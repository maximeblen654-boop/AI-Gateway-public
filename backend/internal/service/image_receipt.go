package service

// Receipt recovery is intentionally separate from native asynchronous image
// tasks: a receipt identifies a single already dispatched upstream operation.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const ImageReceiptHeader = "X-Studio-Image-Task"
const ImageReceiptMaxUSDHeader = "X-Studio-Image-Max-USD"

var ErrImageReceiptInvalidPriceCap = errors.New("invalid image receipt maximum USD")
var ErrImageReceiptPriceCapExceeded = errors.New("image receipt cost exceeds maximum USD")
var imageReceiptUSDPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`)

// The cap is an exact integer number of microUSD, expressed in USD. Zero is
// allowed only after admission verifies the explicitly free model's Group card.
// Compare the calculated decimal cost exactly so fractional microUSD cannot
// exceed the user's ceiling unnoticed. This header never reprices a task.
func checkImageReceiptPriceCapWithZero(headers http.Header, actualCost float64, allowZero bool) error {
	values := headers.Values(ImageReceiptMaxUSDHeader)
	if len(values) == 0 {
		return nil
	}
	if len(values) != 1 {
		return ErrImageReceiptInvalidPriceCap
	}
	value := strings.TrimSpace(values[0])
	if !imageReceiptUSDPattern.MatchString(value) {
		return ErrImageReceiptInvalidPriceCap
	}
	parts := strings.SplitN(value, ".", 2)
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	digits := strings.TrimLeft(parts[0]+fraction+strings.Repeat("0", 6-len(fraction)), "0")
	if digits == "" {
		digits = "0"
	}
	micros, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || (micros == 0 && !allowZero) {
		return ErrImageReceiptInvalidPriceCap
	}
	if math.IsNaN(actualCost) || math.IsInf(actualCost, 0) || actualCost < 0 || (actualCost == 0 && !allowZero) {
		return ErrImageReceiptInvalidPriceCap
	}
	actual, ok := new(big.Rat).SetString(strconv.FormatFloat(actualCost, 'f', -1, 64))
	if !ok {
		return ErrImageReceiptInvalidPriceCap
	}
	cap := new(big.Rat).SetFrac(big.NewInt(micros), big.NewInt(1_000_000))
	if actual.Cmp(cap) > 0 {
		return ErrImageReceiptPriceCapExceeded
	}
	return nil
}

// Free admission is a single explicitly priced product, never a missing card
// or a zero multiplier on a paid product. Match the Bridge's flat exact card.
func imageReceiptAllowsZeroPrice(model, pricingModel string, group *Group, resolved *ResolvedPricing) bool {
	if model != "canvas-image-07" || pricingModel != model {
		return false
	}
	card := imageReceiptFlatGroupCard(model, group, resolved)
	return card != nil && card.PerRequestPrice != nil && *card.PerRequestPrice == 0 && resolved.DefaultPerRequestPrice == 0
}

func imageReceiptFlatGroupCard(model string, group *Group, resolved *ResolvedPricing) *ChannelModelPricing {
	if group == nil || resolved == nil || resolved.Source != PricingSourceGroup || (resolved.Mode != BillingModeImage && resolved.Mode != BillingModePerRequest) || len(resolved.RequestTiers) != 0 {
		return nil
	}
	hits := 0
	var found *ChannelModelPricing
	for index := range group.ModelPricing {
		card := &group.ModelPricing[index]
		for _, id := range card.Models {
			if id == model {
				hits++
				if card.Platform == PlatformOpenAI && card.BillingMode == resolved.Mode && len(card.Intervals) == 0 && card.TimePricing == nil {
					found = card
				}
			}
		}
	}
	if hits != 1 {
		return nil
	}
	return found
}

func imageReceiptReferenceCost(model, pricingModel string, group *Group, resolved *ResolvedPricing, count int, multiplier float64) (*CostBreakdown, bool, error) {
	card := imageReceiptFlatGroupCard(model, group, resolved)
	if !isImage2ProModel(model) || pricingModel != model || card == nil || card.PerRequestPrice == nil || *card.PerRequestPrice < 0 || card.ImageReferencePrice == nil || resolved.ImageReferencePrice == nil {
		return nil, false, errors.New("explicit reference image customer price unavailable")
	}
	unit := *card.ImageReferencePrice
	if unit != *resolved.ImageReferencePrice || math.IsNaN(unit) || math.IsInf(unit, 0) || unit < 0 || (unit == 0 && model != "canvas-image-07") || math.IsNaN(multiplier) || math.IsInf(multiplier, 0) || multiplier <= 0 || count < 1 {
		return nil, false, errors.New("invalid reference image customer price")
	}
	cost := &CostBreakdown{TotalCost: unit * float64(count), ActualCost: unit * float64(count) * multiplier, BillingMode: string(resolved.Mode)}
	if math.IsNaN(cost.ActualCost) || math.IsInf(cost.ActualCost, 0) {
		return nil, false, errors.New("invalid reference image customer cost")
	}
	return cost, model == "canvas-image-07" && unit == 0, nil
}

var imageReceiptKeyPattern = regexp.MustCompile(`^img_[a-f0-9]{32}$`)
var imageReceiptMu sync.Mutex
var imageReceiptReads = make(chan struct{}, 2)

type ImageReceiptView struct {
	ResultExpiresAt   *time.Time      `json:"result_expires_at,omitempty"`
	Status            string          `json:"status"`
	UpstreamRequestID string          `json:"upstream_request_id,omitempty"`
	AccountID         int64           `json:"account_id,omitempty"`
	BillingState      string          `json:"billing_state"`
	Result            json.RawMessage `json:"result,omitempty"`
	ErrorCode         string          `json:"error_code,omitempty"`
}

type imageReceiptRecord struct {
	BillingRecoveryVersion int
	AccountQuotaEnabled    bool
	UpstreamResponseHash   string
	UpstreamPayloadHash    string
	DispatchStartedAt      time.Time
	ResolutionEvidence     string
	ResolvedAt             time.Time
	SupplierRequestID      string
	BillingCount           int
	ExpectedCount          int
	Protocol               string
	RequestBody            []byte
	CreatePath             string
	IdempotencyKey         string
	NextPollAt             time.Time
	Attempts               int
	ResultHash             string
	ResultExpiresAt        time.Time
	ClientKey              string
	UserID                 int64
	APIKeyID               int64
	AccountID              int64
	BaseURL                string
	CredentialFingerprint  string
	PayloadHash            string
	ReceiptID              string
	Model                  string
	UpstreamModel          string
	Size                   string
	SizeTier               string
	CreatedAt              time.Time
	Status                 string
	BillingState           string
	ErrorCode              string
	Cost                   *CostBreakdown
	Multiplier             float64
	AccountRate            float64
	KeyQuota               float64
	KeyRate5h              float64
	KeyRate1d              float64
	KeyRate7d              float64
	Group                  *Group
	QuotaPlatform          string
	Channel                ChannelUsageFields
}

func ImageReceiptRequested(c *gin.Context) bool {
	return strings.TrimSpace(c.GetHeader(ImageReceiptHeader)) != ""
}
func ValidImageReceiptKey(key string) bool { return imageReceiptKeyPattern.MatchString(key) }
func imageReceiptRoot() string {
	if root := strings.TrimSpace(os.Getenv("IMAGE_RECEIPT_DIR")); root != "" {
		return root
	}
	return "/app/data/image-receipts"
}
func imageReceiptPath(userID, keyID int64, key string) (string, error) {
	if userID <= 0 || keyID <= 0 || !ValidImageReceiptKey(key) {
		return "", errors.New("invalid receipt owner or key")
	}
	return filepath.Join(imageReceiptRoot(), fmt.Sprintf("%d_%d_%s.json", userID, keyID, key)), nil
}
func imageReceiptClaimPath(userID int64, key string) string {
	return filepath.Join(imageReceiptRoot(), fmt.Sprintf("%d_%s.claim", userID, key))
}
func imageReceiptFingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func readImageReceipt(path string) (*imageReceiptRecord, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var r imageReceiptRecord
	if err = json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if r.UserID <= 0 || r.APIKeyID <= 0 || r.AccountID <= 0 || r.Group == nil || r.Cost == nil || !ValidImageReceiptKey(r.ClientKey) {
		return nil, errors.New("invalid receipt journal")
	}
	return &r, nil
}

func findOwnedImageReceipt(key *APIKey, clientKey string) (string, *imageReceiptRecord, error) {
	if key == nil || key.GroupID == nil || !ValidImageReceiptKey(clientKey) {
		return "", nil, os.ErrNotExist
	}
	paths, err := filepath.Glob(filepath.Join(imageReceiptRoot(), fmt.Sprintf("%d_*_%s.json", key.UserID, clientKey)))
	if err != nil {
		return "", nil, err
	}
	if len(paths) == 0 {
		return "", nil, os.ErrNotExist
	}
	if len(paths) != 1 {
		return "", nil, errors.New("ambiguous receipt owner binding")
	}
	r, err := readImageReceipt(paths[0])
	if err != nil {
		return "", nil, err
	}
	if r.UserID != key.UserID || r.Group.ID != *key.GroupID {
		return "", nil, os.ErrNotExist
	}
	return paths[0], r, nil
}
func saveImageReceipt(path string, r *imageReceiptRecord) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".receipt-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	if runtime.GOOS == "windows" {
		return nil
	}
	return d.Sync()
}
func receiptView(r *imageReceiptRecord) *ImageReceiptView {
	status := r.Status
	if status == "completed" {
		status = "processing"
	} // A completed response always carries validated result bytes.
	v := &ImageReceiptView{Status: status, UpstreamRequestID: r.ReceiptID, AccountID: r.AccountID, BillingState: r.BillingState, ErrorCode: r.ErrorCode}
	if r.Protocol == image2ProReceiptProtocol {
		v.AccountID = 0
		v.UpstreamRequestID = r.ClientKey
	}
	if r.Protocol == "legacy-sync-local-v1" {
		v.UpstreamRequestID = r.SupplierRequestID
	}
	if !r.ResultExpiresAt.IsZero() {
		v.ResultExpiresAt = &r.ResultExpiresAt
	}
	return v
}

// DispatchImageReceipt runs exactly one POST after a durable claim. It must be
// called instead of ForwardImages so generic failover cannot duplicate a bill.
func (s *OpenAIGatewayService) DispatchImageReceipt(ctx context.Context, c *gin.Context, account *Account, body []byte, parsed *OpenAIImagesRequest, in *OpenAIRecordUsageInput) (*ImageReceiptView, error) {
	key := strings.TrimSpace(c.GetHeader(ImageReceiptHeader))
	if !ValidImageReceiptKey(key) || !IsStudioReceiptModel(parsed.Model) || parsed.Stream || (parsed.Multipart && parsed.Model != "gpt-image-2.5") || parsed.N != 1 || (parsed.Endpoint != openAIImagesGenerationsEndpoint && parsed.Endpoint != openAIImagesEditsEndpoint) {
		return nil, errors.New("receipt requires one non-streaming NEW batch")
	}
	if account.Type != AccountTypeAPIKey || account.ParentAccountID != nil || in.Subscription != nil || in.APIKey.Group == nil || in.APIKey.GroupID == nil {
		return nil, errors.New("receipt pilot requires direct API-key account and balance billing")
	}
	path, err := imageReceiptPath(in.APIKey.UserID, in.APIKey.ID, key)
	if err != nil {
		return nil, err
	}
	hash := HashUsageRequestPayload(body)
	imageReceiptMu.Lock()
	existing, readErr := readImageReceipt(path)
	if os.IsNotExist(readErr) {
		_, owned, ownedErr := findOwnedImageReceipt(in.APIKey, key)
		if ownedErr == nil {
			existing, readErr = owned, nil
		} else if !os.IsNotExist(ownedErr) {
			imageReceiptMu.Unlock()
			return nil, ownedErr
		}
	}
	if readErr == nil {
		imageReceiptMu.Unlock()
		if existing.PayloadHash != hash {
			return nil, errors.New("receipt payload conflict")
		}
		return receiptView(existing), nil
	}
	if !os.IsNotExist(readErr) {
		imageReceiptMu.Unlock()
		return nil, readErr
	}
	upstreamModel := account.GetMappedModel(firstNonEmpty(in.ChannelMappedModel, parsed.Model))
	if upstreamModel != parsed.Model && !isImage2ProModel(parsed.Model) {
		imageReceiptMu.Unlock()
		return nil, errors.New("receipt requires original public model")
	}
	base := account.GetOpenAIBaseURL()
	if _, err = s.validateUpstreamBaseURL(base); err != nil {
		imageReceiptMu.Unlock()
		return nil, err
	}
	token, _, err := s.GetAccessToken(ctx, account)
	if err != nil {
		imageReceiptMu.Unlock()
		return nil, err
	}
	if err := validateReceiptReferences(parsed); err != nil {
		imageReceiptMu.Unlock()
		return nil, err
	}
	hasReferences := len(parsed.InputImageURLs) > 0
	if isImage2ProModel(parsed.Model) {
		var request struct {
			Images []json.RawMessage `json:"images"`
		}
		if json.Unmarshal(body, &request) != nil {
			imageReceiptMu.Unlock()
			return nil, errors.New("invalid reference image request")
		}
		hasReferences = len(request.Images) > 0
		if hasReferences != (len(parsed.InputImageURLs) > 0) || (hasReferences && parsed.Endpoint != openAIImagesEditsEndpoint) {
			imageReceiptMu.Unlock()
			return nil, errors.New("reference image request binding mismatch")
		}
	}
	pricingModel := forwardResultBillingModel(parsed.Model, upstreamModel)
	if isImage2ProModel(parsed.Model) {
		// Customer aliases have their own explicit native Group price.
		pricingModel = parsed.Model
	}
	switch in.BillingModelSource {
	case BillingModelSourceRequested:
		pricingModel = in.OriginalModel
	case BillingModelSourceChannelMapped:
		pricingModel = in.ChannelMappedModel
	}
	resolved := s.resolveOpenAIChannelPricing(ctx, pricingModel, in.APIKey)
	if resolved != nil && resolved.Mode == BillingModeToken {
		imageReceiptMu.Unlock()
		return nil, errors.New("receipt pilot does not support token billing")
	}
	now := time.Now().UTC()
	mult := s.ResolveUserGroupRateMultiplier(ctx, in.User.ID, *in.APIKey.GroupID, in.APIKey.Group.RateMultiplier)
	_, imageMult := computePeakAwareMultipliers(in.APIKey, mult, now)
	expectedCount := 1
	if parsed.Model == "midjourney" {
		expectedCount = 4
	}
	billingCount := expectedCount
	if resolved != nil && resolved.Mode == BillingModePerRequest {
		billingCount = 1
	}
	// A new model cannot silently inherit the Flare pilot's generic 1K price.
	if parsed.Model != "gpt-image-2.5-flare" && (resolved == nil || (resolved.Source != PricingSourceGroup && resolved.Source != PricingSourceChannel) || (resolved.Mode != BillingModeImage && resolved.Mode != BillingModePerRequest)) {
		imageReceiptMu.Unlock()
		return nil, errors.New("explicit model customer price unavailable")
	}
	cost := s.calculateOpenAIImageCost(ctx, pricingModel, in.APIKey, &OpenAIForwardResult{Model: parsed.Model, UpstreamModel: upstreamModel, ImageCount: billingCount, ImageSize: parsed.SizeTier}, imageMult)
	allowZero := imageReceiptAllowsZeroPrice(parsed.Model, pricingModel, in.APIKey.Group, resolved)
	if isImage2ProModel(parsed.Model) && hasReferences {
		cost, allowZero, err = imageReceiptReferenceCost(parsed.Model, pricingModel, in.APIKey.Group, resolved, billingCount, imageMult)
		if err != nil {
			imageReceiptMu.Unlock()
			return nil, err
		}
	}
	if cost == nil || math.IsNaN(cost.ActualCost) || math.IsInf(cost.ActualCost, 0) || cost.ActualCost < 0 || (cost.ActualCost == 0 && (!allowZero || cost.TotalCost != 0)) || s.usageBillingRepo == nil {
		imageReceiptMu.Unlock()
		return nil, errors.New("receipt billing unavailable")
	}
	if err = checkImageReceiptPriceCapWithZero(c.Request.Header, cost.ActualCost, allowZero); err != nil {
		imageReceiptMu.Unlock()
		return nil, err
	}
	groupSnapshot := *in.APIKey.Group
	groupSnapshot.AccountGroups = nil // Nested accounts may contain credentials.
	r := &imageReceiptRecord{BillingCount: billingCount, ExpectedCount: expectedCount, ClientKey: key, UserID: in.APIKey.UserID, APIKeyID: in.APIKey.ID, AccountID: account.ID, BaseURL: base, CredentialFingerprint: imageReceiptFingerprint(token), PayloadHash: hash, Model: parsed.Model, UpstreamModel: upstreamModel, Size: parsed.Size, SizeTier: parsed.SizeTier, CreatedAt: now, Status: "unknown", BillingState: "not_billed", Cost: cost, Multiplier: imageMult, AccountRate: account.BillingRateMultiplier(), Group: &groupSnapshot, QuotaPlatform: in.QuotaPlatform, Channel: in.ChannelUsageFields}
	r.KeyQuota, r.KeyRate5h, r.KeyRate1d, r.KeyRate7d = in.APIKey.Quota, in.APIKey.RateLimit5h, in.APIKey.RateLimit1d, in.APIKey.RateLimit7d
	if isImage2ProModel(parsed.Model) {
		if err = prepareImage2ProReceipt(r, account, parsed, body); err != nil {
			imageReceiptMu.Unlock()
			return nil, err
		}
		if err = imageReceiptStorePreflight(int64(len(r.RequestBody)) + imageReceiptResultReserve); err != nil {
			imageReceiptMu.Unlock()
			return nil, err
		}
	}
	if os.Getenv("IMAGE_RECEIPT_ASYNC_ENABLED") == "true" && IsDurableImageModel(parsed.Model) {
		r.Protocol, r.CreatePath, r.IdempotencyKey = "durable-async-v1", imageReceiptAsyncPath(parsed.Endpoint), key
		r.RequestBody = append([]byte(nil), body...)
		if err = imageReceiptStorePreflight(int64(len(body))*4/3 + 64*1024); err != nil {
			imageReceiptMu.Unlock()
			return nil, err
		}
	}
	if parsed.Model == "gpt-image-2.5" {
		r.Protocol = "legacy-sync-local-v1"
		r.CreatePath = parsed.Endpoint
		r.ReceiptID = "local_" + key
		r.RequestBody = append([]byte(nil), body...)
		if err = imageReceiptStorePreflight(int64(len(body))*4/3 + 64*1024); err != nil {
			imageReceiptMu.Unlock()
			return nil, err
		}
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		imageReceiptMu.Unlock()
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) >= 20000 {
		imageReceiptMu.Unlock()
		return nil, errors.New("receipt journal capacity unavailable")
	}
	// Permanent exclusive marker prevents POST replay across Core processes too.
	claim, claimErr := os.OpenFile(imageReceiptClaimPath(r.UserID, key), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if claimErr != nil {
		imageReceiptMu.Unlock()
		return nil, errors.New("receipt claim exists or unavailable")
	}
	if err = claim.Sync(); err != nil {
		_ = claim.Close()
		imageReceiptMu.Unlock()
		return nil, err
	}
	_ = claim.Close()
	err = saveImageReceipt(path, r)
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	// No request cancellation from a disconnected bridge; total duration remains bounded.
	if r.Protocol == image2ProReceiptProtocol {
		s.startImage2ProReceipt(path, in.APIKey, in.APIKeyService)
		return receiptView(r), nil
	}
	if r.Protocol == "durable-async-v1" {
		return s.advanceAsyncImageReceipt(context.WithoutCancel(ctx), path, r, in.APIKey, in.APIKeyService, true)
	}
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 16*time.Minute)
	defer cancel()
	request, err := s.buildOpenAIImagesRequest(WithHTTPUpstreamRedirectsDisabled(runCtx), c, account, body, parsed.ContentType, token, parsed.Endpoint)
	if err != nil {
		return receiptView(r), nil
	}
	if request.Header.Get("Authorization") != "Bearer "+token {
		return nil, errors.New("receipt pilot requires original bearer credential")
	}
	request.GetBody = nil // Do not permit transparent replay of a paid POST.
	proxy := ""
	if account.Proxy != nil {
		proxy = account.Proxy.URL()
	}
	resp, err := s.doOpenAIUpstream(request, proxy, account)
	if err != nil {
		return receiptView(r), nil
	}
	defer func() { _ = resp.Body.Close() }()
	if r.Protocol == "legacy-sync-local-v1" {
		r.SupplierRequestID = strings.TrimSpace(resp.Header.Get("X-Oneapi-Request-Id"))
	} else {
		r.ReceiptID = strings.TrimSpace(resp.Header.Get("X-Oneapi-Request-Id"))
	}
	if r.ReceiptID != "" {
		r.Status = "processing"
	}
	// This fsync precedes even the first read of the response body.
	imageReceiptMu.Lock()
	err = saveImageReceipt(path, r)
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20+1))
	if err != nil || len(data) > 32<<20 {
		return receiptView(r), nil
	}
	if resp.StatusCode != http.StatusOK || r.ReceiptID == "" {
		return receiptView(r), nil
	}
	return s.completeImageReceipt(runCtx, path, r, account, in.APIKey, in.APIKeyService, data)
}

func (s *OpenAIGatewayService) completeImageReceipt(ctx context.Context, path string, r *imageReceiptRecord, account *Account, key *APIKey, quota APIKeyQuotaUpdater, data []byte) (*ImageReceiptView, error) {
	if err := validateReceiptImageResultCount(data, imageReceiptExpectedCount(r)); err != nil {
		v := receiptView(r)
		v.ErrorCode = "invalid_upstream_result"
		return v, nil
	}
	imageReceiptMu.Lock()
	defer imageReceiptMu.Unlock()
	latest, err := readImageReceipt(path)
	if err != nil {
		return nil, err
	}
	r = latest
	if r.BillingState == "billing_unknown" && r.BillingRecoveryVersion != 1 {
		return receiptView(r), nil
	}
	if err = persistImageReceiptResult(path, r, data); err != nil {
		v := receiptView(r)
		v.Status = "unknown"
		v.ErrorCode = "result_storage_unavailable"
		return v, nil
	}
	// Deliver and bill only the durable bytes. Another legacy GET may already
	// have saved a different valid response for this receipt.
	data, err = loadImageReceiptResult(path, r)
	if err != nil {
		return nil, err
	}
	if r.BillingState != "billed" {
		// v1 recovery reuses the frozen money-event ID and native transactional
		// fingerprint dedup. Legacy unknown journals remain audit-only.
		r.BillingState = "billing_unknown"
		r.Status = "settling"
		if err = saveImageReceipt(path, r); err != nil {
			return nil, err
		}
		billingKey := *key
		billingKey.Group = r.Group
		billingKey.GroupID = &r.Group.ID
		billingKey.Quota, billingKey.RateLimit5h, billingKey.RateLimit1d, billingKey.RateLimit7d = r.KeyQuota, r.KeyRate5h, r.KeyRate1d, r.KeyRate7d
		billingAccount := *account
		billingAccount.RateMultiplier = &r.AccountRate
		billingAccount.Extra = make(map[string]any, len(account.Extra)+1)
		for k, v := range account.Extra {
			billingAccount.Extra[k] = v
		}
		if r.BillingRecoveryVersion == 1 {
			// The native billing fingerprint includes account quota cost. Changing
			// a live account limit cannot change a previously admitted money event.
			billingAccount.Extra["quota_limit"] = float64(0)
			billingAccount.Extra["quota_daily_limit"] = float64(0)
			billingAccount.Extra["quota_weekly_limit"] = float64(0)
			if r.AccountQuotaEnabled {
				billingAccount.Extra["quota_limit"] = float64(1)
			}
		}
		billingAccount.Extra[AccountExtraUpstreamRequestIDHeader] = "X-Oneapi-Request-Id"
		supplierID := r.ReceiptID
		if r.Protocol == "legacy-sync-local-v1" {
			supplierID = r.SupplierRequestID
		}
		result := &OpenAIForwardResult{RequestID: fmt.Sprintf("image-receipt:%d:%s", r.AccountID, r.ReceiptID), Model: r.Model, UpstreamModel: r.UpstreamModel, ImageCount: imageReceiptExpectedCount(r), ImageSize: r.SizeTier, ImageInputSize: r.Size, ImageOutputSizes: collectOpenAIResponseImageOutputSizesFromJSONBytes(data), Duration: time.Since(r.CreatedAt), UpstreamHeaders: http.Header{"X-Oneapi-Request-Id": []string{supplierID}}}
		err = s.RecordUsage(ctx, &OpenAIRecordUsageInput{Result: result, APIKey: &billingKey, User: key.User, Account: &billingAccount, APIKeyService: quota, RequestPayloadHash: r.PayloadHash, InboundEndpoint: imageReceiptEndpoint(r), UpstreamEndpoint: imageReceiptEndpoint(r), QuotaPlatform: r.QuotaPlatform, PricingAt: r.CreatedAt, ChannelUsageFields: r.Channel, ReceiptCostSnapshot: r.Cost, ReceiptMultiplier: r.Multiplier})
		if err != nil {
			r.ErrorCode = "billing_unknown"
			_ = saveImageReceipt(path, r)
			return receiptView(r), nil
		}
		r.BillingState = "billed"
		r.Status = "completed"
		r.ErrorCode = ""
		if err = saveImageReceipt(path, r); err != nil {
			return nil, err
		}
	}
	v := receiptView(r)
	v.Status = "completed"
	v.Result = json.RawMessage(data)
	return v, nil
}

func (s *OpenAIGatewayService) GetImageReceipt(ctx context.Context, key *APIKey, clientKey string, quota APIKeyQuotaUpdater) (*ImageReceiptView, error) {
	imageReceiptMu.Lock()
	path, r, err := findOwnedImageReceipt(key, clientKey)
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	if r.ResultHash != "" {
		data, storeErr := loadImageReceiptResult(path, r)
		if storeErr != nil {
			v := receiptView(r)
			v.Status = "unknown"
			v.ErrorCode = "result_storage_unavailable"
			if !time.Now().Before(r.ResultExpiresAt) {
				v.Status = "expired"
				v.ErrorCode = "result_expired"
			}
			return v, nil
		}
		if r.BillingState == "billed" {
			v := receiptView(r)
			v.Status = "completed"
			v.Result = data
			return v, nil
		}
	}
	if r.APIKeyID != key.ID {
		lookup, ok := quota.(interface {
			GetByID(context.Context, int64) (*APIKey, error)
		})
		if !ok {
			return nil, errors.New("original customer key lookup unavailable")
		}
		original, lookupErr := lookup.GetByID(ctx, r.APIKeyID)
		if lookupErr != nil || original == nil || original.UserID != r.UserID || original.GroupID == nil || *original.GroupID != r.Group.ID || (original.Status != StatusActive && original.Status != StatusAPIKeyQuotaExhausted) || (original.ExpiresAt != nil && original.ExpiresAt.Before(time.Now())) {
			return nil, errors.New("original customer key unavailable")
		}
		if original.User == nil {
			original.User = key.User
		}
		key = original
	}
	if r.Protocol == "legacy-sync-local-v1" && r.ResultHash == "" {
		v := receiptView(r)
		v.Status = "unknown"
		v.ErrorCode = "legacy_upstream_reconciliation_required"
		return v, nil
	}
	if r.Protocol == image2ProReceiptProtocol {
		s.startImage2ProReceipt(path, key, quota)
		return receiptView(r), nil
	}
	if (r.ReceiptID == "" && r.Protocol != "durable-async-v1") || r.BillingState == "billing_unknown" || r.Status == "failed" || r.Status == "expired" {
		return receiptView(r), nil
	}
	if r.Protocol == "durable-async-v1" {
		return s.advanceAsyncImageReceipt(ctx, path, r, key, quota, false)
	}
	select {
	case imageReceiptReads <- struct{}{}:
		defer func() { <-imageReceiptReads }()
	default:
		v := receiptView(r)
		v.Result = nil
		v.ErrorCode = "receipt_poll_busy"
		return v, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	account, err := s.accountRepo.GetByID(ctx, r.AccountID)
	if err != nil || account == nil {
		return nil, errors.New("original account unavailable")
	}
	if account.Status != StatusActive || (account.ExpiresAt != nil && account.ExpiresAt.Before(time.Now())) || account.ParentAccountID != nil || account.Type != AccountTypeAPIKey || account.GetOpenAIBaseURL() != r.BaseURL {
		return nil, errors.New("original account changed or disabled")
	}
	token, _, err := s.GetAccessToken(ctx, account)
	if err != nil || imageReceiptFingerprint(token) != r.CredentialFingerprint {
		return nil, errors.New("original credential changed")
	}
	if r.Protocol == "legacy-sync-local-v1" {
		data, loadErr := loadImageReceiptResult(path, r)
		if loadErr != nil {
			return receiptView(r), nil
		}
		return s.completeImageReceipt(ctx, path, r, account, key, quota, data)
	}
	base, err := s.validateUpstreamBaseURL(r.BaseURL)
	if err != nil {
		return nil, err
	}
	target := strings.TrimSuffix(buildOpenAIImagesURL(base, openAIImagesGenerationsEndpoint), "/generations") + "/tasks/" + url.PathEscape(r.ReceiptID)
	req, err := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	proxy := ""
	if account.Proxy != nil {
		proxy = account.Proxy.URL()
	}
	resp, err := s.doOpenAIUpstream(req, proxy, account)
	if err != nil {
		return receiptView(r), nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == 404 || resp.StatusCode == 410 {
		v := receiptView(r)
		v.Status = "unknown"
		v.ErrorCode = fmt.Sprintf("receipt_http_%d", resp.StatusCode)
		return v, nil
	}
	if resp.StatusCode != 200 && resp.StatusCode != 202 {
		return receiptView(r), nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20+1))
	if err != nil || len(data) > 32<<20 {
		return receiptView(r), nil
	}
	var envelope struct {
		State  string          `json:"state"`
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return receiptView(r), nil
	}
	// The upstream receipt contract uses state. Accept the older status alias,
	// but never complete an ambiguous response with conflicting values.
	if envelope.State != "" {
		if envelope.Status != "" && envelope.Status != envelope.State {
			v := receiptView(r)
			v.ErrorCode = "conflicting_receipt_state"
			return v, nil
		}
		envelope.Status = envelope.State
	}
	if envelope.Status == "completed" && (len(envelope.Error) == 0 || string(envelope.Error) == "null") {
		return s.completeImageReceipt(ctx, path, r, account, key, quota, envelope.Result)
	}
	v := receiptView(r)
	switch envelope.Status {
	case "accepted", "queued", "submitting", "processing", "settling", "reconciling":
		v.Status = envelope.Status
	}
	if envelope.Status == "error" || envelope.Status == "failed" {
		v.Status = "unknown"
		if r.BillingState == "not_billed" {
			v.Status = "failed"
		}
		v.ErrorCode = "upstream_error"
	}
	imageReceiptMu.Lock()
	latest, readErr := readImageReceipt(path)
	if readErr == nil && latest.BillingState == "not_billed" {
		latest.Status, latest.ErrorCode = v.Status, v.ErrorCode
		err = saveImageReceipt(path, latest)
	}
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	return v, nil
}

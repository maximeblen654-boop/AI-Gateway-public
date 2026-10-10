package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/gin-gonic/gin"
)

type StudioImageRuntime struct {
	Core    *OpenAIGatewayService
	Media   mediaworkbench.Repository
	Store   *StudioImageStore
	APIKeys *APIKeyService
	enabled bool
	network func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error)
}

var studioImageTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type StudioImageCatalogOffer struct {
	InputMode     string                 `json:"input_mode,omitempty"`
	DisplayName   string                 `json:"display_name"`
	UpstreamModel string                 `json:"upstream_model"`
	OfferID       string                 `json:"offer_id"`
	ProductID     string                 `json:"product_id"`
	Model         string                 `json:"model"`
	Revision      string                 `json:"published_revision"`
	Spec          mediaworkbench.Match   `json:"spec"`
	Excluded      []mediaworkbench.Match `json:"excluded"`
	Price         mediaworkbench.Price   `json:"sale_price"`
	VideoProfile  *videoplan.Model       `json:"video_profile,omitempty"`
}

func (r *StudioImageRuntime) Catalog(ctx context.Context, owner StudioImageOwner, key *APIKey) ([]StudioImageCatalogOffer, error) {
	rows, err := r.Media.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []StudioImageCatalogOffer{}
	for i := range rows {
		a := &rows[i]
		if a.Config == nil || a.Config.Published == nil {
			continue
		}
		original, e := r.Core.accountRepo.GetByID(ctx, a.ID)
		if e != nil || original == nil || !slices.Contains(original.GroupIDs, owner.GroupID) {
			continue
		}
		for _, o := range a.Config.Published.Offers {
			if o.MediaType != "image" || !studioGroupAllows(key, o.SiteModel) || o.SpecMatch.Count == nil || o.SpecMatch.References == nil {
				continue
			}
			if !mediaworkbench.PublishedImageOfferQuoteable(a, o.OfferID) {
				continue
			}
			out = append(out, StudioImageCatalogOffer{OfferID: o.OfferID, ProductID: o.ProductID, Model: o.SiteModel, Revision: a.Config.Published.Revision, Spec: o.SpecMatch, Excluded: o.Excluded, Price: o.SalePrice, DisplayName: o.UpstreamModel, UpstreamModel: o.UpstreamModel})
		}
	}
	return out, nil
}

func NewStudioImageRuntime(core *OpenAIGatewayService, media mediaworkbench.Repository) *StudioImageRuntime {
	root := strings.TrimSpace(os.Getenv("STUDIO_IMAGE_BINDING_ROOT"))
	if root == "" {
		root = filepath.Join("data", "studio-image-bindings")
	}
	r := &StudioImageRuntime{Core: core, Media: media, Store: NewStudioImageStore(root)}
	// Independent server gate; client headers and readiness cannot activate it.
	r.enabled = os.Getenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION") == "true"
	r.network = r.dispatchHTTP
	return r
}
func (r *StudioImageRuntime) Enabled() bool {
	return r != nil && r.enabled && r.Core != nil && r.Media != nil && r.Store != nil && r.Core.usageBillingRepo != nil && r.network != nil
}
func studioCredentialFingerprint(a *Account) string {
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	return studioHash(struct {
		Credentials map[string]any
		Proxy       string
	}{a.Credentials, proxy})
}
func studioGroupAllows(k *APIKey, model string) bool {
	return k != nil && k.Group != nil && GroupAllowsImageGeneration(k.Group) && k.Group.ModelAllowlist.Allows(model)
}

func (r *StudioImageRuntime) Issue(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, subscriptionID *int64) (string, error) {
	if r == nil || r.Core == nil || r.Media == nil || key == nil || key.ID != owner.APIKeyID || key.UserID != owner.UserID || key.GroupID == nil || *key.GroupID != owner.GroupID {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	resolved, err := mediaworkbench.NewService(r.Media).ResolvePublishedImageOffer(ctx, offerID, spec, func(id int64) bool {
		a, e := r.Core.accountRepo.GetByID(ctx, id)
		return e == nil && a != nil && slices.Contains(a.GroupIDs, owner.GroupID)
	})
	if err != nil || !studioGroupAllows(key, resolved.Offer.SiteModel) {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	unitPrice, totalPrice, err := mediaworkbench.PriceForQuantity(resolved.Offer.SalePrice, resolved.Spec.Count)
	if err != nil {
		return "", err
	}
	m := &UsageBillingExactAmounts{totalPrice.Amount, "0", "0", "0", "0"}
	if subscriptionID != nil {
		m.Subscription = m.Balance
		m.Balance = "0"
	}
	if err = m.Validate(); err != nil {
		return "", err
	}
	n, _ := mediaworkbench.DecimalAmount(totalPrice.Amount)
	// Native usage-log money columns are DECIMAL(20,10).
	if n.GreaterThanOrEqual(decimalSubscriptionLimit) {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	a, err := r.Core.accountRepo.GetByID(ctx, resolved.Offer.AccountID)
	if err != nil || a == nil {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	q := StudioImageQuote{Owner: owner, Binding: resolved, BaseURL: a.GetOpenAIBaseURL(), CredentialFingerprint: studioCredentialFingerprint(a), CreatedAt: time.Now().UTC(), SubscriptionID: subscriptionID, KeyQuotaEnabled: key.Quota > 0, KeyRateEnabled: key.HasRateLimits(), AccountQuotaEnabled: a.HasAnyQuotaLimit(), UnitPrice: &unitPrice, Quantity: resolved.Spec.Count, TotalPrice: &totalPrice}
	execution, err := mediaworkbench.PublishedImageExecution(resolved)
	if err != nil || execution.Mode == mediaworkbench.ImageExecutionProviderAsync {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	q.Execution = &execution
	q.ExpiresAt = q.CreatedAt.Add(2 * time.Minute)
	q.Accounting, err = r.Core.studioImageAccountCost(ctx, a, resolved, owner.GroupID, q.CreatedAt)
	if err != nil {
		return "", err
	}
	if _, release, e := r.Core.SelectQuotedImageAccount(ctx, q, r.Media, false); e != nil {
		return "", e
	} else {
		release()
	}
	return r.Store.Issue(q)
}

func (r *StudioImageRuntime) Dispatch(ctx context.Context, c *gin.Context, q StudioImageQuote, taskID, prompt string, references []string, key *APIKey) (*StudioImageReceipt, error) {
	if q.Execution != nil {
		return r.dispatchExecution(ctx, c, q, taskID, prompt, references, key)
	}
	if !r.Enabled() {
		return nil, errors.New("published image paid gate off")
	}
	if !studioImageTaskID.MatchString(taskID) || !studioGroupAllows(key, q.Binding.Offer.SiteModel) || key.ID != q.Owner.APIKeyID || key.UserID != q.Owner.UserID || key.GroupID == nil || *key.GroupID != q.Owner.GroupID {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	plan, err := mediaworkbench.CompilePublishedImagePlan(q.Binding, prompt, references)
	if err != nil {
		return nil, err
	}
	body := plan.MaterializeJSON()
	requestHash := studioHash(struct {
		Prompt     string
		References []string
		Spec       mediaworkbench.Spec
	}{prompt, references, q.Binding.Spec})
	if old, e := r.Store.Receipt(taskID, q.Owner); e == nil {
		if old.Quote.BindingHash != q.BindingHash || old.RequestHash != requestHash || old.PayloadHash != HashUsageRequestPayload(body) {
			return nil, ErrStudioImageConflict
		}
		return r.Recover(ctx, taskID, q.Owner)
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if !time.Now().Before(q.ExpiresAt) || time.Now().Before(q.CreatedAt) {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	// Admission policy may change after issue. It cannot silently remove native
	// key accounting or move a new request between balance/subscription ledgers.
	if (key.Quota > 0) != q.KeyQuotaEnabled || key.HasRateLimits() != q.KeyRateEnabled || key.Group.IsSubscriptionType() != (q.SubscriptionID != nil) {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	a, release, err := r.Core.SelectQuotedImageAccount(ctx, q, r.Media, true)
	if err != nil {
		return nil, err
	}
	defer release()
	if q.Accounting.Validate(q) != nil || (a.HasAnyQuotaLimit() && !q.AccountQuotaEnabled) {
		return nil, ErrStudioImageAccounting
	}
	receipt := StudioImageReceipt{Version: StudioImageReceiptVersion, TaskID: taskID, Quote: q, Request: body, PayloadHash: HashUsageRequestPayload(body), RequestHash: requestHash, Endpoint: plan.Path}
	persisted, first, err := r.Store.Claim(receipt)
	if err != nil {
		return nil, err
	}
	if !first {
		return r.Recover(ctx, taskID, q.Owner)
	}
	data, id, err := r.network(ctx, c, a, persisted.Request, persisted.Endpoint)
	if err != nil {
		return persisted, ErrStudioImageUnknown
	}
	persisted.UpstreamID = id
	if err = r.Store.Save(persisted); err != nil {
		return persisted, err
	}
	if err = r.Store.write(r.Store.path("upstream", taskID), data, false); err != nil {
		return persisted, err
	}
	if err = r.Store.PersistResult(persisted, data); err != nil {
		return persisted, err
	}
	return r.settle(ctx, persisted)
}

func (r *StudioImageRuntime) Recover(ctx context.Context, taskID string, owner StudioImageOwner) (*StudioImageReceipt, error) {
	receipt, err := r.Store.Receipt(taskID, owner)
	if err != nil {
		return nil, err
	}
	if receipt.Version == StudioImageMultiReceiptVersion {
		return r.recoverExecution(ctx, receipt)
	}
	if receipt.ResultHash == "" {
		data, e := os.ReadFile(r.Store.path("upstream", taskID))
		if e != nil {
			return receipt, ErrStudioImageUnknown
		}
		if e = r.Store.PersistResult(receipt, data); e != nil {
			return receipt, e
		}
	}
	if _, err = r.Store.Result(receipt); err != nil {
		return receipt, err
	}
	return r.settle(ctx, receipt)
}
func (r *StudioImageRuntime) settle(ctx context.Context, receipt *StudioImageReceipt) (*StudioImageReceipt, error) {
	if receipt.BillingState == "billed" {
		return receipt, nil
	}
	if _, err := r.Store.Result(receipt); err != nil {
		return receipt, err
	}
	receipt.BillingState = "billing_unknown"
	if err := r.Store.Save(receipt); err != nil {
		return receipt, err
	}
	result, err := SettleQuotedImage(ctx, r.Core.usageBillingRepo, receipt)
	if err != nil {
		return receipt, err
	}
	if r.Core.billingCacheService != nil {
		_ = r.Core.billingCacheService.InvalidateUserBalance(ctx, receipt.Quote.Owner.UserID)
		_ = r.Core.billingCacheService.InvalidateAPIKeyRateLimit(ctx, receipt.Quote.Owner.APIKeyID)
		if receipt.Quote.SubscriptionID != nil {
			_ = r.Core.billingCacheService.InvalidateSubscription(ctx, receipt.Quote.Owner.UserID, receipt.Quote.Owner.GroupID)
		}
		if result.Applied && receipt.Quote.SubscriptionID == nil && r.Core.userPlatformQuotaRepo != nil && r.Core.billingCacheService.HasUserPlatformQuotaLimit(ctx, receipt.Quote.Owner.UserID, PlatformOpenAI) {
			// Reuse the existing native usage side effect; no Studio quota ledger.
			_, total, _, e := studioImageReceiptPrices(receipt)
			if e != nil {
				return receipt, e
			}
			n, _ := mediaworkbench.DecimalAmount(total.Amount)
			r.Core.billingCacheService.IncrementUserPlatformQuotaUsage(receipt.Quote.Owner.UserID, PlatformOpenAI, n.InexactFloat64())
			// Preserve native flusher ownership and its non-flusher DB fallback.
			if r.Core.cfg == nil || !r.Core.cfg.Database.UserPlatformQuotaFlusherEnabled {
				if err := r.Core.userPlatformQuotaRepo.IncrementUsageWithReset(ctx, receipt.Quote.Owner.UserID, PlatformOpenAI, n.InexactFloat64(), time.Now().UTC()); err != nil {
					// Keep the existing native best-effort quota/cache semantics.
					userPlatformQuotaDBIncrErrorTotal.Add(1)
					logger.LegacyPrintf("service.studio_images", "ALERT: native user platform quota persistence failed user=%d: %v", receipt.Quote.Owner.UserID, err)
				}
			}
		}
	}
	if r.APIKeys != nil {
		r.APIKeys.InvalidateAuthCacheByUserID(ctx, receipt.Quote.Owner.UserID)
	}
	if r.Core.deferredService != nil {
		r.Core.deferredService.ScheduleLastUsedUpdate(receipt.Quote.Binding.Offer.AccountID)
	}
	receipt.BillingState = "billed"
	receipt.Status = "completed"
	if receipt.Version == StudioImageMultiReceiptVersion && receipt.DeliveredCount < receipt.ExpectedCount {
		receipt.Status = "partial"
	}
	return receipt, r.Store.Save(receipt)
}
func (r *StudioImageRuntime) dispatchHTTP(ctx context.Context, c *gin.Context, a *Account, body []byte, endpoint string) ([]byte, string, error) {
	ctx, release := detachUpstreamContext(ctx)
	defer release()
	token, _, err := r.Core.GetAccessToken(ctx, a)
	if err != nil {
		return nil, "", err
	}
	req, err := r.Core.buildOpenAIImagesRequest(ctx, c, a, body, "application/json", token, endpoint)
	if err != nil {
		return nil, "", err
	}
	req = req.WithContext(WithHTTPUpstreamRedirectsDisabled(req.Context()))
	req.GetBody = nil
	req.Header.Del("Idempotency-Key")
	req.Header.Del("X-Idempotency-Key")
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	resp, err := r.Core.httpUpstream.Do(req, proxy, a.ID, a.Concurrency)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.Header.Get("x-request-id"), &StudioImageUpstreamError{Status: resp.StatusCode, RequestID: resp.Header.Get("x-request-id")}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (32<<20)+1))
	if err != nil || len(data) > 32<<20 {
		return nil, "", ErrStudioImageUnknown
	}
	return data, resp.Header.Get("x-request-id"), nil
}

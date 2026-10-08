//go:build unit

package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func checkImageReceiptPriceCap(headers http.Header, actualCost float64) error {
	return checkImageReceiptPriceCapWithZero(headers, actualCost, false)
}

func TestImageReceiptPriceCapBeforeClaimOrPOST(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		omit        bool
		wantErr     error
	}{
		{name: "absent", omit: true},
		{name: "equal", value: "0.030000"},
		{name: "larger", value: "0.04"},
		{name: "lower", value: "0.029999", wantErr: ErrImageReceiptPriceCapExceeded},
		{name: "invalid", value: "no", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "nan", value: "NaN", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "infinite", value: "Infinity", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "negative", value: "-0.03", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "zero", value: "0", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "empty", value: "", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "fractional_micro", value: "0.0300001", wantErr: ErrImageReceiptInvalidPriceCap},
		{name: "overflow", value: "9223372036855", wantErr: ErrImageReceiptInvalidPriceCap},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, key, account, r, path, billing := receiptFixture(t)
			require.NoError(t, os.Remove(path))
			up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
				return nil, errors.New("simulated disconnect; no external traffic")
			}}
			svc.httpUpstream = up
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)
			c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
			if !tc.omit {
				c.Request.Header.Set(ImageReceiptMaxUSDHeader, tc.value)
			}
			parsed := &OpenAIImagesRequest{Model: "gpt-image-2.5-flare", N: 1, SizeTier: "1K", ContentType: "application/json", Endpoint: openAIImagesGenerationsEndpoint}
			body := []byte(`{"model":"gpt-image-2.5-flare"}`)
			input := &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account}
			_, err := svc.DispatchImageReceipt(context.Background(), c, account, body, parsed, input)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
				require.Zero(t, up.calls)
				_, err = os.Stat(path)
				require.ErrorIs(t, err, os.ErrNotExist)
				_, err = os.Stat(imageReceiptClaimPath(r.UserID, r.ClientKey))
				require.ErrorIs(t, err, os.ErrNotExist)
			} else {
				require.NoError(t, err)
				require.Equal(t, 1, up.calls)
				stored, err := readImageReceipt(path)
				require.NoError(t, err)
				require.Equal(t, 0.03, stored.Cost.ActualCost)
				// A changed cap or quote on duplicate delivery cannot create a second
				// dispatch or change the admission quote of the original operation.
				c.Request.Header.Set(ImageReceiptMaxUSDHeader, "NaN")
				changed := 9.0
				key.Group.ImagePrice1K = &changed
				_, err = svc.DispatchImageReceipt(context.Background(), c, account, body, parsed, input)
				require.NoError(t, err)
				require.Equal(t, 1, up.calls)
				stored, err = readImageReceipt(path)
				require.NoError(t, err)
				require.Equal(t, 0.03, stored.Cost.ActualCost)
			}
			require.Zero(t, billing.calls)
		})
	}
}

func TestImageReceiptPriceCapRejectsAmbiguityAndNonfiniteCost(t *testing.T) {
	h := http.Header{}
	h.Add(ImageReceiptMaxUSDHeader, "0.03")
	h.Add(ImageReceiptMaxUSDHeader, "0.04")
	require.ErrorIs(t, checkImageReceiptPriceCap(h, 0.03), ErrImageReceiptInvalidPriceCap)
	h.Set(ImageReceiptMaxUSDHeader, "0.03")
	for _, cost := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1, 0} {
		require.ErrorIs(t, checkImageReceiptPriceCap(h, cost), ErrImageReceiptInvalidPriceCap)
	}
	require.ErrorIs(t, checkImageReceiptPriceCap(h, 0.03000001), ErrImageReceiptPriceCapExceeded)
	h.Set(ImageReceiptMaxUSDHeader, "0.1")
	require.NoError(t, checkImageReceiptPriceCap(h, 0.1))
}

type receiptUpstreamStub struct {
	HTTPUpstream
	calls int
	run   func(*http.Request) (*http.Response, error)
}
type receiptKeyLookupStub struct {
	openAIRecordUsageAPIKeyQuotaStub
	original *APIKey
}

func (s *receiptKeyLookupStub) GetByID(_ context.Context, id int64) (*APIKey, error) {
	if s.original != nil && s.original.ID == id {
		return s.original, nil
	}
	return nil, os.ErrNotExist
}

func (s *receiptUpstreamStub) Do(r *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	s.calls++
	return s.run(r)
}
func receiptPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 1, 1))))
	data, err := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(b.Bytes())}}})
	require.NoError(t, err)
	return data
}
func receiptFixture(t *testing.T) (*OpenAIGatewayService, *APIKey, *Account, *imageReceiptRecord, string, *openAIRecordUsageBillingRepoStub) {
	t.Helper()
	t.Setenv("IMAGE_RECEIPT_DIR", t.TempDir())
	billing := &openAIRecordUsageBillingRepoStub{result: &UsageBillingApplyResult{Applied: true}}
	svc := newOpenAIRecordUsageServiceWithBillingRepoForTest(&openAIRecordUsageLogRepoStub{inserted: true}, billing, &openAIRecordUsageUserRepoStub{}, &openAIRecordUsageSubRepoStub{}, nil)
	price := 0.03
	group := &Group{ID: 31, Platform: PlatformOpenAI, RateMultiplier: 1, ImagePrice1K: &price}
	key := &APIKey{ID: 7, UserID: 2, User: &User{ID: 2}, GroupID: &group.ID, Group: group}
	account := &Account{ID: 44, Type: AccountTypeAPIKey, Platform: PlatformOpenAI, Status: StatusActive, Credentials: map[string]any{"base_url": "https://example.com", "api_key": "test-secret"}}
	svc.accountRepo = &openAIRecordUsageAccountRepoStub{account: account}
	r := &imageReceiptRecord{ClientKey: "img_" + strings.Repeat("a", 32), UserID: 2, APIKeyID: 7, AccountID: 44, BaseURL: account.GetOpenAIBaseURL(), CredentialFingerprint: imageReceiptFingerprint("test-secret"), PayloadHash: "same-payload", ReceiptID: "upstream-receipt-1", Model: "gpt-image-2.5-flare", UpstreamModel: "gpt-image-2.5-flare", SizeTier: "1K", CreatedAt: time.Now(), Status: "processing", BillingState: "not_billed", Group: group, Cost: &CostBreakdown{TotalCost: 0.03, ActualCost: 0.03, BillingMode: "image"}, Multiplier: 1, AccountRate: 1}
	path, err := imageReceiptPath(2, 7, r.ClientKey)
	require.NoError(t, err)
	require.NoError(t, saveImageReceipt(path, r))
	return svc, key, account, r, path, billing
}
func TestImageReceiptRejectsErrorMissingAndBrokenPNG(t *testing.T) {
	require.NoError(t, validateReceiptImageResult(receiptPNG(t)))
	for _, v := range []string{`{"error":{"message":"no"},"data":[]}`, `{"data":[]}`, `{"data":[{"b64_json":"aGVsbG8="}]}`, `{"data":[{},{}]}`} {
		require.Error(t, validateReceiptImageResult([]byte(v)))
	}
}
func TestImageReceiptBillingOnceAndFrozenQuote(t *testing.T) {
	svc, key, account, r, path, billing := receiptFixture(t)
	// Change live group pricing; persisted admission quote still governs charge.
	expensive := 8.0
	key.Group.ImagePrice1K = &expensive
	key.Group.ImageRateIndependent = true
	key.Group.ImageRateMultiplier = 9
	ctx := context.WithValue(context.Background(), ctxkey.ClientRequestID, "different-poll-id")
	view, err := svc.completeImageReceipt(ctx, path, r, account, key, nil, receiptPNG(t))
	require.NoError(t, err)
	require.Equal(t, "completed", view.Status)
	require.Equal(t, 1, billing.calls)
	require.InDelta(t, 0.03, billing.lastCmd.BalanceCost, 0.000001)
	require.Equal(t, "image-receipt:44:upstream-receipt-1", billing.lastCmd.RequestID)
	require.Equal(t, 1.0, svc.usageLogRepo.(*openAIRecordUsageLogRepoStub).lastLog.RateMultiplier)
	view, err = svc.completeImageReceipt(context.Background(), path, r, account, key, nil, receiptPNG(t))
	require.NoError(t, err)
	require.Equal(t, "billed", view.BillingState)
	require.Equal(t, 1, billing.calls)
}
func TestImageReceiptBillingFailureStaysUnknown(t *testing.T) {
	svc, key, account, r, path, billing := receiptFixture(t)
	billing.err = errors.New("database unavailable")
	view, err := svc.completeImageReceipt(context.Background(), path, r, account, key, nil, receiptPNG(t))
	require.NoError(t, err)
	require.Equal(t, "billing_unknown", view.BillingState)
	require.Empty(t, view.Result)
	billing.err = nil
	_, err = svc.completeImageReceipt(context.Background(), path, r, account, key, nil, receiptPNG(t))
	require.NoError(t, err)
	require.Equal(t, 1, billing.calls)
}
func TestImageReceiptOwnerAndOriginalCredential(t *testing.T) {
	svc, key, account, r, _, _ := receiptFixture(t)
	key.UserID++
	_, err := svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
	require.ErrorIs(t, err, os.ErrNotExist)
	key.UserID--
	account.Credentials["api_key"] = "rotated"
	_, err = svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
	require.ErrorContains(t, err, "credential changed")
}
func TestImageReceiptSettlingAndHTTPErrorNeverBill(t *testing.T) {
	for _, body := range []string{`{"state":"settling"}`, `{"state":"settling","status":"completed"}`, `{"status":"settling"}`, `{"status":"completed","error":{"message":"bad"},"result":{"data":[]}}`, `{"status":"error"}`} {
		t.Run(body, func(t *testing.T) {
			svc, key, _, r, _, billing := receiptFixture(t)
			up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
				require.Equal(t, http.MethodGet, req.Method)
				require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
				require.Equal(t, "Bearer test-secret", req.Header.Get("Authorization"))
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			}}
			svc.httpUpstream = up
			view, err := svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
			require.NoError(t, err)
			require.NotEqual(t, "completed", view.Status)
			require.Empty(t, view.Result)
			require.Zero(t, billing.calls)
		})
	}
}

type receiptReadProbe struct {
	t    *testing.T
	path string
	read bool
}

func (p *receiptReadProbe) Read(_ []byte) (int, error) {
	r, err := readImageReceipt(p.path)
	require.NoError(p.t, err)
	require.Equal(p.t, "early-header", r.ReceiptID)
	p.read = true
	return 0, errors.New("connection reset")
}
func (*receiptReadProbe) Close() error { return nil }
func TestImageReceiptDurableHeaderBeforeBodyAndNoRepeatPOST(t *testing.T) {
	svc, key, account, r, path, billing := receiptFixture(t)
	require.NoError(t, os.Remove(path))
	probe := &receiptReadProbe{t: t, path: path}
	up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodPost, req.Method)
		require.Nil(t, req.GetBody)
		require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
		_, err := os.Stat(imageReceiptClaimPath(r.UserID, r.ClientKey))
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Header: http.Header{"X-Oneapi-Request-Id": []string{"early-header"}}, Body: probe}, nil
	}}
	svc.httpUpstream = up
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)
	c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
	parsed := &OpenAIImagesRequest{Model: "gpt-image-2.5-flare", N: 1, SizeTier: "1K", ContentType: "application/json", Endpoint: openAIImagesGenerationsEndpoint}
	input := &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account}
	view, err := svc.DispatchImageReceipt(context.Background(), c, account, []byte(`{"model":"gpt-image-2.5-flare"}`), parsed, input)
	require.NoError(t, err)
	require.Equal(t, "processing", view.Status)
	require.True(t, probe.read)
	_, err = svc.DispatchImageReceipt(context.Background(), c, account, []byte(`{"model":"gpt-image-2.5-flare"}`), parsed, input)
	require.NoError(t, err)
	require.Equal(t, 1, up.calls)
	require.Zero(t, billing.calls)
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "test-secret")
}

func TestImageReceiptGETCompletedAfterRestartAndRepeatedQuery(t *testing.T) {
	svc, key, account, r, _, billing := receiptFixture(t)
	data := receiptPNG(t)
	envelope, _ := json.Marshal(map[string]any{"state": "completed", "result": json.RawMessage(data)})
	up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodGet, req.Method)
		require.Equal(t, "/v1/images/tasks/upstream-receipt-1", req.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(envelope))}, nil
	}}
	svc.httpUpstream = up
	// No in-memory task state exists: lookup reconstructs the record from disk.
	for i := 0; i < 2; i++ {
		account.Extra = map[string]any{"quota_used": float64(i), "quota_daily_used": float64(i)}
		view, err := svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
		require.NoError(t, err)
		require.Equal(t, "completed", view.Status)
		require.JSONEq(t, string(data), string(view.Result))
	}
	require.Equal(t, 1, up.calls) // Repeated delivery uses the durable local result.
	require.Equal(t, 1, billing.calls)
	logRepo := svc.usageLogRepo.(*openAIRecordUsageLogRepoStub)
	require.NotNil(t, logRepo.lastLog.UpstreamRequestID)
	require.Equal(t, "upstream-receipt-1", *logRepo.lastLog.UpstreamRequestID)
}

func TestImageReceiptGETMissingExpiredAndStorageFailure(t *testing.T) {
	for _, status := range []int{404, 410} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			svc, key, _, r, _, billing := receiptFixture(t)
			svc.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(""))}, nil
			}}
			view, err := svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
			require.NoError(t, err)
			require.Equal(t, "unknown", view.Status)
			require.NotEmpty(t, view.ErrorCode)
			require.Empty(t, view.Result)
			require.Zero(t, billing.calls)
		})
	}
	_, _, _, r, path, _ := receiptFixture(t)
	require.Error(t, saveImageReceipt(path+"/impossible.json", r))
	_, err := imageReceiptPath(2, 7, "../../elsewhere")
	require.Error(t, err)
}

func TestImageReceiptNewCustomerKeyRetainsOriginalBillingOwner(t *testing.T) {
	svc, original, _, r, _, billing := receiptFixture(t)
	original.Status = StatusAPIKeyQuotaExhausted
	newKey := *original
	newKey.ID = 99
	newKey.Status = StatusActive
	lookup := &receiptKeyLookupStub{original: original}
	data := receiptPNG(t)
	envelope, _ := json.Marshal(map[string]any{"status": "completed", "result": json.RawMessage(data)})
	up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodGet, req.Method)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(envelope))}, nil
	}}
	svc.httpUpstream = up
	view, err := svc.GetImageReceipt(context.Background(), &newKey, r.ClientKey, lookup)
	require.NoError(t, err)
	require.Equal(t, "completed", view.Status)
	require.Equal(t, original.ID, billing.lastCmd.APIKeyID)
	otherGroup := int64(32)
	newKey.GroupID = &otherGroup
	_, err = svc.GetImageReceipt(context.Background(), &newKey, r.ClientKey, lookup)
	require.ErrorIs(t, err, os.ErrNotExist)
	require.Equal(t, 1, up.calls)
	newKey.GroupID = original.GroupID
	ambiguous := *r
	ambiguous.APIKeyID = 100
	ambiguousPath, err := imageReceiptPath(r.UserID, 100, r.ClientKey)
	require.NoError(t, err)
	require.NoError(t, saveImageReceipt(ambiguousPath, &ambiguous))
	_, err = svc.GetImageReceipt(context.Background(), &newKey, r.ClientKey, lookup)
	require.ErrorContains(t, err, "ambiguous")
	require.Equal(t, 1, up.calls)
}

func TestImageReceiptConflictingStateWithValidPNGNeverBills(t *testing.T) {
	svc, key, _, r, _, billing := receiptFixture(t)
	envelope, _ := json.Marshal(map[string]any{"state": "settling", "status": "completed", "result": json.RawMessage(receiptPNG(t))})
	svc.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(envelope))}, nil
	}}
	view, err := svc.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
	require.NoError(t, err)
	require.Equal(t, "conflicting_receipt_state", view.ErrorCode)
	require.Empty(t, view.Result)
	require.Zero(t, billing.calls)
}

// A restart creates fresh runtime locks and retains only durable-service dependencies.
func restartReceiptService(s *OpenAIGatewayService) *OpenAIGatewayService {
	r := newOpenAIRecordUsageServiceWithBillingRepoForTest(s.usageLogRepo, s.usageBillingRepo, s.userRepo, s.userSubRepo, nil)
	r.accountRepo = s.accountRepo
	r.cfg = s.cfg
	r.httpUpstream = s.httpUpstream
	r.imageResultFetcher = s.imageResultFetcher
	r.billingService = s.billingService
	r.resolver = s.resolver
	r.userGroupRateResolver = s.userGroupRateResolver
	return r
}

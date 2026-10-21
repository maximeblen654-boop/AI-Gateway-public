//go:build unit

package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func image2ProFixture(t *testing.T) (*OpenAIGatewayService, *APIKey, *Account, *imageReceiptRecord, string) {
	s, key, account, r, path, _ := receiptFixture(t)
	account.Credentials["base_url"] = "https://api.image2pro.top"
	r.BaseURL = account.GetOpenAIBaseURL()
	r.Model, r.UpstreamModel = "canvas-image-01", "无限制-Seedream-5-Pro"
	body := []byte(`{"model":"canvas-image-01","prompt":"fixture","n":1}`)
	r.PayloadHash = HashUsageRequestPayload(body)
	// Historical fixture only: today's entry is forbidden from creating these
	// records. Recovery must preserve the original serialized request identity.
	r.RequestBody, _ = json.Marshal(map[string]any{"model": r.UpstreamModel, "prompt": "fixture", "n": 1})
	r.UpstreamPayloadHash = HashUsageRequestPayload(r.RequestBody)
	r.Protocol, r.CreatePath, r.IdempotencyKey = image2ProReceiptProtocol, openAIImagesGenerationsEndpoint, r.ClientKey
	r.ReceiptID, r.Status = "local_"+r.ClientKey, "queued"
	r.BillingRecoveryVersion, r.AccountQuotaEnabled = 1, account.HasAnyQuotaLimit()
	require.NoError(t, saveImageReceipt(path, r))
	return s, key, account, r, path
}

func TestImage2ProLegacyAliasesRejectNewReceiptWithoutClaimOrPOST(t *testing.T) {
	for _, model := range imagecontract.Image2ProModels {
		t.Run(model.ID, func(t *testing.T) {
			s, key, account, r, path := image2ProFixture(t)
			require.NoError(t, os.Remove(path))
			account.Credentials["model_mapping"] = map[string]any{model.ID: model.UpstreamID}
			upstream := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) { t.Fatal("retired alias cannot generate"); return nil, nil }}
			s.httpUpstream = upstream
			body, _ := json.Marshal(map[string]any{"model": model.ID, "prompt": "synthetic", "n": 1})
			parsed := &OpenAIImagesRequest{Model: model.ID, N: 1, Endpoint: openAIImagesGenerationsEndpoint}
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, openAIImagesGenerationsEndpoint, nil)
			c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
			_, err := s.DispatchImageReceipt(t.Context(), c, account, body, parsed, &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account})
			require.ErrorIs(t, err, ErrImage2ProLegacyAdmission)
			_, err = os.Stat(path)
			require.ErrorIs(t, err, os.ErrNotExist)
			_, err = os.Stat(imageReceiptClaimPath(r.UserID, r.ClientKey))
			require.ErrorIs(t, err, os.ErrNotExist)
			require.Zero(t, upstream.calls)
		})
	}
}

func TestImage2ProAliasesCannotFallThroughToOtherSupplier(t *testing.T) {
	for _, model := range imagecontract.Image2ProModels {
		a := &Account{Type: AccountTypeAPIKey, Platform: PlatformOpenAI, Credentials: map[string]any{"base_url": "https://different.example"}}
		require.False(t, a.IsModelSupported(model.ID))
		a.Credentials["model_mapping"] = map[string]any{"*": model.UpstreamID}
		require.False(t, a.IsModelSupported(model.ID))
		a.Credentials["base_url"] = "https://api.image2pro.top"
		require.False(t, a.IsModelSupported(model.ID))
		a.Credentials["model_mapping"] = map[string]any{model.ID: model.UpstreamID}
		require.True(t, a.IsModelSupported(model.ID))
	}
}

func TestImage2ProSaveAndExplicitTestsCannotGenerate(t *testing.T) {
	for _, base := range []string{"https://api.image2pro.top", "https://API.IMAGE2PRO.TOP/v1", "https://api.image2pro.top/other"} {
		account := Account{ID: 1, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": base, "api_key": "fixture-not-a-real-key"}}
		upstream := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("unexpected generation probe")
		}}
		s := &AccountTestService{accountRepo: &openAIRecordUsageAccountRepoStub{account: &account}, httpUpstream: upstream}
		s.ProbeOpenAIAPIKeyResponsesSupport(context.Background(), account.ID)
		require.Zero(t, upstream.calls)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/test", nil)
		require.Error(t, s.TestAccountConnection(c, account.ID, "any", "probe", ""))
		require.Zero(t, upstream.calls)
	}
	require.False(t, MeteredAccountTestsDisabled(&Account{Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": "https://api.image2pro.top.evil.example"}}))
}

func TestImage2ProLegacyQueuedReceiptCannotStartFirstPOST(t *testing.T) {
	s, key, _, r, path := image2ProFixture(t)
	upstream := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		t.Fatal("old queued receipt must not generate")
		return nil, nil
	}}
	s.httpUpstream = upstream
	s.startImage2ProReceipt(path, key, nil)
	require.Eventually(t, func() bool {
		imageReceiptMu.Lock()
		defer imageReceiptMu.Unlock()
		saved, err := readImageReceipt(path)
		return err == nil && saved.Status == "failed"
	}, time.Second, 10*time.Millisecond)
	stored, err := readImageReceipt(path)
	require.NoError(t, err)
	require.Equal(t, "legacy_submission_disabled_not_billed", stored.ErrorCode)
	require.Equal(t, "not_billed", stored.BillingState)
	require.Equal(t, r.UpstreamPayloadHash, stored.UpstreamPayloadHash)
	require.Equal(t, r.RequestBody, stored.RequestBody)
	_, err = os.Stat(path + ".sync-dispatch")
	require.ErrorIs(t, err, os.ErrNotExist)
	require.Zero(t, upstream.calls)
	require.NoError(t, s.runImage2ProReceipt(t.Context(), path, key, nil))
	require.Zero(t, upstream.calls)
}

func TestImage2ProLostSynchronousResponseNeverResubmitsOrBills(t *testing.T) {
	s, key, _, r, path := image2ProFixture(t)
	s.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		t.Fatal("historical unknown result cannot be resubmitted")
		return nil, nil
	}}
	r.DispatchStartedAt, r.Attempts = time.Now().Add(-17*time.Minute), 1
	require.NoError(t, saveImageReceipt(path, r))
	require.NoError(t, os.WriteFile(path+".sync-dispatch", []byte("historical-dispatch"), 0600))
	require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
	restarted := restartReceiptService(s)
	for range 3 {
		require.NoError(t, restarted.runImage2ProReceipt(context.Background(), path, key, nil))
	}
	require.Zero(t, s.httpUpstream.(*receiptUpstreamStub).calls)
	stored, err := readImageReceipt(path)
	require.NoError(t, err)
	require.Equal(t, "not_billed", stored.BillingState)
	require.Empty(t, stored.ResultHash)
	// Even after supplier dedup expiration the permanent marker wins.
	stored.DispatchStartedAt = time.Now().Add(-3 * time.Hour)
	require.NoError(t, saveImageReceipt(path, stored))
	require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
	stored, err = readImageReceipt(path)
	require.NoError(t, err)
	require.Equal(t, "upstream_original_result_required", stored.ErrorCode)
	require.Zero(t, s.httpUpstream.(*receiptUpstreamStub).calls)
	_ = r
}

type image2ProDedupLedger struct {
	UsageBillingRepository
	mu                 sync.Mutex
	entries            map[string]string
	debits             int
	unknownAfterCommit bool
}

func (b *image2ProDedupLedger) Apply(_ context.Context, cmd *UsageBillingCommand) (*UsageBillingApplyResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	cmd.Normalize()
	if hash, ok := b.entries[cmd.RequestID]; ok {
		if hash != cmd.RequestFingerprint {
			return nil, ErrUsageBillingRequestConflict
		}
		return &UsageBillingApplyResult{Applied: false}, nil
	}
	b.entries[cmd.RequestID] = cmd.RequestFingerprint
	b.debits++
	if b.unknownAfterCommit {
		b.unknownAfterCommit = false
		return nil, errors.New("connection lost after commit")
	}
	return &UsageBillingApplyResult{Applied: true}, nil
}

func TestImage2ProRestartAfterMoneyCommitRecoversOriginalBytesOnce(t *testing.T) {
	s, key, _, r, path := image2ProFixture(t)
	ledger := &image2ProDedupLedger{entries: map[string]string{}, unknownAfterCommit: true}
	s.usageBillingRepo = ledger
	// Crash window: response file rename succeeded, receipt hash not yet saved.
	require.NoError(t, persistImage2ProResponse(path, receiptPNG(t)))
	s.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) { t.Fatal("recovery must not generate"); return nil, nil }}
	require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
	stored, err := readImageReceipt(path)
	require.NoError(t, err)
	require.Equal(t, "billing_unknown", stored.BillingState)
	require.NotEmpty(t, stored.ResultHash)
	require.Equal(t, 1, ledger.debits)
	restarted := restartReceiptService(s)
	require.NoError(t, restarted.runImage2ProReceipt(context.Background(), path, key, nil))
	view, err := restarted.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
	require.NoError(t, err)
	require.Equal(t, "completed", view.Status)
	require.Equal(t, "billed", view.BillingState)
	require.Equal(t, 1, ledger.debits)
	require.NoError(t, validateReceiptImageResult(view.Result))
	require.Zero(t, s.httpUpstream.(*receiptUpstreamStub).calls)
}

func TestImage2ProBillingRecoveryFreezesAccountQuota(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			s, key, account, r, path := image2ProFixture(t)
			r.AccountQuotaEnabled = enabled
			if enabled {
				account.Extra = map[string]any{"quota_limit": float64(8)}
			}
			require.NoError(t, saveImageReceipt(path, r))
			ledger := &image2ProDedupLedger{entries: map[string]string{}, unknownAfterCommit: true}
			s.usageBillingRepo = ledger
			require.NoError(t, persistImage2ProResponse(path, receiptPNG(t)))
			require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
			if enabled {
				account.Extra = nil
			} else {
				account.Extra = map[string]any{"quota_daily_limit": float64(9)}
			}
			require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
			stored, e := readImageReceipt(path)
			require.NoError(t, e)
			require.Equal(t, "billed", stored.BillingState)
			require.Equal(t, 1, ledger.debits)
		})
	}
}

func TestImage2ProPreflightAndManualTerminalNeverDispatch(t *testing.T) {
	for _, scenario := range []string{"disabled", "rotated", "manual-terminal", "stale-start"} {
		t.Run(scenario, func(t *testing.T) {
			s, key, account, r, path := image2ProFixture(t)
			s.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) { t.Fatal("must not dispatch"); return nil, nil }}
			switch scenario {
			case "disabled":
				account.Status = "disabled"
			case "rotated":
				account.Credentials["api_key"] = "rotated-test-value"
			default:
				stored := *r
				stored.Status = "failed"
				require.NoError(t, saveImageReceipt(path, &stored))
			}
			if scenario == "stale-start" {
				s.startImage2ProReceipt(path, key, nil)
			} else {
				require.NoError(t, s.runImage2ProReceipt(context.Background(), path, key, nil))
			}
			stored, e := readImageReceipt(path)
			require.NoError(t, e)
			require.Equal(t, "failed", stored.Status)
			require.Equal(t, "not_billed", stored.BillingState)
			_, e = os.Stat(path + ".sync-dispatch")
			require.True(t, os.IsNotExist(e))
			require.Zero(t, s.httpUpstream.(*receiptUpstreamStub).calls)
		})
	}
}

func TestImage2ProURLAndBase64Projection(t *testing.T) {
	var original struct {
		Data []struct {
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	result := receiptPNG(t)
	require.NoError(t, json.Unmarshal(result, &original))
	for _, raw := range []string{"http://localhost/p.png", "https://name:secret@example.com/p.png", "https://example.com:8443/p.png", "https://localhost/p.png"} {
		require.Error(t, validateImage2ProResultURL(raw))
	}
	for _, raw := range []string{"https://127.0.0.1/p.png", "https://169.254.169.254/p.png", "https://[::1]/p.png"} {
		_, err := fetchImage2ProResultURL(context.Background(), raw)
		require.Error(t, err)
	}
	_, err := normalizeImage2ProResult(context.Background(), []byte(`{"data":[{"url":"https://example.com/p.png","b64_json":"anything"}]}`), nil)
	require.Error(t, err)
	out, err := normalizeImage2ProResult(context.Background(), []byte(`{"supplier":"hidden","data":[{"b64_json":"`+original.Data[0].B64+`","url":""}],"request_id":"private"}`), nil)
	require.NoError(t, err)
	require.NotContains(t, string(out), "hidden")
	require.NotContains(t, string(out), "private")
	_, err = normalizeImage2ProResult(context.Background(), []byte(`{"data":[{"b64_json":"`+strings.Repeat("a", 20)+`"}]}`), nil)
	require.Error(t, err)
}

// Only historical unit fixtures write a saved response. Production recovery
// reads the original bytes and never starts a retired supplier submission.
func persistImage2ProResponse(path string, data []byte) error {
	if len(data) == 0 || int64(len(data)) > imageReceiptResultReserve {
		return errors.New("invalid upstream image response")
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".image-response-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
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
	if err = os.Rename(tmp, path+".upstream"); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}

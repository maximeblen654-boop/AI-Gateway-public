package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var imageReceiptActive sync.Map

func (s *OpenAIGatewayService) advanceAsyncImageReceipt(ctx context.Context, path string, r *imageReceiptRecord, key *APIKey, quota APIKeyQuotaUpdater, initialDispatch bool) (*ImageReceiptView, error) {
	if _, busy := imageReceiptActive.LoadOrStore(path, true); busy {
		return receiptView(r), nil
	}
	defer imageReceiptActive.Delete(path)
	select {
	case imageReceiptReads <- struct{}{}:
		defer func() { <-imageReceiptReads }()
	default:
		return receiptView(r), nil
	}
	imageReceiptMu.Lock()
	latest, err := readImageReceipt(path)
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	r = latest
	// Only the caller that created the permanent receipt claim may issue a POST.
	// An old/no-ID journal is ambiguous even when Attempts is zero. Recovery never resubmits.
	if r.ReceiptID == "" && (!initialDispatch || r.Attempts != 0 || !r.DispatchStartedAt.IsZero()) {
		v := receiptView(r)
		v.Status, v.ErrorCode = "unknown", "upstream_original_result_required"
		return v, nil
	}
	if time.Now().Before(r.NextPollAt) {
		return receiptView(r), nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	account, err := s.accountRepo.GetByID(ctx, r.AccountID)
	if err != nil || account == nil || account.Status != StatusActive || account.ParentAccountID != nil || account.Type != AccountTypeAPIKey || account.GetOpenAIBaseURL() != r.BaseURL || (account.ExpiresAt != nil && account.ExpiresAt.Before(time.Now())) {
		return nil, errors.New("original account unavailable")
	}
	token, _, err := s.GetAccessToken(ctx, account)
	if err != nil || imageReceiptFingerprint(token) != r.CredentialFingerprint {
		return nil, errors.New("original credential changed")
	}
	if r.ResultHash != "" {
		data, e := loadImageReceiptResult(path, r)
		if e != nil {
			return receiptView(r), nil
		}
		return s.completeImageReceipt(ctx, path, r, account, key, quota, data)
	}
	base, err := s.validateUpstreamBaseURL(r.BaseURL)
	if err != nil {
		return nil, err
	}
	target := strings.TrimSuffix(buildOpenAIImagesURL(base, openAIImagesGenerationsEndpoint), "/generations") + "/tasks/" + url.PathEscape(r.ReceiptID)
	method := http.MethodGet
	var body io.Reader
	if r.ReceiptID == "" {
		if r.Protocol != "durable-async-v1" || (r.CreatePath != "/v1/images/generations/async" && r.CreatePath != "/v1/images/edits/async") || r.IdempotencyKey != r.ClientKey || HashUsageRequestPayload(r.RequestBody) != r.PayloadHash {
			return nil, errors.New("invalid async binding")
		}
		target = buildOpenAIImagesURL(base, imageReceiptEndpoint(r)) + "/async"
		method = http.MethodPost
		body = bytes.NewReader(r.RequestBody)
	}
	req, err := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), method, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.GetBody = nil
	if method == http.MethodPost {
		req.Header.Set("Idempotency-Key", r.IdempotencyKey)
		r.DispatchStartedAt = time.Now().UTC()
	}
	// Persist a retry schedule before I/O; process crashes cannot trigger a tight loop.
	r.Attempts++
	delay := time.Duration(3*(1<<min(r.Attempts-1, 5))) * time.Second
	r.NextPollAt = time.Now().UTC().Add(delay)
	r.Status = "reconciling"
	imageReceiptMu.Lock()
	err = saveImageReceipt(path, r)
	imageReceiptMu.Unlock()
	if err != nil {
		return nil, err
	}
	proxy := ""
	if account.Proxy != nil {
		proxy = account.Proxy.URL()
	}
	resp, err := s.doOpenAIUpstream(req, proxy, account)
	if err != nil {
		return receiptView(r), nil
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20+1))
	if err != nil || len(data) > 32<<20 {
		return receiptView(r), nil
	}
	var envelope struct {
		RequestID  string          `json:"request_id"`
		PollURL    string          `json:"poll_url"`
		RetryAfter int             `json:"retry_after"`
		State      string          `json:"state"`
		Status     string          `json:"status"`
		Result     json.RawMessage `json:"result"`
		Error      json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return receiptView(r), nil
	}
	if envelope.State != "" {
		if envelope.Status != "" && envelope.State != envelope.Status {
			return receiptView(r), nil
		}
		envelope.Status = envelope.State
	}
	if method == http.MethodPost && (resp.StatusCode == 202 || resp.StatusCode == 200) {
		id := strings.TrimSpace(envelope.RequestID)
		headerID := strings.TrimSpace(resp.Header.Get("X-Oneapi-Request-Id"))
		if id == "" {
			id = headerID
		}
		if id == "" || len(id) > 256 || strings.ContainsAny(id, "/\\?#\r\n") || (headerID != "" && headerID != id) {
			return receiptView(r), nil
		}
		expected := strings.TrimSuffix(buildOpenAIImagesURL(base, openAIImagesGenerationsEndpoint), "/generations") + "/tasks/" + url.PathEscape(id)
		if envelope.PollURL != "" {
			u, e := url.Parse(envelope.PollURL)
			origin, _ := url.Parse(target)
			if e != nil {
				return receiptView(r), nil
			}
			resolved := origin.ResolveReference(u)
			if resolved.String() != expected {
				return receiptView(r), nil
			}
		}
		r.ReceiptID = id
		r.Status = "accepted"
		if envelope.Status == "reconciling" || envelope.Status == "settling" {
			r.Status = envelope.Status
		}
		r.Attempts = 0
		// The first POST may return a completed envelope (200).
		// Persist its identity before validating/saving the PNG or billing.
		imageReceiptMu.Lock()
		err = saveImageReceipt(path, r)
		imageReceiptMu.Unlock()
		if err != nil {
			return nil, err
		}
	}
	if (resp.StatusCode == 200 || resp.StatusCode == 202) && (method == http.MethodGet || (method == http.MethodPost && resp.StatusCode == 200 && r.ReceiptID != "")) {
		if envelope.Status == "completed" && (len(envelope.Error) == 0 || string(envelope.Error) == "null") {
			return s.completeImageReceipt(ctx, path, r, account, key, quota, envelope.Result)
		}
		switch envelope.Status {
		case "accepted", "queued", "submitting", "processing", "reconciling", "settling":
			r.Status = envelope.Status
			r.Attempts = 0
		case "error", "failed":
			if r.BillingState == "not_billed" {
				r.Status = "failed"
				r.ErrorCode = "upstream_error"
			} else {
				r.Status = "unknown"
				r.ErrorCode = "upstream_billing_dispute"
			}
		}
	} else if resp.StatusCode == 410 && method == http.MethodGet {
		r.Status = "expired"
		r.ErrorCode = "upstream_result_expired"
	} else if method == http.MethodPost && (resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 402 || resp.StatusCode == 403 || resp.StatusCode == 422) && r.BillingState == "not_billed" {
		r.Status = "failed"
		r.ErrorCode = "upstream_rejected"
	}
	seconds := envelope.RetryAfter
	if h, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && h > seconds {
		seconds = h
	}
	if seconds < 3 {
		seconds = 3
	}
	if seconds > 3600 {
		seconds = 3600
	}
	if r.Attempts == 0 || time.Duration(seconds)*time.Second > delay {
		r.NextPollAt = time.Now().UTC().Add(time.Duration(seconds) * time.Second)
	}
	imageReceiptMu.Lock()
	err = saveImageReceipt(path, r)
	imageReceiptMu.Unlock()
	return receiptView(r), err
}

// The caller owns lifecycle cancellation. No browser session or raw customer key
// is retained; each pass loads the original native API-key identity by ID.
func (s *OpenAIGatewayService) StartImageReceiptWorker(ctx context.Context, quota APIKeyQuotaUpdater) {
	if os.Getenv("IMAGE_RECEIPT_WORKER_ENABLED") != "true" {
		return
	}
	s.imageReceiptWorkerOnce.Do(func() {
		ctx, cancel := context.WithCancel(ctx)
		s.imageReceiptWorkerCancel = cancel
		go func() {
			ticker := time.NewTicker(3 * time.Second)
			defer ticker.Stop()
			for {
				s.runImageReceiptWorkerPass(ctx, quota)
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	})
}

func (s *OpenAIGatewayService) StopImageReceiptWorker() {
	if s.imageReceiptWorkerCancel != nil {
		s.imageReceiptWorkerCancel()
	}
}

func (s *OpenAIGatewayService) runImageReceiptWorkerPass(ctx context.Context, quota APIKeyQuotaUpdater) {
	imageReceiptMu.Lock()
	_ = imageReceiptStorePreflight() // Reclaim only expired billed bytes; preserve journals and unresolved audit.
	imageReceiptMu.Unlock()
	lookup, ok := quota.(interface {
		GetByID(context.Context, int64) (*APIKey, error)
	})
	if !ok {
		return
	}
	paths, _ := filepath.Glob(filepath.Join(imageReceiptRoot(), "*.json"))
	var wg sync.WaitGroup
	slots := make(chan struct{}, 2)
	for _, path := range paths {
		if ctx.Err() != nil {
			break
		}
		imageReceiptMu.Lock()
		r, err := readImageReceipt(path)
		imageReceiptMu.Unlock()
		if err != nil || (r.BillingState == "billing_unknown" && r.BillingRecoveryVersion != 1) || r.Status == "failed" || r.Status == "expired" || r.BillingState == "billed" || r.ReceiptID == "" || time.Now().Before(r.NextPollAt) {
			continue
		}
		slots <- struct{}{}
		wg.Add(1)
		go func(r *imageReceiptRecord) {
			defer wg.Done()
			defer func() { <-slots }()
			key, e := lookup.GetByID(ctx, r.APIKeyID)
			if e != nil || key == nil || key.User == nil || key.UserID != r.UserID || key.GroupID == nil || *key.GroupID != r.Group.ID || (key.Status != StatusActive && key.Status != StatusAPIKeyQuotaExhausted) || (key.ExpiresAt != nil && key.ExpiresAt.Before(time.Now())) {
				return
			}
			_, _ = s.GetImageReceipt(ctx, key, r.ClientKey, quota)
		}(r)
	}
	wg.Wait()
}

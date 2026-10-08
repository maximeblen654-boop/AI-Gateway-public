package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
)

const image2ProReceiptProtocol = "image2pro-sync-v1"

func prepareImage2ProReceipt(r *imageReceiptRecord, account *Account, parsed *OpenAIImagesRequest, body []byte) error {
	model, ok := imagecontract.LookupImage2ProModel(parsed.Model)
	if !ok || !imagecontract.IsImage2ProBase(account.GetOpenAIBaseURL()) || r.UpstreamModel != model.UpstreamID || parsed.Multipart || parsed.N != 1 || parsed.HasMask {
		return errors.New("image product route or operation unavailable")
	}
	if parsed.Endpoint == openAIImagesEditsEndpoint && !model.References {
		return errors.New("image product does not support references")
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		return errors.New("invalid image product request")
	}
	for field := range payload {
		switch field {
		case "model", "prompt", "n", "images":
		default:
			return errors.New("unreviewed image product parameter")
		}
	}
	// Only reviewed fields are sent. Native size/encoding defaults remain owned
	// by the supplier; the UI must not promise an exact size it cannot enforce.
	payload["model"], _ = json.Marshal(model.UpstreamID)
	r.RequestBody, _ = json.Marshal(payload)
	r.UpstreamPayloadHash = HashUsageRequestPayload(r.RequestBody)
	r.Protocol, r.CreatePath, r.IdempotencyKey = image2ProReceiptProtocol, parsed.Endpoint, r.ClientKey
	r.ReceiptID, r.Status = "local_"+r.ClientKey, "queued"
	r.BillingRecoveryVersion = 1
	r.AccountQuotaEnabled = account.HasAnyQuotaLimit()
	return nil
}

// POST acceptance is independent of the browser/bridge lifetime. A permanent
// dispatch marker also prevents replay after a crash, including after the
// supplier's two-hour dedup TTL. Only a saved response may be retried/recovered.
func (s *OpenAIGatewayService) startImage2ProReceipt(path string, r *imageReceiptRecord, key *APIKey, quota APIKeyQuotaUpdater) {
	imageReceiptMu.Lock()
	defer imageReceiptMu.Unlock()
	latest, err := readImageReceipt(path)
	if err != nil {
		return
	}
	r = latest
	if r.Status == "failed" || r.Status == "expired" || r.BillingState == "billed" || time.Now().Before(r.NextPollAt) {
		return
	}
	if _, busy := imageReceiptActive.LoadOrStore(path, true); busy {
		return
	}
	select {
	case imageReceiptReads <- struct{}{}:
	default:
		imageReceiptActive.Delete(path)
		return
	}
	go func() {
		defer imageReceiptActive.Delete(path)
		defer func() { <-imageReceiptReads }()
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		_ = s.runImage2ProReceipt(ctx, path, key, quota)
	}()
}

func (s *OpenAIGatewayService) runImage2ProReceipt(ctx context.Context, path string, key *APIKey, quota APIKeyQuotaUpdater) error {
	imageReceiptMu.Lock()
	r, err := readImageReceipt(path)
	imageReceiptMu.Unlock()
	if err != nil {
		return err
	}
	if r.Status == "failed" || r.Status == "expired" || r.BillingState == "billed" {
		return nil
	}
	if r.Protocol != image2ProReceiptProtocol || r.UserID != key.UserID || r.APIKeyID != key.ID || r.IdempotencyKey != r.ClientKey ||
		(r.CreatePath != openAIImagesGenerationsEndpoint && r.CreatePath != openAIImagesEditsEndpoint) ||
		HashUsageRequestPayload(r.RequestBody) != r.UpstreamPayloadHash {
		return errors.New("invalid saved image binding")
	}
	account, err := s.accountRepo.GetByID(ctx, r.AccountID)
	if err != nil || account == nil || account.GetOpenAIBaseURL() != r.BaseURL || account.Type != AccountTypeAPIKey {
		return errors.New("original image account unavailable")
	}
	if r.ResultHash != "" {
		data, e := loadImageReceiptResult(path, r)
		if e != nil {
			return e
		}
		_, e = s.completeImageReceipt(ctx, path, r, account, key, quota, data)
		return e
	}
	// Also recovers a crash between durable response rename and journal fsync.
	data, readErr := readImage2ProResponse(path)
	if os.IsNotExist(readErr) {
		if _, e := os.Stat(path + ".sync-dispatch"); e == nil {
			return markImage2ProAwaitingOriginal(path, r)
		} else if !os.IsNotExist(e) {
			return e
		}
		// Deterministic local rejection precedes the permanent dispatch marker.
		// Only outcomes after the first network attempt can be upstream-unknown.
		reject := func() error {
			r.Status, r.ErrorCode = "failed", "local_preflight_failed_not_billed"
			return saveImage2ProProgress(path, r)
		}
		if !imagecontract.IsImage2ProBase(r.BaseURL) || account.Status != StatusActive || (account.ExpiresAt != nil && account.ExpiresAt.Before(time.Now())) {
			return reject()
		}
		token, _, e := s.GetAccessToken(ctx, account)
		if e != nil || imageReceiptFingerprint(token) != r.CredentialFingerprint {
			return reject()
		}
		base, e := s.validateUpstreamBaseURL(r.BaseURL)
		if e != nil {
			return reject()
		}
		req, e := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), http.MethodPost, buildOpenAIImagesURL(base, r.CreatePath), bytes.NewReader(r.RequestBody))
		if e != nil {
			return reject()
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", r.IdempotencyKey)
		req.GetBody = nil
		claim, e := os.OpenFile(path+".sync-dispatch", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			if !os.IsExist(e) {
				return e
			}
			return markImage2ProAwaitingOriginal(path, r)
		}
		e = claim.Sync()
		_ = claim.Close()
		if e != nil {
			return e
		}
		r.DispatchStartedAt, r.Status = time.Now().UTC(), "processing"
		r.Attempts++
		r.NextPollAt = r.DispatchStartedAt.Add(16 * time.Minute)
		// Directory fsync covers the no-replay marker before the network call.
		if e = saveImage2ProProgress(path, r); e != nil {
			return e
		}
		proxy := ""
		if account.Proxy != nil {
			proxy = account.Proxy.URL()
		}
		resp, e := s.doOpenAIUpstream(req, proxy, account)
		if e != nil {
			r.Status, r.ErrorCode = "unknown", "upstream_original_result_required"
			r.NextPollAt = time.Now().UTC().Add(time.Hour)
			return saveImage2ProProgress(path, r)
		}
		defer func() { _ = resp.Body.Close() }()
		data, e = io.ReadAll(io.LimitReader(resp.Body, imageReceiptResultReserve+1))
		if e != nil || int64(len(data)) > imageReceiptResultReserve {
			r.Status, r.ErrorCode = "unknown", "upstream_original_result_required"
			return saveImage2ProProgress(path, r)
		}
		if resp.StatusCode != http.StatusOK {
			r.Status, r.ErrorCode = "unknown", "upstream_original_result_required"
			// These statuses are documented rejection paths, never replayed.
			if resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 402 || resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 422 {
				r.Status, r.ErrorCode = "failed", "upstream_rejected_not_billed"
			}
			return saveImage2ProProgress(path, r)
		}
		if e = persistImage2ProResponse(path, data); e != nil {
			return e
		}
	} else if readErr != nil {
		return readErr
	}
	if r.UpstreamResponseHash != "" && r.UpstreamResponseHash != imageReceiptFingerprint(string(data)) {
		return errors.New("saved upstream response changed")
	}
	r.UpstreamResponseHash = imageReceiptFingerprint(string(data))
	r.Status, r.ErrorCode = "processing", ""
	r.NextPollAt = time.Now().UTC().Add(30 * time.Second)
	if err = saveImage2ProProgress(path, r); err != nil {
		return err
	}
	fetchResult := s.imageResultFetcher
	if fetchResult == nil {
		fetchResult = fetchImage2ProResultURL
	}
	normalized, err := normalizeImage2ProResult(ctx, data, fetchResult)
	if err != nil {
		r.Status, r.ErrorCode = "reconciling", "original_image_download_pending"
		return saveImage2ProProgress(path, r)
	}
	_, err = s.completeImageReceipt(ctx, path, r, account, key, quota, normalized)
	return err
}

func markImage2ProAwaitingOriginal(path string, r *imageReceiptRecord) error {
	r.Status, r.ErrorCode = "reconciling", "upstream_response_pending"
	if r.DispatchStartedAt.IsZero() || time.Since(r.DispatchStartedAt) >= 16*time.Minute {
		r.Status, r.ErrorCode = "unknown", "upstream_original_result_required"
	}
	r.NextPollAt = time.Now().UTC().Add(time.Minute)
	return saveImage2ProProgress(path, r)
}

func saveImage2ProProgress(path string, r *imageReceiptRecord) error {
	imageReceiptMu.Lock()
	defer imageReceiptMu.Unlock()
	return saveImageReceipt(path, r)
}

func readImage2ProResponse(path string) ([]byte, error) {
	info, err := os.Lstat(path + ".upstream")
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > imageReceiptResultReserve {
		return nil, errors.New("invalid saved image response")
	}
	return os.ReadFile(path + ".upstream")
}

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

func normalizeImage2ProResult(ctx context.Context, data []byte, fetchURL func(context.Context, string) ([]byte, error)) ([]byte, error) {
	var body struct {
		Error json.RawMessage `json:"error"`
		Data  []struct {
			URL string `json:"url"`
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &body) != nil || len(body.Data) != 1 || (len(body.Error) > 0 && string(body.Error) != "null") {
		return nil, errors.New("invalid image response")
	}
	item := body.Data[0]
	if (item.URL == "") == (item.B64 == "") {
		return nil, errors.New("ambiguous image result")
	}
	if item.URL != "" {
		raw, err := fetchURL(ctx, item.URL)
		if err != nil {
			return nil, err
		}
		item.B64 = base64.StdEncoding.EncodeToString(raw)
	}
	// Project only image bytes. Supplier URLs, metadata and request IDs never
	// enter the customer result; original image bytes themselves are unchanged.
	out, _ := json.Marshal(map[string]any{"data": []map[string]string{{"b64_json": item.B64}}})
	if err := validateReceiptImageResult(out); err != nil {
		return nil, err
	}
	return out, nil
}

func validateImage2ProResultURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 8192 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" ||
		(u.Port() != "" && u.Port() != "443") || isBlockedHostname(u.Hostname()) || strings.ContainsAny(raw, "\r\n") {
		return errors.New("unsafe image result target")
	}
	return nil
}

func fetchImage2ProResultURL(ctx context.Context, raw string) ([]byte, error) {
	if err := validateImage2ProResultURL(raw); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	// Use the existing DNS-pinned SSRF dialer; no upstream credential, cookies,
	// environment proxy or redirect is ever sent to a result host.
	transport := &http.Transport{DialContext: image2ProResultDial, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "image/png, image/jpeg, image/webp")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("image download unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 || resp.ContentLength > 20<<20 {
		return nil, errors.New("image download rejected")
	}
	mime := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "application/octet-stream" {
		return nil, errors.New("image download type rejected")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20+1))
	if err != nil || len(data) == 0 || len(data) > 20<<20 || (resp.ContentLength >= 0 && int64(len(data)) != resp.ContentLength) {
		return nil, errors.New("incomplete image download")
	}
	return data, nil
}

func image2ProResultDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || isBlockedHostname(host) {
		return nil, errors.New("unsafe image result target")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("image result DNS unavailable")
	}
	for _, a := range addresses {
		if !a.IP.IsGlobalUnicast() || isPrivateIP(a.IP) {
			return nil, errors.New("unsafe image result target")
		}
	}
	// Connect the validated address itself; a second DNS lookup cannot rebind it.
	var last error
	for _, a := range addresses {
		conn, e := safeDialContext(ctx, network, net.JoinHostPort(a.IP.String(), port))
		if e == nil {
			return conn, nil
		}
		last = e
	}
	return nil, last
}

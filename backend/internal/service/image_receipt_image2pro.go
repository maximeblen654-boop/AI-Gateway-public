package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const image2ProReceiptProtocol = "image2pro-sync-v1"

var ErrImage2ProLegacyAdmission = errors.New("该图片入口已停止创建新任务，请重新保存并发布商品后使用图片工作台。")

// Historical receipts recover only their original persisted response/result.
// This entry never starts a supplier generation, including queued old records.
func (s *OpenAIGatewayService) startImage2ProReceipt(path string, key *APIKey, quota APIKeyQuotaUpdater) {
	imageReceiptMu.Lock()
	defer imageReceiptMu.Unlock()
	r, err := readImageReceipt(path)
	if err != nil {
		return
	}
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
		if !r.DispatchStartedAt.IsZero() || r.Attempts > 0 {
			return markImage2ProAwaitingOriginal(path, r)
		}
		// No saved response and no previous dispatch: retire this queued record
		// locally. Do not create a marker, fetch a token, or send a replacement.
		r.Status, r.ErrorCode = "failed", "legacy_submission_disabled_not_billed"
		return saveImage2ProProgress(path, r)
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

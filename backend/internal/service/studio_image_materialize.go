package service

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// This transport reuses the gateway's proxy and SSRF-protected downloader.
// No Account credential is attached to an upstream-provided result URL.
type studioImageDownloadTransport struct {
	core    *OpenAIGatewayService
	account *Account
}

func (t studioImageDownloadTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		return nil, ErrStudioImageConflict
	}
	if _, err := t.core.validateOutboundURL(req.URL.String()); err != nil {
		return nil, err
	}
	if err := rejectPrivateImageHost(req.URL.String()); err != nil {
		return nil, err
	}
	req = req.Clone(WithHTTPUpstreamPublicHostsOnly(WithHTTPUpstreamRedirectsDisabled(req.Context())))
	req.Header.Del("Authorization")
	req.Header.Del("Cookie")
	proxy := ""
	if t.account.Proxy != nil {
		proxy = t.account.Proxy.URL()
	}
	return t.core.httpUpstream.Do(req, proxy, t.account.ID, t.account.Concurrency)
}

func (r *StudioImageRuntime) materializeResult(ctx context.Context, q StudioImageQuote, id string, body []byte) ([]byte, error) {
	// Complete inline envelopes retain their original bytes and hashes.
	if _, _, err := studioExecutionResult(body, q.Binding.Spec.Count); err == nil {
		return body, nil
	}
	path := r.Store.path("materialized", id)
	root, err := os.OpenRoot(r.Store.Root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	read := func() ([]byte, error) {
		saved, err := root.ReadFile(filepath.Base(path))
		if err == nil {
			_, _, err = studioExecutionResult(saved, q.Binding.Spec.Count)
		}
		return saved, err
	}
	if saved, err := read(); err == nil {
		return saved, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	a, err := r.Core.accountRepo.GetByID(ctx, q.Binding.Offer.AccountID)
	if err != nil || a == nil || studioCredentialFingerprint(a) != q.CredentialFingerprint {
		return nil, ErrStudioImageUnknown
	}
	client := &http.Client{Transport: studioImageDownloadTransport{r.Core, a}, Timeout: 60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	uploader := NewImageResultUploader(nil, "", 16<<20, client)
	data, err := uploader.Inline(ctx, body)
	if err != nil {
		return nil, ErrStudioImageUnknown
	}
	if _, _, err = studioExecutionResult(data, q.Binding.Spec.Count); err != nil {
		return nil, err
	}
	if err = r.Store.write(path, data, true); errors.Is(err, os.ErrExist) {
		return read()
	}
	return data, err
}

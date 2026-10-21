package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
)

var image2ProTaskID = regexp.MustCompile(`^[a-fA-F0-9]{16,80}$`)

// Safe evidence intentionally excludes the supplier body, echoed prompts,
// credentials and result URLs. A POST error does not prove non-submission.
type StudioVideoImage2ProHTTPError struct {
	Status         int    `json:"status"`
	Code           string `json:"code,omitempty"`
	ResponseSHA256 string `json:"response_sha256"`
}

func (e *StudioVideoImage2ProHTTPError) Error() string {
	return fmt.Sprintf("Image2Pro video HTTP %d code=%s response_sha256=%s", e.Status, e.Code, e.ResponseSHA256)
}
func newImage2ProHTTPError(status int, body []byte) *StudioVideoImage2ProHTTPError {
	var f struct {
		Code  string          `json:"code"`
		Error json.RawMessage `json:"error"`
	}
	_ = json.Unmarshal(body, &f)
	if f.Code == "" {
		var nested struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(f.Error, &nested) == nil {
			f.Code = nested.Code
		}
	}
	if f.Code != "invalid_request_error" {
		f.Code = ""
	}
	return &StudioVideoImage2ProHTTPError{Status: status, Code: f.Code, ResponseSHA256: fmt.Sprintf("%x", sha256.Sum256(body))}
}

type image2ProVideoTask struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	URL    string `json:"url"`
}

func decodeImage2ProTask(body []byte, expected string) (image2ProVideoTask, error) {
	var task image2ProVideoTask
	if json.Unmarshal(body, &task) != nil || !image2ProTaskID.MatchString(task.ID) || expected != "" && task.ID != expected {
		return task, ErrStudioVideoUnknown
	}
	switch task.Status {
	case "processing", "completed", "failed":
	default:
		return task, ErrStudioVideoUnknown
	}
	return task, nil
}

func (r *StudioVideoRuntime) requestImage2Pro(ctx context.Context, a *Account, method, path string, body []byte) ([]byte, string, error) {
	if r == nil || r.Core == nil || r.Core.httpUpstream == nil || a == nil || !imagecontract.IsImage2ProBase(a.GetOpenAIBaseURL()) || a.GetOpenAIProtocolAPIKey() == "" {
		return nil, "", ErrStudioVideoConflict
	}
	if a.ProxyID != nil && (a.Proxy == nil || a.Proxy.ID != *a.ProxyID) {
		return nil, "", ErrStudioVideoConflict
	}
	if strings.HasSuffix(path, "/content") {
		if method != http.MethodGet {
			return nil, "", ErrStudioVideoConflict
		}
		statusPath := strings.TrimSuffix(path, "/content")
		data, _, e := r.requestImage2Pro(ctx, a, http.MethodGet, statusPath, nil)
		if e != nil {
			return nil, "", e
		}
		task, e := decodeImage2ProTask(data, strings.TrimPrefix(statusPath, "/videos/"))
		if e != nil || task.Status != "completed" || task.URL == "" {
			return nil, "", ErrStudioVideoUnknown
		}
		return r.downloadImage2ProVideo(ctx, a, task.URL)
	}
	expected := ""
	switch method {
	case http.MethodPost:
		if path != "/videos" || len(body) == 0 {
			return nil, "", ErrStudioVideoConflict
		}
	case http.MethodGet:
		expected = strings.TrimPrefix(path, "/videos/")
		if !strings.HasPrefix(path, "/videos/") || !image2ProTaskID.MatchString(expected) {
			return nil, "", ErrStudioVideoConflict
		}
	default:
		return nil, "", ErrStudioVideoConflict
	}
	root := strings.TrimRight(a.GetOpenAIBaseURL(), "/")
	if !strings.HasSuffix(root, "/v1") {
		root += "/v1"
	}
	req, e := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), method, root+path, bytes.NewReader(body))
	if e != nil {
		return nil, "", e
	}
	req.GetBody = nil
	req.Header.Set("Authorization", "Bearer "+a.GetOpenAIProtocolAPIKey())
	req.Header.Set("Accept", "application/json")
	if method == http.MethodPost {
		id, _ := ctx.Value(videoIdempotencyContextKey{}).(string)
		if !AccountVideoChild(id) || len(id) > 120 {
			return nil, "", ErrStudioVideoConflict
		}
		req.Header.Set("Idempotency-Key", id)
		req.Header.Set("Content-Type", "application/json")
	}
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	resp, e := r.Core.httpUpstream.Do(req, proxy, a.ID, a.Concurrency)
	if e != nil {
		return nil, "", ErrStudioVideoUnknown
	}
	defer func() { _ = resp.Body.Close() }()
	data, e := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if e != nil || len(data) > 2<<20 {
		return nil, "", ErrStudioVideoUnknown
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		safe := newImage2ProHTTPError(resp.StatusCode, data)
		if method == http.MethodPost && r.Store != nil {
			id, _ := ctx.Value(videoIdempotencyContextKey{}).(string)
			if e := r.Store.put("request-error", id, safe); e != nil && !os.IsExist(e) {
				return nil, "", e
			}
		}
		return nil, "", safe
	}
	if _, e := decodeImage2ProTask(data, expected); e != nil {
		return nil, "", e
	}
	return data, "application/json", nil
}

func (r *StudioVideoRuntime) downloadImage2ProVideo(ctx context.Context, a *Account, rawURL string) ([]byte, string, error) {
	parsed, e := url.Parse(rawURL)
	if e != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, "", ErrStudioVideoUnknown
	}
	client := &http.Client{Transport: studioImageDownloadTransport{r.Core, a}, Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if e != nil {
		return nil, "", ErrStudioVideoUnknown
	}
	resp, e := client.Do(req)
	if e != nil {
		return nil, "", ErrStudioVideoUnknown
	}
	defer func() { _ = resp.Body.Close() }()
	ct, _, e := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if e != nil || resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Range") != "" || (ct != "video/mp4" && ct != "video/webm") || resp.ContentLength > 100_000_000 {
		return nil, "", ErrStudioVideoUnknown
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, 100_000_001))
	if e != nil || len(data) == 0 || len(data) > 100_000_000 || resp.ContentLength >= 0 && int64(len(data)) != resp.ContentLength {
		return nil, "", ErrStudioVideoUnknown
	}
	return data, ct, nil
}

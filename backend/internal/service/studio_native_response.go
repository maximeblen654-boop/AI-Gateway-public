package service

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Native forwarders own authentication, mapping and protocol conversion. Studio
// captures their response before durable delivery and its single billing path;
// invoking a public handler here would run admission and billing a second time.
type studioNativeResponse struct {
	header            http.Header
	body              bytes.Buffer
	status, limit     int
	written, overflow bool
}

func newStudioNativeContext(ctx context.Context, method, path string, body []byte, limit int) (*gin.Context, *studioNativeResponse) {
	w := &studioNativeResponse{header: make(http.Header), status: http.StatusOK, limit: limit}
	req, _ := http.NewRequestWithContext(withStudioNativeExecution(ctx), method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return &gin.Context{Request: req, Writer: w}, w
}
func (w *studioNativeResponse) Header() http.Header { return w.header }
func (w *studioNativeResponse) WriteHeader(code int) {
	if !w.written {
		w.status = code
	}
}
func (w *studioNativeResponse) WriteHeaderNow() { w.written = true }
func (w *studioNativeResponse) Write(p []byte) (int, error) {
	w.written = true
	if w.overflow || len(p) > w.limit-w.body.Len() {
		w.overflow = true
		return 0, errors.New("native media response exceeds limit")
	}
	return w.body.Write(p)
}
func (w *studioNativeResponse) WriteString(s string) (int, error) { return w.Write([]byte(s)) }
func (w *studioNativeResponse) Status() int                       { return w.status }
func (w *studioNativeResponse) Size() int {
	if !w.written {
		return -1
	}
	return w.body.Len()
}
func (w *studioNativeResponse) Written() bool            { return w.written }
func (w *studioNativeResponse) Flush()                   { w.WriteHeaderNow() }
func (w *studioNativeResponse) CloseNotify() <-chan bool { return make(chan bool) }
func (w *studioNativeResponse) Pusher() http.Pusher      { return nil }
func (w *studioNativeResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, errors.New("native media capture cannot hijack")
}

type studioNativeExecutionKey struct{}

func withStudioNativeExecution(ctx context.Context) context.Context {
	return context.WithValue(WithHTTPUpstreamRedirectsDisabled(ctx), studioNativeExecutionKey{}, true)
}
func isStudioNativeExecution(ctx context.Context) bool {
	return ctx.Value(studioNativeExecutionKey{}) == true
}

// A durable Studio claim already owns this generation. Do not make its POST
// replayable by HTTP transport retries or forward client idempotency headers.
func prepareStudioNativeRequest(req *http.Request) {
	if isStudioNativeExecution(req.Context()) {
		req.GetBody = nil
		req.Header.Del("Idempotency-Key")
		req.Header.Del("X-Idempotency-Key")
	}
}

func studioNativeResult(w *studioNativeResponse, result *OpenAIForwardResult, err error) ([]byte, string, error) {
	id := w.Header().Get("x-request-id")
	if result != nil {
		id = result.RequestID
	}
	if w.overflow {
		return nil, id, ErrStudioImageUnknown
	}
	if err != nil {
		var failover *UpstreamFailoverError
		if errors.As(err, &failover) {
			return nil, id, &StudioImageUpstreamError{Status: failover.StatusCode, RequestID: id}
		}
		if w.status >= 400 {
			return nil, id, &StudioImageUpstreamError{Status: w.status, RequestID: id}
		}
		return nil, id, ErrStudioImageUnknown
	}
	if w.status != http.StatusOK {
		return nil, id, &StudioImageUpstreamError{Status: w.status, RequestID: id}
	}
	return w.body.Bytes(), id, nil
}

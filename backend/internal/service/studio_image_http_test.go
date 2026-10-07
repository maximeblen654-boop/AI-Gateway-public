package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Exercise the production request builder and dispatchHTTP with real TLS HTTP.
// Only the supplier is simulated; no credential or response crosses the host.
type studioImageLoopbackHTTP struct {
	HTTPUpstream
	client *http.Client
	t      *testing.T
}

func (s studioImageLoopbackHTTP) Do(req *http.Request, proxy string, accountID int64, concurrency int) (*http.Response, error) {
	require.Equal(s.t, int64(7), accountID)
	require.Equal(s.t, 1, concurrency)
	require.Empty(s.t, proxy)
	require.Nil(s.t, req.GetBody, "POST must not be replayable")
	return s.client.Do(req)
}

func TestStudioImageRealHTTPRecovery(t *testing.T) {
	for _, mode := range []string{"success", "reject", "lost_response", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			var posts atomic.Int32
			result := studioResult(t, "png")
			supplier := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				posts.Add(1)
				require.Equal(t, "POST", req.Method)
				require.Equal(t, "/v1/images/generations", req.URL.Path)
				require.Equal(t, "Bearer synthetic-only", req.Header.Get("Authorization"))
				require.Empty(t, req.Header.Get("Idempotency-Key"))
				body, err := io.ReadAll(req.Body)
				require.NoError(t, err)
				var fields map[string]any
				require.NoError(t, json.Unmarshal(body, &fields))
				require.Equal(t, "gpt-image-2", fields["model"])
				require.Equal(t, "1024x1024", fields["size"])
				require.Equal(t, float64(1), fields["n"])
				switch mode {
				case "reject":
					w.WriteHeader(422)
					_, _ = w.Write([]byte(`{"error":"synthetic private provider detail"}`))
				case "lost_response":
					conn, _, hijackErr := w.(http.Hijacker).Hijack()
					require.NoError(t, hijackErr)
					_ = conn.Close()
				case "timeout":
					<-req.Context().Done()
				default:
					w.Header().Set("x-request-id", "synthetic-original")
					_, _ = w.Write(result)
				}
			}))
			defer supplier.Close()
			r, q, key, _, billing := studioContractFixture(t, supplier.URL+"/v1")
			client := supplier.Client() // trusts only the local fixture certificate
			client.Timeout = 500 * time.Millisecond
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			r.Core.httpUpstream = studioImageLoopbackHTTP{client: client, t: t}
			r.network = r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			_, err := r.Dispatch(context.Background(), c, q, "http-original", "synthetic", nil, key)
			if mode == "success" {
				require.NoError(t, err)
				require.Equal(t, 1, billing.applied)
			} else {
				require.ErrorIs(t, err, ErrStudioImageUnknown)
				require.NotContains(t, err.Error(), "provider detail")
				require.Zero(t, billing.applied)
			}
			// Recreate runtime/store from disk; recovery uses the original receipt.
			t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", "true")
			restarted := NewStudioImageRuntime(r.Core, r.Media)
			restarted.Store = NewStudioImageStore(r.Store.Root)
			_, _ = restarted.Dispatch(context.Background(), c, q, "http-original", "synthetic", nil, key)
			receipt, recoveredErr := restarted.Recover(context.Background(), "http-original", q.Owner)
			require.EqualValues(t, 1, posts.Load())
			if mode == "success" {
				require.NoError(t, recoveredErr)
				require.Equal(t, "billed", receipt.BillingState)
				require.Equal(t, 1, billing.applied)
			} else {
				require.ErrorIs(t, recoveredErr, ErrStudioImageUnknown)
				require.Zero(t, billing.applied)
			}
			_, err = restarted.Recover(context.Background(), "http-original", StudioImageOwner{9, 2, 3})
			require.Error(t, err)
		})
	}
}

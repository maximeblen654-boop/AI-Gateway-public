package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Preserve the configured supplier identity; transport is loopback-only.
type imageFinalityHTTP struct {
	HTTPUpstream
	target *url.URL
	client *http.Client
	t      *testing.T
}

func (h imageFinalityHTTP) Do(req *http.Request, proxy string, account int64, concurrency int) (*http.Response, error) {
	require.Equal(h.t, "api.image2pro.top", req.URL.Hostname())
	require.Nil(h.t, req.GetBody)
	copy := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = h.target.Scheme
	u.Host = h.target.Host
	copy.URL = &u
	return h.client.Do(copy)
}

func TestStudioImage502CustomerFinalityRealHTTP(t *testing.T) {
	for _, scenario := range []string{"502", "partial502", "timeout", "disconnect", "success", "conflicting_output"} {
		t.Run(scenario, func(t *testing.T) {
			var posts atomic.Int32
			result := studioResultN(t, 2)
			supplier := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				n := posts.Add(1)
				switch scenario {
				case "timeout":
					select {
					case <-req.Context().Done():
					case <-time.After(500 * time.Millisecond):
					}
					return
				case "disconnect":
					hijacker, ok := w.(http.Hijacker)
					require.True(t, ok)
					conn, _, err := hijacker.Hijack()
					require.NoError(t, err)
					_ = conn.Close()
					return
				case "success":
					data := result
					if n == 3 {
						data = studioResultN(t, 1)
					}
					_, _ = w.Write(data)
					return
				case "partial502":
					if n == 1 {
						_, _ = w.Write(result)
						return
					}
				case "conflicting_output":
					w.WriteHeader(502)
					_, _ = w.Write(result)
					return
				}
				w.Header().Set("x-request-id", "synthetic-final-502")
				w.WriteHeader(502)
				_, _ = w.Write([]byte(`{"error":"synthetic busy"}`))
			}))
			defer supplier.Close()
			r, _, key, _, billing := studioContractFixture(t, "https://api.image2pro.top/v1")
			q := enableStudioNativeMulti(t, r)
			target, err := url.Parse(supplier.URL)
			require.NoError(t, err)
			client := supplier.Client()
			client.Timeout = 100 * time.Millisecond
			r.Core.httpUpstream = imageFinalityHTTP{target: target, client: client, t: t}
			r.network = r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			receipt, err := r.Dispatch(context.Background(), c, q, "final-"+scenario, "synthetic", nil, key)
			switch scenario {
			case "502":
				require.NoError(t, err)
				require.Equal(t, "failed", receipt.Status)
				require.Equal(t, "not_charged", receipt.BillingState)
				require.Equal(t, studioImageNoCharge502, StudioImageFailureCode(receipt))
				require.Equal(t, 5, receipt.FailedCount)
				proof := receipt.Units[0].HTTPFailure
				require.NotNil(t, proof)
				require.Equal(t, 502, proof.Status)
				require.Equal(t, "synthetic-final-502", proof.RequestID)
				require.Equal(t, "synthetic busy", proof.Message)
				require.NotEmpty(t, proof.ResponseHash)
				require.Error(t, r.Store.writeUnitOutcome(receipt.Units[0], "response", result, "late"))
				require.Error(t, r.Store.PersistResult(receipt, result))
				_, err = SettleQuotedImage(context.Background(), billing, receipt)
				require.Error(t, err)
				require.NoError(t, os.WriteFile(r.Store.path("upstream", receipt.TaskID), result, 0600))
			case "partial502":
				require.NoError(t, err)
				require.Equal(t, "partial", receipt.Status)
				require.Equal(t, 2, receipt.DeliveredCount)
				require.Equal(t, 3, receipt.FailedCount)
				require.Equal(t, "1.60", billing.cmd.ExactAmounts.Balance)
				require.Equal(t, 1, billing.applied)
				require.Error(t, r.Store.writeUnitOutcome(receipt.Units[1], "response", result, "late"))
			case "success":
				require.NoError(t, err)
				require.Equal(t, "completed", receipt.Status)
				require.Equal(t, "4.00", billing.cmd.ExactAmounts.Balance)
			default:
				require.ErrorIs(t, err, ErrStudioImageUnknown)
				require.Equal(t, "unknown", receipt.Status)
				require.Equal(t, "pending", receipt.BillingState)
			}
			before := posts.Load()
			applied := billing.applied
			restarted := *r
			restarted.Store = NewStudioImageStore(r.Store.Root)
			for range 3 {
				got, _ := restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
				require.Equal(t, receipt.Status, got.Status)
			}
			_, _ = restarted.Dispatch(context.Background(), c, q, receipt.TaskID, "synthetic", nil, key)
			require.Equal(t, before, posts.Load())
			require.Equal(t, applied, billing.applied)
			if scenario != "success" && scenario != "partial502" {
				require.Zero(t, billing.calls)
			}
			_, err = restarted.Recover(context.Background(), receipt.TaskID, StudioImageOwner{99, 2, 3})
			require.Error(t, err)
		})
	}
}

func TestStudioImage502EvidenceScope(t *testing.T) {
	for _, tc := range []struct {
		name, base string
		status     int
		native     bool
		want       bool
	}{
		{"supplier", "https://api.image2pro.top/v1", 502, true, true},
		{"other", "https://supplier.example/v1", 502, true, false},
		{"spoof", "https://api.image2pro.top.evil.example/v1", 502, true, false},
		{"timeout", "https://api.image2pro.top/v1", 0, true, false},
		{"503", "https://api.image2pro.top/v1", 503, true, false},
		{"native_api", "https://api.image2pro.top/v1", 502, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			if tc.native {
				ctx = withStudioNativeExecution(ctx)
			}
			req, _ := http.NewRequestWithContext(ctx, "POST", "/v1/images/generations", nil)
			c := &gin.Context{Request: req}
			a := &Account{Type: AccountTypeAPIKey, Platform: PlatformOpenAI, Credentials: map[string]any{"base_url": tc.base}}
			recordStudioImageHTTPFailure(c, a, tc.status, "request", []byte(`{"error":"busy"}`))
			value, ok := c.Get(studioImageHTTPFailureKey)
			if !tc.native {
				require.False(t, ok)
				return
			}
			proof, valid := value.(*StudioImageHTTPFailure)
			require.True(t, valid)
			require.Equal(t, tc.want, proof.NoChargeFinal)
		})
	}
	require.Nil(t, studioImageFinalFailure(&StudioImageUpstreamError{Status: 502}))
	require.Nil(t, studioImageFinalFailure(context.DeadlineExceeded))
}

func TestStudioImageHistorical502RemainsUnknown(t *testing.T) {
	r, _, key, _, billing := studioContractFixture(t, "https://api.image2pro.top/v1")
	q := enableStudioNativeMulti(t, r)
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		return nil, "old", &StudioImageUpstreamError{Status: 502}
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "historical-unknown", "old", nil, key)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	got, err := r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	require.Equal(t, "unknown", got.Status)
	require.Empty(t, StudioImageFailureCode(got))
	require.Zero(t, billing.calls)
}

func TestStudioImageHTTPFailureRedactsCredential(t *testing.T) {
	c, _ := newStudioNativeContext(context.Background(), "POST", "/v1/images/generations", nil, 1024)
	a := &Account{Type: AccountTypeAPIKey, Platform: PlatformOpenAI, Credentials: map[string]any{"base_url": "https://api.image2pro.top/v1", "api_key": "synthetic-secret"}}
	recordStudioImageHTTPFailure(c, a, 502, "id", []byte(`{"error":"token synthetic-secret https://example.invalid/?key=private"}`))
	proof, _ := c.Get(studioImageHTTPFailureKey)
	failure, ok := proof.(*StudioImageHTTPFailure)
	require.True(t, ok)
	message := failure.Message
	require.NotContains(t, message, "synthetic-secret")
	require.NotContains(t, message, "key=private")
}

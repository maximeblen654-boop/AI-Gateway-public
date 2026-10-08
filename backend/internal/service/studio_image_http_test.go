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

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
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
	for _, mode := range []string{"success", "widescreen", "different_pixels", "different_ratio", "reject", "lost_response", "timeout", "wrong_count", "missing_metadata"} {
		t.Run(mode, func(t *testing.T) {
			var posts atomic.Int32
			result := studioResult(t, "png")
			switch mode {
			case "different_pixels":
				result = studioPixelResult(t, 512, 512)
			case "different_ratio":
				result = studioPixelResult(t, 1024, 576)
			case "wrong_count":
				result = []byte(`{"data":[]}`)
			case "missing_metadata":
				// Supplier JSON dimensions cannot stand in for a decodable image.
				result = []byte(`{"data":[{"b64_json":"AQ==","width":1024,"height":1024}]}`)
			}
			validResult := mode == "success" || mode == "widescreen" || mode == "different_pixels" || mode == "different_ratio"
			wireSize := "1024x1024"
			if mode == "widescreen" {
				wireSize = "1536x864"
				result = studioPixelResult(t, 1536, 864)
			}
			transportUnknown := mode == "reject" || mode == "lost_response" || mode == "timeout"
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
				require.Equal(t, wireSize, fields["size"])
				require.Equal(t, float64(1), fields["n"])
				switch mode {
				case "reject":
					w.WriteHeader(422)
					_, _ = w.Write([]byte(`{"error":"synthetic private provider detail"}`))
				case "lost_response":
					hijacker, ok := w.(http.Hijacker)
					require.True(t, ok)
					conn, _, hijackErr := hijacker.Hijack()
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
			if mode == "widescreen" {
				ma := r.Media.(*studioMediaFixture)
				admin := mediaworkbench.NewService(ma)
				product := ma.a.Config.Draft.Products[0]
				product.Capabilities.AspectRatios = []string{"16:9"}
				product.AdapterConfig.SizeMappings = []mediaworkbench.SizeMapping{{Resolution: "1K", AspectRatio: "16:9", WireSize: wireSize}}
				draft, e := admin.SaveDraft(context.Background(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
				require.NoError(t, e)
				require.True(t, draft.Config.Validation.PublishReady)
				published, e := admin.Publish(context.Background(), 7, draft.Config.RecordVersion, draft.Config.Draft.Revision)
				require.NoError(t, e)
				r.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: studioAccountPrice("0.35")}}
				token, e := r.Issue(context.Background(), q.Owner, key, published.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "16:9", Count: 1}, nil)
				require.NoError(t, e)
				q, e = r.Store.Quote(token, q.Owner, time.Now())
				require.NoError(t, e)
			}
			client := supplier.Client() // trusts only the local fixture certificate
			client.Timeout = 500 * time.Millisecond
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			r.Core.httpUpstream = studioImageLoopbackHTTP{client: client, t: t}
			r.network = r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			_, err := r.Dispatch(context.Background(), c, q, "http-original", "synthetic", nil, key)
			if validResult {
				require.NoError(t, err)
				require.Equal(t, 1, billing.applied)
			} else {
				require.Error(t, err)
				if transportUnknown {
					require.ErrorIs(t, err, ErrStudioImageUnknown)
				}
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
			if validResult {
				require.NoError(t, recoveredErr)
				require.Equal(t, "billed", receipt.BillingState)
				require.Equal(t, 1, billing.applied)
				require.Equal(t, 1, billing.calls)
				require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
				saved, readErr := restarted.Store.Result(receipt)
				require.NoError(t, readErr)
				require.Equal(t, result, saved, "preview/download must use unchanged supplier bytes")
				require.Equal(t, HashUsageRequestPayload(result), receipt.ResultHash)
			} else {
				require.Error(t, recoveredErr)
				if transportUnknown {
					require.ErrorIs(t, recoveredErr, ErrStudioImageUnknown)
				}
				require.Equal(t, "unknown", receipt.Status)
				require.Equal(t, "pending", receipt.BillingState)
				require.Empty(t, receipt.ResultHash)
				require.Zero(t, billing.applied)
				require.Zero(t, billing.calls)
			}
			t.Logf("request size=%s n=1; task=http-original status=%s billing=%s supplier_posts=%d native_billing_calls=%d applied=%d result_hash=%s", wireSize, receipt.Status, receipt.BillingState, posts.Load(), billing.calls, billing.applied, receipt.ResultHash)
			_, err = restarted.Recover(context.Background(), "http-original", StudioImageOwner{9, 2, 3})
			require.Error(t, err)
		})
	}
}

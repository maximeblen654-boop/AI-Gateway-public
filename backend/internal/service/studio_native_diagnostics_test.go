package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestStudioNativeImageFailureOpsContext(t *testing.T) {
	for _, edit := range []bool{false, true} {
		endpoint := "/v1/images/generations"
		fields := map[string]any{"model": "gpt-image-2", "prompt": "synthetic", "n": 1}
		if edit {
			endpoint = "/v1/images/edits"
			fields["images"] = []map[string]string{{"image_url": "data:image/png;base64,AQ=="}}
		}
		t.Run(endpoint, func(t *testing.T) {
			calls := 0
			upstream := studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
				calls++
				require.Equal(t, int64(77), id)
				require.Nil(t, req.GetBody)
				return &http.Response{StatusCode: 502, Header: http.Header{"X-Request-Id": {"synthetic-upstream-502"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"synthetic upstream busy"}}`))}, nil
			}}
			runtime := &StudioImageRuntime{Core: &OpenAIGatewayService{cfg: &config.Config{}, httpUpstream: upstream}}
			account := &Account{ID: 77, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "synthetic", "base_url": "https://mock.invalid"}}
			writer := httptest.NewRecorder()
			outer, _ := gin.CreateTestContext(writer)
			outer.Request = httptest.NewRequest("POST", "/internal/studio", nil)
			outer.Set("owner", int64(2))
			body, err := json.Marshal(fields)
			require.NoError(t, err)
			_, upstreamID, err := runtime.dispatchHTTP(context.Background(), outer, account, body, endpoint)
			require.ErrorIs(t, err, ErrStudioImageUnknown)
			require.NotContains(t, err.Error(), "synthetic upstream busy")
			require.Equal(t, "synthetic-upstream-502", upstreamID)
			require.Equal(t, 1, calls)
			require.Empty(t, writer.Body.String())
			events, ok := outer.Get(OpsUpstreamErrorsKey)
			require.True(t, ok, "native diagnostics must reach original Ops context")
			attempts, ok := events.([]*OpsUpstreamErrorEvent)
			require.True(t, ok)
			require.Len(t, attempts, 1)
			require.Equal(t, 502, attempts[0].UpstreamStatusCode)
			require.Equal(t, int64(77), attempts[0].AccountID)
			require.Equal(t, "synthetic-upstream-502", attempts[0].UpstreamRequestID)
			require.Equal(t, "synthetic upstream busy", attempts[0].Message)
			_, ok = outer.Get(OpsUpstreamLatencyMsKey)
			require.True(t, ok)
			require.Equal(t, int64(2), outer.MustGet("owner"))
		})
	}
}

func TestStudioNativeFailureReceiptRecovery(t *testing.T) {
	r, _, key, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	calls := 0
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
		calls++
		require.Nil(t, req.GetBody)
		return &http.Response{StatusCode: 502, Header: http.Header{"X-Request-Id": {"original-failed-request"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"busy"}}`))}, nil
	}}
	r.network = r.dispatchHTTP
	receipt, err := r.Dispatch(context.Background(), nil, q, "diagnostic-original", "synthetic", nil, key)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	var outcome studioImageUnitOutcome
	require.NoError(t, studioRead(r.Store.path("unit-response", receipt.Units[0].ID), &outcome))
	require.Equal(t, "original-failed-request", outcome.UpstreamID)
	require.Equal(t, "unknown", outcome.State)
	restarted := NewStudioImageRuntime(r.Core, r.Media)
	restarted.Store = NewStudioImageStore(r.Store.Root)
	for i := 0; i < 2; i++ {
		receipt, err = restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
		require.ErrorIs(t, err, ErrStudioImageUnknown)
		require.Equal(t, "unknown", receipt.Status)
		require.Equal(t, "pending", receipt.BillingState)
	}
	require.Equal(t, 1, calls)
	require.Zero(t, billing.calls)
	require.Zero(t, billing.applied)
}

func TestStudioNativeDiagnosticsIsolation(t *testing.T) {
	outer, _ := gin.CreateTestContext(httptest.NewRecorder())
	native, _ := newStudioNativeContext(context.Background(), "POST", "/test", nil, 100)
	outer.Set("owner", int64(2))
	native.Set("owner", int64(9))
	native.Set(ResponseCommittedKey, true)
	appendOpsUpstreamError(outer, OpsUpstreamErrorEvent{AccountID: 1, Message: "first"})
	appendOpsUpstreamError(native, OpsUpstreamErrorEvent{AccountID: 77, Message: "second", UpstreamRequestID: "last"})
	require.Equal(t, "last", preserveStudioNativeDiagnostics(outer, native))
	require.Equal(t, int64(2), outer.MustGet("owner"))
	_, ok := outer.Get(ResponseCommittedKey)
	require.False(t, ok)
	events, ok := outer.MustGet(OpsUpstreamErrorsKey).([]*OpsUpstreamErrorEvent)
	require.True(t, ok)
	require.Len(t, events, 2)
	nativeEvents, ok := native.MustGet(OpsUpstreamErrorsKey).([]*OpsUpstreamErrorEvent)
	require.True(t, ok)
	nativeEvents[0].Message = "changed"
	require.Equal(t, "second", events[1].Message)
	require.Equal(t, "last", preserveStudioNativeDiagnostics(nil, native))
	require.Empty(t, preserveStudioNativeDiagnostics(outer, nil))
}

package studiobridge

import (
	"context"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVideoBridgeOriginalKeyAndPrivateSettlement(t *testing.T) {
	token := strings.Repeat("s", 32)
	calls := 0
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "Bearer synthetic-customer-key", r.Header.Get("Authorization"))
		require.Equal(t, token, r.Header.Get("X-Studio-Service-Token"))
		require.True(t, strings.HasPrefix(r.URL.Path, "/v1/studio/videos/"))
		if strings.HasSuffix(r.URL.Path, "/result") {
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("X-Video-Quality", "original")
			_, _ = w.Write([]byte("fixture-bytes"))
			return
		}
		_, _ = w.Write([]byte(`{"contract":"account_video_v1","status":"captured"}`))
	}))
	defer core.Close()
	keys := &imageKeys{}
	b, e := NewVideo(ImageOptions{ServiceToken: token, GroupID: 3, CoreURL: core.URL, Keys: keys, Verify: func(_ context.Context, p string) (int64, error) {
		if p != "proof" {
			return 0, errors.New("proof")
		}
		return 1, nil
	}})
	require.NoError(t, e)
	call := func(method, path, proof, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, VideoPath+path, strings.NewReader(`{"key_ref":42,"payload":{"result_hash":"fixture"}}`))
		r.Header.Set("X-Studio-Service-Token", token)
		r.Header.Set("X-Studio-Session-Proof", proof)
		r.Header.Set("X-Studio-Binding-Contract", service.StudioVideoBindingVersion)
		r.Header.Set("X-Studio-Key-Ref", key)
		out := httptest.NewRecorder()
		b.ServeHTTP(out, r)
		return out
	}
	require.Equal(t, 200, call("GET", "tasks/av_original", "proof", "42").Code)
	require.Equal(t, 200, call("POST", "tasks/av_original/capture", "proof", "42").Code)
	require.Contains(t, call("GET", "tasks/av_original/result", "proof", "42").Body.String(), "Zml4dHVyZS1ieXRlcw==")
	require.Equal(t, 3, keys.receiptCalls)
	before := calls
	require.Equal(t, 403, call("GET", "tasks/av_original", "proof", "99").Code)
	require.Equal(t, 401, call("POST", "tasks/av_original/capture", "bad", "42").Code)
	require.Equal(t, 404, call("GET", "tasks/legacy_slot", "proof", "42").Code)
	require.Equal(t, 503, call("POST", "tasks", "proof", "42").Code)
	require.Equal(t, before, calls)
}

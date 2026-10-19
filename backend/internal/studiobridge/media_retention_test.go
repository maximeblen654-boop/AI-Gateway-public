package studiobridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestMediaRetentionBridgeVideoOriginalAndExpiry(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "available", true: "expired"}[expired], func(t *testing.T) {
			retention := map[string]any{"persisted_at": "2026-10-01T00:00:00Z", "expires_at": "2026-10-03T00:00:00Z", "expired": expired, "policy": service.StudioVideoRetentionPolicy}
			metadata, err := json.Marshal(retention)
			require.NoError(t, err)
			core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if expired {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusGone)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": "result_expired", "result_retention": retention})
					return
				}
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("X-Video-Quality", "original")
				w.Header().Set("X-Studio-Result-Retention", string(metadata))
				_, _ = w.Write([]byte("synthetic-original"))
			}))
			defer core.Close()
			token := strings.Repeat("s", 32)
			bridge, err := NewVideo(ImageOptions{ServiceToken: token, GroupID: 3, CoreURL: core.URL, Keys: &imageKeys{}, Verify: func(context.Context, string) (int64, error) { return 1, nil }})
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodGet, VideoPath+"tasks/av_retention/result", nil)
			req.Header.Set("X-Studio-Service-Token", token)
			req.Header.Set("X-Studio-Session-Proof", "proof")
			req.Header.Set("X-Studio-Binding-Contract", service.StudioVideoBindingVersion)
			req.Header.Set("X-Studio-Key-Ref", "42")
			out := httptest.NewRecorder()
			bridge.ServeHTTP(out, req)
			var body map[string]any
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &body))
			if expired {
				require.Equal(t, http.StatusGone, out.Code)
				require.Equal(t, "result_expired", body["code"])
				require.Equal(t, retention, body["result_retention"])
				require.NotContains(t, out.Body.String(), "bytes_base64")
			} else {
				require.Equal(t, http.StatusOK, out.Code)
				data, ok := body["data"].(map[string]any)
				require.True(t, ok, "expected data object")
				payload, ok := data["payload"].(map[string]any)
				require.True(t, ok, "expected payload object")
				require.Equal(t, retention, payload["result_retention"])
				require.NotEmpty(t, payload["bytes_base64"])
			}
		})
	}
}

func TestMediaRetentionBridgeCaptureForwardsTrustedTimestamp(t *testing.T) {
	payload := `{"result_hash":"` + strings.Repeat("a", 64) + `","result_retention":{"persisted_at":"2026-10-01T00:00:00Z","expires_at":"2026-10-03T00:00:00Z","expired":false,"policy":"video_original_48h"}}`
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.JSONEq(t, payload, string(data))
		_, _ = w.Write([]byte(`{"contract":"account_video_v1","status":"captured"}`))
	}))
	defer core.Close()
	token := strings.Repeat("s", 32)
	bridge, err := NewVideo(ImageOptions{ServiceToken: token, GroupID: 3, CoreURL: core.URL, Keys: &imageKeys{}, Verify: func(context.Context, string) (int64, error) { return 1, nil }})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, VideoPath+"tasks/av_retention/capture", strings.NewReader(`{"key_ref":42,"payload":`+payload+`}`))
	req.Header.Set("X-Studio-Service-Token", token)
	req.Header.Set("X-Studio-Session-Proof", "proof")
	req.Header.Set("X-Studio-Binding-Contract", service.StudioVideoBindingVersion)
	out := httptest.NewRecorder()
	bridge.ServeHTTP(out, req)
	require.Equal(t, http.StatusOK, out.Code)
}

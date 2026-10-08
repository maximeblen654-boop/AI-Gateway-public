package studiobridge

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVideoBFFBridgeCoreLoopbackRecovery(t *testing.T) {
	node, e := exec.LookPath("node")
	require.NoError(t, e)
	ffmpeg, e := exec.LookPath("ffmpeg")
	require.NoError(t, e)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// The valid original intentionally differs from the frozen 1280x720/8s
	// request. The real BFF/Bridge transport must preserve and capture it once.
	original, e := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=5", "-t", "2", "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1").Output()
	require.NoError(t, e)
	var mu sync.Mutex
	posts, captures, resultGets := 0, 0, 0
	taskID, requestHash, status := "", "", "completed"
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		require.Equal(t, "Bearer synthetic-customer-key", r.Header.Get("Authorization"))
		require.Equal(t, strings.Repeat("s", 32), r.Header.Get("X-Studio-Service-Token"))
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/studio/videos/catalog":
			// The BFF resolves the Published offer before compiling the request.
			// Keep this fixture aligned with the production catalog contract so the
			// recovery assertions below exercise the complete bridge path.
			_ = json.NewEncoder(w).Encode(map[string]any{"offers": []any{map[string]any{
				"offer_id": "offer-original", "model": "3.0",
				"video_profile": map[string]any{"apiModelId": "3.0", "upstreamModelId": "3.0", "documentedStatus": "enabled", "durationSeconds": []int{8}, "resolutions": []string{"1280x720"}, "ratios": []string{"16:9"}, "inputMode": "images", "requiredAnyMedia": []string{}, "mediaLimits": map[string]int{"image": 9, "video": 0, "audio": 0, "total": 9}, "promptMaxLength": 6000},
			}}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/quotes"):
			var in struct {
				Offer   string          `json:"offer_id"`
				Spec    any             `json:"spec"`
				Request json.RawMessage `json:"request"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
			var fields map[string]any
			require.NoError(t, json.Unmarshal(in.Request, &fields))
			require.Equal(t, "1280x720", fields["resolution"])
			require.Equal(t, float64(8), fields["duration"])
			require.Equal(t, "16:9", fields["ratio"])
			requestHash = service.HashUsageRequestPayload(in.Request)
			binding := map[string]any{"version": "account_video_v1", "quote_id": "quote-original", "owner": map[string]int{"user_id": 1, "api_key_id": 42, "group_id": 3}, "published_revision": "original-published", "offer": map[string]any{"offer_id": in.Offer, "account_id": 7, "site_model": "3.0", "adapter": map[string]string{"revision": "laoli_video_json_v136_r1"}, "sale_price": map[string]string{"amount": "0.80", "currency": "CNY", "billing_mode": "per_request"}}, "spec": in.Spec, "request_hash": requestHash, "expires_at": time.Now().Add(time.Minute)}
			_ = json.NewEncoder(w).Encode(map[string]any{"contract": "account_video_v1", "quote_token": strings.Repeat("b", 64), "binding_hash": strings.Repeat("a", 64), "binding": binding})
		case r.Method == "POST" && r.URL.Path == "/v1/studio/videos/tasks":
			var in struct {
				ID string `json:"task_id"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
			taskID = in.ID
			posts++
			http.Error(w, "lost response after accept", http.StatusBadGateway)
		case r.Method == "GET" && r.URL.Path == "/v1/studio/videos/tasks/"+taskID:
			_ = json.NewEncoder(w).Encode(map[string]any{"contract": "account_video_v1", "task_id": taskID, "upstream_id": "original-upstream", "status": status, "request_hash": requestHash, "binding_hash": strings.Repeat("a", 64)})
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/result"):
			resultGets++
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("X-Video-Quality", "original")
			_, _ = w.Write(original)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/capture"):
			var in struct {
				Hash string `json:"result_hash"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&in))
			require.Equal(t, service.HashUsageRequestPayload(original), in.Hash)
			captures++
			status = "captured"
			_ = json.NewEncoder(w).Encode(map[string]string{"contract": "account_video_v1", "task_id": taskID, "status": status})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", 500)
		}
	}))
	defer core.Close()
	keys := &imageKeys{}
	bridge, e := NewVideo(ImageOptions{ServiceToken: strings.Repeat("s", 32), GroupID: 3, CoreURL: core.URL, Keys: keys, Verify: func(_ context.Context, p string) (int64, error) {
		if p != "valid-proof" {
			return 0, errors.New("proof")
		}
		return 1, nil
	}})
	require.NoError(t, e)
	bridge.enabled = true
	server := httptest.NewServer(bridge)
	defer server.Close()
	probe, e := filepath.Abs(filepath.Join("..", "..", "..", "studio", "bff", "test", "video-bridge-contract-probe.mjs"))
	require.NoError(t, e)
	out, e := exec.CommandContext(ctx, node, probe, server.URL, t.TempDir(), service.HashUsageRequestPayload(original)).CombinedOutput()
	require.NoError(t, e, string(out))
	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, 1, posts)
	require.Equal(t, 1, captures)
	require.Equal(t, 1, resultGets)
	require.Equal(t, int64(42), keys.last)
	t.Log(string(out))
	t.Logf("request=1280x720/8s/16:9 original=640x360/2s task_posts=%d captures=%d original_gets=%d", posts, captures, resultGets)
}

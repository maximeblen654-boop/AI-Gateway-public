//go:build unit

package service

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestStudioSeedanceUsesNativeTaskLifecycle(t *testing.T) {
	var paths []string
	var createBody []byte
	up := studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
		require.Equal(t, int64(9), id)
		paths = append(paths, req.URL.Path)
		if req.Method == http.MethodPost {
			createBody, _ = io.ReadAll(req.Body)
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(io.LimitReader(strings.NewReader(`{"id":"task-seed"}`), 1024))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"task-seed","status":"succeeded","content":{"video_url":"https://cdn.example/video.mp4"}}`))}, nil
	}}
	core := &OpenAIGatewayService{cfg: &config.Config{}, httpUpstream: up}
	runtime := &StudioVideoRuntime{Core: core}
	a := &Account{ID: 9, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "synthetic", "base_url": "https://ark.example/api/v3", "openai_capabilities": []string{"seedance"}, "model_mapping": map[string]any{"site-video": "ep-video"}}}
	seedanceContext := context.WithValue(context.Background(), videoAdapterContextKey{}, "seedance_video")
	_, _, err := runtime.requestHTTP(seedanceContext, a, http.MethodPost, "/contents/generations/tasks", []byte(`{"model":"site-video","content":[{"type":"text","text":"waves"}],"duration":5,"resolution":"720p","aspect_ratio":"16:9"}`))
	require.NoError(t, err)
	require.Contains(t, string(createBody), `"model":"ep-video"`)
	status, _, err := runtime.requestHTTP(seedanceContext, a, http.MethodGet, "/videos/task-seed", nil)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"task-seed","status":"completed"}`, string(status))
	require.Equal(t, []string{"/api/v3/contents/generations/tasks", "/api/v3/contents/generations/tasks/task-seed"}, paths)
	paths = nil
	_, _, err = runtime.requestHTTP(context.Background(), a, http.MethodGet, "/videos/legacy-task", nil)
	require.NoError(t, err)
	require.Equal(t, []string{"/api/v3/v1/videos/legacy-task"}, paths, "a Seedance-capable Account must not hijack generic video bindings")
}

func TestStudioSeedanceMaterializesContentFromRawStatus(t *testing.T) {
	up := studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
		require.Equal(t, int64(9), id)
		if req.URL.Host == "cdn.example" {
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{
				"Content-Type": {"video/mp4"},
			}, Body: io.NopCloser(strings.NewReader("video-bytes"))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"task-seed","status":"succeeded","content":{"video_url":"https://cdn.example/video.mp4"}}`))}, nil
	}}
	core := &OpenAIGatewayService{cfg: &config.Config{}, httpUpstream: up}
	runtime := &StudioVideoRuntime{Core: core}
	a := &Account{ID: 9, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{
		"api_key": "synthetic", "base_url": "https://ark.example/api/v3", "openai_capabilities": []string{"seedance"},
	}}
	ctx := context.WithValue(context.Background(), videoAdapterContextKey{}, "seedance_video")
	data, contentType, err := runtime.requestHTTP(ctx, a, http.MethodGet, "/videos/task-seed/content", nil)
	require.NoError(t, err)
	require.Equal(t, "video/mp4", contentType)
	require.Equal(t, "video-bytes", string(data))
}

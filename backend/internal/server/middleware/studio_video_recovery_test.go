package middleware

import (
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVideoRecoveryAuthorizationBoundary(t *testing.T) {
	token := strings.Repeat("t", 32)
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", token)
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{"GET", "/v1/studio/videos/tasks/av_one", true},
		{"GET", "/v1/studio/videos/tasks/av_one/result", true},
		{"POST", "/v1/studio/videos/tasks/av_one/capture", true},
		{"POST", "/v1/studio/videos/tasks/av_one/release", true},
		{"GET", "/v1/studio/videos/tasks/av_one/capture", false},
		{"POST", "/v1/studio/videos/tasks", false},
		{"POST", "/v1/studio/videos/quotes", false},
		{"GET", "/v1/studio/videos/tasks/legacy_one", false},
		{"GET", "/v1/studio/videos/tasks/av_one?account=2", false},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		require.False(t, isStudioVideoRecovery(r))
		r.Header.Set("X-Studio-Service-Token", token)
		require.Equal(t, tc.want, isStudioVideoRecovery(r), tc.path)
	}
}

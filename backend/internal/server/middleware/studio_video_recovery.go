package middleware

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"os"
	"regexp"
	"strings"
)

func StudioVideoServiceAuthorized(r *http.Request) bool {
	token := os.Getenv("STUDIO_BRIDGE_SERVICE_TOKEN")
	if len(token) < 32 || r == nil {
		return false
	}
	want, got := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(r.Header.Get("X-Studio-Service-Token")))
	return subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

var videoRecoveryPath = regexp.MustCompile(`^/v1/studio/videos/tasks/av_[A-Za-z0-9_-]{1,120}(?:/(result|capture|release))?$`)

func isStudioVideoRecovery(r *http.Request) bool {
	if !StudioVideoServiceAuthorized(r) || !videoRecoveryPath.MatchString(r.URL.Path) || r.URL.RawQuery != "" {
		return false
	}
	if r.Method == http.MethodGet {
		return !strings.HasSuffix(r.URL.Path, "/capture") && !strings.HasSuffix(r.URL.Path, "/release")
	}
	return r.Method == http.MethodPost && (strings.HasSuffix(r.URL.Path, "/capture") || strings.HasSuffix(r.URL.Path, "/release"))
}

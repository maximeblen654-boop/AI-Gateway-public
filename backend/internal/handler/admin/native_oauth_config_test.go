//go:build unit

package admin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func TestNativeOAuthConfigurationHTTP(t *testing.T) {
	for _, provider := range []string{"ANTIGRAVITY", "GEMINI_CLI"} {
		for _, state := range []string{"missing", "id_only", "secret_only", "configured"} {
			t.Run(provider+"/"+state, func(t *testing.T) {
				id, secret := "", ""
				if state == "configured" || state == "id_only" {
					id = "synthetic-native-client"
				}
				if state == "configured" || state == "secret_only" {
					secret = "synthetic-native-secret"
				}
				t.Setenv(provider+"_OAUTH_CLIENT_ID", id)
				t.Setenv(provider+"_OAUTH_CLIENT_SECRET", secret)
				router := gin.New()
				if provider == "ANTIGRAVITY" {
					svc := service.NewAntigravityOAuthService(nil)
					defer svc.Stop()
					router.POST("/auth-url", NewAntigravityOAuthHandler(svc).GenerateAuthURL)
				} else {
					svc := service.NewGeminiOAuthService(nil, nil, nil, nil, &config.Config{})
					defer svc.Stop()
					router.POST("/auth-url", NewGeminiOAuthHandler(svc).GenerateAuthURL)
				}
				req := httptest.NewRequest(http.MethodPost, "/auth-url", strings.NewReader(`{"oauth_type":"code_assist"}`))
				req.Header.Set("Content-Type", "application/json")
				res := httptest.NewRecorder()
				router.ServeHTTP(res, req)
				if state == "configured" {
					if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "synthetic-native-client") {
						t.Fatal("configured native authorization failed")
					}
				} else {
					field := "CLIENT_ID"
					if state == "id_only" {
						field = "CLIENT_SECRET"
					}
					if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), provider+"_OAUTH_"+field+"_MISSING") {
						t.Fatal("incomplete native config must return HTTP 400 with a precise reason")
					}
				}
				if strings.Contains(res.Body.String(), "synthetic-native-secret") {
					t.Fatal("response exposed the configured secret")
				}
			})
		}
	}
}

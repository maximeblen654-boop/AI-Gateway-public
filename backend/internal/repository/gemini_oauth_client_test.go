//go:build unit

package repository

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/geminicli"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Exercise the real repository client and existing Account refresh service against
// a loopback token endpoint; no provider credentials or provider traffic are used.
func TestGeminiNativeOAuthRuntimeConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, id, secret, reason string
	}{
		{"unset", "", "", "GEMINI_CLI_OAUTH_CLIENT_ID_MISSING"},
		{"id_only", "synthetic-cli-client", "", "GEMINI_CLI_OAUTH_CLIENT_SECRET_MISSING"},
		{"secret_only", "", "synthetic-cli-secret", "GEMINI_CLI_OAUTH_CLIENT_ID_MISSING"},
		{"configured", "synthetic-cli-client", "synthetic-cli-secret", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(geminicli.GeminiCLIOAuthClientIDEnv, tc.id)
			t.Setenv(geminicli.GeminiCLIOAuthClientSecretEnv, tc.secret)
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.ParseForm() != nil {
					t.Error("expected POST form")
				}
				if r.Form.Get("client_id") != tc.id || r.Form.Get("client_secret") != tc.secret {
					t.Error("native runtime pair must reach the token endpoint unchanged")
				}
				switch r.Form.Get("grant_type") {
				case "authorization_code":
					if r.Form.Get("code_verifier") != "synthetic-verifier" {
						t.Error("PKCE verifier missing")
					}
				case "refresh_token":
					if r.Form.Get("refresh_token") != "synthetic-refresh" {
						t.Error("refresh identity changed")
					}
				default:
					t.Error("unexpected grant")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"access_token":"synthetic-access","token_type":"Bearer","expires_in":3600}`))
			}))
			defer server.Close()
			cfg := &config.Config{}
			client := &geminiOAuthClient{cfg: cfg, tokenURL: server.URL}
			svc := service.NewGeminiOAuthService(nil, client, nil, nil, cfg)
			defer svc.Stop()
			for _, kind := range []string{"code_assist", "google_one"} {
				auth, err := svc.GenerateAuthURL(context.Background(), nil, "", "synthetic-project", kind, "")
				if tc.reason != "" {
					if infraerrors.Reason(err) != tc.reason || auth != nil {
						t.Fatal("authorization must fail closed with configuration reason")
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					u, err := url.Parse(auth.AuthURL)
					if err != nil || u.Query().Get("client_id") != tc.id || u.Query().Get("redirect_uri") != geminicli.GeminiCLIRedirectURI {
						t.Fatal("configured native authorization changed client or redirect")
					}
				}
				_, err = client.ExchangeCode(context.Background(), kind, "synthetic-code", "synthetic-verifier", geminicli.GeminiCLIRedirectURI, "")
				if (tc.reason == "" && err != nil) || (tc.reason != "" && infraerrors.Reason(err) != tc.reason) {
					t.Fatalf("exchange configuration result: %v", err)
				}
				_, err = svc.RefreshToken(context.Background(), kind, "synthetic-refresh", "")
				if (tc.reason == "" && err != nil) || (tc.reason != "" && infraerrors.Reason(err) != tc.reason) {
					t.Fatalf("refresh configuration result: %v", err)
				}
			}
			// Existing Accounts retain their OAuth type and project; no provider lookup.
			account := &service.Account{Platform: service.PlatformGemini, Type: service.AccountTypeOAuth, Credentials: map[string]any{
				"refresh_token": "synthetic-refresh", "oauth_type": "code_assist", "project_id": "synthetic-project", "tier_id": service.GeminiTierGCPStandard,
			}}
			info, err := svc.RefreshAccountToken(context.Background(), account)
			if (tc.reason == "" && err != nil) || (tc.reason != "" && infraerrors.Reason(err) != tc.reason) {
				t.Fatalf("existing Account configuration result: %v", err)
			}
			if tc.reason != "" {
				if calls.Load() != 0 {
					t.Fatal("incomplete config made a token request")
				}
			} else if calls.Load() != 5 || info.ProjectID != "synthetic-project" || info.OAuthType != "code_assist" {
				t.Fatal("configured exchange/refresh or Account identity changed")
			}
		})
	}
}

func TestGeminiCustomOAuthIndependentOfNativeConfiguration(t *testing.T) {
	t.Setenv(geminicli.GeminiCLIOAuthClientIDEnv, "")
	t.Setenv(geminicli.GeminiCLIOAuthClientSecretEnv, "")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.ParseForm() != nil || r.Form.Get("client_id") != "synthetic-custom-client" || r.Form.Get("client_secret") != "synthetic-custom-secret" {
			t.Error("custom OAuth configuration changed")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"synthetic-access","expires_in":3600}`))
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Gemini.OAuth.ClientID, cfg.Gemini.OAuth.ClientSecret = "synthetic-custom-client", "synthetic-custom-secret"
	client := &geminiOAuthClient{cfg: cfg, tokenURL: server.URL}
	svc := service.NewGeminiOAuthService(nil, client, nil, nil, cfg)
	defer svc.Stop()
	if !svc.GetOAuthConfig().AIStudioOAuthEnabled {
		t.Fatal("custom OAuth disabled by unrelated native config")
	}
	if _, err := svc.GenerateAuthURL(context.Background(), nil, "", "", "ai_studio", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ExchangeCode(context.Background(), "ai_studio", "synthetic-code", "synthetic-verifier", geminicli.AIStudioOAuthRedirectURI, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RefreshToken(context.Background(), "ai_studio", "synthetic-refresh", ""); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("custom OAuth exchange/refresh not exercised")
	}
}

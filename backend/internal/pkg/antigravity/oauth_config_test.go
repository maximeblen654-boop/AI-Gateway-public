//go:build unit

package antigravity

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestOAuthConfigIncompleteNeverSendsCredentials(t *testing.T) {
	for _, tc := range []struct{ name, id, secret string }{
		{"unset", "", ""},
		{"id_only", "synthetic-antigravity-client", ""},
		{"secret_only", "", "synthetic-antigravity-secret"},
		{"whitespace", "  ", "  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ANTIGRAVITY_OAUTH_CLIENT_ID", tc.id)
			t.Setenv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", tc.secret)
			if authURL, err := BuildAuthorizationURL("state", "challenge"); err == nil || authURL != "" {
				t.Error("authorization must reject incomplete runtime config")
			}
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"access_token":"synthetic-access","expires_in":3600}`))
			}))
			defer server.Close()
			client := newTestClientWithRedirect(map[string]string{TokenURL: server.URL})
			if _, err := client.ExchangeCode(context.Background(), "synthetic-code", "synthetic-verifier"); err == nil {
				t.Error("authorization exchange must reject incomplete runtime config")
			}
			if _, err := client.RefreshToken(context.Background(), "synthetic-refresh"); err == nil {
				t.Error("refresh must reject incomplete runtime config")
			}
			if requests.Load() != 0 {
				t.Error("incomplete runtime config reached token endpoint")
			}
		})
	}
}

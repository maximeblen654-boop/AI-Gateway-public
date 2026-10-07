//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

func TestAntigravityOAuthMissingRuntimeConfiguration(t *testing.T) {
	for _, tc := range []struct{ name, id, secret, reason string }{
		{"unset", "", "", "ANTIGRAVITY_OAUTH_CLIENT_ID_MISSING"},
		{"id_only", "synthetic-client", "", "ANTIGRAVITY_OAUTH_CLIENT_SECRET_MISSING"},
		{"secret_only", "", "synthetic-secret", "ANTIGRAVITY_OAUTH_CLIENT_ID_MISSING"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(antigravity.AntigravityOAuthClientIDEnv, tc.id)
			t.Setenv(antigravity.AntigravityOAuthClientSecretEnv, tc.secret)
			svc := NewAntigravityOAuthService(nil)
			defer svc.sessionStore.Stop()
			if auth, err := svc.GenerateAuthURL(context.Background(), nil); auth != nil || infraerrors.Reason(err) != tc.reason {
				t.Fatal("native authorization must return the configuration reason")
			}
			account := &Account{Platform: PlatformAntigravity, Type: AccountTypeOAuth, Credentials: map[string]any{
				"refresh_token": "synthetic-refresh", "project_id": "synthetic-project",
			}}
			info, err := svc.RefreshAccountToken(context.Background(), account)
			if info != nil || infraerrors.Reason(err) != tc.reason || !isNonRetryableAntigravityOAuthError(err) {
				t.Fatal("existing Account must fail before network and without retrying missing config")
			}
			if account.GetCredential("refresh_token") != "synthetic-refresh" || account.GetCredential("project_id") != "synthetic-project" {
				t.Fatal("missing config must not rewrite existing Account credentials")
			}
		})
	}
}

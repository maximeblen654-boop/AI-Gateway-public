package geminicli

import "testing"

func TestOAuthConfigIncompleteRejectsNativeAuthorization(t *testing.T) {
	for _, tc := range []struct{ name, id, secret string }{
		{"unset", "", ""},
		{"id_only", "synthetic-gemini-cli-client", ""},
		{"secret_only", "", "synthetic-gemini-cli-secret"},
		{"whitespace", "  ", "  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GEMINI_CLI_OAUTH_CLIENT_ID", tc.id)
			t.Setenv("GEMINI_CLI_OAUTH_CLIENT_SECRET", tc.secret)
			for _, kind := range []string{"code_assist", "google_one"} {
				if _, err := BuildAuthorizationURL(OAuthConfig{}, "state", "challenge", GeminiCLIRedirectURI, "", kind); err == nil {
					t.Errorf("%s authorization must reject incomplete runtime config", kind)
				}
			}
			custom := OAuthConfig{ClientID: "synthetic-custom-client", ClientSecret: "synthetic-custom-secret"}
			if _, err := BuildAuthorizationURL(custom, "state", "challenge", AIStudioOAuthRedirectURI, "", "ai_studio"); err != nil {
				t.Fatalf("custom OAuth must remain independent: %v", err)
			}
		})
	}
}

package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPaidSidecarTrustBoundary(t *testing.T) {
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", strings.Repeat("s", 32))
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		t.Error("redirect target must not receive service token")
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/studio/paid-control" || r.Header.Get("X-Studio-Service-Token") != strings.Repeat("s", 32) {
			t.Error("wrong service request")
		}
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	if _, err := paidSidecarStatus(context.Background(), server.URL); err == nil {
		t.Fatal("redirect accepted")
	}
	if hits != 0 {
		t.Fatal("secret forwarded")
	}
	for _, raw := range []string{"https://127.0.0.1:1", "http://example.invalid:1", "http://localhost:1", "http://user:password@127.0.0.1:1", "http://127.0.0.1:1?q=x"} {
		if _, err := paidSidecarStatus(context.Background(), raw); err == nil {
			t.Fatal("unsafe endpoint accepted", raw)
		}
	}
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"managed-v1","ready":true}`))
	}))
	defer good.Close()
	if _, err := paidSidecarStatus(context.Background(), good.URL); err != nil {
		t.Fatal(err)
	}
}

package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
)

// Exercise real service and HTTP encoding; the DB/CAS contract has repository tests.
type mediaHandlerRepo struct{ a mediaworkbench.Account }

func (r *mediaHandlerRepo) Get(_ context.Context, id int64) (*mediaworkbench.Account, error) {
	if id != r.a.ID {
		return nil, mediaworkbench.ErrNotFound
	}
	b, _ := json.Marshal(r.a)
	var a mediaworkbench.Account
	_ = json.Unmarshal(b, &a)
	return &a, nil
}
func (r *mediaHandlerRepo) List(context.Context) ([]mediaworkbench.Account, error) {
	return []mediaworkbench.Account{r.a}, nil
}
func (r *mediaHandlerRepo) CompareAndSwap(_ context.Context, id, expected int64, c *mediaworkbench.Config) error {
	v := int64(0)
	if r.a.Config != nil {
		v = r.a.Config.RecordVersion
	}
	if expected != v {
		return mediaworkbench.ErrStale
	}
	r.a.Config = c
	return nil
}
func (r *mediaHandlerRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps mediaworkbench.Dependencies, c *mediaworkbench.Config) error {
	if mediaworkbench.DependenciesFor(&r.a) != deps {
		return mediaworkbench.ErrStale
	}
	return r.CompareAndSwap(ctx, id, expected, c)
}
func TestMediaWorkbenchHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Status: "active", Schedulable: true}}
	h := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	r := gin.New()
	r.GET("/suppliers", h.Suppliers)
	r.GET("/accounts/:id", h.Detail)
	r.POST("/accounts/:id/initialize", h.Initialize)
	r.PUT("/accounts/:id/draft", h.SaveDraft)
	r.PUT("/accounts/:id/sales", h.SetSales)
	r.POST("/accounts/:id/publish", h.Publish)
	cases := []struct {
		method, path, body string
		status             int
		reason             string
	}{
		{"GET", "/accounts/0", "", 400, "INVALID_MEDIA_CONFIG"},
		{"GET", "/accounts/99", "", 404, "MEDIA_ACCOUNT_NOT_FOUND"},
		{"POST", "/accounts/7/initialize", `{"media_types":["image"]}`, 200, "MODEL_SYNC_REQUIRED"},
		{"PUT", "/accounts/7/draft", `{"expected_record_version":1,"draft":{"products":[{"product_id":"p","media_type":"image","upstream_model":"m"}]}}`, 200, "mwd_"},
		{"PUT", "/accounts/7/draft", `{"expected_record_version":1,"draft":{}}`, 409, "STALE_MEDIA_CONFIG"},
		{"PUT", "/accounts/7/draft", `{"expected_record_version":2,"draft":{"products":[]},"published":{"revision":"forged"}}`, 400, "INVALID_MEDIA_CONFIG"},
		{"PUT", "/accounts/7/draft", `{"expected_record_version":2,"draft":{"products":[{"api_key":"secret-do-not-echo"}]}}`, 400, "INVALID_MEDIA_CONFIG"},
		{"PUT", "/accounts/7/draft", `{"draft":{}}`, 400, "INVALID_MEDIA_CONFIG"},
		{"PUT", "/accounts/7/sales", `{"expected_record_version":2}`, 400, "INVALID_MEDIA_CONFIG"},
		{"PUT", "/accounts/7/sales", `{"expected_record_version":3,"enabled":false}`, 200, "record_version"},
		{"PUT", "/accounts/7/sales", `{"expected_record_version":4,"enabled":true}`, 422, "MEDIA_SALES_NOT_READY"},
		{"PUT", "/accounts/7/sales", `{"expected_record_version":3,"enabled":false} {}`, 400, "INVALID_MEDIA_CONFIG"},
		{"GET", "/suppliers", "", 200, "media_workbench_v1"},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.reason) || strings.Contains(w.Body.String(), "secret-do-not-echo") {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
	if repo.a.Config.RecordVersion != 4 || len(repo.a.Config.Draft.Products) != 1 {
		t.Fatal("rejected input or sales lost draft")
	}
	oversized := `{"media_types":["` + strings.Repeat("x", 1<<20) + `"]}`
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/accounts/7/initialize", strings.NewReader(oversized)))
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestMediaPublishHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Platform: "openai", Status: "active", Schedulable: true, RuntimeReady: true, Catalog: &mediaworkbench.Catalog{Models: []string{"gpt-image-2"}, SyncedAt: "2026-10-05T00:00:00Z"}}}
	svc := mediaworkbench.NewService(repo)
	h := NewMediaWorkbenchHandler(svc)
	r := gin.New()
	r.POST("/accounts/:id/publish", h.Publish)
	d, err := svc.Initialize(context.Background(), 7, []string{"image"})
	if err != nil {
		t.Fatal(err)
	}
	p := mediaworkbench.Product{ProductID: "p", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Count: mediaworkbench.Range{Min: 1, Max: 1}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "1.00", Currency: "USD", BillingMode: "per_request"}}}}
	d, err = svc.SaveDraft(context.Background(), 7, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"expected_record_version": d.Config.RecordVersion, "expected_draft_revision": d.Config.Draft.Revision})
	call := func(body string, status int, reason string) {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", "/accounts/7/publish", strings.NewReader(body)))
		if w.Code != status || !strings.Contains(w.Body.String(), reason) {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	call(`{"expected_record_version":3}`, 400, "INVALID_MEDIA_CONFIG")
	call(`{"expected_record_version":3,"expected_draft_revision":"stale"}`, 409, "STALE_MEDIA_CONFIG")
	call(string(body), 200, "mw_offer_")
	call(string(body), 409, "STALE_MEDIA_CONFIG") // repeated click cannot publish again
	p.PricingRules = nil
	d, err = svc.SaveDraft(context.Background(), 7, repo.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	if err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(map[string]any{"expected_record_version": d.Config.RecordVersion, "expected_draft_revision": d.Config.Draft.Revision})
	call(string(body), 422, "MISSING_PRICE") // structured latest editor DTO in data
	call(`{"expected_record_version":7,"expected_draft_revision":"r","api_key":"secret"}`, 400, "INVALID_MEDIA_CONFIG")
}

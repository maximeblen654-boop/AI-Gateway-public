package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

func TestMediaDraftSubmissionReceiptHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Status: "active", Schedulable: true}}
	h := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	router := gin.New()
	router.PUT("/accounts/:id/draft", h.SaveDraft)
	router.GET("/accounts/:id", h.Detail)
	const submission = "550e8400-e29b-41d4-a716-446655440000"
	body := `{"expected_record_version":0,"submission_id":"` + submission + `","draft":{"products":[{"product_id":"p","media_type":"image","upstream_model":"m"}]}}`
	call := func(method, requestBody string, expectedStatus int) *httptest.ResponseRecorder {
		t.Helper()
		path := "/accounts/7"
		if method == http.MethodPut {
			path += "/draft"
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(requestBody)))
		if w.Code != expectedStatus {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body.String())
		}
		return w
	}
	for _, method := range []string{http.MethodPut, http.MethodGet} {
		w := call(method, body, http.StatusOK)
		var envelope struct {
			Data mediaworkbench.Detail `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		c := envelope.Data.Config
		if c == nil || c.Draft.SaveReceipt == nil || *c.Draft.SaveReceipt != (mediaworkbench.SaveReceipt{SubmissionID: submission, BaseRecordVersion: 0, DraftRevision: c.Draft.Revision}) || c.Validation.Status != "FAIL" {
			t.Fatalf("PUT/GET did not return its saved incomplete draft receipt: %s", w.Body.String())
		}
	}
	before, _ := json.Marshal(repo.a.Config)
	w := call(http.MethodPut, body, http.StatusConflict)
	after, _ := json.Marshal(repo.a.Config)
	if !strings.Contains(w.Body.String(), "STALE_MEDIA_CONFIG") || !bytes.Equal(before, after) {
		t.Fatal("repeated old CAS changed the record or did not return a conflict")
	}
	for _, rejected := range []string{
		`{"expected_record_version":2,"submission_id":"not-a-uuid","draft":{}}`,
		`{"expected_record_version":2,"submission_id":"550e8400e29b41d4a716446655440000","draft":{}}`,
		`{"expected_record_version":2,"draft":{"submission_id":"` + submission + `"}}`,
		`{"expected_record_version":2,"draft":{"save_receipt":{"submission_id":"` + submission + `"}}}`,
	} {
		w = call(http.MethodPut, rejected, http.StatusBadRequest)
		after, _ = json.Marshal(repo.a.Config)
		if !strings.Contains(w.Body.String(), "INVALID_MEDIA_CONFIG") || !bytes.Equal(before, after) {
			t.Fatal("invalid submission or forged receipt was persisted")
		}
	}
}

type mediaHandlerReplacedDraftRepo struct{ *mediaHandlerRepo }

func (r *mediaHandlerReplacedDraftRepo) CompareAndSwap(ctx context.Context, id, expected int64, c *mediaworkbench.Config) error {
	if err := r.mediaHandlerRepo.CompareAndSwap(ctx, id, expected, c); err != nil {
		return err
	}
	current, err := r.Get(ctx, id)
	if err != nil {
		return err
	}
	version := current.Config.RecordVersion
	current.Config.RecordVersion++
	current.Config.Draft.SaveReceipt.SubmissionID = "550e8400-e29b-41d4-a716-446655440001"
	return r.mediaHandlerRepo.CompareAndSwap(ctx, id, version, current.Config)
}

func TestMediaDraftReplacedReceiptReturnsHTTPConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerReplacedDraftRepo{mediaHandlerRepo: &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Status: "active", Schedulable: true}}}
	h := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	router := gin.New()
	router.PUT("/accounts/:id/draft", h.SaveDraft)
	body := `{"expected_record_version":0,"submission_id":"550e8400-e29b-41d4-a716-446655440000","draft":{"products":[{"product_id":"p","media_type":"image","upstream_model":"m"}]}}`
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/accounts/7/draft", strings.NewReader(body)))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "STALE_MEDIA_CONFIG") || !strings.Contains(w.Body.String(), `"save_stage":"confirmation"`) || strings.Contains(w.Body.String(), `"products"`) {
		t.Fatalf("replacement was returned as success or leaked draft contents: %d %s", w.Code, w.Body.String())
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
	p := mediaworkbench.Product{CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, ProductID: "p", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Count: mediaworkbench.Range{Min: 1, Max: 1}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "1.00", Currency: "CNY", BillingMode: "per_request"}}}}
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

func TestBlankDraftRemovalHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 77, Type: "apikey", Platform: "openai", Status: "active", Schedulable: true}}
			svc := mediaworkbench.NewService(repo)
			h := NewMediaWorkbenchHandler(svc)
			router := gin.New()
			router.PUT("/accounts/:id/draft", h.SaveDraft)
			router.GET("/accounts/:id", h.Detail)
			configured := mediaworkbench.Product{ProductID: "configured", MediaType: kind, UpstreamModel: "same-model", Enabled: true, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"1K"}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.70", Currency: "CNY", BillingMode: "per_request"}}}}
			products := []mediaworkbench.Product{configured}
			for i := 1; i <= 6; i++ {
				products = append(products, mediaworkbench.Product{ProductID: fmt.Sprintf("blank-%d", i), MediaType: kind, UpstreamModel: "same-model"})
			}
			d, err := svc.SaveDraft(context.Background(), 77, 0, mediaworkbench.DraftInput{Products: products})
			if err != nil {
				t.Fatal(err)
			}
			repo.a.Config.Published = &mediaworkbench.Published{Revision: "frozen", Products: []mediaworkbench.Product{configured}}
			published, _ := json.Marshal(repo.a.Config.Published)
			call := func(method, path string, body any, want int) string {
				t.Helper()
				encoded, _ := json.Marshal(body)
				w := httptest.NewRecorder()
				req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
				req.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(w, req)
				if w.Code != want {
					t.Fatalf("%s: %d %s", method, w.Code, w.Body.String())
				}
				return w.Body.String()
			}
			read := call("GET", "/accounts/77", nil, 200)
			if !strings.Contains(read, `"product_removal"`) || !strings.Contains(read, `"allowed":true`) {
				t.Fatal("removal eligibility missing")
			}
			remaining := append(append([]mediaworkbench.Product{}, products[:3]...), products[4:]...)
			body := map[string]any{"expected_record_version": d.Config.RecordVersion, "draft": mediaworkbench.DraftInput{Products: remaining}}
			call("PUT", "/accounts/77/draft", body, 422)
			body["draft"] = mediaworkbench.DraftInput{Products: remaining, RemoveProductIDs: []string{"blank-3"}}
			call("PUT", "/accounts/77/draft", body, 200)
			call("PUT", "/accounts/77/draft", body, 409)
			if len(repo.a.Config.Draft.Products) != 6 || len(repo.a.Config.RemovedDraftProducts) != 1 || repo.a.Config.RemovedDraftProducts[0].ProductID != "blank-3" {
				t.Fatal("wrong persistence result")
			}
			after, _ := json.Marshal(repo.a.Config.Published)
			if !bytes.Equal(published, after) {
				t.Fatal("HTTP draft save changed Published")
			}
			body["expected_record_version"] = repo.a.Config.RecordVersion
			body["draft"] = mediaworkbench.DraftInput{Products: remaining[1:], RemoveProductIDs: []string{"configured"}}
			call("PUT", "/accounts/77/draft", body, 422)
			body["draft"] = map[string]any{"products": remaining, "removed_draft_products": []any{}}
			call("PUT", "/accounts/77/draft", body, 400)
		})
	}
}

func TestMediaLifecycleHTTPUsesExplicitCASAndPreservesDraft(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Status: "active", Schedulable: true, Catalog: &mediaworkbench.Catalog{Models: []string{"gpt-image-2"}, SyncedAt: "2026-10-16T00:00:00Z"}}}
	h := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	r := gin.New()
	r.POST("/accounts/:id/lifecycle", h.Lifecycle)
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"action":"hide","model_id":"gpt-image-2"}`, 400},
		{`{"expected_version":0,"action":"hide","model_id":"gpt-image-2","product_id":"p"}`, 400},
		{`{"expected_version":0,"action":"hide","model_id":"gpt-image-2","sales":{"enabled":true}}`, 400},
		{`{"expected_version":0,"action":"hide","model_id":"gpt-image-2"}`, 200},
		{`{"expected_version":0,"action":"restore","model_id":"gpt-image-2"}`, 409},
		{`{"expected_version":1,"action":"restore","model_id":"gpt-image-2"}`, 200},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", "/accounts/7/lifecycle", strings.NewReader(tc.body)))
		if w.Code != tc.status {
			t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body.String())
		}
	}
	if repo.a.Config.Published != nil || repo.a.Config.Sales.Enabled || len(repo.a.Config.Draft.Products) != 0 || len(repo.a.Config.HiddenModels) != 0 {
		t.Fatal("lifecycle changed publication/sales/draft")
	}
}

func TestMediaSelectedPublishHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Type: "apikey", Platform: "openai", Status: "active", Schedulable: true, RuntimeReady: true, Catalog: &mediaworkbench.Catalog{Models: []string{"gpt-image-2"}, SyncedAt: "2026-10-05T00:00:00Z"}}}
	svc := mediaworkbench.NewService(repo)
	r := gin.New()
	r.POST("/accounts/:id/publish", NewMediaWorkbenchHandler(svc).Publish)
	d, err := svc.Initialize(context.Background(), 7, []string{"image"})
	if err != nil {
		t.Fatal(err)
	}
	p := mediaworkbench.Product{CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, ProductID: "ready", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Count: mediaworkbench.Range{Min: 1, Max: 1}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "1.00", Currency: "CNY", BillingMode: "per_request"}}}}
	half := p
	half.ProductID = "incomplete"
	half.PricingRules = nil
	d, err = svc.SaveDraft(context.Background(), 7, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p, half}})
	if err != nil {
		t.Fatal(err)
	}
	if d.Config.Validation.PublishReady {
		t.Fatal("incomplete draft must not pass")
	}
	call := func(ids []string, status int, reason string) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"expected_record_version": repo.a.Config.RecordVersion, "expected_draft_revision": repo.a.Config.Draft.Revision, "product_ids": ids})
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", "/accounts/7/publish", strings.NewReader(string(body))))
		if w.Code != status || !strings.Contains(w.Body.String(), reason) {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	call([]string{}, 400, "INVALID_MEDIA_CONFIG")
	call([]string{"ready"}, 200, "publish_validation")
	if len(repo.a.Config.Published.Products) != 1 || repo.a.Config.Published.Products[0].ProductID != "ready" || repo.a.Config.Validation.PublishReady {
		t.Fatal("selective publication changed unrelated draft validation")
	}
	version := repo.a.Config.RecordVersion
	call([]string{"incomplete"}, 422, "MISSING_PRICE")
	if repo.a.Config.RecordVersion != version {
		t.Fatal("failed selected publication wrote state")
	}
}

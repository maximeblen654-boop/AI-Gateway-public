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
	"github.com/stretchr/testify/require"
)

type modelBindingHandlerRepo struct{ mediaHandlerRepo }

func (r *modelBindingHandlerRepo) Get(ctx context.Context, id int64) (*mediaworkbench.Account, error) {
	a, err := r.mediaHandlerRepo.Get(ctx, id)
	if err == nil {
		a.BaseURL, a.ModelMapping, a.EndpointCapabilities = r.a.BaseURL, r.a.ModelMapping, r.a.EndpointCapabilities
	}
	return a, err
}

func modelBindingHTTPFixture(t *testing.T, publish bool, productChange func(*mediaworkbench.Product)) (*mediaworkbench.Service, *modelBindingHandlerRepo, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := &modelBindingHandlerRepo{mediaHandlerRepo: mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Name: "fixture", Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true, BaseURL: "https://supplier.example/v1", Catalog: &mediaworkbench.Catalog{Source: "upstream", SyncedAt: "2026-10-26T00:00:00Z", AccountIdentitySHA256: "fixture-catalog-owner", Models: []string{"gpt-image-2", "gpt-image-new"}}}}}
	svc := mediaworkbench.NewService(repo)
	p := mediaworkbench.Product{ProductID: "p", SiteModel: "customer-alias", UpstreamModel: "gpt-image-2", DisplayName: "fixture image", Enabled: true, MediaType: "image", Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"1K"}, AspectRatios: []string{"1:1"}, Count: mediaworkbench.Range{Min: 1, Max: 1}}, AdapterConfig: mediaworkbench.ImageConfig{SizeMappings: []mediaworkbench.SizeMapping{{Resolution: "1K", AspectRatio: "1:1", WireSize: "1024x1024"}}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "1.25", Currency: "CNY", BillingMode: "per_request"}}}}
	if productChange != nil {
		productChange(&p)
	}
	d, err := svc.SaveDraft(t.Context(), 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, err)
	if publish {
		d, err = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
		require.NoError(t, err)
		_, err = svc.Lifecycle(t.Context(), 7, d.Config.RecordVersion, mediaworkbench.LifecycleInput{Action: "unlist", ProductID: "p"})
		require.NoError(t, err)
	}
	repo.a.Catalog.Models = []string{"gpt-image-new"}
	h := NewMediaWorkbenchHandler(svc)
	r := gin.New()
	r.POST("/accounts/:id/model-binding", h.ModelBinding)
	r.POST("/accounts/:id/lifecycle", h.Lifecycle)
	return svc, repo, r
}

func bindingHTTPBody(r *modelBindingHandlerRepo) map[string]any {
	return map[string]any{"expected_record_version": r.a.Config.RecordVersion, "expected_draft_revision": r.a.Config.Draft.Revision, "old_model_id": "gpt-image-2", "new_model_id": "gpt-image-new", "action": "rebind", "product_ids": []string{"p"}}
}

func bindingHTTPRequest(t *testing.T, router *gin.Engine, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	require.NoError(t, err)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
	return w
}

func TestMediaModelBindingHTTPPreservesPriceAndAllowsExplicitRelist(t *testing.T) {
	_, repo, router := modelBindingHTTPFixture(t, true, nil)
	repo.a.Config.Draft.Products[0].UpstreamModel = "earlier-third-model-choice"
	repo.a.Config.Draft.Products[0].PricingRules = []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "9.99", Currency: "CNY", BillingMode: "per_request"}}}
	w := bindingHTTPRequest(t, router, "/accounts/7/model-binding", bindingHTTPBody(repo))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var result struct {
		Data mediaworkbench.Detail `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.Equal(t, "gpt-image-new", result.Data.Config.Published.Products[0].UpstreamModel)
	require.Equal(t, "customer-alias", result.Data.Config.Published.Products[0].SiteModel)
	require.Equal(t, "1.25", result.Data.Config.Published.Products[0].PricingRules[0].SalePrice.Amount)
	require.Equal(t, "9.99", result.Data.Config.Draft.Products[0].PricingRules[0].SalePrice.Amount)
	require.Equal(t, "unlisted", result.Data.Config.ProductLifecycle["p"].State)
	w = bindingHTTPRequest(t, router, "/accounts/7/lifecycle", map[string]any{"expected_version": result.Data.Config.RecordVersion, "action": "relist", "product_id": "p"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "active", repo.a.Config.ProductLifecycle["p"].State)
}

func TestMediaModelBindingHTTPRejectsInvalidAndStalePayloads(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
		status int
	}{
		{"missing record", func(in map[string]any) { delete(in, "expected_record_version") }, 400},
		{"missing revision", func(in map[string]any) { delete(in, "expected_draft_revision") }, 400},
		{"missing new", func(in map[string]any) { delete(in, "new_model_id") }, 400},
		{"empty new", func(in map[string]any) { in["new_model_id"] = "" }, 400},
		{"new unavailable", func(in map[string]any) { in["new_model_id"] = "absent" }, 422},
		{"wrong selection", func(in map[string]any) { in["product_ids"] = []string{"other"} }, 422},
		{"stale record", func(in map[string]any) { in["expected_record_version"] = int64(1) }, 409},
		{"stale draft", func(in map[string]any) { in["expected_draft_revision"] = "outdated" }, 409},
		{"forged field", func(in map[string]any) { in["api_key"] = "secret-do-not-echo" }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, repo, router := modelBindingHTTPFixture(t, true, nil)
			before, err := json.Marshal(repo.a.Config)
			require.NoError(t, err)
			body := bindingHTTPBody(repo)
			tc.change(body)
			w := bindingHTTPRequest(t, router, "/accounts/7/model-binding", body)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			require.NotContains(t, w.Body.String(), "secret-do-not-echo")
			after, err := json.Marshal(repo.a.Config)
			require.NoError(t, err)
			require.Equal(t, string(before), string(after))
		})
	}
}

func TestMediaModelBindingHTTPFailureSeparatesPersistedAndCandidateConfig(t *testing.T) {
	_, repo, router := modelBindingHTTPFixture(t, false, func(p *mediaworkbench.Product) {
		p.AdapterConfig.Execution = &mediaworkbench.ImageExecutionConfig{Mode: "unimplemented_mode"}
	})
	w := bindingHTTPRequest(t, router, "/accounts/7/model-binding", bindingHTTPBody(repo))
	require.Equal(t, http.StatusUnprocessableEntity, w.Code, w.Body.String())
	var result struct {
		Data mediaworkbench.Detail `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
	require.NotNil(t, result.Data.PublishValidation)
	require.False(t, result.Data.PublishValidation.PublishReady)
	require.Equal(t, "gpt-image-2", result.Data.Config.Draft.Products[0].UpstreamModel)
	require.Equal(t, "gpt-image-2", repo.a.Config.Draft.Products[0].UpstreamModel)
	require.Len(t, result.Data.BindingValidationProducts, 1)
	require.Equal(t, "gpt-image-new", result.Data.BindingValidationProducts[0].UpstreamModel)
	require.Contains(t, w.Body.String(), "IMAGE_EXECUTION_CAPABILITY_INVALID")
}

func TestMediaModelBindingHTTPDeleteAndRelistReasons(t *testing.T) {
	_, repo, router := modelBindingHTTPFixture(t, true, nil)
	w := bindingHTTPRequest(t, router, "/accounts/7/lifecycle", map[string]any{"expected_version": repo.a.Config.RecordVersion, "action": "relist", "product_id": "p"})
	require.Equal(t, http.StatusUnprocessableEntity, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "UPSTREAM_REMOVED")
	require.Contains(t, w.Body.String(), "publish_validation")
	require.Contains(t, w.Body.String(), `"product_id":"p"`)
	repo.a.Config.Draft.Products[0].PricingRules = nil
	body := bindingHTTPBody(repo)
	body["action"], body["new_model_id"] = "delete", ""
	w = bindingHTTPRequest(t, router, "/accounts/7/model-binding", body)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Empty(t, repo.a.Config.Draft.Products)
	require.Nil(t, repo.a.Config.Published)
	require.NotContains(t, repo.a.Config.ProductLifecycle, "p")
	// The strict common decoder also rejects a second JSON value.
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/accounts/7/model-binding", strings.NewReader(`{} {}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

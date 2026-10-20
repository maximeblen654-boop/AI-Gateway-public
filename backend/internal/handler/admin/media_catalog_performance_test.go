package admin

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
)

// The optional local overlay supplies counters without shipping a global probe.
// Normal tests remain independent of instrumentation and wall-clock thresholds.
var catalogPerfProbe = func(reset bool) (int64, int64, int64) { return 0, 0, 0 }

type catalogPerformanceRepo struct {
	accounts []mediaworkbench.Account
	readTime time.Duration
	reads    int
}

func (r *catalogPerformanceRepo) Get(ctx context.Context, id int64) (*mediaworkbench.Account, error) {
	started := time.Now()
	defer func() { r.readTime += time.Since(started); r.reads++ }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for i := range r.accounts {
		if r.accounts[i].ID == id {
			body, err := json.Marshal(r.accounts[i])
			if err != nil {
				return nil, err
			}
			var a mediaworkbench.Account
			if err := json.Unmarshal(body, &a); err != nil {
				return nil, err
			}
			a.BaseURL, a.ModelMapping, a.EndpointCapabilities, a.RoutingFingerprint = r.accounts[i].BaseURL, r.accounts[i].ModelMapping, r.accounts[i].EndpointCapabilities, r.accounts[i].RoutingFingerprint
			return &a, nil
		}
	}
	return nil, mediaworkbench.ErrNotFound
}

func (r *catalogPerformanceRepo) List(ctx context.Context) ([]mediaworkbench.Account, error) {
	started := time.Now()
	defer func() { r.readTime += time.Since(started); r.reads++ }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Fresh, fully decoded rows model the repository snapshot boundary. This is
	// explicitly a fixture read, not evidence for PostgreSQL query performance.
	var out []mediaworkbench.Account
	body, err := json.Marshal(r.accounts)
	if err == nil {
		err = json.Unmarshal(body, &out)
	}
	for i := range out {
		out[i].BaseURL = r.accounts[i].BaseURL
		out[i].ModelMapping = r.accounts[i].ModelMapping
		out[i].RoutingFingerprint = r.accounts[i].RoutingFingerprint
		out[i].EndpointCapabilities = r.accounts[i].EndpointCapabilities
	}
	return out, err
}

func (r *catalogPerformanceRepo) CompareAndSwap(ctx context.Context, id, expected int64, c *mediaworkbench.Config) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	for i := range r.accounts {
		a := &r.accounts[i]
		if a.ID != id {
			continue
		}
		version := int64(0)
		if a.Config != nil {
			version = a.Config.RecordVersion
		}
		if version != expected {
			return mediaworkbench.ErrStale
		}
		a.Config = c
		return nil
	}
	return mediaworkbench.ErrNotFound
}

func (r *catalogPerformanceRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps mediaworkbench.Dependencies, c *mediaworkbench.Config) error {
	a, err := r.Get(ctx, id)
	if err != nil {
		return err
	}
	if mediaworkbench.DependenciesFor(a) != deps {
		return mediaworkbench.ErrStale
	}
	return r.CompareAndSwap(ctx, id, expected, c)
}

func catalogPerformanceFixture(t *testing.T) *catalogPerformanceRepo {
	t.Helper()
	repo := &catalogPerformanceRepo{}
	type snapshot struct {
		Account              mediaworkbench.Account
		BaseURL              string
		ModelMapping         map[string]string
		EndpointCapabilities []string
		RoutingFingerprint   string
	}
	fixturePath := ""
	if dir := os.Getenv("STUDIO_CATALOG_PERF_FIXTURE_DIR"); dir != "" {
		fixturePath = filepath.Join(dir, "backend-admin-fixture.json")
		if body, err := os.ReadFile(fixturePath); err == nil {
			var rows []snapshot
			if err := json.Unmarshal(body, &rows); err != nil {
				t.Fatal(err)
			}
			for _, row := range rows {
				a := row.Account
				a.BaseURL, a.ModelMapping, a.EndpointCapabilities, a.RoutingFingerprint = row.BaseURL, row.ModelMapping, row.EndpointCapabilities, row.RoutingFingerprint
				repo.accounts = append(repo.accounts, a)
			}
			return repo
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		id := int64(i + 7)
		a := mediaworkbench.Account{ID: id, Name: fmt.Sprintf("catalog-performance-%d", i), Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true, BaseURL: "https://supplier.example.invalid/v1", Catalog: &mediaworkbench.Catalog{SyncedAt: "fixture", Models: []string{"gpt-image-2", "configured-performance-video"}}}
		for j := 0; j < 3000; j++ {
			a.Catalog.Models = append(a.Catalog.Models, fmt.Sprintf("discovered-model-%04d", j))
		}
		repo.accounts = append(repo.accounts, a)
		svc := mediaworkbench.NewService(repo)
		detail, err := svc.Initialize(t.Context(), id, []string{"image", "video"})
		if err != nil {
			t.Fatal(err)
		}
		image := mediaworkbench.Product{ProductID: "image", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"4K"}, AspectRatios: []string{"1:1", "16:9", "4:5", "5:4", "21:9", "3:4", "4:3", "2:3", "3:2", "9:16", "9:21"}, Count: mediaworkbench.Range{Min: 1, Max: 10}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 16}, TotalMax: 16}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.025", Currency: "CNY", BillingMode: "per_request"}}}}
		video := mediaworkbench.Product{ProductID: "video", MediaType: "video", SiteModel: "configured-performance-video", UpstreamModel: "configured-performance-video", Enabled: true, AdapterConfig: mediaworkbench.ImageConfig{Version: 1, WireProfile: "inline_multimedia"}, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"9:16", "16:9", "1:1", "3:4", "4:3", "21:9"}, Count: mediaworkbench.Range{Min: 1, Max: 1}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 10}, Video: mediaworkbench.Range{Max: 5}, Audio: mediaworkbench.Range{Max: 5}, TotalMax: 20}}}
		for j := 0; j < 12; j++ {
			duration := j + 4
			video.Capabilities.DurationsSeconds = append(video.Capabilities.DurationsSeconds, duration)
			video.PricingRules = append(video.PricingRules, mediaworkbench.PricingRule{Match: mediaworkbench.Match{DurationSeconds: []int{duration}}, SalePrice: &mediaworkbench.Price{Amount: strconv.Itoa(duration), Currency: "CNY", BillingMode: "per_request"}})
		}
		detail, err = svc.SaveDraft(t.Context(), id, detail.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{image, video}})
		if err != nil || !detail.Config.Validation.PublishReady || detail.Config.Validation.CaseCount != 30382 {
			t.Fatalf("fixture validation: err=%v validation=%+v", err, detail.Config.Validation)
		}
		detail, err = svc.Publish(t.Context(), id, detail.Config.RecordVersion, detail.Config.Draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		detail, err = svc.SetSales(t.Context(), id, detail.Config.RecordVersion, true)
		if err != nil || len(detail.Config.Published.Offers) != 13 {
			t.Fatalf("fixture publish/sales: %v", err)
		}
		for j := 0; j < 100; j++ {
			detail.Config.Draft.Products = append(detail.Config.Draft.Products, mediaworkbench.Product{ProductID: fmt.Sprintf("unpublished-%03d", j), MediaType: "video", UpstreamModel: fmt.Sprintf("discovered-model-%04d", j), DisplayName: "large unsaved-independent draft", PricingRules: make([]mediaworkbench.PricingRule, 20)})
		}
	}
	if fixturePath != "" {
		var rows []snapshot
		for _, a := range repo.accounts {
			rows = append(rows, snapshot{a, a.BaseURL, a.ModelMapping, a.EndpointCapabilities, a.RoutingFingerprint})
		}
		body, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixturePath, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return repo
}

func TestMediaCatalogHTTPPerformance(t *testing.T) {
	runMediaCatalogHTTPPerformance(t, "suppliers", "/suppliers")
}

func TestMediaDetailHTTPPerformance(t *testing.T) {
	runMediaCatalogHTTPPerformance(t, "detail", "/accounts/7")
}

func runMediaCatalogHTTPPerformance(t *testing.T, endpoint, path string) {
	if os.Getenv("STUDIO_CATALOG_PERF") != "1" {
		t.Skip("opt-in real Service + admin HTTP performance fixture")
	}
	runs := 5
	if value := os.Getenv("STUDIO_CATALOG_PERF_RUNS"); value != "" {
		var err error
		runs, err = strconv.Atoi(value)
		if err != nil || runs < 1 || runs > 20 {
			t.Fatal("STUDIO_CATALOG_PERF_RUNS must be 1..20")
		}
	}
	gin.SetMode(gin.TestMode)
	repo := catalogPerformanceFixture(t)
	handler := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	router := gin.New()
	router.GET("/suppliers", handler.Suppliers)
	router.GET("/accounts/:id", handler.Detail)
	var elapsed []float64
	var stableBody []byte
	for i := 0; i < runs; i++ {
		repo.readTime, repo.reads = 0, 0
		catalogPerfProbe(true)
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request = request.WithContext(mediaworkbench.WithPublishedValidationMemo(request.Context()))
		response := httptest.NewRecorder()
		started := time.Now()
		router.ServeHTTP(response, request)
		wallMS := float64(time.Since(started).Microseconds()) / 1000
		if response.Code != http.StatusOK {
			t.Fatalf("catalog HTTP: %d %s", response.Code, response.Body.String())
		}
		if i == 0 {
			stableBody = append([]byte(nil), response.Body.Bytes()...)
		} else if string(stableBody) != response.Body.String() {
			t.Fatal("same snapshot changed HTTP response")
		}
		products, validations, validationNS := catalogPerfProbe(false)
		elapsed = append(elapsed, wallMS)
		encoded, _ := json.Marshal(map[string]any{"endpoint": endpoint, "fixture": "3accounts-3002models-1870image-28512video-13offers-102drafts", "iteration": i, "http_total_ms": wallMS, "fixture_read_decode_ms": float64(repo.readTime.Microseconds()) / 1000, "repository_reads": repo.reads, "product_validation_calls": products, "full_validation_calls": validations, "product_validation_ms": float64(validationNS) / 1e6, "response_bytes": response.Body.Len(), "response_sha256": fmt.Sprintf("%x", sha256.Sum256(response.Body.Bytes())), "sql": "SKIP_PostgreSQL_unavailable"})
		t.Log(string(encoded))
	}
	if dir := os.Getenv("STUDIO_CATALOG_PERF_FIXTURE_DIR"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, "backend-admin-"+endpoint+"-response.json"), stableBody, 0600); err != nil {
			t.Fatal(err)
		}
	}
	sort.Float64s(elapsed)
	t.Logf("CATALOG_HTTP_P50_P95 endpoint=%s n=%d p50_ms=%.3f p95_ms=%.3f bytes=%d", endpoint, runs, elapsed[(runs-1)/2], elapsed[(95*runs+99)/100-1], len(stableBody))
}

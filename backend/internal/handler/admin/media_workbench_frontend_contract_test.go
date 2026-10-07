//go:build media_contract

package admin

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

// This explicit build-tag fixture connects the real frontend Axios adapter to
// real handlers over stdio. Only persistence and upstream model discovery are
// replaced; validation/Publish cannot access a network or a supplier credential.
type mediaContractRepo struct {
	mediaHandlerRepo
	deleted        bool
	failValidation bool
}

type mediaContractCatalogRepo struct {
	service.AccountRepository
	media *mediaContractRepo
}

func (r *mediaContractRepo) Get(ctx context.Context, id int64) (*mediaworkbench.Account, error) {
	if r.deleted {
		return nil, mediaworkbench.ErrNotFound
	}
	a, err := r.mediaHandlerRepo.Get(ctx, id)
	if err == nil {
		a.BaseURL = r.a.BaseURL
	}
	return a, err
}

func (r *mediaContractCatalogRepo) UpdateExtra(_ context.Context, _ int64, updates map[string]any) error {
	if snapshot, ok := updates[mediaworkbench.CatalogKey]; ok {
		body, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		return json.Unmarshal(body, &r.media.a.Catalog)
	}
	return nil
}

func (r *mediaContractRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps mediaworkbench.Dependencies, c *mediaworkbench.Config) error {
	if r.failValidation {
		r.failValidation = false
		return errors.New("local validation persistence unavailable")
	}
	return r.mediaHandlerRepo.CompareAndSwapChecked(ctx, id, expected, deps, c)
}

type mediaContractUpstream struct {
	t      *testing.T
	models []string
	calls  int
}

func (u *mediaContractUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	if req.Method != http.MethodGet || req.URL.Host != "contract.example.invalid" || req.URL.Path != "/v1/models" {
		u.t.Fatalf("unexpected supplier request: %s %s", req.Method, req.URL.Redacted())
	}
	u.calls++
	data := make([]map[string]string, 0, len(u.models))
	for _, model := range u.models {
		data = append(data, map[string]string{"id": model})
	}
	body, err := json.Marshal(map[string]any{"data": data})
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}

func (u *mediaContractUpstream) DoWithTLS(req *http.Request, proxy string, id int64, concurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxy, id, concurrency)
}

func TestMediaFrontendContractBridge(t *testing.T) {
	repo := &mediaContractRepo{mediaHandlerRepo: mediaHandlerRepo{a: mediaworkbench.Account{
		ID: 7, Name: "contract supplier", Type: "apikey", Platform: "openai", Status: "active",
		Schedulable: true, RuntimeReady: true, BaseURL: "https://contract.example.invalid/v1",
	}}}
	upstream := &mediaContractUpstream{t: t, models: []string{"gpt-image-2"}}
	adminSvc := &availableModelsAdminService{stubAdminService: newStubAdminService(), account: service.Account{
		ID: 7, Platform: "openai", Type: "apikey", Credentials: map[string]any{
			"api_key": "synthetic-fixture", "base_url": repo.a.BaseURL,
		},
	}}
	accountTest := service.NewAccountTestService(&mediaContractCatalogRepo{media: repo}, nil, nil, nil, nil, upstream,
		&config.Config{Security: config.SecurityConfig{URLAllowlist: config.URLAllowlistConfig{Enabled: false}}}, nil)
	accountHandler := NewAccountHandler(adminSvc, nil, nil, nil, nil, nil, nil, nil, accountTest, nil, nil, nil, nil, nil)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	media := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	router.POST("/api/v1/admin/accounts/:id/models/sync-upstream", accountHandler.SyncUpstreamModels)
	router.GET("/api/v1/admin/media-workbench/suppliers", media.Suppliers)
	router.GET("/api/v1/admin/media-workbench/accounts/:id", media.Detail)
	router.POST("/api/v1/admin/media-workbench/accounts/:id/initialize", media.Initialize)
	router.PUT("/api/v1/admin/media-workbench/accounts/:id/draft", media.SaveDraft)
	router.POST("/api/v1/admin/media-workbench/accounts/:id/publish", media.Publish)
	router.PUT("/api/v1/admin/media-workbench/accounts/:id/sales", media.SetSales)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var in struct {
			Method, Path, Body, Action, Status string
			Models                             []string
			Ready                              bool
		}
		if err := json.Unmarshal(scanner.Bytes(), &in); err != nil {
			t.Fatal(err)
		}
		switch in.Action {
		case "models":
			upstream.models = in.Models
		case "status":
			repo.a.Status = in.Status
		case "schedulable":
			repo.a.Schedulable = in.Ready
		case "runtime":
			repo.a.RuntimeReady = in.Ready
		case "deleted":
			repo.deleted = in.Ready
		case "unknown":
			repo.a.Catalog = nil
		case "validation_unavailable":
			repo.failValidation = true
		}
		if in.Action != "" {
			if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"status": 200, "data": map[string]any{"calls": upstream.calls}}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		w := httptest.NewRecorder()
		req := httptest.NewRequest(in.Method, in.Path, strings.NewReader(in.Body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(w, req)
		if _, err := fmt.Fprintf(os.Stdout, "{\"status\":%d,\"data\":%s}\n", w.Code, w.Body.String()); err != nil {
			t.Fatal(err)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}

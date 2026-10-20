package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// Filled by the optional local overlay; no global probe is shipped.
var videoCatalogPerfProbe = func(reset bool) (int64, int64, int64) { return 0, 0, 0 }

func TestStudioVideoCatalogPerformance(t *testing.T) {
	if os.Getenv("STUDIO_CATALOG_PERF") != "1" {
		t.Skip("opt-in real StudioVideoRuntime.Catalog performance fixture")
	}
	runs := 5
	if value := os.Getenv("STUDIO_CATALOG_PERF_RUNS"); value != "" {
		var err error
		runs, err = strconv.Atoi(value)
		if err != nil || runs < 1 || runs > 20 {
			t.Fatal("STUDIO_CATALOG_PERF_RUNS must be 1..20")
		}
	}
	p, repo, key, accounts := paidPerformanceFixture(t, true)
	fixturePath := ""
	if dir := os.Getenv("STUDIO_CATALOG_PERF_FIXTURE_DIR"); dir != "" {
		fixturePath = filepath.Join(dir, "backend-video-fixture.json")
		var snapshot struct {
			Account              mediaworkbench.Account
			BaseURL              string
			ModelMapping         map[string]string
			EndpointCapabilities []string
			RoutingFingerprint   string
		}
		if body, err := os.ReadFile(fixturePath); err == nil {
			if err := json.Unmarshal(body, &snapshot); err != nil {
				t.Fatal(err)
			}
			repo.a = snapshot.Account
			repo.a.BaseURL, repo.a.ModelMapping, repo.a.EndpointCapabilities, repo.a.RoutingFingerprint = snapshot.BaseURL, snapshot.ModelMapping, snapshot.EndpointCapabilities, snapshot.RoutingFingerprint
		} else if os.IsNotExist(err) {
			snapshot.Account, snapshot.BaseURL, snapshot.ModelMapping, snapshot.EndpointCapabilities, snapshot.RoutingFingerprint = repo.a, repo.a.BaseURL, repo.a.ModelMapping, repo.a.EndpointCapabilities, repo.a.RoutingFingerprint
			body, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(fixturePath, body, 0600); err != nil {
				t.Fatal(err)
			}
		} else {
			t.Fatal(err)
		}
	}
	owner := StudioImageOwner{UserID: 1, APIKeyID: 2, GroupID: 3}
	before, err := json.Marshal(repo.a.Config)
	if err != nil {
		t.Fatal(err)
	}
	var elapsed []float64
	var stableBody []byte
	for i := 0; i < runs; i++ {
		videoCatalogPerfProbe(true)
		reads := accounts.calls
		ctx := mediaworkbench.WithPublishedValidationMemo(context.Background())
		started := time.Now()
		offers, err := p.video.Catalog(ctx, owner, key)
		catalogMS := float64(time.Since(started).Microseconds()) / 1000
		if err != nil || len(offers) != len(repo.a.Config.Published.Offers) {
			t.Fatalf("catalog changed published offer count: %d err=%v", len(offers), err)
		}
		started = time.Now()
		body, err := json.Marshal(offers)
		encodeMS := float64(time.Since(started).Microseconds()) / 1000
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			stableBody = body
		} else if string(stableBody) != string(body) {
			t.Fatal("same snapshot changed video response")
		}
		products, validations, validationNS := videoCatalogPerfProbe(false)
		elapsed = append(elapsed, catalogMS)
		digest := sha256.Sum256(body)
		encoded, _ := json.Marshal(map[string]any{"fixture": "28512video-12offers", "iteration": i, "catalog_ms": catalogMS, "json_encode_ms": encodeMS, "native_account_reads": accounts.calls - reads, "product_validation_calls": products, "full_validation_calls": validations, "product_validation_ms": float64(validationNS) / 1e6, "response_bytes": len(body), "response_sha256": fmt.Sprintf("%x", digest), "sql": "SKIP_PostgreSQL_unavailable"})
		t.Log(string(encoded))
	}
	if dir := os.Getenv("STUDIO_CATALOG_PERF_FIXTURE_DIR"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, "backend-video-response.json"), stableBody, 0600); err != nil {
			t.Fatal(err)
		}
	}
	after, err := json.Marshal(repo.a.Config)
	if err != nil || string(before) != string(after) {
		t.Fatal("catalog changed draft, publication, or sales")
	}
	sort.Float64s(elapsed)
	t.Logf("VIDEO_CATALOG_P50_P95 n=%d p50_ms=%.3f p95_ms=%.3f bytes=%d", runs, elapsed[(runs-1)/2], elapsed[(95*runs+99)/100-1], len(stableBody))
}

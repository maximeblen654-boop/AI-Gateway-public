package service

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// This uses a declared, anonymous inline_multimedia product with the same
// geometry as the slow production report. It does not claim supplier support.
func paidPerformanceFixture(t *testing.T, complex bool) (*studioPaidPreflight, *studioMediaFixture, *APIKey, *studioAccountFixture) {
	t.Helper()
	p, repo, key := paidPreflightFixture(t)
	accounts, ok := p.image.Core.accountRepo.(*studioAccountFixture)
	if !ok {
		t.Fatal("unexpected native Account fixture")
	}
	for _, name := range []string{"quota_limit", "quota_daily_limit", "quota_weekly_limit"} {
		delete(accounts.a.Extra, name)
	}
	const model = "configured-performance-video"
	accounts.a.Credentials["model_mapping"] = map[string]any{model: model}
	repo.a.ModelMapping = map[string]string{model: model}
	repo.a.Catalog.Models = []string{model}
	repo.a.Config = nil
	svc := mediaworkbench.NewService(repo)
	ctx := context.Background()
	_, err := svc.Initialize(ctx, repo.a.ID, []string{"video"})
	if err != nil {
		t.Fatal(err)
	}
	product := mediaworkbench.Product{
		ProductID: "performance-video", MediaType: "video", SiteModel: model, UpstreamModel: model, Enabled: true,
		AdapterConfig: mediaworkbench.ImageConfig{Version: 1, WireProfile: "inline_multimedia"},
		Capabilities: mediaworkbench.Capabilities{
			Resolutions: []string{"720p"}, AspectRatios: []string{"16:9", "1:1"}, DurationsSeconds: []int{5, 10},
			Count:      mediaworkbench.Range{Min: 1, Max: 1},
			References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 1}, TotalMax: 1},
		},
	}
	if complex {
		product.Capabilities.AspectRatios = []string{"9:16", "16:9", "1:1", "3:4", "4:3", "21:9"}
		product.Capabilities.DurationsSeconds = make([]int, 12)
		for i := range product.Capabilities.DurationsSeconds {
			product.Capabilities.DurationsSeconds[i] = i + 4
		}
		product.Capabilities.References = mediaworkbench.References{
			Image: mediaworkbench.Range{Max: 10}, Video: mediaworkbench.Range{Max: 5},
			Audio: mediaworkbench.Range{Max: 5}, TotalMax: 20,
		}
	}
	for _, duration := range product.Capabilities.DurationsSeconds {
		product.PricingRules = append(product.PricingRules, mediaworkbench.PricingRule{
			Match:     mediaworkbench.Match{Resolution: []string{"720p"}, DurationSeconds: []int{duration}},
			SalePrice: &mediaworkbench.Price{Amount: "4", Currency: "CNY", BillingMode: "per_request"},
		})
	}
	detail, err := svc.SaveDraft(ctx, repo.a.ID, repo.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
	if err != nil || !detail.Config.Validation.PublishReady {
		t.Fatalf("performance product not publishable: detail=%+v err=%v", detail, err)
	}
	detail, err = svc.Publish(ctx, repo.a.ID, detail.Config.RecordVersion, detail.Config.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.SetSales(ctx, repo.a.ID, detail.Config.RecordVersion, true); err != nil {
		t.Fatal(err)
	}
	p.video = NewStudioVideoRuntime(p.image.Core, repo, &videoOrderFixture{orders: map[string]*StudioVideoOrder{}})
	p.video.Store = &StudioVideoStore{Root: t.TempDir()}
	p.video.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		t.Fatal("preflight called supplier")
		return nil, "", ErrPaidControl
	}
	return p, repo, key, accounts
}

func TestStudioPaidPerformanceCompleteCheckAndApply(t *testing.T) {
	runs := 1
	if value := os.Getenv("STUDIO_PAID_PERF_RUNS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 20 {
			t.Fatal("STUDIO_PAID_PERF_RUNS must be 1..20")
		}
		runs = parsed
	}
	for _, complex := range []bool{false, true} {
		name, specs := "ordinary", 8
		if complex {
			name, specs = "complex", 28512
		}
		t.Run(name, func(t *testing.T) {
			p, repo, _, accounts := paidPerformanceFixture(t, complex)
			gate := &StudioPaidControl{Managed: true, Settings: &paidSettingsFake{values: map[string]string{}}, Check: p.check}
			gate.Snapshot = func(ctx context.Context, media string, actor int64) (paidDependencies, error) {
				snapshot, err := p.snapshot(ctx, media, actor)
				return paidDependencies{Shared: snapshot.fingerprint, Offers: snapshot.grants}, err
			}
			var checkTimes, applyTimes []float64
			for i := 0; i < runs; i++ {
				ctx := context.Background()
				before := accounts.calls
				started := time.Now()
				report := gate.Preflight(ctx, "video", 1)
				checkMS := float64(time.Since(started).Microseconds()) / 1000
				if !report.Pass || report.Metrics.SpecsChecked != specs || len(report.dependencies.Offers) != len(repo.a.Config.Published.Offers) {
					t.Fatalf("full check failed: %+v", report)
				}
				if report.Metrics.ProductValidations != 1 || report.Metrics.ValidationReuses != 4*len(repo.a.Config.Published.Offers) {
					t.Fatalf("request-local validation counts: %+v", report.Metrics)
				}
				checkReads := accounts.calls - before
				if checkReads < 2+2*len(repo.a.Config.Published.Offers) {
					t.Fatal("native Account admission reads disappeared")
				}
				before = accounts.calls
				started = time.Now()
				state, applied, err := gate.Apply(ctx, "video", 1, true, gate.Status(ctx, "video").Revision, report.Fingerprint)
				applyMS := float64(time.Since(started).Microseconds()) / 1000
				if err != nil || !state.Requested || !state.Effective || applied == nil || !applied.Pass || applied.Metrics.SpecsChecked != specs {
					t.Fatalf("full apply failed: state=%+v report=%+v err=%v", state, applied, err)
				}
				// PUT gets an independent memo and repeats all specs and live admission.
				if applied.Metrics.ProductValidations != 1 || applied.Metrics.ValidationReuses != report.Metrics.ValidationReuses || accounts.calls-before < checkReads {
					t.Fatal("apply reused the prior POST grant or skipped native admission")
				}
				for _, metric := range []string{"apply_total", "apply_lock_wait", "apply_preflight", "apply_dependencies", "apply_effective_state"} {
					if _, ok := applied.Metrics.TimingsMS[metric]; !ok {
						t.Fatalf("missing %s", metric)
					}
				}
				checkTimes, applyTimes = append(checkTimes, checkMS), append(applyTimes, applyMS)
				encoded, err := json.Marshal(map[string]any{"fixture": name, "iteration": i, "specs": specs, "check_wall_ms": checkMS, "apply_wall_ms": applyMS, "native_account_reads_check": checkReads, "check": report.Metrics, "apply": applied.Metrics})
				if err != nil {
					t.Fatal(err)
				}
				t.Log(string(encoded))
				if closed, _, err := gate.Apply(ctx, "video", 1, false, state.Revision, ""); err != nil || closed.Requested || closed.Effective {
					t.Fatal("close failed", closed, err)
				}
				if gate.Status(ctx, "image").Requested || gate.Status(ctx, "image").Effective {
					t.Fatal("video test changed image control")
				}
			}
			sort.Float64s(checkTimes)
			sort.Float64s(applyTimes)
			index := (95*runs+99)/100 - 1
			t.Logf("PERF_P95 fixture=%s n=%d check_ms=%.3f apply_ms=%.3f specs=%d", name, runs, checkTimes[index], applyTimes[index], specs)
		})
	}
}

func TestStudioPaidApplyMetricsWithMinimalChecker(t *testing.T) {
	gate := &StudioPaidControl{
		Managed: true, Settings: &paidSettingsFake{values: map[string]string{}},
		Check: func(context.Context, string, int64) PaidReport {
			return PaidReport{Pass: true, Fingerprint: "same", Metrics: &PaidCheckMetrics{}}
		},
		Fingerprint: func(context.Context, string, int64) (string, error) { return "same", nil },
	}
	state, report, err := gate.Apply(context.Background(), "video", 1, true, "", "same")
	if err != nil || !state.Effective || report == nil || report.Metrics.TimingsMS == nil {
		t.Fatal("minimal checker lost successful admission", state, report, err)
	}
	if _, ok := report.Metrics.TimingsMS["apply_total"]; !ok {
		t.Fatal("apply timing not finalized")
	}
}

func TestStudioPaidAccountLifecycleIsolatesImageAndVideoGrants(t *testing.T) {
	for _, media := range []string{"image", "video"} {
		t.Run(media, func(t *testing.T) {
			ctx := context.Background()
			current := paidDependencies{Shared: "same-customer-and-storage", Offers: map[string]string{"7:one": "published-one", "8:two": "published-two"}}
			gate := paidGrantFixture(t, media, &current)
			// Snapshot excludes a deleted, disabled or unschedulable Account.
			delete(current.Offers, "7:one")
			if !gate.Status(ctx, media).Effective || !gate.AllowsOffer(ctx, media, 8, "two") || gate.AllowsOffer(ctx, media, 7, "one") {
				t.Fatal("removed Account closed another approved product")
			}
			current.Offers["9:new"] = "newly-published"
			if gate.AllowsOffer(ctx, media, 9, "new") || !gate.AllowsOffer(ctx, media, 8, "two") {
				t.Fatal("new Account borrowed admission or revoked another product")
			}
			delete(current.Offers, "8:two")
			if gate.Status(ctx, media).Effective {
				t.Fatal("only unchecked offers remained but service reported open")
			}
		})
	}
}

func TestStudioPaidConcurrentSameRevisionCannotReuseCheck(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	calls := 0
	gate := &StudioPaidControl{
		Managed: true, Settings: &paidSettingsFake{values: map[string]string{}},
		Check: func(context.Context, string, int64) PaidReport {
			calls++
			close(started)
			<-release
			return PaidReport{Pass: true, Fingerprint: "same", Metrics: &PaidCheckMetrics{}}
		},
		Fingerprint: func(context.Context, string, int64) (string, error) { return "same", nil },
	}
	type result struct {
		state PaidState
		err   error
	}
	results := make(chan result, 2)
	apply := func() {
		state, _, err := gate.Apply(context.Background(), "video", 1, true, "", "same")
		results <- result{state, err}
	}
	go apply()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("initial check did not start")
	}
	go apply()
	close(release)
	first, second := <-results, <-results
	successes := 0
	for _, outcome := range []result{first, second} {
		if outcome.err == nil && outcome.state.Effective {
			successes++
		} else if outcome.err != ErrPaidControl || outcome.state.Reason != "revision_changed" {
			t.Fatal("unexpected concurrent outcome", outcome)
		}
	}
	if successes != 1 || calls != 1 {
		t.Fatalf("same revision reused check: successes=%d calls=%d", successes, calls)
	}
}

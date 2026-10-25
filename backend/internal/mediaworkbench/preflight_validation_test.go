package mediaworkbench

import (
	"context"
	"maps"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func memoAccountSnapshot(t *testing.T, a *Account) *Account {
	t.Helper()
	r := &memoryRepo{a: *a}
	copy, err := r.Get(context.Background(), a.ID)
	must(t, err)
	copy.ModelMapping = maps.Clone(a.ModelMapping)
	copy.EndpointCapabilities = slices.Clone(a.EndpointCapabilities)
	return copy
}

func TestPublishedValidationMemoRequestScope(t *testing.T) {
	a := preflight1870Fixture(t)
	id := a.Config.Published.Products[0].ProductID
	ctx := WithPublishedValidationMemo(context.Background())
	for i := 0; i < 2; i++ {
		if !publishedProductReady(ctx, a, id) {
			t.Fatal("unchanged Published snapshot failed validation")
		}
	}
	if runs, reuses := PublishedValidationMemoStats(ctx); runs != 1 || reuses != 1 {
		t.Fatalf("same request: runs=%d reuses=%d", runs, reuses)
	}
	// Even wrapping an existing request starts an independent memo.
	fresh := WithPublishedValidationMemo(ctx)
	if !publishedProductReady(fresh, a, id) {
		t.Fatal("fresh request failed validation")
	}
	if runs, reuses := PublishedValidationMemoStats(fresh); runs != 1 || reuses != 0 {
		t.Fatalf("fresh request reused validation: runs=%d reuses=%d", runs, reuses)
	}
	calls := 0
	for i := 0; i < 2; i++ {
		memoizedPublishedValidation(context.Background(), a, id, func() bool { calls++; return true })
	}
	if calls != 2 {
		t.Fatalf("context without a memo computed %d times", calls)
	}
	if runs, reuses := PublishedValidationMemoStats(context.Background()); runs != 0 || reuses != 0 {
		t.Fatalf("context without a memo: runs=%d reuses=%d", runs, reuses)
	}
}

func TestPublishedValidationMemoSnapshotChanges(t *testing.T) {
	base := preflight1870Fixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*Account)
	}{
		{"base_url", func(a *Account) { a.BaseURL = "https://changed.example.invalid/v1" }},
		{"model_mapping", func(a *Account) { a.ModelMapping = map[string]string{"gpt-image-2": "changed"} }},
		{"endpoint_capabilities", func(a *Account) { a.EndpointCapabilities = []string{"changed"} }},
		{"routing_fingerprint", func(a *Account) { a.RoutingFingerprint = "changed" }},
		{"account_id", func(a *Account) { a.ID++ }},
		{"account_platform", func(a *Account) { a.Platform = "changed" }},
		{"account_type", func(a *Account) { a.Type = "changed" }},
		{"account_status", func(a *Account) { a.Status = "disabled" }},
		{"schedulable", func(a *Account) { a.Schedulable = false }},
		{"runtime_ready", func(a *Account) { a.RuntimeReady = false }},
		{"catalog_models", func(a *Account) { a.Catalog.Models = nil }},
		{"catalog_sync", func(a *Account) { a.Catalog.SyncedAt = "changed" }},
		{"sales", func(a *Account) { a.Config.Sales.Enabled = false }},
		{"lifecycle", func(a *Account) {
			a.Config.ProductLifecycle = map[string]ProductLifecycle{"p": {State: "unlisted", Revision: 1}}
		}},
		{"product_enabled", func(a *Account) { a.Config.Published.Products[0].Enabled = false }},
		{"product_capabilities", func(a *Account) { a.Config.Published.Products[0].Capabilities.Count.Max-- }},
		{"product_price", func(a *Account) { a.Config.Published.Products[0].PricingRules[0].SalePrice.Amount = "0" }},
		{"product_upstream", func(a *Account) { a.Config.Published.Products[0].UpstreamModel = "changed" }},
		{"published_revision", func(a *Account) { a.Config.Published.Revision = "changed" }},
		{"published_source", func(a *Account) { a.Config.Published.SourceDraftRevision = "changed" }},
		{"published_time", func(a *Account) { a.Config.Published.PublishedAt = a.Config.Published.PublishedAt.Add(time.Second) }},
		{"offer_price", func(a *Account) { a.Config.Published.Offers[0].SalePrice.Amount = "0" }},
		{"offers", func(a *Account) { a.Config.Published.Offers = nil }},
		{"product_dependencies", func(a *Account) { a.Config.Published.ProductDependencies = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := memoAccountSnapshot(t, base)
			id := a.Config.Published.Products[0].ProductID
			ctx := WithPublishedValidationMemo(context.Background())
			calls := 0
			if !memoizedPublishedValidation(ctx, a, id, func() bool { calls++; return true }) {
				t.Fatal("initial validation failed")
			}
			tc.mutate(a)
			// Some changes remain valid under native policy. Returning false here
			// isolates whether the new snapshot actually executes the validator.
			if memoizedPublishedValidation(ctx, a, id, func() bool { calls++; return false }) {
				t.Fatal("changed snapshot reused prior PASS")
			}
			if memoizedPublishedValidation(ctx, a, id, func() bool { calls++; return true }) {
				t.Fatal("unchanged failed snapshot was not reused")
			}
			if runs, reuses := PublishedValidationMemoStats(ctx); calls != 2 || runs != 2 || reuses != 1 {
				t.Fatalf("calls=%d runs=%d reuses=%d", calls, runs, reuses)
			}
		})
	}
	ctx := WithPublishedValidationMemo(context.Background())
	if !memoizedPublishedValidation(ctx, base, "first-product", func() bool { return true }) || memoizedPublishedValidation(ctx, base, "second-product", func() bool { return false }) {
		t.Fatal("different ProductID reused validation")
	}
}

func TestPublishedValidationMemoMarshalFailureClosed(t *testing.T) {
	a := preflight1870Fixture(t)
	ctx := WithPublishedValidationMemo(context.Background())
	id := a.Config.Published.Products[0].ProductID
	if !publishedProductReady(ctx, a, id) {
		t.Fatal("valid snapshot failed")
	}
	a.Config.Sales.UpdatedAt = time.Date(10000, time.January, 1, 0, 0, 0, 0, time.UTC)
	calls := 0
	if memoizedPublishedValidation(ctx, a, id, func() bool { calls++; return true }) {
		t.Fatal("unmarshalable snapshot reused or retained PASS")
	}
	if runs, reuses := PublishedValidationMemoStats(ctx); calls != 0 || runs != 1 || reuses != 0 {
		t.Fatalf("marshal failure: calls=%d runs=%d reuses=%d", calls, runs, reuses)
	}
}

// Like preflightCancelContext, this exposes deterministic CPU-work boundaries.
type memoTerminalContext struct {
	context.Context
	calls, after int
	err          error
}

func (c *memoTerminalContext) Err() error {
	c.calls++
	if c.calls >= c.after {
		return c.err
	}
	return nil
}

func TestPublishedValidationMemoCancellationAndDeadline(t *testing.T) {
	a := preflight1870Fixture(t)
	id := a.Config.Published.Products[0].ProductID
	for _, terminal := range []struct {
		name string
		err  error
	}{{"cancel", context.Canceled}, {"deadline", context.DeadlineExceeded}} {
		for _, hit := range []bool{false, true} {
			name := terminal.name + "/compute"
			if hit {
				name = terminal.name + "/hit"
			}
			t.Run(name, func(t *testing.T) {
				base := WithPublishedValidationMemo(context.Background())
				if hit && !memoizedPublishedValidation(base, a, id, func() bool { return true }) {
					t.Fatal("could not seed memo")
				}
				ctx := &memoTerminalContext{Context: base, after: 3, err: terminal.err}
				calls := 0
				if memoizedPublishedValidation(ctx, a, id, func() bool { calls++; return true }) {
					t.Fatal("terminal request returned PASS")
				}
				runs, reuses := PublishedValidationMemoStats(base)
				if hit {
					if calls != 0 || runs != 1 || reuses != 0 {
						t.Fatalf("terminal hit: calls=%d runs=%d reuses=%d", calls, runs, reuses)
					}
				} else {
					memo, ok := base.Value(publishedValidationMemoKey{}).(*publishedValidationMemo)
					if !ok || memo == nil {
						t.Fatal("missing request-local validation memo")
					}
					if calls != 1 || runs != 0 || reuses != 0 || len(memo.values) != 0 {
						t.Fatalf("terminal compute retained result: calls=%d runs=%d reuses=%d entries=%d", calls, runs, reuses, len(memo.values))
					}
				}
			})
		}
	}
}

func TestPublishedValidationMemoConcurrentComputeOnce(t *testing.T) {
	a := preflight1870Fixture(t)
	id := a.Config.Published.Products[0].ProductID
	ctx := WithPublishedValidationMemo(context.Background())
	const workers = 32
	var calls, failures atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if !memoizedPublishedValidation(ctx, a, id, func() bool {
				calls.Add(1)
				return validatePublishedProduct(ctx, a, id)
			}) {
				failures.Add(1)
			}
			PublishedValidationMemoStats(ctx)
		}()
	}
	close(start)
	wg.Wait()
	if runs, reuses := PublishedValidationMemoStats(ctx); calls.Load() != 1 || failures.Load() != 0 || runs != 1 || reuses != workers-1 {
		t.Fatalf("calls=%d failures=%d runs=%d reuses=%d", calls.Load(), failures.Load(), runs, reuses)
	}
}

func memoVideoSnapshot(t *testing.T) *Account {
	t.Helper()
	ctx := context.Background()
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
	r.a.Catalog.Models = []string{representativeUpstreamModel}
	m := genericReferenceVideoModel()
	// Keep the generic fixture larger than the 64 preview cap, while the
	// resolver's independent image-limit rejection remains exactly ten > nine.
	m.Durations = []int{5, 6, 7, 8, 9, 10, 11}
	m.Limits.Image, m.Limits.Total = 9, 9
	p := representativeVideoProduct(&Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"})
	p.Capabilities.Resolutions = slices.Clone(m.Resolutions)
	p.Capabilities.AspectRatios = slices.Clone(m.Ratios)
	p.Capabilities.DurationsSeconds = slices.Clone(m.Durations)
	p.Capabilities.References = References{Image: Range{Min: 0, Max: m.Limits.Image}, TotalMax: m.Limits.Total}
	p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"}}}
	d, err := s.Initialize(ctx, 7, []string{"video"})
	must(t, err)
	d, err = s.BindVideoAdapter(ctx, 7, d.Config.RecordVersion, "laoli_video")
	must(t, err)
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	_, err = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	must(t, err)
	return &r.a
}

func TestPublishedVideoOfferSnapshotAllSpecsMatchNative(t *testing.T) {
	a := memoVideoSnapshot(t)
	o := a.Config.Published.Offers[0]
	cases, err := PublishedOfferSpecs(a, o)
	must(t, err)
	if len(cases) <= 64 {
		t.Fatalf("fixture must cover specs outside capped previews, got %d", len(cases))
	}
	revision, deps := offerSnapshot(a, o)
	ctx := WithPublishedValidationMemo(context.Background())
	before := hash(a)
	for _, spec := range cases {
		native, err := ResolvePublishedVideoOfferContext(ctx, a, o.OfferID, spec)
		must(t, err)
		cached, err := resolvePublishedVideoOfferWithSnapshot(a, o.OfferID, spec, func(Offer) (string, Dependencies) {
			return revision, deps
		})
		must(t, err)
		if hash(native) != hash(cached) {
			t.Fatalf("snapshot differs from native resolver for %+v", spec)
		}
	}
	if runs, reuses := PublishedValidationMemoStats(ctx); runs != 1 || reuses != len(cases)-1 {
		t.Fatalf("all-spec native validation: runs=%d reuses=%d", runs, reuses)
	}
	if hash(a) != before {
		t.Fatal("snapshot helper mutated immutable Account")
	}
	t.Logf("all %d published video specs preserve native frozen identity", len(cases))
}

func TestPublishedVideoOfferSnapshotPreservesResolverRejections(t *testing.T) {
	base := memoVideoSnapshot(t)
	o := base.Config.Published.Offers[0]
	cases, err := PublishedOfferSpecs(base, o)
	must(t, err)
	for _, tc := range []struct {
		name   string
		mutate func(*Account, *string, *Spec)
	}{
		{"count_zero", func(_ *Account, _ *string, s *Spec) { s.Count = 0 }},
		{"count_multiple", func(_ *Account, _ *string, s *Spec) { s.Count = 2 }},
		{"duration_zero", func(_ *Account, _ *string, s *Spec) { s.DurationSeconds = 0 }},
		{"duration_negative", func(_ *Account, _ *string, s *Spec) { s.DurationSeconds = -1 }},
		{"duration_unmatched", func(_ *Account, _ *string, s *Spec) { s.DurationSeconds = 1 }},
		{"quality", func(_ *Account, _ *string, s *Spec) { s.Quality = "high" }},
		{"unknown_offer", func(_ *Account, id *string, _ *Spec) { *id = "missing" }},
		{"media", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].MediaType = "image" }},
		{"account", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].AccountID++ }},
		{"adapter", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].Adapter.Kind = "missing" }},
		{"adapter_revision", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].Adapter.Revision = "changed" }},
		{"adapter_auth", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].Adapter.Auth = "changed" }},
		{"adapter_task_flow", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].Adapter.TaskFlow = "changed" }},
		{"platform", func(a *Account, _ *string, _ *Spec) { a.Platform = "anthropic" }},
		{"resolution", func(_ *Account, _ *string, s *Spec) { s.Resolution = "missing" }},
		{"aspect_ratio", func(_ *Account, _ *string, s *Spec) { s.AspectRatio = "missing" }},
		{"output_format", func(_ *Account, _ *string, s *Spec) { s.OutputFormat = "png" }},
		{"image_limit", func(_ *Account, _ *string, s *Spec) { s.Images = 10 }},
		{"video_limit", func(_ *Account, _ *string, s *Spec) { s.Videos = 1 }},
		{"audio_limit", func(_ *Account, _ *string, s *Spec) { s.Audio = 1 }},
		{"excluded", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].Excluded = []Match{{}} }},
		{"missing_price", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.Amount = "" }},
		{"zero_price", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.Amount = "0" }},
		{"negative_price", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.Amount = "-1" }},
		{"malformed_price", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.Amount = "bad" }},
		{"price_currency", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.Currency = "invalid" }},
		{"billing_mode", func(a *Account, _ *string, _ *Spec) { a.Config.Published.Offers[0].SalePrice.BillingMode = "invalid" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := memoAccountSnapshot(t, base)
			id, spec := o.OfferID, cases[0]
			tc.mutate(a, &id, &spec)
			_, nativeErr := resolvePublishedVideoOffer(a, id, spec)
			called := false
			_, cachedErr := resolvePublishedVideoOfferWithSnapshot(a, id, spec, func(Offer) (string, Dependencies) {
				called = true
				return offerSnapshot(a, a.Config.Published.Offers[0])
			})
			if nativeErr != ErrRuntimeBinding || cachedErr != ErrRuntimeBinding || called {
				t.Fatalf("rejection differs: native=%v cached=%v snapshot_called=%v", nativeErr, cachedErr, called)
			}
		})
	}
}

func TestPublishedValidationMemoVideoSalesAndStatusRemainFresh(t *testing.T) {
	a := memoVideoSnapshot(t)
	o := a.Config.Published.Offers[0]
	cases, err := PublishedOfferSpecs(a, o)
	must(t, err)
	ctx := WithPublishedValidationMemo(context.Background())
	_, err = ResolvePublishedVideoOfferContext(ctx, a, o.OfferID, cases[0])
	must(t, err)
	a.Config.Sales.Enabled = false
	if _, err = ResolvePublishedVideoOfferContext(ctx, a, o.OfferID, cases[0]); err != ErrRuntimeBinding {
		t.Fatal("sales stop reused old validation", err)
	}
	a.Config.Sales.Enabled = true
	a.Status = "disabled"
	if _, err = ResolvePublishedVideoOfferContext(ctx, a, o.OfferID, cases[0]); err != ErrRuntimeBinding {
		t.Fatal("disabled Account reused old validation", err)
	}
	if runs, reuses := PublishedValidationMemoStats(ctx); runs != 2 || reuses != 0 {
		t.Fatalf("fresh native checks: runs=%d reuses=%d", runs, reuses)
	}
}

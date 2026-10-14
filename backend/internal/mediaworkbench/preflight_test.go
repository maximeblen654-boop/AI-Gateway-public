package mediaworkbench

import (
	"context"
	"os"
	"testing"
	"time"
)

func preflight1870Fixture(t *testing.T) *Account {
	t.Helper()
	s, r := validatorFixture(t)
	p := validProduct()
	p.AdapterConfig.SizeMappings = nil
	p.Capabilities.Resolutions = []string{"4K"}
	p.Capabilities.AspectRatios = []string{"1:1", "16:9", "4:5", "5:4", "21:9", "3:4", "4:3", "2:3", "3:2", "9:16", "9:21"}
	p.Capabilities.Count = Range{Min: 1, Max: 10}
	p.Capabilities.References.Image = Range{Min: 0, Max: 16}
	p.Capabilities.References.TotalMax = 16
	p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.025", Currency: "CNY", BillingMode: "per_request"}}}
	ctx := context.Background()
	d, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{p}})
	must(t, err)
	if !d.Config.Validation.PublishReady || d.Config.Validation.CaseCount != 1870 {
		t.Fatalf("fixture: %+v", d.Config.Validation)
	}
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	_, err = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	must(t, err)
	return &r.a
}

// Opt-in reproduction of the old request loop. Kept out of routine CI because
// it intentionally repeats the full validator 1,870 times; no network is used.
func TestPreflight1870LegacyTiming(t *testing.T) {
	if os.Getenv("STUDIO_PREFLIGHT_BASELINE") != "1" {
		t.Skip("opt-in quadratic baseline")
	}
	a := preflight1870Fixture(t)
	start := time.Now()
	cases, err := PublishedOfferSpecs(a, a.Config.Published.Offers[0])
	must(t, err)
	enumeration := time.Since(start)
	var resolveTime, compileTime time.Duration
	checked := 0
	for _, spec := range cases {
		at := time.Now()
		r, err := ResolvePublishedImageOffer(a, a.Config.Published.Offers[0].OfferID, spec)
		must(t, err)
		resolveTime += time.Since(at)
		at = time.Now()
		_, err = PublishedImageExecution(r)
		must(t, err)
		refs := make([]string, spec.Images)
		for i := range refs {
			refs[i] = "data:image/png;base64,c3ludGhldGlj"
		}
		_, err = CompilePublishedImagePlan(r, "non-paid preflight", refs)
		must(t, err)
		compileTime += time.Since(at)
		checked++
	}
	if checked != 1870 {
		t.Fatalf("coverage %d", checked)
	}
	t.Logf("legacy specs=%d enumerate=%s resolve_full_validation=%s compile=%s total=%s", checked, enumeration, resolveTime, compileTime, time.Since(start))
}

func TestPreflight1870CompleteAndFast(t *testing.T) {
	a := preflight1870Fixture(t)
	before := hash(a)
	started := time.Now()
	got, err := InspectPublishedOffers(context.Background(), a, "image")
	must(t, err)
	if got.SpecCount != 1870 || len(got.Offers) != 1 || got.Offers[0].SpecCount != 1870 || got.Offers[0].Err != nil {
		t.Fatalf("incomplete: %+v", got)
	}
	if len(got.Offers[0].Selected) != 2 {
		t.Fatal("text/edit paths missing")
	}
	if before != hash(a) {
		t.Fatal("inspection mutated account")
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("request-local full check exceeded 5s budget")
	}
	t.Logf("optimized specs=%d full_validation=%s all_spec_compilation=%s total=%s", got.SpecCount, got.ValidationTime, got.CompilationTime, time.Since(started))
	// Outside the 64 previews, both paths still use the exact frozen resolver.
	for _, images := range []int{0, 16} {
		spec := Spec{Resolution: "4K", AspectRatio: "16:9", Count: 10, Images: images}
		native, err := ResolvePublishedImageOffer(a, got.Offers[0].Offer.OfferID, spec)
		must(t, err)
		batch, err := resolvePublishedImageOffer(a, got.Offers[0].Offer.OfferID, spec)
		must(t, err)
		if hash(native) != hash(batch) {
			t.Fatal("batch differs from native frozen binding")
		}
	}
}

func TestPreflightInvalidSnapshotNeverCached(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*Account)
	}{
		{"mapping", func(a *Account) { a.ModelMapping = map[string]string{"gpt-image-2": "other"} }},
		{"routing", func(a *Account) { a.RoutingFingerprint = "changed" }},
		{"sales", func(a *Account) { a.Config.Sales.Enabled = false }},
		{"revision", func(a *Account) { a.Config.Published.Revision = "changed" }},
		{"offer_price", func(a *Account) {
			a.Config.Published.Offers[0].SalePrice.Amount = "0"
			a.Config.Published.Revision = publishedRevision(a.Config.Published)
		}},
		{"invalid_edit", func(a *Account) {
			a.Config.Published.Products[0].AdapterConfig.EditExecution = &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 1}
			a.Config.Published.Revision = publishedRevision(a.Config.Published)
		}},
		{"missing_price", func(a *Account) {
			a.Config.Published.Products[0].PricingRules = nil
			a.Config.Published.Revision = publishedRevision(a.Config.Published)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := preflight1870Fixture(t)
			_, err := InspectPublishedOffers(context.Background(), a, "image")
			must(t, err)
			tc.mutate(a)
			if _, err = InspectPublishedOffers(context.Background(), a, "image"); err == nil {
				t.Fatal("invalid snapshot reused prior PASS")
			}
		})
	}
	a := preflight1870Fixture(t)
	a.Config.Draft.Products = nil
	got, err := InspectPublishedOffers(context.Background(), a, "image")
	must(t, err)
	if got.SpecCount != 1870 {
		t.Fatal("unpublished Draft changed checked domain")
	}
}

// Deterministic cancellation during CPU work, independent of host scheduling.
type preflightCancelContext struct {
	context.Context
	calls, after int
	cancel       context.CancelFunc
}

func (c *preflightCancelContext) Err() error {
	c.calls++
	if c.calls == c.after {
		c.cancel()
	}
	return c.Context.Err()
}
func TestPreflightCancellationAndDeadline(t *testing.T) {
	a := preflight1870Fixture(t)
	for _, after := range []int{1, 300, 2200} {
		ctx, cancel := context.WithCancel(context.Background())
		counted := &preflightCancelContext{Context: ctx, after: after, cancel: cancel}
		got, err := InspectPublishedOffers(counted, a, "image")
		cancel()
		if err != context.Canceled || got.SpecCount == 1870 {
			t.Fatalf("cancel after %d: %+v %v", after, got, err)
		}
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := InspectPublishedOffers(ctx, a, "image"); err != context.DeadlineExceeded {
		t.Fatal(err)
	}
}

func TestPreflightVideoUsesSamePublishedValidation(t *testing.T) {
	ctx := context.Background()
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
	r.a.Catalog.Models = []string{representativeUpstreamModel}
	d, err := s.Initialize(ctx, 7, []string{"video"})
	must(t, err)
	d, err = s.BindVideoAdapter(ctx, 7, d.Config.RecordVersion, "laoli_video")
	must(t, err)
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{representativeVideoProduct(&Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"})}})
	must(t, err)
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	_, err = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	must(t, err)
	got, err := InspectPublishedOffers(ctx, &r.a, "video")
	must(t, err)
	if got.SpecCount != 1 || got.Offers[0].Err != nil {
		t.Fatalf("video: %+v", got)
	}
	o := got.Offers[0]
	spec := o.Selected["text"]
	native, err := ResolvePublishedVideoOffer(&r.a, o.Offer.OfferID, spec)
	must(t, err)
	batch, err := resolvePublishedVideoOffer(&r.a, o.Offer.OfferID, spec)
	must(t, err)
	if hash(native) != hash(batch) {
		t.Fatal("video resolver contract changed")
	}
	if _, err := InspectPublishedOffers(ctx, &r.a, "image"); err == nil {
		t.Fatal("video accepted as image")
	}
}

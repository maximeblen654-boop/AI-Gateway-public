package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func validProduct() Product {
	return Product{ProductID: "p", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true,
		Capabilities:  Capabilities{Resolutions: []string{"1K"}, AspectRatios: []string{"1:1", "16:9"}, Count: Range{1, 2}, References: References{Image: Range{0, 4}, TotalMax: 4}},
		AdapterConfig: ImageConfig{SizeMappings: []SizeMapping{{"1K", "1:1", "1024x1024"}, {"1K", "16:9", "1536x864"}}},
		PricingRules: []PricingRule{{Match: Match{References: &References{TotalMax: 0}}, SalePrice: &Price{Amount: "0", Currency: "USD", BillingMode: "per_request"}},
			{Match: Match{References: &References{Image: Range{1, 4}, TotalMax: 4}}, SalePrice: &Price{Amount: "0.100000000000000001", Currency: "USD", BillingMode: "per_request"}}}}
}
func validatorFixture(t *testing.T) (*Service, *memoryRepo) {
	t.Helper()
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.Catalog.Models = []string{"gpt-image-2", "gpt-image-new"}
	_, err := s.Initialize(context.Background(), 7, []string{"image", "video"})
	must(t, err)
	return s, r
}
func hasCode(v Validation, code, class string) bool {
	for _, d := range v.Diagnostics {
		if d.Code == code && d.Class == class {
			return true
		}
	}
	return false
}
func TestSaveValidatePublishSalesZeroNetwork(t *testing.T) {
	s, r := validatorFixture(t)
	var calls atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	t.Cleanup(server.Close)
	r.a.BaseURL = server.URL
	ctx := context.Background()
	d, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{validProduct()}})
	must(t, err)
	if d.Config.Validation.Status != "PASS" || !d.Config.Validation.PublishReady || d.Config.Validation.CaseCount != 20 || len(d.Config.Validation.Previews) != 20 {
		t.Fatalf("validation: %+v", d.Config.Validation)
	}
	if r.writes != 3 || d.Config.RecordVersion != 3 {
		t.Fatal("Draft must save before validation commits")
	}
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	if len(d.Config.Published.Offers) != 2 || d.EffectiveSales {
		t.Fatal("compact offers or paused Publish")
	}
	for _, preview := range d.Config.Validation.Previews {
		hits := 0
		for _, offer := range d.Config.Published.Offers {
			if offer.Matches(preview.Spec) {
				hits++
			}
		}
		if hits != 1 {
			t.Fatalf("spec matches %d offers", hits)
		}
		if preview.Fields["model"] != "gpt-image-2" || preview.Fields["prompt"] != "<dry-run-prompt>" {
			t.Fatal("preview not sanitized/mapped")
		}
		wantPath := "/v1/images/generations"
		if preview.Spec.Images > 0 {
			wantPath = "/v1/images/edits"
		}
		if preview.Path != wantPath {
			t.Fatal("wrong shared endpoint")
		}
	}
	snapshot, _ := json.Marshal(d.Config.Published)
	d, err = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	must(t, err)
	if !d.EffectiveSales || d.EffectiveState != "SELLING" {
		t.Fatalf("sales: %+v", d)
	}
	// An incomplete newer Draft cannot mutate or invalidate a valid Published.
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{})
	must(t, err)
	after, _ := json.Marshal(d.Config.Published)
	if string(snapshot) != string(after) || !d.EffectiveSales || d.Config.Validation.Status != "FAIL" {
		t.Fatal("Draft failure changed Published sales")
	}
	before := d.Config.Published.Revision
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	if !errors.Is(err, ErrValidation) || d.Config.Published.Revision != before {
		t.Fatal("invalid Draft published or old Published changed")
	}
	encoded, _ := json.Marshal(d.Config.Validation.Previews)
	for _, secret := range []string{"Authorization", "api_key", "cookie", server.URL, "real-user-prompt"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("unsafe preview")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("validation sent a supplier request")
	}
	// Runtime request outside the declared domain must match no compiled offer.
	bad := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1, DurationSeconds: 15}
	for _, o := range d.Config.Published.Offers {
		if o.Matches(bad) {
			t.Fatal("matcher widened omitted duration")
		}
	}
}

func TestDiagnosticsAndPriceBoundaries(t *testing.T) {
	cases := []struct {
		name, code, class string
		change            func(*Account, *Product)
	}{
		{"no snapshot", "MODEL_SYNC_REQUIRED", "UI_FIXABLE", func(a *Account, _ *Product) { a.Catalog = nil }},
		{"no sync timestamp", "MODEL_SYNC_REQUIRED", "UI_FIXABLE", func(a *Account, _ *Product) { a.Catalog.SyncedAt = "" }},
		{"missing model", "MODEL_NOT_DISCOVERED", "UI_FIXABLE", func(a *Account, _ *Product) { a.Catalog.Models = nil }},
		{"mapping", "MODEL_MAPPING_MISMATCH", "UI_FIXABLE", func(a *Account, _ *Product) { a.ModelMapping = map[string]string{"gpt-image-2": "gpt-image-new"} }},
		{"missing sale", "MISSING_PRICE", "UI_FIXABLE", func(a *Account, p *Product) {
			p.PricingRules[0].SalePrice = nil
			a.Config.Procurement.Entries = []ProcurementEntry{{Cost: Price{Amount: "1"}}}
		}},
		{"price gap", "MISSING_PRICE", "UI_FIXABLE", func(_ *Account, p *Product) { p.PricingRules = p.PricingRules[:1] }},
		{"overlap same price", "PRICE_RULE_OVERLAP", "UI_FIXABLE", func(_ *Account, p *Product) { p.PricingRules = append(p.PricingRules, p.PricingRules[0]) }},
		{"interior gap", "MISSING_PRICE", "UI_FIXABLE", func(_ *Account, p *Product) { p.PricingRules[1].Match.References.Image.Min = 3 }},
		{"interior overlap", "PRICE_RULE_OVERLAP", "UI_FIXABLE", func(_ *Account, p *Product) {
			rule := p.PricingRules[1]
			rule.Match.References = &References{Image: Range{2, 2}, TotalMax: 2}
			p.PricingRules = append(p.PricingRules, rule)
		}},
		{"precision", "INVALID_PRICE", "UI_FIXABLE", func(_ *Account, p *Product) { p.PricingRules[0].SalePrice.Amount = "1e-9" }},
		{"negative", "INVALID_PRICE", "UI_FIXABLE", func(_ *Account, p *Product) { p.PricingRules[0].SalePrice.Amount = "-1" }},
		{"unsupported duration", "PARAMETER_TYPE_UNSUPPORTED", "NEEDS_DEVELOPMENT", func(_ *Account, p *Product) { p.Capabilities.DurationsSeconds = []int{15} }},
		{"coded model", "VALUE_HARDCODED", "NEEDS_DEVELOPMENT", func(a *Account, p *Product) {
			p.SiteModel = "custom-image"
			p.UpstreamModel = p.SiteModel
			a.Catalog.Models = append(a.Catalog.Models, p.SiteModel)
		}},
		{"missing size map", "MISSING_VALUE_MAPPING", "UI_FIXABLE", func(_ *Account, p *Product) { p.AdapterConfig.SizeMappings = p.AdapterConfig.SizeMappings[:1] }},
		{"duplicate map", "DUPLICATE_VALUE_MAPPING", "UI_FIXABLE", func(_ *Account, p *Product) {
			p.AdapterConfig.SizeMappings = append(p.AdapterConfig.SizeMappings, p.AdapterConfig.SizeMappings[0])
		}},
		{"unsafe wire size", "INVALID_VALUE_MAPPING", "UI_FIXABLE", func(_ *Account, p *Product) { p.AdapterConfig.SizeMappings[0].WireSize = "https://secret.example" }},
		{"bad range", "INVALID_REFERENCE_LIMIT", "UI_FIXABLE", func(_ *Account, p *Product) { p.Capabilities.References.Image.Min = -1 }},
		{"bad total", "INVALID_REFERENCE_LIMIT", "UI_FIXABLE", func(_ *Account, p *Product) { p.Capabilities.References.TotalMax = -1 }},
		{"bad deny", "INVALID_COMBINATION_RULE", "UI_FIXABLE", func(_ *Account, p *Product) {
			p.Capabilities.CombinationRules = []CombinationRule{{Deny: Match{Resolution: []string{"4K"}}}}
		}},
		{"async", "TASK_FLOW_UNSUPPORTED", "NEEDS_DEVELOPMENT", func(a *Account, _ *Product) {
			b := a.Config.AdapterBindings["image"]
			b.TaskFlow = "async_task"
			a.Config.AdapterBindings["image"] = b
		}},
		{"auth", "AUTH_FLOW_UNSUPPORTED", "NEEDS_DEVELOPMENT", func(a *Account, _ *Product) {
			b := a.Config.AdapterBindings["image"]
			b.Auth = "oauth"
			a.Config.AdapterBindings["image"] = b
		}},
		{"Image2Pro absent", "BUILDER_REFACTOR_REQUIRED", "NEEDS_DEVELOPMENT", func(a *Account, _ *Product) { a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "image2pro"} }},
		{"video owned by Node", "BUILDER_REFACTOR_REQUIRED", "NEEDS_DEVELOPMENT", func(_ *Account, p *Product) { p.MediaType = "video" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, r := validatorFixture(t)
			p := validProduct()
			tc.change(&r.a, &p)
			v, offers := Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
			if v.PublishReady || v.Status != "FAIL" || len(offers) > 0 || !hasCode(v, tc.code, tc.class) {
				t.Fatalf("diagnostic: %+v", v)
			}
		})
	}
}

func TestCombinationRulesAndDeterministicMatchers(t *testing.T) {
	_, r := validatorFixture(t)
	p := validProduct()
	p.Capabilities.CombinationRules = []CombinationRule{{Deny: Match{AspectRatio: []string{"16:9"}, References: &References{Image: Range{3, 4}, TotalMax: 4}}}}
	v, offers := Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
	if !v.PublishReady || len(offers) != 2 || v.CaseCount != 16 {
		t.Fatalf("explicit deny: %+v", v)
	}
	for images := 0; images <= 4; images++ {
		for _, ratio := range []string{"1:1", "16:9"} {
			s := Spec{Resolution: "1K", AspectRatio: ratio, Count: 1, Images: images}
			hits := 0
			for _, o := range offers {
				if o.Matches(s) {
					hits++
				}
			}
			want := 1
			if ratio == "16:9" && images >= 3 {
				want = 0
			}
			if hits != want {
				t.Fatalf("%+v hits=%d", s, hits)
			}
		}
	}
	p.PricingRules[0], p.PricingRules[1] = p.PricingRules[1], p.PricingRules[0]
	p.Capabilities.AspectRatios = []string{"16:9", "1:1"}
	_, reordered := Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
	if hash(offers) != hash(reordered) {
		t.Fatal("rule/input order changed deterministic offers")
	}
}

func TestValidatorExcludesDeniedPricingCombination(t *testing.T) {
	_, r := validatorFixture(t)
	p := validProduct()
	p.Capabilities.Resolutions = []string{"1K", "2K"}
	p.Capabilities.Qualities = []string{"standard", "high"}
	p.Capabilities.CombinationRules = []CombinationRule{{Deny: Match{Resolution: []string{"2K"}, Quality: []string{"high"}}}}
	p.AdapterConfig.SizeMappings = append(p.AdapterConfig.SizeMappings,
		SizeMapping{"2K", "1:1", "2048x2048"}, SizeMapping{"2K", "16:9", "2560x1440"})
	p.PricingRules = []PricingRule{
		{Match: Match{Resolution: []string{"1K"}, Quality: []string{"standard"}}, SalePrice: &Price{Amount: "0.10", Currency: "USD", BillingMode: "per_request"}},
		{Match: Match{Resolution: []string{"1K"}, Quality: []string{"high"}}, SalePrice: &Price{Amount: "0.20", Currency: "USD", BillingMode: "per_request"}},
		{Match: Match{Resolution: []string{"2K"}, Quality: []string{"standard"}}, SalePrice: &Price{Amount: "0.30", Currency: "USD", BillingMode: "per_request"}},
	}
	v, offers := Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
	if !v.PublishReady || len(offers) != 3 {
		t.Fatalf("denied combination changed validation: status=%s diagnostics=%+v offers=%d", v.Status, v.Diagnostics, len(offers))
	}
	for _, tc := range []struct {
		resolution, quality string
		want                int
	}{
		{"1K", "standard", 1}, {"1K", "high", 1}, {"2K", "standard", 1}, {"2K", "high", 0},
	} {
		spec := Spec{Resolution: tc.resolution, Quality: tc.quality, AspectRatio: "1:1", Count: 1}
		hits := 0
		for _, offer := range offers {
			if offer.Matches(spec) {
				hits++
			}
		}
		if hits != tc.want {
			t.Fatalf("%s/%s matches=%d want=%d", tc.resolution, tc.quality, hits, tc.want)
		}
	}
}

func TestStaleDependenciesAndPublishedRuntimeGates(t *testing.T) {
	s, r := validatorFixture(t)
	ctx := context.Background()
	d, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{validProduct()}})
	must(t, err)
	r.a.Catalog.Models = []string{"gpt-image-new"} // stale successful sync, before Publish
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	if !errors.Is(err, ErrValidation) || !hasCode(d.Config.Validation, "MODEL_NOT_DISCOVERED", "UI_FIXABLE") || d.Config.Published != nil {
		t.Fatal("stale dependency published")
	}
	r.a.Catalog.Models = []string{"gpt-image-2"}
	d, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	version := d.Config.RecordVersion
	for _, change := range []func(){func() { r.a.RuntimeReady = false }, func() { r.a.Status = "inactive" }, func() { r.a.Schedulable = false }} {
		r.a.RuntimeReady = true
		r.a.Status = "active"
		r.a.Schedulable = true
		change()
		if _, err = s.SetSales(ctx, 7, version, true); !errors.Is(err, ErrSales) {
			t.Fatal("enabled runtime-blocked Account")
		}
	}
	r.a.RuntimeReady = true
	r.a.Status = "active"
	r.a.Schedulable = true
	r.a.ModelMapping = map[string]string{"gpt-image-2": "gpt-image-new"}
	if _, err = s.SetSales(ctx, 7, version, true); !errors.Is(err, ErrSales) {
		t.Fatal("stale mapping enabled")
	}
	r.a.ModelMapping = nil
	_, err = s.SetSales(ctx, 7, version, true)
	must(t, err)
	r.a.RuntimeReady = false
	d, err = s.Detail(ctx, 7)
	must(t, err)
	if d.EffectiveSales {
		t.Fatal("runtime cooldown did not stop readiness")
	}
	r.deleted = true
	if _, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted Account published")
	}
}

type racingRepo struct {
	*memoryRepo
	once    sync.Once
	entered chan struct{}
	resume  chan struct{}
}

func (r *racingRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps Dependencies, c *Config) error {
	r.once.Do(func() { close(r.entered); <-r.resume })
	return r.memoryRepo.CompareAndSwapChecked(ctx, id, expected, deps, c)
}
func TestOldValidationCannotOverwriteNewerDraft(t *testing.T) {
	_, base := validatorFixture(t)
	r := &racingRepo{memoryRepo: base, entered: make(chan struct{}), resume: make(chan struct{})}
	s := NewService(r)
	ctx := context.Background()
	finished := make(chan error, 1)
	go func() {
		_, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{validProduct()}})
		finished <- err
	}()
	<-r.entered
	d, err := s.Detail(ctx, 7)
	must(t, err)
	if d.Config.Validation.Status != "UNKNOWN" || d.Config.RecordVersion != 2 {
		t.Fatal("Draft was not saved first")
	}
	// Save a different Draft directly through the same CAS primitive while the
	// first local validation is delayed. No timings or network are involved.
	c := d.Config
	c.Draft = makeDraft(DraftInput{}, "", time.Now())
	c.RecordVersion++
	c.Validation = Validation{Status: "UNKNOWN", DraftRevision: c.Draft.Revision}
	must(t, base.CompareAndSwap(ctx, 7, 2, c))
	close(r.resume)
	must(t, <-finished)
	d, err = s.Detail(ctx, 7)
	must(t, err)
	if len(d.Config.Draft.Products) != 0 || d.Config.Validation.Status != "UNKNOWN" || d.Config.Validation.DraftRevision != d.Config.Draft.Revision {
		t.Fatal("old validation overwrote the new Draft")
	}
}

type unavailableRepo struct {
	*memoryRepo
	unavailable bool
}

func (r *unavailableRepo) Get(ctx context.Context, id int64) (*Account, error) {
	if r.unavailable {
		return nil, errors.New("local database unavailable")
	}
	return r.memoryRepo.Get(ctx, id)
}
func (r *unavailableRepo) CompareAndSwap(ctx context.Context, id, expected int64, c *Config) error {
	err := r.memoryRepo.CompareAndSwap(ctx, id, expected, c)
	if err == nil {
		r.unavailable = true
	}
	return err
}
func TestLocalDependencyFailureReturnsSavedDraftUnknown(t *testing.T) {
	_, base := validatorFixture(t)
	r := &unavailableRepo{memoryRepo: base}
	s := NewService(r)
	d, err := s.SaveDraft(context.Background(), 7, 1, DraftInput{Products: []Product{validProduct()}})
	must(t, err)
	if d.Config.RecordVersion != 2 || len(base.a.Config.Draft.Products) != 1 || !hasCode(d.Config.Validation, "LOCAL_DEPENDENCY_UNAVAILABLE", "UNKNOWN") || d.Config.Validation.Status != "UNKNOWN" || d.Config.Validation.PublishReady {
		t.Fatal("local dependency failure lost Draft or implied ready")
	}
}

func TestRegistryModesAndNewModelReuse(t *testing.T) {
	_, r := validatorFixture(t)
	p := validProduct()
	p.SiteModel = "gpt-image-new"
	p.UpstreamModel = p.SiteModel
	v, _ := Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
	if !v.PublishReady {
		t.Fatalf("same-flow new model: %+v", v)
	}
	d, ok := Descriptor("openai_images")
	if !ok || d.Parameters["resolution"].Mode != ConfigMap || d.Parameters["quality"].Mode != Passthrough || d.Parameters["reference_images"].Mode != Derived || d.Parameters["model"].Mode != CodeEnum || d.Parameters["duration_seconds"].Mode != Unsupported {
		t.Fatal("descriptor does not reflect builder")
	}
	// Stored bindings track the current registered builder on revalidation.
	b := r.a.Config.AdapterBindings["image"]
	b.Revision = "old_revision"
	r.a.Config.AdapterBindings["image"] = b
	v, _ = Validate(&r.a, Draft{Revision: "r", Products: []Product{p}}, time.Now())
	if !v.PublishReady {
		t.Fatal("old registry binding was not refreshed")
	}
}

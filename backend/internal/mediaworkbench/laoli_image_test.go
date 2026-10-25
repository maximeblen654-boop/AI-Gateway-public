package mediaworkbench

import (
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/tidwall/gjson"
)

func laoliImageFixture(t *testing.T) (*Service, *memoryRepo, Product) {
	t.Helper()
	s, r := validatorFixture(t)
	r.a.BaseURL = "https://video.laoliimage2.win/v1"
	r.a.Catalog.Models = []string{"gpt-image-2.5-sr-flare"}
	p := validProduct()
	p.SiteModel, p.UpstreamModel = "customer-laoli-alias", "gpt-image-2.5-sr-flare"
	p.Capabilities.References = References{Image: Range{Min: 0, Max: 2}, TotalMax: 2}
	p.Capabilities.Count = Range{Min: 1, Max: 3}
	p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}
	return s, r, p
}

func TestLaoliSyncImagePreservesOtherSupplierProfiles(t *testing.T) {
	for _, tc := range []struct{ base, family string }{
		{"https://ordinary.example/v1", ""},
		{"https://api.image2pro.top/v1", "image2pro_json"},
		{"https://video.laoliimage2.win/v1", "openai_json"},
		{"https://video.laoliimage2.win/v1", "image2pro_json"},
	} {
		_, r, p := laoliImageFixture(t)
		r.a.BaseURL = tc.base
		p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, tc.family
		before, err := json.Marshal(p)
		must(t, err)
		if inheritLaoliSyncProduct(&r.a, &p) {
			t.Fatal("an existing explicit or unrelated supplier profile was migrated", tc)
		}
		after, err := json.Marshal(p)
		must(t, err)
		if string(before) != string(after) {
			t.Fatal("profile mutation", tc)
		}
	}
	for _, family := range []string{"openai_json", "image2pro_json"} {
		p := validProduct()
		p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, family
		plan, err := compilePlan(p, Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1, Images: 1})
		must(t, err)
		ref := gjson.GetBytes(plan.MaterializeJSON(), "images.0")
		if family == "openai_json" && (ref.Type != gjson.JSON || !ref.Get("image_url").Exists() || plan.Protocol != "") {
			t.Fatal("ordinary OpenAI image shape changed", string(plan.MaterializeJSON()))
		}
		if family == "image2pro_json" && (ref.Type != gjson.String || plan.Protocol != imageplan.Image2ProSyncProtocol) {
			t.Fatal("Image2Pro string reference contract changed", string(plan.MaterializeJSON()))
		}
	}
}

func TestLaoliSyncImageDraftAndFrozenPlan(t *testing.T) {
	s, r, p := laoliImageFixture(t)
	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	if !d.Config.Validation.PublishReady || d.Config.Draft.Products[0].AdapterConfig.ModelFamily != laoliSyncFamily {
		t.Fatalf("dedicated supplier profile missing: %+v", d.Config.Validation)
	}
	d, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	d, err = s.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	must(t, err)
	spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 3, Images: 2}
	var offer Offer
	for _, o := range d.Config.Published.Offers {
		if o.Matches(spec) {
			offer = o
		}
	}
	binding, err := ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
	must(t, err)
	refs := []string{"https://example.com/reference.png", "data:image/png;base64,AQ=="}
	plan, err := CompilePublishedImagePlanForCount(binding, "synthetic", refs, 1)
	must(t, err)
	if plan.Protocol != imageplan.LaoliSyncProtocol || plan.Path != imageplan.Edits || gjson.GetBytes(plan.MaterializeJSON(), "images.0").String() != refs[0] {
		t.Fatal("runtime changed reference format", string(plan.MaterializeJSON()))
	}
	execution, err := PublishedImageExecution(binding)
	must(t, err)
	if len(execution.Units) != 3 || execution.MaxOutputImages != 1 {
		t.Fatal("unconfirmed native n inferred", execution)
	}
}

func TestLaoliSyncImageRejectsUnconfirmedProducts(t *testing.T) {
	for _, kind := range []string{"quality", "format", "native_multi", "async", "midjourney", "wrong_host"} {
		t.Run(kind, func(t *testing.T) {
			s, r, p := laoliImageFixture(t)
			switch kind {
			case "quality":
				p.Capabilities.Qualities = []string{"high"}
			case "format":
				p.Capabilities.OutputFormats = []string{"webp"}
			case "native_multi":
				p.AdapterConfig.Execution = &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 2}
			case "async":
				p.AdapterConfig.Execution = &ImageExecutionConfig{Mode: ImageExecutionProviderAsync, Provider: "gemini_api", MaxOutputImages: 1}
			case "midjourney":
				p.UpstreamModel, r.a.Catalog.Models = "midjourney", []string{"midjourney"}
			case "wrong_host":
				r.a.BaseURL = "https://video.laoliimage2.win.attacker.invalid/v1"
				p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, laoliSyncFamily
			}
			d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			if d.Config.Validation.PublishReady {
				t.Fatal("unconfirmed supplier contract published", kind)
			}
		})
	}
}

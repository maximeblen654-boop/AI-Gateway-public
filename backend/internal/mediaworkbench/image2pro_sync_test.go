package mediaworkbench

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/tidwall/gjson"
)

const image2ProNewPublicModel = "新公开图片模型-20261019"

func image2ProSyncFixture(t *testing.T) (*Service, *memoryRepo, Product) {
	t.Helper()
	s, r := validatorFixture(t)
	r.a.BaseURL = "https://api.image2pro.top/v1"
	r.a.Catalog.Models = []string{image2ProNewPublicModel}
	p := validProduct()
	p.SiteModel, p.UpstreamModel = "customer-image-alias", image2ProNewPublicModel
	p.Capabilities.Count = Range{Min: 1, Max: 5}
	p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}
	return s, r, p
}

func TestImage2ProSyncDraftInheritanceAndPublishedPlan(t *testing.T) {
	s, r, p := image2ProSyncFixture(t)
	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	if !d.Config.Validation.PublishReady {
		t.Fatalf("public model was rejected: %+v", d.Config.Validation.Diagnostics)
	}
	saved := d.Config.Draft.Products[0]
	if saved.SiteModel != p.SiteModel || saved.UpstreamModel != p.UpstreamModel || saved.AdapterConfig.Version != 1 || saved.AdapterConfig.ModelFamily != image2ProSyncFamily || saved.AdapterConfig.Execution != nil {
		t.Fatalf("draft inheritance changed model or conservative execution: %+v", saved)
	}
	for _, preview := range d.Config.Validation.Previews {
		if preview.Protocol != imageplan.Image2ProSyncProtocol || preview.Fields["model"] != image2ProNewPublicModel || preview.Fields["n"] != float64(1) {
			t.Fatalf("preview did not use one safe execution unit: %+v", preview)
		}
		if preview.Spec.Images > 0 {
			if _, ok := preview.Fields["images"].([]any)[0].(string); !ok {
				t.Fatal("preview references must be strings")
			}
		}
	}
	d, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	d, err = s.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	must(t, err)
	var offer Offer
	spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 5, Images: 2}
	for _, candidate := range d.Config.Published.Offers {
		if candidate.Matches(spec) {
			offer = candidate
		}
	}
	binding, err := ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
	must(t, err)
	plan, err := CompilePublishedImagePlanForCount(binding, "keep this prompt", []string{"https://example.com/reference.png", "data:image/png;base64,AQ=="}, 1)
	must(t, err)
	if plan.Protocol != imageplan.Image2ProSyncProtocol || gjson.GetBytes(plan.MaterializeJSON(), "model").String() != image2ProNewPublicModel || gjson.GetBytes(plan.MaterializeJSON(), "images.0").Type != gjson.String {
		t.Fatal("runtime lost public ID or string reference protocol", string(plan.MaterializeJSON()))
	}
	before, _ := json.Marshal(d.Config.Published)
	p = saved
	p.Enabled = false
	_, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	after, _ := json.Marshal(r.a.Config.Published)
	if string(before) != string(after) {
		t.Fatal("saving a new draft rewrote the prior published snapshot")
	}
}

func TestImage2ProSyncValidationRefusesUnconfirmedAndAsyncProducts(t *testing.T) {
	for _, kind := range []string{"quality", "format", "native_five", "edit_native_five", "async", "edit_async", "wrong_host"} {
		t.Run(kind, func(t *testing.T) {
			s, r, p := image2ProSyncFixture(t)
			code := ""
			switch kind {
			case "quality":
				p.Capabilities.Qualities = []string{"high"}
				code = "IMAGE2PRO_QUALITY_UNCONFIRMED"
			case "format":
				p.Capabilities.OutputFormats = []string{"png"}
				code = "IMAGE2PRO_OUTPUT_FORMAT_UNCONFIRMED"
			case "native_five", "edit_native_five":
				config := &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 5}
				if kind == "native_five" {
					p.AdapterConfig.Execution = config
				} else {
					p.AdapterConfig.EditExecution = config
				}
				code = "IMAGE2PRO_N_EXCEEDED"
			case "async", "edit_async":
				config := &ImageExecutionConfig{Mode: ImageExecutionProviderAsync, Provider: "gemini_api", MaxOutputImages: 1}
				if kind == "async" {
					p.AdapterConfig.Execution = config
				} else {
					p.AdapterConfig.EditExecution = config
				}
				code = "IMAGE2PRO_ASYNC_UNAVAILABLE"
			case "wrong_host":
				r.a.BaseURL = "https://api.image2pro.top.attacker.invalid/v1"
				p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, image2ProSyncFamily
				code = "IMAGE2PRO_SYNC_ACCOUNT_UNSUPPORTED"
			}
			d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			found := false
			for _, diag := range d.Config.Validation.Diagnostics {
				found = found || diag.Code == code
			}
			if d.Config.Validation.PublishReady || !found {
				t.Fatalf("invalid product was not rejected at its field: %+v", d.Config.Validation)
			}
			if d.Config.Draft.Products[0].AdapterConfig.Execution != nil && kind == "native_five" && d.Config.Draft.Products[0].AdapterConfig.Execution.MaxOutputImages != 5 {
				t.Fatal("invalid explicit capability was silently reduced")
			}
		})
	}
}

func TestImage2ProSyncCompilePreservesConfiguredSpecsAndSafeUnits(t *testing.T) {
	_, _, p := image2ProSyncFixture(t)
	p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, image2ProSyncFamily
	p.AdapterConfig.Execution = &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 4}
	spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 5}
	plan, err := compileImage2ProSyncPlan(p, spec)
	must(t, err)
	if plan.Fields["size"] != "1024x1024" || plan.Fields["n"] != float64(4) {
		t.Fatal(plan.Fields)
	}
	p.AdapterConfig.SizeMappings = nil
	plan, err = compileImage2ProSyncPlan(p, spec)
	must(t, err)
	if plan.Fields["resolution"] != "1K" || plan.Fields["aspect_ratio"] != "1:1" {
		t.Fatal(plan.Fields)
	}
	for _, override := range []Spec{{Count: 1, Quality: "high"}, {Count: 1, OutputFormat: "png"}, {Count: 1, Images: 17}} {
		if _, err = compileImage2ProSyncPlan(p, override); err == nil {
			t.Fatal("invalid runtime specification accepted", override)
		}
	}
	for _, host := range []string{"https://other.example/v1", "http://api.image2pro.top", "https://api.image2pro.top:444/v1", "https://api.image2pro.top/other"} {
		a := &Account{Platform: "openai", Type: "apikey", BaseURL: host}
		ordinary := validProduct()
		before, _ := json.Marshal(ordinary)
		if inheritImage2ProSyncProduct(a, &ordinary) {
			t.Fatal("wrong host inherited Image2Pro")
		}
		after, _ := json.Marshal(ordinary)
		if string(before) != string(after) {
			t.Fatal("unrelated provider changed")
		}
	}
}

func TestImage2ProSyncOldDraftRequiresSaveAndRepublish(t *testing.T) {
	s, r, p := image2ProSyncFixture(t)
	p.CostVersion, p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, 1, "openai_json"
	r.a.Config.Draft = makeDraft(DraftInput{Products: []Product{p}}, "", time.Now().UTC())
	v, _ := Validate(&r.a, r.a.Config.Draft, time.Now().UTC())
	if v.PublishReady || !hasCode(v, "IMAGE2PRO_SYNC_PROFILE_REQUIRED", "UI_FIXABLE") {
		t.Fatal(v.Diagnostics)
	}
	for _, d := range v.Diagnostics {
		if d.Code == "IMAGE2PRO_SYNC_PROFILE_REQUIRED" && (strings.Contains(d.Message+d.Action, "image2pro_json") || !strings.Contains(d.Action, "重新保存")) {
			t.Fatal(d)
		}
	}
	_, err := s.Publish(t.Context(), 7, r.a.Config.RecordVersion, r.a.Config.Draft.Revision)
	if !errors.Is(err, ErrValidation) {
		t.Fatal("old profile published without a fresh save", err)
	}
	saved, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	if !saved.Config.Validation.PublishReady || saved.Config.Draft.Products[0].AdapterConfig.ModelFamily != image2ProSyncFamily {
		t.Fatal(saved.Config.Validation.Diagnostics)
	}
	_, err = s.Publish(t.Context(), 7, saved.Config.RecordVersion, saved.Config.Draft.Revision)
	must(t, err)
}

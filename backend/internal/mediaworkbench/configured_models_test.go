package mediaworkbench

import (
	"context"
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"testing"
	"time"
)

func TestConfiguredModelsOutsideStaticRegistry(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			s, r := validatorFixture(t)
			id := "new-discovered-" + kind
			r.a.Catalog.Models = append(r.a.Catalog.Models, id)
			p := validProduct()
			p.SiteModel = id
			p.UpstreamModel = id
			p.MediaType = kind
			p.AdapterConfig.Version = 1
			p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}
			if kind == "image" {
				p.AdapterConfig.ModelFamily = "openai_json"
			} else {
				d, _ := Descriptor("laoli_video")
				r.a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
				p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "images"}
				p.Capabilities = Capabilities{Resolutions: []string{"test-resolution"}, AspectRatios: []string{"17:9"}, DurationsSeconds: []int{7}, Count: Range{1, 1}, References: References{Image: Range{0, 1}, TotalMax: 1}}
			}
			saved, e := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, e)
			if !saved.Config.Validation.PublishReady {
				t.Fatalf("%+v", saved.Config.Validation.Diagnostics)
			}
			saved, e = s.Publish(context.Background(), 7, saved.Config.RecordVersion, saved.Config.Draft.Revision)
			must(t, e)
			_, e = s.SetSales(context.Background(), 7, saved.Config.RecordVersion, true)
			must(t, e)
			spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1}
			if kind == "image" {
				bound, e := ResolvePublishedImageOffer(&r.a, r.a.Config.Published.Offers[0].OfferID, spec)
				must(t, e)
				plan, e := CompilePublishedImagePlan(bound, "test", nil)
				must(t, e)
				if plan.Fields["model"] != id {
					t.Fatal("wrong model")
				}
			} else {
				spec = Spec{Resolution: "test-resolution", AspectRatio: "17:9", DurationSeconds: 7, Count: 1}
				bound, e := ResolvePublishedVideoOffer(&r.a, r.a.Config.Published.Offers[0].OfferID, spec)
				must(t, e)
				m, ok := VideoProfileModel(p)
				if !ok {
					t.Fatal("profile")
				}
				wire, e := videoplan.PreviewWithModel(m, id, spec.Resolution, spec.AspectRatio, 7, 0, 0, 0)
				must(t, e)
				plan, e := CompilePublishedVideoPlan(bound, wire.Body)
				must(t, e)
				p.Capabilities.DurationsSeconds = []int{8}
				v, _ := Validate(&r.a, Draft{Revision: "next", Products: []Product{p}}, time.Now())
				if !v.PublishReady {
					t.Fatal(v.Diagnostics)
				}
				again, e := CompilePublishedVideoPlan(bound, wire.Body)
				must(t, e)
				if again.RequestHash != plan.RequestHash {
					t.Fatal("old binding changed")
				}
				var f map[string]any
				_ = json.Unmarshal(wire.Body, &f)
				f["duration"] = 8
				b, _ := json.Marshal(f)
				if _, e = CompilePublishedVideoPlan(bound, b); e == nil {
					t.Fatal("old quote accepted changed spec")
				}
			}
		})
	}
}
func TestConfiguredProfileSafety(t *testing.T) {
	_, r := validatorFixture(t)
	p := validProduct()
	p.AdapterConfig.Version = 1
	p.AdapterConfig.ModelFamily = "arbitrary-template"
	v, _ := Validate(&r.a, Draft{Products: []Product{p}}, time.Now())
	if v.PublishReady {
		t.Fatal("unknown family")
	}
	p.MediaType = "video"
	p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "https://evil.invalid"}
	if _, ok := VideoProfileModel(p); ok {
		t.Fatal("arbitrary wire")
	}
	p.SiteModel = "unconfigured-video"
	p.AdapterConfig = ImageConfig{}
	if _, ok := VideoProfileModel(p); ok {
		t.Fatal("missing frozen video capabilities automatically opened")
	}
}

func TestSeedanceNativeAdapterAndPlan(t *testing.T) {
	a := &Account{Platform: "openai", Type: "apikey", EndpointCapabilities: []string{"seedance"}}
	if got := nativeAdapterKind(a, "video"); got != "seedance_video" {
		t.Fatalf("native adapter = %q", got)
	}
	d, ok := Descriptor("seedance_video")
	if !ok || d.Revision != "core_seedance_video_r1" || d.TaskFlow != "async" {
		t.Fatalf("descriptor = %+v, ok=%v", d, ok)
	}
	p := Product{MediaType: "video", SiteModel: "site-video", UpstreamModel: "ep-video", AdapterConfig: ImageConfig{}, Capabilities: Capabilities{
		Resolutions: []string{"720p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5},
		References: References{Image: Range{0, 1}, Audio: Range{0, 1}, TotalMax: 2},
	}}
	inheritNativeProduct(a, &p)
	if p.AdapterConfig.Version != 1 || p.AdapterConfig.WireProfile != "seedance" {
		t.Fatalf("inherited adapter config = %+v", p.AdapterConfig)
	}
	m, ok := VideoProfileModel(p)
	if !ok {
		t.Fatal("seedance video profile was not accepted")
	}
	preview, err := videoplan.PreviewWithModel(m, "ep-video", "720p", "16:9", 5, 1, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := videoplan.CompilePlanForModel(m, "ep-video", preview.Body)
	if err != nil {
		t.Fatal(err)
	}
	if compiled.AdapterRevision != "core_seedance_video_r1" || compiled.Path != "/v1/contents/generations/tasks" {
		t.Fatalf("compiled plan = %+v", compiled)
	}
}

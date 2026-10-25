package mediaworkbench

import (
	"context"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func laoliVideoProduct(id string) Product {
	return Product{ProductID: "new-video", MediaType: "video", SiteModel: id, UpstreamModel: id, Enabled: true,
		Capabilities: Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5}, Count: Range{Min: 1, Max: 1}, References: References{Image: Range{Max: 1}, TotalMax: 1}},
		PricingRules: []PricingRule{{SalePrice: &Price{Amount: "1.00", Currency: "CNY", BillingMode: "per_request"}}}}
}

func TestLaoliNewContractInheritanceIsExactAndOriginScoped(t *testing.T) {
	for _, base := range []string{"https://video.laoliimage2.win", "https://video.laoliimage2.win/v1", "https://compat.example/v1", "https://video.laoliimage2.win.evil/v1"} {
		s, r := validatorFixture(t)
		r.a.BaseURL = base
		r.a.Catalog.Models = []string{"3.0"}
		r.a.ModelMapping = map[string]string{"3.0": "3.0"}
		saved, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{laoliVideoProduct("3.0")}})
		if err != nil {
			t.Fatal(err)
		}
		got := saved.Config.Draft.Products[0].AdapterConfig.WireProfile
		want := "images"
		if base == "https://video.laoliimage2.win" || base == "https://video.laoliimage2.win/v1" {
			want = videoplan.LaoliMediaProfile
		}
		if got != want {
			t.Fatalf("%s: got %q want %q", base, got, want)
		}
		if !saved.Config.Validation.PublishReady {
			t.Fatalf("%s: %+v", base, saved.Config.Validation.Diagnostics)
		}
	}
}

func TestLaoliContractRejectsExplicitProfileOnAnotherOrigin(t *testing.T) {
	_, r := validatorFixture(t)
	p := laoliVideoProduct("3.0")
	p.AdapterConfig = ImageConfig{Version: 1, WireProfile: videoplan.LaoliMediaProfile}
	d, _ := Descriptor("laoli_video")
	r.a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
	r.a.Catalog.Models = []string{"3.0"}
	r.a.ModelMapping = map[string]string{"3.0": "3.0"}
	r.a.BaseURL = "https://other.example"
	validation, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
	if !hasCode(validation, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT") {
		t.Fatalf("explicit new profile escaped supplier scope: %+v", validation.Diagnostics)
	}
}

func TestLaoliUnknownRatiosRequireDraftAndCannotExpandDocumentedLimits(t *testing.T) {
	_, r := validatorFixture(t)
	r.a.BaseURL = "https://video.laoliimage2.win"
	p := laoliVideoProduct("sd-native-full-2.0")
	p.Capabilities.AspectRatios = nil
	inheritNativeProduct(&r.a, &p)
	if p.AdapterConfig.WireProfile != videoplan.LaoliMediaProfile {
		t.Fatal("unknown ratios fell back to legacy contract")
	}
	if _, ok := VideoProfileModel(p); ok {
		t.Fatal("invented missing aspect ratios")
	}
	p.Capabilities.AspectRatios = []string{"17:9"}
	m, ok := VideoProfileModel(p)
	if !ok || len(m.Ratios) != 1 || m.Ratios[0] != "17:9" {
		t.Fatal("explicit draft ratio was not preserved")
	}
	p = laoliVideoProduct("3.0")
	p.AdapterConfig = ImageConfig{Version: 1, WireProfile: videoplan.LaoliMediaProfile}
	p.Capabilities.Resolutions = []string{"1080p"}
	d, _ := Descriptor("laoli_video")
	r.a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
	r.a.Catalog.Models = []string{"3.0"}
	r.a.ModelMapping = map[string]string{"3.0": "3.0"}
	validation, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
	for _, diag := range validation.Diagnostics {
		if diag.Code == "VIDEO_RESOLUTION_UNSUPPORTED" {
			return
		}
	}
	t.Fatalf("expanded documented resolution: %+v", validation.Diagnostics)
}

func TestLaoliOriginCannotFallBackToUnlistedGenericModel(t *testing.T) {
	s, r := validatorFixture(t)
	r.a.BaseURL = "https://video.laoliimage2.win"
	p := laoliVideoProduct("unlisted-video-model")
	r.a.Catalog.Models = []string{p.UpstreamModel}
	r.a.ModelMapping = map[string]string{p.SiteModel: p.UpstreamModel}
	saved, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	if err != nil {
		t.Fatal(err)
	}
	if !hasCode(saved.Config.Validation, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT") {
		t.Fatalf("unlisted supplier model fell back: %+v", saved.Config.Validation.Diagnostics)
	}
}

func TestLaoliIntegrationPreservesOtherNativeVideoAdapters(t *testing.T) {
	for _, tc := range []struct {
		name    string
		account Account
		want    string
	}{
		{"ordinary", Account{Platform: "openai", Type: "apikey", BaseURL: "https://ordinary.example/v1"}, "laoli_video"},
		{"image2pro", Account{Platform: "openai", Type: "apikey", BaseURL: "https://api.image2pro.top/v1"}, "image2pro_video"},
		{"grok", Account{Platform: "grok", Type: "apikey", BaseURL: "https://grok.example/v1"}, "grok_video"},
		{"grok-oauth", Account{Platform: "grok", Type: "oauth"}, "grok_video"},
		{"seedance", Account{Platform: "openai", Type: "apikey", BaseURL: "https://seedance.example", EndpointCapabilities: []string{"seedance"}}, "seedance_video"},
		{"seedance-on-laoli-origin", Account{Platform: "openai", Type: "apikey", BaseURL: "https://video.laoliimage2.win", EndpointCapabilities: []string{"seedance"}}, "seedance_video"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := nativeAdapterKind(&tc.account, "video"); got != tc.want {
				t.Fatalf("adapter changed: %q want %q", got, tc.want)
			}
			p := laoliVideoProduct("3.0")
			inheritNativeProduct(&tc.account, &p)
			if p.AdapterConfig.WireProfile == videoplan.LaoliMediaProfile {
				t.Fatalf("new Laoli profile selected for %s", tc.name)
			}
		})
	}
}

func TestGenericVideoWithoutStoredProfileKeepsItsOwnCapabilities(t *testing.T) {
	_, r := validatorFixture(t)
	r.a.BaseURL = "https://another-supplier.example/v1"
	p := laoliVideoProduct("other-supplier-custom-model")
	p.AdapterConfig = ImageConfig{}
	r.a.Catalog.Models = []string{p.UpstreamModel}
	r.a.ModelMapping = map[string]string{p.SiteModel: p.UpstreamModel}
	d, _ := Descriptor("laoli_video")
	r.a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
	validation, _ := Validate(&r.a, Draft{Revision: "existing-generic", Products: []Product{p}}, time.Now())
	if !validation.PublishReady {
		t.Fatalf("other supplier's frozen capabilities were rejected: %+v", validation.Diagnostics)
	}
	m, ok := VideoProfileModel(p)
	if !ok || m.Upstream != p.UpstreamModel || m.Mode != "images" {
		t.Fatal("generic profile requires a supplier model table")
	}
	plan, err := videoplan.PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Path != "/v1/videos" || plan.AdapterRevision != videoplan.Revision {
		t.Fatal("other supplier transport changed")
	}
	p.AdapterConfig.Version = 2
	if _, ok = VideoProfileModel(p); ok {
		t.Fatal("unknown config version accepted")
	}
}

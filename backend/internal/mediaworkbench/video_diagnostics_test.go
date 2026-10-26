package mediaworkbench

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func requireVideoDiagnostic(t *testing.T, v Validation, code, class, path string) {
	t.Helper()
	for _, d := range v.Diagnostics {
		if d.Code == code && d.Class == class && d.Path == path {
			if d.Scope == "" || !strings.ContainsAny(d.Message, "比例时长分辨率数量视频图片参考配置") {
				t.Fatalf("diagnostic must identify the product and explain the field in Chinese: %+v", d)
			}
			return
		}
	}
	t.Fatalf("missing %s/%s at %s: %+v", code, class, path, v.Diagnostics)
}

func requireNoVideoDevelopmentDiagnostic(t *testing.T, v Validation) {
	t.Helper()
	for _, d := range v.Diagnostics {
		if d.Class == "NEEDS_DEVELOPMENT" {
			t.Fatalf("ordinary draft configuration was classified as development: %+v", v.Diagnostics)
		}
	}
	if v.PublishReady || v.Status != "FAIL" {
		t.Fatalf("incomplete configuration must still fail closed: %+v", v)
	}
}

func TestLaoliMissingOrMalformedRatioIsDraftFixable(t *testing.T) {
	for _, model := range []string{"sd-native-full-2.0", "sd-native-full-2.5", "wan-3.0-video-ref", "wan-3.0-no-video-ref"} {
		for _, ratios := range [][]string{nil, {""}, {"16/9"}, {"16:9", "16:9"}} {
			t.Run(model+"/"+strings.Join(ratios, ","), func(t *testing.T) {
				s, r := validatorFixture(t)
				r.a.BaseURL = "https://video.laoliimage2.win"
				r.a.Catalog.Models = []string{model}
				p := laoliVideoProduct(model)
				p.Capabilities.AspectRatios = ratios
				saved, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
				must(t, err)
				v := saved.Config.Validation
				code := "VIDEO_RATIO_INVALID"
				if len(ratios) == 0 {
					code = "VIDEO_RATIO_REQUIRED"
				}
				requireVideoDiagnostic(t, v, code, "UI_FIXABLE", "capabilities.aspect_ratios")
				requireNoVideoDevelopmentDiagnostic(t, v)
				got := saved.Config.Draft.Products[0]
				if !reflect.DeepEqual(got.Capabilities.AspectRatios, ratios) || got.PricingRules[0].SalePrice.Amount != "1.00" {
					t.Fatal("validation changed the operator's ratios or price")
				}
				if _, ok := VideoProfileModel(got); ok {
					t.Fatal("incomplete ratios became an executable model")
				}
			})
		}
	}
}

func TestVideoFieldDiagnosticsDistinguishConfigurationFromSupport(t *testing.T) {
	for _, tc := range []struct {
		name, code, class, path string
		change                  func(*Product)
	}{
		{"missing ratio", "VIDEO_RATIO_REQUIRED", "UI_FIXABLE", "capabilities.aspect_ratios", func(p *Product) { p.Capabilities.AspectRatios = nil }},
		{"missing duration", "VIDEO_DURATION_REQUIRED", "UI_FIXABLE", "capabilities.durations_seconds", func(p *Product) { p.Capabilities.DurationsSeconds = nil }},
		{"missing resolution", "VIDEO_RESOLUTION_REQUIRED", "UI_FIXABLE", "capabilities.resolutions", func(p *Product) { p.Capabilities.Resolutions = nil }},
		{"invalid count", "INVALID_REFERENCE_LIMIT", "UI_FIXABLE", "capabilities.count", func(p *Product) { p.Capabilities.Count = Range{} }},
		{"multiple videos", "VIDEO_COUNT_UNSUPPORTED", "NEEDS_DEVELOPMENT", "capabilities.count", func(p *Product) { p.Capabilities.Count.Max = 2 }},
		{"quality parameter", "VIDEO_QUALITY_UNSUPPORTED", "NEEDS_DEVELOPMENT", "capabilities.qualities", func(p *Product) { p.Capabilities.Qualities = []string{"high"} }},
		{"image size mappings", "VIDEO_IMAGE_SIZE_MAPPING_CONFLICT", "UI_FIXABLE", "adapter_config.size_mappings", func(p *Product) { p.AdapterConfig.SizeMappings = []SizeMapping{{"720p", "16:9", "1280x720"}} }},
		{"image family", "VIDEO_MODEL_FAMILY_CONFLICT", "UI_FIXABLE", "adapter_config.model_family", func(p *Product) { p.AdapterConfig.ModelFamily = "openai_json" }},
		{"existing multimedia profile conflict", "VIDEO_REFERENCES_PROFILE_CONFLICT", "UI_FIXABLE", "adapter_config.wire_profile", func(p *Product) { p.Capabilities.References.Video.Max = 1; p.Capabilities.References.TotalMax = 2 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, r := validatorFixture(t)
			p := laoliVideoProduct("generic-video")
			p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "images"}
			r.a.Catalog.Models = []string{p.UpstreamModel}
			tc.change(&p)
			before := hash(p)
			v, offers := Validate(&r.a, Draft{Revision: "video-fields", Products: []Product{p}}, time.Now())
			requireVideoDiagnostic(t, v, tc.code, tc.class, tc.path)
			if tc.class == "UI_FIXABLE" {
				requireNoVideoDevelopmentDiagnostic(t, v)
			}
			if hash(p) != before || len(offers) != 0 || v.PublishReady {
				t.Fatal("invalid video configuration changed or produced offers")
			}
			if hasCode(v, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT") {
				t.Fatalf("specific field error also emitted a generic profile failure: %+v", v.Diagnostics)
			}
		})
	}
}

func TestImage2ProMissingMetadataHasOneActionableDiagnostic(t *testing.T) {
	s, r, p := image2ProVideoFixture(t)
	r.a.Image2ProVideoCapabilities = nil
	saved, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	must(t, err)
	v := saved.Config.Validation
	requireVideoDiagnostic(t, v, "IMAGE2PRO_VIDEO_METADATA_REQUIRED", "UI_FIXABLE", "adapter_config.image2pro")
	requireNoVideoDevelopmentDiagnostic(t, v)
	if len(v.Diagnostics) != 1 || saved.Config.Draft.Products[0].PricingRules[0].SalePrice.Amount != "4" {
		t.Fatalf("missing metadata should preserve the draft and have one cause: %+v", v.Diagnostics)
	}
}

func TestImage2ProDefaultSizeRequiresOneValidOperatorLabel(t *testing.T) {
	for _, labels := range [][]string{nil, {"supplier-default", "480P"}, {" bad "}} {
		s, _, p := seedance2VideoFixture(t)
		p.Capabilities.Resolutions = labels
		p.PricingRules[0].Match.Resolution = nil
		saved, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
		must(t, err)
		requireVideoDiagnostic(t, saved.Config.Validation, "IMAGE2PRO_VIDEO_RESOLUTION_LABEL_REQUIRED", "UI_FIXABLE", "capabilities.resolutions")
		requireNoVideoDevelopmentDiagnostic(t, saved.Config.Validation)
		if !reflect.DeepEqual(saved.Config.Draft.Products[0].Capabilities.Resolutions, labels) {
			t.Fatal("validation replaced operator labels")
		}
	}
}

func TestVideoUnknownContractsStillNeedDevelopment(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile string
		version int
		base    string
		model   string
		path    string
	}{
		{"unknown profile", "future_profile", 1, "https://supplier.example", "generic-video", "adapter_config.wire_profile"},
		{"unknown version", "images", 2, "https://supplier.example", "generic-video", "adapter_config.version"},
		{"unknown exact Laoli model", videoplan.LaoliMediaProfile, 1, "https://video.laoliimage2.win", "unlisted-video", "upstream_model"},
		{"foreign Laoli origin", videoplan.LaoliMediaProfile, 1, "https://other.example", "3.0", "adapter_config.wire_profile"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, r := validatorFixture(t)
			p := laoliVideoProduct(tc.model)
			p.AdapterConfig = ImageConfig{Version: tc.version, WireProfile: tc.profile}
			r.a.BaseURL = tc.base
			r.a.Catalog.Models = []string{tc.model}
			v, offers := Validate(&r.a, Draft{Revision: "unsupported-video", Products: []Product{p}}, time.Now())
			requireVideoDiagnostic(t, v, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT", tc.path)
			if v.PublishReady || len(offers) > 0 {
				t.Fatal("unsupported contract produced a sellable offer")
			}
		})
	}
}

func TestVideoMalformedFieldValuesStayDraftFixable(t *testing.T) {
	for _, tc := range []struct {
		name, code, path string
		change           func(*Product)
	}{
		{"reversed count", "INVALID_REFERENCE_LIMIT", "capabilities.count", func(p *Product) { p.Capabilities.Count = Range{Min: 2, Max: 1} }},
		{"count above form limit", "INVALID_REFERENCE_LIMIT", "capabilities.count", func(p *Product) { p.Capabilities.Count.Max = 11 }},
		{"negative reference", "INVALID_REFERENCE_LIMIT", "capabilities.references.image", func(p *Product) { p.Capabilities.References.Image.Min = -1 }},
		{"duplicate resolution", "INVALID_SPECIFICATION_FORMAT", "capabilities.resolutions", func(p *Product) { p.Capabilities.Resolutions = []string{"720p", "720p"} }},
		{"blank ratio", "VIDEO_RATIO_INVALID", "capabilities.aspect_ratios", func(p *Product) { p.Capabilities.AspectRatios = []string{" "} }},
		{"blank quality", "INVALID_SPECIFICATION_FORMAT", "capabilities.qualities", func(p *Product) { p.Capabilities.Qualities = []string{""} }},
		{"duplicate duration", "INVALID_SPECIFICATION_FORMAT", "capabilities.durations_seconds", func(p *Product) { p.Capabilities.DurationsSeconds = []int{5, 5} }},
		{"legacy profile missing ratio", "VIDEO_RATIO_REQUIRED", "capabilities.aspect_ratios", func(p *Product) { p.AdapterConfig = ImageConfig{}; p.Capabilities.AspectRatios = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, r := validatorFixture(t)
			p := laoliVideoProduct("generic-video")
			p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "images"}
			r.a.Catalog.Models = []string{p.UpstreamModel}
			tc.change(&p)
			v, _ := Validate(&r.a, Draft{Revision: "malformed-video", Products: []Product{p}}, time.Now())
			requireVideoDiagnostic(t, v, tc.code, "UI_FIXABLE", tc.path)
			requireNoVideoDevelopmentDiagnostic(t, v)
		})
	}
}

func TestVideoUnsupportedReferenceFlowsStillNeedDevelopment(t *testing.T) {
	for _, tc := range []struct {
		profile, code, path string
		refs                References
	}{
		{"seedance", "VIDEO_REFERENCE_VIDEO_UNSUPPORTED", "video", References{Video: Range{Max: 1}, TotalMax: 1}},
		{"grok", "VIDEO_REFERENCE_IMAGE_UNSUPPORTED", "image", References{Image: Range{Max: 2}, TotalMax: 2}},
		{"grok", "VIDEO_REFERENCE_AUDIO_UNSUPPORTED", "audio", References{Audio: Range{Max: 1}, TotalMax: 1}},
	} {
		t.Run(tc.profile+"/"+tc.path, func(t *testing.T) {
			_, r := validatorFixture(t)
			p := laoliVideoProduct("generic-video")
			p.AdapterConfig = ImageConfig{Version: 1, WireProfile: tc.profile}
			p.Capabilities.References = tc.refs
			r.a.Catalog.Models = []string{p.UpstreamModel}
			v, offers := Validate(&r.a, Draft{Revision: "reference-flow", Products: []Product{p}}, time.Now())
			requireVideoDiagnostic(t, v, tc.code, "NEEDS_DEVELOPMENT", "capabilities.references."+tc.path)
			if v.PublishReady || len(offers) > 0 || hasCode(v, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT") {
				t.Fatalf("unsupported references must have one specific support cause: %+v", v.Diagnostics)
			}
		})
	}
}

func TestLaoliExplicitRatioCorrectionRestoresValidation(t *testing.T) {
	for _, model := range []string{"sd-native-full-2.0", "sd-native-full-2.5", "wan-3.0-video-ref", "wan-3.0-no-video-ref"} {
		t.Run(model, func(t *testing.T) {
			s, r := validatorFixture(t)
			r.a.BaseURL = "https://video.laoliimage2.win"
			r.a.Catalog.Models = []string{model}
			p := laoliVideoProduct(model)
			p.Capabilities.AspectRatios = nil
			saved, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			requireVideoDiagnostic(t, saved.Config.Validation, "VIDEO_RATIO_REQUIRED", "UI_FIXABLE", "capabilities.aspect_ratios")
			p = saved.Config.Draft.Products[0]
			p.Capabilities.AspectRatios = []string{"16:9"}
			saved, err = s.SaveDraft(t.Context(), 7, saved.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			if !saved.Config.Validation.PublishReady || saved.Config.Validation.Status != "PASS" {
				t.Fatalf("explicit operator correction did not restore supported flow: %+v", saved.Config.Validation.Diagnostics)
			}
			if saved.Config.Draft.Products[0].PricingRules[0].SalePrice.Amount != "1.00" || len(saved.Config.Validation.Previews) == 0 {
				t.Fatal("corrected draft lost price or did not compile real previews")
			}
		})
	}
}

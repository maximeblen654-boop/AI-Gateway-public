package mediaworkbench

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPublishedImageAspectRetainsFinalWireSize(t *testing.T) {
	_, repo, first := runtimeFixture(t)
	bound, err := ResolvePublishedImageOffer(&repo.a, first.Offer.OfferID, Spec{Resolution: "1K", AspectRatio: "16:9", Count: 1})
	must(t, err)
	plan, err := CompilePublishedImagePlan(bound, "synthetic", nil)
	must(t, err)
	var fields map[string]any
	must(t, json.Unmarshal(plan.MaterializeJSON(), &fields))
	if fields["size"] != "1536x864" || fields["n"] != float64(1) {
		t.Fatal(fields)
	}
	wire, width, height, err := ImageDimensions(bound.Offer.ResolvedConfig, bound.Spec)
	must(t, err)
	if wire != fields["size"] || width != 1536 || height != 864 {
		t.Fatal("delivery expectation diverges from final wire size")
	}
	t.Logf("spec=1K/16:9 count=1 final=%s expected_pixels=%dx%d", plan.MaterializeJSON(), width, height)
}

func TestImageMappingCannotDowngradeDeclaredSpec(t *testing.T) {
	for _, tc := range []struct{ name, resolution, ratio, wire string }{
		{"wrong_ratio", "1K", "16:9", "1024x1024"},
		{"fixed_to_auto", "1K", "1:1", "auto"},
		{"fixed_pixels_changed", "1024x1024", "1:1", "512x512"},
		{"oversized_pixel_label", "999999x999999", "1:1", "512x512"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := validatorFixture(t)
			p := validProduct()
			p.Capabilities.Resolutions = []string{tc.resolution}
			p.Capabilities.AspectRatios = []string{tc.ratio}
			p.AdapterConfig.SizeMappings = []SizeMapping{{tc.resolution, tc.ratio, tc.wire}}
			d, err := s.SaveDraft(context.Background(), 7, 1, DraftInput{Products: []Product{p}})
			must(t, err)
			if d.Config.Validation.PublishReady || !hasCode(d.Config.Validation, "IMAGE_SPEC_MAPPING_MISMATCH", "UI_FIXABLE") {
				t.Fatalf("misleading mapping accepted: status=%s diagnostics=%+v", d.Config.Validation.Status, d.Config.Validation.Diagnostics)
			}
			if _, err := compilePlan(p, Spec{Resolution: tc.resolution, AspectRatio: tc.ratio, Count: 1}); err == nil {
				t.Fatal("runtime compiler accepted misleading frozen mapping")
			}
		})
	}
}

func TestImageDimensionsAllowOnlyExplicitAutomaticSize(t *testing.T) {
	for _, m := range []SizeMapping{{"auto", "auto", "auto"}, {"1K", "16:9", "1536x864"}, {"1024x1024", "1:1", "1024x1024"}} {
		if _, _, err := validateImageMapping(m); err != nil {
			t.Fatal(m, err)
		}
	}
	for _, m := range []SizeMapping{{"auto", "16:9", "auto"}, {"1K", "", "auto"}, {"1K", "landscape", "1536x864"}} {
		if _, _, err := validateImageMapping(m); err == nil {
			t.Fatal("unverifiable specification accepted", m)
		}
	}
}

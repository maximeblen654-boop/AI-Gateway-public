package mediaworkbench

import (
	"testing"
	"time"
)

func TestImageGeometryWithoutProductMappings(t *testing.T) {
	for _, tc := range []struct{ resolution, ratio, size string }{
		{"1K", "1:1", ""}, {"2K", "3:2", ""}, {"4K", "16:9", ""},
		{"1024x1024", "1:1", "1024x1024"}, {"1536x1024", "3:2", "1536x1024"},
	} {
		for _, refs := range []int{0, 1} {
			p := validProduct()
			p.AdapterConfig.SizeMappings = nil
			spec := Spec{Resolution: tc.resolution, AspectRatio: tc.ratio, Count: 1, Images: refs}
			plan, err := compilePlan(p, spec)
			if err != nil {
				t.Fatalf("%+v refs=%d: %v", tc, refs, err)
			}
			if tc.size != "" {
				if plan.Fields["size"] != tc.size {
					t.Fatalf("pixel size lost: %+v", plan.Fields)
				}
			} else if plan.Fields["resolution"] != tc.resolution || plan.Fields["aspect_ratio"] != tc.ratio || plan.Fields["size"] != nil {
				t.Fatalf("native geometry lost: %+v", plan.Fields)
			}
		}
	}
}
func TestImageGeometryKeepsExplicitMapsAndPixelConsistency(t *testing.T) {
	p := validProduct()
	plan, err := compilePlan(p, Spec{Resolution: "1K", AspectRatio: "16:9", Count: 1})
	if err != nil || plan.Fields["size"] != "1536x864" || plan.Fields["resolution"] != nil {
		t.Fatalf("legacy mapping changed: %+v %v", plan, err)
	}
	p.AdapterConfig.SizeMappings = nil
	if _, err := compilePlan(p, Spec{Resolution: "1024x1024", AspectRatio: "16:9", Count: 1}); err == nil {
		t.Fatal("fixed pixels must not ignore conflicting ratio")
	}
	p.AdapterConfig.ModelFamily = "openai_images_oauth"
	if _, err := compilePlan(p, Spec{Resolution: "2K", AspectRatio: "16:9", Count: 1}); err == nil {
		t.Fatal("pixel-only OAuth must not invent K dimensions or drop fields")
	}
	plan, err = compilePlan(p, Spec{Resolution: "1536x1024", AspectRatio: "3:2", Count: 1})
	if err != nil || plan.Fields["size"] != "1536x1024" {
		t.Fatalf("exact pixels need no hand-written map: %+v %v", plan, err)
	}
}
func TestGeometryWithoutMapsPreviewAndFrozenExecutionAgree(t *testing.T) {
	_, repo := validatorFixture(t)
	p := validProduct()
	p.AdapterConfig.SizeMappings = nil
	p.Capabilities.Resolutions = []string{"1K", "2K", "4K"}
	p.Capabilities.AspectRatios = []string{"1:1", "3:2", "16:9"}
	v, offers := Validate(&repo.a, Draft{Revision: "geometry", Products: []Product{p}}, time.Now())
	if !v.PublishReady {
		t.Fatalf("no-map native contract blocked: %+v", v.Diagnostics)
	}
	if len(v.Previews) == 0 || len(offers) == 0 {
		t.Fatal("expected validated previews and offers")
	}
	for _, preview := range v.Previews {
		hits := 0
		for _, offer := range offers {
			if !offer.Matches(preview.Spec) {
				continue
			}
			hits++
			r := ResolvedImageOffer{Version: ImageBindingVersion, Offer: offer, Spec: preview.Spec, SpecHash: hash(preview.Spec)}
			refs := make([]string, preview.Spec.Images)
			for i := range refs {
				refs[i] = "data:image/png;base64,aQ=="
			}
			plan, err := CompilePublishedImagePlan(r, "same selected specs", refs)
			if err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"size", "resolution", "aspect_ratio"} {
				if plan.Fields[field] != preview.Fields[field] {
					t.Fatalf("%s differs between preview and execution", field)
				}
			}
		}
		if hits != 1 {
			t.Fatalf("expected one offer for preview, got %d", hits)
		}
	}
}

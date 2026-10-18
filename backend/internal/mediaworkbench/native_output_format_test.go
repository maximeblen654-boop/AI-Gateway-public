package mediaworkbench

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNativeFormatFrozenAndCompiled(t *testing.T) {
	s, r := validatorFixture(t)
	p := validProduct()
	p.Capabilities.OutputFormats = []string{"png", "jpeg", "webp"}
	d, e := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, e)
	d, e = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, e)
	_, e = s.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
	must(t, e)
	inspection, err := InspectPublishedOffers(context.Background(), &r.a, "image")
	must(t, err)
	if inspection.SpecCount != 80 {
		t.Fatalf("format variants not fully checked: %d", inspection.SpecCount)
	}
	for _, images := range []int{0, 1, 2} {
		for _, format := range []string{"", "png", "jpeg", "webp"} {
			spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1, Images: images, OutputFormat: format}
			offer := r.a.Config.Published.Offers[0]
			for _, o := range r.a.Config.Published.Offers {
				if o.Matches(spec) {
					offer = o
					break
				}
			}
			b, e := ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
			must(t, e)
			refs := make([]string, images)
			for i := range refs {
				refs[i] = "data:image/png;base64,aGVsbG8="
			}
			wire, e := CompilePublishedImagePlan(b, "test", refs)
			must(t, e)
			var fields map[string]any
			must(t, json.Unmarshal(wire.MaterializeJSON(), &fields))
			v, exists := fields["output_format"]
			if exists != (format != "") || exists && v != format {
				t.Fatal(format, fields)
			}
			want := "0.01"
			if images > 0 {
				want = "0.10"
			}
			if b.Offer.SalePrice.Amount != want {
				t.Fatal("format changed reference-mode price")
			}
			b.Spec.OutputFormat = "webp"
			if format == "webp" {
				b.Spec.OutputFormat = "png"
			}
			if _, e = CompilePublishedImagePlan(b, "test", refs); e == nil {
				t.Fatal("changed frozen format accepted")
			}
		}
	}
	for _, format := range []string{"gif", "jpg", "JPEG", " png", "auto"} {
		if _, _, e := NormalizeImageSpec(Spec{Count: 1, OutputFormat: format}); e == nil {
			t.Fatal(format)
		}
	}
}

func TestNativeFormatLegacyAndCapabilitySafety(t *testing.T) {
	_, _, b := runtimeFixture(t)
	raw, e := json.Marshal(b.Spec)
	must(t, e)
	if strings.Contains(string(raw), "output_format") {
		t.Fatal("legacy hash shape changed")
	}
	b.Spec.OutputFormat = "png"
	if b.Offer.Matches(b.Spec) {
		t.Fatal("unconfigured format accepted")
	}
	_, r := validatorFixture(t)
	for _, formats := range [][]string{{"gif"}, {"png", "png"}} {
		p := validProduct()
		p.Capabilities.OutputFormats = formats
		v, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
		if !hasCode(v, "OUTPUT_FORMAT_UNSUPPORTED", "UI_FIXABLE") {
			t.Fatal(v)
		}
	}
	p := validProduct()
	p.MediaType = "video"
	p.Capabilities.OutputFormats = []string{"png"}
	v, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
	if !hasCode(v, "OUTPUT_FORMAT_UNSUPPORTED", "UI_FIXABLE") {
		t.Fatal(v)
	}
	for _, kind := range []string{"grok_images", "gemini_images", "openai_images_oauth"} {
		o := b.Offer
		o.SpecMatch.OutputFormats = []string{"png"}
		o.Adapter.Kind = kind
		if o.Matches(b.Spec) {
			t.Fatal("unconfirmed native route accepted", kind)
		}
	}
}

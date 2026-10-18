package mediaworkbench

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestRatioSliderPreservesPublishedPrices(t *testing.T) {
	for _, priced := range []bool{false, true} {
		s, r := validatorFixture(t)
		p := validProduct()
		p.Capabilities.AspectRatioSlider = &AspectRatioSlider{Enabled: true, Mode: "discrete", Min: "1:1", Max: "16:9"}
		if priced {
			p.PricingRules = nil
			for i, ratio := range []string{"1:1", "16:9"} {
				for mode, rule := range validProduct().PricingRules {
					rule.Match.AspectRatio = []string{ratio}
					amount := []string{"0.01", "0.10", "0.02", "0.20"}[i*2+mode]
					rule.SalePrice = &Price{Amount: amount, Currency: "CNY", BillingMode: "per_request"}
					p.PricingRules = append(p.PricingRules, rule)
				}
			}
		}
		before, _ := json.Marshal(p.PricingRules)
		d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
		must(t, err)
		if d.Config.Validation.Status != "PASS" || d.Config.Validation.CaseCount != 20 {
			t.Fatalf("slider changed domain: %+v", d.Config.Validation)
		}
		d, err = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
		must(t, err)
		_, err = s.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
		must(t, err)
		after, _ := json.Marshal(r.a.Config.Published.Products[0].PricingRules)
		if string(before) != string(after) {
			t.Fatal("slider rewrote prices")
		}
		for _, ratio := range []string{"1:1", "16:9"} {
			for _, images := range []int{0, 1, 2} {
				spec := Spec{Resolution: "1K", AspectRatio: ratio, Count: 1, Images: images}
				hits := 0
				for _, offer := range r.a.Config.Published.Offers {
					if !offer.Matches(spec) {
						continue
					}
					hits++
					binding, err := ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
					must(t, err)
					want := "0.01"
					if images > 0 {
						want = "0.10"
					}
					if priced && ratio == "16:9" {
						if images > 0 {
							want = "0.20"
						} else {
							want = "0.02"
						}
					}
					if binding.Offer.SalePrice.Amount != want {
						t.Fatalf("ratio/mode price lost: %s %d %s", ratio, images, binding.Offer.SalePrice.Amount)
					}
					binding.Spec.AspectRatio = "4:3"
					if _, err := CompilePublishedImagePlan(binding, "test", nil); err == nil {
						t.Fatal("changed frozen ratio accepted")
					}
				}
				if hits != 1 {
					t.Fatalf("%d matches", hits)
				}
			}
		}
		for _, bad := range []string{"4:3", "9:16", "32:9", "0:1", "1.5:1"} {
			for _, offer := range r.a.Config.Published.Offers {
				if offer.Matches(Spec{Resolution: "1K", AspectRatio: bad, Count: 1}) {
					t.Fatal("unpublished ratio accepted", bad)
				}
			}
		}
	}
}

func TestRatioSliderRangeAndLegacySafety(t *testing.T) {
	if !ratioWithin("01:1", "01:1", "16:9") || ratioWithin("+1:1", "1:1", "16:9") {
		t.Fatal("numeric ratio identifiers must match the client without normalization")
	}
	_, r := validatorFixture(t)
	for _, config := range []*AspectRatioSlider{
		{true, "continuous", "1:1", "16:9"}, {true, "discrete", "1:1", "1:1"},
		{true, "discrete", "16:9", "1:1"}, {true, "discrete", "0:1", "16:9"},
		{true, "discrete", "1:2", "16:9"},
	} {
		p := validProduct()
		p.Capabilities.AspectRatioSlider = config
		v, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
		if !hasCode(v, "INVALID_RATIO_SLIDER", "UI_FIXABLE") {
			t.Fatalf("unsafe slider accepted: %+v", config)
		}
	}
	p := validProduct()
	p.Capabilities.AspectRatioSlider = &AspectRatioSlider{false, "discrete", "", ""}
	v, _ := Validate(&r.a, Draft{Revision: "test", Products: []Product{p}}, time.Now())
	if v.Status != "PASS" {
		t.Fatal(v)
	}
	for _, row := range [][3]string{{"1:2", "1:2", "16:9"}, {"1:1", "1:2", "16:9"}, {"16:9", "1:2", "16:9"}} {
		if !ratioWithin(row[0], row[1], row[2]) {
			t.Fatal(row)
		}
	}
	legacy, _ := json.Marshal(validProduct().Capabilities)
	var fields map[string]any
	must(t, json.Unmarshal(legacy, &fields))
	if _, found := fields["aspect_ratio_slider"]; found {
		t.Fatal("legacy serialization changed")
	}
}

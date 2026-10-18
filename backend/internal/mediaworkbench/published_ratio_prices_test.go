package mediaworkbench

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPublishedRatioSelectionPreservesPrices(t *testing.T) {
	for _, priced := range []bool{false, true} {
		s, r := validatorFixture(t)
		p := validProduct()
		p.Capabilities.AspectRatios = append(p.Capabilities.AspectRatios, "7:5")
		p.AdapterConfig.SizeMappings = append(p.AdapterConfig.SizeMappings, SizeMapping{"1K", "7:5", "1120x800"})
		if priced {
			p.PricingRules = nil
			for i, ratio := range []string{"1:1", "16:9", "7:5"} {
				for mode, rule := range validProduct().PricingRules {
					rule.Match.AspectRatio = []string{ratio}
					amount := []string{"0.01", "0.10", "0.02", "0.20", "0.03", "0.30"}[i*2+mode]
					rule.SalePrice = &Price{Amount: amount, Currency: "CNY", BillingMode: "per_request"}
					p.PricingRules = append(p.PricingRules, rule)
				}
			}
		}
		before, _ := json.Marshal(p.PricingRules)
		d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
		must(t, err)
		if d.Config.Validation.Status != "PASS" || d.Config.Validation.CaseCount != 30 {
			t.Fatalf("published ratio domain changed: %+v", d.Config.Validation)
		}
		d, err = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
		must(t, err)
		_, err = s.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
		must(t, err)
		after, _ := json.Marshal(r.a.Config.Published.Products[0].PricingRules)
		if string(before) != string(after) {
			t.Fatal("publication rewrote prices")
		}
		for _, ratio := range []string{"1:1", "16:9", "7:5"} {
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
					if priced && ratio == "7:5" {
						if images > 0 {
							want = "0.30"
						} else {
							want = "0.03"
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

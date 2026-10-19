package mediaworkbench

import (
	"fmt"
	"testing"
)

func TestVideoRetailSaveAndPublishWithoutProcurement(t *testing.T) {
	for _, withOldCost := range []bool{false, true} {
		t.Run(fmt.Sprint(withOldCost), func(t *testing.T) {
			s, r := fixture()
			r.a.BaseURL = "https://supplier.example/v1"
			r.a.Catalog.Models = []string{representativeUpstreamModel}
			p := representativeVideoProduct(&Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"})
			if !withOldCost {
				p.CostRules = nil
			}
			d, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
			must(t, err)
			if !d.Config.Validation.PublishReady || d.Config.Draft.Products[0].CostVersion != VideoRetailVersion || len(d.Config.Draft.Products[0].CostRules) != 0 {
				t.Fatalf("video retail draft: %+v", d.Config)
			}
			d, err = s.PublishSelected(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID})
			must(t, err)
			saved := d.Config.Published.Products[0]
			if saved.CostVersion != VideoRetailVersion || len(saved.CostRules) != 0 || len(d.Config.Published.Offers) != 1 || d.Config.Published.Offers[0].CostVersion != VideoRetailVersion || d.Config.Published.Offers[0].SalePrice.Amount != "2.50" {
				t.Fatal("published retail contract changed", d.Config.Published)
			}
		})
	}
}

func TestVideoGroupedRetailRulesRemainBounded(t *testing.T) {
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.Catalog.Models = []string{"configured-video"}
	p := Product{ProductID: "video", MediaType: "video", SiteModel: "video", UpstreamModel: "configured-video", Enabled: true,
		Capabilities: Capabilities{Resolutions: []string{"720p", "1080p", "2k", "4k"}, AspectRatios: []string{"16:9"}, Count: Range{Min: 1, Max: 1}}}
	for sec := 4; sec <= 30; sec++ {
		p.Capabilities.DurationsSeconds = append(p.Capabilities.DurationsSeconds, sec)
	}
	for _, resolution := range p.Capabilities.Resolutions {
		for _, sec := range p.Capabilities.DurationsSeconds {
			p.PricingRules = append(p.PricingRules, PricingRule{Match: Match{Resolution: []string{resolution}, DurationSeconds: []int{sec}}, SalePrice: &Price{Amount: fmt.Sprint(sec), Currency: "CNY", BillingMode: "per_request"}})
		}
	}
	d, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	must(t, err)
	if !d.Config.Validation.PublishReady || len(d.Config.Draft.Products[0].PricingRules) != 108 {
		t.Fatalf("normal grouped matrix rejected: %+v", d.Config.Validation)
	}
	p.PricingRules = make([]PricingRule, 1025)
	d, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	if d.Config.Validation.PublishReady || !hasCode(d.Config.Validation, "CONFIG_TOO_LARGE", "UI_FIXABLE") {
		t.Fatal("rule budget removed")
	}
}

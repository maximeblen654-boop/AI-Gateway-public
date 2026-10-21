package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestMediaRetailImageSaveAndPublishWithoutProcurement(t *testing.T) {
	for _, amount := range []string{"", "0", "-1", "0.123456789", "999"} {
		t.Run("old_cost_"+amount, func(t *testing.T) {
			s, r, _ := runtimeFixture(t)
			old := hash(r.a.Config.Published)
			p := validProduct()
			p.CostVersion = 999 // clients cannot select a cost contract
			p.CostRules[0].Cost.Amount = amount
			d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			if !d.Config.Validation.PublishReady || d.Config.Draft.Products[0].CostVersion != MediaRetailVersion || len(d.Config.Draft.Products[0].CostRules) != 0 {
				t.Fatal(d.Config.Validation.Diagnostics, d.Config.Draft.Products)
			}
			if hash(d.Config.Published) != old {
				t.Fatal("draft save mutated immutable publication")
			}
			if _, err := s.SaveDraft(context.Background(), 7, d.Config.RecordVersion-1, DraftInput{Products: []Product{p}}); !errors.Is(err, ErrStale) {
				t.Fatal("stale CAS admitted", err)
			}
			d, err = s.PublishSelected(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID})
			must(t, err)
			if d.Config.Published.Products[0].CostVersion != MediaRetailVersion || len(d.Config.Published.Products[0].CostRules) != 0 {
				t.Fatal("new publication retained procurement configuration")
			}
			for i, offer := range d.Config.Published.Offers {
				if offer.CostVersion != MediaRetailVersion || offer.SalePrice.Amount != p.PricingRules[i].SalePrice.Amount {
					t.Fatal("sale-only publication changed customer price", offer)
				}
			}
		})
	}
}

func TestMediaRetailIgnoresLegacyCostsAndKeepsSaleValidation(t *testing.T) {
	_, r := validatorFixture(t)
	p := validProduct()
	p.CostVersion = 1
	p.CostRules = []CostRule{{Cost: nil, Source: "obsolete"}, {Cost: &Price{Amount: "-3", Currency: "USD"}}}
	v, offers := Validate(&r.a, Draft{Revision: "legacy", Products: []Product{p}}, time.Now())
	if !v.PublishReady || len(offers) == 0 {
		t.Fatal(v.Diagnostics)
	}
	data, _ := json.Marshal(offers)
	if strings.Contains(string(data), "cost_rules") || strings.Contains(string(data), "obsolete") {
		t.Fatal("procurement leaked into customer offer")
	}
	p.PricingRules[0].SalePrice.Amount = "0"
	v, _ = Validate(&r.a, Draft{Revision: "invalid-sale", Products: []Product{p}}, time.Now())
	if v.PublishReady || !hasCode(v, "INVALID_PRICE", "UI_FIXABLE") {
		t.Fatal("cost removal weakened customer price validation", v.Diagnostics)
	}
}

func TestMediaRetailOldPublicationNotRewrittenForNewQuote(t *testing.T) {
	_, r, b := runtimeFixture(t)
	pub := r.a.Config.Published
	for i := range pub.Products {
		pub.Products[i].CostVersion = 1
		pub.Products[i].CostRules = []CostRule{{Cost: &Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}}}
	}
	for i := range pub.Offers {
		pub.Offers[i].CostVersion = 1
		pub.Offers[i].OfferID = ""
		pub.Offers[i].OfferID = "mw_offer_" + hash(pub.Offers[i])
	}
	pub.Revision = publishedRevision(pub)
	before := hash(pub)
	r.a.ModelMapping = map[string]string{"gpt-image-2": "api-only-other-model"}
	after, err := ResolvePublishedImageOffer(&r.a, pub.Offers[0].OfferID, b.Spec)
	must(t, err)
	expectedRevision, _ := offerSnapshot(&r.a, pub.Offers[0])
	if after.Offer.CostVersion != 1 || after.PublishedRevision != expectedRevision || before != hash(pub) {
		t.Fatal("reading old publication changed its identity")
	}
}

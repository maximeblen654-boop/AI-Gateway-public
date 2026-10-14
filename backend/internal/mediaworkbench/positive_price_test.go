package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestMediaPositiveRetailPriceDraftPublishAndRuntime(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		for _, amount := range []string{"", "0", "0.00000000", "0.01", "1", "9.9"} {
			t.Run(kind+"/"+amount, func(t *testing.T) {
				s, r := validatorFixture(t)
				p := validProduct()
				if kind == "video" {
					p = representativeVideoProduct(nil)
					r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
					r.a.Catalog.Models = []string{representativeUpstreamModel}
				}
				for i := range p.PricingRules {
					p.PricingRules[i].SalePrice = nil
					if amount != "" {
						p.PricingRules[i].SalePrice = &Price{amount, "CNY", "per_request"}
					}
				}
				d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
				must(t, err)
				raw, _ := json.Marshal(d.Config.Draft.Products)
				reread, err := s.Detail(context.Background(), 7)
				must(t, err)
				saved, _ := json.Marshal(reread.Config.Draft.Products)
				if string(raw) != string(saved) {
					t.Fatal("saved draft changed")
				}
				invalid := amount == "" || amount == "0" || amount == "0.00000000"
				if d.Config.Validation.PublishReady == invalid {
					t.Fatal(d.Config.Validation)
				}
				d, err = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
				if invalid {
					if !errors.Is(err, ErrValidation) || d.Config.Published != nil {
						t.Fatalf("invalid price published: %v", err)
					}
					code := "INVALID_PRICE"
					if amount == "" {
						code = "MISSING_PRICE"
					}
					if !hasCode(d.Config.Validation, code, "UI_FIXABLE") {
						t.Fatal(d.Config.Validation)
					}
					return
				}
				must(t, err)
				d, err = s.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
				must(t, err)
				offer := d.Config.Published.Offers[0]
				spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1}
				if kind == "video" {
					spec = Spec{Resolution: "720p", AspectRatio: "16:9", DurationSeconds: 5, Count: 1}
				}
				for _, candidate := range d.Config.Published.Offers {
					if candidate.Matches(spec) {
						offer = candidate
						break
					}
				}
				if kind == "image" {
					_, err = ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
				} else {
					_, err = ResolvePublishedVideoOffer(&r.a, offer.OfferID, spec)
				}
				must(t, err)
				// Structurally intact historical zero-price snapshots must not admit new requests.
				pub := r.a.Config.Published
				for i := range pub.Products {
					for j := range pub.Products[i].PricingRules {
						pub.Products[i].PricingRules[j].SalePrice.Amount = "0"
					}
				}
				for i := range pub.Offers {
					pub.Offers[i].SalePrice.Amount = "0"
				}
				pub.Revision = publishedRevision(pub)
				if kind == "image" {
					if PublishedImageOfferQuoteable(&r.a, offer.OfferID) {
						t.Fatal("zero image catalog entry")
					}
					_, err = ResolvePublishedImageOffer(&r.a, offer.OfferID, spec)
				} else {
					if len(PublishedVideoOffers(&r.a)) != 0 {
						t.Fatal("zero video catalog entry")
					}
					_, err = ResolvePublishedVideoOffer(&r.a, offer.OfferID, spec)
				}
				if !errors.Is(err, ErrRuntimeBinding) {
					t.Fatal("legacy zero binding admitted", err)
				}
				if pub.Offers[0].SalePrice.Amount != "0" {
					t.Fatal("silently repriced")
				}
			})
		}
	}
}
func TestHistoricalZeroReceiptArithmeticRemainsReadable(t *testing.T) {
	p := Price{"0", "CNY", "per_request"}
	if ValidateMediaSalePrice(p) == nil {
		t.Fatal("new free generation admitted")
	}
	_, total, err := PriceForQuantity(p, 3)
	must(t, err)
	if total.Amount != "0" {
		t.Fatal(total)
	}
}

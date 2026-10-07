package mediaworkbench

import (
	"context"
	"encoding/json"
	"testing"
)

func runtimeFixture(t *testing.T) (*Service, *memoryRepo, ResolvedImageOffer) {
	t.Helper()
	s, r := validatorFixture(t)
	ctx := context.Background()
	p := validProduct()
	for i := range p.PricingRules {
		p.PricingRules[i].SalePrice = &Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}
	}
	d, e := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{p}})
	must(t, e)
	d, e = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, e)
	_, e = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	must(t, e)
	bound, e := ResolvePublishedImageOffer(&r.a, r.a.Config.Published.Offers[0].OfferID, Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1})
	must(t, e)
	return s, r, bound
}
func TestPublishedImageRuntimeContract(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Account)
	}{
		{"sales_paused", func(a *Account) { a.Config.Sales.Enabled = false }},
		{"no_published", func(a *Account) { a.Config.Published = nil }},
		{"account_inactive", func(a *Account) { a.Status = "inactive" }},
		{"account_oauth", func(a *Account) { a.Type = "oauth" }},
		{"account_unschedulable", func(a *Account) { a.Schedulable = false }},
		{"runtime_not_ready", func(a *Account) { a.RuntimeReady = false }},
		{"catalog_drift", func(a *Account) { a.Catalog.Models = []string{"other"} }},
		{"base_drift", func(a *Account) { a.BaseURL = "https://changed.example/v1" }},
		{"mapping_drift", func(a *Account) { a.ModelMapping = map[string]string{"gpt-image-2": "other"} }},
		{"routing_drift", func(a *Account) { a.RoutingFingerprint = "changed" }},
		{"revision_tamper", func(a *Account) { a.Config.Published.Revision = "changed" }},
		{"price_tamper", func(a *Account) { a.Config.Published.Offers[0].SalePrice.Amount = "1.20" }},
		{"adapter_tamper", func(a *Account) { a.Config.Published.Offers[0].Adapter.Revision = "changed" }},
		{"unsupported_image2pro", func(a *Account) { a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "image2pro"} }},
		{"unsupported_async", func(a *Account) { a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "async"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, r, b := runtimeFixture(t)
			tc.mutate(&r.a)
			if _, err := ResolvePublishedImageOffer(&r.a, b.Offer.OfferID, b.Spec); err == nil {
				t.Fatal("drift admitted")
			}
		})
	}
	t.Run("Published_not_Draft_or_procurement", func(t *testing.T) {
		s, r, b := runtimeFixture(t)
		_, e := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{})
		must(t, e)
		r.a.Config.Procurement.Entries = []ProcurementEntry{{ProductID: "p", Cost: Price{Amount: "0.42", Currency: "CNY"}}}
		after, e := ResolvePublishedImageOffer(&r.a, b.Offer.OfferID, b.Spec)
		must(t, e)
		if after.Offer.SalePrice.Amount != "0.80" || after.PublishedRevision != b.PublishedRevision {
			t.Fatal("non-Published price influenced binding")
		}
	})
	t.Run("shared_materialization", func(t *testing.T) {
		_, _, b := runtimeFixture(t)
		p, e := CompilePublishedImagePlan(b, "actual prompt", nil)
		must(t, e)
		var fields map[string]any
		must(t, json.Unmarshal(p.MaterializeJSON(), &fields))
		if fields["model"] != b.Offer.UpstreamModel || fields["n"] != float64(b.Spec.Count) || fields["size"] != "1024x1024" || fields["prompt"] != "actual prompt" {
			t.Fatal(fields)
		}
		d, _ := Descriptor(b.Offer.Adapter.Kind)
		if b.Offer.Adapter.Revision != d.Revision {
			t.Fatal("contract split")
		}
	})
	for _, tc := range []struct {
		name string
		s    Spec
	}{
		{"count_zero", Spec{Count: 0}}, {"count_11", Spec{Count: 11}}, {"refs_negative", Spec{Count: 1, Images: -1}}, {"refs_17", Spec{Count: 1, Images: 17}},
		{"video", Spec{Count: 1, Videos: 1}}, {"audio", Spec{Count: 1, Audio: 1}}, {"duration", Spec{Count: 1, DurationSeconds: 1}}, {"whitespace", Spec{Count: 1, Resolution: " 1K"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, e := NormalizeImageSpec(tc.s); e == nil {
				t.Fatal("invalid spec normalized")
			}
		})
	}
	t.Run("different_spec_hash", func(t *testing.T) {
		_, _, a := NormalizeImageSpec(Spec{Count: 0})
		if a == nil {
			t.Fatal("count bound lost")
		}
		_, h1, _ := NormalizeImageSpec(Spec{Count: 1})
		_, h2, _ := NormalizeImageSpec(Spec{Count: 2})
		if h1 == h2 {
			t.Fatal("hash collision")
		}
	})
}

func TestImageDecimalCNYContract(t *testing.T) {
	for _, v := range []string{"0", "0.35", "0.35000000", "999999999999.99999999"} {
		t.Run("accept_"+v, func(t *testing.T) {
			if e := ValidateImageSalePrice(Price{v, "CNY", "per_request"}); e != nil {
				t.Fatal(e)
			}
		})
	}
	for _, v := range []string{"-1", "+1", "01", "1e-8", "NaN", "Inf", "0.350000001", "1000000000000", " 0.35", ".35", "1."} {
		t.Run("reject_"+v, func(t *testing.T) {
			if _, e := DecimalAmount(v); e == nil {
				t.Fatal("invalid amount admitted")
			}
		})
	}
	for _, currency := range []string{"USD", "", "EUR"} {
		t.Run("reject_currency_"+currency, func(t *testing.T) {
			if e := ValidateImageSalePrice(Price{"0.35", currency, "per_request"}); e == nil {
				t.Fatal("currency accepted")
			}
		})
	}
	if e := ValidateImageSalePrice(Price{"0.35", "CNY", "image"}); e == nil {
		t.Fatal("wrong billing mode accepted")
	}
}

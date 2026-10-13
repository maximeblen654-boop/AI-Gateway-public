package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func TestDraftOmissionRequiresExplicitRemoval(t *testing.T) {
	s, r := fixture()
	ctx := context.Background()
	d, err := s.SaveDraft(ctx, 7, 0, DraftInput{Products: []Product{{ProductID: "blank", MediaType: "image", UpstreamModel: "model-a"}}})
	must(t, err)
	writes := r.writes
	_, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{}})
	if err == nil || r.writes != writes {
		t.Fatal("unconfirmed omission silently removed a saved draft")
	}
}

func blankManagementProduct(id, kind string) Product {
	return Product{ProductID: id, MediaType: kind, SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Capabilities: Capabilities{Count: Range{1, 1}}}
}
func TestRemoveOneOfSixBlankDraftsPreservesBusinessState(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			s, r := validatorFixture(t)
			configured := validProduct()
			configured.MediaType = kind
			products := []Product{configured}
			for i := 1; i <= 6; i++ {
				products = append(products, blankManagementProduct(fmt.Sprintf("blank-%d", i), kind))
			}
			d, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: products})
			must(t, err)
			r.a.Config.Published = &Published{Revision: "frozen", Products: []Product{d.Config.Draft.Products[0]}, Offers: []Offer{{ProductID: "p", OfferID: "frozen-offer", SalePrice: Price{Amount: "0.70", Currency: "CNY"}}}}
			r.a.Config.Procurement.Entries = []ProcurementEntry{{ProductID: "p", Cost: Price{Amount: "0.20", Currency: "CNY"}}}
			published, _ := json.Marshal(r.a.Config.Published)
			procurement, _ := json.Marshal(r.a.Config.Procurement)
			first, _ := json.Marshal(d.Config.Draft.Products[0])
			for _, max := range []int{10, 1, 2} {
				input := DraftInput{Products: d.Config.Draft.Products}
				input.Products[1].AdapterConfig.Execution = &ImageExecutionConfig{Mode: "single", MaxOutputImages: max}
				d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, input)
				must(t, err)
				if len(d.Config.Draft.Products) != 7 {
					t.Fatal("ordinary edit changed product count")
				}
			}
			input := DraftInput{RemoveProductIDs: []string{"blank-3"}}
			for _, p := range d.Config.Draft.Products {
				if p.ProductID != "blank-3" {
					input.Products = append(input.Products, p)
				}
			}
			expected := d.Config.RecordVersion
			d, err = s.SaveDraft(ctx, 7, expected, input)
			must(t, err)
			if len(d.Config.Draft.Products) != 6 || len(d.Config.RemovedDraftProducts) != 1 || d.Config.RemovedDraftProducts[0].ProductID != "blank-3" {
				t.Fatal("wrong removed draft")
			}
			afterFirst, _ := json.Marshal(d.Config.Draft.Products[0])
			afterPublished, _ := json.Marshal(d.Config.Published)
			afterProcurement, _ := json.Marshal(d.Config.Procurement)
			if string(first) != string(afterFirst) || string(published) != string(afterPublished) || string(procurement) != string(afterProcurement) {
				t.Fatal("removal changed unrelated business state")
			}
			if _, err = s.SaveDraft(ctx, 7, expected, input); !errors.Is(err, ErrStale) {
				t.Fatal("duplicate save bypassed CAS")
			}
			loaded, err := s.Detail(ctx, 7)
			must(t, err)
			loadedJSON, _ := json.Marshal(loaded.Config)
			savedJSON, _ := json.Marshal(d.Config)
			if string(loadedJSON) != string(savedJSON) {
				t.Fatal("reread lost retained state")
			}
		})
	}
}
func TestDraftRemovalRejectsProtectedAndMalformedChanges(t *testing.T) {
	for _, scenario := range []string{"configured", "zero_price", "published_product", "published_offer", "procurement", "unknown", "duplicate", "still_present", "unconfirmed_extra", "recycle_removed_id"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			s, r := fixture()
			p := blankManagementProduct("blank", "image")
			d, err := s.SaveDraft(ctx, 7, 0, DraftInput{Products: []Product{p}})
			must(t, err)
			input := DraftInput{Products: []Product{}, RemoveProductIDs: []string{"blank"}}
			switch scenario {
			case "configured":
				r.a.Config.Draft.Products[0].Capabilities.Resolutions = []string{"1K"}
			case "zero_price":
				r.a.Config.Draft.Products[0].PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0", Currency: "CNY"}}}
			case "published_product":
				r.a.Config.Published = &Published{Products: []Product{p}}
			case "published_offer":
				r.a.Config.Published = &Published{Offers: []Offer{{ProductID: p.ProductID}}}
			case "procurement":
				r.a.Config.Procurement.Entries = []ProcurementEntry{{ProductID: p.ProductID}}
			case "unknown":
				input.RemoveProductIDs = append(input.RemoveProductIDs, "unknown")
			case "duplicate":
				input.RemoveProductIDs = append(input.RemoveProductIDs, "blank")
			case "still_present":
				input.Products = []Product{p}
			case "unconfirmed_extra":
				r.a.Config.Draft.Products = append(r.a.Config.Draft.Products, blankManagementProduct("other", "video"))
			case "recycle_removed_id":
				r.a.Config.RemovedDraftProducts = []Product{blankManagementProduct("retained", "image")}
				input.Products = []Product{blankManagementProduct("retained", "image")}
			}
			before, _ := json.Marshal(r.a)
			writes := r.writes
			_, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, input)
			after, _ := json.Marshal(r.a)
			if !errors.Is(err, ErrDraftRemoval) || writes != r.writes || string(before) != string(after) {
				t.Fatalf("unsafe removal %s: %v", scenario, err)
			}
		})
	}
}
func TestLastBlankCanBeRemovedAndFrozenImageBindingIsUnaffected(t *testing.T) {
	ctx := context.Background()
	s, r := fixture()
	d, err := s.SaveDraft(ctx, 7, 0, DraftInput{Products: []Product{blankManagementProduct("only", "video")}})
	must(t, err)
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{}, RemoveProductIDs: []string{"only"}})
	must(t, err)
	if len(d.Config.Draft.Products) != 0 || len(d.Config.RemovedDraftProducts) != 1 || d.Config.Sales.Enabled {
		t.Fatal("last blank removal changed sales")
	}
	s, r, frozen := runtimeFixture(t)
	d, err = s.SaveDraft(ctx, 7, r.a.Config.RecordVersion, DraftInput{Products: append(r.a.Config.Draft.Products, blankManagementProduct("blank", "image"))})
	must(t, err)
	_, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: d.Config.Draft.Products[:1], RemoveProductIDs: []string{"blank"}})
	must(t, err)
	resolved, err := ResolvePublishedImageOffer(&r.a, frozen.Offer.OfferID, frozen.Spec)
	must(t, err)
	if !reflect.DeepEqual(resolved, frozen) {
		t.Fatal("draft removal changed frozen offer or price")
	}
	beforePlan, err := CompilePublishedImagePlan(frozen, "same prompt", nil)
	must(t, err)
	afterPlan, err := CompilePublishedImagePlan(resolved, "same prompt", nil)
	must(t, err)
	if !reflect.DeepEqual(beforePlan, afterPlan) {
		t.Fatal("draft removal changed frozen execution")
	}
}

func TestBlankPricePlaceholderCanBeRemoved(t *testing.T) {
	p := blankManagementProduct("blank", "image")
	p.PricingRules = []PricingRule{{Match: Match{}, SalePrice: nil}}
	if !blankDraftProduct(p) {
		t.Fatal("unfilled default price row was treated as configured")
	}
	p.PricingRules[0].Match.Resolution = []string{"1K"}
	if blankDraftProduct(p) {
		t.Fatal("explicit price match was treated as blank")
	}
}

package service

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"testing"
	"time"
)

// Catalog-native model plus unrelated legacy aliases; only synthetic data.
func TestStudioQuoteCatalogModelAlongsideLegacyAliases(t *testing.T) {
	for _, refs := range []int{0, 1} {
		t.Run(map[int]string{0: "text", 1: "edit"}[refs], func(t *testing.T) {
			r, original, key, account, _ := studioContractFixture(t)
			account.a.Extra = nil
			account.a.Credentials["model_mapping"] = map[string]any{"legacy-image": "other-image"}
			ma := r.Media.(*studioMediaFixture)
			ma.a.ModelMapping = map[string]string{"legacy-image": "other-image"}
			svc := mediaworkbench.NewService(ma)
			p := ma.a.Config.Draft.Products[0]
			p.Capabilities.References = mediaworkbench.References{Image: mediaworkbench.Range{Min: 0, Max: 2}, TotalMax: 2}
			p.PricingRules[0].Match.References = &p.Capabilities.References
			saved, err := svc.SaveDraft(context.Background(), ma.a.ID, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
			if err != nil {
				t.Fatal(err)
			}
			published, err := svc.Publish(context.Background(), ma.a.ID, saved.Config.RecordVersion, saved.Config.Draft.Revision)
			if err != nil {
				t.Fatal(err)
			}
			_, err = svc.SetSales(context.Background(), ma.a.ID, published.Config.RecordVersion, true)
			if err != nil {
				t.Fatal(err)
			}
			spec := original.Binding.Spec
			spec.Images = refs
			token, err := r.Issue(context.Background(), original.Owner, key, ma.a.Config.Published.Offers[0].OfferID, spec, nil)
			if err != nil {
				t.Fatalf("published catalog model quote rejected: %v", err)
			}
			q, err := r.Store.Quote(token, original.Owner, time.Now())
			if err != nil || q.Binding.Offer.UpstreamModel != "gpt-image-2" {
				t.Fatalf("wrong identity: %v", err)
			}
		})
	}
}

func TestPublishedMediaModelGrantIsScoped(t *testing.T) {
	r, q, _, account, _ := studioContractFixture(t)
	_ = r
	a := account.a
	a.Credentials["model_mapping"] = map[string]any{"legacy": "other"}
	if accountSupportsRequestedModel(context.Background(), a, "gpt-image-2") {
		t.Fatal("ordinary API mapping allowlist bypassed")
	}
	ctx := withPublishedMediaModel(context.Background(), a, "gpt-image-2", "gpt-image-2")
	if !accountSupportsRequestedModel(ctx, a, "gpt-image-2") {
		t.Fatal("published catalog grant lost")
	}
	if accountSupportsRequestedModel(ctx, a, "unknown") {
		t.Fatal("grant leaked to another model")
	}
	other := *a
	other.ID++
	if accountSupportsRequestedModel(ctx, &other, q.Binding.Offer.SiteModel) {
		t.Fatal("grant leaked to another Account")
	}
	a.Credentials["model_mapping"] = map[string]any{"legacy": "changed"}
	if accountSupportsRequestedModel(ctx, a, "gpt-image-2") {
		t.Fatal("grant survived dependency drift")
	}
}

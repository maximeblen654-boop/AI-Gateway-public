package mediaworkbench

import (
	"context"
	"fmt"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSelectedPublishIgnoresUnconfiguredModelsAndIncompleteDraft(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	for len(a.Catalog.Models) < 53 {
		a.Catalog.Models = append(a.Catalog.Models, fmt.Sprintf("unconfigured-%d", len(a.Catalog.Models)))
	}
	old := a.Config.Published
	healthyOffer := old.Offers[0]
	for _, offer := range old.Offers {
		if offer.ProductID == "banana-product" {
			healthyOffer = offer
		}
	}
	specs, err := PublishedOfferSpecs(a, healthyOffer)
	require.NoError(t, err)
	bound, err := ResolvePublishedImageOffer(a, healthyOffer.OfferID, specs[0])
	require.NoError(t, err)
	half := validProduct()
	half.ProductID = "half-finished"
	half.UpstreamModel = "unconfigured-2"
	half.SiteModel = half.UpstreamModel
	half.PricingRules = nil
	draft := append(append([]Product{}, a.Config.Draft.Products...), half)
	draft[1].DisplayName = "Unfinished next edition"
	draft[1].PricingRules = nil
	d, err := s.SaveDraft(ctx, 7, a.Config.RecordVersion, DraftInput{Products: draft})
	require.NoError(t, err)
	require.False(t, d.Config.Validation.PublishReady)
	draftHash, validationHash := hash(d.Config.Draft), hash(d.Config.Validation)
	d, err = s.PublishSelected(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{draft[0].ProductID})
	require.NoError(t, err)
	require.True(t, d.PublishValidation.PublishReady)
	require.Equal(t, draftHash, hash(d.Config.Draft))
	require.Equal(t, validationHash, hash(d.Config.Validation))
	require.Len(t, d.Config.Published.Products, 2)
	require.Len(t, d.Config.Published.Offers, 2)
	require.Equal(t, old.Products[1], d.Config.Published.Products[0])
	again, err := ResolvePublishedImageOffer(a, healthyOffer.OfferID, specs[0])
	require.NoError(t, err)
	require.Equal(t, bound, again)
	require.True(t, d.EffectiveSales)
	states := map[string]ProductState{}
	for _, state := range d.ProductStates {
		states[state.ProductID] = state
	}
	require.True(t, states[healthyOffer.ProductID].PublishedReady)
	require.Equal(t, "NOT_PUBLISHED", states[half.ProductID].State)
	before := hash(a.Config)
	_, err = s.PublishSelected(ctx, 7, a.Config.RecordVersion, a.Config.Draft.Revision, []string{half.ProductID})
	require.ErrorIs(t, err, ErrValidation)
	require.Equal(t, before, hash(a.Config))
	for _, ids := range [][]string{{}, {"missing"}, {draft[0].ProductID, draft[0].ProductID}} {
		_, err = s.PublishSelected(ctx, 7, a.Config.RecordVersion, a.Config.Draft.Revision, ids)
		require.ErrorIs(t, err, ErrInvalid)
	}
	require.Equal(t, before, hash(a.Config))
	a.Catalog.Models = []string{healthyOffer.UpstreamModel}
	states = map[string]ProductState{}
	for _, state := range describe(a).ProductStates {
		states[state.ProductID] = state
	}
	require.True(t, states[healthyOffer.ProductID].PublishedReady)
	require.Equal(t, "UPSTREAM_REMOVED", states[draft[0].ProductID].State)
	require.True(t, describe(a).EffectiveSales)
}
func TestSelectedFirstPublishAndLegacySafety(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	products := append([]Product{}, a.Config.Draft.Products...)
	half := validProduct()
	half.ProductID = "half"
	half.PricingRules = nil
	a.Config.Published = nil
	d, err := s.SaveDraft(ctx, 7, a.Config.RecordVersion, DraftInput{Products: append(products, half)})
	require.NoError(t, err)
	d, err = s.PublishSelected(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{products[0].ProductID, products[1].ProductID})
	require.NoError(t, err)
	require.Len(t, d.Config.Published.Products, 2)
	require.False(t, d.Config.Validation.PublishReady)
	a.Config.Published.ProductDependencies = nil
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	before := hash(a.Config)
	_, err = s.PublishSelected(ctx, 7, a.Config.RecordVersion, a.Config.Draft.Revision, []string{products[0].ProductID})
	require.ErrorIs(t, err, ErrLegacyPublish)
	require.Equal(t, before, hash(a.Config))
	d, err = s.PublishSelected(ctx, 7, a.Config.RecordVersion, a.Config.Draft.Revision, []string{products[0].ProductID, products[1].ProductID})
	require.NoError(t, err)
	require.Len(t, d.Config.Published.ProductDependencies, 2)
}

func TestSelectedPublishDoesNotLabelUnselectedPriceAsPublished(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	products := append([]Product{}, a.Config.Draft.Products...)
	products[1].PricingRules = []PricingRule{{SalePrice: &Price{Amount: "9.99", Currency: "CNY", BillingMode: "per_request"}}}
	d, err := s.SaveDraft(ctx, 7, a.Config.RecordVersion, DraftInput{Products: products})
	require.NoError(t, err)
	require.True(t, d.Config.Validation.PublishReady)
	d, err = s.PublishSelected(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{products[0].ProductID})
	require.NoError(t, err)
	for _, model := range d.Models {
		if model.ModelID == products[1].UpstreamModel {
			require.Equal(t, "DRAFT", model.State)
		}
	}
	for _, product := range d.Config.Published.Products {
		if product.ProductID == products[1].ProductID {
			require.Equal(t, "0.01", product.PricingRules[0].SalePrice.Amount)
		}
	}
}

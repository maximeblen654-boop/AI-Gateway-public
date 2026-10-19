package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
)

func TestStudioVideoProductScopeIsolatesPublishedIdentity(t *testing.T) {
	base := mediaworkbench.Offer{AccountID: 77, ProductID: "product", MediaType: "video"}
	scope := studioVideoProductScope(base, "revision")
	require.Len(t, scope, 64)
	require.Equal(t, scope, studioVideoProductScope(base, "revision"))
	for _, tc := range []struct {
		name     string
		offer    mediaworkbench.Offer
		revision string
	}{
		{"account", mediaworkbench.Offer{AccountID: 78, ProductID: "product", MediaType: "video"}, "revision"},
		{"product", mediaworkbench.Offer{AccountID: 77, ProductID: "other", MediaType: "video"}, "revision"},
		{"published_revision", base, "next"},
		{"media_type", mediaworkbench.Offer{AccountID: 77, ProductID: "product", MediaType: "image"}, "revision"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NotEqual(t, scope, studioVideoProductScope(tc.offer, tc.revision))
		})
	}
	require.NotEqual(t, scope, studioImageProductScope(77, "product", "revision"), "image and video scopes must have separate domains")
	otherSpec := base
	otherSpec.OfferID = "different-offer"
	otherSpec.SpecMatch.DurationSeconds = []int{15}
	otherSpec.SalePrice = mediaworkbench.Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"}
	require.Equal(t, scope, studioVideoProductScope(otherSpec, "revision"), "offer specs and prices must remain inside the same product entry")
	// Structured identity must not confuse a separator inside a product ID with
	// a separator inside a published revision.
	base.ProductID = "one:two"
	otherSpec.ProductID = "one"
	require.NotEqual(t, studioVideoProductScope(base, "three"), studioVideoProductScope(otherSpec, "two:three"))
}

func TestVideoCatalogSharesProductScopeWithoutChangingOffers(t *testing.T) {
	r, key, _, product := wanQuoteFixture(t)
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		t.Fatal("catalog must not call the supplier")
		return nil, "", nil
	}
	media := studioCostMediaFixture(t, r.Media)
	product.PricingRules = []mediaworkbench.PricingRule{
		{Match: mediaworkbench.Match{DurationSeconds: []int{5}}, SalePrice: &mediaworkbench.Price{Amount: "1.50", Currency: "CNY", BillingMode: "per_request"}},
		{Match: mediaworkbench.Match{DurationSeconds: []int{10}}, SalePrice: &mediaworkbench.Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"}},
		{Match: mediaworkbench.Match{DurationSeconds: []int{15}}, SalePrice: &mediaworkbench.Price{Amount: "3.50", Currency: "CNY", BillingMode: "per_request"}},
	}
	svc := mediaworkbench.NewService(media)
	detail, err := svc.SaveDraft(t.Context(), 7, media.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
	require.NoError(t, err)
	detail, err = svc.Publish(t.Context(), 7, detail.Config.RecordVersion, detail.Config.Draft.Revision)
	require.NoError(t, err)
	require.Len(t, detail.Config.Published.Offers, 3)
	frozenBefore, err := json.Marshal(detail.Config.Published)
	require.NoError(t, err)
	owner := StudioImageOwner{UserID: 1, APIKeyID: 2, GroupID: 3}
	entries, err := r.Catalog(t.Context(), owner, key)
	require.NoError(t, err)
	require.Len(t, entries, 3)
	scope := entries[0].ProductScope
	require.Len(t, scope, 64)
	seen := map[string]bool{}
	for _, entry := range entries {
		require.Equal(t, scope, entry.ProductScope)
		require.Equal(t, product.ProductID, entry.ProductID)
		require.Equal(t, detail.Config.Published.Revision, entry.Revision)
		require.False(t, seen[entry.OfferID], "independent offers must retain unique identities")
		seen[entry.OfferID] = true
		var published *mediaworkbench.Offer
		for i := range detail.Config.Published.Offers {
			if detail.Config.Published.Offers[i].OfferID == entry.OfferID {
				published = &detail.Config.Published.Offers[i]
				break
			}
		}
		require.NotNil(t, published)
		require.Equal(t, studioVideoProductScope(*published, entry.Revision), entry.ProductScope)
		require.Equal(t, published.SpecMatch, entry.Spec)
		require.Equal(t, published.Excluded, entry.Excluded)
		require.Equal(t, published.SalePrice, entry.Price)
		require.Equal(t, "unavailable", entry.PassiveStatus.State, "no passive statistics must not remove a published offer")
	}
	frozenAfter, err := json.Marshal(media.a.Config.Published)
	require.NoError(t, err)
	require.JSONEq(t, string(frozenBefore), string(frozenAfter), "catalog must not rewrite frozen offers or prices")
}

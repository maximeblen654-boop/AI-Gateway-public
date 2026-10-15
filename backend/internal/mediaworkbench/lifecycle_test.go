package mediaworkbench

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func twoModelFixture(t *testing.T) (*Service, *memoryRepo) {
	s, r := validatorFixture(t)
	p := validProduct()
	p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.01", Currency: "CNY", BillingMode: "per_request"}}}
	q := validProduct()
	q.PricingRules = p.PricingRules
	q.ProductID = "banana-product"
	q.SiteModel = "Nano-banana-2.1"
	q.UpstreamModel = q.SiteModel
	r.a.Catalog.Models = append(r.a.Catalog.Models, q.UpstreamModel)
	d, e := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p, q}})
	require.NoError(t, e)
	d, e = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, e)
	_, e = s.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
	require.NoError(t, e)
	return s, r
}
func TestProductIsolationAndLifecycle(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	pub := a.Config.Published
	first, second := pub.Offers[0], pub.Offers[1]
	specs, e := PublishedOfferSpecs(a, first)
	require.NoError(t, e)
	spec := specs[0]
	original, e := ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.NoError(t, e)
	draft, validation, published := hash(a.Config.Draft), hash(a.Config.Validation), hash(pub)
	firstQuote, e := ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.NoError(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "archive"})
	require.Error(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "unlist"})
	require.NoError(t, e)
	_, e = ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.Error(t, e)
	other, e := ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.NoError(t, e)
	require.Equal(t, original, other)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "archive"})
	require.NoError(t, e)
	require.Equal(t, published, hash(a.Config.Published))
	require.Equal(t, draft, hash(a.Config.Draft))
	require.Equal(t, validation, hash(a.Config.Validation))
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "restore"})
	require.NoError(t, e)
	_, e = ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.Error(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "relist"})
	require.NoError(t, e)
	fresh, e := ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.NoError(t, e)
	require.NotEqual(t, firstQuote.PublishedRevision, fresh.PublishedRevision)
	// Missing GPT cannot alter the healthy sibling's frozen contract.
	a.Catalog.Models = []string{second.UpstreamModel}
	a.Catalog.SyncedAt = time.Now().Format(time.RFC3339)
	_, e = ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.Error(t, e)
	other, e = ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.NoError(t, e)
	require.Equal(t, original, other)
	inspection, e := InspectPublishedOffers(ctx, a, "image")
	require.NoError(t, e)
	require.Len(t, inspection.Offers, 2)
	require.Error(t, inspection.Offers[0].Err)
	require.NoError(t, inspection.Offers[1].Err)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "unlist"})
	require.NoError(t, e)
	a.Catalog.Models = append(a.Catalog.Models, first.UpstreamModel)
	_, e = ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.Error(t, e, "catalog restoration cannot relist")
	a.ModelMapping = map[string]string{first.SiteModel: "different"}
	other, e = ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.NoError(t, e)
	require.Equal(t, original, other)
	a.RuntimeReady = false
	_, e = ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.Error(t, e)
}
func TestArchiveConfiguredUnpublishedPreservesPublishedSibling(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	// A later populated draft is never included by single-product management.
	p := validProduct()
	p.ProductID = "new-draft"
	p.DisplayName = "Unpublished priced draft"
	d, e := s.SaveDraft(ctx, 7, a.Config.RecordVersion, DraftInput{Products: append(a.Config.Draft.Products, p)})
	require.NoError(t, e)
	before := hash(d.Config.Published)
	draft := hash(d.Config.Draft)
	validation := hash(d.Config.Validation)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: p.ProductID, Action: "archive"})
	require.NoError(t, e)
	require.Equal(t, before, hash(a.Config.Published))
	require.Equal(t, draft, hash(a.Config.Draft))
	require.Equal(t, validation, hash(a.Config.Validation))
	require.Equal(t, "archived", a.Config.ProductLifecycle[p.ProductID].State)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion-1, LifecycleInput{ProductID: p.ProductID, Action: "restore"})
	require.ErrorIs(t, e, ErrStale)
}
func TestUnconfiguredHideDoesNotChangeNativeCatalog(t *testing.T) {
	s, r := fixture()
	before := hash(r.a.Catalog)
	d, e := s.Lifecycle(context.Background(), 7, 0, LifecycleInput{ModelID: "model-a", Action: "hide"})
	require.NoError(t, e)
	require.Equal(t, before, hash(r.a.Catalog))
	require.Contains(t, d.Config.HiddenModels, "model-a")
	require.Empty(t, d.Config.Draft.Products)
	_, e = s.Lifecycle(context.Background(), 7, d.Config.RecordVersion, LifecycleInput{ModelID: "model-a", Action: "restore"})
	require.NoError(t, e)
	require.Empty(t, r.a.Config.HiddenModels)
	require.Nil(t, r.a.Config.Published)
}

func TestLegacyLifecycleDoesNotReviveQuoteOrArchiveSibling(t *testing.T) {
	s, r := twoModelFixture(t)
	a := &r.a
	a.Config.Published.ProductDependencies = nil
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	first, second := a.Config.Published.Offers[0], a.Config.Published.Offers[1]
	spec := Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1}
	before, e := ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.NoError(t, e)
	ctx := context.Background()
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "unlist"})
	require.NoError(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "relist"})
	require.NoError(t, e)
	after, e := ResolvePublishedImageOffer(a, first.OfferID, spec)
	require.NoError(t, e)
	require.NotEqual(t, before.PublishedRevision, after.PublishedRevision)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "unlist"})
	require.NoError(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: first.ProductID, Action: "archive"})
	require.NoError(t, e)
	_, e = ResolvePublishedImageOffer(a, second.OfferID, spec)
	require.NoError(t, e)
}

func TestHiddenConfiguredModelRestoresAndAmbiguousModelIsRejected(t *testing.T) {
	ctx := context.Background()
	s, r := twoModelFixture(t)
	a := &r.a
	model := a.Config.Draft.Products[0].UpstreamModel
	a.Config.HiddenModels = []string{model}
	_, e := s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ModelID: model, Action: "restore"})
	require.NoError(t, e)
	require.Empty(t, a.Config.HiddenModels)
	p := a.Config.Draft.Products[0]
	p.UpstreamModel = "changed-draft-model"
	a.Config.Draft.Products[0] = p
	before := hash(a.Config)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ModelID: model, Action: "unlist"})
	require.ErrorIs(t, e, ErrInvalid)
	require.Equal(t, before, hash(a.Config))
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: p.ProductID, Action: "unlist"})
	require.NoError(t, e)
}

func TestVideoProductsUseSameLifecycleIsolation(t *testing.T) {
	ctx := context.Background()
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.Catalog.Models = []string{representativeUpstreamModel, "other-video"}
	r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
	d, e := s.Initialize(ctx, 7, []string{"video"})
	require.NoError(t, e)
	p := representativeVideoProduct(&Price{Amount: "2.5", Currency: "CNY", BillingMode: "per_request"})
	q := p
	q.ProductID = "other-video-product"
	q.SiteModel = "other-video"
	q.UpstreamModel = q.SiteModel
	d, e = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{p, q}})
	require.NoError(t, e)
	d, e = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, e)
	_, e = s.SetSales(ctx, 7, d.Config.RecordVersion, true)
	require.NoError(t, e)
	a := &r.a
	var target, healthy Offer
	for _, o := range a.Config.Published.Offers {
		if o.ProductID == p.ProductID {
			target = o
		} else {
			healthy = o
		}
	}
	spec := Spec{Resolution: "720p", AspectRatio: "16:9", DurationSeconds: 5, Count: 1}
	before, e := ResolvePublishedVideoOffer(a, healthy.OfferID, spec)
	require.NoError(t, e)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: p.ProductID, Action: "unlist"})
	require.NoError(t, e)
	_, e = ResolvePublishedVideoOffer(a, target.OfferID, spec)
	require.Error(t, e)
	after, e := ResolvePublishedVideoOffer(a, healthy.OfferID, spec)
	require.NoError(t, e)
	require.Equal(t, before, after)
	_, e = s.Lifecycle(ctx, 7, a.Config.RecordVersion, LifecycleInput{ProductID: p.ProductID, Action: "archive"})
	require.NoError(t, e)
	a.Catalog.Models = []string{"other-video"}
	after, e = ResolvePublishedVideoOffer(a, healthy.OfferID, spec)
	require.NoError(t, e)
	require.Equal(t, before, after)
}

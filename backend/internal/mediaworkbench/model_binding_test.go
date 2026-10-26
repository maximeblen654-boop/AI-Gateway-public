package mediaworkbench

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func modelBindingFixture(t *testing.T) (*Service, *memoryRepo, ModelBindingInput) {
	t.Helper()
	s, r := twoModelFixture(t)
	r.a.Catalog.Source = "upstream"
	r.a.Catalog.AccountIdentitySHA256 = "fixture-catalog-owner"
	r.a.Catalog.Models = []string{"gpt-image-new", "Nano-banana-2.1"}
	return s, r, ModelBindingInput{ExpectedDraftRevision: r.a.Config.Draft.Revision, OldModelID: "gpt-image-2", NewModelID: "gpt-image-new", Action: "rebind", ProductIDs: []string{"p"}}
}

func bindingDraftProduct(t *testing.T, c *Config, id string) Product {
	t.Helper()
	for _, p := range c.Draft.Products {
		if p.ProductID == id {
			return p
		}
	}
	t.Fatalf("draft product %s missing", id)
	return Product{}
}

func TestModelBindingKeepsOriginalPublishedPriceAndDivergentDraft(t *testing.T) {
	s, r, input := modelBindingFixture(t)
	a := &r.a
	_, err := s.Lifecycle(t.Context(), 7, a.Config.RecordVersion, LifecycleInput{Action: "unlist", ProductID: "p"})
	require.NoError(t, err)
	copy, err := bindingCandidate(a)
	require.NoError(t, err)
	products := copy.Config.Draft.Products
	products[0].UpstreamModel = input.NewModelID
	products[0].PricingRules = []PricingRule{{SalePrice: &Price{Amount: "9.99", Currency: "CNY", BillingMode: "per_request"}}}
	products[1].PricingRules = nil // Unrelated unfinished work must not block repair.
	_, err = s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: products})
	require.NoError(t, err)
	input.ExpectedDraftRevision = a.Config.Draft.Revision
	oldVersion := a.Config.RecordVersion
	draft := bindingDraftProduct(t, a.Config, "p")
	otherDraft := bindingDraftProduct(t, a.Config, "banana-product")
	original, _ := publishedProduct(a, "p")
	other, _ := publishedProduct(a, "banana-product")
	otherOffers, otherDeps := productOffers(a, other.ProductID), a.Config.Published.ProductDependencies[other.ProductID]
	lifecycle, sales := hash(a.Config.ProductLifecycle), hash(a.Config.Sales)
	oldSource := a.Config.Published.SourceDraftRevision
	d, err := s.ModelBinding(t.Context(), 7, oldVersion, input)
	require.NoError(t, err)
	require.Equal(t, oldVersion+1, d.Config.RecordVersion)
	require.Equal(t, hash(draft), hash(bindingDraftProduct(t, d.Config, "p")))
	require.Equal(t, hash(otherDraft), hash(bindingDraftProduct(t, d.Config, "banana-product")))
	pub, ok := publishedProduct(a, "p")
	require.True(t, ok)
	require.Equal(t, input.NewModelID, pub.UpstreamModel)
	require.Equal(t, original.SiteModel, pub.SiteModel)
	require.Equal(t, original.ProductID, pub.ProductID)
	require.Equal(t, hash(original.Capabilities), hash(pub.Capabilities))
	require.Equal(t, hash(original.PricingRules), hash(pub.PricingRules))
	require.Equal(t, oldSource, d.Config.Published.SourceDraftRevision)
	gotOther, _ := publishedProduct(a, other.ProductID)
	require.Equal(t, other, gotOther)
	require.Equal(t, otherOffers, productOffers(a, other.ProductID))
	require.Equal(t, otherDeps, d.Config.Published.ProductDependencies[other.ProductID])
	require.Equal(t, lifecycle, hash(d.Config.ProductLifecycle))
	require.Equal(t, sales, hash(d.Config.Sales))
	require.False(t, d.Config.Validation.PublishReady, "unrelated unfinished draft stays unfinished")
	for _, o := range productOffers(a, "p") {
		require.Equal(t, input.NewModelID, o.UpstreamModel)
		require.Equal(t, "0.01", o.SalePrice.Amount)
	}
	_, err = s.SaveDraft(t.Context(), 7, oldVersion, DraftInput{Products: products})
	require.ErrorIs(t, err, ErrStale)
	d, err = s.Lifecycle(t.Context(), 7, d.Config.RecordVersion, LifecycleInput{Action: "relist", ProductID: "p"})
	require.NoError(t, err)
	require.True(t, publishedProductReady(t.Context(), &r.a, "p"))
	require.True(t, d.EffectiveSales)
}

func TestModelBindingRepairsOnlyExplicitProductsOnSameMissingModel(t *testing.T) {
	s, r := twoModelFixture(t)
	copy, err := bindingCandidate(&r.a)
	require.NoError(t, err)
	p := copy.Config.Draft.Products[0]
	p.ProductID, p.SiteModel = "same-model-sibling", "stable-customer-alias"
	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: append(copy.Config.Draft.Products, p)})
	require.NoError(t, err)
	_, err = s.PublishSelected(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID})
	require.NoError(t, err)
	r.a.Catalog.Source = "upstream"
	r.a.Catalog.AccountIdentitySHA256 = "fixture-catalog-owner"
	r.a.Catalog.Models = []string{"gpt-image-new", "Nano-banana-2.1"}
	other, _ := publishedProduct(&r.a, p.ProductID)
	otherOffers, deps := productOffers(&r.a, p.ProductID), r.a.Config.Published.ProductDependencies[p.ProductID]
	input := ModelBindingInput{ExpectedDraftRevision: r.a.Config.Draft.Revision, OldModelID: "gpt-image-2", NewModelID: "gpt-image-new", Action: "rebind", ProductIDs: []string{"p"}}
	_, err = s.ModelBinding(t.Context(), 7, r.a.Config.RecordVersion, input)
	require.NoError(t, err)
	got, _ := publishedProduct(&r.a, p.ProductID)
	require.Equal(t, other, got)
	require.Equal(t, otherOffers, productOffers(&r.a, p.ProductID))
	require.Equal(t, deps, r.a.Config.Published.ProductDependencies[p.ProductID])
	require.False(t, publishedProductReady(t.Context(), &r.a, p.ProductID))
}

func TestModelBindingDraftOnlyMayRemainIncompleteAndCannotPublishImplicitly(t *testing.T) {
	s, r := validatorFixture(t)
	p := validProduct()
	p.PricingRules = nil
	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	require.NoError(t, err)
	r.a.Catalog.Source = "upstream"
	r.a.Catalog.AccountIdentitySHA256 = "fixture-catalog-owner"
	r.a.Catalog.Models = []string{"gpt-image-new"}
	input := ModelBindingInput{ExpectedDraftRevision: d.Config.Draft.Revision, OldModelID: p.UpstreamModel, NewModelID: "gpt-image-new", Action: "rebind", ProductIDs: []string{p.ProductID}}
	d, err = s.ModelBinding(t.Context(), 7, d.Config.RecordVersion, input)
	require.NoError(t, err)
	require.Nil(t, d.Config.Published)
	require.False(t, d.Config.Validation.PublishReady)
	require.Equal(t, "gpt-image-new", d.Config.Draft.Products[0].UpstreamModel)
	require.Equal(t, p.SiteModel, d.Config.Draft.Products[0].SiteModel)
	require.Nil(t, d.Config.Draft.Products[0].PricingRules)
	before := hash(r.a.Config)
	d, err = s.Lifecycle(t.Context(), 7, d.Config.RecordVersion, LifecycleInput{Action: "relist", ProductID: p.ProductID})
	require.ErrorIs(t, err, ErrValidation)
	require.True(t, hasCode(*d.PublishValidation, "NOT_PUBLISHED", "UI_FIXABLE"))
	require.Equal(t, before, hash(r.a.Config))
}

func TestModelBindingRejectsInvalidStaleAndUntrustedInputWithoutWrites(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*memoryRepo, *ModelBindingInput, *int64)
		want   error
	}{
		{"empty new is not delete", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.NewModelID = "" }, ErrInvalid},
		{"same model", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.NewModelID = in.OldModelID }, ErrInvalid},
		{"duplicate products", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.ProductIDs = []string{"p", "p"} }, ErrInvalid},
		{"empty selection", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.ProductIDs = nil }, ErrInvalid},
		{"unknown product", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.ProductIDs = []string{"banana-product"} }, ErrValidation},
		{"unknown new", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.NewModelID = "not-discovered" }, ErrValidation},
		{"old is still present", func(r *memoryRepo, in *ModelBindingInput, _ *int64) {
			r.a.Catalog.Models = append(r.a.Catalog.Models, in.OldModelID)
		}, ErrValidation},
		{"stale record", func(_ *memoryRepo, _ *ModelBindingInput, v *int64) { *v-- }, ErrStale},
		{"stale draft", func(_ *memoryRepo, in *ModelBindingInput, _ *int64) { in.ExpectedDraftRevision = "old-draft" }, ErrStale},
		{"missing catalog", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog = nil }, ErrValidation},
		{"configured catalog", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog.Source = "configured" }, ErrValidation},
		{"missing timestamp", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog.SyncedAt = "" }, ErrValidation},
		{"missing catalog identity", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog.AccountIdentitySHA256 = "" }, ErrValidation},
		{"invalid timestamp", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog.SyncedAt = "yesterday" }, ErrValidation},
		{"empty catalog", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) { r.a.Catalog.Models = nil }, ErrValidation},
		{"invalid catalog identifier", func(r *memoryRepo, _ *ModelBindingInput, _ *int64) {
			r.a.Catalog.Models = append(r.a.Catalog.Models, " ")
		}, ErrValidation},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, in := modelBindingFixture(t)
			expected := r.a.Config.RecordVersion
			tc.change(r, &in, &expected)
			before, writes := hash(r.a.Config), r.writes
			d, err := s.ModelBinding(t.Context(), 7, expected, in)
			require.ErrorIs(t, err, tc.want)
			require.Equal(t, before, hash(r.a.Config))
			require.Equal(t, writes, r.writes)
			if errors.Is(err, ErrValidation) {
				require.NotNil(t, d.PublishValidation)
				require.False(t, d.PublishValidation.PublishReady)
				require.Equal(t, before, hash(d.Config), "error response retains persisted configuration")
			}
		})
	}
}

func TestModelBindingExplicitSelectionReplacesThirdModelDraftWithoutPublishingItsPrice(t *testing.T) {
	s, r, input := modelBindingFixture(t)
	a := &r.a
	a.Catalog.Models = append(a.Catalog.Models, "earlier-third-model-choice")
	copy, err := bindingCandidate(a)
	require.NoError(t, err)
	products := copy.Config.Draft.Products
	products[0].UpstreamModel = "earlier-third-model-choice"
	products[0].DisplayName = "Unpublished edited name"
	products[0].PricingRules = []PricingRule{{SalePrice: &Price{Amount: "9.99", Currency: "CNY", BillingMode: "per_request"}}}
	d, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: products})
	require.NoError(t, err)
	input.ExpectedDraftRevision = d.Config.Draft.Revision
	original, _ := publishedProduct(a, "p")
	expectedDraft := bindingDraftProduct(t, a.Config, "p")
	expectedDraft.UpstreamModel = input.NewModelID
	otherDraft := bindingDraftProduct(t, a.Config, "banana-product")
	otherPublished, _ := publishedProduct(a, otherDraft.ProductID)
	otherOffers := productOffers(a, otherDraft.ProductID)
	d, err = s.ModelBinding(t.Context(), 7, d.Config.RecordVersion, input)
	require.NoError(t, err)
	require.Equal(t, expectedDraft, bindingDraftProduct(t, d.Config, "p"))
	current, _ := publishedProduct(a, "p")
	require.Equal(t, input.NewModelID, current.UpstreamModel)
	require.Equal(t, original.SiteModel, current.SiteModel)
	require.Equal(t, original.DisplayName, current.DisplayName)
	require.Equal(t, original.Capabilities, current.Capabilities)
	require.Equal(t, original.PricingRules, current.PricingRules)
	for _, offer := range productOffers(a, "p") {
		require.Equal(t, "0.01", offer.SalePrice.Amount)
	}
	require.Equal(t, otherDraft, bindingDraftProduct(t, d.Config, otherDraft.ProductID))
	gotOther, _ := publishedProduct(a, otherDraft.ProductID)
	require.Equal(t, otherPublished, gotOther)
	require.Equal(t, otherOffers, productOffers(a, otherDraft.ProductID))
}

func TestModelBindingVideoCompatibilityFailureIsAtomicAndReportsCandidate(t *testing.T) {
	s, r, p := image2ProVideoFixture(t)
	d, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	require.NoError(t, err)
	d, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	newID := "new-incompatible-video"
	caps := r.a.Image2ProVideoCapabilities[p.UpstreamModel]
	caps.DurationMin, caps.DurationMax = 6, 8
	r.a.Image2ProVideoCapabilities[newID] = caps
	r.a.Catalog.Source = "upstream"
	r.a.Catalog.AccountIdentitySHA256 = "fixture-catalog-owner"
	r.a.Catalog.Models = []string{newID}
	before, writes := hash(r.a.Config), r.writes
	input := ModelBindingInput{ExpectedDraftRevision: d.Config.Draft.Revision, OldModelID: p.UpstreamModel, NewModelID: newID, Action: "rebind", ProductIDs: []string{p.ProductID}}
	d, err = s.ModelBinding(t.Context(), 7, d.Config.RecordVersion, input)
	require.ErrorIs(t, err, ErrValidation)
	require.Equal(t, before, hash(r.a.Config))
	require.Equal(t, before, hash(d.Config))
	require.Equal(t, writes, r.writes)
	require.True(t, hasCode(*d.PublishValidation, "VIDEO_DURATION_UNSUPPORTED", "UI_FIXABLE"))
	require.Len(t, d.BindingValidationProducts, 1)
	require.Equal(t, newID, d.BindingValidationProducts[0].UpstreamModel)
	require.Equal(t, 6, d.BindingValidationProducts[0].AdapterConfig.Image2Pro.DurationMin)
	require.Equal(t, p.Capabilities, d.BindingValidationProducts[0].Capabilities)
}

type bindingMutationRepo struct {
	*memoryRepo
	mutate func(*Account)
}

func (r *bindingMutationRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps Dependencies, c *Config) error {
	r.mu.Lock()
	r.mutate(&r.a)
	r.mu.Unlock()
	return r.memoryRepo.CompareAndSwapChecked(ctx, id, expected, deps, c)
}

func TestModelBindingCheckedCASRejectsCatalogRouteAndRecordRaces(t *testing.T) {
	for _, action := range []string{"rebind", "delete"} {
		for _, tc := range []struct {
			name   string
			mutate func(*Account)
		}{
			{"catalog", func(a *Account) { a.Catalog.Models = append(a.Catalog.Models, "concurrent-catalog-model") }},
			{"route", func(a *Account) { a.BaseURL = "https://changed.example/v1" }},
			{"record", func(a *Account) { a.Config.RecordVersion++ }},
		} {
			t.Run(action+"/"+tc.name, func(t *testing.T) {
				_, r, in := modelBindingFixture(t)
				in.Action = action
				if action == "delete" {
					in.NewModelID = ""
				}
				before, writes := hash(r.a.Config), r.writes
				expected := r.a.Config.RecordVersion
				s := NewService(&bindingMutationRepo{memoryRepo: r, mutate: tc.mutate})
				_, err := s.ModelBinding(t.Context(), 7, expected, in)
				require.ErrorIs(t, err, ErrStale)
				require.Equal(t, writes, r.writes)
				if tc.name == "record" {
					r.a.Config.RecordVersion-- // Compare the data after excluding the concurrent writer's version.
				}
				require.Equal(t, before, hash(r.a.Config))
			})
		}
	}
}

func TestModelBindingExplicitDeleteDoesNotRequireValidSpecsOrPrices(t *testing.T) {
	s, r, input := modelBindingFixture(t)
	a := &r.a
	other, _ := publishedProduct(a, "banana-product")
	otherDraft := bindingDraftProduct(t, a.Config, "banana-product")
	otherOffers, deps := productOffers(a, other.ProductID), a.Config.Published.ProductDependencies[other.ProductID]
	a.Config.ProductLifecycle = map[string]ProductLifecycle{"p": {State: "archived", Revision: 3}, other.ProductID: {State: "unlisted", Revision: 1}}
	a.Config.Procurement = Procurement{Revision: 4, Entries: []ProcurementEntry{{ProductID: "p", Source: "selected"}, {ProductID: other.ProductID, Source: "retained"}}}
	a.Config.RemovedDraftProducts = []Product{{ProductID: "p"}, {ProductID: "retained-blank"}}
	a.Config.Draft.Products[0].PricingRules = nil
	a.Config.Draft.Products[0].Capabilities = Capabilities{}
	a.Config.Published.Products[0].PricingRules = nil
	a.Config.Published.Products[0].Capabilities = Capabilities{}
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	beforeSales, otherLifecycle := hash(a.Config.Sales), a.Config.ProductLifecycle[other.ProductID]
	oldVersion := a.Config.RecordVersion
	input.Action, input.NewModelID = "delete", ""
	d, err := s.ModelBinding(t.Context(), 7, oldVersion, input)
	require.NoError(t, err)
	require.Len(t, d.Config.Draft.Products, 1)
	require.Equal(t, otherDraft, d.Config.Draft.Products[0])
	require.Len(t, d.Config.Published.Products, 1)
	require.Equal(t, other, d.Config.Published.Products[0])
	require.Equal(t, otherOffers, d.Config.Published.Offers)
	require.Equal(t, deps, d.Config.Published.ProductDependencies[other.ProductID])
	require.NotContains(t, d.Config.Published.ProductDependencies, "p")
	require.NotContains(t, d.Config.ProductLifecycle, "p")
	require.Equal(t, otherLifecycle, d.Config.ProductLifecycle[other.ProductID])
	require.Equal(t, []ProcurementEntry{{ProductID: other.ProductID, Source: "retained"}}, d.Config.Procurement.Entries)
	require.Equal(t, int64(5), d.Config.Procurement.Revision)
	require.Equal(t, []Product{{ProductID: "retained-blank"}}, d.Config.RemovedDraftProducts)
	require.Equal(t, beforeSales, hash(d.Config.Sales))
	before := hash(a.Config)
	_, err = s.ModelBinding(t.Context(), 7, oldVersion, input)
	require.ErrorIs(t, err, ErrStale)
	require.Equal(t, before, hash(a.Config))
}

func TestModelBindingDeletePreservesLegacySiblingWithoutGrantingCurrentDependencies(t *testing.T) {
	s, r, input := modelBindingFixture(t)
	pub := r.a.Config.Published
	pub.ProductDependencies = nil
	pub.Products[1].PricingRules = nil // Deletion cannot require a sibling's specifications or prices to pass.
	pub.Revision = publishedRevision(pub)
	other, _ := publishedProduct(&r.a, "banana-product")
	offers, dependencies := productOffers(&r.a, other.ProductID), pub.Dependencies
	input.Action, input.NewModelID = "delete", ""
	d, err := s.ModelBinding(t.Context(), 7, r.a.Config.RecordVersion, input)
	require.NoError(t, err)
	require.Equal(t, []Product{other}, d.Config.Published.Products)
	require.Equal(t, offers, d.Config.Published.Offers)
	require.Equal(t, dependencies, d.Config.Published.Dependencies)
	require.Empty(t, d.Config.Published.ProductDependencies)
	require.False(t, publishedProductReady(t.Context(), &r.a, other.ProductID))
}

func TestModelBindingLegacySiblingsRequireOriginalContractValidation(t *testing.T) {
	for _, valid := range []bool{true, false} {
		t.Run(map[bool]string{true: "verified original sibling", false: "invalid original sibling"}[valid], func(t *testing.T) {
			s, r, input := modelBindingFixture(t)
			pub := r.a.Config.Published
			pub.ProductDependencies = nil
			if !valid {
				pub.Products[1].PricingRules = nil
			}
			pub.Revision = publishedRevision(pub)
			other, _ := publishedProduct(&r.a, "banana-product")
			otherOffers := productOffers(&r.a, other.ProductID)
			d, err := s.ModelBinding(t.Context(), 7, r.a.Config.RecordVersion, input)
			require.NoError(t, err)
			require.Equal(t, other, d.Config.Published.Products[1])
			require.Equal(t, otherOffers, productOffers(&r.a, other.ProductID))
			if valid {
				require.Equal(t, productDependencies(&r.a, other), d.Config.Published.ProductDependencies[other.ProductID])
				require.True(t, publishedProductReady(t.Context(), &r.a, other.ProductID))
			} else {
				require.NotContains(t, d.Config.Published.ProductDependencies, other.ProductID)
				require.False(t, publishedProductReady(t.Context(), &r.a, other.ProductID))
			}
		})
	}
}

func TestModelBindingLegacyMissingSiblingsCanBeRepairedIndependently(t *testing.T) {
	s, r, first := modelBindingFixture(t)
	a := &r.a
	pub := a.Config.Published
	// Exercise the oldest shared snapshot and v0 binding contract together.
	a.Catalog.Models = []string{"gpt-image-2", "Nano-banana-2.1"}
	for i, p := range pub.Products {
		p.CostVersion = 0
		pub.Products[i], a.Config.Draft.Products[i] = p, p
	}
	v, oldOffers := validateBindingProducts(t.Context(), a, pub.Products, pub.SourceDraftRevision, pub.PublishedAt)
	require.True(t, v.PublishReady, v.Diagnostics)
	pub.Offers = oldOffers
	pub.Dependencies = dependenciesForProducts(a, pub.Products)
	pub.ProductDependencies = nil
	pub.Revision = publishedRevision(pub)
	a.Catalog.Models = []string{first.NewModelID, "replacement-banana"}
	originalSecond, _ := publishedProduct(a, "banana-product")
	originalSecondOffers := productOffers(a, originalSecond.ProductID)
	d, err := s.ModelBinding(t.Context(), 7, a.Config.RecordVersion, first)
	require.NoError(t, err)
	require.True(t, publishedProductReady(t.Context(), a, "p"))
	second, _ := publishedProduct(a, originalSecond.ProductID)
	require.Equal(t, originalSecond, second)
	require.Equal(t, originalSecondOffers, productOffers(a, second.ProductID))
	require.NotContains(t, d.Config.Published.ProductDependencies, second.ProductID)
	require.False(t, publishedProductReady(t.Context(), a, second.ProductID))
	firstProduct, _ := publishedProduct(a, "p")
	firstOffers, firstDependencies := productOffers(a, "p"), d.Config.Published.ProductDependencies["p"]
	secondInput := ModelBindingInput{ExpectedDraftRevision: d.Config.Draft.Revision, OldModelID: second.UpstreamModel, NewModelID: "replacement-banana", Action: "rebind", ProductIDs: []string{second.ProductID}}
	d, err = s.ModelBinding(t.Context(), 7, d.Config.RecordVersion, secondInput)
	require.NoError(t, err)
	require.True(t, publishedProductReady(t.Context(), a, "p"))
	require.True(t, publishedProductReady(t.Context(), a, second.ProductID))
	gotFirst, _ := publishedProduct(a, "p")
	require.Equal(t, firstProduct, gotFirst)
	require.Equal(t, firstOffers, productOffers(a, "p"))
	require.Equal(t, firstDependencies, d.Config.Published.ProductDependencies["p"])
	gotSecond, _ := publishedProduct(a, second.ProductID)
	require.Equal(t, secondInput.NewModelID, gotSecond.UpstreamModel)
	require.Equal(t, originalSecond.SiteModel, gotSecond.SiteModel)
	require.Equal(t, originalSecond.Capabilities, gotSecond.Capabilities)
	require.Equal(t, originalSecond.PricingRules, gotSecond.PricingRules)
}

func TestModelBindingV0PublishedAliasAdoptsDirectContractWithoutChangingNativeMapping(t *testing.T) {
	s, r := twoModelFixture(t)
	a := &r.a
	a.Catalog.Source = "upstream"
	a.Catalog.AccountIdentitySHA256 = "fixture-catalog-owner"
	a.ModelMapping = map[string]string{"customer-legacy-alias": "gpt-image-2"}
	pub := a.Config.Published
	for i, p := range pub.Products {
		if p.ProductID == "p" {
			p.SiteModel = "customer-legacy-alias"
			p.CostVersion = 0
			p.CostRules = []CostRule{{Cost: &Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "historical"}}
			pub.Products[i], a.Config.Draft.Products[0] = p, p
		}
	}
	v, offers := validateBindingProducts(t.Context(), a, pub.Products, pub.SourceDraftRevision, pub.PublishedAt)
	require.True(t, v.PublishReady, v.Diagnostics)
	pub.Offers = offers
	pub.Dependencies = dependenciesForProducts(a, pub.Products)
	pub.ProductDependencies = nil
	pub.Revision = publishedRevision(pub)
	original, _ := publishedProduct(a, "p")
	other, _ := publishedProduct(a, "banana-product")
	otherOffers, mapping := productOffers(a, other.ProductID), hash(a.ModelMapping)
	a.Catalog.Models = []string{"gpt-image-new", "Nano-banana-2.1"}
	in := ModelBindingInput{ExpectedDraftRevision: a.Config.Draft.Revision, OldModelID: "gpt-image-2", NewModelID: "gpt-image-new", Action: "rebind", ProductIDs: []string{"p"}}
	d, err := s.ModelBinding(t.Context(), 7, a.Config.RecordVersion, in)
	require.NoError(t, err)
	current, _ := publishedProduct(a, "p")
	require.Equal(t, "customer-legacy-alias", current.SiteModel)
	require.Equal(t, "p", current.ProductID)
	require.Equal(t, "gpt-image-new", current.UpstreamModel)
	require.Equal(t, MediaRetailVersion, current.CostVersion)
	require.Empty(t, current.CostRules)
	require.Equal(t, original.Capabilities, current.Capabilities)
	require.Equal(t, original.PricingRules, current.PricingRules)
	require.Equal(t, mapping, hash(a.ModelMapping))
	require.True(t, publishedProductReady(t.Context(), a, "p"))
	require.Equal(t, other, d.Config.Published.Products[1])
	require.Equal(t, otherOffers, productOffers(a, other.ProductID))
	require.Equal(t, 0, original.CostVersion, "the original immutable snapshot is preserved")
	require.Equal(t, "gpt-image-2", original.UpstreamModel)
}

func TestMissingModelStatusPrecedesLegacyDependencies(t *testing.T) {
	_, r, _ := modelBindingFixture(t)
	r.a.Config.Published.ProductDependencies = nil
	r.a.Config.Published.Revision = publishedRevision(r.a.Config.Published)
	for _, state := range describe(&r.a).ProductStates {
		if state.ProductID == "p" {
			require.Equal(t, "UPSTREAM_REMOVED", state.State)
			require.False(t, state.PublishedReady)
			return
		}
	}
	t.Fatal("missing product state")
}

func TestHistoricalLifecycleStatusPrecedesMissingModel(t *testing.T) {
	for _, lifecycle := range []struct{ state, want string }{{"archived", "ARCHIVED"}, {"unlisted", "UNLISTED"}} {
		for _, draft := range []string{"absent", "new-model"} {
			t.Run(lifecycle.state+"/"+draft, func(t *testing.T) {
				_, r, _ := modelBindingFixture(t)
				r.a.Config.Published.ProductDependencies = nil
				r.a.Config.Published.Revision = publishedRevision(r.a.Config.Published)
				r.a.Config.ProductLifecycle = map[string]ProductLifecycle{"p": {State: lifecycle.state, Revision: 1, UpdatedAt: time.Now().UTC()}}
				if draft == "absent" {
					r.a.Config.Draft.Products = r.a.Config.Draft.Products[1:]
				} else {
					r.a.Config.Draft.Products[0].UpstreamModel = "gpt-image-new"
				}
				for _, state := range describe(&r.a).ProductStates {
					if state.ProductID == "p" {
						require.Equal(t, lifecycle.want, state.State)
						require.NotEqual(t, "UPSTREAM_REMOVED", state.State, "a historical lifecycle snapshot must not become an affected active product")
						require.False(t, state.PublishedReady)
						return
					}
				}
				t.Fatal("historical product state missing")
			})
		}
	}
}

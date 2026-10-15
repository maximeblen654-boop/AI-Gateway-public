package mediaworkbench

import (
	"context"
	"slices"
)

// Product dependencies scope canonical mapping and adapter to the actual sold
// contract. Account routing/auth and registry remain mandatory shared boundaries.
func productDependencies(a *Account, p Product) Dependencies {
	d := dependenciesForProducts(a, []Product{p})
	mapped, matched, catalog := resolveAccountModel(a, p.SiteModel)
	d.MappingSHA256 = hash([]any{p.SiteModel, mapped, matched, catalog})
	d.BindingSHA256 = hash(bindingsFor(a, []string{p.MediaType}))
	return d
}
func snapshotProductDependencies(a *Account, products []Product) map[string]Dependencies {
	out := map[string]Dependencies{}
	for _, p := range products {
		if p.Enabled {
			out[p.ProductID] = productDependencies(a, p)
		}
	}
	return out
}
func publishedEnvelopeReady(a *Account) bool {
	if a == nil || !SupportsAccount(a) || a.Status != "active" || !a.Schedulable || !a.RuntimeReady || a.Config == nil || a.Catalog == nil || a.Catalog.SyncedAt == "" {
		return false
	}
	p := a.Config.Published
	return p != nil && len(p.Offers) > 0 && p.Revision == publishedRevision(p)
}
func publishedProduct(a *Account, id string) (Product, bool) {
	if a == nil || a.Config == nil || a.Config.Published == nil {
		return Product{}, false
	}
	for _, p := range a.Config.Published.Products {
		if p.ProductID == id {
			return p, true
		}
	}
	return Product{}, false
}
func productActive(a *Account, id string) bool {
	state := a.Config.ProductLifecycle[id].State
	return state == "" || state == "active"
}
func productOffers(a *Account, id string) []Offer {
	out := []Offer{}
	for _, o := range a.Config.Published.Offers {
		if o.ProductID == id {
			out = append(out, o)
		}
	}
	return out
}
func productDependencyReady(a *Account, id string) bool {
	if !publishedEnvelopeReady(a) || !productActive(a, id) {
		return false
	}
	p, ok := publishedProduct(a, id)
	if !ok || !p.Enabled || !slices.Contains(a.Catalog.Models, p.UpstreamModel) {
		return false
	}
	deps := a.Config.Published.ProductDependencies
	if len(deps) == 0 {
		return a.Config.Published.Dependencies == PublishedDependenciesFor(a)
	}
	expected, ok := deps[id]
	return ok && expected == productDependencies(a, p)
}
func publishedProductReady(ctx context.Context, a *Account, id string) bool {
	if !productDependencyReady(a, id) {
		return false
	}
	if len(a.Config.Published.ProductDependencies) == 0 {
		return legacyPublishedReady(ctx, a)
	}
	p, _ := publishedProduct(a, id)
	v, offers := validateContext(ctx, a, Draft{Revision: a.Config.Published.SourceDraftRevision, Products: []Product{p}}, a.Config.Published.PublishedAt)
	return v.PublishReady && hash(offers) == hash(productOffers(a, id))
}
func publishedOfferReady(ctx context.Context, a *Account, id string) bool {
	if a == nil || a.Config == nil || a.Config.Published == nil {
		return false
	}
	for _, o := range a.Config.Published.Offers {
		if o.OfferID == id {
			return publishedProductReady(ctx, a, o.ProductID)
		}
	}
	return false
}

// PublishedOfferIdentity is a cheap current dependency identity. It is NOT a
// validation grant: preflight validates all specs, and quotes compile natively.
func PublishedOfferIdentity(a *Account, id string) (string, bool) {
	if a == nil || a.Config == nil || a.Config.Published == nil || !a.Config.Sales.Enabled {
		return "", false
	}
	for _, o := range a.Config.Published.Offers {
		if o.OfferID != id {
			continue
		}
		if !productDependencyReady(a, o.ProductID) {
			return "", false
		}
		p, _ := publishedProduct(a, o.ProductID)
		_, deps := offerSnapshot(a, o)
		return hash([]any{p, o, deps}), true
	}
	return "", false
}
func offerSnapshot(a *Account, o Offer) (string, Dependencies) {
	pub := a.Config.Published
	deps, ok := pub.ProductDependencies[o.ProductID]
	if !ok {
		if revision := a.Config.ProductLifecycle[o.ProductID].Revision; revision > 0 {
			return "mwp_product_" + hash([]any{pub.Revision, o.ProductID, revision}), pub.Dependencies
		}
		return pub.Revision, pub.Dependencies
	}
	p, _ := publishedProduct(a, o.ProductID)
	return "mwp_product_" + hash([]any{p, productOffers(a, o.ProductID), deps, a.Config.ProductLifecycle[o.ProductID].Revision}), deps
}

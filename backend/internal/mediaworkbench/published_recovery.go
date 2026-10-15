package mediaworkbench

import (
	"context"
	"time"
)

// RevalidatePublishedCatalog prepares a replacement from the original published
// products ONLY. It performs no writes. The maintenance caller must lock/CAS the
// original full Account, back it up, and preserve Draft/Validation verbatim.
func RevalidatePublishedCatalog(ctx context.Context, a *Account, now time.Time) (*Published, PublishedInspection, error) {
	var empty PublishedInspection
	if a == nil || a.ID != 77 || a.Config == nil || a.Config.Published == nil {
		return nil, empty, ErrInvalid
	}
	old := a.Config.Published
	if old.Revision != publishedRevision(old) {
		return nil, empty, ErrStale
	}
	expected, current := old.Dependencies, DependenciesFor(a)
	// This narrowly scoped operation cannot approve a mapping, route, binding or
	// registry change. Catalog changes must still pass the full native validator.
	expected.CatalogSHA256 = current.CatalogSHA256
	if expected != current {
		return nil, empty, ErrStale
	}
	for _, p := range old.Products {
		if p.MediaType != "image" || p.UpstreamModel != "gpt-image-2" {
			return nil, empty, ErrInvalid
		}
	}
	if len(old.Products) != 1 {
		return nil, empty, ErrInvalid
	}
	d := Draft{Revision: old.SourceDraftRevision, Products: old.Products}
	v, offers := validateContext(ctx, a, d, now)
	if !v.PublishReady || hash(offers) != hash(old.Offers) {
		return nil, empty, ErrValidation
	}
	next := *old
	next.Dependencies = dependenciesForProducts(a, old.Products)
	next.PublishedAt = now
	next.Revision = publishedRevision(&next)
	candidate := *a
	config := *a.Config
	config.Published = &next
	candidate.Config = &config
	inspection, err := InspectPublishedOffers(ctx, &candidate, "image")
	if err != nil {
		return nil, inspection, err
	}
	for _, offer := range inspection.Offers {
		if offer.Err != nil {
			return nil, inspection, offer.Err
		}
	}
	return &next, inspection, nil
}

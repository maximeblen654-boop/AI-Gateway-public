package mediaworkbench

import (
	"context"
	"time"
)

// PublishSelected validates exactly the saved products named by the administrator.
// Unselected drafts and published contracts are preserved, including their grants.
func (s *Service) PublishSelected(ctx context.Context, id, expected int64, revision string, ids []string) (*Detail, error) {
	a, err := s.mutable(ctx, id, expected)
	if err != nil {
		return nil, err
	}
	if revision == "" || len(ids) == 0 || len(ids) > len(a.Config.Draft.Products) {
		return nil, ErrInvalid
	}
	if revision != a.Config.Draft.Revision {
		return nil, ErrStale
	}
	selected := map[string]bool{}
	for _, id := range ids {
		if id == "" || selected[id] {
			return nil, ErrInvalid
		}
		selected[id] = true
	}
	products := []Product{}
	for _, p := range a.Config.Draft.Products {
		if selected[p.ProductID] {
			if !p.Enabled || a.Config.ProductLifecycle[p.ProductID].State == "archived" {
				return nil, ErrInvalid
			}
			// Explicit publication adopts the current cost contract, including
			// saved drafts created before its introduction.
			p.CostVersion = 1
			products = append(products, p)
		}
	}
	if len(products) != len(ids) {
		return nil, ErrInvalid
	}
	a.Config.AdapterBindings = bindingsFor(a, a.Config.MediaTypes)
	a.Config.AdapterBinding = nil
	now := time.Now().UTC()
	validation, offers := validateContext(ctx, a, Draft{Revision: revision, Products: products}, now)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validation.PublishReady {
		d := describe(a)
		d.PublishValidation = &validation
		return d, ErrValidation
	}
	// A legacy snapshot must retain its original strict dependency semantics. It
	// cannot silently gain current grants while publishing a different product.
	merged := []Product{}
	mergedOffers := []Offer{}
	deps := map[string]Dependencies{}
	if old := a.Config.Published; old != nil {
		if old.Revision != publishedRevision(old) {
			return nil, ErrStale
		}
		for _, p := range old.Products {
			if selected[p.ProductID] {
				continue
			}
			dependency, ok := old.ProductDependencies[p.ProductID]
			if !ok {
				return nil, ErrLegacyPublish
			}
			merged = append(merged, p)
			mergedOffers = append(mergedOffers, productOffers(a, p.ProductID)...)
			deps[p.ProductID] = dependency
		}
	}
	merged = append(merged, products...)
	mergedOffers = append(mergedOffers, offers...)
	for _, p := range products {
		deps[p.ProductID] = productDependencies(a, p)
	}
	pub := &Published{SourceDraftRevision: revision, PublishedAt: now, Products: merged, Offers: mergedOffers,
		Dependencies: dependenciesForProducts(a, merged), ProductDependencies: deps}
	pub.Revision = publishedRevision(pub)
	a.Config.Published = pub
	// Draft validation still describes the whole saved draft. A subset PASS must
	// never masquerade as a PASS for unrelated unfinished products.
	a.Config.RecordVersion++
	if err := s.repo.CompareAndSwapChecked(ctx, id, expected, validation.Dependencies, a.Config); err != nil {
		return nil, err
	}
	d := describe(a)
	d.PublishValidation = &validation
	return d, nil
}

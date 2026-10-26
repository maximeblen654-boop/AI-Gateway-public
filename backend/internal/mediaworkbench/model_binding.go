package mediaworkbench

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// ModelBindingInput is an explicit, product-scoped maintenance operation. A new
// model identifier is never interpreted as a request to publish a newer draft.
type ModelBindingInput struct {
	ExpectedDraftRevision string   `json:"expected_draft_revision"`
	OldModelID            string   `json:"old_model_id"`
	NewModelID            string   `json:"new_model_id"`
	Action                string   `json:"action"`
	ProductIDs            []string `json:"product_ids"`
}

func boundedBindingID(id string) bool {
	return id != "" && len(id) <= catalogChangeMaxModelBytes && strings.TrimSpace(id) == id
}

func trustedBindingCatalog(c *Catalog) bool {
	if c == nil || c.Source != "upstream" || c.SyncedAt == "" || c.AccountIdentitySHA256 == "" || len(c.Models) == 0 {
		return false
	}
	if _, err := time.Parse(time.RFC3339, c.SyncedAt); err != nil {
		return false
	}
	for _, model := range c.Models {
		if !boundedBindingID(model) {
			return false
		}
	}
	return true
}

// ModelBinding changes only the selected current product records. Historical
// tasks, quotes, receipts and their immutable snapshots live outside this Config.
func (s *Service) ModelBinding(ctx context.Context, id, expected int64, in ModelBindingInput) (*Detail, error) {
	if !boundedBindingID(in.OldModelID) || in.ExpectedDraftRevision == "" || len(in.ProductIDs) == 0 || len(in.ProductIDs) > 100 ||
		(in.Action != "rebind" && in.Action != "delete") ||
		(in.Action == "rebind" && (!boundedBindingID(in.NewModelID) || in.NewModelID == in.OldModelID)) ||
		(in.Action == "delete" && in.NewModelID != "") {
		return nil, ErrInvalid
	}
	selected := make(map[string]bool, len(in.ProductIDs))
	for _, productID := range in.ProductIDs {
		if !boundedBindingID(productID) || selected[productID] {
			return nil, ErrInvalid
		}
		selected[productID] = true
	}
	ctx = WithModelBindingCatalogIdentity(ctx)
	a, err := s.mutable(ctx, id, expected)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if a.Config.Draft.Revision != in.ExpectedDraftRevision {
		return nil, ErrStale
	}
	if !trustedBindingCatalog(a.Catalog) {
		return bindingFailure(a, bindingDiagnostic(a, "MODEL_BINDING_CATALOG_REQUIRED", "", "model_catalog", "请先成功同步该 Account 的完整模型目录，再处理缺失型号。"), nil)
	}
	if slices.Contains(a.Catalog.Models, in.OldModelID) {
		return bindingFailure(a, bindingDiagnostic(a, "MODEL_BINDING_OLD_MODEL_PRESENT", "", "old_model_id", "旧型号仍在当前成功同步的目录中，请重新读取后核对本次处理对象。"), nil)
	}
	if in.Action == "rebind" && !slices.Contains(a.Catalog.Models, in.NewModelID) {
		return bindingFailure(a, bindingDiagnostic(a, "MODEL_BINDING_NEW_MODEL_UNAVAILABLE", "", "new_model_id", "新型号不在该 Account 当前成功同步的目录中，请明确选择可用型号。"), nil)
	}
	if a.Config.Published != nil && a.Config.Published.Revision != publishedRevision(a.Config.Published) {
		return nil, ErrStale
	}
	drafts, published := map[string]Product{}, map[string]Product{}
	for _, p := range a.Config.Draft.Products {
		if _, duplicate := drafts[p.ProductID]; duplicate {
			return nil, ErrInvalid
		}
		drafts[p.ProductID] = p
	}
	if a.Config.Published != nil {
		for _, p := range a.Config.Published.Products {
			if _, duplicate := published[p.ProductID]; duplicate {
				return nil, ErrInvalid
			}
			published[p.ProductID] = p
		}
	}
	for _, productID := range in.ProductIDs {
		draft, hasDraft := drafts[productID]
		pub, hasPublished := published[productID]
		if (!hasDraft || draft.UpstreamModel != in.OldModelID) && (!hasPublished || pub.UpstreamModel != in.OldModelID) {
			return bindingFailure(a, bindingDiagnostic(a, "MODEL_BINDING_PRODUCT_MISMATCH", productID, "upstream_model", "此商品的草稿和发布快照均未绑定所选旧型号，请重新读取后确认。"), nil)
		}
	}
	// Preserve the original dependency identity for the row-lock check. Editing a
	// legacy draft or deleting its last product can itself change DependenciesFor.
	checkedDependencies := DependenciesFor(a)
	candidate, err := bindingCandidate(a)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	var validation *Validation
	if in.Action == "delete" {
		deleteBindingProducts(candidate.Config, selected)
	} else {
		var products []Product
		publishedChanged := false
		for i, p := range candidate.Config.Draft.Products {
			if selected[p.ProductID] {
				candidate.Config.Draft.Products[i] = reboundProduct(candidate, p, in.NewModelID)
			}
		}
		// Explicit product selection may replace an earlier draft model choice;
		// its business fields stay in the draft. Only the original published
		// contract is recompiled into current offers.
		if candidate.Config.Published != nil {
			for i, p := range candidate.Config.Published.Products {
				if selected[p.ProductID] && p.UpstreamModel == in.OldModelID {
					publishedChanged = true
					p = reboundProduct(candidate, p, in.NewModelID)
					candidate.Config.Published.Products[i] = p
					if p.Enabled {
						products = append(products, p)
					}
				}
			}
		}
		// Draft-only products may remain unfinished. Reject an unsupported
		// technical flow, but keep ordinary missing specifications/prices in the
		// saved Draft validation; no published grant is created for such a draft.
		for _, p := range candidate.Config.Draft.Products {
			if selected[p.ProductID] && p.Enabled {
				if _, exists := published[p.ProductID]; !exists {
					v, _ := validateBindingProducts(ctx, candidate, []Product{p}, in.ExpectedDraftRevision, now)
					if err := ctx.Err(); err != nil {
						return nil, err
					}
					for _, diagnostic := range v.Diagnostics {
						if diagnostic.Class == "NEEDS_DEVELOPMENT" || diagnostic.Class == "UNKNOWN" {
							return bindingFailure(a, v, []Product{p})
						}
					}
				}
			}
		}
		if len(products) > 0 {
			v, offers := validateBindingProducts(ctx, candidate, products, in.ExpectedDraftRevision, now)
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if !v.PublishReady {
				return bindingFailure(a, v, products)
			}
			validation = &v
			if pub := candidate.Config.Published; pub != nil && publishedChanged {
				pub.Offers = slices.DeleteFunc(pub.Offers, func(o Offer) bool {
					p, exists := published[o.ProductID]
					return selected[o.ProductID] && exists && p.UpstreamModel == in.OldModelID
				})
				for _, offer := range offers {
					if p, exists := published[offer.ProductID]; exists && p.UpstreamModel == in.OldModelID {
						pub.Offers = append(pub.Offers, offer)
					}
				}
			}
		}
		if pub := candidate.Config.Published; pub != nil && publishedChanged {
			if len(products) == 0 {
				pub.Offers = slices.DeleteFunc(pub.Offers, func(o Offer) bool {
					return selected[o.ProductID] && published[o.ProductID].UpstreamModel == in.OldModelID
				})
			}
			if pub.ProductDependencies == nil {
				pub.ProductDependencies = map[string]Dependencies{}
			}
			for _, p := range pub.Products {
				if selected[p.ProductID] && published[p.ProductID].UpstreamModel == in.OldModelID {
					if p.Enabled {
						pub.ProductDependencies[p.ProductID] = productDependencies(candidate, p)
					}
					continue
				}
				if _, exists := pub.ProductDependencies[p.ProductID]; exists || !p.Enabled {
					continue
				}
				// Legacy siblings receive a per-product grant only after their own
				// original published contract reproduces the exact original offers.
				v, offers := validateBindingProducts(ctx, candidate, []Product{p}, pub.SourceDraftRevision, pub.PublishedAt)
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if !v.PublishReady || hash(offers) != hash(productOffers(a, p.ProductID)) {
					// A missing grant fails this sibling closed. Keep its original
					// product/offers available for a separate explicit repair, without
					// letting two removed legacy models block each other's repair.
					continue
				}
				pub.ProductDependencies[p.ProductID] = productDependencies(candidate, p)
			}
			pub.Dependencies = dependenciesForProducts(candidate, pub.Products)
			pub.PublishedAt = now
			pub.Revision = publishedRevision(pub)
		}
	}
	basedOn := ""
	if candidate.Config.Published != nil {
		basedOn = candidate.Config.Published.Revision
	}
	candidate.Config.Draft = makeDraft(DraftInput{Products: candidate.Config.Draft.Products}, basedOn, now)
	candidate.Config.Validation, _ = validateContext(ctx, candidate, candidate.Config.Draft, now)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	candidate.Config.RecordVersion++
	if err := s.repo.CompareAndSwapChecked(ctx, id, expected, checkedDependencies, candidate.Config); err != nil {
		return nil, err
	}
	d := describe(candidate)
	d.PublishValidation = validation
	return d, nil
}

func bindingCandidate(a *Account) (*Account, error) {
	b, err := json.Marshal(a.Config)
	if err != nil {
		return nil, err
	}
	candidate := *a
	candidate.Config = nil
	if err := json.Unmarshal(b, &candidate.Config); err != nil {
		return nil, err
	}
	return &candidate, nil
}

func reboundProduct(a *Account, p Product, model string) Product {
	siteModel := p.SiteModel
	p.UpstreamModel = model
	// This explicit operation adopts the same direct, sale-only contract as a
	// normal saved/published product. Historical v0 Account aliases must not force
	// an administrator to edit native API mappings to repair a Studio binding.
	normalizeProductCost(&p)
	inheritNativeProduct(a, &p)
	p.SiteModel = siteModel // A technical rename never changes customer identity.
	return p
}

func validateBindingProducts(ctx context.Context, a *Account, products []Product, revision string, now time.Time) (Validation, []Offer) {
	copyAccount, copyConfig := *a, *a.Config
	copyConfig.ProductLifecycle = nil // Validate immutable contracts even while unlisted/archived.
	copyAccount.Config = &copyConfig
	return validateContext(ctx, &copyAccount, Draft{Revision: revision, Products: products}, now)
}

func bindingDiagnostic(a *Account, code, productID, path, message string) Validation {
	v := Validation{DraftRevision: a.Config.Draft.Revision, Status: "FAIL", CheckedAt: time.Now().UTC(), Dependencies: DependenciesFor(a), AdapterRegistryRevision: RegistryRevision, Diagnostics: []Diagnostic{}, Previews: []Preview{}}
	if a.Catalog != nil {
		v.ModelCatalog = CatalogDependency{SyncedAt: a.Catalog.SyncedAt, SHA256: v.Dependencies.CatalogSHA256}
	}
	v.Diagnostics = append(v.Diagnostics, diagnostic("UI_FIXABLE", code, productID, path, message))
	return v
}

func bindingFailure(a *Account, validation Validation, products []Product) (*Detail, error) {
	d := describe(a)
	d.PublishValidation = &validation
	d.BindingValidationProducts = products
	return d, ErrValidation
}

func deleteBindingProducts(c *Config, selected map[string]bool) {
	c.Draft.Products = slices.DeleteFunc(c.Draft.Products, func(p Product) bool { return selected[p.ProductID] })
	c.RemovedDraftProducts = slices.DeleteFunc(c.RemovedDraftProducts, func(p Product) bool { return selected[p.ProductID] })
	if pub := c.Published; pub != nil {
		pub.Products = slices.DeleteFunc(pub.Products, func(p Product) bool { return selected[p.ProductID] })
		pub.Offers = slices.DeleteFunc(pub.Offers, func(o Offer) bool { return selected[o.ProductID] })
		for id := range selected {
			delete(pub.ProductDependencies, id)
		}
		// Keep the original shared legacy dependencies: deletion must not grant
		// current dependencies to a sibling without validating its contract.
		pub.Revision = publishedRevision(pub)
		if len(pub.Products) == 0 && len(pub.Offers) == 0 {
			c.Published = nil
		}
	}
	before := len(c.Procurement.Entries)
	c.Procurement.Entries = slices.DeleteFunc(c.Procurement.Entries, func(e ProcurementEntry) bool { return selected[e.ProductID] })
	if len(c.Procurement.Entries) != before {
		c.Procurement.Revision++
	}
	for id := range selected {
		delete(c.ProductLifecycle, id)
	}
}

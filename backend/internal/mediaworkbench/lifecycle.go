package mediaworkbench

import (
	"context"
	"slices"
	"strings"
	"time"
)

type ProductLifecycle struct {
	State     string    `json:"state"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updated_at"`
}
type LifecycleInput struct {
	Action    string `json:"action"`
	ProductID string `json:"product_id,omitempty"`
	ModelID   string `json:"model_id,omitempty"`
}

// Lifecycle is an explicit admin CAS independent of Draft publication. Archived
// products retain their snapshots and remain in save payloads for restoration.
func (s *Service) Lifecycle(ctx context.Context, id, expected int64, in LifecycleInput) (*Detail, error) {
	if expected < 0 || expected >= 9007199254740991 || (in.ProductID == "") == (in.ModelID == "") || len(in.ModelID) > 256 || len(in.ProductID) > 256 || strings.TrimSpace(in.ModelID) != in.ModelID {
		return nil, ErrInvalid
	}
	if !slices.Contains([]string{"unlist", "relist", "archive", "restore", "hide"}, in.Action) {
		return nil, ErrInvalid
	}
	a, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !SupportsAccount(a) {
		return nil, ErrUnsupported
	}
	if a.Config == nil {
		if expected != 0 || in.Action != "hide" || in.ModelID == "" || a.Catalog == nil || !slices.Contains(a.Catalog.Models, in.ModelID) {
			return nil, ErrInvalid
		}
		now := time.Now().UTC()
		a.Config = &Config{SchemaVersion: 1, MediaTypes: []string{"image", "video"}, AdapterBindings: bindingsFor(a, []string{"image", "video"}), Sales: Sales{HasEverEnabled: new(bool), UpdatedAt: now}, Procurement: Procurement{Entries: []ProcurementEntry{}}}
		a.Config.Draft = makeDraft(DraftInput{Products: []Product{}}, "", now)
		a.Config.Validation, _ = Validate(a, a.Config.Draft, now)
	} else if a.Config.SchemaVersion != 1 {
		return nil, ErrInvalid
	} else if a.Config.RecordVersion != expected || expected < 1 {
		return nil, ErrStale
	}
	c := a.Config
	targets := map[string]Product{}
	collect := func(p Product) {
		if (in.ProductID != "" && p.ProductID == in.ProductID) || (in.ModelID != "" && p.UpstreamModel == in.ModelID) {
			targets[p.ProductID] = p
		}
	}
	for _, p := range c.Draft.Products {
		collect(p)
	}
	if c.Published != nil {
		for _, p := range c.Published.Products {
			collect(p)
		}
	}
	if in.ModelID != "" && c.Published != nil {
		for _, draft := range c.Draft.Products {
			published, ok := publishedProduct(a, draft.ProductID)
			if ok && draft.UpstreamModel != published.UpstreamModel && (draft.UpstreamModel == in.ModelID || published.UpstreamModel == in.ModelID) {
				return nil, ErrInvalid // Use the explicit product action for divergent Draft/Published identities.
			}
		}
	}
	if in.ModelID != "" && in.Action == "restore" {
		c.HiddenModels = slices.DeleteFunc(c.HiddenModels, func(v string) bool { return v == in.ModelID })
	}
	if len(targets) == 0 {
		if in.ModelID == "" || (in.Action != "hide" && in.Action != "restore") {
			return nil, ErrInvalid
		}
		if in.Action == "hide" {
			if a.Catalog == nil || !slices.Contains(a.Catalog.Models, in.ModelID) || len(c.HiddenModels) >= 1000 {
				return nil, ErrInvalid
			}
			if !slices.Contains(c.HiddenModels, in.ModelID) {
				c.HiddenModels = append(c.HiddenModels, in.ModelID)
			}
		} else {
			c.HiddenModels = slices.DeleteFunc(c.HiddenModels, func(v string) bool { return v == in.ModelID })
		}
	} else {
		if in.Action == "hide" {
			return nil, ErrInvalid
		}
		if c.ProductLifecycle == nil {
			c.ProductLifecycle = map[string]ProductLifecycle{}
		}
		// Validate all targets before changing any, including mixed bulk operations.
		for id := range targets {
			state := c.ProductLifecycle[id].State
			_, published := publishedProduct(a, id)
			if in.Action == "archive" && published && state != "unlisted" && state != "archived" {
				return nil, ErrSales
			}
			if in.Action == "relist" {
				if state == "archived" {
					return relistFailure(a, id, bindingDiagnostic(a, "PRODUCT_ARCHIVED", id, "product_lifecycle", "商品已归档，请先恢复配置，再明确重新上架。"))
				}
				if !published {
					return relistFailure(a, id, bindingDiagnostic(a, "NOT_PUBLISHED", id, "published", "此商品尚未发布，请先完成规格及售价并明确发布该商品，再重新上架。"))
				}
				copyAccount := *a
				copyConfig := *c
				copyStates := map[string]ProductLifecycle{}
				for k, v := range c.ProductLifecycle {
					copyStates[k] = v
				}
				delete(copyStates, id)
				copyConfig.ProductLifecycle = copyStates
				copyAccount.Config = &copyConfig
				if !publishedProductReady(ctx, &copyAccount, id) {
					if err := ctx.Err(); err != nil {
						return nil, err
					}
					p, _ := publishedProduct(a, id)
					if a.Catalog != nil && a.Catalog.SyncedAt != "" && !slices.Contains(a.Catalog.Models, p.UpstreamModel) {
						return relistFailure(a, id, bindingDiagnostic(a, "UPSTREAM_REMOVED", id, "upstream_model", "原发布商品绑定的型号已从当前成功目录移除，请先更换绑定，或明确删除该缺失商品。"))
					}
					v, offers := validateBindingProducts(ctx, &copyAccount, []Product{p}, a.Config.Published.SourceDraftRevision, a.Config.Published.PublishedAt)
					if v.PublishReady {
						code, message := "PUBLISHED_DEPENDENCIES_CHANGED", "该商品的原发布依赖与当前 Account 不一致，请核对执行配置并校验原发布合同。"
						if hash(offers) != hash(productOffers(a, id)) {
							code, message = "PUBLISHED_CONTRACT_CHANGED", "该商品的原发布 Offer 不能按当前技术配置原样复现，请核对该商品后再重新上架。"
						} else if !SupportsAccount(a) || a.Status != "active" || !a.Schedulable || !a.RuntimeReady {
							code, message = "ACCOUNT_UNAVAILABLE", "该 Account 当前的原生执行或调度条件不满足，请先核对账号可用性。"
						}
						v = bindingDiagnostic(a, code, id, "published", message)
					}
					return relistFailure(a, id, v)
				}
			}
		}
		for id := range targets {
			state := c.ProductLifecycle[id]
			next := state.State
			switch in.Action {
			case "unlist":
				if next != "archived" {
					next = "unlisted"
				}
			case "relist":
				if next != "archived" {
					next = "active"
				}
			case "archive":
				next = "archived"
			case "restore":
				if next == "archived" {
					next = "unlisted"
				}
			}
			if next != state.State {
				c.ProductLifecycle[id] = ProductLifecycle{State: next, Revision: state.Revision + 1, UpdatedAt: time.Now().UTC()}
			}
		}
	}
	c.RecordVersion++
	if in.Action == "relist" {
		err = s.repo.CompareAndSwapChecked(ctx, id, expected, DependenciesFor(a), c)
	} else {
		err = s.repo.CompareAndSwap(ctx, id, expected, c)
	}
	if err != nil {
		return nil, err
	}
	return describe(a), nil
}

func relistFailure(a *Account, id string, validation Validation) (*Detail, error) {
	d := describe(a)
	d.PublishValidation = &validation
	if p, ok := publishedProduct(a, id); ok {
		d.BindingValidationProducts = []Product{p}
	}
	e := *ErrValidation
	metadata := map[string]string{"product_id": id}
	if len(validation.Diagnostics) > 0 {
		e.Message = validation.Diagnostics[0].Message
		metadata["diagnostic_code"] = validation.Diagnostics[0].Code
	}
	return d, e.WithMetadata(metadata)
}

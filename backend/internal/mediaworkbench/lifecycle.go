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
			if in.Action == "relist" && state != "archived" {
				copyAccount := *a
				copyConfig := *c
				copyStates := map[string]ProductLifecycle{}
				for k, v := range c.ProductLifecycle {
					copyStates[k] = v
				}
				delete(copyStates, id)
				copyConfig.ProductLifecycle = copyStates
				copyAccount.Config = &copyConfig
				if published {
					if !publishedProductReady(ctx, &copyAccount, id) {
						return nil, ErrValidation
					}
				} else {
					v, _ := validateContext(ctx, &copyAccount, Draft{Products: []Product{targets[id]}}, time.Now().UTC())
					if !v.PublishReady {
						return nil, ErrValidation
					}
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

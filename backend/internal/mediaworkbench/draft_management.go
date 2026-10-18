package mediaworkbench

import apperrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"

var ErrDraftRemoval = apperrors.New(422, "MEDIA_DRAFT_REMOVAL_BLOCKED", "只能明确移除未发布且未关联采购配置的空白草稿，请重新读取后确认所选商品")

type DraftRemoval struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
}

// Blank means no sale specifications, reference requirements or price rules.
// A zero price is a configured price, never an empty draft. Technical defaults
// inherited from the Account do not turn a blank business draft into an offer.
func blankDraftProduct(p Product) bool {
	c := p.Capabilities
	if len(p.CostRules) > 0 {
		return false
	}
	for _, rule := range p.PricingRules {
		m := rule.Match
		if rule.SalePrice != nil || len(m.Resolution)+len(m.DurationSeconds)+len(m.AspectRatio)+len(m.Quality) > 0 || m.Count != nil || m.References != nil {
			return false
		}
	}
	return len(c.Resolutions) == 0 && len(c.AspectRatios) == 0 && len(c.Qualities) == 0 &&
		len(c.DurationsSeconds) == 0 && len(c.CombinationRules) == 0 &&
		c.References == (References{})
}

func draftRemovalOptions(c *Config) map[string]DraftRemoval {
	result := map[string]DraftRemoval{}
	if c == nil {
		return result
	}
	protected := map[string]bool{}
	if c.Published != nil {
		for _, p := range c.Published.Products {
			protected[p.ProductID] = true
		}
		for _, o := range c.Published.Offers {
			protected[o.ProductID] = true
		}
	}
	for _, e := range c.Procurement.Entries {
		protected[e.ProductID] = true
	}
	for _, p := range c.Draft.Products {
		option := DraftRemoval{Allowed: true}
		if protected[p.ProductID] {
			option = DraftRemoval{Reason: "已发布或有关联采购配置，不能移除。可通过商品启停管理后续销售。"}
		} else if !blankDraftProduct(p) {
			option = DraftRemoval{Reason: "已有规格、参考素材要求或价格，不属于空白草稿。"}
		}
		result[p.ProductID] = option
	}
	return result
}

func validateDraftRemovals(c *Config, input DraftInput) ([]Product, error) {
	requested, remaining := map[string]bool{}, map[string]bool{}
	for _, id := range input.RemoveProductIDs {
		if id == "" || requested[id] {
			return nil, ErrDraftRemoval
		}
		requested[id] = true
	}
	for _, p := range input.Products {
		if requested[p.ProductID] {
			return nil, ErrDraftRemoval
		}
		remaining[p.ProductID] = true
	}
	// An old retained identity cannot be silently recycled for a new product.
	for _, p := range c.RemovedDraftProducts {
		if remaining[p.ProductID] {
			return nil, ErrDraftRemoval
		}
	}
	options := draftRemovalOptions(c)
	removed := []Product{}
	for _, p := range c.Draft.Products {
		if remaining[p.ProductID] {
			continue
		}
		if !requested[p.ProductID] || !options[p.ProductID].Allowed {
			return nil, ErrDraftRemoval.WithMetadata(map[string]string{"product_id": p.ProductID})
		}
		removed = append(removed, p)
		delete(requested, p.ProductID)
	}
	if len(requested) != 0 {
		return nil, ErrDraftRemoval
	}
	return removed, nil
}

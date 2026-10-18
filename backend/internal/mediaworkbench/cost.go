package mediaworkbench

import "fmt"

// Cost rules use the same bounded domain as sale prices but are independently
// matched. Amount is the cost of one delivered image/video, including for video
// duration-specific rules: runtime never multiplies by duration.
func validCostMatch(m Match, c Capabilities) bool {
	formats := m.OutputFormats
	m.OutputFormats = nil
	// Omitted native output_format is itself an allowed request. A cost rule
	// may target it explicitly with "" without overlapping explicit formats.
	return subset(formats, append([]string{""}, c.OutputFormats...)) && validMatch(m, c)
}

func costMatches(m Match, s Spec) bool {
	return member(m.OutputFormats, s.OutputFormat) && Matches(m, s)
}

func validateCostRules(p Product, v *Validation) {
	add := func(code, path, message string) {
		d := diagnostic("UI_FIXABLE", code, p.ProductID, path, p.DisplayName+"："+message)
		d.Action = "前往第4步填写采购成本并保存草稿"
		v.Diagnostics = append(v.Diagnostics, d)
	}
	if p.CostVersion != 1 {
		add("INVALID_COST_VERSION", "cost_rules", "采购成本版本不受支持")
	}
	if len(p.CostRules) > 100 {
		add("CONFIG_TOO_LARGE", "cost_rules", "每个商品最多配置100条采购成本规则")
		return
	}
	for i, r := range p.CostRules {
		path := fmt.Sprintf("cost_rules.%d", i)
		if !validCostMatch(r.Match, p.Capabilities) {
			add("INVALID_COST_MATCH", path+".match", "采购成本条件超出当前可售规格")
		}
		if r.Source != "" && r.Source != "manual" && r.Source != "calculator" {
			add("INVALID_COST_SOURCE", path+".source", "请选择直接填写或采用计算结果")
		}
		if r.Cost == nil {
			add("MISSING_COST", path+".cost", "采购成本尚未填写")
			v.Diagnostics[len(v.Diagnostics)-1].Match = &p.CostRules[i].Match
		} else if ValidateImageSalePrice(*r.Cost) != nil {
			add("INVALID_COST", path+".cost", "采购成本必须是非负CNY金额，最多8位小数，按张或整条计费")
		}
	}
}

func validateCostCoverage(p Product, cases []Spec, v *Validation) {
	hits := make([]int, len(p.CostRules))
	missing, overlap := []Spec{}, []Spec{}
	missingCount, overlapCount := 0, 0
	for _, spec := range cases {
		count := 0
		for i, rule := range p.CostRules {
			if costMatches(rule.Match, spec) {
				hits[i]++
				count++
			}
		}
		if count == 0 {
			missingCount++
			if len(missing) < 8 {
				missing = append(missing, spec)
			}
		} else if count > 1 {
			overlapCount++
			if len(overlap) < 8 {
				overlap = append(overlap, spec)
			}
		}
	}
	add := func(code, path, message string, evidence []Spec, count int) {
		d := diagnostic("UI_FIXABLE", code, p.ProductID, path, p.DisplayName+"："+message)
		d.Action, d.Specs, d.SpecCount = "前往第4步填写采购成本并保存草稿", evidence, count
		v.Diagnostics = append(v.Diagnostics, d)
	}
	if missingCount > 0 {
		add("MISSING_COST", "cost_rules", "部分可售规格的采购成本尚未填写", missing, missingCount)
	}
	if overlapCount > 0 {
		add("COST_RULE_OVERLAP", "cost_rules", "部分规格匹配了多条采购成本规则", overlap, overlapCount)
	}
	for i, count := range hits {
		if count == 0 {
			add("UNUSED_COST_RULE", fmt.Sprintf("cost_rules.%d", i), "采购成本规则未覆盖任何合法规格", nil, 0)
		}
	}
}

// ResolvePublishedCost is private server accounting input, never a customer DTO.
// The exact current immutable product/offer/revision must match the binding.
func ResolvePublishedCost(a *Account, b ResolvedImageOffer) (Price, string, error) {
	p, ok := publishedProduct(a, b.Offer.ProductID)
	if !ok || p.CostVersion != 1 || b.Offer.CostVersion != 1 || a.ID != b.Offer.AccountID || p.UpstreamModel != b.Offer.UpstreamModel || !b.Offer.Matches(b.Spec) {
		return Price{}, "", ErrRuntimeBinding
	}
	validOffer := false
	for _, o := range productOffers(a, p.ProductID) {
		if hash(o) == hash(b.Offer) {
			validOffer = true
			break
		}
	}
	if !validOffer {
		return Price{}, "", ErrRuntimeBinding
	}
	revision, _ := offerSnapshot(a, b.Offer)
	if b.PublishedRevision != revision || b.SpecHash != hash(b.Spec) {
		return Price{}, "", ErrRuntimeBinding
	}
	matched := -1
	for i, rule := range p.CostRules {
		if costMatches(rule.Match, b.Spec) {
			if matched >= 0 || rule.Cost == nil || ValidateImageSalePrice(*rule.Cost) != nil {
				return Price{}, "", ErrRuntimeBinding
			}
			matched = i
		}
	}
	if matched < 0 {
		return Price{}, "", ErrRuntimeBinding
	}
	rule := p.CostRules[matched]
	return *rule.Cost, hash([]any{a.ID, p.ProductID, p.UpstreamModel, revision, rule}), nil
}

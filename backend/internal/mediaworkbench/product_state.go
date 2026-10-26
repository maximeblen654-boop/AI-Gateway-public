package mediaworkbench

import (
	"context"
	"slices"
	"sort"
)

type ProductState struct {
	ProductID      string `json:"product_id"`
	DisplayName    string `json:"display_name"`
	UpstreamModel  string `json:"upstream_model"`
	MediaType      string `json:"media_type"`
	Published      bool   `json:"published"`
	PublishedReady bool   `json:"published_ready"`
	State          string `json:"state"`
	Reason         string `json:"reason"`
	Action         string `json:"action"`
}

// Status is derived from the published contract, not its in-progress draft.
// It does not claim that the global paid gate or a customer's native permissions pass.
func describeProductsContext(ctx context.Context, a *Account, ready func(string) bool) []ProductState {
	out := []ProductState{}
	if a == nil || a.Config == nil {
		return out
	}
	products := map[string]Product{}
	for _, p := range a.Config.Draft.Products {
		products[p.ProductID] = p
	}
	if a.Config.Published != nil {
		for _, p := range a.Config.Published.Products {
			products[p.ProductID] = p
		}
	}
	ids := []string{}
	for id := range products {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if ctx.Err() != nil {
			return nil
		}
		p := products[id]
		_, published := publishedProduct(a, id)
		state := ProductState{ProductID: id, DisplayName: p.DisplayName, UpstreamModel: p.UpstreamModel, MediaType: p.MediaType, Published: published}
		set := func(code, reason, action string) { state.State, state.Reason, state.Action = code, reason, action }
		switch {
		case a.Config.ProductLifecycle[id].State == "archived":
			set("ARCHIVED", "商品已归档，不接受新的 Studio 报价和生成。", "如需经营，恢复配置并经校验后明确重新上架。")
		case a.Config.ProductLifecycle[id].State == "unlisted":
			set("UNLISTED", "商品已手动下架。", "核对商品后，通过重新上架操作恢复；同步目录不会自动上架。")
		case a.Catalog != nil && a.Catalog.SyncedAt != "" && !slices.Contains(a.Catalog.Models, p.UpstreamModel):
			set("UPSTREAM_REMOVED", "该商品绑定的型号已不在当前成功同步的目录中，仅此商品不可售。", "明确选择当前可用型号更换绑定，或删除该缺失型号的选中商品；历史订单和任务仍保留原快照。")
		case !published:
			set("NOT_PUBLISHED", "此商品尚未发布；草稿保存或校验通过不代表已可售。", "完成该商品的规格及正数售价，明确选择此商品发布。其他草稿无需同时完成。")
		case !SupportsAccount(a) || a.Status != "active" || !a.Schedulable || !a.RuntimeReady:
			set("ACCOUNT_UNAVAILABLE", "该 Account 的原生执行或调度条件当前不满足。", "在账号管理核对该 Account 的可用性、权限及执行条件。")
		case a.Catalog == nil || a.Catalog.SyncedAt == "":
			set("DEPENDENCIES_CHANGED", "缺少可信的模型目录。", "成功同步完整目录后重新检查，不要直接发布未完成草稿。")
		case len(a.Config.Published.ProductDependencies) == 0 && !legacyPublishedReady(ctx, a):
			set("DEPENDENCIES_CHANGED", "历史已发布快照的完整依赖校验未通过，尚未建立逐商品依赖。", "先对原已发布商品执行受控校验恢复；不要通过发布包含新草稿的整个 Account 来修复。")
		case !productDependencyReady(a, id):
			set("DEPENDENCIES_CHANGED", "该商品的已发布依赖与当前 Account 执行配置不一致。", "核对该模型的映射、路由和执行配置，校验后仅发布本次明确选择的商品。")
		case !ready(id):
			set("PUBLISHED_INVALID", "该商品的已发布规格、售价或执行校验未通过。", "核对该商品的诊断与规格售价，修正并仅发布该商品。")
		case !a.Config.Sales.Enabled:
			set("ACCOUNT_SALES_OFF", "已发布商品通过校验，但 Account 销售尚未开启。", "由管理员单独确认 Account 销售状态；发布不会自动开启销售。")
		default:
			state.PublishedReady = true
			set("READY", "该商品的已发布配置及 Account 销售条件满足。", "实际使用还需 Studio 全局付费开关与当前客户原生权限通过。")
		}
		out = append(out, state)
	}
	return out
}

func draftProductMatchesPublished(draft Draft, published Product) bool {
	for _, product := range draft.Products {
		if product.ProductID == published.ProductID {
			return hash(product) == hash(published)
		}
	}
	return true
}

package mediaworkbench

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/imageplan"
)

const laoliSyncFamily = "laoli_json"

func inheritLaoliSyncProduct(a *Account, p *Product) bool {
	if a == nil || p == nil || p.MediaType != "image" || nativeAdapterKind(a, "image") != "openai_images" || !imagecontract.IsLaoliMediaBase(a.BaseURL) || p.AdapterConfig.WireProfile != "" {
		return false
	}
	switch p.AdapterConfig.ModelFamily {
	case "", laoliSyncFamily:
		p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, laoliSyncFamily
		return true
	}
	return false
}

func validateLaoliSyncProduct(a *Account, p Product) []Diagnostic {
	if p.MediaType != "image" || ((a == nil || !imagecontract.IsLaoliMediaBase(a.BaseURL)) && p.AdapterConfig.ModelFamily != laoliSyncFamily) {
		return nil
	}
	var out []Diagnostic
	add := func(code, path, message string) {
		d := diagnostic("UI_FIXABLE", code, p.ProductID, path, message)
		d.Action = "请按已确认的商品规格修正并重新保存；未确认的能力不能发布。"
		out = append(out, d)
	}
	if a == nil || !imagecontract.IsLaoliMediaBase(a.BaseURL) || nativeAdapterKind(a, "image") != "openai_images" || p.AdapterConfig.Version != 1 || p.AdapterConfig.ModelFamily != laoliSyncFamily || p.AdapterConfig.WireProfile != "" {
		add("LAOLI_SYNC_PROFILE_REQUIRED", "adapter_config", "该图片商品与老李同步接口不匹配，请重新选择账户并保存。")
	}
	if !imagecontract.IsLaoliSyncImageModel(p.UpstreamModel) {
		add("LAOLI_IMAGE_MODEL_UNCONFIRMED", "upstream_model", "该模型的单张同步产出合同尚未确认；Midjourney 的四张批次暂不能作为单张商品销售。")
	}
	if len(p.Capabilities.Qualities) > 0 {
		add("LAOLI_IMAGE_QUALITY_UNCONFIRMED", "capabilities.qualities", "接口文档未确认画质选项，请移除该规格。")
	}
	if len(p.Capabilities.OutputFormats) > 0 {
		add("LAOLI_IMAGE_FORMAT_UNCONFIRMED", "capabilities.output_formats", "接口文档未确认指定输出格式，请按实际图片格式交付。")
	}
	for _, item := range []struct {
		config *ImageExecutionConfig
		path   string
	}{{p.AdapterConfig.Execution, "adapter_config.execution"}, {p.AdapterConfig.EditExecution, "adapter_config.edit_execution"}} {
		if item.config != nil && (item.config.Mode != "" && item.config.Mode != ImageExecutionSingle || item.config.MaxOutputImages > 1 || item.config.Provider != "") {
			add("LAOLI_IMAGE_EXECUTION_UNCONFIRMED", item.path, "当前仅支持每次同步请求一张图片；批量数量由本站分为单张请求。")
		}
	}
	return out
}

func compileLaoliSyncPlan(p Product, spec Spec) (imageplan.Plan, error) {
	if p.AdapterConfig.Version != 1 || p.AdapterConfig.ModelFamily != laoliSyncFamily || p.AdapterConfig.WireProfile != "" || !imagecontract.IsLaoliSyncImageModel(p.UpstreamModel) || spec.Quality != "" || spec.OutputFormat != "" || spec.Images < 0 || spec.Videos != 0 || spec.Audio != 0 || spec.DurationSeconds != 0 {
		return imageplan.Plan{}, fmt.Errorf("unsupported Laoli synchronous image specification")
	}
	config := p.AdapterConfig
	if spec.Images > 0 {
		config.Execution = config.EditExecution
	}
	execution, err := PlanImageExecution(config, spec.Count)
	if err != nil || execution.Mode != ImageExecutionSingle || execution.MaxOutputImages != 1 {
		return imageplan.Plan{}, fmt.Errorf("unconfirmed Laoli synchronous execution capability")
	}
	fields := map[string]any{"model": p.UpstreamModel, "prompt": "<dry-run-prompt>", "n": 1}
	if spec.Resolution != "" || spec.AspectRatio != "" {
		size, _, _, dimensionErr := ImageDimensions(p.AdapterConfig, spec)
		if dimensionErr == nil {
			fields["size"] = size
		} else if errors.Is(dimensionErr, errMissingMapping) && spec.AspectRatio == "" {
			fields["resolution"] = spec.Resolution
		} else {
			// The supplier documents size/resolution, not image aspect_ratio.
			// Require a caller-confirmed size mapping instead of guessing pixels.
			return imageplan.Plan{}, fmt.Errorf("laoli image aspect ratio requires an explicit size mapping")
		}
	}
	endpoint := imageplan.Generations
	if spec.Images > 0 {
		endpoint = imageplan.Edits
		refs := make([]string, spec.Images)
		for i := range refs {
			refs[i] = fmt.Sprintf("https://studio-preview.invalid/image/%d.png", i+1)
		}
		fields["images"] = refs
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return imageplan.Plan{}, err
	}
	return imageplan.CompileLaoliJSON(body, p.UpstreamModel, endpoint)
}

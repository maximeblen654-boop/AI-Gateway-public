package mediaworkbench

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/imageplan"
)

const image2ProSyncFamily = "image2pro_json"

// Only explicit draft saves inherit this profile. Older published products must
// be saved and published again before any new quote or generation is admitted.
func inheritImage2ProSyncProduct(a *Account, p *Product) bool {
	if a == nil || p == nil || p.MediaType != "image" || nativeAdapterKind(a, "image") != "openai_images" ||
		!imagecontract.IsImage2ProBase(a.BaseURL) || p.AdapterConfig.WireProfile != "" {
		return false
	}
	switch p.AdapterConfig.ModelFamily {
	case "", "openai_json", image2ProSyncFamily:
		p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, image2ProSyncFamily
		return true
	}
	return false
}

func validateImage2ProSyncProduct(a *Account, p Product) []Diagnostic {
	if p.MediaType != "image" {
		return nil
	}
	image2ProAccount := a != nil && imagecontract.IsImage2ProBase(a.BaseURL)
	if !image2ProAccount && p.AdapterConfig.ModelFamily != image2ProSyncFamily {
		return nil
	}
	diagnostics := []Diagnostic{}
	add := func(class, code, path, message string) {
		d := diagnostic(class, code, p.ProductID, path, message)
		d.Action = "请修正对应商品字段，重新保存草稿并发布。"
		diagnostics = append(diagnostics, d)
	}
	if image2ProAccount && (p.AdapterConfig.ModelFamily != image2ProSyncFamily || p.AdapterConfig.Version != 1 || p.AdapterConfig.WireProfile != "") {
		add("UI_FIXABLE", "IMAGE2PRO_SYNC_PROFILE_REQUIRED", "adapter_config", "该图片商品需要更新，请重新保存草稿并发布后再使用。")
		return diagnostics
	}
	if a == nil || !imagecontract.IsImage2ProBase(a.BaseURL) || nativeAdapterKind(a, "image") != "openai_images" || p.AdapterConfig.Version != 1 || p.AdapterConfig.WireProfile != "" {
		add("NEEDS_DEVELOPMENT", "IMAGE2PRO_SYNC_ACCOUNT_UNSUPPORTED", "adapter_config", "该图片商品与所选供应商账户不匹配，请重新选择账户并保存。")
	}
	if len(p.Capabilities.Qualities) > 0 {
		add("UI_FIXABLE", "IMAGE2PRO_QUALITY_UNCONFIRMED", "capabilities.qualities", "供应商不保证处理画质选项，请移除该商品的画质规格。")
	}
	if len(p.Capabilities.OutputFormats) > 0 {
		add("UI_FIXABLE", "IMAGE2PRO_OUTPUT_FORMAT_UNCONFIRMED", "capabilities.output_formats", "供应商不保证指定输出格式，请移除该规格并按实际图片格式交付。")
	}
	for _, item := range []struct {
		config *ImageExecutionConfig
		path   string
	}{{p.AdapterConfig.Execution, "adapter_config.execution"}, {p.AdapterConfig.EditExecution, "adapter_config.edit_execution"}} {
		if item.config == nil {
			continue
		}
		if item.config.Mode == ImageExecutionProviderAsync || item.config.Provider != "" {
			add("NEEDS_DEVELOPMENT", "IMAGE2PRO_ASYNC_UNAVAILABLE", item.path, "当前图片工作台尚未支持异步任务，请改用已支持的同步执行方式。")
		}
		if item.config.Mode == ImageExecutionNativeMulti && item.config.MaxOutputImages > 4 {
			add("UI_FIXABLE", "IMAGE2PRO_N_EXCEEDED", item.path+".max_output_images", "单次最多生成四张图片，请将单请求产出上限设为四张以内。")
		}
	}
	return diagnostics
}

func compileImage2ProSyncPlan(p Product, spec Spec) (imageplan.Plan, error) {
	if p.AdapterConfig.Version != 1 || p.AdapterConfig.ModelFamily != image2ProSyncFamily || p.AdapterConfig.WireProfile != "" ||
		spec.Quality != "" || spec.OutputFormat != "" || spec.Images < 0 || spec.Images > 16 || spec.Videos != 0 || spec.Audio != 0 || spec.DurationSeconds != 0 {
		return imageplan.Plan{}, fmt.Errorf("unsupported Image2Pro synchronous specification")
	}
	config := p.AdapterConfig
	if spec.Images > 0 {
		config.Execution = config.EditExecution
	}
	execution, err := PlanImageExecution(config, spec.Count)
	if err != nil || execution.Mode == ImageExecutionProviderAsync || execution.MaxOutputImages > 4 {
		return imageplan.Plan{}, fmt.Errorf("unsupported Image2Pro synchronous execution unit")
	}
	// A customer quantity is split by the existing executor. The preview and
	// full-request identity use the first unit; each unit is compiled again with
	// its own frozen output count before any network effect.
	fields := map[string]any{"model": p.UpstreamModel, "prompt": "<dry-run-prompt>", "n": execution.Units[0].OutputCount}
	if spec.Resolution != "" || spec.AspectRatio != "" {
		size, _, _, dimensionErr := ImageDimensions(p.AdapterConfig, spec)
		if dimensionErr == nil {
			fields["size"] = size
		} else if errors.Is(dimensionErr, errMissingMapping) {
			if spec.Resolution != "" {
				fields["resolution"] = spec.Resolution
			}
			if spec.AspectRatio != "" {
				fields["aspect_ratio"] = spec.AspectRatio
			}
		} else {
			return imageplan.Plan{}, dimensionErr
		}
	}
	endpoint := imageplan.Generations
	if spec.Images > 0 {
		endpoint = imageplan.Edits
		images := make([]string, spec.Images)
		for i := range images {
			images[i] = fmt.Sprintf("https://studio-preview.invalid/image/%d.png", i+1)
		}
		fields["images"] = images
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return imageplan.Plan{}, err
	}
	return imageplan.CompileImage2ProJSON(body, p.UpstreamModel, endpoint)
}

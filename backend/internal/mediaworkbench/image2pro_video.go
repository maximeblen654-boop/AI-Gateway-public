package mediaworkbench

import (
	"reflect"
	"slices"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func image2ProVideoModel(p Product) (videoplan.Model, bool) {
	c := p.AdapterConfig.Image2Pro
	if p.AdapterConfig.Version != 1 || c == nil || !c.Valid() {
		return videoplan.Model{}, false
	}
	c2 := c.Normalize()
	m := videoplan.Model{ID: p.SiteModel, Upstream: p.UpstreamModel, Status: "enabled", Mode: "image2pro", PromptMax: 6000, Image2Pro: &c2, Resolutions: []string{c2.Size}, Ratios: append([]string(nil), c2.AspectRatios...)}
	if c2.Size == "" {
		if len(p.Capabilities.Resolutions) != 1 {
			return videoplan.Model{}, false
		}
		label := p.Capabilities.Resolutions[0]
		if label == "" || len(label) > 32 || strings.TrimSpace(label) != label {
			return videoplan.Model{}, false
		}
		m.Resolutions = []string{label}
	}
	for d := c2.DurationMin; d <= c2.DurationMax; d++ {
		m.Durations = append(m.Durations, d)
	}
	m.Limits.Image = c2.MaxImages
	m.Limits.Audio = c2.MaxAudioReferences
	m.Limits.Video = c2.MaxVideoReferences
	m.Limits.Total = c2.MaxImages + c2.MaxAudioReferences + c2.MaxVideoReferences
	return m, true
}

func inheritImage2ProVideo(a *Account, p *Product) {
	// These fields are server-owned. A draft cannot manufacture supplier
	// capability, retain removed metadata or inject a foreign model snapshot.
	p.AdapterConfig.Version, p.AdapterConfig.WireProfile = 1, "image2pro"
	p.AdapterConfig.Image2Pro = nil
	if c, ok := a.Image2ProVideoCapabilities[p.UpstreamModel]; ok && c.Valid() {
		c = c.Normalize()
		p.AdapterConfig.Image2Pro = &c
	}
}

func image2ProVideoMetadataMatches(a *Account, p Product) bool {
	frozen := p.AdapterConfig.Image2Pro
	latest, ok := a.Image2ProVideoCapabilities[p.UpstreamModel]
	return frozen != nil && frozen.Valid() && ok && latest.Valid() && reflect.DeepEqual(frozen.Normalize(), latest.Normalize())
}

func validateImage2ProVideoProduct(a *Account, p Product) []Diagnostic {
	if p.MediaType != "video" {
		return nil
	}
	native := nativeAdapterKind(a, "video") == "image2pro_video"
	selected := p.AdapterConfig.WireProfile == "image2pro" || p.AdapterConfig.Image2Pro != nil
	if !native && !selected {
		return nil
	}
	if !native {
		return []Diagnostic{diagnostic("NEEDS_DEVELOPMENT", "IMAGE2PRO_VIDEO_ACCOUNT_UNSUPPORTED", p.ProductID, "adapter_config.wire_profile", "当前 Account 没有 Image2Pro 视频执行合同；如需此协议，须先核对并适配该账号。")}
	}
	if p.AdapterConfig.WireProfile != "image2pro" || !image2ProVideoMetadataMatches(a, p) {
		return []Diagnostic{diagnostic("UI_FIXABLE", "IMAGE2PRO_VIDEO_METADATA_REQUIRED", p.ProductID, "adapter_config.image2pro", "请先同步该 Account 的模型列表，再重新保存商品；视频能力缺失或已变化，当前不能发布或报价。")}
	}
	c := p.AdapterConfig.Image2Pro
	if c.Size == "" && (len(p.Capabilities.Resolutions) != 1 || !validStrings(p.Capabilities.Resolutions) || len(p.Capabilities.Resolutions[0]) > 32) {
		return []Diagnostic{diagnostic("UI_FIXABLE", "IMAGE2PRO_VIDEO_RESOLUTION_LABEL_REQUIRED", p.ProductID, "capabilities.resolutions", "该模型由上游决定输出尺寸；商品分辨率须填写一个不超过 32 个字符、无首尾空白的展示名称，不能配置多个分辨率。")}
	}
	refs := p.Capabilities.References
	canText := refs.Image.Min+refs.Audio.Min+refs.Video.Min == 0
	canReference := refs.Image.Max+refs.Audio.Max+refs.Video.Max > 0 && refs.TotalMax > 0
	if canText && !slices.Contains(c.Modes, "text") || canReference && !slices.Contains(c.Modes, "reference") {
		return []Diagnostic{diagnostic("UI_FIXABLE", "IMAGE2PRO_VIDEO_MODE_UNSUPPORTED", p.ProductID, "capabilities.references", "当前素材范围超出模型支持的输入方式；请调整参考素材数量，或同步模型后重新保存。")}
	}
	return nil
}

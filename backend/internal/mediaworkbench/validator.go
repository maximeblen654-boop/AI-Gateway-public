package mediaworkbench

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/modelmapping"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

const maxCases = 32768
const maxPreviews = 64

var dimensionPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$`)

// resolveAccountModel preserves legacy v0 snapshots' read-only view of Account's
// canonical model mapping. The exact/wildcard precedence is delegated to the
// same shared resolver used by the native Account service; a model present in
// the last successful Account catalog can pass through unchanged when there
// is no matching mapping entry.
func resolveAccountModel(a *Account, requested string) (mapped string, mappingMatched bool, catalogMatched bool) {
	if a == nil {
		return "", false, false
	}
	if mapped, matched := modelmapping.ResolveRequestedModel(a.ModelMapping, requested); matched {
		return mapped, true, false
	}
	if a.Catalog != nil && slices.Contains(a.Catalog.Models, requested) {
		return requested, false, true
	}
	return "", false, false
}

func diagnostic(class, code, scope, path, message string) Diagnostic {
	action := "Edit the indicated Draft field and save again"
	if class == "NEEDS_DEVELOPMENT" {
		action = "Develop and review the owning adapter before publishing this flow"
	}
	if class == "UI_FIXABLE" && (code == "IMAGE_EXECUTION_CAPABILITY_INVALID" || code == "IMAGE_EDIT_EXECUTION_CAPABILITY_INVALID") {
		action = "请在指示的执行字段中修正单请求产出上限，然后重新保存草稿"
	}
	if class == "UNKNOWN" {
		action = "Retry after the local dependency is available"
	}
	return Diagnostic{Class: class, Severity: "error", Code: code, Scope: scope, Path: path, Message: message, Action: action}
}

// Only ordinary single-request count conflicts are editable parameter errors.
// Unknown modes/providers still require the owning adapter to be implemented.
func invalidImageExecution(config *ImageExecutionConfig, scope, path, code, label string) Diagnostic {
	if config != nil && config.Provider == "" {
		switch config.Mode {
		case "", ImageExecutionSingle:
			return diagnostic("UI_FIXABLE", code, scope, path+".max_output_images", label+"选择了每次一张，单请求上限必须为 1。")
		case ImageExecutionNativeMulti:
			return diagnostic("UI_FIXABLE", code, scope, path+".max_output_images", label+"选择了原生多图，单请求上限必须为 2～10；若每次只输出一张，请选择每次一张。")
		}
	}
	return diagnostic("NEEDS_DEVELOPMENT", code, scope, path, label+"的执行模式或供应商批量合同尚未接通；请由技术维护者核对。")
}

// Validate has no supplier client or credential input. The bounded finite domain
// proves price uniqueness/coverage; only compact rule matchers are persisted.
func Validate(a *Account, d Draft, now time.Time) (Validation, []Offer) {
	return validateContext(context.Background(), a, d, now)
}

func validateContext(ctx context.Context, a *Account, d Draft, now time.Time) (Validation, []Offer) {
	deps := DependenciesFor(a)
	v := Validation{DraftRevision: d.Revision, Status: "PASS", PublishReady: true, CheckedAt: now, AdapterRegistryRevision: RegistryRevision, Dependencies: deps, Diagnostics: []Diagnostic{}, Previews: []Preview{}}
	if a.Catalog != nil {
		v.ModelCatalog = CatalogDependency{SyncedAt: a.Catalog.SyncedAt, SHA256: deps.CatalogSHA256}
	}
	add := func(class, code, scope, path, message string) {
		v.Diagnostics = append(v.Diagnostics, diagnostic(class, code, scope, path, message))
	}
	cancelled := func() bool {
		if ctx.Err() == nil {
			return false
		}
		v.Status, v.PublishReady = "UNKNOWN", false
		add("UNKNOWN", "VALIDATION_CANCELLED", "", "validation", "Validation request ended before completing all specifications")
		return true
	}
	if cancelled() {
		return v, nil
	}
	offers := []Offer{}
	if a.Config == nil || a.Config.SchemaVersion != 1 {
		add("UI_FIXABLE", "INVALID_SCHEMA", "", "schema_version", "Unsupported media configuration schema")
	}
	if !SupportsAccount(a) {
		add("NEEDS_DEVELOPMENT", "AUTH_FLOW_UNSUPPORTED", "", "account", "This Account authentication type has no native media adapter")
	}
	if !ValidateRouting(a) {
		add("UI_FIXABLE", "ACCOUNT_ENDPOINT_INVALID", "", "account", "Configure a valid HTTPS supplier endpoint in Account settings")
	}
	if a.Catalog == nil || a.Catalog.SyncedAt == "" {
		add("UI_FIXABLE", "MODEL_SYNC_REQUIRED", "", "model_catalog", "Synchronize the Account model catalog first")
	}
	if len(d.Products) > 100 {
		add("UI_FIXABLE", "CONFIG_TOO_LARGE", "", "products", "At most 100 products can be validated together")
		v.Status = "FAIL"
		v.PublishReady = false
		return v, nil
	}
	ids := map[string]bool{}
	enabled := 0
	for _, p := range d.Products {
		if cancelled() {
			return v, nil
		}
		if !p.Enabled || (a.Config != nil && a.Config.ProductLifecycle[p.ProductID].State == "archived") {
			continue
		}
		enabled++
		start := len(v.Diagnostics)
		pid := p.ProductID
		for name, value := range map[string]string{"product_id": pid, "site_model": p.SiteModel, "upstream_model": p.UpstreamModel} {
			if value == "" || strings.TrimSpace(value) != value || len(value) > 256 {
				add("UI_FIXABLE", "REQUIRED_FIELD", pid, name, "A nonempty bounded identifier is required")
			}
		}
		if ids[pid] {
			add("UI_FIXABLE", "DUPLICATE_PRODUCT", pid, "product_id", "Product IDs must be unique")
		}
		ids[pid] = true
		if a.Config == nil || !slices.Contains(a.Config.MediaTypes, p.MediaType) {
			add("UI_FIXABLE", "INVALID_MEDIA_TYPE", pid, "media_type", "Select an initialized media type")
		}
		if a.Catalog != nil && !slices.Contains(a.Catalog.Models, p.UpstreamModel) {
			add("UI_FIXABLE", "MODEL_NOT_DISCOVERED", pid, "upstream_model", "Upstream model is absent from the last successful snapshot")
		}
		if p.CostVersion == 0 {
			mapped, mappingMatched, catalogMatched := resolveAccountModel(a, p.SiteModel)
			if mapped != p.UpstreamModel {
				add("UI_FIXABLE", "MODEL_MAPPING_MISMATCH", pid, "upstream_model", "Account model mapping differs from the selected upstream model")
			}
			if p.SiteModel != p.UpstreamModel && !mappingMatched && !catalogMatched {
				add("UI_FIXABLE", "MODEL_MAPPING_MISMATCH", pid, "site_model", "Configure the Account model mapping")
			}
		}
		binding := AdapterBinding{}
		if a.Config != nil {
			binding = bindingsFor(a, a.Config.MediaTypes)[p.MediaType]
		}
		descriptor, known := Descriptor(binding.Kind)
		if !known {
			add("NEEDS_DEVELOPMENT", "BUILDER_REFACTOR_REQUIRED", pid, "adapter_bindings", "This flow has no shared Core CompilePlan in the selected baseline")
		} else {
			if binding.Auth != descriptor.Auth {
				add("NEEDS_DEVELOPMENT", "AUTH_FLOW_UNSUPPORTED", pid, "adapter_bindings", "Authentication profile is not supported")
			}
			if binding.TaskFlow != descriptor.TaskFlow {
				add("NEEDS_DEVELOPMENT", "TASK_FLOW_UNSUPPORTED", pid, "adapter_bindings", "Task flow is not supported by the shared builder")
			}
			if binding.Revision != descriptor.Revision {
				add("NEEDS_DEVELOPMENT", "ADAPTER_REVISION_UNSUPPORTED", pid, "adapter_bindings", "Adapter binding requires an unavailable builder revision")
			}
			if p.MediaType != descriptor.MediaType || !adapterOwnsPlatform(binding.Kind, a.Platform) {
				add("NEEDS_DEVELOPMENT", "ADAPTER_UNKNOWN", pid, "adapter_bindings", "The Account platform does not own this builder")
			}
			if p.MediaType == "image" {
				configuredProfile := binding.Kind == "openai_images" && p.AdapterConfig.Version == 1 && (p.AdapterConfig.ModelFamily == "openai_json" || p.AdapterConfig.ModelFamily == "image2pro_json" || p.AdapterConfig.ModelFamily == laoliSyncFamily) && p.AdapterConfig.WireProfile == ""
				legacyProfile := binding.Kind == "openai_images" && p.AdapterConfig.Version == 0 && p.AdapterConfig.ModelFamily == "" && p.AdapterConfig.WireProfile == "" && imageplan.IsImageModel(p.SiteModel) && imageplan.IsImageModel(p.UpstreamModel)
				inheritedProfile := p.AdapterConfig.ModelFamily == "" && p.AdapterConfig.WireProfile == "" && nativeAdapterKind(a, "image") == "openai_images"
				nativeProfile := p.AdapterConfig.Version == 1 && p.AdapterConfig.ModelFamily == nativeAdapterKind(a, "image") && binding.Kind != "openai_images"
				if !configuredProfile && !legacyProfile && !nativeProfile && !inheritedProfile {
					add("NEEDS_DEVELOPMENT", "VALUE_HARDCODED", pid, "upstream_model", "Product technical fields conflict with the native Account media adapter")
				}
			}
			if p.MediaType == "image" && (len(p.Capabilities.DurationsSeconds) > 0 || p.Capabilities.References.Video.Max > 0 || p.Capabilities.References.Audio.Max > 0) {
				add("NEEDS_DEVELOPMENT", "PARAMETER_TYPE_UNSUPPORTED", pid, "capabilities", "This image builder cannot express duration, video or audio references")
			}
			if p.MediaType == "image" {
				if binding.Kind == "gemini_images" && (len(p.Capabilities.Qualities) > 0 ||
					(p.AdapterConfig.Execution != nil && p.AdapterConfig.Execution.Mode != ImageExecutionSingle) ||
					(p.AdapterConfig.EditExecution != nil && p.AdapterConfig.EditExecution.Mode != ImageExecutionSingle)) {
					add("NEEDS_DEVELOPMENT", "NATIVE_IMAGE_PARAMETER_UNSUPPORTED", pid, "adapter_config.execution", "Native generateContent uses one output per execution unit and has no quality field")
				}
				if _, err := PlanImageExecution(p.AdapterConfig, 1); err != nil {
					v.Diagnostics = append(v.Diagnostics, invalidImageExecution(p.AdapterConfig.Execution, pid, "adapter_config.execution", "IMAGE_EXECUTION_CAPABILITY_INVALID", "文生图"))
				} else if p.AdapterConfig.Execution != nil && p.AdapterConfig.Execution.Mode == ImageExecutionProviderAsync {
					add("NEEDS_DEVELOPMENT", "IMAGE_PROVIDER_ASYNC_UNAVAILABLE", pid, "adapter_config.execution", "Native provider batch adapters use a separate queue and settlement contract")
				}
				if p.AdapterConfig.EditExecution != nil {
					edit := p.AdapterConfig
					edit.Execution = edit.EditExecution
					if _, err := PlanImageExecution(edit, 1); err != nil {
						v.Diagnostics = append(v.Diagnostics, invalidImageExecution(edit.Execution, pid, "adapter_config.edit_execution", "IMAGE_EDIT_EXECUTION_CAPABILITY_INVALID", "参考图编辑"))
					} else if edit.Execution.Mode == ImageExecutionProviderAsync {
						add("NEEDS_DEVELOPMENT", "IMAGE_PROVIDER_ASYNC_UNAVAILABLE", pid, "adapter_config.edit_execution", "Native provider batch adapters use a separate queue and settlement contract")
					}
				}
			}
		}
		if p.MediaType == "image" {
			v.Diagnostics = append(v.Diagnostics, validateImage2ProSyncProduct(a, p)...)
			v.Diagnostics = append(v.Diagnostics, validateLaoliSyncProduct(a, p)...)
		}
		v.Diagnostics = append(v.Diagnostics, validateImage2ProVideoProduct(a, p)...)
		if known && p.MediaType == "video" {
			m, ok := VideoProfileModel(p)
			if p.AdapterConfig.WireProfile == videoplan.LaoliMediaProfile && (!imagecontract.IsLaoliMediaBase(a.BaseURL) || binding.Kind != "laoli_video" || nativeAdapterKind(a, "video") != "laoli_video") {
				ok = false
			}
			if imagecontract.IsLaoliMediaBase(a.BaseURL) && binding.Kind == "laoli_video" && p.AdapterConfig.WireProfile != videoplan.LaoliMediaProfile {
				ok = false
			}
			if !ok || p.AdapterConfig.ModelFamily != "" || p.Capabilities.Count != (Range{Min: 1, Max: 1}) || len(p.Capabilities.Qualities) > 0 || len(p.AdapterConfig.SizeMappings) > 0 {
				add("NEEDS_DEVELOPMENT", "VIDEO_PROFILE_UNSUPPORTED", pid, "capabilities", "Use a supported explicit video contract, count one, and no image size mappings")
			} else {
				for _, v := range p.Capabilities.DurationsSeconds {
					if !slices.Contains(m.Durations, v) {
						add("UI_FIXABLE", "VIDEO_DURATION_UNSUPPORTED", pid, "capabilities", "Duration is outside this adapter contract")
					}
				}
				for _, v := range p.Capabilities.Resolutions {
					valid := slices.Contains(m.Resolutions, v)
					if m.Mode == "image2pro" && m.Image2Pro != nil && m.Image2Pro.Size != "" {
						valid = strings.EqualFold(m.Image2Pro.Size, v)
					}
					if !valid {
						add("UI_FIXABLE", "VIDEO_RESOLUTION_UNSUPPORTED", pid, "capabilities", "当前分辨率不在这个模型已确认的范围内")
					}
				}
				for _, v := range p.Capabilities.AspectRatios {
					if !slices.Contains(m.Ratios, v) {
						add("UI_FIXABLE", "VIDEO_RATIO_UNSUPPORTED", pid, "capabilities", "Ratio is outside this adapter contract")
					}
				}
				refs := p.Capabilities.References
				if refs.Image.Max > m.Limits.Image || refs.Video.Max > m.Limits.Video || refs.Audio.Max > m.Limits.Audio || refs.TotalMax > m.Limits.Total {
					add("UI_FIXABLE", "VIDEO_REFERENCES_UNSUPPORTED", pid, "capabilities", "Reference limit exceeds the adapter contract")
				}
			}
		}
		if len(p.Capabilities.OutputFormats) > 3 {
			add("UI_FIXABLE", "OUTPUT_FORMAT_UNSUPPORTED", pid, "capabilities.output_formats", "At most three native output formats are supported")
		}
		if len(p.Capabilities.OutputFormats) > 0 {
			seenFormats := map[string]bool{}
			for _, format := range p.Capabilities.OutputFormats {
				if !known || descriptor.Kind != "openai_images" || p.MediaType != "image" || !validOutputFormat(format) || seenFormats[format] {
					add("UI_FIXABLE", "OUTPUT_FORMAT_UNSUPPORTED", pid, "capabilities.output_formats", "Select only confirmed png/jpeg/webp formats for the OpenAI-compatible image route")
				}
				seenFormats[format] = true
			}
		}
		if !validCapabilities(p.Capabilities) {
			add("UI_FIXABLE", "INVALID_REFERENCE_LIMIT", pid, "capabilities", "Use valid bounded count/reference ranges and nonempty unique specification values")
		}
		priceRuleLimit := 100
		if p.MediaType == "video" {
			priceRuleLimit = 1024
		}
		if len(p.PricingRules) > priceRuleLimit || len(p.AdapterConfig.SizeMappings) > 1024 {
			add("UI_FIXABLE", "CONFIG_TOO_LARGE", pid, "pricing_rules", fmt.Sprintf("Use at most %d pricing rules and 1024 size mappings per product", priceRuleLimit))
			continue
		}
		if known {
			if p.Capabilities.References.TotalMax > descriptor.MaxReferences || p.Capabilities.References.Image.Max > descriptor.MaxReferences || p.Capabilities.References.Video.Max > descriptor.MaxReferences || p.Capabilities.References.Audio.Max > descriptor.MaxReferences {
				add("UI_FIXABLE", "REFERENCE_LIMIT_EXCEEDED", pid, "capabilities.references", "Reference count exceeds the native adapter limit")
			}
			for _, m := range p.AdapterConfig.SizeMappings {
				if !dimensionPattern.MatchString(m.WireSize) && m.WireSize != "auto" {
					add("UI_FIXABLE", "INVALID_VALUE_MAPPING", pid, "adapter_config.size_mappings", "Wire size must be auto or positive width x height")
				} else if p.MediaType == "image" {
					if _, _, err := validateImageMapping(m); err != nil {
						add("UI_FIXABLE", "IMAGE_SPEC_MAPPING_MISMATCH", pid, "adapter_config.size_mappings", err.Error())
					}
				}
			}
			mappingKeys := map[string]bool{}
			for _, m := range p.AdapterConfig.SizeMappings {
				k := m.Resolution + "\x00" + m.AspectRatio
				if mappingKeys[k] {
					add("UI_FIXABLE", "DUPLICATE_VALUE_MAPPING", pid, "adapter_config.size_mappings", "A size combination has multiple mappings")
				}
				mappingKeys[k] = true
			}
		}
		for i, r := range p.Capabilities.CombinationRules {
			if !validMatch(r.Deny, p.Capabilities) || emptyMatch(r.Deny) {
				add("UI_FIXABLE", "INVALID_COMBINATION_RULE", pid, fmt.Sprintf("capabilities.combination_rules.%d", i), "A deny rule must select a valid condition")
			}
		}
		for i, r := range p.PricingRules {
			path := fmt.Sprintf("pricing_rules.%d", i)
			if !validMatch(r.Match, p.Capabilities) {
				add("UI_FIXABLE", "INVALID_PRICE_MATCH", pid, path+".match", "Price conditions must be inside the configured specification domain")
			}
			if r.SalePrice == nil {
				add("UI_FIXABLE", "MISSING_PRICE", pid, path+".sale_price", "An explicit sale price is required")
				v.Diagnostics[len(v.Diagnostics)-1].Match = &p.PricingRules[i].Match
			} else if !validPrice(*r.SalePrice) {
				add("UI_FIXABLE", "INVALID_PRICE", pid, path+".sale_price", "Customer sale price must be greater than 0 CNY, with at most 8 decimal places and per_request billing")
			}
		}
		if len(v.Diagnostics) != start {
			continue
		}
		cases, err := specs(p.Capabilities, maxCases-v.CaseCount)
		if err != nil {
			add("UI_FIXABLE", "VALIDATION_MATRIX_TOO_LARGE", pid, "capabilities", "Reduce the configured domain before validating")
			continue
		}
		if len(cases) == 0 {
			add("UI_FIXABLE", "NO_SELLABLE_SPEC", pid, "capabilities.combination_rules", "All configured combinations are denied")
			continue
		}
		v.CaseCount += len(cases)
		hits := make([]int, len(p.PricingRules))
		missing, overlap, mappingMissing, compilerFailed := false, false, false, false
		missingSpecs := []Spec{}
		missingCount := 0
		for _, spec := range cases {
			if cancelled() {
				return v, nil
			}
			matched := 0
			for i, r := range p.PricingRules {
				if Matches(r.Match, spec) {
					matched++
					hits[i]++
				}
			}
			if matched == 0 {
				missing = true
				missingCount++
				if len(missingSpecs) < 8 {
					missingSpecs = append(missingSpecs, spec)
				}
			}
			if matched > 1 {
				overlap = true
			}
			plan, err := compilePlan(p, spec)
			if err != nil {
				if errors.Is(err, errMissingMapping) {
					mappingMissing = true
				} else {
					compilerFailed = true
				}
				continue
			}
			if len(v.Previews) < maxPreviews {
				v.Previews = append(v.Previews, Preview{ProductID: pid, Spec: spec, Plan: plan})
			}
		}
		if missing {
			add("UI_FIXABLE", "MISSING_PRICE", pid, "pricing_rules", "Some allowed specifications have no sale price")
			v.Diagnostics[len(v.Diagnostics)-1].Specs = missingSpecs
			v.Diagnostics[len(v.Diagnostics)-1].SpecCount = missingCount
		}
		if overlap {
			add("UI_FIXABLE", "PRICE_RULE_OVERLAP", pid, "pricing_rules", "An allowed request matches multiple prices")
		}
		if mappingMissing {
			add("UI_FIXABLE", "MISSING_VALUE_MAPPING", pid, "adapter_config.size_mappings", "Every allowed resolution/aspect-ratio combination needs a size mapping")
		}
		if compilerFailed {
			add("UNKNOWN", "LOCAL_COMPILER_FAILURE", pid, "validation", "The shared local request compiler failed unexpectedly")
		}
		for i, n := range hits {
			if n == 0 {
				add("UI_FIXABLE", "UNUSED_PRICE_RULE", pid, fmt.Sprintf("pricing_rules.%d", i), "Price rule matches no allowed request")
			}
		}
		if len(v.Diagnostics) != start {
			continue
		}
		for _, r := range p.PricingRules {
			o := Offer{ProductID: pid, AccountID: a.ID, MediaType: p.MediaType, SiteModel: p.SiteModel, UpstreamModel: p.UpstreamModel, SpecMatch: completeMatch(r.Match, p.Capabilities), SalePrice: *r.SalePrice, Adapter: binding, ResolvedConfig: p.AdapterConfig, Excluded: []Match{}}
			for _, rule := range p.Capabilities.CombinationRules {
				o.Excluded = append(o.Excluded, canonicalMatch(rule.Deny))
			}
			sort.Slice(o.Excluded, func(i, j int) bool { return hash(o.Excluded[i]) < hash(o.Excluded[j]) })
			o.CostVersion = p.CostVersion
			o.OfferID = "mw_offer_" + hash(o)
			offers = append(offers, o)
		}
	}
	if enabled == 0 {
		add("UI_FIXABLE", "NO_ENABLED_PRODUCT", "", "products", "Enable at least one configured product before publishing")
	}
	// Stable diagnostics and offer IDs across map iteration/processes.
	sort.Slice(v.Diagnostics, func(i, j int) bool { return hash(v.Diagnostics[i]) < hash(v.Diagnostics[j]) })
	sort.Slice(offers, func(i, j int) bool { return offers[i].OfferID < offers[j].OfferID })
	if len(v.Diagnostics) > 0 {
		v.Status = "FAIL"
		for _, d := range v.Diagnostics {
			if d.Class == "UNKNOWN" {
				v.Status = "UNKNOWN"
				break
			}
		}
		v.PublishReady = false
		offers = nil
	}
	if cancelled() {
		return v, nil
	}
	return v, offers
}

func validPrice(p Price) bool {
	return ValidateMediaSalePrice(p) == nil
}
func validRange(r Range, max int) bool { return r.Min >= 0 && r.Max >= r.Min && r.Max <= max }
func validStrings(values []string) bool {
	seen := map[string]bool{}
	for _, v := range values {
		if v == "" || strings.TrimSpace(v) != v || len(v) > 128 || seen[v] {
			return false
		}
		seen[v] = true
	}
	return len(values) <= 32
}
func validCapabilities(c Capabilities) bool {
	r := c.References
	if !validRange(c.Count, 10) || c.Count.Min < 1 || !validRange(r.Image, 30) || !validRange(r.Video, 30) || !validRange(r.Audio, 30) || r.TotalMax < r.Image.Min+r.Video.Min+r.Audio.Min || r.TotalMax > 30 {
		return false
	}
	if !validStrings(c.Resolutions) || !validStrings(c.AspectRatios) || !validStrings(c.Qualities) {
		return false
	}
	if len(c.DurationsSeconds) > 32 {
		return false
	}
	seen := map[int]bool{}
	for _, n := range c.DurationsSeconds {
		if n < 1 || n > 3600 || seen[n] {
			return false
		}
		seen[n] = true
	}
	return len(c.CombinationRules) <= 100
}
func emptyMatch(m Match) bool {
	return len(m.Resolution)+len(m.DurationSeconds)+len(m.AspectRatio)+len(m.Quality) == 0 && m.Count == nil && m.References == nil
}
func subset[T comparable](part, all []T) bool {
	seen := map[T]bool{}
	for _, v := range part {
		if !slices.Contains(all, v) || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func inside(r, domain Range) bool {
	return r.Min >= domain.Min && r.Max <= domain.Max && r.Max >= r.Min
}
func validMatch(m Match, c Capabilities) bool {
	// Output formats belong to the product capability, never a second price axis.
	if len(m.OutputFormats) != 0 {
		return false
	}
	if !subset(m.Resolution, c.Resolutions) || !subset(m.DurationSeconds, c.DurationsSeconds) || !subset(m.AspectRatio, c.AspectRatios) || !subset(m.Quality, c.Qualities) {
		return false
	}
	if m.Count != nil && !inside(*m.Count, c.Count) {
		return false
	}
	if r := m.References; r != nil {
		return inside(r.Image, c.References.Image) && inside(r.Video, c.References.Video) && inside(r.Audio, c.References.Audio) && r.TotalMax >= r.Image.Min+r.Video.Min+r.Audio.Min && r.TotalMax <= c.References.TotalMax
	}
	return true
}
func member[T comparable](values []T, value T) bool {
	return len(values) == 0 || slices.Contains(values, value)
}
func in(r Range, n int) bool { return n >= r.Min && n <= r.Max }
func Matches(m Match, s Spec) bool {
	if !member(m.Resolution, s.Resolution) || !member(m.DurationSeconds, s.DurationSeconds) || !member(m.AspectRatio, s.AspectRatio) || !member(m.Quality, s.Quality) || (m.Count != nil && !in(*m.Count, s.Count)) {
		return false
	}
	return m.References == nil || (in(m.References.Image, s.Images) && in(m.References.Video, s.Videos) && in(m.References.Audio, s.Audio) && s.Images+s.Videos+s.Audio <= m.References.TotalMax)
}
func validOutputFormat(format string) bool {
	return format == "png" || format == "jpeg" || format == "webp"
}

func (o Offer) Matches(s Spec) bool {
	if s.OutputFormat != "" && (o.MediaType != "image" || o.Adapter.Kind != "openai_images" || !validOutputFormat(s.OutputFormat) || !slices.Contains(o.SpecMatch.OutputFormats, s.OutputFormat)) {
		return false
	}
	if !Matches(o.SpecMatch, s) {
		return false
	}
	for _, m := range o.Excluded {
		if Matches(m, s) {
			return false
		}
	}
	return true
}
func canonicalMatch(m Match) Match {
	m.Resolution = slices.Clone(m.Resolution)
	sort.Strings(m.Resolution)
	m.AspectRatio = slices.Clone(m.AspectRatio)
	sort.Strings(m.AspectRatio)
	m.Quality = slices.Clone(m.Quality)
	sort.Strings(m.Quality)
	m.DurationSeconds = slices.Clone(m.DurationSeconds)
	sort.Ints(m.DurationSeconds)
	return m
}
func completeMatch(m Match, c Capabilities) Match {
	m.OutputFormats = slices.Clone(c.OutputFormats)
	sort.Strings(m.OutputFormats)
	if len(m.Resolution) == 0 {
		m.Resolution = choices(c.Resolutions)
	}
	if len(m.AspectRatio) == 0 {
		m.AspectRatio = choices(c.AspectRatios)
	}
	if len(m.Quality) == 0 {
		m.Quality = choices(c.Qualities)
	}
	if len(m.DurationSeconds) == 0 {
		m.DurationSeconds = choices(c.DurationsSeconds)
	}
	if m.Count == nil {
		r := c.Count
		m.Count = &r
	}
	if m.References == nil {
		r := c.References
		m.References = &r
	}
	return canonicalMatch(m)
}
func choices[T comparable](values []T) []T {
	if len(values) == 0 {
		return []T{*new(T)}
	}
	return values
}
func specs(c Capabilities, budget int) ([]Spec, error) {
	result := []Spec{}
	// Reject excessive domains before allocating or looping over the Cartesian
	// product. Safety limits here bound CPU and memory, not supplier capability.
	size := int64(1)
	for _, n := range []int{1 + len(c.OutputFormats), len(choices(c.Resolutions)), len(choices(c.AspectRatios)), len(choices(c.Qualities)), len(choices(c.DurationsSeconds)), c.Count.Max - c.Count.Min + 1, c.References.Image.Max - c.References.Image.Min + 1, c.References.Video.Max - c.References.Video.Min + 1, c.References.Audio.Max - c.References.Audio.Min + 1} {
		size *= int64(n)
		if size > maxCases {
			return nil, fmt.Errorf("matrix too large")
		}
	}
	if size > int64(budget) {
		return nil, fmt.Errorf("matrix too large")
	}
	for _, res := range choices(c.Resolutions) {
		for _, duration := range choices(c.DurationsSeconds) {
			for _, ratio := range choices(c.AspectRatios) {
				for _, quality := range choices(c.Qualities) {
					for n := c.Count.Min; n <= c.Count.Max; n++ {
						for image := c.References.Image.Min; image <= c.References.Image.Max; image++ {
							for video := c.References.Video.Min; video <= c.References.Video.Max; video++ {
								for audio := c.References.Audio.Min; audio <= c.References.Audio.Max; audio++ {
									if image+video+audio > c.References.TotalMax {
										continue
									}
									s := Spec{Resolution: res, DurationSeconds: duration, AspectRatio: ratio, Quality: quality, Count: n, Images: image, Videos: video, Audio: audio}
									denied := false
									for _, r := range c.CombinationRules {
										if Matches(r.Deny, s) {
											denied = true
											break
										}
									}
									if !denied {
										result = append(result, s)
										for _, format := range c.OutputFormats {
											s.OutputFormat = format
											result = append(result, s)
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
	return result, nil
}

// ValidateRouting only observes the configured local endpoint. It does not
// resolve DNS or contact the supplier.
func ValidateRouting(a *Account) bool {
	if a.BaseURL == "" {
		return a.Platform == "openai"
	}
	u, err := url.Parse(a.BaseURL)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && u.RawQuery == ""
}

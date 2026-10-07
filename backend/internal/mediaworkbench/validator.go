package mediaworkbench

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
)

const maxCases = 32768
const maxPreviews = 64

var amountPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?$`)
var dimensionPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$`)
var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

func diagnostic(class, code, scope, path, message string) Diagnostic {
	action := "Edit the indicated Draft field and save again"
	if class == "NEEDS_DEVELOPMENT" {
		action = "Develop and review the owning adapter before publishing this flow"
	}
	if class == "UNKNOWN" {
		action = "Retry after the local dependency is available"
	}
	return Diagnostic{Class: class, Severity: "error", Code: code, Scope: scope, Path: path, Message: message, Action: action}
}

// Validate has no supplier client or credential input. The bounded finite domain
// proves price uniqueness/coverage; only compact rule matchers are persisted.
func Validate(a *Account, d Draft, now time.Time) (Validation, []Offer) {
	deps := DependenciesFor(a)
	v := Validation{DraftRevision: d.Revision, Status: "PASS", PublishReady: true, CheckedAt: now, AdapterRegistryRevision: RegistryRevision, Dependencies: deps, Diagnostics: []Diagnostic{}, Previews: []Preview{}}
	if a.Catalog != nil {
		v.ModelCatalog = CatalogDependency{SyncedAt: a.Catalog.SyncedAt, SHA256: deps.CatalogSHA256}
	}
	add := func(class, code, scope, path, message string) {
		v.Diagnostics = append(v.Diagnostics, diagnostic(class, code, scope, path, message))
	}
	offers := []Offer{}
	if a.Config == nil || a.Config.SchemaVersion != 1 {
		add("UI_FIXABLE", "INVALID_SCHEMA", "", "schema_version", "Unsupported media configuration schema")
	}
	if a.Type != "apikey" {
		add("NEEDS_DEVELOPMENT", "AUTH_FLOW_UNSUPPORTED", "", "account", "This flow requires an API-key Account")
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
	siteModels := map[string]bool{}
	enabled := 0
	for _, p := range d.Products {
		if !p.Enabled {
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
		key := p.MediaType + "\x00" + p.SiteModel
		if siteModels[key] {
			add("UI_FIXABLE", "DUPLICATE_SITE_MODEL", pid, "site_model", "Enabled products cannot share a media type and site model")
		}
		siteModels[key] = true
		if a.Config == nil || !slices.Contains(a.Config.MediaTypes, p.MediaType) {
			add("UI_FIXABLE", "INVALID_MEDIA_TYPE", pid, "media_type", "Select an initialized media type")
		}
		if a.Catalog != nil && !slices.Contains(a.Catalog.Models, p.UpstreamModel) {
			add("UI_FIXABLE", "MODEL_NOT_DISCOVERED", pid, "upstream_model", "Upstream model is absent from the last successful snapshot")
		}
		mapped := p.SiteModel
		if m, ok := a.ResolvedModels[p.SiteModel]; ok {
			mapped = m
		} else if m, ok := a.ModelMapping[p.SiteModel]; ok {
			mapped = m
		}
		if mapped != p.UpstreamModel {
			add("UI_FIXABLE", "MODEL_MAPPING_MISMATCH", pid, "upstream_model", "Account model mapping differs from the selected upstream model")
		}
		if len(a.ModelMapping) > 0 && mapped == p.SiteModel && p.SiteModel != p.UpstreamModel {
			add("UI_FIXABLE", "MODEL_MAPPING_MISMATCH", pid, "site_model", "Configure the Account model mapping")
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
			if p.MediaType != descriptor.MediaType || a.Platform != "openai" {
				add("NEEDS_DEVELOPMENT", "ADAPTER_UNKNOWN", pid, "adapter_bindings", "The Account platform does not own this builder")
			}
			if p.MediaType == "image" && !(p.AdapterConfig.Version == 1 && p.AdapterConfig.ModelFamily == "openai_json" && p.AdapterConfig.WireProfile == "") && !(p.AdapterConfig.Version == 0 && p.AdapterConfig.ModelFamily == "" && p.AdapterConfig.WireProfile == "" && imageplan.IsImageModel(p.SiteModel) && imageplan.IsImageModel(p.UpstreamModel)) {
				add("NEEDS_DEVELOPMENT", "VALUE_HARDCODED", pid, "upstream_model", "Core Images currently accepts only its coded image-model families or the configured OpenAI Images JSON family")
			}
			if p.MediaType == "image" && (len(p.Capabilities.DurationsSeconds) > 0 || p.Capabilities.References.Video.Max > 0 || p.Capabilities.References.Audio.Max > 0) {
				add("NEEDS_DEVELOPMENT", "PARAMETER_TYPE_UNSUPPORTED", pid, "capabilities", "This image builder cannot express duration, video or audio references")
			}
		}
		if known && p.MediaType == "video" {
			m, ok := VideoProfileModel(p)
			if !ok || p.AdapterConfig.ModelFamily != "" || p.Capabilities.Count != (Range{Min: 1, Max: 1}) || len(p.Capabilities.Qualities) > 0 || len(p.AdapterConfig.SizeMappings) > 0 {
				add("NEEDS_DEVELOPMENT", "VIDEO_PROFILE_UNSUPPORTED", pid, "capabilities", "Use a supported explicit video contract, count one, and no image size mappings")
			} else {
				for _, v := range p.Capabilities.DurationsSeconds {
					if !slices.Contains(m.Durations, v) {
						add("UI_FIXABLE", "VIDEO_DURATION_UNSUPPORTED", pid, "capabilities", "Duration is outside this adapter contract")
					}
				}
				for _, v := range p.Capabilities.Resolutions {
					if !slices.Contains(m.Resolutions, v) {
						add("UI_FIXABLE", "VIDEO_RESOLUTION_UNSUPPORTED", pid, "capabilities", "Resolution is outside this adapter contract")
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
		if !validCapabilities(p.Capabilities) {
			add("UI_FIXABLE", "INVALID_REFERENCE_LIMIT", pid, "capabilities", "Use valid bounded count/reference ranges and nonempty unique specification values")
		}
		if len(p.PricingRules) > 100 || len(p.AdapterConfig.SizeMappings) > 1024 {
			add("UI_FIXABLE", "CONFIG_TOO_LARGE", pid, "pricing_rules", "Use at most 100 pricing rules and 1024 size mappings per product")
			continue
		}
		if known {
			for _, m := range p.AdapterConfig.SizeMappings {
				if !dimensionPattern.MatchString(m.WireSize) && m.WireSize != "auto" {
					add("UI_FIXABLE", "INVALID_VALUE_MAPPING", pid, "adapter_config.size_mappings", "Wire size must be auto or positive width x height")
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
			} else if !validPrice(*r.SalePrice) {
				add("UI_FIXABLE", "INVALID_PRICE", pid, path+".sale_price", "Use an exact nonnegative decimal, a three-letter currency and per_request billing")
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
		for _, spec := range cases {
			matched := 0
			for i, r := range p.PricingRules {
				if Matches(r.Match, spec) {
					matched++
					hits[i]++
				}
			}
			if matched == 0 {
				missing = true
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
	return v, offers
}

func validPrice(p Price) bool {
	return len(p.Amount) <= 80 && amountPattern.MatchString(p.Amount) && currencyPattern.MatchString(p.Currency) && p.BillingMode == "per_request"
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
	if !validRange(c.Count, 10) || c.Count.Min < 1 || !validRange(r.Image, 16) || !validRange(r.Video, 16) || !validRange(r.Audio, 16) || r.TotalMax < r.Image.Min+r.Video.Min+r.Audio.Min || r.TotalMax > 16 {
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
func (o Offer) Matches(s Spec) bool {
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
	for _, n := range []int{len(choices(c.Resolutions)), len(choices(c.AspectRatios)), len(choices(c.Qualities)), len(choices(c.DurationsSeconds)), c.Count.Max - c.Count.Min + 1, c.References.Image.Max - c.References.Image.Min + 1, c.References.Video.Max - c.References.Video.Min + 1, c.References.Audio.Max - c.References.Audio.Min + 1} {
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
									s := Spec{res, duration, ratio, quality, n, image, video, audio}
									denied := false
									for _, r := range c.CombinationRules {
										if Matches(r.Deny, s) {
											denied = true
											break
										}
									}
									if !denied {
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

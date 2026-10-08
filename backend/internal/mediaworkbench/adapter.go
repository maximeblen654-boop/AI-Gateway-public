package mediaworkbench

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func VideoProfileModel(p Product) (videoplan.Model, bool) {
	profile := p.AdapterConfig.WireProfile
	if profile == "" {
		if p.AdapterConfig.Version != 0 {
			return videoplan.Model{}, false
		}
		if legacy, ok := videoplan.Lookup(p.SiteModel); ok && legacy.Upstream == p.UpstreamModel {
			return legacy, true
		}
		return videoplan.Model{}, false
	}
	if p.AdapterConfig.Version != 1 || !videoplan.ValidWireProfile(profile) || (profile == "images" && (p.Capabilities.References.Video.Max > 0 || p.Capabilities.References.Audio.Max > 0)) {
		return videoplan.Model{}, false
	}
	m := videoplan.Model{ID: p.SiteModel, Upstream: p.UpstreamModel, Status: "enabled", Mode: profile, PromptMax: 6000,
		Durations: append([]int(nil), p.Capabilities.DurationsSeconds...), Resolutions: append([]string(nil), p.Capabilities.Resolutions...), Ratios: append([]string(nil), p.Capabilities.AspectRatios...)}
	m.Limits.Image = p.Capabilities.References.Image.Max
	m.Limits.Video = p.Capabilities.References.Video.Max
	m.Limits.Audio = p.Capabilities.References.Audio.Max
	m.Limits.Total = p.Capabilities.References.TotalMax
	return m, true
}

const RegistryRevision = "media_registry_v1_r1"

var errMissingMapping = errors.New("missing size mapping")

type SupportMode string

const (
	Passthrough  SupportMode = "passthrough"
	ConfigMap    SupportMode = "config_map"
	FixedByModel SupportMode = "fixed_by_model"
	Derived      SupportMode = "derived"
	CodeEnum     SupportMode = "code_enum"
	Unsupported  SupportMode = "unsupported"
)

type Parameter struct {
	Mode      SupportMode `json:"mode"`
	WireField string      `json:"wire_field,omitempty"`
	ValueType string      `json:"value_type,omitempty"`
}
type AdapterDescriptor struct {
	Kind          string               `json:"kind"`
	Revision      string               `json:"revision"`
	MediaType     string               `json:"media_type"`
	Auth          string               `json:"auth"`
	Transport     string               `json:"transport"`
	TaskFlow      string               `json:"task_flow"`
	Parameters    map[string]Parameter `json:"parameters"`
	MaxReferences int                  `json:"max_references"`
}
type AdapterBinding struct {
	Kind     string `json:"kind"`
	Revision string `json:"revision"`
	Auth     string `json:"auth"`
	TaskFlow string `json:"task_flow"`
}

// This registry describes the selected base commit, not the unmerged Studio
// candidate. An unsupported profile remains explicit and cannot publish.
func Descriptor(kind string) (AdapterDescriptor, bool) {
	if kind == "laoli_video" {
		return AdapterDescriptor{Kind: kind, Revision: videoplan.Revision, MediaType: "video", Auth: "account_apikey", Transport: "https_json", TaskFlow: "async", MaxReferences: 16, Parameters: map[string]Parameter{
			"model": {Mode: CodeEnum, ValueType: "video_contract_model"}, "resolution": {Mode: CodeEnum}, "aspect_ratio": {Mode: CodeEnum}, "duration_seconds": {Mode: CodeEnum}, "count": {Mode: FixedByModel, ValueType: "one"}, "quality": {Mode: Unsupported}, "reference_images": {Mode: Derived}, "reference_video": {Mode: Derived}, "reference_audio": {Mode: Derived},
		}}, true
	}
	if kind != "openai_images" {
		return AdapterDescriptor{}, false
	}
	return AdapterDescriptor{Kind: kind, Revision: "core_openai_images_json_r1", MediaType: "image", Auth: "account_apikey", Transport: "https_json", TaskFlow: "sync", MaxReferences: 16,
		Parameters: map[string]Parameter{
			"model":            {Mode: CodeEnum, WireField: "model", ValueType: "core_image_model_family"},
			"resolution":       {Mode: ConfigMap, WireField: "size", ValueType: "string"},
			"aspect_ratio":     {Mode: ConfigMap, WireField: "size", ValueType: "string"},
			"quality":          {Mode: Passthrough, WireField: "quality", ValueType: "string"},
			"count":            {Mode: Passthrough, WireField: "n", ValueType: "integer"},
			"reference_images": {Mode: Derived, WireField: "images[].image_url", ValueType: "asset_list"},
			"reference_video":  {Mode: Unsupported}, "reference_audio": {Mode: Unsupported}, "duration_seconds": {Mode: Unsupported},
		}}, true
}

func bindingsFor(a *Account, mediaTypes []string) map[string]AdapterBinding {
	out := make(map[string]AdapterBinding, len(mediaTypes))
	for _, mediaType := range mediaTypes {
		// Preserve explicit internal bindings; never infer a supplier's flow from
		// its host, model name or public docs.
		if a.Config != nil {
			if b, ok := a.Config.AdapterBindings[mediaType]; ok {
				if d, known := Descriptor(b.Kind); known {
					b.Revision = d.Revision
				}
				out[mediaType] = b
				continue
			}
		}
		if mediaType == "image" && a.Platform == "openai" {
			d, _ := Descriptor("openai_images")
			out[mediaType] = AdapterBinding{Kind: d.Kind, Revision: d.Revision, Auth: d.Auth, TaskFlow: d.TaskFlow}
		} else {
			out[mediaType] = AdapterBinding{Kind: "unbound_" + mediaType, Auth: "account_apikey"}
		}
	}
	return out
}

// Only business value mappings are accepted from Draft input. No arbitrary
// wire fields, URLs, headers, credentials, expressions or task-flow overrides.
type SizeMapping struct {
	Resolution  string `json:"resolution"`
	AspectRatio string `json:"aspect_ratio"`
	WireSize    string `json:"wire_size"`
}
type ImageConfig struct {
	Version      int           `json:"version,omitempty"`
	SizeMappings []SizeMapping `json:"size_mappings"`
	WireProfile  string        `json:"wire_profile,omitempty"`
	ModelFamily  string        `json:"model_family,omitempty"`
}
type Spec struct {
	Resolution      string `json:"resolution"`
	DurationSeconds int    `json:"duration_seconds"`
	AspectRatio     string `json:"aspect_ratio"`
	Quality         string `json:"quality"`
	Count           int    `json:"count"`
	Images          int    `json:"images"`
	Videos          int    `json:"videos"`
	Audio           int    `json:"audio"`
}
type Preview struct {
	ProductID string `json:"product_id"`
	Spec      Spec   `json:"spec"`
	imageplan.Plan
}

func compilePlan(p Product, spec Spec) (imageplan.Plan, error) {
	if p.MediaType == "video" {
		m, ok := VideoProfileModel(p)
		if !ok {
			return imageplan.Plan{}, fmt.Errorf("unsupported video wire profile")
		}
		v, e := videoplan.PreviewWithModel(m, p.UpstreamModel, spec.Resolution, spec.AspectRatio, spec.DurationSeconds, spec.Images, spec.Videos, spec.Audio)
		if e != nil {
			return imageplan.Plan{}, e
		}
		fields := map[string]any{}
		if e = json.Unmarshal(v.Body, &fields); e != nil {
			return imageplan.Plan{}, e
		}
		// This DTO is only a preview; executable video plans use videoplan.Plan.
		return imageplan.Plan{Method: v.Method, Path: v.Path, Encoding: "application/json", Fields: fields, Omitted: []string{}, AssetSlots: []imageplan.AssetSlot{}}, nil
	}

	fields := map[string]any{"model": p.SiteModel, "prompt": "<dry-run-prompt>", "n": spec.Count}
	if spec.Resolution != "" || spec.AspectRatio != "" {
		size, _, _, err := ImageDimensions(p.AdapterConfig, spec)
		if err != nil {
			return imageplan.Plan{}, err
		}
		fields["size"] = size
	}
	if spec.Quality != "" {
		fields["quality"] = spec.Quality
	}
	endpoint := imageplan.Generations
	if spec.Images > 0 {
		endpoint = imageplan.Edits
		images := make([]map[string]string, 0, spec.Images)
		for i := 1; i <= spec.Images; i++ {
			images = append(images, map[string]string{"image_url": fmt.Sprintf("<image:%d>", i)})
		}
		fields["images"] = images
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return imageplan.Plan{}, err
	}
	return imageplan.CompileJSON(body, p.UpstreamModel, endpoint)
}

type Dependencies struct {
	AccountID        int64  `json:"account_id"`
	RoutingSHA256    string `json:"routing_sha256"`
	CatalogSHA256    string `json:"catalog_sha256"`
	MappingSHA256    string `json:"mapping_sha256"`
	BindingSHA256    string `json:"binding_sha256"`
	RegistryRevision string `json:"registry_revision"`
}

func hash(v any) string { b, _ := json.Marshal(v); return fmt.Sprintf("%x", sha256.Sum256(b)) }

func DependenciesFor(a *Account) Dependencies {
	bindings := map[string]AdapterBinding{}
	if a.Config != nil {
		bindings = bindingsFor(a, a.Config.MediaTypes)
	}
	u, _ := url.Parse(a.BaseURL)
	endpoint := ""
	if u != nil {
		endpoint = strings.ToLower(u.Scheme+"://"+u.Host) + u.EscapedPath()
	} // excludes userinfo and query
	return Dependencies{AccountID: a.ID, RoutingSHA256: hash([]string{a.Platform, a.Type, endpoint, a.RoutingFingerprint}), CatalogSHA256: hash(a.Catalog), MappingSHA256: hash(a.ModelMapping), BindingSHA256: hash(bindings), RegistryRevision: RegistryRevision}
}

func publishedRevision(p *Published) string {
	return "mwp_" + hash(struct {
		Source       string
		Products     []Product
		Offers       []Offer
		Dependencies Dependencies
	}{p.SourceDraftRevision, p.Products, p.Offers, p.Dependencies})
}
func publishedReady(a *Account) bool {
	if a.Type != "apikey" || a.Status != "active" || !a.Schedulable || !a.RuntimeReady || a.Config == nil {
		return false
	}
	p := a.Config.Published
	if p == nil || len(p.Offers) == 0 || p.Dependencies != DependenciesFor(a) || p.Revision != publishedRevision(p) {
		return false
	}
	// Validate the immutable Published products rather than a newer/incomplete
	// Draft. An edit failure must not interrupt previously published sales.
	v, offers := Validate(a, Draft{Revision: p.SourceDraftRevision, Products: p.Products}, p.PublishedAt)
	return v.PublishReady && hash(offers) == hash(p.Offers)
}

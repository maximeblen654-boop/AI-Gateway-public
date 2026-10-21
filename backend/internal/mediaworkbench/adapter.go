package mediaworkbench

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func VideoProfileModel(p Product) (videoplan.Model, bool) {
	profile := p.AdapterConfig.WireProfile
	if profile == "image2pro" {
		return image2ProVideoModel(p)
	}
	// An explicit wire profile must not turn a known model's declared product
	// capabilities into its own authority, bypassing fixed reference/duration limits.
	if known, ok := videoplan.DocumentedModel(p.SiteModel); ok && known.Upstream == p.UpstreamModel {
		if known.Status != "enabled" || profile != "" && (p.AdapterConfig.Version != 1 || profile != known.Mode) {
			return videoplan.Model{}, false
		}
		if profile == "" && p.AdapterConfig.Version != 0 {
			return videoplan.Model{}, false
		}
		return known, true
	}
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
	if profile == "seedance" && p.Capabilities.References.Video.Max > 0 {
		return videoplan.Model{}, false
	}
	if profile == "grok" && (p.Capabilities.References.Image.Max > 1 || p.Capabilities.References.Video.Max > 0 || p.Capabilities.References.Audio.Max > 0) {
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

// Descriptors expose the installed native adapters, not supplier-tested model
// capabilities. Unsupported contracts remain explicit and cannot publish.
func Descriptor(kind string) (AdapterDescriptor, bool) {
	if kind == "image2pro_video" {
		return AdapterDescriptor{Kind: kind, Revision: videoplan.Image2ProRevision, MediaType: "video", Auth: "account_apikey", Transport: "https_json", TaskFlow: "async", MaxReferences: 13, Parameters: map[string]Parameter{"model": {Mode: CodeEnum, ValueType: "account_public_video_model"}, "resolution": {Mode: FixedByModel, ValueType: "metadata.size"}, "aspect_ratio": {Mode: CodeEnum, WireField: "ratio"}, "duration_seconds": {Mode: CodeEnum, WireField: "duration"}, "count": {Mode: FixedByModel, ValueType: "one"}, "quality": {Mode: Unsupported}, "reference_images": {Mode: Derived, WireField: "images[]"}, "reference_audio": {Mode: Derived, WireField: "audios[].mediaId"}, "reference_video": {Mode: Derived, WireField: "videos[].mediaId"}}}, true
	}
	if kind == "grok_video" {
		d, _ := Descriptor("laoli_video")
		d.Kind, d.Revision, d.Auth, d.MaxReferences = kind, videoplan.GrokRevision, "account_native", 1
		return d, true
	}
	if kind == "seedance_video" {
		return AdapterDescriptor{Kind: kind, Revision: "core_seedance_video_r1", MediaType: "video", Auth: "account_native", Transport: "https_json", TaskFlow: "async", MaxReferences: 16, Parameters: map[string]Parameter{
			"model": {Mode: CodeEnum, ValueType: "account_model_mapping"}, "resolution": {Mode: Passthrough, WireField: "resolution"}, "aspect_ratio": {Mode: Passthrough, WireField: "aspect_ratio"}, "duration_seconds": {Mode: Passthrough, WireField: "duration"}, "count": {Mode: FixedByModel, ValueType: "one"}, "reference_images": {Mode: Derived, WireField: "content[].image_url"}, "reference_video": {Mode: Unsupported}, "reference_audio": {Mode: Derived, WireField: "content[].audio_url"},
		}}, true
	}
	if kind == "grok_images" || kind == "gemini_images" || kind == "openai_images_oauth" {
		d, _ := Descriptor("openai_images")
		d.Kind, d.Revision, d.Auth = kind, "core_"+kind+"_r1", "account_native"
		if kind == "grok_images" {
			d.MaxReferences = 3
			d.Parameters["resolution"] = Parameter{Mode: Passthrough, WireField: "resolution"}
			d.Parameters["aspect_ratio"] = Parameter{Mode: Passthrough, WireField: "aspect_ratio"}
		} // native Grok edit parser limit
		if kind == "gemini_images" {
			d.Parameters["resolution"] = Parameter{Mode: Passthrough, WireField: "generationConfig.imageConfig.imageSize"}
			d.Parameters["aspect_ratio"] = Parameter{Mode: Passthrough, WireField: "generationConfig.imageConfig.aspectRatio"}
			d.Parameters["quality"] = Parameter{Mode: Unsupported}
			d.Parameters["count"] = Parameter{Mode: FixedByModel, ValueType: "one"}
		}
		if kind == "openai_images_oauth" {
			// Native direct-images/Responses consume pixel size, not these JSON extensions.
			d.Parameters["resolution"] = Parameter{Mode: ConfigMap, WireField: "size"}
			d.Parameters["aspect_ratio"] = Parameter{Mode: ConfigMap, WireField: "size"}
		}
		return d, true
	}
	if kind == "laoli_video" {
		return AdapterDescriptor{Kind: kind, Revision: videoplan.Revision, MediaType: "video", Auth: "account_apikey", Transport: "https_json", TaskFlow: "async", MaxReferences: 30, Parameters: map[string]Parameter{
			"model": {Mode: CodeEnum, ValueType: "video_contract_model"}, "resolution": {Mode: CodeEnum}, "aspect_ratio": {Mode: CodeEnum}, "duration_seconds": {Mode: CodeEnum}, "count": {Mode: FixedByModel, ValueType: "one"}, "quality": {Mode: Unsupported}, "reference_images": {Mode: Derived}, "reference_video": {Mode: Derived}, "reference_audio": {Mode: Derived},
		}}, true
	}
	if kind != "openai_images" {
		return AdapterDescriptor{}, false
	}
	return AdapterDescriptor{Kind: kind, Revision: "core_openai_images_json_r1", MediaType: "image", Auth: "account_apikey", Transport: "https_json", TaskFlow: "sync", MaxReferences: 16,
		Parameters: map[string]Parameter{
			"model":            {Mode: CodeEnum, WireField: "model", ValueType: "core_image_model_family"},
			"resolution":       {Mode: Passthrough, WireField: "resolution", ValueType: "string"},
			"aspect_ratio":     {Mode: Passthrough, WireField: "aspect_ratio", ValueType: "string"},
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
				if mediaType == "video" && nativeAdapterKind(a, "video") == "image2pro_video" && (b.Kind == "laoli_video" || b.Kind == "unbound_video") {
					d, _ := Descriptor("image2pro_video")
					out[mediaType] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
					continue
				}
				if b.Kind == "unbound_"+mediaType && nativeAdapterKind(a, mediaType) != "" {
					// An old draft may have recorded the temporary unbound marker
					// before the Account's native adapter became available. Resolve
					// that marker during the normal save/read path instead of
					// dropping the media type from the returned binding map.
					kind := nativeAdapterKind(a, mediaType)
					d, known := Descriptor(kind)
					if known {
						out[mediaType] = AdapterBinding{Kind: d.Kind, Revision: d.Revision, Auth: d.Auth, TaskFlow: d.TaskFlow}
						continue
					}
				}
				if d, known := Descriptor(b.Kind); known {
					b.Revision = d.Revision
				}
				out[mediaType] = b
				continue
			}
		}
		if kind := nativeAdapterKind(a, mediaType); kind != "" {
			d, _ := Descriptor(kind)
			out[mediaType] = AdapterBinding{Kind: d.Kind, Revision: d.Revision, Auth: d.Auth, TaskFlow: d.TaskFlow}
		} else {
			out[mediaType] = AdapterBinding{Kind: "unbound_" + mediaType, Auth: "account_apikey"}
		}
	}
	return out
}

// Account platform/type already selects the native gateway protocol. This is
// a local adapter inventory, not a claim that a supplier/model was probed.
func nativeAdapterKind(a *Account, mediaType string) string {
	if mediaType == "video" && a.Platform == "openai" && a.Type == "apikey" && imagecontract.IsImage2ProBase(a.BaseURL) {
		return "image2pro_video"
	}
	if mediaType == "video" && a.Platform == "grok" && (a.Type == "apikey" || a.Type == "oauth") {
		return "grok_video"
	}
	if mediaType == "video" && a.Platform == "openai" && a.Type == "apikey" && slices.Contains(a.EndpointCapabilities, "seedance") {
		return "seedance_video"
	}
	if mediaType == "video" && a.Platform == "openai" && a.Type == "apikey" {
		// The existing OpenAI-compatible video contract is selected by the
		// Account's native platform/type. It is intentionally model-agnostic:
		// the catalog and frozen upstream mapping still decide the model and
		// accepted values, while the product draft must not require an operator
		// to copy a wire profile from a prior Studio product.
		return "laoli_video"
	}
	if mediaType == "image" {
		switch a.Platform {
		case "openai":
			if a.Type == "apikey" {
				return "openai_images"
			}
			if a.Type == "oauth" || a.Type == "setup-token" {
				return "openai_images_oauth"
			}
		case "grok":
			if a.Type == "apikey" || a.Type == "oauth" {
				return "grok_images"
			}
		case "gemini":
			if a.Type == "apikey" || a.Type == "oauth" || a.Type == "service_account" {
				return "gemini_images"
			}
		}
	}
	return ""
}

func SupportsAccount(a *Account) bool {
	return a.Type == "apikey" || nativeAdapterKind(a, "image") != "" || nativeAdapterKind(a, "video") != ""
}

func adapterOwnsPlatform(kind, platform string) bool {
	switch kind {
	case "openai_images", "openai_images_oauth", "laoli_video", "seedance_video", "image2pro_video":
		return platform == "openai"
	case "grok_images", "grok_video":
		return platform == "grok"
	case "gemini_images":
		return platform == "gemini"
	}
	return false
}

// Only explicit draft saves acquire defaults. Published products and historical
// quotes retain their original configuration and hashes.
func inheritNativeProduct(a *Account, p *Product) {
	// Older Studio drafts could accidentally persist the generated product ID
	// as site_model. Keep that legacy draft readable, but stop carrying the
	// internal product identity into the model contract on the next explicit
	// save. Real Account aliases remain untouched.
	if p != nil && p.UpstreamModel != "" && strings.HasPrefix(p.SiteModel, "media-") && p.SiteModel == p.ProductID {
		p.SiteModel = p.UpstreamModel
	}
	if p.MediaType == "video" && nativeAdapterKind(a, "video") == "image2pro_video" {
		inheritImage2ProVideo(a, p)
		return
	}
	if p.MediaType == "image" && inheritImage2ProSyncProduct(a, p) {
		return
	}
	if p.MediaType == "video" && nativeAdapterKind(a, "video") == "grok_video" && p.AdapterConfig.WireProfile == "" {
		p.AdapterConfig.Version, p.AdapterConfig.WireProfile = 1, "grok"
	}
	if p.MediaType == "video" && nativeAdapterKind(a, "video") == "seedance_video" && p.AdapterConfig.WireProfile == "" {
		p.AdapterConfig.Version, p.AdapterConfig.WireProfile = 1, "seedance"
	}
	if p.MediaType == "video" && nativeAdapterKind(a, "video") == "laoli_video" && p.AdapterConfig.WireProfile == "" {
		// Keep the immutable legacy catalog contract for existing model IDs.
		// New discovered IDs use the same compatible transport with a profile
		// derived from their declared reference domain.
		if legacy, ok := videoplan.Lookup(p.SiteModel); ok && legacy.Upstream == p.UpstreamModel {
			return
		}
		profile := "images"
		if p.Capabilities.References.Video.Max > 0 || p.Capabilities.References.Audio.Max > 0 {
			profile = "inline_multimedia"
		}
		p.AdapterConfig.Version, p.AdapterConfig.WireProfile = 1, profile
	}
	if p.MediaType != "image" || p.AdapterConfig.ModelFamily != "" || p.AdapterConfig.WireProfile != "" {
		return
	}
	switch nativeAdapterKind(a, "image") {
	case "openai_images":
		// The native Account adapter is authoritative; no protocol selection or
		// synthetic model-family value is needed in an ordinary product draft.
	case "grok_images", "gemini_images", "openai_images_oauth":
		p.AdapterConfig.Version, p.AdapterConfig.ModelFamily = 1, nativeAdapterKind(a, "image")
	}
}

// Only business value mappings are accepted from Draft input. No arbitrary
// wire fields, URLs, headers, credentials, expressions or task-flow overrides.
type SizeMapping struct {
	Resolution  string `json:"resolution"`
	AspectRatio string `json:"aspect_ratio"`
	WireSize    string `json:"wire_size"`
}
type ImageConfig struct {
	Version       int                              `json:"version,omitempty"`
	SizeMappings  []SizeMapping                    `json:"size_mappings"`
	WireProfile   string                           `json:"wire_profile,omitempty"`
	ModelFamily   string                           `json:"model_family,omitempty"`
	Execution     *ImageExecutionConfig            `json:"execution,omitempty"`
	EditExecution *ImageExecutionConfig            `json:"edit_execution,omitempty"`
	Image2Pro     *videoplan.Image2ProCapabilities `json:"image2pro,omitempty"`
}

// ImageExecutionConfig records only capabilities that were explicitly
// verified for the bound Account/model/interface. An omitted configuration is
// deliberately conservative: one normal image per upstream request.
type ImageExecutionMode string

const (
	ImageExecutionSingle        ImageExecutionMode = "single"
	ImageExecutionNativeMulti   ImageExecutionMode = "native_multi"
	ImageExecutionProviderAsync ImageExecutionMode = "provider_async"
)

type ImageExecutionConfig struct {
	Mode            ImageExecutionMode `json:"mode,omitempty"`
	MaxOutputImages int                `json:"max_output_images,omitempty"`
	Provider        string             `json:"provider,omitempty"`
}

type ImageExecutionUnit struct {
	Index        int                `json:"index"`
	OutputOffset int                `json:"output_offset"`
	OutputCount  int                `json:"output_count"`
	Mode         ImageExecutionMode `json:"mode"`
	Provider     string             `json:"provider,omitempty"`
}

type ImageExecutionPlan struct {
	Mode            ImageExecutionMode   `json:"mode"`
	Provider        string               `json:"provider,omitempty"`
	MaxOutputImages int                  `json:"max_output_images"`
	Units           []ImageExecutionUnit `json:"units"`
}

// PlanImageExecution turns a frozen customer quantity into durable upstream
// units. It never infers capability from a model name, protocol shape or the
// presence of an n field.
func PlanImageExecution(config ImageConfig, quantity int) (ImageExecutionPlan, error) {
	if quantity < 1 || quantity > 10 {
		return ImageExecutionPlan{}, ErrRuntimeBinding
	}
	mode := ImageExecutionSingle
	max := 1
	provider := ""
	if config.Execution != nil {
		if config.Execution.MaxOutputImages < 0 {
			return ImageExecutionPlan{}, ErrRuntimeBinding
		}
		if config.Execution.Mode != "" {
			mode = config.Execution.Mode
		}
		if config.Execution.MaxOutputImages > 0 {
			max = config.Execution.MaxOutputImages
		}
		provider = config.Execution.Provider
	}
	if mode != ImageExecutionProviderAsync && provider != "" {
		return ImageExecutionPlan{}, ErrRuntimeBinding
	}
	switch mode {
	case ImageExecutionSingle:
		if max != 1 {
			return ImageExecutionPlan{}, ErrRuntimeBinding
		}
	case ImageExecutionNativeMulti:
		if max < 2 || max > 10 {
			return ImageExecutionPlan{}, ErrRuntimeBinding
		}
	case ImageExecutionProviderAsync:
		if provider != "gemini_api" && provider != "vertex" || max < 1 || max > 10 {
			return ImageExecutionPlan{}, ErrRuntimeBinding
		}
	default:
		return ImageExecutionPlan{}, ErrRuntimeBinding
	}
	units := make([]ImageExecutionUnit, 0, (quantity+max-1)/max)
	remaining, offset := quantity, 0
	for i := 0; remaining > 0; i++ {
		count := remaining
		if count > max {
			count = max
		}
		units = append(units, ImageExecutionUnit{Index: i, OutputOffset: offset, OutputCount: count, Mode: mode, Provider: provider})
		offset += count
		remaining -= count
	}
	return ImageExecutionPlan{Mode: mode, Provider: provider, MaxOutputImages: max, Units: units}, nil
}

type Spec struct {
	OutputFormat    string `json:"output_format,omitempty"`
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

	if p.AdapterConfig.ModelFamily == "image2pro_json" {
		return compileImage2ProSyncPlan(p, spec)
	}
	fields := map[string]any{"model": p.SiteModel, "prompt": "<dry-run-prompt>", "n": spec.Count}
	if spec.OutputFormat != "" {
		if !validOutputFormat(spec.OutputFormat) || (p.AdapterConfig.ModelFamily != "" && p.AdapterConfig.ModelFamily != "openai_json") {
			return imageplan.Plan{}, fmt.Errorf("unsupported native output format")
		}
		fields["output_format"] = spec.OutputFormat
	}
	if p.AdapterConfig.ModelFamily == "gemini_images" {
		if spec.Resolution != "" {
			fields["image_size"] = spec.Resolution
		}
		if spec.AspectRatio != "" {
			fields["aspect_ratio"] = spec.AspectRatio
		}
	} else if p.AdapterConfig.ModelFamily == "grok_images" {
		if spec.Resolution != "" {
			fields["resolution"] = spec.Resolution
		}
		if spec.AspectRatio != "" {
			fields["aspect_ratio"] = spec.AspectRatio
		}
	} else if spec.Resolution != "" || spec.AspectRatio != "" {
		size, _, _, err := ImageDimensions(p.AdapterConfig, spec)
		if err == nil {
			fields["size"] = size
		} else if errors.Is(err, errMissingMapping) && p.AdapterConfig.ModelFamily != "openai_images_oauth" {
			// ForwardImages API-key JSON preserves these native request fields.
			// Keep the sold specification verbatim; do not guess K-to-pixel sizes.
			// Explicit historical mappings still take precedence above.
			if spec.Resolution != "" {
				fields["resolution"] = spec.Resolution
			}
			if spec.AspectRatio != "" {
				fields["aspect_ratio"] = spec.AspectRatio
			}
		} else {
			return imageplan.Plan{}, err
		}
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
	mapping := hash(a.ModelMapping)
	if a.Config != nil && directProducts(a.Config.Draft.Products) {
		mapping = "studio-exact-v1"
	}
	catalogHash := hash(a.Catalog)
	if len(a.Image2ProVideoCapabilities) > 0 {
		catalogHash = hash(struct {
			Catalog *Catalog
			Video   map[string]videoplan.Image2ProCapabilities
		}{a.Catalog, a.Image2ProVideoCapabilities})
	}
	return Dependencies{AccountID: a.ID, RoutingSHA256: hash([]string{a.Platform, a.Type, endpoint, a.RoutingFingerprint}), CatalogSHA256: catalogHash, MappingSHA256: mapping, BindingSHA256: hash(bindings), RegistryRevision: RegistryRevision}
}

func directProducts(products []Product) bool {
	direct := false
	for _, p := range products {
		if p.Enabled && p.CostVersion == 0 {
			return false
		}
		if p.Enabled && p.CostVersion >= 1 {
			direct = true
		}
	}
	return direct
}

// Published dependency checks only bind catalog membership of the models sold.
// Draft validation/CAS deliberately keep the complete snapshot in DependenciesFor.
const publishedCatalogPrefix = "published-models-v1:"

func dependenciesForProducts(a *Account, products []Product) Dependencies {
	d := DependenciesFor(a)
	if directProducts(products) {
		d.MappingSHA256 = "studio-exact-v1"
	} else {
		d.MappingSHA256 = hash(a.ModelMapping)
	}
	models := map[string]bool{}
	videoMetadata := map[string]*videoplan.Image2ProCapabilities{}
	for _, p := range products {
		if p.Enabled {
			models[p.UpstreamModel] = a.Catalog != nil && slices.Contains(a.Catalog.Models, p.UpstreamModel)
			if p.AdapterConfig.WireProfile == "image2pro" {
				if c, ok := a.Image2ProVideoCapabilities[p.UpstreamModel]; ok {
					c = c.Normalize()
					videoMetadata[p.UpstreamModel] = &c
				} else {
					videoMetadata[p.UpstreamModel] = nil
				}
			}
		}
	}
	d.CatalogSHA256 = publishedCatalogPrefix + hash(models)
	if len(videoMetadata) > 0 {
		d.CatalogSHA256 = publishedCatalogPrefix + hash(struct {
			Models map[string]bool
			Video  map[string]*videoplan.Image2ProCapabilities
		}{models, videoMetadata})
	}
	return d
}

// Legacy snapshots retain exact comparison until explicitly revalidated. Unknown
// scopes fail closed; reading a snapshot never rewrites it or upgrades its scope.
func PublishedDependenciesFor(a *Account) Dependencies {
	d := DependenciesFor(a)
	d.MappingSHA256 = hash(a.ModelMapping) // original immutable snapshot semantics
	if a.Config != nil && a.Config.Published != nil && strings.HasPrefix(a.Config.Published.Dependencies.CatalogSHA256, publishedCatalogPrefix) {
		return dependenciesForProducts(a, a.Config.Published.Products)
	}
	return d
}

func publishedRevision(p *Published) string {
	return "mwp_" + hash(struct {
		Source              string
		Products            []Product
		Offers              []Offer
		Dependencies        Dependencies
		ProductDependencies map[string]Dependencies `json:",omitempty"`
	}{p.SourceDraftRevision, p.Products, p.Offers, p.Dependencies, p.ProductDependencies})
}
func publishedReady(a *Account) bool {
	return publishedReadyContext(context.Background(), a)
}

func publishedReadyContext(ctx context.Context, a *Account) bool {
	return publishedReadyWithValidation(ctx, a, publishedSnapshotValidator(ctx, a))
}

func publishedReadyWithValidation(ctx context.Context, a *Account, ready func(string) bool) bool {
	if a != nil && a.Config != nil && a.Config.Published != nil {
		for _, o := range a.Config.Published.Offers {
			if ctx.Err() != nil {
				return false
			}
			if ready(o.ProductID) {
				return true
			}
		}
		return false
	}
	return false
}

func legacyPublishedReady(ctx context.Context, a *Account) bool {
	if !SupportsAccount(a) || a.Status != "active" || !a.Schedulable || !a.RuntimeReady || a.Config == nil {
		return false
	}
	p := a.Config.Published
	if p == nil || len(p.Offers) == 0 || p.Dependencies != PublishedDependenciesFor(a) || p.Revision != publishedRevision(p) {
		return false
	}
	// Validate the immutable Published products rather than a newer/incomplete
	// Draft. An edit failure must not interrupt previously published sales.
	copyAccount, copyConfig := *a, *a.Config
	copyConfig.ProductLifecycle = nil // Validate immutable offers; current availability is checked per product.
	copyAccount.Config = &copyConfig
	v, offers := validateContext(ctx, &copyAccount, Draft{Revision: p.SourceDraftRevision, Products: p.Products}, p.PublishedAt)
	return v.PublishReady && hash(offers) == hash(p.Offers)
}

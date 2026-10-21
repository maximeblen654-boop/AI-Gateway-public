// Package mediaworkbench owns the Account-scoped Studio configuration boundary.
// It has no supplier client, scheduler, pricing fallback or dispatch dependency.
package mediaworkbench

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"

	apperrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

const ExtraKey = "media_workbench_v1"
const CatalogKey = "upstream_model_catalog_snapshot"

var (
	ErrLegacyPublish = apperrors.New(409, "MEDIA_PUBLISHED_RECOVERY_REQUIRED", "Historical published configuration requires controlled revalidation before selective publishing; no draft was published")
	ErrNotFound      = apperrors.New(404, "MEDIA_ACCOUNT_NOT_FOUND", "Account not found or deleted")
	ErrStale         = apperrors.New(409, "STALE_MEDIA_CONFIG", "Media configuration changed; reload before saving")
	ErrInvalid       = apperrors.New(400, "INVALID_MEDIA_CONFIG", "Invalid media configuration")
	ErrUninitialized = apperrors.New(409, "MEDIA_NOT_INITIALIZED", "Initialize the media workbench first")
	ErrUnsupported   = apperrors.New(422, "MEDIA_APIKEY_REQUIRED", "Media suppliers require an API-key Account")
	ErrSales         = apperrors.New(422, "MEDIA_SALES_NOT_READY", "Sales require an active schedulable Account and valid published offers")
	ErrValidation    = apperrors.New(422, "MEDIA_VALIDATION_FAILED", "Draft saved but validation does not permit publishing")
)

type Config struct {
	SchemaVersion int      `json:"schema_version"`
	RecordVersion int64    `json:"record_version"`
	MediaTypes    []string `json:"media_types"`
	// Decode accepted phase-1 records; new responses use typed bindings only.
	AdapterBinding  *Diagnostic               `json:"adapter_binding,omitempty"`
	AdapterBindings map[string]AdapterBinding `json:"adapter_bindings"`
	Sales           Sales                     `json:"sales"`
	Draft           Draft                     `json:"draft"`
	Validation      Validation                `json:"validation"`
	Published       *Published                `json:"published"`
	Procurement     Procurement               `json:"procurement"`
	// Retain removed blank drafts; removing an editor entry is not a hard delete.
	RemovedDraftProducts []Product                   `json:"removed_draft_products,omitempty"`
	ProductLifecycle     map[string]ProductLifecycle `json:"product_lifecycle,omitempty"`
	HiddenModels         []string                    `json:"hidden_models,omitempty"`
}
type Sales struct {
	Enabled bool `json:"enabled"`
	// Nil preserves unknown sales history in configurations created before this
	// field existed. Only a successful explicit enable establishes true.
	HasEverEnabled *bool     `json:"has_ever_enabled,omitempty"`
	UpdatedAt      time.Time `json:"updated_at"`
}
type Draft struct {
	Revision                 string       `json:"revision"`
	BasedOnPublishedRevision string       `json:"based_on_published_revision"`
	UpdatedAt                time.Time    `json:"updated_at"`
	Products                 []Product    `json:"products"`
	SaveReceipt              *SaveReceipt `json:"save_receipt,omitempty"`
}

// SaveReceipt identifies the write that persisted this draft. It deliberately
// contains no business fields, credentials or validation results.
type SaveReceipt struct {
	SubmissionID      string `json:"submission_id"`
	BaseRecordVersion int64  `json:"base_record_version"`
	DraftRevision     string `json:"draft_revision"`
}

// DraftInput deliberately excludes server-owned revisions and timestamps.
type DraftInput struct {
	Products         []Product `json:"products"`
	RemoveProductIDs []string  `json:"remove_product_ids,omitempty"`
	// The HTTP handler supplies request context separately from editable draft
	// fields. A caller cannot submit a forged save_receipt inside draft.
	SubmissionID string `json:"-"`
}

var submissionIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Product struct {
	ProductID string `json:"product_id"`
	MediaType string `json:"media_type"`
	// SiteModel is the customer-facing model identity used for offer selection
	// and Group permissions. V1 dispatch binds UpstreamModel directly; v0
	// snapshots retain their historical Account alias contract.
	SiteModel   string `json:"site_model"`
	DisplayName string `json:"display_name"`
	// UpstreamModel is the exact Account catalog model captured by the product.
	// New Studio contracts do not resolve it through the API model mapping.
	UpstreamModel string        `json:"upstream_model"`
	Enabled       bool          `json:"enabled"`
	Capabilities  Capabilities  `json:"capabilities"`
	PricingRules  []PricingRule `json:"pricing_rules"`
	// Server-owned discriminator. Absent on immutable historical snapshots.
	CostVersion   int         `json:"cost_version,omitempty"`
	CostRules     []CostRule  `json:"cost_rules,omitempty"`
	AdapterConfig ImageConfig `json:"adapter_config"`
}
type Range struct {
	Min int `json:"min"`
	Max int `json:"max"`
}
type References struct {
	Image    Range `json:"image"`
	Video    Range `json:"video"`
	Audio    Range `json:"audio"`
	TotalMax int   `json:"total_max"`
}
type Match struct {
	OutputFormats   []string    `json:"output_formats,omitempty"`
	Resolution      []string    `json:"resolution,omitempty"`
	DurationSeconds []int       `json:"duration_seconds,omitempty"`
	AspectRatio     []string    `json:"aspect_ratio,omitempty"`
	Quality         []string    `json:"quality,omitempty"`
	Count           *Range      `json:"count,omitempty"`
	References      *References `json:"references,omitempty"`
}
type CombinationRule struct {
	Deny Match `json:"deny"`
}
type Capabilities struct {
	OutputFormats    []string          `json:"output_formats,omitempty"`
	Resolutions      []string          `json:"resolutions"`
	AspectRatios     []string          `json:"aspect_ratios"`
	Qualities        []string          `json:"qualities"`
	DurationsSeconds []int             `json:"durations_seconds"`
	Count            Range             `json:"count"`
	References       References        `json:"references"`
	CombinationRules []CombinationRule `json:"combination_rules"`
}

// Amount stays decimal text: nil price is missing; "0" is explicitly zero.
type Price struct {
	Amount      string `json:"amount"`
	Currency    string `json:"currency"`
	BillingMode string `json:"billing_mode"`
}
type PricingRule struct {
	Match     Match  `json:"match"`
	SalePrice *Price `json:"sale_price"`
}
type CostRule struct {
	Match  Match  `json:"match"`
	Cost   *Price `json:"cost"`
	Source string `json:"source,omitempty"`
}
type Diagnostic struct {
	Class    string `json:"class"`
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Scope    string `json:"scope"`
	Path     string `json:"path"`
	Message  string `json:"message"`
	Action   string `json:"action"`
	// Optional price coverage evidence, scoped to this diagnostic's product.
	Match     *Match `json:"match,omitempty"`
	Specs     []Spec `json:"specs,omitempty"`
	SpecCount int    `json:"spec_count,omitempty"`
}
type Catalog struct {
	Source                string   `json:"source"`
	SyncedAt              string   `json:"synced_at"`
	Models                []string `json:"models"`
	AccountIdentitySHA256 string   `json:"account_identity_sha256,omitempty"`
}

// CatalogChange is bounded discovery metadata stored separately from Catalog
// and the CAS-owned media configuration. It never participates in dependency hashes.
type CatalogChange struct {
	SchemaVersion         int      `json:"schema_version"`
	AccountIdentitySHA256 string   `json:"account_identity_sha256"`
	DetectedAt            string   `json:"detected_at"`
	PreviousSyncedAt      string   `json:"previous_synced_at"`
	AddedCount            int      `json:"added_count"`
	MissingCount          int      `json:"missing_count"`
	AddedModels           []string `json:"added_models"`
	MissingModels         []string `json:"missing_models"`
	Truncated             bool     `json:"truncated"`
}

type CatalogDependency struct {
	SyncedAt string `json:"synced_at"`
	SHA256   string `json:"sha256"`
}
type Validation struct {
	DraftRevision           string            `json:"draft_revision"`
	Status                  string            `json:"status"`
	PublishReady            bool              `json:"publish_ready"`
	CheckedAt               time.Time         `json:"checked_at"`
	ModelCatalog            CatalogDependency `json:"model_catalog"`
	AdapterRegistryRevision string            `json:"adapter_registry_revision"`
	Diagnostics             []Diagnostic      `json:"diagnostics"`
	Dependencies            Dependencies      `json:"dependencies"`
	Previews                []Preview         `json:"previews"`
	CaseCount               int               `json:"case_count"`
}

type Published struct {
	Revision            string                  `json:"revision"`
	SourceDraftRevision string                  `json:"source_draft_revision"`
	PublishedAt         time.Time               `json:"published_at"`
	Products            []Product               `json:"products"`
	Offers              []Offer                 `json:"offers"`
	Dependencies        Dependencies            `json:"dependencies"`
	ProductDependencies map[string]Dependencies `json:"product_dependencies,omitempty"`
}
type Offer struct {
	CostVersion    int            `json:"cost_version,omitempty"`
	OfferID        string         `json:"offer_id"`
	ProductID      string         `json:"product_id"`
	AccountID      int64          `json:"account_id"`
	MediaType      string         `json:"media_type"`
	SiteModel      string         `json:"site_model"`
	UpstreamModel  string         `json:"upstream_model"`
	SpecMatch      Match          `json:"spec_match"`
	SalePrice      Price          `json:"sale_price"`
	Adapter        AdapterBinding `json:"adapter"`
	ResolvedConfig ImageConfig    `json:"resolved_config"`
	Excluded       []Match        `json:"excluded"`
}
type Procurement struct {
	Revision int64              `json:"revision"`
	Entries  []ProcurementEntry `json:"entries"`
}
type ProcurementEntry struct {
	ProductID  string    `json:"product_id"`
	Cost       Price     `json:"cost"`
	Source     string    `json:"source"`
	ObservedAt time.Time `json:"observed_at"`
}

// Account is a narrow repository projection, never the generic Account DTO.
type Account struct {
	ID                         int64                                      `json:"id"`
	Name                       string                                     `json:"name"`
	Platform                   string                                     `json:"platform"`
	Type                       string                                     `json:"type"`
	Status                     string                                     `json:"status"`
	Schedulable                bool                                       `json:"schedulable"`
	BaseURL                    string                                     `json:"-"`
	Catalog                    *Catalog                                   `json:"model_catalog"`
	CatalogChange              *CatalogChange                             `json:"model_catalog_change,omitempty"`
	Config                     *Config                                    `json:"media_workbench_v1"`
	ModelMapping               map[string]string                          `json:"-"`
	EndpointCapabilities       []string                                   `json:"-"`
	RuntimeReady               bool                                       `json:"runtime_ready"`
	Image2ProVideoCapabilities map[string]videoplan.Image2ProCapabilities `json:"image2pro_video_capabilities,omitempty"`
	RoutingFingerprint         string                                     `json:"-"`
}
type ModelState struct {
	ModelID string `json:"model_id"`
	State   string `json:"state"`
}
type Detail struct {
	ProductStates     []ProductState `json:"product_states"`
	PublishValidation *Validation    `json:"publish_validation,omitempty"`
	*Account
	NativeAdapters map[string]AdapterDescriptor `json:"native_adapters"`
	ProductRemoval map[string]DraftRemoval      `json:"product_removal"`
	Host           string                       `json:"host"`
	EffectiveSales bool                         `json:"effective_sales"`
	EffectiveState string                       `json:"effective_state"`
	Models         []ModelState                 `json:"models"`
	Discovered     int                          `json:"discovered_count"`
	Configured     int                          `json:"configured_count"`
	Pending        int                          `json:"pending_count"`
	Problems       int                          `json:"problem_count"`
}
type Repository interface {
	Get(context.Context, int64) (*Account, error)
	List(context.Context) ([]Account, error)
	CompareAndSwap(context.Context, int64, int64, *Config) error
	// Checks dependencies under the Account row lock before committing validation,
	// publish or sales-enable. Generic Account edits cannot race past this gate.
	CompareAndSwapChecked(context.Context, int64, int64, Dependencies, *Config) error
}
type Service struct{ repo Repository }

func NewService(repo Repository) *Service { return &Service{repo: repo} }
func (s *Service) Detail(ctx context.Context, id int64) (*Detail, error) {
	ctx = WithPublishedValidationMemo(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	detail := describeContext(ctx, a)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return detail, nil
}
func (s *Service) Suppliers(ctx context.Context) ([]Detail, error) {
	ctx = WithPublishedValidationMemo(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	accounts, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Detail, 0, len(accounts))
	for i := range accounts {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out = append(out, *describeContext(ctx, &accounts[i]))
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
func describe(a *Account) *Detail {
	return describeContext(context.Background(), a)
}

func describeContext(ctx context.Context, a *Account) *Detail {
	ready := publishedSnapshotValidator(ctx, a)
	d := &Detail{Account: a, Models: []ModelState{}, EffectiveState: "NOT_INITIALIZED"}
	d.ProductStates = describeProductsContext(ctx, a, ready)
	d.ProductRemoval = draftRemovalOptions(a.Config)
	d.NativeAdapters = map[string]AdapterDescriptor{}
	for _, mediaType := range []string{"image", "video"} {
		if descriptor, ok := Descriptor(nativeAdapterKind(a, mediaType)); ok {
			d.NativeAdapters[mediaType] = descriptor
		}
	}
	if u, err := url.Parse(a.BaseURL); err == nil && (u.Scheme == "https" || u.Scheme == "http") {
		d.Host = u.Hostname()
	}
	states := map[string]string{}
	discovered := map[string]bool{}
	if a.Catalog != nil {
		for _, m := range a.Catalog.Models {
			states[m] = "PENDING"
			discovered[m] = true
		}
		d.Discovered = len(states)
	}
	if c := a.Config; c != nil {
		for _, p := range c.Draft.Products {
			if p.UpstreamModel == "" {
				continue
			}
			if discovered[p.UpstreamModel] {
				states[p.UpstreamModel] = "DRAFT"
			} else if a.Catalog != nil {
				states[p.UpstreamModel] = "UPSTREAM_NOT_DISCOVERED"
			} else {
				states[p.UpstreamModel] = "MODEL_SYNC_REQUIRED"
			}
		}
		d.EffectiveState = "SALES_OFF_UNKNOWN"
		if c.Sales.HasEverEnabled != nil {
			d.EffectiveState = "NOT_YET_ENABLED"
			if *c.Sales.HasEverEnabled {
				d.EffectiveState = "SALES_PAUSED"
			}
		}
		if c.Sales.Enabled {
			d.EffectiveState = "PUBLISHED_NOT_READY"
			if publishedReadyWithValidation(ctx, a, ready) {
				d.EffectiveSales = true
				d.EffectiveState = "SELLING"
			}
		}
		for _, p := range c.Draft.Products {
			if states[p.UpstreamModel] != "DRAFT" {
				continue
			}
			for _, diagnostic := range c.Validation.Diagnostics {
				if diagnostic.Scope == p.ProductID {
					states[p.UpstreamModel] = diagnostic.Class
					break
				}
			}
		}
		if c.Published != nil {
			for _, p := range c.Published.Products {
				if !p.Enabled {
					continue
				}
				if !discovered[p.UpstreamModel] {
					states[p.UpstreamModel] = "UPSTREAM_NOT_DISCOVERED"
					if a.Catalog == nil {
						states[p.UpstreamModel] = "MODEL_SYNC_REQUIRED"
					}
				} else if states[p.UpstreamModel] == "PENDING" || (states[p.UpstreamModel] == "DRAFT" && draftProductMatchesPublished(c.Draft, p)) {
					states[p.UpstreamModel] = "PUBLISHED"
				}
			}
		}
	}
	if !SupportsAccount(a) {
		d.EffectiveState = "UNSUPPORTED_ACCOUNT_TYPE"
	} else if a.Status != "active" {
		d.EffectiveState = "ACCOUNT_INACTIVE"
	} else if !a.Schedulable {
		d.EffectiveState = "ACCOUNT_UNSCHEDULABLE"
	} else if !a.RuntimeReady {
		d.EffectiveState = "ACCOUNT_RUNTIME_BLOCKED"
	}
	if !SupportsAccount(a) || a.Status != "active" || !a.Schedulable || !a.RuntimeReady {
		d.EffectiveSales = false
	}
	if c := a.Config; c != nil {
		for _, model := range c.HiddenModels {
			states[model] = "ARCHIVED"
		}
		all := map[string]Product{}
		for _, p := range c.Draft.Products {
			all[p.ProductID] = p
		}
		if c.Published != nil {
			for _, p := range c.Published.Products {
				all[p.ProductID] = p
			}
		}
		total, archived, unlisted := map[string]int{}, map[string]int{}, map[string]int{}
		for id, p := range all {
			total[p.UpstreamModel]++
			switch c.ProductLifecycle[id].State {
			case "archived":
				archived[p.UpstreamModel]++
			case "unlisted":
				unlisted[p.UpstreamModel]++
			}
		}
		for model, n := range total {
			if archived[model] == n {
				states[model] = "ARCHIVED"
			} else if archived[model]+unlisted[model] == n {
				states[model] = "UNLISTED"
			}
		}
	}
	for m, state := range states {
		d.Models = append(d.Models, ModelState{m, state})
		if state == "PENDING" {
			d.Pending++
		} else {
			d.Configured++
		}
		if state == "UPSTREAM_NOT_DISCOVERED" || state == "MODEL_SYNC_REQUIRED" {
			d.Problems++
		}
	}
	sort.Slice(d.Models, func(i, j int) bool { return d.Models[i].ModelID < d.Models[j].ModelID })
	if a.Config != nil && a.Config.Validation.Status != "PASS" {
		d.Problems++
	}
	return d
}
func (s *Service) Initialize(ctx context.Context, id int64, mediaTypes []string) (*Detail, error) {
	if len(mediaTypes) == 0 || len(mediaTypes) > 2 {
		return nil, ErrInvalid
	}
	types := append([]string(nil), mediaTypes...)
	sort.Strings(types)
	for i, t := range types {
		if t != "image" && t != "video" {
			return nil, ErrInvalid
		}
		if i > 0 && types[i-1] == t {
			return nil, ErrInvalid
		}
	}
	a, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !SupportsAccount(a) {
		return nil, ErrUnsupported
	}
	if a.Config != nil {
		return describe(a), nil
	} // repeat initialize never edits existing configuration
	now := time.Now().UTC()
	c := &Config{SchemaVersion: 1, RecordVersion: 1, MediaTypes: types, AdapterBindings: bindingsFor(a, types), Sales: Sales{HasEverEnabled: new(bool), UpdatedAt: now}, Procurement: Procurement{Entries: []ProcurementEntry{}}}
	c.Draft = makeDraft(DraftInput{Products: []Product{}}, "", now)
	a.Config = c
	c.Validation, _ = Validate(a, c.Draft, now)
	if err = s.repo.CompareAndSwap(ctx, id, 0, c); err != nil {
		return nil, err
	}
	a.Config = c
	return describe(a), nil
}
func makeDraft(input DraftInput, basedOn string, now time.Time) Draft {
	if input.Products == nil {
		input.Products = []Product{}
	}
	data, _ := json.Marshal(struct {
		Products []Product `json:"products"`
		BasedOn  string    `json:"based_on"`
	}{input.Products, basedOn})
	return Draft{Revision: fmt.Sprintf("mwd_%x", sha256.Sum256(data)), BasedOnPublishedRevision: basedOn, UpdatedAt: now, Products: input.Products}
}
func (s *Service) SaveDraft(ctx context.Context, id, expected int64, input DraftInput) (*Detail, error) {
	if input.SubmissionID != "" && (len(input.SubmissionID) != 36 || !submissionIDPattern.MatchString(input.SubmissionID)) {
		return nil, ErrInvalid
	}
	var a *Account
	var err error
	if expected == 0 {
		// The first explicit save is the initialization boundary. Browsing a
		// catalog remains read-only; an empty or repeated version-zero write
		// cannot create a media configuration.
		a, err = s.repo.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		if !SupportsAccount(a) {
			return nil, ErrUnsupported
		}
		if a.Config != nil {
			return nil, ErrStale
		}
		if len(input.Products) == 0 {
			return nil, ErrInvalid
		}
		types := make([]string, 0, 2)
		seen := map[string]bool{}
		for _, p := range input.Products {
			if p.MediaType != "image" && p.MediaType != "video" {
				return nil, ErrInvalid
			}
			if !seen[p.MediaType] {
				seen[p.MediaType] = true
				types = append(types, p.MediaType)
			}
		}
		sort.Strings(types)
		now := time.Now().UTC()
		a.Config = &Config{SchemaVersion: 1, RecordVersion: 0, MediaTypes: types, AdapterBindings: bindingsFor(a, types), Sales: Sales{HasEverEnabled: new(bool), UpdatedAt: now}, Procurement: Procurement{Entries: []ProcurementEntry{}}}
	} else {
		a, err = s.mutable(ctx, id, expected)
		if err != nil {
			return nil, err
		}
	}
	// Persist incomplete business fields before local validation.
	for _, p := range input.Products {
		if p.MediaType != "" && p.MediaType != "image" && p.MediaType != "video" {
			return nil, ErrInvalid
		}
	}
	c := a.Config
	removed, err := validateDraftRemovals(c, input)
	if err != nil {
		return nil, err
	}
	c.RemovedDraftProducts = append(c.RemovedDraftProducts, removed...)
	// MediaTypes records Studio configuration, not native API authorization.
	// Extend it only for types explicitly submitted by this CAS-protected save;
	// adapter/model/spec validation still decides whether they may be published.
	expanded := false
	for _, p := range input.Products {
		if p.MediaType != "" && !slices.Contains(c.MediaTypes, p.MediaType) {
			c.MediaTypes = append(c.MediaTypes, p.MediaType)
			expanded = true
		}
	}
	if expanded {
		sort.Strings(c.MediaTypes)
	}
	basedOn := ""
	if c.Published != nil {
		basedOn = c.Published.Revision
	}
	now := time.Now().UTC()
	for i := range input.Products {
		normalizeProductCost(&input.Products[i])
		inheritNativeProduct(a, &input.Products[i])
	}
	c.Draft = makeDraft(input, basedOn, now)
	if input.SubmissionID != "" {
		c.Draft.SaveReceipt = &SaveReceipt{SubmissionID: input.SubmissionID, BaseRecordVersion: expected, DraftRevision: c.Draft.Revision}
	}
	c.AdapterBindings = bindingsFor(a, c.MediaTypes)
	c.AdapterBinding = nil
	c.Validation = Validation{DraftRevision: c.Draft.Revision, Status: "UNKNOWN", CheckedAt: now, Diagnostics: []Diagnostic{{Class: "UNKNOWN", Severity: "error", Code: "VALIDATION_PENDING", Message: "Draft saved; local validation pending"}}, Previews: []Preview{}}
	c.RecordVersion++
	if err = s.repo.CompareAndSwap(ctx, id, expected, c); err != nil {
		return nil, err
	}
	return s.validateSaved(ctx, id, a)
}
func (s *Service) SetSales(ctx context.Context, id, expected int64, enabled bool) (*Detail, error) {
	a, err := s.mutable(ctx, id, expected)
	if err != nil {
		return nil, err
	}
	if enabled && !publishedReady(a) {
		return nil, ErrSales
	}
	a.Config.Sales.Enabled = enabled
	a.Config.Sales.UpdatedAt = time.Now().UTC()
	if enabled {
		a.Config.Sales.HasEverEnabled = &enabled
	}
	a.Config.RecordVersion++
	if enabled {
		err = s.repo.CompareAndSwapChecked(ctx, id, expected, DependenciesFor(a), a.Config)
	} else {
		err = s.repo.CompareAndSwap(ctx, id, expected, a.Config)
	}
	if err != nil {
		return nil, err
	}
	return describe(a), nil
}

func (s *Service) validateSaved(ctx context.Context, id int64, saved *Account) (*Detail, error) {
	for attempt := 0; attempt < 3; attempt++ {
		a, err := s.repo.Get(ctx, id)
		if errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err != nil {
			return unknownSaved(saved), nil
		}
		if !sameSavedDraft(saved, a) {
			return nil, saveConfirmationConflict(saved, a)
		}
		expected := a.Config.RecordVersion
		v, _ := Validate(a, a.Config.Draft, time.Now().UTC())
		a.Config.Validation = v
		a.Config.RecordVersion++
		err = s.repo.CompareAndSwapChecked(ctx, id, expected, v.Dependencies, a.Config)
		if errors.Is(err, ErrStale) {
			continue
		}
		if errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err != nil {
			return unknownSaved(saved), nil
		}
		return describe(a), nil
	}
	// Retrying local validation never retries the submitted draft write. Even
	// after the retry limit, another writer's latest draft is not our receipt.
	a, err := s.repo.Get(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if err != nil {
		return unknownSaved(saved), nil
	}
	if !sameSavedDraft(saved, a) {
		return nil, saveConfirmationConflict(saved, a)
	}
	return describe(a), nil
}

func sameSavedDraft(saved, current *Account) bool {
	if current == nil || current.Config == nil {
		return false
	}
	want, got := saved.Config.Draft, current.Config.Draft
	// UpdatedAt also distinguishes otherwise identical writes from old clients
	// that do not yet send submission_id. Validation preserves this timestamp.
	if want.Revision != got.Revision || !want.UpdatedAt.Equal(got.UpdatedAt) {
		return false
	}
	if want.SaveReceipt == nil || got.SaveReceipt == nil {
		return want.SaveReceipt == nil && got.SaveReceipt == nil
	}
	return *want.SaveReceipt == *got.SaveReceipt
}

func saveConfirmationConflict(saved, current *Account) error {
	metadata := map[string]string{"save_stage": "confirmation", "saved_record_version": fmt.Sprint(saved.Config.RecordVersion)}
	if receipt := saved.Config.Draft.SaveReceipt; receipt != nil {
		metadata["submission_id"] = receipt.SubmissionID
		metadata["base_record_version"] = fmt.Sprint(receipt.BaseRecordVersion)
	}
	if current != nil && current.Config != nil {
		metadata["response_record_version"] = fmt.Sprint(current.Config.RecordVersion)
	}
	return ErrStale.WithMetadata(metadata)
}

func unknownSaved(a *Account) *Detail {
	// The first CAS already stored UNKNOWN. A later local read/write failure
	// cannot undo the Draft; return its receipt with an actionable diagnostic.
	a.Config.Validation.Status = "UNKNOWN"
	a.Config.Validation.PublishReady = false
	a.Config.Validation.Diagnostics = []Diagnostic{diagnostic("UNKNOWN", "LOCAL_DEPENDENCY_UNAVAILABLE", "", "validation", "Draft saved; local validation could not be committed")}
	return describe(a)
}

func (s *Service) Publish(ctx context.Context, id, expected int64, revision string) (*Detail, error) {
	a, err := s.mutable(ctx, id, expected)
	if err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, ErrInvalid
	}
	if a.Config.Draft.Revision != revision {
		return nil, ErrStale
	}
	a.Config.AdapterBindings = bindingsFor(a, a.Config.MediaTypes)
	a.Config.AdapterBinding = nil
	// Always reread/recompile: this also automatically refreshes stale registry,
	// catalog, mapping and routing dependencies without supplier calls.
	now := time.Now().UTC()
	publication := a.Config.Draft
	publication.Products = append([]Product(nil), publication.Products...)
	for i := range publication.Products {
		normalizeProductCost(&publication.Products[i])
	}
	v, offers := Validate(a, publication, now)
	a.Config.Validation = v
	if v.PublishReady {
		products := []Product{}
		for _, product := range publication.Products {
			if product.Enabled && a.Config.ProductLifecycle[product.ProductID].State != "archived" {
				products = append(products, product)
			}
		}
		p := &Published{SourceDraftRevision: revision, PublishedAt: now, Products: products, Offers: offers, Dependencies: dependenciesForProducts(a, products)}
		p.ProductDependencies = snapshotProductDependencies(a, products)
		p.Revision = publishedRevision(p)
		a.Config.Published = p
	}
	a.Config.RecordVersion++
	if err = s.repo.CompareAndSwapChecked(ctx, id, expected, v.Dependencies, a.Config); err != nil {
		return nil, err
	}
	if !v.PublishReady {
		return describe(a), ErrValidation
	}
	return describe(a), nil
}
func (s *Service) mutable(ctx context.Context, id, expected int64) (*Account, error) {
	if expected < 1 || expected >= 9007199254740991 {
		return nil, ErrInvalid
	}
	a, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !SupportsAccount(a) {
		return nil, ErrUnsupported
	}
	if a.Config == nil {
		return nil, ErrUninitialized
	}
	if a.Config.SchemaVersion != 1 {
		return nil, ErrInvalid
	}
	if a.Config.RecordVersion != expected {
		return nil, ErrStale
	}
	return a, nil
}

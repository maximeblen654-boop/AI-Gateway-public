package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/shopspring/decimal"
	"github.com/tidwall/gjson"
)

type StudioVideoRuntime struct {
	CatalogSync       studioCatalogRefresher
	PaidControl       *StudioPaidControl
	Monitor           *ChannelMonitorV2Service
	Core              *OpenAIGatewayService
	Media             mediaworkbench.Repository
	Orders            StudioVideoOrderRepository
	APIKeys           *APIKeyService
	Store             *StudioVideoStore
	ReferenceUploader AccountBoundReferenceUploader
	enabled           bool
	request           func(context.Context, *Account, string, string, []byte) ([]byte, string, error)
}

func (r *StudioVideoRuntime) Catalog(ctx context.Context, owner StudioImageOwner, key *APIKey) ([]StudioImageCatalogOffer, error) {
	ctx = mediaworkbench.WithPublishedValidationMemo(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !videoOwnerKey(owner, key) {
		return nil, ErrStudioVideoInvalidOrder
	}
	rows, e := r.Media.List(ctx)
	if e != nil {
		return nil, e
	}
	out := []StudioImageCatalogOffer{}
	for i := range rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if r.CatalogSync != nil && rows[i].Config != nil && rows[i].Config.Published != nil {
			fresh, err := refreshStudioCatalog(ctx, r.Media, r.CatalogSync, &rows[i])
			if err != nil {
				continue
			}
			rows[i] = *fresh
		}
		a, e := r.Core.accountRepo.GetByID(ctx, rows[i].ID)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if e != nil || a == nil || !slices.Contains(a.GroupIDs, owner.GroupID) {
			continue
		}
		offers, err := mediaworkbench.PublishedVideoOffersContext(ctx, &rows[i])
		if err != nil {
			return nil, err
		}
		for _, o := range offers {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if key.Group.ModelAllowlist.Allows(o.SiteModel) {
				mode := o.ResolvedConfig.WireProfile
				entry := StudioImageCatalogOffer{ProductScope: studioVideoProductScope(o, rows[i].Config.Published.Revision), statusPlatform: studioPassivePlatform(a, key), InputMode: mode, DisplayName: o.UpstreamModel, UpstreamModel: o.UpstreamModel, OfferID: o.OfferID, ProductID: o.ProductID, Model: o.SiteModel, Revision: rows[i].Config.Published.Revision, Spec: o.SpecMatch, Excluded: o.Excluded, Price: o.SalePrice}

				for _, product := range rows[i].Config.Published.Products {
					if product.ProductID == o.ProductID {
						if profile, ok := mediaworkbench.VideoProfileModel(product); ok {
							entry.VideoProfile = &profile
							entry.InputMode = profile.Mode
						}
					}
				}
				out = append(out, entry)
			}
		}
	}
	attachStudioPassiveStatuses(ctx, r.Monitor, owner, key, out)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// The customer model entry groups specs only within one published video
// product. Quotes continue to bind the individual, unchanged published offer.
func studioVideoProductScope(offer mediaworkbench.Offer, revision string) string {
	return studioHash(struct {
		Domain            string `json:"domain"`
		MediaType         string `json:"media_type"`
		AccountID         int64  `json:"account_id"`
		ProductID         string `json:"product_id"`
		PublishedRevision string `json:"published_revision"`
	}{"video-product", offer.MediaType, offer.AccountID, offer.ProductID, revision})
}

func NewStudioVideoRuntime(core *OpenAIGatewayService, media mediaworkbench.Repository, orders StudioVideoOrderRepository) *StudioVideoRuntime {
	root := strings.TrimSpace(os.Getenv("STUDIO_VIDEO_BINDING_ROOT"))
	if root == "" {
		root = filepath.Join("data", "studio-video-bindings")
	}
	r := &StudioVideoRuntime{Core: core, Media: media, Orders: orders, Store: &StudioVideoStore{Root: root}, ReferenceUploader: NewHTTPAccountBoundReferenceUploader(core), enabled: os.Getenv("STUDIO_VIDEO_ACCOUNT_SUBMISSION") == "true"}
	// Default off. Activation is an explicit operator choice on every layer;
	// constructing this runtime or running tests never submits a supplier request.
	r.request = r.requestHTTP
	return r
}
func (r *StudioVideoRuntime) Enabled() bool {
	if r == nil || r.Core == nil || r.Media == nil || r.Store == nil || r.Orders == nil || r.request == nil {
		return false
	}
	if r != nil && r.PaidControl != nil && r.PaidControl.Managed {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return r.PaidControl.Effective(ctx, "video")
	}
	return r != nil && r.enabled && r.Core != nil && r.Media != nil && r.Orders != nil && r.Store != nil && r.request != nil
}

// Only execution credentials/proxy are identity. Model mappings and prices may
// change later without rewriting the historical plan or blocking its read-only recovery.
func videoCredentialFingerprint(a *Account) string {
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	credential := a.GetOpenAIProtocolAPIKey()
	if a.IsGrokOAuth() {
		credential = a.GetGrokAccessToken()
	}
	if a.Platform == PlatformGrok {
		return studioHash(struct {
			Credential string
			ProxyID    *int64
			Proxy      string
			Headers    map[string]string
			Standard   bool
		}{credential, a.ProxyID, proxy, a.GetHeaderOverrides(), a.UsesStandardGrokVideoAPI()})
	}
	return studioHash(struct {
		Key     string
		ProxyID *int64
		Proxy   string
	}{credential, a.ProxyID, proxy})
}
func videoOwnerKey(owner StudioImageOwner, key *APIKey) bool {
	return key != nil && key.Group != nil && key.GroupID != nil && key.ID == owner.APIKeyID && key.UserID == owner.UserID && *key.GroupID == owner.GroupID && !key.Group.IsSubscriptionType()
}

func (r *StudioVideoRuntime) Issue(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, body []byte) (string, StudioVideoQuote, error) {
	return r.IssueWithPreparation(ctx, owner, key, offerID, spec, body, "")
}

func (r *StudioVideoRuntime) IssueWithPreparation(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, body []byte, preparationID string) (string, StudioVideoQuote, error) {
	return r.issueQuote(ctx, owner, key, offerID, spec, body, preparationID, false)
}

// quotePreflight compiles inert reference placeholders through the native plan
// and validates the same frozen price, Account and cost rules. It never uploads
// references, sends upstream requests, or issues an executable quote token.
func (r *StudioVideoRuntime) quotePreflight(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, body []byte) error {
	_, _, err := r.issueQuote(ctx, owner, key, offerID, spec, body, "", true)
	return err
}
func (r *StudioVideoRuntime) issueQuote(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, body []byte, preparationID string, preflight bool) (string, StudioVideoQuote, error) {
	var q StudioVideoQuote
	if r == nil || r.Core == nil || r.Media == nil || r.Store == nil || len(body) > 24<<20 || !videoOwnerKey(owner, key) {
		return "", q, QuoteFailure("request", ErrStudioVideoInvalidOrder)
	}
	resolved, e := mediaworkbench.NewService(r.Media).ResolvePublishedVideoOffer(ctx, offerID, spec, func(id int64) bool {
		a, e := r.Core.accountRepo.GetByID(ctx, id)
		return e == nil && a != nil && slices.Contains(a.GroupIDs, owner.GroupID)
	})
	if e == nil && !preflight && r.CatalogSync != nil {
		if e = r.CatalogSync.Ensure(ctx, resolved.Offer.AccountID); e != nil {
			return "", q, QuoteFailure("model_catalog", e)
		}
		resolved, e = mediaworkbench.NewService(r.Media).ResolvePublishedVideoOffer(ctx, offerID, spec, func(id int64) bool {
			a, e := r.Core.accountRepo.GetByID(ctx, id)
			return e == nil && a != nil && slices.Contains(a.GroupIDs, owner.GroupID)
		})
	}
	if e != nil {
		return "", q, QuoteFailure("published_offer", ErrStudioVideoInvalidOrder)
	}
	if !key.Group.ModelAllowlist.Allows(resolved.Offer.SiteModel) {
		return "", q, QuoteFailure("model_permission", ErrStudioVideoInvalidOrder)
	}
	plan, e := mediaworkbench.CompilePublishedVideoPlan(resolved, body)
	if e != nil {
		return "", q, QuoteFailure("execution", e)
	}
	aCurrent, e := r.Core.accountRepo.GetByID(ctx, resolved.Offer.AccountID)
	if e != nil || aCurrent == nil {
		return "", q, QuoteFailure("account", ErrStudioVideoInvalidOrder)
	}
	if !preflight && preparationID == "" && (gjson.GetBytes(body, "references.#").Int() > 0 || resolved.Offer.Adapter.Kind == "image2pro_video" && spec.Images+spec.Audio+spec.Videos > 0) {
		return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
	}
	var preparation *StudioVideoReferencePreparation
	if preparationID != "" {
		if e := r.Store.init(); e != nil {
			return "", q, e
		}
		lockID := preparationID
		if resolved.Offer.Adapter.Kind == "image2pro_video" {
			candidate, err := r.Store.ReferencePreparation(preparationID, owner)
			if err != nil {
				return "", q, QuoteFailure("reference_preparation", err)
			}
			lockID = "prep_" + candidate.AssetIntentHash
		}
		unlock, e := studioFileLock(r.Store.path("reference-lock", lockID))
		if e != nil {
			return "", q, e
		}
		defer unlock()
		prep, e := r.Store.ReferencePreparation(preparationID, owner)
		endpointFingerprint := studioHash(struct{ Base, Model string }{aCurrent.GetOpenAIBaseURL(), resolved.Offer.UpstreamModel})
		proxyFingerprint := studioHash(func() string {
			if aCurrent.Proxy == nil {
				return ""
			}
			return aCurrent.Proxy.URL()
		}())
		if e != nil || prep.Status != "ready" || prep.OfferID != offerID || prep.AccountID != resolved.Offer.AccountID || prep.PublishedRevision != resolved.PublishedRevision || prep.AdapterRevision != resolved.Offer.Adapter.Revision || prep.Spec != spec || prep.SalePrice != resolved.Offer.SalePrice || prep.EndpointFingerprint != endpointFingerprint || prep.ProxyFingerprint != proxyFingerprint || prep.CredentialFingerprint != videoCredentialFingerprint(aCurrent) {
			return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
		}
		preparation = &prep
		if resolved.Offer.Adapter.Kind == "image2pro_video" {
			if e := validateImage2ProPreparedBody(prep, body, r.Store.now()); e != nil {
				return "", q, QuoteFailure("reference_preparation", e)
			}
		}
		if prep.FinalQuoteToken != "" {
			if prep.FinalRequestHash != plan.RequestHash {
				return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
			}
			old, err := r.Store.Quote(prep.FinalQuoteToken, owner)
			if err != nil || !r.Store.now().Before(old.Binding.ExpiresAt) {
				return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
			}
			return prep.FinalQuoteToken, old, nil
		}
		if resolved.Offer.Adapter.Kind != "image2pro_video" {
			var refs []struct {
				Type   string `json:"type"`
				Source string `json:"source"`
			}
			if !gjson.ValidBytes(body) || !gjson.GetBytes(body, "references").Exists() || gjson.GetBytes(body, "references.#").Int() != int64(len(prep.Receipts)) || json.Unmarshal([]byte(gjson.GetBytes(body, "references").Raw), &refs) != nil || len(refs) != len(prep.Receipts) {
				return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
			}
			if len(prep.Assets) != len(prep.Receipts) {
				return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
			}
			for i, receipt := range prep.Receipts {
				asset := prep.Assets[i]
				if asset.AssetRef != receipt.AssetRef || asset.Kind != receipt.Kind || asset.MimeType != receipt.MimeType || asset.Size != receipt.Size || asset.SHA256 != receipt.SHA256 || refs[i].Type != receipt.Kind || refs[i].Source != receipt.Source || refs[i].Source == "" {
					return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
				}
			}
		}
	}
	a := aCurrent
	now := r.Store.now()
	id, e := studioRandom()
	if e != nil {
		return "", q, e
	}
	b := StudioVideoBinding{Version: StudioVideoRetailBindingVersion, QuoteID: id, Owner: owner, PublishedRevision: resolved.PublishedRevision,
		Offer: resolved.Offer, Spec: resolved.Spec, SpecHash: resolved.SpecHash, PlanHash: studioHash(plan), RequestHash: plan.RequestHash,
		AccountType: a.Type, Platform: a.Platform, BaseURL: studioMediaBaseURL(a), CredentialFingerprint: videoCredentialFingerprint(a), KeyQuotaEnabled: key.Quota > 0, KeyRateEnabled: key.HasRateLimits(), AccountQuotaEnabled: a.HasAnyQuotaLimit(), CreatedAt: now, ExpiresAt: now.Add(2 * time.Minute)}
	b.Accounting, e = r.referenceAccounting(ctx, a, owner, resolved, now)
	if e != nil {
		if QuoteFailureStage(e) == "account_quota_requires_cost" || QuoteFailureStage(e) == "cost_rule_missing" || QuoteFailureStage(e) == "cost_contract" {
			return "", q, e
		}
		return "", q, QuoteFailure("account_cost", e)
	}
	if preparation != nil {
		currentCost, err := r.referenceAccounting(ctx, a, owner, resolved, preparation.Accounting.PricingAt)
		if err != nil || currentCost != preparation.Accounting {
			return "", q, QuoteFailure("reference_preparation", ErrStudioVideoConflict)
		}
		b.Accounting = preparation.Accounting
		if resolved.Offer.Adapter.Kind == "image2pro_video" && preparation.ExpiresAt.Before(b.ExpiresAt) {
			b.ExpiresAt = preparation.ExpiresAt
		}
	}
	q = StudioVideoQuote{Binding: b, BindingHash: b.Hash(), Plan: plan}
	if _, release, e := r.account(ctx, b, true, false); e != nil {
		return "", q, QuoteFailure("account_admission", e)
	} else {
		release()
	}
	if preflight {
		return "", q, nil
	}
	token, e := r.Store.Issue(q)
	if e == nil && preparation != nil {
		preparation.FinalQuoteToken = token
		preparation.FinalRequestHash = plan.RequestHash
		e = r.Store.UpdateReferencePreparation(*preparation)
	}
	return token, q, QuoteFailure("quote_store", e)
}

// New dispatch checks current eligibility AND the frozen identity. Recovery
// ignores today's catalog/sales/rate rules, but never changes Account, endpoint,
// credential or proxy and still requires the original active authorized account.
func (r *StudioVideoRuntime) account(ctx context.Context, b StudioVideoBinding, admission, slot bool) (*Account, func(), error) {
	fail := func() (*Account, func(), error) { return nil, nil, ErrStudioVideoConflict }
	if b.Validate() != nil || r.Core == nil || r.Core.accountRepo == nil {
		return fail()
	}
	a, e := r.Core.accountRepo.GetByID(ctx, b.Offer.AccountID)
	if e != nil || a == nil || a.ID != b.Offer.AccountID || !a.IsActive() || a.Type != firstNonEmptyString(b.AccountType, AccountTypeAPIKey) || a.Platform != firstNonEmptyString(b.Platform, PlatformOpenAI) || a.ParentAccountID != nil || !slices.Contains(a.GroupIDs, b.Owner.GroupID) || studioMediaBaseURL(a) != b.BaseURL || videoCredentialFingerprint(a) != b.CredentialFingerprint {
		return fail()
	}
	if a.ProxyID != nil && (a.Proxy == nil || a.Proxy.ID != *a.ProxyID) {
		return fail()
	}
	if _, e = r.Core.validateUpstreamBaseURL(b.BaseURL); e != nil {
		return fail()
	}
	if admission {
		if b.Version == StudioVideoRetailBindingVersion && a.HasAnyQuotaLimit() {
			return nil, nil, QuoteFailure("account_quota_requires_cost", ErrStudioImageAccounting)
		}
		if a.Platform == PlatformGrok {
			if eligible, _ := a.GrokMediaGenerationEligibility(); !eligible {
				return fail()
			}
		}
		if !a.IsSchedulable() || (b.Version != StudioVideoRetailBindingVersion && b.Offer.CostVersion == 0 && a.GetMappedModel(b.Offer.SiteModel) != b.Offer.UpstreamModel) || (a.HasAnyQuotaLimit() && !b.AccountQuotaEnabled) {
			return fail()
		}
		ma, e := r.Media.Get(ctx, a.ID)
		if e != nil {
			return fail()
		}
		current, e := mediaworkbench.ResolvePublishedVideoOfferContext(ctx, ma, b.Offer.OfferID, b.Spec)
		if e != nil || current.PublishedRevision != b.PublishedRevision || studioHash(current.Offer) != studioHash(b.Offer) {
			return fail()
		}
		requested := current.Offer.SiteModel
		if b.Version == StudioVideoRetailBindingVersion || current.Offer.CostVersion >= 1 {
			requested = current.Offer.UpstreamModel
		}
		ctx = withPublishedMediaModel(ctx, a, requested, current.Offer.UpstreamModel, b.Version == StudioVideoRetailBindingVersion || current.Offer.CostVersion >= 1)
		a = publishedMediaExecutionAccount(ctx, a, requested)
		gid := b.Owner.GroupID
		ctx = r.Core.withOpenAIQuotaAutoPauseContext(ctx)
		a = r.Core.recheckSelectedOpenAIAccountFromDBBeforeProfit(ctx, a, &gid, a.Platform, requested, false, "")
		checker := defaultOpenAIAccountScheduler{service: r.Core}
		requiredCapability := OpenAIEndpointCapability("")
		if b.Offer.Adapter.Kind == "seedance_video" {
			requiredCapability = OpenAIEndpointCapabilitySeedance
		}
		req := OpenAIAccountScheduleRequest{GroupID: &gid, Platform: b.Platform, RequestedModel: requested, RequiredCapability: requiredCapability, RequirePrivacySet: r.Core.openAIGroupRequiresPrivacySet(ctx, &gid)}
		if a == nil || !a.IsSchedulable() || !checker.isAccountRequestCompatible(ctx, a, req) || r.Core.isOpenAIAccountRequestRuntimeBlocked(a, requested) || studioMediaBaseURL(a) != b.BaseURL || videoCredentialFingerprint(a) != b.CredentialFingerprint {
			return fail()
		}

	}
	release := func() {}
	if slot {
		if r.Core.concurrencyService == nil {
			return fail()
		}
		s, e := r.Core.concurrencyService.AcquireAccountSlot(ctx, a.ID, a.Concurrency)
		if e != nil || s == nil || !s.Acquired {
			return fail()
		}
		release = s.ReleaseFunc
		fresh, _, e := r.account(ctx, b, true, false)
		if e != nil {
			release()
			return fail()
		}
		a = fresh
	}
	return a, release, nil
}

type StudioVideoState struct {
	Contract        string                 `json:"contract"`
	TaskID          string                 `json:"task_id"`
	UpstreamID      string                 `json:"upstream_id,omitempty"`
	Status          string                 `json:"status"`
	RequestHash     string                 `json:"request_hash"`
	BindingHash     string                 `json:"binding_hash"`
	ResultRetention *StudioResultRetention `json:"result_retention,omitempty"`
}

func videoState(t StudioVideoTask, id, status string) StudioVideoState {
	return StudioVideoState{Contract: StudioVideoBindingVersion, TaskID: t.ID, UpstreamID: id, Status: status, RequestHash: t.Quote.Binding.RequestHash, BindingHash: t.Quote.BindingHash}
}

func (r *StudioVideoRuntime) videoState(t StudioVideoTask, id, status string) StudioVideoState {
	state := videoState(t, id, status)
	if retention, err := r.Store.ResultRetention(t.ID); err == nil {
		state.ResultRetention = &retention
	}
	return state
}

func (r *StudioVideoRuntime) Submit(ctx context.Context, owner StudioImageOwner, key *APIKey, token, id string) (StudioVideoState, error) {
	if !r.Enabled() {
		return StudioVideoState{}, errors.New("account video paid gate off")
	}
	if !videoOwnerKey(owner, key) || !AccountVideoChild(id) || !studioImageTaskID.MatchString(id) {
		return StudioVideoState{}, ErrStudioVideoConflict
	}
	if old, e := r.Store.Task(id, owner); e == nil {
		if old.TokenHash != HashUsageRequestPayload([]byte(token)) {
			return StudioVideoState{}, ErrStudioVideoConflict
		}
		if _, e := os.Stat(r.Store.path("dispatch", id)); e == nil {
			return r.Recover(ctx, owner, id)
		} else if !os.IsNotExist(e) {
			return StudioVideoState{}, e
		}
	} else if !os.IsNotExist(e) {
		return StudioVideoState{}, e
	}
	q, e := r.Store.Quote(token, owner)
	if e != nil {
		return StudioVideoState{}, e
	}
	b := q.Binding
	// Dispatched historical tasks recover above. An old costful quote without a
	// dispatch cannot start a new supplier request under the sale-only contract.
	if b.Version != StudioVideoRetailBindingVersion {
		return StudioVideoState{}, QuoteFailure("account_cost", ErrStudioVideoConflict)
	}
	if !r.Store.now().Before(b.ExpiresAt) || r.Store.now().Before(b.CreatedAt) || !key.Group.ModelAllowlist.Allows(b.Offer.SiteModel) || (key.Quota > 0) != b.KeyQuotaEnabled || key.HasRateLimits() != b.KeyRateEnabled {
		return StudioVideoState{}, ErrStudioVideoConflict
	}
	if !r.PaidControl.AllowsOffer(ctx, "video", b.Offer.AccountID, b.Offer.OfferID) {
		return StudioVideoState{}, ErrPaidControl
	}
	a, release, e := r.account(ctx, b, true, true)
	if e != nil {
		return StudioVideoState{}, e
	}
	defer release()
	t := StudioVideoTask{ID: id, TokenHash: HashUsageRequestPayload([]byte(token)), Quote: q}
	_, e = r.Store.Claim(t)
	if e != nil {
		return StudioVideoState{}, e
	}
	sale, _ := decimal.NewFromString(b.Offer.SalePrice.Amount)
	_, e = r.Orders.ReserveStudioVideoOrder(ctx, &StudioVideoReserveCommand{ChildID: id, UserID: owner.UserID, APIKeyID: owner.APIKeyID, GroupID: owner.GroupID, QuoteID: b.QuoteID, CapabilityVersion: b.CapabilityVersion(), RequestHash: b.RequestHash, HoldAmount: sale.InexactFloat64(), Binding: &b})
	if e != nil {
		return r.videoState(t, "", "reserve_pending"), e
	}
	r.invalidateBilling(ctx, owner)
	claimed, e := r.Store.DispatchClaim(id)
	if e != nil {
		return r.videoState(t, "", "unknown"), e
	}
	if !claimed {
		return r.Recover(ctx, owner, id)
	}
	body, _, e := q.Plan.Materialize()
	if e != nil {
		return r.videoState(t, "", "unknown"), e
	}
	dispatchCtx := context.WithValue(ctx, videoIdempotencyContextKey{}, id)
	dispatchCtx = context.WithValue(dispatchCtx, videoAdapterContextKey{}, q.Binding.Offer.Adapter.Kind)
	dispatchCtx = context.WithValue(dispatchCtx, videoPlanRevisionContextKey{}, q.Plan.AdapterRevision)
	data, _, e := r.request(dispatchCtx, a, http.MethodPost, strings.TrimPrefix(q.Plan.Path, "/v1"), body)
	if e != nil {
		if b.Offer.Adapter.Kind == "image2pro_video" {
			return r.videoState(t, "", "unknown"), errors.Join(ErrStudioVideoUnknown, e)
		}
		return r.videoState(t, "", "unknown"), ErrStudioVideoUnknown
	}
	upstream := videoTaskID(data)
	if !studioImageTaskID.MatchString(upstream) || b.Offer.Adapter.Kind == "image2pro_video" && !image2ProTaskID.MatchString(upstream) {
		return r.videoState(t, "", "unknown"), ErrStudioVideoUnknown
	}
	if e = r.Store.Accept(id, upstream); e != nil {
		return r.videoState(t, "", "unknown"), e
	}
	return r.videoState(t, upstream, "accepted"), nil
}

func videoTaskID(body []byte) string {
	var id string
	for _, p := range []string{"id", "task_id", "data.id", "data.task_id"} {
		if v := gjson.GetBytes(body, p).String(); v != "" {
			if id != "" && id != v {
				return ""
			}
			id = v
		}
	}
	return id
}

// Snapshot reads the original task and native ledger only. It never polls the
// supplier, downloads media, or reserves/finalizes money.
func (r *StudioVideoRuntime) Snapshot(ctx context.Context, owner StudioImageOwner, id string) (StudioVideoState, error) {
	t, e := r.Store.Task(id, owner)
	if e != nil {
		return StudioVideoState{}, e
	}
	if _, e = r.Store.ResultRetention(id); e != nil {
		return StudioVideoState{}, e
	}
	order, e := r.Orders.GetStudioVideoOrder(ctx, owner.UserID, id)
	if e != nil {
		return r.videoState(t, "", "reserve_pending"), e
	}
	b := t.Quote.Binding
	expected := (&StudioVideoReserveCommand{ChildID: id, Binding: &b}).Fingerprint()
	if order.HoldFingerprint != expected || order.CapabilityVersion != b.CapabilityVersion() || order.RequestHash != b.RequestHash || order.APIKeyID != owner.APIKeyID || order.GroupID != owner.GroupID {
		return r.videoState(t, "", "recovery_blocked"), ErrStudioVideoConflict
	}
	if order.State == StudioVideoCaptured {
		return r.videoState(t, order.SupplierTaskID, "captured"), nil
	}
	if order.State == StudioVideoReleased {
		return r.videoState(t, order.SupplierTaskID, "released"), nil
	}
	upstream, e := r.Store.Upstream(id)
	if os.IsNotExist(e) {
		return r.videoState(t, "", "unknown"), nil
	}
	if e != nil {
		return r.videoState(t, "", "unknown"), e
	}
	return r.videoState(t, upstream, "accepted"), nil
}

func (r *StudioVideoRuntime) Recover(ctx context.Context, owner StudioImageOwner, id string) (StudioVideoState, error) {
	state, e := r.Snapshot(ctx, owner, id)
	if e == nil && state.Status == "unknown" {
		return r.recoverLaoliSubmission(ctx, owner, id, state)
	}
	if e != nil || state.Status != "accepted" {
		return state, e
	}
	t, e := r.Store.Task(id, owner)
	if e != nil {
		return state, e
	}
	upstream := state.UpstreamID
	a, release, e := r.account(ctx, t.Quote.Binding, false, false)
	if e != nil {
		return r.videoState(t, upstream, "recovery_blocked"), e
	}
	defer release()
	requestCtx := context.WithValue(ctx, videoAdapterContextKey{}, t.Quote.Binding.Offer.Adapter.Kind)
	body, _, e := r.request(requestCtx, a, http.MethodGet, "/videos/"+url.PathEscape(upstream), nil)
	if e != nil {
		return r.videoState(t, upstream, "unknown"), e
	}
	if remote := videoTaskID(body); remote != upstream {
		return r.videoState(t, upstream, "unknown"), ErrStudioVideoConflict
	}
	status := gjson.GetBytes(body, "status").String()
	if status == "" {
		status = gjson.GetBytes(body, "data.status").String()
	}
	if status == "in_progress" && imagecontract.IsLaoliMediaBase(t.Quote.Binding.BaseURL) {
		status = "processing"
	}
	if status != "completed" && status != "failed" && status != "queued" && status != "processing" {
		status = "unknown"
	}
	return r.videoState(t, upstream, status), nil
}

func (r *StudioVideoRuntime) Original(ctx context.Context, owner StudioImageOwner, id string) ([]byte, string, error) {
	t, e := r.Store.Task(id, owner)
	if e != nil {
		return nil, "", e
	}
	retention, e := r.Store.ResultRetention(id)
	if e != nil {
		return nil, "", e
	}
	if retention.Expired {
		return nil, "", ErrStudioResultExpired
	}
	upstream, e := r.Store.Upstream(id)
	if e != nil {
		return nil, "", e
	}
	order, e := r.Orders.GetStudioVideoOrder(ctx, owner.UserID, id)
	if e != nil || order.State == StudioVideoReleased {
		return nil, "", ErrStudioVideoConflict
	}
	a, release, e := r.account(ctx, t.Quote.Binding, false, false)
	if e != nil {
		return nil, "", e
	}
	defer release()
	requestCtx := context.WithValue(ctx, videoAdapterContextKey{}, t.Quote.Binding.Offer.Adapter.Kind)
	data, mime, err := r.request(requestCtx, a, http.MethodGet, "/videos/"+url.PathEscape(upstream)+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	if retention, err := r.Store.ResultRetention(id); err != nil {
		return nil, "", err
	} else if retention.Expired {
		return nil, "", ErrStudioResultExpired
	}
	return data, mime, nil
}

// Only the authenticated internal delivery adapter calls this after its durable
// original-byte store has decoded the complete video. Browsers cannot send proof.
func (r *StudioVideoRuntime) Capture(ctx context.Context, owner StudioImageOwner, id, resultHash string, retention ...*StudioResultRetention) (*StudioVideoOrder, error) {
	if !videoDigest(resultHash) {
		return nil, ErrStudioVideoConflict
	}
	t, e := r.Store.Task(id, owner)
	if e != nil {
		return nil, e
	}
	var input *StudioResultRetention
	if len(retention) > 0 {
		input = retention[0]
	}
	upstream, e := r.Store.Upstream(id)
	if e != nil {
		return nil, e
	}
	if e = r.Store.captureRetention(t, input); e != nil {
		return nil, e
	}
	b := t.Quote.Binding
	evidence := studioHash(struct{ Binding, Request, Upstream, Result string }{t.Quote.BindingHash, b.RequestHash, upstream, resultHash})
	// Stable durable proof precedes the SQL transaction; recovery reuses it.
	e = r.Store.put("result", id, resultHash)
	if os.IsExist(e) {
		var old string
		e = studioRead(r.Store.path("result", id), &old)
		if e == nil && old != resultHash {
			e = ErrStudioVideoConflict
		}
	}
	if e != nil {
		return nil, e
	}
	sale, _ := decimal.NewFromString(b.Offer.SalePrice.Amount)
	order, err := r.Orders.CaptureStudioVideoOrder(ctx, &StudioVideoCaptureCommand{ChildID: id, UserID: owner.UserID, ActualAmount: sale.InexactFloat64(), SupplierTaskID: upstream, EvidenceHash: evidence, ResultHash: resultHash, Binding: &b})
	if err == nil {
		r.invalidateBilling(ctx, owner)
	}
	return order, err
}

type videoIdempotencyContextKey struct{}
type videoAdapterContextKey struct{}
type videoPlanRevisionContextKey struct{}
type seedanceRawStatusContextKey struct{}

func (r *StudioVideoRuntime) requestHTTP(ctx context.Context, a *Account, method, path string, body []byte) ([]byte, string, error) {
	if adapter, _ := ctx.Value(videoAdapterContextKey{}).(string); adapter == "image2pro_video" {
		return r.requestImage2Pro(ctx, a, method, path, body)
	}
	if adapter, _ := ctx.Value(videoAdapterContextKey{}).(string); adapter == "seedance_video" {
		return r.requestSeedance(ctx, a, method, path, body)
	}
	if a.Platform == PlatformGrok {
		return r.requestGrok(ctx, a, method, path, body)
	}
	root := strings.TrimRight(a.GetOpenAIBaseURL(), "/")
	if !strings.HasSuffix(root, "/v1") {
		root += "/v1"
	}
	contentType := "application/json"
	if revision, _ := ctx.Value(videoPlanRevisionContextKey{}).(string); revision == videoplan.LaoliMediaRevision && method == http.MethodPost {
		if !imagecontract.IsLaoliMediaBase(a.GetOpenAIBaseURL()) || path != "/videos" {
			return nil, "", ErrStudioVideoConflict
		}
		var err error
		body, contentType, err = laoliVideoMultipart(body)
		if err != nil {
			return nil, "", err
		}
	}
	req, e := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), method, root+path, bytes.NewReader(body))
	if e != nil {
		return nil, "", e
	}
	req.GetBody = nil
	if id, ok := ctx.Value(videoIdempotencyContextKey{}).(string); ok && (method == http.MethodPost || method == http.MethodGet && path == "/video-submissions/current" && imagecontract.IsLaoliMediaBase(a.GetOpenAIBaseURL())) {
		req.Header.Set("Idempotency-Key", id)
	}
	req.Header.Set("Authorization", "Bearer "+a.GetOpenAIProtocolAPIKey())
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	resp, e := r.Core.httpUpstream.Do(req, proxy, a.ID, a.Concurrency)
	if e != nil {
		return nil, "", e
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", ErrStudioVideoUnknown
	}
	limit := int64(2 << 20)
	if strings.HasSuffix(path, "/content") {
		limit = 100_000_000
	}
	mediaType := resp.Header.Get("Content-Type")
	if strings.HasSuffix(path, "/content") {
		if imagecontract.IsLaoliMediaBase(a.GetOpenAIBaseURL()) {
			var err error
			mediaType, _, err = mime.ParseMediaType(mediaType)
			if err != nil {
				return nil, "", ErrStudioVideoUnknown
			}
		} else if resp.Header.Get("X-Video-Quality") != "original" {
			return nil, "", ErrStudioVideoUnknown
		}
	}
	if strings.HasSuffix(path, "/content") && (resp.StatusCode != 200 || (mediaType != "video/mp4" && mediaType != "video/webm") || resp.Header.Get("Content-Range") != "") {
		return nil, "", ErrStudioVideoUnknown
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil || int64(len(data)) > limit {
		return nil, "", ErrStudioVideoUnknown
	}
	return data, mediaType, nil
}

func (r *StudioVideoRuntime) requestSeedance(ctx context.Context, a *Account, method, path string, body []byte) ([]byte, string, error) {
	trimmed := strings.TrimPrefix(path, "/contents/generations/tasks/")
	if strings.HasPrefix(path, "/videos/") {
		trimmed = strings.TrimPrefix(path, "/videos/")
	}
	trimmed = strings.TrimSuffix(trimmed, "/content")
	if trimmed == "" || strings.ContainsAny(trimmed, "/?#") {
		if method != http.MethodPost || path != "/contents/generations/tasks" {
			return nil, "", ErrStudioVideoConflict
		}
	}
	endpoint := SeedanceEndpointCreate
	if method == http.MethodGet {
		endpoint = SeedanceEndpointStatus
	}
	if method == http.MethodDelete {
		endpoint = SeedanceEndpointDelete
	}
	if strings.HasSuffix(path, "/content") {
		// Content retrieval needs the native task payload, including its
		// provider URL. The normal status path intentionally normalizes the
		// response to id/status for polling, so use a scoped raw-status marker
		// rather than trying to reconstruct the URL from that summary.
		rawCtx := context.WithValue(ctx, seedanceRawStatusContextKey{}, true)
		status, _, err := r.requestSeedance(rawCtx, a, http.MethodGet, "/contents/generations/tasks/"+trimmed, nil)
		if err != nil {
			return nil, "", err
		}
		urlValue := firstNonEmptyString(gjson.GetBytes(status, "content.video_url").String(), gjson.GetBytes(status, "data.content.video_url").String(), gjson.GetBytes(status, "video_url").String(), gjson.GetBytes(status, "data.video_url").String())
		if urlValue == "" {
			return nil, "", ErrStudioVideoUnknown
		}
		client := &http.Client{Transport: studioImageDownloadTransport{r.Core, a}, Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Get(urlValue)
		if err != nil {
			return nil, "", ErrStudioVideoUnknown
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Range") != "" || (resp.Header.Get("Content-Type") != "video/mp4" && resp.Header.Get("Content-Type") != "video/webm") {
			return nil, "", ErrStudioVideoUnknown
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 100_000_001))
		if err != nil || len(data) > 100_000_000 {
			return nil, "", ErrStudioVideoUnknown
		}
		return data, resp.Header.Get("Content-Type"), nil
	}
	c, capture := newStudioNativeContext(ctx, method, "/api/v3/contents/generations/tasks", body, 2<<20)
	result, err := r.Core.ForwardSeedance(c.Request.Context(), c, a, endpoint, trimmed, body)
	data, _, err := studioNativeResult(capture, result, err)
	if err != nil {
		return nil, "", err
	}
	if endpoint == SeedanceEndpointStatus {
		if raw, _ := ctx.Value(seedanceRawStatusContextKey{}).(bool); raw {
			return data, "application/json", nil
		}
		status := strings.ToLower(firstNonEmptyString(gjson.GetBytes(data, "status").String(), gjson.GetBytes(data, "data.status").String()))
		switch status {
		case "succeeded", "completed", "success":
			status = "completed"
		case "running", "processing", "in_progress":
			status = "processing"
		case "failed", "cancelled", "canceled", "expired":
			status = "failed"
		default:
			status = "queued"
		}
		normalized, marshalErr := json.Marshal(map[string]string{"id": trimmed, "status": status})
		return normalized, "application/json", marshalErr
	}
	return data, "application/json", nil
}

// Release requires a verified terminal failure. Unknown POSTs stay held; no
// current Account/catalog interpretation or automatic regeneration is allowed.
func (r *StudioVideoRuntime) Release(ctx context.Context, owner StudioImageOwner, id string) (*StudioVideoOrder, error) {
	t, e := r.Store.Task(id, owner)
	if e != nil {
		return nil, e
	}
	state, e := r.Recover(ctx, owner, id)
	if e != nil {
		return nil, e
	}
	if state.Status == "released" {
		return r.Orders.GetStudioVideoOrder(ctx, owner.UserID, id)
	}
	if state.Status != "failed" {
		return nil, ErrStudioVideoUnknown
	}
	b := t.Quote.Binding
	order, err := r.Orders.ReleaseStudioVideoOrder(ctx, &StudioVideoReleaseCommand{ChildID: id, UserID: owner.UserID, Reason: "supplier_failed", EvidenceHash: studioHash(state), Binding: &b})
	if err == nil {
		r.invalidateBilling(ctx, owner)
	}
	return order, err
}

// Invalidation is retryable and has no monetary effects. Never replay a money
// command merely because a cache refresh failed after commit.
func (r *StudioVideoRuntime) invalidateBilling(ctx context.Context, owner StudioImageOwner) {
	if r.APIKeys != nil {
		r.APIKeys.InvalidateAuthCacheByUserID(ctx, owner.UserID)
	}
	if r.Core != nil && r.Core.billingCacheService != nil {
		_ = r.Core.billingCacheService.InvalidateUserBalance(ctx, owner.UserID)
		_ = r.Core.billingCacheService.InvalidateAPIKeyRateLimit(ctx, owner.APIKeyID)
	}
}

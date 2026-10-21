package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"sort"
	"time"
)

type paidSidecar struct {
	Version      string `json:"version"`
	Ready        bool   `json:"ready"`
	ImageGroup   int64  `json:"image_group"`
	VideoGroup   int64  `json:"video_group"`
	Assets       bool   `json:"assets"`
	CoreLoopback bool   `json:"core_loopback"`
	ImageReady   bool   `json:"image_ready"`
	VideoReady   bool   `json:"video_ready"`
	ImageStorage string `json:"image_storage"`
	VideoStorage string `json:"video_storage"`
	AssetStorage string `json:"asset_storage"`
}
type paidSnapshot struct {
	accounts     []mediaworkbench.Account
	key          *APIKey
	subscription *UserSubscription
	group        int64
	fingerprint  string
	grants       map[string]string
	checks       []PaidCheck
	assets       bool
}
type studioPaidPreflight struct {
	image *StudioImageRuntime
	video *StudioVideoRuntime
	keys  *APIKeyService
}

func NewStudioPaidControl(settings SettingRepository, image *StudioImageRuntime, video *StudioVideoRuntime, keys *APIKeyService) *StudioPaidControl {
	p := &studioPaidPreflight{image, video, keys}
	c := &StudioPaidControl{Settings: settings, Managed: StudioManagedPaidMode()}
	c.Check = p.check
	c.Snapshot = func(ctx context.Context, m string, actor int64) (paidDependencies, error) {
		v, e := p.snapshot(ctx, m, actor)
		return paidDependencies{Shared: v.fingerprint, Offers: v.grants}, e
	}
	return c
}
func paidSidecarStatus(ctx context.Context, raw string) (paidSidecar, error) {
	var out paidSidecar
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return out, ErrPaidControl
	}
	u.Path = "/internal/studio/paid-control"
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil) //nolint:gosec // G704: deployment-only URL, literal loopback IP and http validated above; path overwritten, no redirects.
	if e != nil {
		return out, e
	}
	secret := os.Getenv("STUDIO_BRIDGE_SERVICE_TOKEN")
	if len(secret) < 32 {
		return out, ErrPaidControl
	}
	req.Header.Set("X-Studio-Service-Token", secret)
	client := http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, e := client.Do(req) //nolint:gosec // G704: only the validated literal loopback endpoint; proxy and redirects disabled.
	if e != nil {
		return out, ErrPaidControl
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out) != nil || out.Version != StudioPaidControlVersion || !out.Ready {
		return out, ErrPaidControl
	}
	return out, nil
}
func (p *studioPaidPreflight) snapshot(ctx context.Context, m string, actor int64) (paidSnapshot, error) {
	out := paidSnapshot{grants: map[string]string{}}
	if !validPaidMedia(m) || actor <= 0 || p.image == nil || p.video == nil || p.keys == nil || p.keys.apiKeyRepo == nil || p.image.Core == nil || p.image.Core.accountRepo == nil || p.image.Media == nil || p.image.Store == nil || p.video.Store == nil {
		return out, ErrPaidControl
	}
	bridge, e := paidSidecarStatus(ctx, firstNonEmptyString(os.Getenv("STUDIO_CONTROL_BRIDGE_URL"), "http://127.0.0.1:8091"))
	if e != nil || !bridge.CoreLoopback {
		return out, QuoteFailure("sidecar_runtime", ErrPaidControl)
	}
	bff, e := paidSidecarStatus(ctx, firstNonEmptyString(os.Getenv("STUDIO_CONTROL_BFF_URL"), "http://127.0.0.1:8092"))
	if e != nil {
		return out, QuoteFailure("sidecar_runtime", e)
	}
	if (m == "image" && !bff.ImageReady) || (m == "video" && !bff.VideoReady) {
		return out, QuoteFailure("private_result_storage", ErrPaidControl)
	}
	out.group = bridge.ImageGroup
	if m == "video" {
		out.group = bridge.VideoGroup
	}
	if out.group <= 0 {
		return out, ErrPaidControl
	}
	out.assets = bff.Assets
	keys, _, e := p.keys.apiKeyRepo.ListByUserID(ctx, actor, pagination.PaginationParams{Page: 1, PageSize: 1, SortBy: "id", SortOrder: "asc"}, APIKeyListFilters{GroupID: &out.group, Status: StatusActive})
	if e != nil || len(keys) != 1 {
		return out, QuoteFailure("customer_key", ErrPaidControl)
	}
	key, e := p.keys.GetByID(ctx, keys[0].ID)
	if e != nil || key == nil || key.User == nil || key.Group == nil || key.GroupID == nil || *key.GroupID != out.group || key.UserID != actor || !key.IsActive() || key.IsExpired() || !key.User.IsActive() || !key.Group.IsActive() {
		return out, QuoteFailure("customer_key", ErrPaidControl)
	}
	if !key.Group.IsSubscriptionType() && !key.User.CanBindGroup(key.Group.ID, key.Group.IsExclusive) {
		return out, QuoteFailure("customer_key", ErrPaidControl)
	}
	out.key = key
	rows, e := p.image.Media.List(ctx)
	if e != nil {
		return out, e
	}
	storage, coreRoot := bff.ImageStorage, p.image.Store.Root
	if m == "video" {
		storage, coreRoot = bff.VideoStorage, p.video.Store.Root
	}
	parts := []any{key.User.AllowedGroups, key.User.RestrictPublicGroups, key.User.Role, key.User.RPMLimit, m, bridge.Version, bridge.CoreLoopback, out.group, bff.Version, storage, bff.AssetStorage, bff.Assets, coreRoot, struct {
		ID          int64
		UserID      int64
		UserStatus  string
		Group       any
		Status      string
		Quota       float64
		Expiry      *time.Time
		Rates       [3]float64
		Allow, Deny []string
	}{key.ID, key.UserID, key.User.Status, studioPaidGroupIdentity(key.Group), key.Status, key.Quota, key.ExpiresAt, [3]float64{key.RateLimit5h, key.RateLimit1d, key.RateLimit7d}, key.IPWhitelist, key.IPBlacklist}}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	for _, a := range rows {
		if a.Config == nil || a.Config.Published == nil || !a.Config.Sales.Enabled {
			continue
		}
		applicable := false
		for _, o := range a.Config.Published.Offers {
			if o.MediaType == m {
				applicable = true
			}
		}
		if !applicable {
			continue
		}
		native, e := p.image.Core.accountRepo.GetByID(ctx, a.ID)
		// A missing/unusable Account excludes only its offers. Media.List and shared
		// services remain fail-closed; per-request native admission is still required.
		if e != nil || native == nil || !native.IsSchedulable() {
			out.checks = append(out.checks, PaidCheck{Code: "native_account", AccountID: a.ID})
			continue
		}
		if !slices.Contains(native.GroupIDs, out.group) {
			continue
		}
		if p.image.CatalogSync != nil && !p.image.CatalogSync.Current(native) {
			out.checks = append(out.checks, PaidCheck{Code: "model_catalog", AccountID: a.ID})
			continue
		}
		for _, offer := range a.Config.Published.Offers {
			if offer.MediaType != m || !key.Group.ModelAllowlist.Allows(offer.SiteModel) {
				continue
			}
			identity, ok := mediaworkbench.PublishedOfferIdentity(&a, offer.OfferID)
			if !ok {
				continue
			}
			mappedModel := offer.UpstreamModel
			if offer.MediaType == "image" && offer.CostVersion == 0 {
				mappedModel = native.GetMappedModel(offer.SiteModel)
			}
			credentials := make(map[string]any, len(native.Credentials))
			for k, v := range native.Credentials {
				// Mapping for another product cannot invalidate this product's grant.
				if k != "model_mapping" && k != "compact_model_mapping" {
					credentials[k] = v
				}
			}
			proxy := ""
			if native.Proxy != nil {
				proxy = native.Proxy.URL()
			}
			out.grants[paidOfferKey(a.ID, offer.OfferID)] = studioHash([]any{nil, identity, native.ID, native.Type, native.Platform, native.ParentAccountID, credentials, native.ProxyID, proxy, studioMediaBaseURL(native), mappedModel, native.GroupIDs, native.RateMultiplier, []float64{native.GetQuotaLimit(), native.GetQuotaDailyLimit(), native.GetQuotaWeeklyLimit()}})
		}
		out.accounts = append(out.accounts, a)
	}
	out.subscription, e = p.sharedEligibility(ctx, m, key)
	if e != nil {
		return out, e
	}
	out.fingerprint = studioHash(parts)
	return out, nil
}

// API pricing/aliases are independent. Retain actual Group access, identity and
// shared quota/concurrency policies in the activation dependency fingerprint.
func studioPaidGroupIdentity(g *Group) any {
	if g == nil {
		return nil
	}
	return []any{g.ID, g.Platform, g.Status, g.IsExclusive, g.SubscriptionType,
		g.DailyLimitUSD, g.WeeklyLimitUSD, g.MonthlyLimitUSD, g.AllowImageGeneration,
		g.AllowBatchImageGeneration, g.ModelAllowlist, g.RequirePrivacySet,
		g.RequireOAuthOnly, g.RPMLimit}
}

func (p *studioPaidPreflight) sharedEligibility(ctx context.Context, m string, key *APIKey) (*UserSubscription, error) {
	var sub *UserSubscription
	if key.Group.IsSubscriptionType() {
		if p.keys.userSubRepo == nil {
			return nil, QuoteFailure("subscription", ErrPaidControl)
		}
		var err error
		sub, err = p.keys.userSubRepo.GetActiveByUserIDAndGroupID(ctx, key.UserID, *key.GroupID)
		if err != nil || sub == nil {
			return nil, QuoteFailure("subscription", ErrPaidControl)
		}
	}
	if key.IsQuotaExhausted() {
		return nil, QuoteFailure("customer_quota", ErrPaidControl)
	}
	if allowed, _ := ip.CheckIPRestriction("127.0.0.1", key.IPWhitelist, key.IPBlacklist); !allowed {
		return nil, QuoteFailure("customer_key_network_restricted", ErrPaidControl)
	}
	if p.image.Core.billingCacheService == nil {
		return nil, QuoteFailure("billing_eligibility", ErrPaidControl)
	}
	if err := p.image.Core.billingCacheService.checkBillingEligibility(ctx, key.User, key, key.Group, sub, QuotaPlatform(ctx, key), false); err != nil {
		return nil, QuoteFailure("billing_eligibility", err)
	}
	var err error
	root := p.image.Store.Root
	if m == "image" {
		err = p.image.Store.init()
	} else {
		root = p.video.Store.Root
		err = p.video.Store.init()
		if p.video.Orders == nil {
			err = ErrPaidControl
		}
	}
	if err == nil {
		err = probeStudioPrivateRoot(root)
	}
	if err != nil {
		return nil, QuoteFailure("private_result_storage", err)
	}
	return sub, nil
}

func (p *studioPaidPreflight) check(ctx context.Context, m string, actor int64) (report PaidReport) {
	started := time.Now()
	// Only pure Published validation is memoized, for this one video check.
	// Native Account admission and final dependency/Key checks remain live.
	if m == "video" {
		ctx = mediaworkbench.WithPublishedValidationMemo(ctx)
	}
	report = PaidReport{Metrics: &PaidCheckMetrics{TimingsMS: map[string]int64{}}, Media: m, Pass: true, Checks: []PaidCheck{}, CheckedAt: time.Now().UTC()}
	add := func(code string, account int64, product, path string, err error) {
		report.Checks = append(report.Checks, PaidCheck{code, account, product, path, err == nil})
		if err != nil && account == 0 {
			report.Pass = false
			report.sharedFailure = true
		}
	}
	defer func() {
		report.Metrics.TimingsMS["total"] = time.Since(started).Milliseconds()
		report.Metrics.ProductValidations, report.Metrics.ValidationReuses = mediaworkbench.PublishedValidationMemoStats(ctx)
		if err := ctx.Err(); err != nil {
			code := "check_cancelled"
			if errors.Is(err, context.DeadlineExceeded) {
				code = "check_timeout"
			}
			add(code, 0, "", "", err)
		}
	}()
	if ctx.Err() != nil {
		return report
	}
	catalogUnavailable := map[int64]bool{}
	stage := time.Now()
	if p.image != nil && p.image.CatalogSync != nil {
		rows, err := p.image.Media.List(ctx)
		if err != nil {
			add("model_catalog", 0, "", "", err)
			return report
		}
		for _, a := range rows {
			if a.Config == nil || a.Config.Published == nil || !a.Config.Sales.Enabled {
				continue
			}
			if err = p.image.CatalogSync.Ensure(ctx, a.ID); err != nil {
				catalogUnavailable[a.ID] = true
				add("model_catalog", a.ID, "", "", err)
			}
		}
	}
	report.Metrics.TimingsMS["model_catalog"] = time.Since(stage).Milliseconds()
	stage = time.Now()
	snap, e := p.snapshot(ctx, m, actor)
	report.Metrics.TimingsMS["initial_dependencies"] = time.Since(stage).Milliseconds()
	if e != nil {
		var qe *StudioQuoteError
		code := "dependencies_unavailable"
		if errors.As(e, &qe) {
			code = qe.Stage
		}
		add(code, 0, "", "", e)
		return report
	}
	report.Checks = append(report.Checks, snap.checks...)
	report.dependencies = paidDependencies{Shared: snap.fingerprint, Offers: map[string]string{}}
	key := snap.key
	owner := StudioImageOwner{key.UserID, key.ID, *key.GroupID}
	report.GroupID = owner.GroupID
	sub := snap.subscription
	var sid *int64
	if sub != nil {
		sid = &sub.ID
	}
	add("billing_eligibility", 0, "", "", nil)
	add("private_result_storage", 0, "", "", nil)
	report.Metrics.TimingsMS["eligibility_and_storage"] = time.Since(started).Milliseconds() - report.Metrics.TimingsMS["initial_dependencies"]
	for i := range snap.accounts {
		if ctx.Err() != nil {
			return report
		}
		a := &snap.accounts[i]
		if catalogUnavailable[a.ID] {
			continue
		}
		inspection, err := mediaworkbench.InspectPublishedOffers(ctx, a, m)
		report.Metrics.TimingsMS["published_validation"] += inspection.ValidationTime.Milliseconds()
		report.Metrics.TimingsMS["spec_compilation"] += inspection.CompilationTime.Milliseconds()
		report.Metrics.SpecsChecked += inspection.SpecCount
		add("published_specs", a.ID, "", "", err)
		if err != nil {
			if ctx.Err() != nil {
				return report
			}
			continue
		}
		report.Metrics.AccountsValidated++
		for _, checked := range inspection.Offers {
			o, selected := checked.Offer, checked.Selected
			err = checked.Err
			if _, edit := selected["edit"]; edit && !snap.assets {
				err = ErrPaidControl
			}
			add("spec_compilation_and_assets", a.ID, o.ProductID, "", err)
			if err != nil {
				continue
			}
			offerPass := len(selected) > 0
			for _, path := range []string{"text", "edit"} {
				spec, ok := selected[path]
				if !ok {
					continue
				}
				if ctx.Err() != nil {
					return report
				}
				quoteStarted := time.Now()
				if m == "image" {
					err = p.image.quotePreflight(ctx, owner, key, o.OfferID, spec, sid)
				} else {

					// Reuse the native preview constructor for each actual wire profile.
					// These inert URLs are compiled, never fetched or uploaded.
					var product mediaworkbench.Product
					for _, p := range a.Config.Published.Products {
						if p.ProductID == o.ProductID {
							product = p
						}
					}
					profile, ok := mediaworkbench.VideoProfileModel(product)
					if !ok {
						err = QuoteFailure("execution", ErrPaidControl)
					} else {
						var plan videoplan.Plan
						plan, err = videoplan.PreviewWithModel(profile, o.UpstreamModel, spec.Resolution, spec.AspectRatio, spec.DurationSeconds, spec.Images, spec.Videos, spec.Audio)
						if err == nil {
							err = p.video.quotePreflight(ctx, owner, key, o.OfferID, spec, plan.Body)
						} else {
							err = QuoteFailure("execution", err)
						}
					}
				}
				report.Metrics.TimingsMS["native_quotes"] += time.Since(quoteStarted).Milliseconds()
				code := "native_quote"
				if err != nil {
					code = "quote_" + QuoteFailureStage(err)
				}
				add(code, a.ID, o.ProductID, path, err)
				if err != nil {
					offerPass = false
				}
			}
			if identity := snap.grants[paidOfferKey(a.ID, o.OfferID)]; offerPass && identity != "" {
				report.dependencies.Offers[paidOfferKey(a.ID, o.OfferID)] = identity
			}
		}
	}
	if ctx.Err() != nil {
		return report
	}
	stage = time.Now()
	latest, e := p.snapshot(ctx, m, actor)
	report.Metrics.TimingsMS["final_dependencies"] = time.Since(stage).Milliseconds()
	if e != nil || latest.fingerprint != snap.fingerprint {
		add("dependencies_changed", 0, "", "", ErrPaidControl)
	} else {
		// Do not authorize a changed offer or latch unrelated offers closed when one
		// product disappears during the scan.
		for id, identity := range report.dependencies.Offers {
			if latest.grants[id] != identity {
				delete(report.dependencies.Offers, id)
			}
		}
	}
	if len(report.dependencies.Offers) == 0 {
		report.Pass = false
		report.Checks = append(report.Checks, PaidCheck{Code: "published_offer"})
	}
	report.Fingerprint = studioHash(report.dependencies)
	return report
}

// The root is from the already validated private runtime store, never a request.
func probeStudioPrivateRoot(root string) error {
	f, err := os.CreateTemp(root, ".paid-preflight-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }() //nolint:gosec // only this probe's CreateTemp path
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write([]byte("storage-check"))
	}
	if err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err != nil {
		return err
	}
	return closed
}

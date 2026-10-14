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
	accounts    []mediaworkbench.Account
	key         *APIKey
	group       int64
	fingerprint string
	assets      bool
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
	c.Fingerprint = func(ctx context.Context, m string, actor int64) (string, error) {
		v, e := p.snapshot(ctx, m, actor)
		return v.fingerprint, e
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
	var out paidSnapshot
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
	if e != nil || key.User == nil || key.Group == nil || key.GroupID == nil || *key.GroupID != out.group || key.UserID != actor || !key.IsActive() || key.IsExpired() || !key.User.IsActive() || !key.Group.IsActive() {
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
		Group       *Group
		Status      string
		Quota       float64
		Expiry      *time.Time
		Rates       [3]float64
		Allow, Deny []string
	}{key.ID, key.UserID, key.User.Status, key.Group, key.Status, key.Quota, key.ExpiresAt, [3]float64{key.RateLimit5h, key.RateLimit1d, key.RateLimit7d}, key.IPWhitelist, key.IPBlacklist}}
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
		if e != nil {
			return out, e
		}
		if !slices.Contains(native.GroupIDs, out.group) {
			continue
		}
		// Exclude unpublished Draft and live usage counters. Every frozen Published,
		// mapping, routing, auth, Account-cost and permission dependency participates.
		parts = append(parts, []any{a.ID, a.Status, a.Schedulable, a.RuntimeReady, mediaworkbench.DependenciesFor(&a), a.Config.Sales, a.Config.Published, studioCredentialFingerprint(native), native.GroupIDs, native.RateMultiplier, []float64{native.GetQuotaLimit(), native.GetQuotaDailyLimit(), native.GetQuotaWeeklyLimit()}})
		out.accounts = append(out.accounts, a)
	}
	if len(out.accounts) == 0 {
		return out, QuoteFailure("published_offer", ErrPaidControl)
	}
	if ch := p.image.Core.channelService; ch != nil && ch.repo != nil {
		cid, e := ch.repo.GetChannelIDByGroupID(ctx, out.group)
		if e != nil {
			return out, e
		}
		if cid > 0 {
			c, e := ch.repo.GetByID(ctx, cid)
			if e != nil {
				return out, e
			}
			parts = append(parts, c)
		}
	}
	out.fingerprint = studioHash(parts)
	return out, nil
}
func (p *studioPaidPreflight) check(ctx context.Context, m string, actor int64) (report PaidReport) {
	started := time.Now()
	report = PaidReport{Metrics: &PaidCheckMetrics{TimingsMS: map[string]int64{}}, Media: m, Pass: true, Checks: []PaidCheck{}, CheckedAt: time.Now().UTC()}
	add := func(code string, account int64, product, path string, err error) {
		report.Checks = append(report.Checks, PaidCheck{code, account, product, path, err == nil})
		if err != nil {
			report.Pass = false
		}
	}
	defer func() {
		report.Metrics.TimingsMS["total"] = time.Since(started).Milliseconds()
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
	stage := time.Now()
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
	report.Fingerprint = snap.fingerprint
	key := snap.key
	owner := StudioImageOwner{key.UserID, key.ID, *key.GroupID}
	var sub *UserSubscription
	if key.Group.IsSubscriptionType() {
		sub, e = p.keys.userSubRepo.GetActiveByUserIDAndGroupID(ctx, key.UserID, *key.GroupID)
		if e != nil {
			add("subscription", 0, "", "", e)
			return report
		}
	}
	if key.IsQuotaExhausted() {
		add("customer_quota", 0, "", "", ErrPaidControl)
		return report
	}
	// The managed Bridge handshake verifies its Core transport is IPv4 loopback,
	// with no forwarded client headers. Reuse the native API-key ACL at that ingress.
	if allowed, _ := ip.CheckIPRestriction("127.0.0.1", key.IPWhitelist, key.IPBlacklist); !allowed {
		add("customer_key_network_restricted", 0, "", "", ErrPaidControl)
		return report
	}
	if p.image.Core.billingCacheService == nil {
		add("billing_eligibility", 0, "", "", ErrPaidControl)
		return report
	}
	e = p.image.Core.billingCacheService.CheckBillingEligibility(ctx, key.User, key, key.Group, sub, QuotaPlatform(ctx, key))
	add("billing_eligibility", 0, "", "", e)
	if e != nil {
		return report
	}
	var sid *int64
	if sub != nil {
		sid = &sub.ID
	}
	if m == "image" {
		e = p.image.Store.init()
	} else {
		e = p.video.Store.init()
		if p.video.Orders == nil {
			e = ErrPaidControl
		}
	}
	if e == nil {
		root := p.image.Store.Root
		if m == "video" {
			root = p.video.Store.Root
		}
		e = probeStudioPrivateRoot(root)
	}
	add("private_result_storage", 0, "", "", e)
	if e != nil {
		return report
	}
	report.Metrics.TimingsMS["eligibility_and_storage"] = time.Since(started).Milliseconds() - report.Metrics.TimingsMS["initial_dependencies"]
	for i := range snap.accounts {
		if ctx.Err() != nil {
			return report
		}
		a := &snap.accounts[i]
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
					_, err = p.image.Issue(ctx, owner, key, o.OfferID, spec, sid)
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
						err = ErrPaidControl
					} else {
						var plan videoplan.Plan
						plan, err = videoplan.PreviewWithModel(profile, o.UpstreamModel, spec.Resolution, spec.AspectRatio, spec.DurationSeconds, spec.Images, spec.Videos, spec.Audio)
						if err == nil {
							err = p.video.quotePreflight(ctx, owner, key, o.OfferID, spec, plan.Body)
						}
					}
				}
				report.Metrics.TimingsMS["native_quotes"] += time.Since(quoteStarted).Milliseconds()
				code := "native_quote"
				if err != nil {
					code = "quote_" + QuoteFailureStage(err)
				}
				add(code, a.ID, o.ProductID, path, err)
			}
		}
	}
	if ctx.Err() != nil {
		return report
	}
	stage = time.Now()
	latest, e := p.snapshot(ctx, m, actor)
	report.Metrics.TimingsMS["final_dependencies"] = time.Since(stage).Milliseconds()
	if e != nil || latest.fingerprint != report.Fingerprint {
		add("dependencies_changed", 0, "", "", ErrPaidControl)
	}
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

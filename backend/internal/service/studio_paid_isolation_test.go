package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/gin-gonic/gin"
)

func paidGrantFixture(t *testing.T, media string, current *paidDependencies) *StudioPaidControl {
	t.Helper()
	gate := &StudioPaidControl{Managed: true, Settings: &paidSettingsFake{values: map[string]string{}}}
	gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) { return *current, nil }
	gate.Check = func(context.Context, string, int64) PaidReport {
		approved := paidDependencies{Shared: current.Shared, Offers: map[string]string{}}
		for k, v := range current.Offers {
			approved.Offers[k] = v
		}
		return PaidReport{Pass: len(approved.Offers) > 0, Fingerprint: studioHash(approved), dependencies: approved}
	}
	report := gate.Preflight(context.Background(), media, 1)
	if state, _, err := gate.Apply(context.Background(), media, 1, true, "", report.Fingerprint); err != nil || !state.Effective {
		t.Fatalf("activate: %+v %v", state, err)
	}
	return gate
}

func TestStudioPaidOfferGrantSubsetAndRestoration(t *testing.T) {
	ctx := context.Background()
	current := paidDependencies{Shared: "shared", Offers: map[string]string{"7:a": "a1", "8:b": "b1"}}
	gate := paidGrantFixture(t, "image", &current)
	delete(current.Offers, "7:a")
	if !gate.Effective(ctx, "image") || gate.AllowsOffer(ctx, "image", 7, "a") || !gate.AllowsOffer(ctx, "image", 8, "b") {
		t.Fatal("one removed offer affected another grant")
	}
	current.Offers["9:new"] = "new1"
	current.Offers["7:a"] = "a2"
	if gate.AllowsOffer(ctx, "image", 9, "new") || gate.AllowsOffer(ctx, "image", 7, "a") || !gate.Effective(ctx, "image") {
		t.Fatal("new or changed offer borrowed grant")
	}
	delete(current.Offers, "8:b")
	if gate.Effective(ctx, "image") || gate.Status(ctx, "image").Reason != "no_approved_offer" {
		t.Fatal("zero approved offers remained open")
	}
	current.Offers["7:a"] = "a1"
	if !gate.AllowsOffer(ctx, "image", 7, "a") {
		t.Fatal("restored identical approved offer remained globally latched")
	}
	current.Shared = "changed"
	if gate.Effective(ctx, "image") {
		t.Fatal("shared permission drift remained open")
	}
	current.Shared = "shared"
	if gate.Effective(ctx, "image") {
		t.Fatal("shared failure did not latch")
	}
}

func TestStudioPaidPartialPreflightDoesNotRevokeOtherGrant(t *testing.T) {
	ctx := context.Background()
	current := paidDependencies{Shared: "shared", Offers: map[string]string{"7:a": "a1"}}
	gate := paidGrantFixture(t, "image", &current)
	gate.Check = func(context.Context, string, int64) PaidReport {
		return PaidReport{Pass: true, Checks: []PaidCheck{{Code: "native_quote", AccountID: 8, Pass: false}}}
	}
	gate.Preflight(ctx, "image", 1)
	if !gate.Effective(ctx, "image") {
		t.Fatal("partial preflight latched healthy offers")
	}
	gate.Check = func(context.Context, string, int64) PaidReport { return PaidReport{Pass: false, sharedFailure: true} }
	gate.Preflight(ctx, "image", 1)
	if gate.Effective(ctx, "image") {
		t.Fatal("shared failed preflight did not close")
	}
}

func TestStudioPaidOfferChangeDuringApply(t *testing.T) {
	ctx := context.Background()
	approved := paidDependencies{Shared: "s", Offers: map[string]string{"7:a": "old"}}
	gate := &StudioPaidControl{Managed: true, Settings: &paidSettingsFake{values: map[string]string{}}}
	gate.Check = func(context.Context, string, int64) PaidReport {
		return PaidReport{Pass: true, Fingerprint: studioHash(approved), dependencies: approved}
	}
	gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) {
		return paidDependencies{Shared: "s", Offers: map[string]string{"7:a": "new"}}, nil
	}
	if state, _, err := gate.Apply(ctx, "image", 1, true, "", studioHash(approved)); err == nil || state.Effective || state.Requested {
		t.Fatal("changed grant passed final guard")
	}
}

func TestStudioPaidNewOfferCannotDispatch(t *testing.T) {
	ctx := context.Background()
	t.Run("image", func(t *testing.T) {
		r, q, key, _, billing := studioContractFixture(t)
		current := paidDependencies{Shared: "s", Offers: map[string]string{"99:approved": "old"}}
		r.PaidControl = paidGrantFixture(t, "image", &current)
		current.Offers[paidOfferKey(q.Binding.Offer.AccountID, q.Binding.Offer.OfferID)] = "unchecked"
		calls := 0
		r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
			calls++
			return nil, "", errors.New("unexpected")
		}
		if _, err := r.Dispatch(ctx, nil, q, "unchecked-image", "prompt", nil, key); !errors.Is(err, ErrPaidControl) || calls != 0 || len(billing.events) != 0 {
			t.Fatalf("unapproved dispatch: %v calls=%d billing=%d", err, calls, len(billing.events))
		}
		execution, err := mediaworkbench.PublishedImageExecution(q.Binding)
		if err != nil {
			t.Fatal(err)
		}
		q.Execution = &execution
		q.BindingHash = studioQuoteHash(q)
		if _, err = r.Dispatch(ctx, nil, q, "unchecked-multi", "prompt", nil, key); !errors.Is(err, ErrPaidControl) || calls != 0 {
			t.Fatalf("unapproved multi dispatch: %v calls=%d", err, calls)
		}
	})
	t.Run("video", func(t *testing.T) {
		r, token, q, key, _, orders := videoRuntimeFixture(t)
		current := paidDependencies{Shared: "s", Offers: map[string]string{"99:approved": "old"}}
		r.PaidControl = paidGrantFixture(t, "video", &current)
		current.Offers[paidOfferKey(q.Binding.Offer.AccountID, q.Binding.Offer.OfferID)] = "unchecked"
		calls := 0
		r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
			calls++
			return nil, "", errors.New("unexpected")
		}
		if _, err := r.Submit(ctx, q.Binding.Owner, key, token, "av_unchecked"); !errors.Is(err, ErrPaidControl) || calls != 0 || len(orders.orders) != 0 {
			t.Fatalf("unapproved dispatch: %v calls=%d orders=%d", err, calls, len(orders.orders))
		}
	})
}

type paidPreflightKeys struct {
	APIKeyRepository
	key *APIKey
}

func (r paidPreflightKeys) GetByID(context.Context, int64) (*APIKey, error) { return r.key, nil }
func (r paidPreflightKeys) ListByUserID(context.Context, int64, pagination.PaginationParams, APIKeyListFilters) ([]APIKey, *pagination.PaginationResult, error) {
	return []APIKey{*r.key}, nil, nil
}

func paidPreflightFixture(t *testing.T) (*studioPaidPreflight, *studioMediaFixture, *APIKey) {
	t.Helper()
	image, _, key, _, _ := studioContractFixture(t)
	image.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: studioAccountPrice("0.35")}}
	image.Core.billingCacheService = &BillingCacheService{cfg: &config.Config{RunMode: config.RunModeSimple}}
	key.Status = StatusActive
	key.User = &User{ID: 1, Status: StatusActive}
	key.Group.Status = StatusActive
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Studio-Service-Token") != "synthetic-preflight-service-token-32" {
			t.Error("missing token")
		}
		_, _ = w.Write([]byte(`{"version":"managed-v1","ready":true,"core_loopback":true,"image_group":3,"video_group":3,"image_ready":true,"video_ready":true,"assets":true,"image_storage":"image","video_storage":"video","asset_storage":"assets"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", "synthetic-preflight-service-token-32")
	t.Setenv("STUDIO_CONTROL_BRIDGE_URL", server.URL)
	t.Setenv("STUDIO_CONTROL_BFF_URL", server.URL)
	video := &StudioVideoRuntime{Store: &StudioVideoStore{Root: t.TempDir()}, Orders: &videoOrderFixture{orders: map[string]*StudioVideoOrder{}}}
	media, ok := image.Media.(*studioMediaFixture)
	if !ok {
		t.Fatal("invalid media fixture")
	}
	return &studioPaidPreflight{image: image, video: video, keys: &APIKeyService{apiKeyRepo: paidPreflightKeys{key: key}}}, media, key
}

func TestStudioPaidPreflightIsolatesNativeOfferFailure(t *testing.T) {
	ctx := context.Background()
	p, repo, key := paidPreflightFixture(t)
	product := repo.a.Config.Published.Products[0]
	product.ProductID = "other"
	product.SiteModel = "other-image"
	repo.a.ModelMapping = map[string]string{"gpt-image-2": "gpt-image-2", "other-image": "gpt-image-2"}
	svc := mediaworkbench.NewService(repo)
	draft, err := svc.SaveDraft(ctx, 7, repo.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: append(repo.a.Config.Published.Products, product)})
	if err != nil {
		t.Fatal(err)
	}
	if !draft.Config.Validation.PublishReady {
		t.Fatalf("draft not ready: %+v", draft.Config.Validation.Diagnostics)
	}
	if _, err = svc.Publish(ctx, 7, draft.Config.RecordVersion, draft.Config.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	// Media configuration is valid, but the second native Account mapping is not.
	// Its quote must fail without revoking the original product.
	report := p.check(ctx, "image", 1)
	if !report.Pass || len(report.dependencies.Offers) != 1 {
		t.Fatalf("mixed report: %+v grants=%v", report, report.dependencies.Offers)
	}
	rejected := false
	for _, check := range report.Checks {
		if check.ProductID == "other" && !check.Pass {
			rejected = true
		}
	}
	if !rejected {
		t.Fatal("missing failed offer diagnostic")
	}
	before, err := os.ReadDir(p.image.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	healthyOffer := ""
	for _, offer := range repo.a.Config.Published.Offers {
		if offer.ProductID == "p" {
			healthyOffer = offer.OfferID
		}
	}
	if err = p.image.quotePreflight(ctx, StudioImageOwner{1, 2, 3}, key, healthyOffer, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1}, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadDir(p.image.Store.Root)
	if len(before) != len(after) {
		t.Fatal("preflight issued executable quote")
	}
	key.QuotaUsed = key.Quota
	blocked := p.check(ctx, "image", 1)
	if blocked.Pass || !blocked.sharedFailure {
		t.Fatal("shared customer quota failure not closed")
	}
}

func TestStudioPaidSnapshotScopesCostAndMapping(t *testing.T) {
	ctx := context.Background()
	p, repo, _ := paidPreflightFixture(t)
	before, err := p.snapshot(ctx, "image", 1)
	if err != nil || len(before.grants) != 1 {
		t.Fatalf("initial snapshot: %v", err)
	}
	channelRepo, ok := p.image.Core.channelService.repo.(*studioChannelFixture)
	if !ok {
		t.Fatal("invalid channel fixture")
	}
	ch := channelRepo.channel
	ch.AccountStatsPricingRules = append(ch.AccountStatsPricingRules, AccountStatsPricingRule{ID: 99, AccountIDs: []int64{99}, Pricing: []ChannelModelPricing{{Models: []string{"unrelated"}}}})
	accountRepo, ok := p.image.Core.accountRepo.(*studioAccountFixture)
	if !ok {
		t.Fatal("invalid account fixture")
	}
	native := accountRepo.a
	native.Credentials["model_mapping"] = map[string]any{"unrelated": "new-model"}
	after, err := p.snapshot(ctx, "image", 1)
	if err != nil || before.fingerprint != after.fingerprint || studioHash(before.grants) != studioHash(after.grants) {
		t.Fatal("unrelated mapping/cost invalidated approved grant", err)
	}
	amount := "0.99"
	ch.AccountStatsPricingRules[0].Pricing[0].AccountStatsPerRequestExact = &amount
	after, err = p.snapshot(ctx, "image", 1)
	if err != nil || before.fingerprint != after.fingerprint || studioHash(before.grants) == studioHash(after.grants) {
		t.Fatal("own exact cost change not isolated into grant", err)
	}
	// A closed paid control must still allow ordinary non-paid quote previews.
	p.image.PaidControl = &StudioPaidControl{Managed: true, Settings: &paidSettingsFake{values: map[string]string{}}}
	if _, err = p.image.Issue(ctx, StudioImageOwner{1, 2, 3}, p.keys.apiKeyRepo.(paidPreflightKeys).key, repo.a.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1}, nil); err != nil {
		t.Fatal("paid control blocked non-paid quote", err)
	}
}

type paidRPMCounter struct {
	UserRPMCache
	calls int
}

func (c *paidRPMCounter) IncrementUserGroupRPM(context.Context, int64, int64) (int, error) {
	c.calls++
	return 1, nil
}
func (c *paidRPMCounter) IncrementUserRPM(context.Context, int64) (int, error) {
	c.calls++
	return 1, nil
}
func TestStudioPaidFundingObservationDoesNotCountRPM(t *testing.T) {
	ctx := context.Background()
	user := &User{ID: 1, Balance: 10, RPMLimit: 100}
	rpm := &paidRPMCounter{}
	billing := &BillingCacheService{cfg: &config.Config{}, userRepo: studioAccessUsers{users: map[int64]*User{1: user}}, userRPMCache: rpm}
	if err := billing.checkBillingEligibility(ctx, user, nil, nil, nil, "", false); err != nil {
		t.Fatal(err)
	}
	if rpm.calls != 0 {
		t.Fatal("observation consumed RPM")
	}
	if err := billing.CheckBillingEligibility(ctx, user, nil, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if rpm.calls != 1 {
		t.Fatal("ordinary request lost native RPM accounting")
	}
	user.Balance = 0
	if err := billing.checkBillingEligibility(ctx, user, nil, nil, nil, "", false); err == nil {
		t.Fatal("observation bypassed funding check")
	}
}

func TestStudioPaidZeroOfferPreflightRequiresFreshApply(t *testing.T) {
	ctx := context.Background()
	current := paidDependencies{Shared: "shared", Offers: map[string]string{"7:a": "a1"}}
	gate := paidGrantFixture(t, "image", &current)
	delete(current.Offers, "7:a")
	if gate.Effective(ctx, "image") {
		t.Fatal("empty catalog remained enabled")
	}
	if gate.Preflight(ctx, "image", 1).Pass {
		t.Fatal("empty preflight passed")
	}
	current.Offers["7:a"] = "a1"
	if gate.Effective(ctx, "image") {
		t.Fatal("restored catalog reopened after failed preflight")
	}
	report := gate.Preflight(ctx, "image", 1)
	state := gate.Status(ctx, "image")
	if next, _, err := gate.Apply(ctx, "image", 1, true, state.Revision, report.Fingerprint); err != nil || !next.Effective {
		t.Fatal("fresh approved apply could not reopen", err)
	}
}

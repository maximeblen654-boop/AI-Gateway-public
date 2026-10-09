package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
)

type studioMediaFixture struct {
	mediaworkbench.Repository
	a mediaworkbench.Account
}

func (r *studioMediaFixture) Get(context.Context, int64) (*mediaworkbench.Account, error) {
	return &r.a, nil
}
func (r *studioMediaFixture) List(context.Context) ([]mediaworkbench.Account, error) {
	return []mediaworkbench.Account{r.a}, nil
}
func (r *studioMediaFixture) CompareAndSwap(_ context.Context, _ int64, _ int64, c *mediaworkbench.Config) error {
	r.a.Config = c
	return nil
}
func (r *studioMediaFixture) CompareAndSwapChecked(ctx context.Context, id, version int64, _ mediaworkbench.Dependencies, c *mediaworkbench.Config) error {
	return r.CompareAndSwap(ctx, id, version, c)
}

type studioAccountFixture struct {
	AccountRepository
	a       *Account
	deleted bool
	calls   int
}

func (r *studioAccountFixture) GetByID(_ context.Context, id int64) (*Account, error) {
	r.calls++
	if r.deleted || r.a.ID != id {
		return nil, errors.New("deleted")
	}
	return r.a, nil
}

type studioSlotFixture struct {
	ConcurrencyCache
	allowed bool
}

func (s studioSlotFixture) AcquireAccountSlot(context.Context, int64, int, string) (bool, error) {
	return s.allowed, nil
}
func (s studioSlotFixture) ReleaseAccountSlot(context.Context, int64, string) error { return nil }

type studioSchedulerTrap struct {
	OpenAIAccountScheduler
	selects, switches int
}

type studioChannelFixture struct {
	ChannelRepository
	channel *Channel
}

func (r *studioChannelFixture) GetChannelIDByGroupID(context.Context, int64) (int64, error) {
	return 9, nil
}
func (r *studioChannelFixture) GetByID(context.Context, int64) (*Channel, error) {
	return r.channel, nil
}

func (r *studioChannelFixture) ListAll(context.Context) ([]Channel, error) {
	if r.channel == nil {
		return nil, nil
	}
	return []Channel{*r.channel}, nil
}
func (r *studioChannelFixture) GetGroupPlatforms(context.Context, []int64) (map[int64]string, error) {
	return map[int64]string{3: PlatformOpenAI}, nil
}

func TestStudioImageIssuedAccountingSnapshot(t *testing.T) {
	r, original, key, account, billing := studioContractFixture(t)
	live := &studioChannelFixture{channel: studioAccountPrice("0.35")}
	r.Core.channelService = &ChannelService{repo: live}
	key.Quota = 100
	key.Group.RateMultiplier = 9
	customerPrice := 7.0
	live.channel.ApplyPricingToAccountStats = true
	live.channel.ModelPricing = []ChannelModelPricing{{Platform: PlatformOpenAI, Models: []string{"gpt-image-2"}, PerRequestPrice: &customerPrice}}
	ma, ok := r.Media.(*studioMediaFixture)
	if !ok {
		t.Fatal("wrong media fixture")
	}
	ma.a.Config.Procurement = mediaworkbench.Procurement{Entries: []mediaworkbench.ProcurementEntry{{ProductID: original.Binding.Offer.ProductID, Cost: mediaworkbench.Price{Amount: "0.42", Currency: "CNY", BillingMode: "per_request"}}}}
	issue := func() StudioImageQuote {
		t.Helper()
		token, e := r.Issue(context.Background(), original.Owner, key, original.Binding.Offer.OfferID, original.Binding.Spec, nil)
		if e != nil {
			t.Fatal(e)
		}
		q, e := r.Store.Quote(token, original.Owner, time.Now())
		if e != nil {
			t.Fatal(e)
		}
		return q
	}
	q := issue()
	calls := 0
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		calls++
		return studioResult(t, "png"), "original-id", nil
	}
	// Freeze .35/rate 1, then change the live independent rule and multiplier.
	live.channel = studioAccountPrice("0.40")
	v := 2.0
	account.a.RateMultiplier = &v
	newQ := issue()
	if q.Accounting.BaseAmount != "0.35" || newQ.Accounting.BaseAmount != "0.4" || newQ.Accounting.EffectiveAccountQuotaCost != "0.8" || q.Binding.Offer.SalePrice.Amount != "0.80" {
		t.Fatal(q.Accounting, newQ.Accounting)
	}
	_, e := r.Dispatch(context.Background(), nil, q, "snapshot", "prompt", nil, key)
	if e != nil {
		t.Fatal(e)
	}
	if billing.cmd.ExactAmounts.Balance != "0.80" || billing.cmd.ExactAmounts.AccountQuota != "0.35" {
		t.Fatal(billing.cmd)
	}
	live.channel = nil
	_, e = r.Recover(context.Background(), "snapshot", q.Owner)
	if e != nil || calls != 1 || billing.applied != 1 {
		t.Fatal(e, calls, billing.applied)
	}
}

func TestStudioImageIssueFreezesUnitTotalAndQuantity(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	r.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: studioAccountPrice("0.35")}}
	token, err := r.Issue(context.Background(), q.Owner, key, q.Binding.Offer.OfferID, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: 2}, nil)
	if err != nil {
		t.Fatal(err)
	}
	frozen, err := r.Store.Quote(token, q.Owner, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if frozen.Quantity != 2 || frozen.UnitPrice == nil || frozen.UnitPrice.Amount != "0.80" || frozen.TotalPrice == nil || frozen.TotalPrice.Amount != "1.60" {
		t.Fatalf("quote did not freeze unit × quantity: %+v", frozen)
	}
}

func TestStudioImageAccountingAdmissionBeforeNetwork(t *testing.T) {
	for _, quota := range []bool{true, false} {
		t.Run(fmt.Sprintf("quota_%t", quota), func(t *testing.T) {
			r, q, key, account, billing := studioContractFixture(t)
			calls := 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				calls++
				return studioResult(t, "png"), "id", nil
			}
			if !quota {
				account.a.Extra = map[string]any{}
			}
			token, e := r.Issue(context.Background(), q.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, nil)
			if quota {
				if e == nil || calls != 0 || billing.applied != 0 {
					t.Fatal("missing cost crossed admission", e, calls)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			allowed, e := r.Store.Quote(token, q.Owner, time.Now())
			if e != nil {
				t.Fatal(e)
			}
			if allowed.Accounting.SourceState != "not_required" || allowed.Accounting.BaseAmount != "0" {
				t.Fatal(allowed.Accounting)
			}
			_, e = r.Dispatch(context.Background(), nil, allowed, "no-quota", "prompt", nil, key)
			if e != nil || calls != 1 || billing.cmd.ExactAmounts.Balance != "0.80" || billing.cmd.ExactAmounts.AccountQuota != "0" {
				t.Fatal(e, billing.cmd)
			}
		})
	}
}

func (s *studioSchedulerTrap) Select(context.Context, OpenAIAccountScheduleRequest) (*AccountSelectionResult, OpenAIAccountScheduleDecision, error) {
	s.selects++
	panic("bound path selected scheduler")
}
func (s *studioSchedulerTrap) ReportSwitch() { s.switches++; panic("bound path switched supplier") }

type studioBillingFixture struct {
	UsageBillingRepository
	events         map[string]string
	cmd            *UsageBillingCommand
	calls, applied int
	before         func()
}

func (r *studioBillingFixture) Apply(_ context.Context, cmd *UsageBillingCommand) (*UsageBillingApplyResult, error) {
	if r.before != nil {
		r.before()
	}
	r.calls++
	r.cmd = cmd
	if old, ok := r.events[cmd.RequestID]; ok {
		if old != cmd.RequestFingerprint {
			return nil, ErrUsageBillingRequestConflict
		}
		return &UsageBillingApplyResult{}, nil
	}
	r.events[cmd.RequestID] = cmd.RequestFingerprint
	r.applied++
	return &UsageBillingApplyResult{Applied: true}, nil
}

func studioContractFixture(t *testing.T, origins ...string) (*StudioImageRuntime, StudioImageQuote, *APIKey, *studioAccountFixture, *studioBillingFixture) {
	t.Helper()
	ctx := context.Background()
	a := &Account{ID: 7, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Status: StatusActive, Schedulable: true, Concurrency: 1, GroupIDs: []int64{3}, Credentials: map[string]any{"api_key": "synthetic-only", "base_url": "https://supplier.example/v1"}, Extra: map[string]any{"quota_limit": 100.0}}
	if len(origins) != 0 {
		a.Credentials["base_url"] = origins[0]
	}
	ma := &studioMediaFixture{a: mediaworkbench.Account{ID: 7, Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true, BaseURL: a.GetOpenAIBaseURL(), Catalog: &mediaworkbench.Catalog{Models: []string{"gpt-image-2"}, SyncedAt: "2026-10-05T00:00:00Z"}}}
	service := mediaworkbench.NewService(ma)
	_, err := service.Initialize(ctx, 7, []string{"image"})
	if err != nil {
		t.Fatal(err)
	}
	match := mediaworkbench.Match{Count: &mediaworkbench.Range{Min: 1, Max: 2}, References: &mediaworkbench.References{TotalMax: 0}}
	p := mediaworkbench.Product{ProductID: "p", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"1K"}, AspectRatios: []string{"1:1"}, Count: mediaworkbench.Range{Min: 1, Max: 2}}, AdapterConfig: mediaworkbench.ImageConfig{SizeMappings: []mediaworkbench.SizeMapping{{Resolution: "1K", AspectRatio: "1:1", WireSize: "1024x1024"}}}, PricingRules: []mediaworkbench.PricingRule{{Match: match, SalePrice: &mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}}
	d, err := service.SaveDraft(ctx, 7, 1, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Config.Validation.PublishReady {
		t.Fatalf("fixture validation: %+v", d.Config.Validation)
	}
	d, err = service.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.SetSales(ctx, 7, d.Config.RecordVersion, true)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := mediaworkbench.ResolvePublishedImageOffer(&ma.a, ma.a.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	accountRepo := &studioAccountFixture{a: a}
	billing := &studioBillingFixture{events: map[string]string{}}
	core := &OpenAIGatewayService{accountRepo: accountRepo, usageBillingRepo: billing, concurrencyService: NewConcurrencyService(studioSlotFixture{allowed: true}), openaiScheduler: &studioSchedulerTrap{}}
	runtime := NewStudioImageRuntime(core, ma)
	runtime.Store = NewStudioImageStore(t.TempDir())
	runtime.enabled = true
	q := StudioImageQuote{Owner: StudioImageOwner{1, 2, 3}, Binding: binding, BaseURL: a.GetOpenAIBaseURL(), CredentialFingerprint: studioCredentialFingerprint(a), CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Minute), KeyQuotaEnabled: true, KeyRateEnabled: true, AccountQuotaEnabled: a.HasAnyQuotaLimit()}
	q.Accounting, err = ResolveStudioImageAccountCost(a, binding, studioAccountPrice("0.35"), q.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	token, err := runtime.Store.Issue(q)
	if err != nil {
		t.Fatal(err)
	}
	q, err = runtime.Store.Quote(token, q.Owner, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	runtime.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		return studioResult(t, "png"), "known-sync-receipt", nil
	}
	return runtime, q, &APIKey{ID: 2, UserID: 1, Quota: 100, RateLimit5h: 100, GroupID: &q.Owner.GroupID, Group: &Group{ID: 3, AllowImageGeneration: true}}, accountRepo, billing
}
func studioAccountPrice(amount string) *Channel {
	price := 0.35
	return &Channel{ID: 9, Status: StatusActive, AccountStatsPricingRules: []AccountStatsPricingRule{{ID: 11, AccountIDs: []int64{7}, Pricing: []ChannelModelPricing{{ID: 12, Platform: PlatformOpenAI, Models: []string{"gpt-image-2"}, BillingMode: BillingModeImage, PerRequestPrice: &price, AccountStatsPerRequestExact: &amount}}}}}
}
func studioResult(t *testing.T, format string) []byte {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, 1024, 1024))
	im.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var b bytes.Buffer
	var err error
	switch format {
	case "webp":
		// A synthetic 1x1 PNG encoded locally with FFmpeg libwebp; no supplier I/O.
		var encoded []byte
		encoded, err = base64.StdEncoding.DecodeString("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=")
		if err == nil {
			_, err = b.Write(encoded)
		}
	case "jpeg":
		err = jpeg.Encode(&b, im, nil)
	default:
		err = png.Encode(&b, im)
	}
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(b.Bytes())}}})
	return out
}

func TestStudioImageQuoteOwnership(t *testing.T) {
	r, q, _, _, _ := studioContractFixture(t)
	token, err := r.Store.Issue(q)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, token string
		owner       StudioImageOwner
		now         time.Time
	}{
		{"tamper", strings.Repeat("a", 64), q.Owner, time.Now()}, {"short", "x", q.Owner, time.Now()}, {"expired", token, q.Owner, q.ExpiresAt},
		{"future", token, q.Owner, q.CreatedAt.Add(-time.Second)}, {"cross_user", token, StudioImageOwner{99, 2, 3}, time.Now()}, {"cross_key", token, StudioImageOwner{1, 99, 3}, time.Now()}, {"cross_group", token, StudioImageOwner{1, 2, 99}, time.Now()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, e := r.Store.Quote(tc.token, tc.owner, tc.now); e == nil {
				t.Fatal("invalid quote accepted")
			}
		})
	}
	if q.Binding.PublishedRevision == "" || q.Binding.Offer.OfferID == "" || q.Binding.SpecHash == "" || q.Accounting.SourceHash == "" {
		t.Fatal("incomplete quote binding")
	}
}

func TestStudioImageUnrecoverableTaskIDsRejected(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t)
	calls := 0
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		calls++
		return nil, "", nil
	}
	for _, id := range []string{"", "a/b", "..", "white space", "中文", strings.Repeat("a", 129)} {
		if _, e := r.Dispatch(context.Background(), nil, q, id, "prompt", nil, key); e == nil {
			t.Fatal("unrecoverable task ID accepted", id)
		}
	}
	if calls != 0 || billing.applied != 0 {
		t.Fatal("bad task crossed network/billing")
	}
}

func TestStudioImageNativeKeyPolicyDrift(t *testing.T) {
	for _, name := range []string{"quota_disabled", "rate_disabled", "subscription_changed"} {
		t.Run(name, func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			calls := 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				calls++
				return studioResult(t, "png"), "id", nil
			}
			switch name {
			case "quota_disabled":
				key.Quota = 0
			case "rate_disabled":
				key.RateLimit5h = 0
			case "subscription_changed":
				key.Group.SubscriptionType = SubscriptionTypeSubscription
			}
			if _, e := r.Dispatch(context.Background(), nil, q, "policy", "prompt", nil, key); e == nil || calls != 0 || billing.applied != 0 {
				t.Fatal("native key policy bypass", e, calls)
			}
		})
	}
}

func TestStudioImageExactAccountDrift(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*StudioImageRuntime, *StudioImageQuote, *studioAccountFixture)
	}{
		{"deleted", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) { a.deleted = true }},
		{"inactive", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) { a.a.Status = "inactive" }},
		{"unschedulable", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) { a.a.Schedulable = false }},
		{"oauth", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) { a.a.Type = AccountTypeOAuth }},
		{"group_removed", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) { a.a.GroupIDs = nil }},
		{"mapping", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			a.a.Credentials["model_mapping"] = map[string]any{"gpt-image-2": "other"}
		}},
		{"credential_missing", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			delete(a.a.Credentials, "api_key")
		}},
		{"credential_changed", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			a.a.Credentials["api_key"] = "different-synthetic"
		}},
		{"base_changed", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			a.a.Credentials["base_url"] = "https://changed.example/v1"
		}},
		{"proxy_missing", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			id := int64(20)
			a.a.ProxyID = &id
		}},
		{"parent", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			id := int64(20)
			a.a.ParentAccountID = &id
		}},
		{"concurrency_full", func(r *StudioImageRuntime, _ *StudioImageQuote, _ *studioAccountFixture) {
			r.Core.concurrencyService = NewConcurrencyService(studioSlotFixture{})
		}},
		{"runtime_block", func(r *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			until := time.Now().Add(time.Hour)
			a.a.TempUnschedulableUntil = &until
			r.Core.openaiAccountRuntimeBlockUntil.Store(a.a.ID, until)
		}},
		{"quota_exhausted", func(_ *StudioImageRuntime, _ *StudioImageQuote, a *studioAccountFixture) {
			a.a.Extra["quota_used"] = 100.0
		}},
		{"published_changed", func(r *StudioImageRuntime, _ *StudioImageQuote, _ *studioAccountFixture) {
			ma, ok := r.Media.(*studioMediaFixture)
			if !ok {
				t.Fatal("wrong fixture")
			}
			ma.a.Config.Published.Revision = "changed"
		}},
		{"adapter_changed", func(r *StudioImageRuntime, _ *StudioImageQuote, _ *studioAccountFixture) {
			ma, ok := r.Media.(*studioMediaFixture)
			if !ok {
				t.Fatal("wrong fixture")
			}
			ma.a.Config.AdapterBindings["image"] = mediaworkbench.AdapterBinding{Kind: "image2pro"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, q, key, a, billing := studioContractFixture(t)
			calls := 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				calls++
				return nil, "", nil
			}
			tc.mutate(r, &q, a)
			if _, e := r.Dispatch(context.Background(), nil, q, "test-task", "prompt", nil, key); e == nil {
				t.Fatal("drift admitted")
			}
			trap, ok := r.Core.openaiScheduler.(*studioSchedulerTrap)
			if !ok {
				t.Fatal("wrong scheduler fixture")
			}
			if calls != 0 || trap.selects != 0 || trap.switches != 0 || billing.calls != 0 {
				t.Fatal("drift invoked paid/fallback operation")
			}
		})
	}
}

func TestStudioImageIndependentAccounting(t *testing.T) {
	r, q, _, a, _ := studioContractFixture(t)
	for _, sale := range []string{"0.80", "1.20"} {
		t.Run("sale_"+sale, func(t *testing.T) {
			binding := q.Binding
			binding.Offer.SalePrice.Amount = sale
			ch := studioAccountPrice("0.35")
			ch.ApplyPricingToAccountStats = true
			bad := 9.0
			ch.ModelPricing = []ChannelModelPricing{{PerRequestPrice: &bad}}
			snap, e := ResolveStudioImageAccountCost(a.a, binding, ch, time.Now())
			if e != nil || snap.BaseAmount != "0.35" || snap.EffectiveAccountQuotaCost != "0.35" {
				t.Fatal(snap, e)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		mutate func(*Account, *Channel)
	}{
		{"other_account", func(_ *Account, c *Channel) { c.AccountStatsPricingRules[0].AccountIDs = []int64{99} }},
		{"group_only", func(_ *Account, c *Channel) {
			c.AccountStatsPricingRules[0].AccountIDs = nil
			c.AccountStatsPricingRules[0].GroupIDs = []int64{3}
		}},
		{"wrong_model", func(_ *Account, c *Channel) { c.AccountStatsPricingRules[0].Pricing[0].Models = []string{"other"} }},
		{"wrong_platform", func(_ *Account, c *Channel) { c.AccountStatsPricingRules[0].Pricing[0].Platform = PlatformAnthropic }},
		{"missing_price", func(_ *Account, c *Channel) {
			p := &c.AccountStatsPricingRules[0].Pricing[0]
			p.PerRequestPrice = nil
			p.AccountStatsPerRequestExact = nil
		}},
		{"token_price", func(_ *Account, c *Channel) { c.AccountStatsPricingRules[0].Pricing[0].BillingMode = BillingModeToken }},
		{"ninth_decimal", func(_ *Account, c *Channel) {
			v := "0.350000001"
			c.AccountStatsPricingRules[0].Pricing[0].AccountStatsPerRequestExact = &v
		}},
		{"negative_rate", func(a *Account, _ *Channel) { v := -1.0; a.RateMultiplier = &v }},
		{"unrepresentable_rate", func(a *Account, _ *Channel) { v := 1.00001; a.RateMultiplier = &v }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, q, _, a, _ := studioContractFixture(t)
			ch := studioAccountPrice("0.35")
			tc.mutate(a.a, ch)
			if _, e := ResolveStudioImageAccountCost(a.a, q.Binding, ch, time.Now()); e == nil {
				t.Fatal("non-independent accounting accepted")
			}
		})
	}
	t.Run("quota_missing_customer_not_fallback", func(t *testing.T) {
		if _, e := ResolveStudioImageAccountCost(a.a, q.Binding, nil, time.Now()); e == nil {
			t.Fatal("quota admitted without strict cost")
		}
	})
	t.Run("no_quota_not_required", func(t *testing.T) {
		a.a.Extra = map[string]any{}
		snap, e := ResolveStudioImageAccountCost(a.a, q.Binding, nil, time.Now())
		if e != nil || snap.SourceState != "not_required" || snap.BaseAmount != "0" {
			t.Fatal(snap, e)
		}
	})
	t.Run("rate_frozen", func(t *testing.T) {
		v := 2.0
		a.a.RateMultiplier = &v
		snap, e := ResolveStudioImageAccountCost(a.a, q.Binding, studioAccountPrice("0.35"), time.Now())
		if e != nil || snap.EffectiveAccountQuotaCost != "0.7" {
			t.Fatal(snap, e)
		}
		v = 3
		if snap.AccountRateMultiplier != "2" || snap.EffectiveAccountQuotaCost != "0.7" {
			t.Fatal("rate recomputed")
		}
	})
	t.Run("new_rule_new_snapshot", func(t *testing.T) {
		a.a.RateMultiplier = nil
		snap, e := ResolveStudioImageAccountCost(a.a, q.Binding, studioAccountPrice("0.40"), time.Now())
		if e != nil || snap.BaseAmount != "0.4" || q.Accounting.BaseAmount != "0.35" {
			t.Fatal(snap, e)
		}
	})
	_ = r
}

func TestStudioImageDispatchAndRecovery(t *testing.T) {
	r, q, key, a, billing := studioContractFixture(t)
	calls := 0
	r.network = func(_ context.Context, _ *gin.Context, account *Account, body []byte, endpoint string) ([]byte, string, error) {
		calls++
		stored, e := r.Store.Receipt("original", q.Owner)
		if e != nil || account.ID != q.Binding.Offer.AccountID || !bytes.Equal(body, stored.Request) || endpoint != stored.Endpoint {
			t.Fatal("non-durable binding")
		}
		if _, e = os.Stat(r.Store.path("task", "original") + ".sync-dispatch"); e != nil {
			t.Fatal("claim not durable")
		}
		return studioResult(t, "png"), "known-id", nil
	}
	billing.before = func() {
		receipt, e := r.Store.Receipt("original", q.Owner)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = r.Store.Result(receipt); e != nil {
			t.Fatal("billed before durable result")
		}
	}
	receipt, e := r.Dispatch(context.Background(), nil, q, "original", "prompt", nil, key)
	if e != nil {
		t.Fatal(e)
	}
	if receipt.BillingState != "billed" || billing.cmd.ExactAmounts.Balance != "0.80" || billing.cmd.ExactAmounts.AccountQuota != "0.35" {
		t.Fatal(receipt, billing.cmd)
	}
	log := QuotedImageUsageLog(receipt)
	if log.ActualCost != 0.8 || *log.AccountStatsCost != 0.35 || *log.AccountRateMultiplier != 1 {
		t.Fatal("customer/account report mixed")
	}
	// Live Published/account/rate drift cannot rewrite an already claimed task.
	a.deleted = true
	v := 99.0
	a.a.RateMultiplier = &v
	ma, ok := r.Media.(*studioMediaFixture)
	if !ok {
		t.Fatal("wrong fixture")
	}
	ma.a.Config.Published.Revision = "changed"
	reads := a.calls
	_, e = r.Recover(context.Background(), "original", q.Owner)
	if e != nil {
		t.Fatal(e)
	}
	_, e = r.Dispatch(context.Background(), nil, q, "original", "prompt", nil, key)
	if e != nil {
		t.Fatal(e)
	}
	if a.calls != reads || calls != 1 || billing.applied != 1 {
		t.Fatal("recovery selected/recomputed/replayed")
	}
	other := q
	other.ID = "different"
	other.BindingHash = studioQuoteHash(other)
	if _, e = r.Dispatch(context.Background(), nil, other, "original", "prompt", nil, key); e == nil {
		t.Fatal("task requoted")
	}
	if _, e = r.Dispatch(context.Background(), nil, q, "original", "changed prompt", nil, key); e == nil {
		t.Fatal("task payload changed")
	}
	if _, e = r.Store.Receipt("original", StudioImageOwner{9, 2, 3}); e == nil {
		t.Fatal("cross-owner receipt")
	}
}

func TestStudioImageCrashAndPersistence(t *testing.T) {
	for _, failure := range []string{"unknown_response", "claim_write", "result_write", "billed_journal", "corrupt_result", "wrong_count", "missing_result"} {
		t.Run(failure, func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			calls := 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				calls++
				if failure == "unknown_response" {
					return nil, "", errors.New("response lost")
				}
				if failure == "corrupt_result" {
					return []byte(`{"data":[{"b64_json":"broken"}]}`), "", nil
				}
				if failure == "wrong_count" {
					return []byte(`{"data":[]}`), "", nil
				}
				return studioResult(t, "png"), "known", nil
			}
			r.Store.writeFile = func(path string, b []byte, exclusive bool) error {
				if failure == "claim_write" && strings.HasSuffix(path, ".sync-dispatch") || failure == "result_write" && strings.Contains(path, "result-") || failure == "billed_journal" && bytes.Contains(b, []byte(`"billing_state":"billed"`)) {
					return errors.New("injected disk failure")
				}
				return studioWrite(path, b, exclusive)
			}
			receipt, e := r.Dispatch(context.Background(), nil, q, "crash", "prompt", nil, key)
			if failure == "missing_result" {
				if e != nil {
					t.Fatal(e)
				}
				if err := os.Remove(r.Store.path("result", "crash")); err != nil {
					t.Fatal(err)
				}
				receipt.BillingState = "pending"
				if err := r.Store.Save(receipt); err != nil {
					t.Fatal(err)
				}
			} else if e == nil {
				t.Fatal("failure unobserved")
			}
			before := billing.applied
			r.Store.writeFile = nil
			_, _ = r.Recover(context.Background(), "crash", q.Owner)
			_, _ = r.Dispatch(context.Background(), nil, q, "crash", "prompt", nil, key)
			if calls > 1 || billing.applied > 1 {
				t.Fatal("duplicate supplier/billing effect")
			}
			if failure == "corrupt_result" || failure == "wrong_count" || failure == "unknown_response" || failure == "claim_write" {
				if billing.applied != 0 {
					t.Fatal("invalid/missing result billed")
				}
			}
			if failure == "missing_result" && billing.applied != before {
				t.Fatal("missing result settled")
			}
			if failure == "billed_journal" && billing.applied != 1 {
				t.Fatal("billing recovery failed")
			}
		})
	}
}

func TestStudioImageContainerIntegrity(t *testing.T) {
	for _, format := range []string{"png", "jpeg", "webp"} {
		t.Run(format, func(t *testing.T) {
			body := studioResult(t, format)
			if _, e := ValidateStudioImageResult(body, 1); e != nil {
				t.Fatal(e)
			}
			if _, e := ValidateStudioImageResult(body, 2); e == nil {
				t.Fatal("wrong count")
			}
			var payload struct {
				Data []map[string]string `json:"data"`
			}
			_ = json.Unmarshal(body, &payload)
			b, _ := base64.StdEncoding.DecodeString(payload.Data[0]["b64_json"])
			decoded, err := ValidateStudioImageResult(body, 1)
			if err != nil || !bytes.Equal(decoded[0], b) {
				t.Fatal("original image bytes changed", err)
			}
			for _, bad := range [][]byte{append(append([]byte{}, b...), 0), b[:len(b)-1], []byte("not-image")} {
				payload.Data[0]["b64_json"] = base64.StdEncoding.EncodeToString(bad)
				corrupt, _ := json.Marshal(payload)
				if _, e := ValidateStudioImageResult(corrupt, 1); e == nil {
					t.Fatal("corrupt bytes admitted")
				}
			}
		})
	}
}

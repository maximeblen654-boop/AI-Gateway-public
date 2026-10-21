package service

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func freezeLegacyImageAccounting(t *testing.T, r *StudioImageRuntime, q StudioImageQuote, version int) StudioImageQuote {
	t.Helper()
	q.Binding.Offer.CostVersion = version
	q.AccountQuotaEnabled = true
	base, effective := "0.35", "0.7"
	if q.Binding.Spec.Count == 5 {
		base, effective = "1.75", "3.5"
	}
	source, kind := "channel:9/rule:1/pricing:1", "explicit_account_stats_rule"
	if version == 1 {
		source, kind = studioPublishedCostSourceID(q.Binding.Offer.AccountID, q.Binding.Offer.ProductID, q.Binding.PublishedRevision), "studio_published_cost"
	}
	// A frozen historical record is constructed explicitly; no live cost resolver
	// can issue a new quote under this contract.
	q.Accounting = AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "resolved", SourceType: kind, SourceID: source, SourceHash: strings.Repeat("a", 64), AccountID: q.Binding.Offer.AccountID, UpstreamModel: q.Binding.Offer.UpstreamModel, SpecHash: q.Binding.SpecHash, RequestCount: q.Binding.Spec.Count, PricingAt: q.CreatedAt, BaseAmount: base, Unit: "CNY", AccountRateMultiplier: "2", EffectiveAccountQuotaCost: effective}
	token, err := r.Store.Issue(q)
	require.NoError(t, err)
	q, err = r.Store.Quote(token, q.Owner, q.CreatedAt.Add(time.Millisecond))
	require.NoError(t, err)
	return q
}

func TestStudioImageLegacyQuoteCannotStartNewSupplierRequest(t *testing.T) {
	for _, version := range []int{0, 1} {
		for _, multi := range []bool{false, true} {
			t.Run(string(rune('0'+version))+map[bool]string{false: "/single", true: "/multi"}[multi], func(t *testing.T) {
				r, q, key, accounts, billing := studioContractFixture(t)
				if multi {
					q = enableStudioNativeMulti(t, r)
				}
				q = freezeLegacyImageAccounting(t, r, q, version)
				reads, posts := accounts.calls, 0
				r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
					posts++
					return studioResult(t, "png"), "forbidden", nil
				}
				_, err := r.Dispatch(t.Context(), nil, q, "old-unsubmitted", "prompt", nil, key)
				require.Equal(t, "account_cost", QuoteFailureStage(err))
				require.Zero(t, posts)
				require.Zero(t, billing.calls)
				require.Equal(t, reads, accounts.calls, "old quote reached account admission")
				_, err = r.Store.Receipt("old-unsubmitted", q.Owner)
				require.True(t, os.IsNotExist(err))
			})
		}
	}
}

func TestStudioImageLegacyReceiptStillRecoversOriginalMoney(t *testing.T) {
	for _, version := range []int{0, 1} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			r, q, key, accounts, billing := studioContractFixture(t)
			q.CreatedAt, q.ExpiresAt = time.Now().Add(-time.Hour), time.Now().Add(-time.Hour+time.Minute)
			q = freezeLegacyImageAccounting(t, r, q, version)
			plan, err := mediaworkbench.CompilePublishedImagePlan(q.Binding, "original prompt", nil)
			require.NoError(t, err)
			body := plan.MaterializeJSON()
			requestHash := studioHash(struct {
				Prompt     string
				References []string
				Spec       mediaworkbench.Spec
			}{"original prompt", nil, q.Binding.Spec})
			receipt, first, err := r.Store.Claim(StudioImageReceipt{Version: StudioImageReceiptVersion, TaskID: "old-delivered", Quote: q, Request: body, PayloadHash: HashUsageRequestPayload(body), RequestHash: requestHash, Endpoint: plan.Path})
			require.NoError(t, err)
			require.True(t, first)
			require.NoError(t, r.Store.PersistResult(receipt, studioResult(t, "png")))
			accounts.deleted = true
			studioCostMediaFixture(t, r.Media).a.Config.Published = nil
			r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				t.Fatal("historical receipt replayed supplier POST")
				return nil, "", nil
			}
			reads := accounts.calls
			for range 2 {
				result, err := r.Dispatch(t.Context(), nil, q, receipt.TaskID, "original prompt", nil, key)
				require.NoError(t, err)
				require.Equal(t, "billed", result.BillingState)
			}
			require.Equal(t, reads, accounts.calls)
			require.Equal(t, 1, billing.applied)
			require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
			require.Equal(t, "0.7", billing.cmd.ExactAmounts.AccountQuota)
			log := QuotedImageUsageLog(receipt)
			require.NotNil(t, log.AccountStatsCost)
			require.Equal(t, .35, *log.AccountStatsCost)
			require.Equal(t, "image", *log.BillingMode)
		})
	}
}

func TestStudioImageOldPublishedMetadataNewQuoteIsUnknownAndImmutable(t *testing.T) {
	r, old, key, _, _ := studioContractFixture(t)
	ma := studioCostMediaFixture(t, r.Media)
	pub := ma.a.Config.Published
	pub.Products[0].CostVersion = 1
	pub.Products[0].CostRules = []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}}}
	pub.Offers[0].CostVersion = 1
	pub.Offers[0].OfferID = ""
	pub.Offers[0].OfferID = "mw_offer_" + studioHash(pub.Offers[0])
	pub.Revision = "mwp_" + studioHash(struct {
		Source              string
		Products            []mediaworkbench.Product
		Offers              []mediaworkbench.Offer
		Dependencies        mediaworkbench.Dependencies
		ProductDependencies map[string]mediaworkbench.Dependencies `json:",omitempty"`
	}{pub.SourceDraftRevision, pub.Products, pub.Offers, pub.Dependencies, pub.ProductDependencies})
	before := studioHash(pub)
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	token, err := r.Issue(t.Context(), old.Owner, key, pub.Offers[0].OfferID, old.Binding.Spec, nil)
	require.NoError(t, err)
	q, err := r.Store.Quote(token, old.Owner, time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, q.Binding.Offer.CostVersion)
	require.Equal(t, StudioImageRetailUsageMode, q.Accounting.SourceType)
	require.Empty(t, q.Accounting.BaseAmount)
	require.Empty(t, q.Accounting.EffectiveAccountQuotaCost)
	require.Equal(t, before, studioHash(pub))
	_, err = r.Dispatch(t.Context(), nil, q, "old-publication-new-sale", "prompt", nil, key)
	require.NoError(t, err, "first dispatch uses new accounting discriminator, not old Offer.CostVersion")
}

func TestStudioVideoLegacyQuoteNeedsExistingDispatchToRecover(t *testing.T) {
	r, _, q, key, _, orders := videoRuntimeFixture(t)
	b := &q.Binding
	b.Version = StudioVideoBindingVersion
	b.Offer.CostVersion = 1
	b.AccountQuotaEnabled = true
	b.Accounting = AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "resolved", SourceType: "studio_published_cost", SourceID: studioPublishedCostSourceID(b.Offer.AccountID, b.Offer.ProductID, b.PublishedRevision), SourceHash: strings.Repeat("a", 64), AccountID: b.Offer.AccountID, UpstreamModel: b.Offer.UpstreamModel, SpecHash: b.SpecHash, RequestCount: 1, PricingAt: b.CreatedAt, BaseAmount: "0.35", Unit: "CNY", AccountRateMultiplier: "2", EffectiveAccountQuotaCost: "0.7"}
	q.BindingHash = b.Hash()
	token, err := r.Store.Issue(q)
	require.NoError(t, err)
	posts, gets := 0, 0
	r.request = func(_ context.Context, _ *Account, method, _ string, _ []byte) ([]byte, string, error) {
		if method == http.MethodPost {
			posts++
		} else {
			gets++
		}
		return []byte(`{"id":"original-legacy","status":"completed"}`), "application/json", nil
	}
	_, err = r.Submit(t.Context(), b.Owner, key, token, "av_old_unsubmitted")
	require.Equal(t, "account_cost", QuoteFailureStage(err))
	require.Zero(t, orders.reserves)
	require.Zero(t, posts)
	// This represents the original pre-upgrade dispatch and hold, not a new POST.
	_, err = r.Store.Claim(StudioVideoTask{ID: "av_old_dispatched", TokenHash: HashUsageRequestPayload([]byte(token)), Quote: q})
	require.NoError(t, err)
	_, err = orders.ReserveStudioVideoOrder(t.Context(), &StudioVideoReserveCommand{ChildID: "av_old_dispatched", UserID: b.Owner.UserID, APIKeyID: b.Owner.APIKeyID, GroupID: b.Owner.GroupID, QuoteID: b.QuoteID, CapabilityVersion: b.CapabilityVersion(), RequestHash: b.RequestHash, HoldAmount: .8, Binding: b})
	require.NoError(t, err)
	_, err = r.Store.DispatchClaim("av_old_dispatched")
	require.NoError(t, err)
	require.NoError(t, r.Store.Accept("av_old_dispatched", "original-legacy"))
	studioCostMediaFixture(t, r.Media).a.Config.Published = nil
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	state, err := r.Submit(t.Context(), b.Owner, key, token, "av_old_dispatched")
	require.NoError(t, err)
	require.Equal(t, "completed", state.Status)
	require.Zero(t, posts)
	require.Equal(t, 1, gets)
	_, err = r.Capture(t.Context(), b.Owner, "av_old_dispatched", strings.Repeat("b", 64), testStudioVideoRetention(q))
	require.NoError(t, err)
	require.Equal(t, 1, orders.captures)
	cmd, err := VideoAccountBillingCommand("av_old_dispatched", b, strings.Repeat("b", 64))
	require.NoError(t, err)
	require.Equal(t, "0.7", cmd.ExactAmounts.AccountQuota)
}

func TestStudioRetailUsageModesAreNotNativePricingOptions(t *testing.T) {
	for _, mode := range []BillingMode{StudioImageRetailUsageMode, StudioVideoRetailUsageMode} {
		require.False(t, mode.IsValid())
		require.True(t, mode.IsValidUsageFilter())
	}
	for _, mode := range []BillingMode{BillingModeImage, BillingModeVideo, BillingModeToken, BillingModePerRequest} {
		require.True(t, mode.IsValid())
	}
}

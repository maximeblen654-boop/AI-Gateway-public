package service

import (
	"context"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/sjson"
	"os"
	"testing"
)

// Published WAN contract; synthetic identities and prices, no supplier network.
func wanQuoteFixture(t *testing.T) (*StudioVideoRuntime, *APIKey, *studioAccountFixture, mediaworkbench.Product) {
	r, _, _, key, accounts, _ := videoRuntimeFixture(t)
	model := "WAN3.0-可参考视频"
	ma := r.Media.(*studioMediaFixture)
	ma.a.Config = nil
	ma.a.ModelMapping = map[string]string{model: model}
	ma.a.Catalog.Models = []string{model}
	accounts.a.Credentials["model_mapping"] = map[string]any{model: model}
	p := mediaworkbench.Product{ProductID: "wan-fixture", MediaType: "video", SiteModel: model, UpstreamModel: model, Enabled: true,
		AdapterConfig: mediaworkbench.ImageConfig{Version: 1, WireProfile: "inline_multimedia"},
		Capabilities:  mediaworkbench.Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"9:16", "16:9", "1:1", "3:4", "4:3", "21:9"}, DurationsSeconds: []int{5, 10, 15}, Count: mediaworkbench.Range{Min: 1, Max: 1}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 10}, Video: mediaworkbench.Range{Max: 5}, Audio: mediaworkbench.Range{Max: 5}, TotalMax: 14}},
		PricingRules:  []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "1.5", Currency: "CNY", BillingMode: "per_request"}}}}
	svc := mediaworkbench.NewService(ma)
	d, e := svc.SaveDraft(context.Background(), 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, e)
	require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
	d, e = svc.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, e)
	_, e = svc.SetSales(context.Background(), 7, d.Config.RecordVersion, true)
	require.NoError(t, e)
	price := studioAccountPrice("0.35")
	price.AccountStatsPricingRules[0].Pricing[0].Models = []string{model}
	price.AccountStatsPricingRules[0].Pricing[0].BillingMode = BillingModePerRequest
	r.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: price}}
	return r, key, accounts, p
}

func TestWANQuoteDiagnosticBranches(t *testing.T) {
	for _, refs := range []int{0, 1} {
		for _, name := range []string{"success", "permission", "identity_fallback", "missing_cost", "wrong_cost_model", "wrong_cost_mode", "group", "mapping", "schedule", "wire_model", "duration", "ratio", "references"} {
			t.Run(name+map[int]string{0: "/text", 1: "/reference"}[refs], func(t *testing.T) {
				r, key, accounts, p := wanQuoteFixture(t)
				m, ok := mediaworkbench.VideoProfileModel(p)
				require.True(t, ok)
				plan, e := videoplan.PreviewWithModel(m, p.UpstreamModel, "720p", "16:9", 5, refs, 0, 0)
				require.NoError(t, e)
				spec := mediaworkbench.Spec{Count: 1, Resolution: "720p", AspectRatio: "16:9", DurationSeconds: 5, Images: refs}
				offer := r.Media.(*studioMediaFixture).a.Config.Published.Offers[0].OfferID
				want := ""
				switch name {
				case "permission":
					key.Group.ModelAllowlist = GroupModelAllowlist{Enabled: true, Models: []string{"other-model"}}
					want = "model_permission"
				case "identity_fallback":
					accounts.a.Credentials["model_mapping"] = map[string]any{"unrelated": "unrelated"}
				case "missing_cost":
					r.Core.channelService = nil
					want = "account_cost"
				case "wrong_cost_model":
					r.Core.channelService.repo.(*studioChannelFixture).channel.AccountStatsPricingRules[0].Pricing[0].Models = []string{"different-upstream"}
					want = "account_cost"
				case "wrong_cost_mode":
					r.Core.channelService.repo.(*studioChannelFixture).channel.AccountStatsPricingRules[0].Pricing[0].BillingMode = BillingModeImage
					want = "account_cost"
				case "group":
					accounts.a.GroupIDs = []int64{99}
					want = "published_offer"
				case "mapping":
					accounts.a.Credentials["model_mapping"] = map[string]any{p.SiteModel: "different-upstream"}
					want = "account_admission"
				case "schedule":
					accounts.a.Schedulable = false
					want = "account_admission"
				case "wire_model":
					plan.Body, e = sjson.SetBytes(plan.Body, "model", "different-upstream")
					require.NoError(t, e)
					want = "execution"
				case "duration":
					spec.DurationSeconds = 99
					want = "published_offer"
				case "ratio":
					spec.AspectRatio = "99:1"
					want = "published_offer"
				case "references":
					spec.Images = 11
					want = "published_offer"
				}
				before, e := os.ReadDir(r.Store.Root)
				require.NoError(t, e)
				e = r.quotePreflight(context.Background(), StudioImageOwner{1, 2, 3}, key, offer, spec, plan.Body)
				if want == "" {
					require.NoError(t, e)
				} else {
					require.Error(t, e)
					require.Equal(t, want, QuoteFailureStage(e))
				}
				after, e := os.ReadDir(r.Store.Root)
				require.NoError(t, e)
				require.Equal(t, len(before), len(after), "preflight must not persist a quote or order")
			})
		}
	}
}

func TestQuoteDiagnosticAllowlist(t *testing.T) {
	secret := errors.New("postgres://secret@private.invalid?token=hidden")
	require.Equal(t, "unknown", QuoteFailureStage(secret))
	require.Equal(t, "unknown", QuoteFailureStage(QuoteFailure(secret.Error(), secret)))
	require.NotContains(t, QuoteFailure(secret.Error(), secret).Error(), "secret")
	for _, stage := range []string{"request", "model_permission", "reference_preparation", "execution", "published_offer", "account", "account_admission", "account_cost", "quote_store", "billing_eligibility", "price"} {
		e := QuoteFailure(stage, secret)
		require.Equal(t, stage, QuoteFailureStage(e))
		require.ErrorIs(t, e, secret)
		require.NotContains(t, e.Error(), "secret")
	}
	require.Nil(t, QuoteFailure("account_cost", nil))
}

func TestWANQuoteMissingCostReproduction(t *testing.T) {
	for _, refs := range []int{0, 1} {
		t.Run(map[int]string{0: "without_reference", 1: "with_reference"}[refs], func(t *testing.T) {
			r, key, _, p := wanQuoteFixture(t)
			m, ok := mediaworkbench.VideoProfileModel(p)
			require.True(t, ok)
			plan, e := videoplan.PreviewWithModel(m, p.UpstreamModel, "720p", "16:9", 5, refs, 0, 0)
			require.NoError(t, e)
			spec := mediaworkbench.Spec{Count: 1, Resolution: "720p", AspectRatio: "16:9", DurationSeconds: 5, Images: refs}
			offer := r.Media.(*studioMediaFixture).a.Config.Published.Offers[0].OfferID
			r.Core.channelService = nil
			e = r.quotePreflight(context.Background(), StudioImageOwner{1, 2, 3}, key, offer, spec, plan.Body)
			require.ErrorIs(t, e, ErrStudioImageAccounting)
			require.Equal(t, "account_cost", QuoteFailureStage(e))
		})
	}
}

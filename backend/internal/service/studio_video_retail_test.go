package service

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
)

func TestVideoRetailRejectsAllMonetaryAccountLimits(t *testing.T) {
	for _, field := range []string{"quota_limit", "quota_daily_limit", "quota_weekly_limit"} {
		t.Run(field, func(t *testing.T) {
			r, token, q, key, accounts, orders := videoRuntimeFixture(t)
			accounts.a.Extra[field] = 100.0
			_, _, err := r.Issue(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, q.Plan.Body)
			require.Equal(t, "account_quota_requires_cost", QuoteFailureStage(err))
			// A limit enabled after quote issuance still blocks before dispatch/hold.
			_, err = r.Submit(t.Context(), q.Binding.Owner, key, token, "av_limit")
			require.Equal(t, "account_quota_requires_cost", QuoteFailureStage(err))
			require.Zero(t, orders.reserves)
			input := []byte("synthetic-reference")
			spec := q.Binding.Spec
			spec.Images = 1
			asset := StudioVideoReferenceAsset{AssetRef: "quota-ref", Kind: "image", MimeType: "image/png", Size: len(input), SHA256: HashUsageRequestPayload(input), BytesBase64: base64.StdEncoding.EncodeToString(input)}
			uploader := &localReferenceUploader{}
			r.SetReferenceUploader(uploader)
			_, err = r.PrepareReferenceAssets(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, []StudioVideoReferenceAsset{asset})
			require.Equal(t, "account_quota_requires_cost", QuoteFailureStage(err))
			require.Zero(t, uploader.calls)
		})
	}
}

func TestVideoRetailExistingPublicationQuotesWithoutCost(t *testing.T) {
	r, _, q, key, _, _ := videoRuntimeFixture(t)
	ma := studioCostMediaFixture(t, r.Media)
	pub := ma.a.Config.Published
	pub.Products[0].CostVersion = 1
	pub.Products[0].CostRules = nil
	pub.Offers[0].CostVersion = 1
	pub.Offers[0].OfferID = ""
	pub.Offers[0].OfferID = "mw_offer_" + studioHash(pub.Offers[0])
	oldOfferID := pub.Offers[0].OfferID
	// Reconstruct a valid persisted v1 publication identity without changing its
	// customer price or OfferID. Old products need no administrator republication.
	pub.Revision = "mwp_" + studioHash(struct {
		Source              string
		Products            []mediaworkbench.Product
		Offers              []mediaworkbench.Offer
		Dependencies        mediaworkbench.Dependencies
		ProductDependencies map[string]mediaworkbench.Dependencies `json:",omitempty"`
	}{pub.SourceDraftRevision, pub.Products, pub.Offers, pub.Dependencies, pub.ProductDependencies})
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	_, current, err := r.Issue(t.Context(), q.Binding.Owner, key, pub.Offers[0].OfferID, q.Binding.Spec, q.Plan.Body)
	require.NoError(t, err)
	require.Equal(t, oldOfferID, current.Binding.Offer.OfferID)
	require.Equal(t, q.Binding.Offer.SalePrice, current.Binding.Offer.SalePrice)
	require.Equal(t, StudioVideoRetailBindingVersion, current.Binding.Version)
	require.Equal(t, "unknown", current.Binding.Accounting.SourceState)
	require.Empty(t, current.Binding.Accounting.BaseAmount)
	require.NoError(t, current.Binding.Validate())
}

func TestVideoRetailFourMeansFourAndReplayDoesNotChargeAgain(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "capture", true: "release"}[failed], func(t *testing.T) {
			r, _, q, key, _, orders := videoRuntimeFixture(t)
			ma := studioCostMediaFixture(t, r.Media)
			product := studioCopyCostProduct(ma.a.Config.Draft.Products[0])
			product.PricingRules[0].SalePrice.Amount = "4"
			admin := mediaworkbench.NewService(ma)
			d, err := admin.SaveDraft(t.Context(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
			require.NoError(t, err)
			d, err = admin.PublishSelected(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{product.ProductID})
			require.NoError(t, err)
			token, q, err := r.Issue(t.Context(), q.Binding.Owner, key, d.Config.Published.Offers[0].OfferID, q.Binding.Spec, q.Plan.Body)
			require.NoError(t, err)
			posts := 0
			r.request = func(_ context.Context, _ *Account, method, _ string, _ []byte) ([]byte, string, error) {
				if method == http.MethodPost {
					posts++
					return []byte(`{"id":"retail-original"}`), "application/json", nil
				}
				status := "completed"
				if failed {
					status = "failed"
				}
				// Supplier points are not a customer amount or a procurement cost contract.
				return []byte(`{"id":"retail-original","status":"` + status + `","usage":{"points":9500}}`), "application/json", nil
			}
			for range 2 {
				_, err = r.Submit(t.Context(), q.Binding.Owner, key, token, "av_four")
				require.NoError(t, err)
			}
			require.Equal(t, []float64{4}, orders.holds)
			if failed {
				for range 2 {
					_, err = r.Release(t.Context(), q.Binding.Owner, "av_four")
					require.NoError(t, err)
				}
				require.Empty(t, orders.captureAmounts)
				require.Equal(t, StudioVideoReleased, orders.orders["av_four"].State)
			} else {
				for range 2 {
					_, err = r.Capture(t.Context(), q.Binding.Owner, "av_four", strings.Repeat("a", 64), testStudioVideoRetention(q))
					require.NoError(t, err)
				}
				require.Equal(t, []float64{4}, orders.captureAmounts)
				cmd, e := VideoAccountBillingCommand("av_four", &q.Binding, strings.Repeat("a", 64))
				require.NoError(t, e)
				require.Equal(t, "4", cmd.ExactAmounts.APIKeyQuota)
				require.Equal(t, "0", cmd.ExactAmounts.Balance)
				log := VideoAccountUsage("av_four", "retail-original", &q.Binding)
				require.Equal(t, float64(4), log.ActualCost)
				require.Equal(t, float64(4), log.TotalCost)
				require.Nil(t, log.AccountStatsCost)
				require.Equal(t, StudioVideoRetailUsageMode, *log.BillingMode)
			}
			require.Equal(t, 1, posts)
		})
	}
}

func TestVideoLegacyFrozenAccountingStillRecovers(t *testing.T) {
	_, _, q, _, _, _ := videoRuntimeFixture(t)
	b := q.Binding
	b.Version = StudioVideoBindingVersion
	b.Offer.CostVersion = 1
	b.AccountQuotaEnabled = true
	b.Accounting = AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "resolved", SourceType: "studio_published_cost", SourceID: studioPublishedCostSourceID(b.Offer.AccountID, b.Offer.ProductID, b.PublishedRevision), SourceHash: strings.Repeat("a", 64), AccountID: b.Offer.AccountID, UpstreamModel: b.Offer.UpstreamModel, SpecHash: b.SpecHash, RequestCount: 1, Unit: "CNY", PricingAt: time.Now(), BaseAmount: "0.35", AccountRateMultiplier: "2", EffectiveAccountQuotaCost: "0.7"}
	require.NoError(t, b.Validate())
	cmd, err := VideoAccountBillingCommand("av_legacy", &b, strings.Repeat("b", 64))
	require.NoError(t, err)
	require.Equal(t, "0.7", cmd.ExactAmounts.AccountQuota)
	log := VideoAccountUsage("av_legacy", "old", &b)
	require.NotNil(t, log.AccountStatsCost)
	require.Equal(t, .35, *log.AccountStatsCost)
	require.Equal(t, "per_request", *log.BillingMode)
}

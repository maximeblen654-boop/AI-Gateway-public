package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type studioNoChannel struct{ ChannelRepository }

func (studioNoChannel) GetChannelIDByGroupID(context.Context, int64) (int64, error) {
	panic("v1 Studio read API Channel")
}
func (studioNoChannel) GetByID(context.Context, int64) (*Channel, error) {
	panic("v1 Studio read API Channel")
}
func (studioNoChannel) ListAll(context.Context) ([]Channel, error) {
	panic("v1 Studio read API Channel")
}

func TestStudioPublishedCostFrozenExecutionIgnoresAPIMapping(t *testing.T) {
	r, q, key, accounts, billing := studioContractFixture(t)
	ma := r.Media.(*studioMediaFixture)
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	accounts.a.Credentials["model_mapping"] = map[string]any{"gpt-image-2": "api-only-model", "*": "api-fallback"}
	ma.a.ModelMapping = map[string]string{"gpt-image-2": "api-only-model"}
	// An API-only model cooldown must not block the explicitly selected model.
	for range 5 {
		r.Core.recordOpenAIAccountModelTransientFailure(accounts.a, "api-only-model", time.Now())
	}
	before, _ := json.Marshal(accounts.a.Credentials)
	calls := 0
	r.network = func(_ context.Context, _ *gin.Context, a *Account, body []byte, _ string) ([]byte, string, error) {
		calls++
		require.Equal(t, accounts.a.ID, a.ID)
		require.Equal(t, accounts.a.Concurrency, a.Concurrency)
		require.Equal(t, accounts.a.GroupIDs, a.GroupIDs)
		require.Equal(t, accounts.a.Extra, a.Extra)
		require.NotContains(t, a.Credentials, "model_mapping")
		var fields map[string]any
		require.NoError(t, json.Unmarshal(body, &fields))
		require.Equal(t, q.Binding.Offer.UpstreamModel, fields["model"])
		return studioResult(t, "png"), "original-cost", nil
	}
	_, err := r.Dispatch(context.Background(), nil, q, "cost-frozen", "prompt", nil, key)
	require.NoError(t, err)
	after, _ := json.Marshal(accounts.a.Credentials)
	require.Equal(t, before, after, "request-local execution view mutated shared Account")
	require.Equal(t, "api-only-model", accounts.a.GetMappedModel("gpt-image-2"), "ordinary API mapping changed")
	require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
	require.Equal(t, "0.35", billing.cmd.ExactAmounts.AccountQuota)
	require.Equal(t, "studio_published_cost", q.Accounting.SourceType)
	_, err = r.Recover(context.Background(), "cost-frozen", q.Owner)
	require.NoError(t, err)
	require.Equal(t, 1, calls)
	require.Equal(t, 1, billing.applied)
}

func TestStudioPublishedCostZeroIsExplicitAndRequired(t *testing.T) {
	r, original, key, _, _ := studioContractFixture(t)
	ma := r.Media.(*studioMediaFixture)
	p := studioCopyCostProduct(ma.a.Config.Draft.Products[0])
	p.CostRules[0].Cost.Amount = "0"
	admin := mediaworkbench.NewService(ma)
	d, err := admin.SaveDraft(context.Background(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, err)
	d, err = admin.PublishSelected(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID})
	require.NoError(t, err)
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	token, err := r.Issue(context.Background(), original.Owner, key, d.Config.Published.Offers[0].OfferID, original.Binding.Spec, nil)
	require.NoError(t, err)
	q, err := r.Store.Quote(token, original.Owner, time.Now())
	require.NoError(t, err)
	require.Equal(t, "resolved", q.Accounting.SourceState)
	require.Equal(t, "studio_published_cost", q.Accounting.SourceType)
	require.Equal(t, "0", q.Accounting.BaseAmount)
	require.NoError(t, q.Accounting.Validate(q))
	q.Accounting.SourceID = "wrong-published-revision"
	require.Error(t, q.Accounting.Validate(q))
	p.CostRules = nil
	d, err = admin.SaveDraft(context.Background(), 7, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, err)
	_, err = admin.PublishSelected(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID})
	require.ErrorIs(t, err, mediaworkbench.ErrValidation)
}

func TestStudioVideoPublishedCostNoChannelFrozenBilling(t *testing.T) {
	r, token, q, key, accounts, orders := videoRuntimeFixture(t)
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	accounts.a.Credentials["model_mapping"] = map[string]any{q.Binding.Offer.SiteModel: "api-only-model", q.Binding.Offer.UpstreamModel: "api-twice"}
	r.Media.(*studioMediaFixture).a.ModelMapping = map[string]string{q.Binding.Offer.SiteModel: "api-only-model"}
	before, _ := json.Marshal(accounts.a.Credentials)
	posts, gets := 0, 0
	r.request = func(_ context.Context, a *Account, method, _ string, body []byte) ([]byte, string, error) {
		if method == http.MethodPost {
			posts++
			require.NotContains(t, a.Credentials, "model_mapping")
			require.Equal(t, []byte(q.Plan.Body), body)
			return []byte(`{"id":"cost-original"}`), "application/json", nil
		}
		gets++
		return []byte(`{"id":"cost-original","status":"completed"}`), "application/json", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_cost")
	require.NoError(t, err)
	after, _ := json.Marshal(accounts.a.Credentials)
	require.Equal(t, before, after)
	_, err = r.Recover(context.Background(), q.Binding.Owner, "av_cost")
	require.NoError(t, err)
	for range 2 {
		_, err = r.Capture(context.Background(), q.Binding.Owner, "av_cost", strings.Repeat("a", 64))
		require.NoError(t, err)
	}
	require.Equal(t, 1, posts)
	require.Equal(t, 1, gets)
	require.Equal(t, 1, orders.captures)
	cmd, err := VideoAccountBillingCommand("av_cost", &q.Binding, strings.Repeat("b", 64))
	require.NoError(t, err)
	require.Equal(t, "0.80", cmd.ExactAmounts.APIKeyQuota)
	require.Equal(t, "0.35", cmd.ExactAmounts.AccountQuota)
	require.Equal(t, "0", cmd.ExactAmounts.Balance)
}

func TestStudioCostExactGrantRetainsSecurityBoundaries(t *testing.T) {
	r, q, _, accounts, _ := studioContractFixture(t)
	a := accounts.a
	req := q.Binding.Offer.UpstreamModel
	ctx := withPublishedMediaModel(context.Background(), a, req, req, true)
	require.True(t, hasPublishedMediaModel(ctx, a, req))
	require.False(t, hasPublishedMediaModel(context.Background(), a, req))
	require.False(t, hasPublishedMediaModel(ctx, a, "different-model"))
	other := *a
	other.ID++
	require.False(t, hasPublishedMediaModel(ctx, &other, req))
	a.Credentials["api_key"] = "rotated-synthetic"
	require.False(t, hasPublishedMediaModel(ctx, a, req))
	_, _, err := r.Core.SelectQuotedImageAccount(context.Background(), q, r.Media, false)
	require.Error(t, err)
}

func studioCopyCostProduct(p mediaworkbench.Product) mediaworkbench.Product {
	raw, _ := json.Marshal(p)
	var out mediaworkbench.Product
	_ = json.Unmarshal(raw, &out)
	return out
}

func TestStudioVideoReferencePreparationBindsCostRevision(t *testing.T) {
	r, _, q, key, _, _ := videoRuntimeFixture(t)
	r.Core.channelService = &ChannelService{repo: studioNoChannel{}}
	ma := r.Media.(*studioMediaFixture)
	spec := q.Binding.Spec
	spec.Images = 1
	input := []byte("synthetic-reference")
	asset := StudioVideoReferenceAsset{AssetRef: "cost-reference", Kind: "image", MimeType: "image/png", Size: len(input), SHA256: HashUsageRequestPayload(input), BytesBase64: base64.StdEncoding.EncodeToString(input)}
	uploader := &localReferenceUploader{}
	r.SetReferenceUploader(uploader)
	prepare := func() StudioVideoReferencePreparationResult {
		p, err := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, []StudioVideoReferenceAsset{asset})
		require.NoError(t, err)
		return p
	}
	old := prepare()
	require.Equal(t, old.PreparationID, prepare().PreparationID)
	require.Equal(t, 1, uploader.calls)
	product := studioCopyCostProduct(ma.a.Config.Draft.Products[0])
	product.CostRules[0].Cost.Amount = "0.49"
	admin := mediaworkbench.NewService(ma)
	d, err := admin.SaveDraft(context.Background(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
	require.NoError(t, err)
	d, err = admin.PublishSelected(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{product.ProductID})
	require.NoError(t, err)
	require.Equal(t, q.Binding.Offer.OfferID, d.Config.Published.Offers[0].OfferID)
	current := prepare()
	require.NotEqual(t, old.PreparationID, current.PreparationID)
	require.Equal(t, current.PreparationID, prepare().PreparationID)
	require.Equal(t, 2, uploader.calls)
	oldSnapshot, err := r.Store.ReferencePreparation(old.PreparationID, q.Binding.Owner)
	require.NoError(t, err)
	newSnapshot, err := r.Store.ReferencePreparation(current.PreparationID, q.Binding.Owner)
	require.NoError(t, err)
	require.Equal(t, "0.35", oldSnapshot.Accounting.BaseAmount)
	require.Equal(t, "0.49", newSnapshot.Accounting.BaseAmount)
}

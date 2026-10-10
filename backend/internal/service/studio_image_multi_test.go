package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func studioResultN(t *testing.T, count int) []byte {
	t.Helper()
	one := studioResult(t, "png")
	var payload struct {
		Data []map[string]string `json:"data"`
	}
	require.NoError(t, json.Unmarshal(one, &payload))
	b64 := payload.Data[0]["b64_json"]
	if _, err := base64.StdEncoding.Strict().DecodeString(b64); err != nil {
		t.Fatal(err)
	}
	payload.Data = make([]map[string]string, count)
	for i := range payload.Data {
		payload.Data[i] = map[string]string{"b64_json": b64}
	}
	out, err := json.Marshal(payload)
	require.NoError(t, err)
	return out
}

func enableStudioNativeMulti(t *testing.T, r *StudioImageRuntime) StudioImageQuote {
	t.Helper()
	ma := r.Media.(*studioMediaFixture)
	admin := mediaworkbench.NewService(ma)
	product := ma.a.Config.Draft.Products[0]
	product.Capabilities.Count = mediaworkbench.Range{Min: 1, Max: 5}
	product.AdapterConfig.Execution = &mediaworkbench.ImageExecutionConfig{Mode: mediaworkbench.ImageExecutionNativeMulti, MaxOutputImages: 2}
	product.PricingRules[0].Match.Count = &mediaworkbench.Range{Min: 1, Max: 5}
	draft, err := admin.SaveDraft(context.Background(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
	require.NoError(t, err)
	require.True(t, draft.Config.Validation.PublishReady, "%+v", draft.Config.Validation)
	draft, err = admin.Publish(context.Background(), 7, draft.Config.RecordVersion, draft.Config.Draft.Revision)
	require.NoError(t, err)
	_, err = admin.SetSales(context.Background(), 7, draft.Config.RecordVersion, true)
	require.NoError(t, err)
	binding, err := mediaworkbench.ResolvePublishedImageOffer(&ma.a, ma.a.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: 5})
	require.NoError(t, err)
	key := &APIKey{ID: 2, UserID: 1, Quota: 100, RateLimit5h: 100, GroupID: new(int64), Group: &Group{ID: 3, AllowImageGeneration: true}}
	*key.GroupID = 3
	account := r.Core.accountRepo.(*studioAccountFixture).a
	q := StudioImageQuote{Owner: StudioImageOwner{1, 2, 3}, Binding: binding, BaseURL: account.GetOpenAIBaseURL(), CredentialFingerprint: studioCredentialFingerprint(account), CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Minute), KeyQuotaEnabled: true, KeyRateEnabled: true, AccountQuotaEnabled: account.HasAnyQuotaLimit()}
	q.Accounting, err = ResolveStudioImageAccountCost(account, binding, studioAccountPrice("0.35"), q.CreatedAt)
	require.NoError(t, err)
	unit, total, err := mediaworkbench.PriceForQuantity(binding.Offer.SalePrice, 5)
	require.NoError(t, err)
	q.UnitPrice, q.TotalPrice, q.Quantity = &unit, &total, 5
	plan, err := mediaworkbench.PublishedImageExecution(binding)
	require.NoError(t, err)
	q.Execution = &plan
	token, err := r.Store.Issue(q)
	require.NoError(t, err)
	quoted, err := r.Store.Quote(token, q.Owner, time.Now().UTC())
	require.NoError(t, err)
	return quoted
}

func TestStudioImageNativeMultiBatchesAndSettlesDeliveredQuantity(t *testing.T) {
	r, _, _, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	key := &APIKey{ID: 2, UserID: 1, Quota: 100, RateLimit5h: 100, GroupID: new(int64), Group: &Group{ID: 3, AllowImageGeneration: true}}
	*key.GroupID = 3
	var counts []int
	r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
		var fields map[string]any
		require.NoError(t, json.Unmarshal(body, &fields))
		counts = append(counts, int(fields["n"].(float64)))
		return studioResultN(t, int(fields["n"].(float64))), "unit", nil
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "multi-native", "one prompt", nil, key)
	require.NoError(t, err)
	require.Equal(t, []int{2, 2, 1}, counts)
	require.Equal(t, 5, receipt.DeliveredCount)
	require.Zero(t, receipt.FailedCount)
	require.Equal(t, "completed", receipt.Status)
	require.Equal(t, "billed", receipt.BillingState)
	require.Equal(t, "4.00", billing.cmd.ExactAmounts.Balance)
	require.Equal(t, 5, billing.cmd.ImageCount)
	result, err := r.Store.Result(receipt)
	require.NoError(t, err)
	var payload struct {
		Data []json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(result, &payload))
	require.Len(t, payload.Data, 5)
	_, err = r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Len(t, counts, 3)
	require.Equal(t, 1, billing.applied)
}

func TestStudioImageMultiKnownFailureChargesDeliveredOnly(t *testing.T) {
	r, _, _, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	key := &APIKey{ID: 2, UserID: 1, Quota: 100, RateLimit5h: 100, GroupID: new(int64), Group: &Group{ID: 3, AllowImageGeneration: true}}
	*key.GroupID = 3
	calls := 0
	r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
		calls++
		if calls == 2 {
			return nil, "rejected", &StudioImageUpstreamError{Status: 422, RequestID: "rejected"}
		}
		var fields map[string]any
		require.NoError(t, json.Unmarshal(body, &fields))
		return studioResultN(t, int(fields["n"].(float64))), "unit", nil
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "multi-partial", "one prompt", nil, key)
	require.NoError(t, err)
	require.NotNil(t, receipt)
	require.Equal(t, 2, receipt.DeliveredCount)
	require.Equal(t, 3, receipt.FailedCount)
	require.Equal(t, "partial", receipt.Status)
	require.Equal(t, "billed", receipt.BillingState)
	require.Equal(t, "1.60", billing.cmd.ExactAmounts.Balance)
	require.Equal(t, 2, billing.cmd.ImageCount)
	got, recoverErr := r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, recoverErr)
	require.Equal(t, "partial", got.Status)
	require.Equal(t, 2, calls)
	require.Equal(t, 1, billing.applied)
}

func TestStudioImageMultiUnknownOutcomeNeverReplaysChild(t *testing.T) {
	r, _, _, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	key := &APIKey{ID: 2, UserID: 1, Quota: 100, RateLimit5h: 100, GroupID: new(int64), Group: &Group{ID: 3, AllowImageGeneration: true}}
	*key.GroupID = 3
	calls := 0
	r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
		calls++
		if calls == 2 {
			return nil, "", ErrStudioImageUnknown
		}
		var fields map[string]any
		require.NoError(t, json.Unmarshal(body, &fields))
		return studioResultN(t, int(fields["n"].(float64))), "unit", nil
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "multi-unknown", "one prompt", nil, key)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	require.Equal(t, 2, calls)
	require.Equal(t, "unknown", receipt.Status)
	_, err = r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	require.Equal(t, 2, calls)
	require.Zero(t, billing.applied)
}

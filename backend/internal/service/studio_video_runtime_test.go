package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
)

type videoOrderFixture struct {
	StudioVideoOrderRepository
	orders             map[string]*StudioVideoOrder
	captures, reserves int
}

func (f *videoOrderFixture) ReserveStudioVideoOrder(_ context.Context, c *StudioVideoReserveCommand) (*StudioVideoOrder, error) {
	if old := f.orders[c.ChildID]; old != nil {
		if old.HoldFingerprint != c.Fingerprint() {
			return nil, ErrStudioVideoConflict
		}
		return old, nil
	}
	f.reserves++
	o := &StudioVideoOrder{ChildID: c.ChildID, UserID: c.UserID, APIKeyID: c.APIKeyID, GroupID: c.GroupID, QuoteID: c.QuoteID, RequestHash: c.RequestHash, CapabilityVersion: c.CapabilityVersion, HoldFingerprint: c.Fingerprint(), State: StudioVideoHeld}
	f.orders[c.ChildID] = o
	return o, nil
}
func (f *videoOrderFixture) GetStudioVideoOrder(_ context.Context, user int64, id string) (*StudioVideoOrder, error) {
	o := f.orders[id]
	if o == nil || o.UserID != user {
		return nil, ErrStudioVideoNotFound
	}
	return o, nil
}
func (f *videoOrderFixture) CaptureStudioVideoOrder(ctx context.Context, c *StudioVideoCaptureCommand) (*StudioVideoOrder, error) {
	o, e := f.GetStudioVideoOrder(ctx, c.UserID, c.ChildID)
	if e != nil {
		return nil, e
	}
	if o.State == StudioVideoCaptured {
		if o.FinalFingerprint != c.Fingerprint() {
			return nil, ErrStudioVideoConflict
		}
		return o, nil
	}
	f.captures++
	o.State = StudioVideoCaptured
	o.SupplierTaskID = c.SupplierTaskID
	o.FinalFingerprint = c.Fingerprint()
	return o, nil
}
func (f *videoOrderFixture) ReleaseStudioVideoOrder(ctx context.Context, c *StudioVideoReleaseCommand) (*StudioVideoOrder, error) {
	o, e := f.GetStudioVideoOrder(ctx, c.UserID, c.ChildID)
	if e != nil {
		return nil, e
	}
	if o.State != StudioVideoHeld {
		return nil, ErrStudioVideoTerminalConflict
	}
	o.State = StudioVideoReleased
	return o, nil
}

func videoRuntimeFixture(t *testing.T) (*StudioVideoRuntime, string, StudioVideoQuote, *APIKey, *studioAccountFixture, *videoOrderFixture) {
	t.Helper()
	ctx := context.Background()
	image, _, key, accounts, _ := studioContractFixture(t)
	model, ok := videoplan.Lookup("3.0")
	require.True(t, ok)
	accounts.a.Credentials["model_mapping"] = map[string]any{"3.0": model.Upstream}
	ma := &studioMediaFixture{a: mediaworkbench.Account{ID: 7, Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true, BaseURL: accounts.a.GetOpenAIBaseURL(), ModelMapping: map[string]string{"3.0": model.Upstream}, Catalog: &mediaworkbench.Catalog{Models: []string{model.Upstream}, SyncedAt: "fixture"}}}
	svc := mediaworkbench.NewService(ma)
	_, e := svc.Initialize(ctx, 7, []string{"video"})
	require.NoError(t, e)
	_, e = svc.BindVideoAdapter(ctx, 7, ma.a.Config.RecordVersion, "laoli_video")
	require.NoError(t, e)
	p := mediaworkbench.Product{ProductID: "video", MediaType: "video", SiteModel: "3.0", UpstreamModel: model.Upstream, Enabled: true,
		Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5}, Count: mediaworkbench.Range{Min: 1, Max: 1}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 1}, TotalMax: 1}},
		PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}}
	d, e := svc.SaveDraft(ctx, 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, e)
	require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
	d, e = svc.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, e)
	_, e = svc.SetSales(ctx, 7, d.Config.RecordVersion, true)
	require.NoError(t, e)
	price := studioAccountPrice("0.35")
	price.AccountStatsPricingRules[0].Pricing[0].Models = []string{model.Upstream}
	price.AccountStatsPricingRules[0].Pricing[0].BillingMode = BillingModePerRequest
	image.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: price}}
	orders := &videoOrderFixture{orders: map[string]*StudioVideoOrder{}}
	r := NewStudioVideoRuntime(image.Core, ma, orders)
	r.Store = &StudioVideoStore{Root: t.TempDir()}
	r.enabled = true
	plan, e := videoplan.Preview("3.0", model.Upstream, "720p", "16:9", 5)
	require.NoError(t, e)
	token, q, e := r.Issue(ctx, StudioImageOwner{1, 2, 3}, key, ma.a.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Count: 1, DurationSeconds: 5, Resolution: "720p", AspectRatio: "16:9"}, plan.Body)
	require.NoError(t, e)
	return r, token, q, key, accounts, orders
}

func TestVideoRuntimeFrozenDispatchRecovery(t *testing.T) {
	r, token, q, key, accounts, orders := videoRuntimeFixture(t)
	ctx := context.Background()
	posts, gets := 0, 0
	r.request = func(_ context.Context, a *Account, method, path string, body []byte) ([]byte, string, error) {
		require.Equal(t, int64(7), a.ID)
		if method == http.MethodPost {
			posts++
			require.Equal(t, "/videos", path)
			require.Equal(t, []byte(q.Plan.Body), body)
			stored, e := r.Store.Task("av_original", q.Binding.Owner)
			require.NoError(t, e)
			require.Equal(t, q.BindingHash, stored.Quote.BindingHash)
			_, e = os.Stat(r.Store.path("dispatch", "av_original"))
			require.NoError(t, e)
			require.Equal(t, 1, orders.reserves)
			return []byte(`{"id":"upstream-original"}`), "application/json", nil
		}
		gets++
		require.Equal(t, "/videos/upstream-original", path)
		return []byte(`{"id":"upstream-original","status":"completed"}`), "application/json", nil
	}
	state, e := r.Submit(ctx, q.Binding.Owner, key, token, "av_original")
	require.NoError(t, e)
	require.Equal(t, "accepted", state.Status)
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	ma.a.Config.Published.Revision = "changed-latest"
	ma.a.Config.Sales.Enabled = false
	r.Core.channelService = nil
	multiplier := 9.
	accounts.a.RateMultiplier = &multiplier
	accounts.a.Credentials["model_mapping"] = map[string]any{"new-model": "new-upstream"}
	state, e = r.Recover(ctx, q.Binding.Owner, "av_original")
	require.NoError(t, e)
	require.Equal(t, "completed", state.Status)
	resultHash := strings.Repeat("a", 64)
	_, e = r.Capture(ctx, q.Binding.Owner, "av_original", resultHash)
	require.NoError(t, e)
	_, e = r.Capture(ctx, q.Binding.Owner, "av_original", resultHash)
	require.NoError(t, e)
	_, e = r.Submit(ctx, q.Binding.Owner, key, token, "av_original")
	require.NoError(t, e)
	require.Equal(t, 1, posts)
	require.Equal(t, 1, gets)
	require.Equal(t, 1, orders.captures)
	_, e = r.Capture(ctx, q.Binding.Owner, "av_original", strings.Repeat("b", 64))
	require.Error(t, e)
	_, e = r.Store.Task("av_original", StudioImageOwner{9, 2, 3})
	require.Error(t, e)
}

func TestVideoRuntimeUnknownNeverResubmits(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	calls := 0
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		calls++
		return nil, "", errors.New("lost response")
	}
	_, e := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_unknown")
	require.ErrorIs(t, e, ErrStudioVideoUnknown)
	restarted := *r
	restarted.Store = &StudioVideoStore{Root: r.Store.Root}
	for i := 0; i < 3; i++ {
		state, e := restarted.Submit(context.Background(), q.Binding.Owner, key, token, "av_unknown")
		require.NoError(t, e)
		require.Equal(t, "unknown", state.Status)
	}
	require.Equal(t, 1, calls)
	require.Equal(t, 0, orders.captures)
	_, e = r.Release(context.Background(), q.Binding.Owner, "av_unknown")
	require.Error(t, e)
}

func TestVideoRuntimeRejectsDroppedOrOverriddenSpecBeforeQuote(t *testing.T) {
	r, _, q, key, _, orders := videoRuntimeFixture(t)
	for _, tc := range []struct {
		field string
		value any
	}{
		{"duration", nil}, {"duration", 10}, {"resolution", nil}, {"resolution", "auto"}, {"ratio", "1:1"},
	} {
		var fields map[string]any
		require.NoError(t, json.Unmarshal(q.Plan.Body, &fields))
		if tc.value == nil {
			delete(fields, tc.field)
		} else {
			fields[tc.field] = tc.value
		}
		body, err := json.Marshal(fields)
		require.NoError(t, err)
		_, _, err = r.Issue(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, body)
		require.Error(t, err, "changed %s", tc.field)
	}
	require.Zero(t, orders.reserves)
	require.Zero(t, orders.captures)
}

func TestVideoRuntimeIdentityDrift(t *testing.T) {
	for _, kind := range []string{"credential", "account", "endpoint", "published", "cost_unknown"} {
		t.Run(kind, func(t *testing.T) {
			r, token, q, key, a, _ := videoRuntimeFixture(t)
			calls := 0
			r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
				calls++
				return nil, "", nil
			}
			switch kind {
			case "credential":
				a.a.Credentials["api_key"] = "changed"
			case "account":
				a.deleted = true
			case "endpoint":
				a.a.Credentials["base_url"] = "https://other.example/v1"
			case "published":
				ma, ok := r.Media.(*studioMediaFixture)
				require.True(t, ok)
				ma.a.Config.Published.Revision = "changed"
			case "cost_unknown":
				r.Core.channelService = nil
				_, _, e := r.Issue(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, q.Plan.Body)
				require.Error(t, e)
				return
			}
			_, e := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_drift")
			require.Error(t, e)
			require.Equal(t, 0, calls)
		})
	}
}

func TestVideoRuntimeQuoteCannotCreateSecondTask(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	calls := 0
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		calls++
		return []byte(`{"id":"original"}`), "application/json", nil
	}
	_, e := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_first")
	require.NoError(t, e)
	_, e = r.Submit(context.Background(), q.Binding.Owner, key, token, "av_second")
	require.Error(t, e)
	require.Equal(t, 1, calls)
	require.Equal(t, 1, orders.reserves)
}
func TestVideoRuntimeAmbiguousUpstreamIdentity(t *testing.T) {
	require.Empty(t, videoTaskID([]byte(`{"id":"one","task_id":"two"}`)))
	require.Equal(t, "one", videoTaskID([]byte(`{"id":"one","data":{"task_id":"one"}}`)))
}

func TestVideoCatalogUsesPublishedPriceAndFailsClosed(t *testing.T) {
	r, _, _, key, _, _ := videoRuntimeFixture(t)
	owner := StudioImageOwner{UserID: 1, APIKeyID: 2, GroupID: 3}
	offers, err := r.Catalog(context.Background(), owner, key)
	require.NoError(t, err)
	require.Len(t, offers, 1)
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	ma.a.Config.Published.Offers[0].SalePrice.Amount = ""
	offers, err = r.Catalog(context.Background(), owner, key)
	require.NoError(t, err)
	require.Empty(t, offers)
}

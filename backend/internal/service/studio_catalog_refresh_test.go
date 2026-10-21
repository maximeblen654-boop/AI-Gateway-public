package service

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

type studioCatalogRefreshFunc func(context.Context, int64) error

func (f studioCatalogRefreshFunc) Ensure(c context.Context, id int64) error { return f(c, id) }
func (f studioCatalogRefreshFunc) Current(*Account) bool                    { return true }

func TestStudioImageCatalogRefreshRechecksExactPublishedModel(t *testing.T) {
	r, q, key, billing := studioImage2ProSyncQuote(t, 1, 0, false)
	media, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	calls := 0
	r.CatalogSync = studioCatalogRefreshFunc(func(_ context.Context, id int64) error {
		calls++
		require.Equal(t, int64(7), id)
		media.a.Catalog.Models = []string{"replacement-public-id"}
		return nil
	})
	token, err := r.Issue(t.Context(), q.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, nil)
	require.Error(t, err)
	require.Empty(t, token)
	require.Equal(t, 1, calls)
	require.Zero(t, billing.calls)
	require.Equal(t, studioImage2ProPublicModel, media.a.Config.Published.Products[0].UpstreamModel, "refresh cannot rewrite a frozen commercial contract")
	offers, err := r.Catalog(t.Context(), q.Owner, key)
	require.NoError(t, err)
	require.Empty(t, offers)
}

func TestStudioImageCatalogRefreshFailureBlocksOnlyNewWork(t *testing.T) {
	r, q, key, billing := studioImage2ProSyncQuote(t, 1, 0, false)
	calls := 0
	r.CatalogSync = studioCatalogRefreshFunc(func(context.Context, int64) error { calls++; return ErrStudioModelCatalogUnavailable })
	_, err := r.Issue(t.Context(), q.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, nil)
	require.Error(t, err)
	require.Equal(t, "model_catalog", QuoteFailureStage(err))
	network := &studioImage2ProDocumentedHTTP{t: t, endpoint: imageplan.Generations, allRequested: true}
	r.Core.httpUpstream = network
	r.network = r.dispatchHTTP
	c, _ := newOpenAIImagesTestContext(t, nil)
	_, err = r.Dispatch(t.Context(), c, q, "stale-unsubmitted", "synthetic", nil, key)
	require.Error(t, err)
	require.Empty(t, network.bodies)
	require.Zero(t, billing.calls)
	require.Equal(t, 2, calls)
	r.CatalogSync = nil
	receipt, err := r.Dispatch(t.Context(), c, q, "existing-completed", "synthetic", nil, key)
	require.NoError(t, err)
	require.Equal(t, "completed", receipt.Status)
	r.CatalogSync = studioCatalogRefreshFunc(func(context.Context, int64) error {
		t.Fatal("recovery must not refresh or reinterpret an original model")
		return ErrStudioModelCatalogUnavailable
	})
	recovered, err := r.Recover(t.Context(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Equal(t, "completed", recovered.Status)
	require.Len(t, network.bodies, 1)
	require.Equal(t, 1, billing.applied)
}

func TestRefreshStudioCatalogReloadsRepositoryAfterConfirmation(t *testing.T) {
	r, _, _, _ := studioImage2ProSyncQuote(t, 1, 0, false)
	media, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	before := media.a
	sync := studioCatalogRefreshFunc(func(context.Context, int64) error {
		media.a.Catalog = &mediaworkbench.Catalog{Models: []string{"new-name"}}
		return nil
	})
	after, err := refreshStudioCatalog(t.Context(), media, sync, &before)
	require.NoError(t, err)
	require.Equal(t, []string{"new-name"}, after.Catalog.Models)
}

type studioCatalogObservation struct {
	studioCatalogRefreshFunc
	current bool
}

func (s studioCatalogObservation) Current(*Account) bool { return s.current }
func TestStudioPaidPreflightCannotApproveFailedCatalogRefresh(t *testing.T) {
	p, _, _ := paidPreflightFixture(t)
	p.image.CatalogSync = studioCatalogRefreshFunc(func(context.Context, int64) error { return ErrStudioModelCatalogUnavailable })
	report := p.check(t.Context(), "image", 1)
	require.False(t, report.Pass)
	require.Empty(t, report.dependencies.Offers)
	found := false
	for _, check := range report.Checks {
		if check.Code == "model_catalog" && !check.Pass {
			found = true
		}
	}
	require.True(t, found)
}
func TestStudioPaidSnapshotExcludesStaleCatalogWithoutFetching(t *testing.T) {
	p, _, _ := paidPreflightFixture(t)
	good, err := p.snapshot(t.Context(), "image", 1)
	require.NoError(t, err)
	require.NotEmpty(t, good.grants)
	p.image.CatalogSync = studioCatalogObservation{studioCatalogRefreshFunc: func(context.Context, int64) error { t.Fatal("status read must not fetch a catalog"); return nil }, current: false}
	stale, err := p.snapshot(t.Context(), "image", 1)
	require.NoError(t, err)
	require.Empty(t, stale.grants)
	require.Empty(t, stale.accounts)
	require.Equal(t, good.fingerprint, stale.fingerprint)
	p.image.CatalogSync = studioCatalogObservation{current: true}
	restored, err := p.snapshot(t.Context(), "image", 1)
	require.NoError(t, err)
	require.Equal(t, good.grants, restored.grants)
}

func TestStudioModelCatalogCurrentIsIdentityBoundAndPure(t *testing.T) {
	now := time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC)
	a := &Account{ID: 77, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": "https://api.image2pro.top/v1", "api_key": "synthetic-only"}, Extra: map[string]any{mediaworkbench.ExtraKey: map[string]any{"media_types": []string{"image"}}}}
	identity, err := studioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	a.Extra[mediaworkbench.CatalogKey] = &mediaworkbench.Catalog{Source: "upstream", SyncedAt: now.Add(-time.Minute).Format(time.RFC3339), Models: []string{"current-model"}, AccountIdentitySHA256: identity}
	sync := &StudioModelCatalogSync{now: func() time.Time { return now }}
	require.True(t, sync.Current(a))
	now = now.Add(6 * time.Minute)
	require.False(t, sync.Current(a))
	now = now.Add(-6 * time.Minute)
	a.Credentials["api_key"] = "rotated-synthetic-only"
	require.False(t, sync.Current(a))
	a.Credentials["base_url"] = "https://unrelated.example/v1"
	require.True(t, sync.Current(a), "unrelated API Accounts are outside this observer")
}

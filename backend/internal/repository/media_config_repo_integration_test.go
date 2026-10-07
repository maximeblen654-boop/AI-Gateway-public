//go:build integration

package repository

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestMediaPublishPostgresDependenciesAndReadiness(t *testing.T) {
	ctx := context.Background()
	a, err := integrationEntClient.Account.Create().SetName("media-publish-fixture").SetPlatform("openai").SetType("apikey").SetCredentials(map[string]any{"api_key": "fixture-only", "model_mapping": map[string]any{"gpt-image-*": "gpt-image-2"}}).SetExtra(map[string]any{mediaworkbench.CatalogKey: map[string]any{"models": []string{"gpt-image-2"}, "synced_at": "2026-10-05T00:00:00Z"}, "unrelated": true}).SetStatus("active").SetSchedulable(true).Save(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM scheduler_outbox WHERE account_id=$1", a.ID)
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM accounts WHERE id=$1", a.ID)
	})
	repo := NewMediaConfigRepository(integrationDB)
	svc := mediaworkbench.NewService(repo)
	d, err := svc.Initialize(ctx, a.ID, []string{"image"})
	require.NoError(t, err)
	product := mediaworkbench.Product{ProductID: "p", MediaType: "image", SiteModel: "gpt-image-site", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Count: mediaworkbench.Range{Min: 1, Max: 1}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.100000000000000001", Currency: "USD", BillingMode: "per_request"}}}}
	d, err = svc.SaveDraft(ctx, a.ID, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
	require.NoError(t, err)
	require.Equal(t, "PASS", d.Config.Validation.Status)
	d, err = svc.Publish(ctx, a.ID, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	require.Len(t, d.Config.Published.Offers, 1)
	require.Equal(t, product.PricingRules[0].SalePrice.Amount, d.Config.Published.Offers[0].SalePrice.Amount)
	d, err = svc.SetSales(ctx, a.ID, d.Config.RecordVersion, true)
	require.NoError(t, err)
	require.True(t, d.EffectiveSales)
	// Runtime gates are checked again under the row lock when enabling sales.
	d, err = svc.SetSales(ctx, a.ID, d.Config.RecordVersion, false)
	require.NoError(t, err)
	checked, err := repo.Get(ctx, a.ID)
	require.NoError(t, err)
	expected := checked.Config.RecordVersion
	checked.Config.RecordVersion++
	checked.Config.Sales = mediaworkbench.Sales{Enabled: true, UpdatedAt: time.Now().UTC()}
	_, err = integrationDB.ExecContext(ctx, "UPDATE accounts SET status='disabled' WHERE id=$1", a.ID)
	require.NoError(t, err)
	require.ErrorIs(t, repo.CompareAndSwapChecked(ctx, a.ID, expected, mediaworkbench.DependenciesFor(checked), checked.Config), mediaworkbench.ErrSales)
	_, err = integrationDB.ExecContext(ctx, "UPDATE accounts SET status='active' WHERE id=$1", a.ID)
	require.NoError(t, err)
	d, err = svc.SetSales(ctx, a.ID, expected, true)
	require.NoError(t, err)
	// Observe native quota, expiry and cooldown semantics through the allowlist
	// projection. Each case restores the disposable fixture before continuing.
	for _, update := range []string{
		`extra=extra || '{"quota_limit":1,"quota_used":1}'::jsonb`,
		`expires_at=NOW()-INTERVAL '1 hour',auto_pause_on_expired=true`,
		`rate_limit_reset_at=NOW()+INTERVAL '1 hour'`,
		`overload_until=NOW()+INTERVAL '1 hour'`,
		`temp_unschedulable_until=NOW()+INTERVAL '1 hour'`,
	} {
		_, err = integrationDB.ExecContext(ctx, "UPDATE accounts SET "+update+" WHERE id=$1", a.ID)
		require.NoError(t, err)
		blocked, readErr := repo.Get(ctx, a.ID)
		require.NoError(t, readErr)
		require.False(t, blocked.RuntimeReady)
		_, err = integrationDB.ExecContext(ctx, `UPDATE accounts SET extra=extra-'quota_limit'-'quota_used',expires_at=NULL,rate_limit_reset_at=NULL,overload_until=NULL,temp_unschedulable_until=NULL WHERE id=$1`, a.ID)
		require.NoError(t, err)
	}
	// Rotation changes only the secret, never the business dependency fingerprint.
	before, err := repo.Get(ctx, a.ID)
	require.NoError(t, err)
	_, err = integrationDB.ExecContext(ctx, `UPDATE accounts SET credentials=jsonb_set(credentials,'{api_key}','"rotated-fixture"'::jsonb) WHERE id=$1`, a.ID)
	require.NoError(t, err)
	after, err := repo.Get(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, mediaworkbench.DependenciesFor(before), mediaworkbench.DependenciesFor(after))
	// A non-media Account edit between compilation and CAS must fail inside the
	// locked transaction, even though record_version did not change.
	c := after.Config
	c.RecordVersion++
	_, err = integrationDB.ExecContext(ctx, `UPDATE accounts SET credentials=jsonb_set(credentials,'{model_mapping}','{"gpt-image-*":"gpt-image-new"}'::jsonb) WHERE id=$1`, a.ID)
	require.NoError(t, err)
	require.ErrorIs(t, repo.CompareAndSwapChecked(ctx, a.ID, after.Config.RecordVersion-1, mediaworkbench.DependenciesFor(after), c), mediaworkbench.ErrStale)
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.False(t, d.EffectiveSales)
	d, err = svc.Publish(ctx, a.ID, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.ErrorIs(t, err, mediaworkbench.ErrValidation)
	require.False(t, d.Config.Validation.PublishReady)
	var count int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM scheduler_outbox WHERE account_id=$1", a.ID).Scan(&count))
	require.Zero(t, count)
}

// Uses only the disposable PostgreSQL provided by the existing integration harness.
func TestMediaConfigPostgresCAS(t *testing.T) {
	ctx := context.Background()
	a, err := integrationEntClient.Account.Create().SetName("media-cas-fixture").SetPlatform("openai").SetType("apikey").SetCredentials(map[string]any{"api_key": "fixture-only"}).SetExtra(map[string]any{"unrelated": "preserve"}).SetStatus("active").SetSchedulable(true).Save(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM scheduler_outbox WHERE account_id=$1", a.ID)
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM accounts WHERE id=$1", a.ID)
	})
	repo := NewMediaConfigRepository(integrationDB)
	svc := mediaworkbench.NewService(repo)
	d, err := svc.Initialize(ctx, a.ID, []string{"image"})
	require.NoError(t, err)
	require.EqualValues(t, 1, d.Config.RecordVersion)
	// Full generic edit loaded before media mutation must not revert the document.
	general := NewAccountRepository(integrationEntClient, integrationDB, nil)
	stale, err := general.GetByID(ctx, a.ID)
	require.NoError(t, err)
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var e error
			if i%2 == 0 {
				_, e = svc.SaveDraft(ctx, a.ID, 1, mediaworkbench.DraftInput{})
			} else {
				_, e = svc.SetSales(ctx, a.ID, 1, false)
			}
			results <- e
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, mediaworkbench.ErrStale) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	require.Equal(t, 1, success)
	require.Equal(t, 15, conflicts)
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	version := d.Config.RecordVersion
	require.True(t, version == 2 || version == 3) // Save includes a separate validation CAS.
	var count int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM scheduler_outbox WHERE account_id=$1", a.ID).Scan(&count))
	require.Zero(t, count, "media-only mutations must not enqueue scheduler events")
	var unrelated string
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT extra->>'unrelated' FROM accounts WHERE id=$1", a.ID).Scan(&unrelated))
	require.Equal(t, "preserve", unrelated)
	stale.Name = "ordinary rename"
	require.NoError(t, general.Update(ctx, stale))
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.EqualValues(t, version, d.Config.RecordVersion)
	require.NoError(t, general.UpdateExtra(ctx, a.ID, map[string]any{"media_workbench_v1": nil, "other": true}))
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.EqualValues(t, version, d.Config.RecordVersion)
	_, err = integrationDB.ExecContext(ctx, "UPDATE accounts SET deleted_at=$2 WHERE id=$1", a.ID, time.Now())
	require.NoError(t, err)
	_, err = svc.SetSales(ctx, a.ID, 2, false)
	require.ErrorIs(t, err, mediaworkbench.ErrNotFound)
	require.ErrorIs(t, repo.CompareAndSwap(ctx, a.ID, 2, &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: 3}), mediaworkbench.ErrNotFound)
}

// The embedded nil interface makes any bucket/cache operation except the
// existing single-Account refresh fail the test immediately.
type mediaCatalogSnapshotCache struct {
	service.SchedulerCache
	account *service.Account
}

func (c *mediaCatalogSnapshotCache) SetAccount(_ context.Context, a *service.Account) error {
	c.account = a
	return nil
}

func TestMediaCatalogSnapshotPostgresDoesNotRebuildScheduler(t *testing.T) {
	ctx := context.Background()
	a, err := integrationEntClient.Account.Create().SetName("media-catalog-fixture").SetPlatform("openai").SetType("apikey").SetCredentials(map[string]any{}).SetStatus("active").SetSchedulable(true).Save(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM scheduler_outbox WHERE account_id=$1", a.ID)
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM accounts WHERE id=$1", a.ID)
	})
	cache := &mediaCatalogSnapshotCache{}
	repo := NewAccountRepository(integrationEntClient, integrationDB, cache)
	snapshot := map[string]any{"source": "upstream", "models": []string{"image-model"}, "synced_at": "2026-10-05T00:00:00Z"}
	require.NoError(t, repo.UpdateExtra(ctx, a.ID, map[string]any{mediaworkbench.CatalogKey: snapshot}))
	var count int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM scheduler_outbox WHERE account_id=$1", a.ID).Scan(&count))
	require.Zero(t, count)
	got, err := repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	require.NotNil(t, cache.account)
	want, _ := json.Marshal(snapshot)
	stored, _ := json.Marshal(got.Extra[mediaworkbench.CatalogKey])
	cached, _ := json.Marshal(cache.account.Extra[mediaworkbench.CatalogKey])
	require.JSONEq(t, string(want), string(stored))
	require.JSONEq(t, string(want), string(cached))
}

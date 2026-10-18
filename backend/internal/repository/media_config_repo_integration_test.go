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
	product := mediaworkbench.Product{CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, ProductID: "p", MediaType: "image", SiteModel: "gpt-image-site", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Count: mediaworkbench.Range{Min: 1, Max: 1}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.10000001", Currency: "CNY", BillingMode: "per_request"}}}}
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
	// API aliases are independent of the v1 Studio contract, including an edit
	// between compilation and the locked media CAS.
	publishedRevision := after.Config.Published.Revision
	expected = after.Config.RecordVersion
	dependencies := mediaworkbench.DependenciesFor(after)
	c := after.Config
	c.RecordVersion++
	_, err = integrationDB.ExecContext(ctx, `UPDATE accounts SET credentials=jsonb_set(credentials,'{model_mapping}','{"gpt-image-*":"gpt-image-new"}'::jsonb) WHERE id=$1`, a.ID)
	require.NoError(t, err)
	mapped, err := repo.Get(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, "gpt-image-new", mapped.ModelMapping["gpt-image-*"])
	require.Equal(t, dependencies, mediaworkbench.DependenciesFor(mapped))
	require.NoError(t, repo.CompareAndSwapChecked(ctx, a.ID, expected, dependencies, c))
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.True(t, d.EffectiveSales)
	require.Equal(t, product.UpstreamModel, d.Config.Published.Offers[0].UpstreamModel)
	require.Equal(t, publishedRevision, d.Config.Published.Revision)
	d, err = svc.Publish(ctx, a.ID, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	require.True(t, d.EffectiveSales)
	// Removing the actual Studio model remains a real dependency change. The
	// row version is unchanged, so the stale CAS must reject the catalog drift.
	checked, err = repo.Get(ctx, a.ID)
	require.NoError(t, err)
	expected = checked.Config.RecordVersion
	dependencies = mediaworkbench.DependenciesFor(checked)
	checked.Config.RecordVersion++
	_, err = integrationDB.ExecContext(ctx, `UPDATE accounts SET extra=jsonb_set(extra,'{upstream_model_catalog_snapshot,models}','["gpt-image-new"]'::jsonb) WHERE id=$1`, a.ID)
	require.NoError(t, err)
	require.ErrorIs(t, repo.CompareAndSwapChecked(ctx, a.ID, expected, dependencies, checked.Config), mediaworkbench.ErrStale)
	d, err = svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, expected, d.Config.RecordVersion)
	require.False(t, d.EffectiveSales)
	d, err = svc.Publish(ctx, a.ID, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.ErrorIs(t, err, mediaworkbench.ErrValidation)
	require.False(t, d.Config.Validation.PublishReady)
	require.Equal(t, publishedRevision, d.Config.Published.Revision)
	missingModel := false
	for _, diagnostic := range d.Config.Validation.Diagnostics {
		if diagnostic.Code == "MODEL_NOT_DISCOVERED" && diagnostic.Scope == product.ProductID {
			missingModel = true
		}
	}
	require.True(t, missingModel, "publication must reject the removed Studio model")
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

func TestBlankDraftRemovalPersistsOnlyAccountMediaConfig(t *testing.T) {
	ctx := context.Background()
	a, err := integrationEntClient.Account.Create().SetName("blank-draft-removal-fixture").SetPlatform("openai").SetType("apikey").SetCredentials(map[string]any{"api_key": "fixture-only", "model_mapping": map[string]any{"gpt-image-*": "gpt-image-2"}}).SetExtra(map[string]any{"unrelated": "preserve"}).SetStatus("active").SetSchedulable(true).Save(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM scheduler_outbox WHERE account_id=$1", a.ID)
		_, _ = integrationDB.ExecContext(ctx, "DELETE FROM accounts WHERE id=$1", a.ID)
	})
	svc := mediaworkbench.NewService(NewMediaConfigRepository(integrationDB))
	products := []mediaworkbench.Product{{ProductID: "configured", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"1K"}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.70", Currency: "CNY", BillingMode: "per_request"}}}}}
	for _, id := range []string{"blank-1", "blank-2", "blank-3", "blank-4", "blank-5", "blank-6"} {
		products = append(products, mediaworkbench.Product{ProductID: id, MediaType: "image", UpstreamModel: "gpt-image-2"})
	}
	d, err := svc.SaveDraft(ctx, a.ID, 0, mediaworkbench.DraftInput{Products: products})
	require.NoError(t, err)
	before, err := integrationEntClient.Account.Get(ctx, a.ID)
	require.NoError(t, err)
	original := d.Config.Draft.Products[0]
	remaining := append(append([]mediaworkbench.Product{}, d.Config.Draft.Products[:3]...), d.Config.Draft.Products[4:]...)
	_, err = svc.SaveDraft(ctx, a.ID, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: remaining})
	require.ErrorIs(t, err, mediaworkbench.ErrDraftRemoval)
	d, err = svc.SaveDraft(ctx, a.ID, d.Config.RecordVersion, mediaworkbench.DraftInput{Products: remaining, RemoveProductIDs: []string{"blank-3"}})
	require.NoError(t, err)
	loaded, err := svc.Detail(ctx, a.ID)
	require.NoError(t, err)
	require.Len(t, loaded.Config.Draft.Products, 6)
	require.Equal(t, original, loaded.Config.Draft.Products[0])
	require.Len(t, loaded.Config.RemovedDraftProducts, 1)
	require.Equal(t, "blank-3", loaded.Config.RemovedDraftProducts[0].ProductID)
	after, err := integrationEntClient.Account.Get(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, before.Credentials, after.Credentials)
	require.Equal(t, before.Status, after.Status)
	require.Equal(t, before.Schedulable, after.Schedulable)
	require.Equal(t, before.Extra["unrelated"], after.Extra["unrelated"])
	require.False(t, d.Config.Sales.Enabled)
	var scheduled int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM scheduler_outbox WHERE account_id=$1", a.ID).Scan(&scheduled))
	require.Zero(t, scheduled)
}

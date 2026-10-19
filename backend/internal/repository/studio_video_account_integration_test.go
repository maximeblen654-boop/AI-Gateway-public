//go:build integration

package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestVideoAccountPostgresAtomicCaptureAndReplay(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	// Restore the unchanged archived video table ONLY in the disposable fixture.
	// No migration is added and no production database is touched.
	ddl, e := os.ReadFile("testdata/studio_video_orders_legacy.sql")
	require.NoError(t, e)
	_, e = integrationDB.ExecContext(ctx, string(ddl))
	require.NoError(t, e)
	suffix := time.Now().UnixNano()
	user := mustCreateUser(t, client, &service.User{Email: fmt.Sprintf("video-%d@example.com", suffix), PasswordHash: "synthetic", Balance: 10})
	group := mustCreateGroup(t, client, &service.Group{Name: fmt.Sprintf("video-%d", suffix), Platform: service.PlatformOpenAI})
	key := mustCreateApiKey(t, client, &service.APIKey{UserID: user.ID, GroupID: &group.ID, Key: fmt.Sprintf("sk-video-fixture-%d", suffix), Quota: 100})
	account := mustCreateAccount(t, client, &service.Account{Name: "Video fixture", Type: service.AccountTypeAPIKey, Platform: service.PlatformOpenAI, Extra: map[string]any{"quota_limit": 100.0}})
	t.Cleanup(func() {
		for _, v := range []struct {
			q  string
			id int64
		}{
			{"DELETE FROM studio_video_orders WHERE user_id=$1", user.ID}, {"DELETE FROM usage_logs WHERE api_key_id=$1", key.ID},
			{"DELETE FROM usage_billing_dedup WHERE api_key_id=$1", key.ID}, {"DELETE FROM usage_billing_dedup_archive WHERE api_key_id=$1", key.ID},
			{"DELETE FROM api_keys WHERE id=$1", key.ID}, {"DELETE FROM accounts WHERE id=$1", account.ID}, {"DELETE FROM groups WHERE id=$1", group.ID}, {"DELETE FROM users WHERE id=$1", user.ID},
		} {
			_, e := integrationDB.ExecContext(ctx, v.q, v.id)
			require.NoError(t, e)
		}
	})
	b := videoBindingFixture(t)
	b.Owner = service.StudioImageOwner{UserID: user.ID, APIKeyID: key.ID, GroupID: group.ID}
	b.Offer.AccountID = account.ID
	b.Accounting.AccountID = account.ID
	child := fmt.Sprintf("av_pg_%d", suffix)
	repo := NewStudioVideoOrderRepository(integrationDB)
	reserve := &service.StudioVideoReserveCommand{ChildID: child, UserID: user.ID, APIKeyID: key.ID, GroupID: group.ID, QuoteID: b.QuoteID, CapabilityVersion: b.CapabilityVersion(), RequestHash: b.RequestHash, HoldAmount: .8, Binding: b}
	_, e = repo.ReserveStudioVideoOrder(ctx, reserve)
	require.NoError(t, e)
	_, e = repo.ReserveStudioVideoOrder(ctx, reserve)
	require.NoError(t, e)
	var balance, frozen string
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "9.20000000", balance)
	require.Equal(t, "0.80000000", frozen)
	capture := &service.StudioVideoCaptureCommand{ChildID: child, UserID: user.ID, ActualAmount: .8, SupplierTaskID: "original-upstream", EvidenceHash: b.RequestHash, ResultHash: b.RequestHash, Binding: b}
	var wg sync.WaitGroup
	results := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := repo.CaptureStudioVideoOrder(ctx, capture); results <- e }()
	}
	wg.Wait()
	close(results)
	for e := range results {
		require.NoError(t, e)
	}
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "9.20000000", balance)
	require.Equal(t, "0.00000000", frozen)
	var quota, cost, actual, stats, rate string
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT quota_used::text FROM api_keys WHERE id=$1", key.ID).Scan(&quota))
	require.Equal(t, "0.80000000", quota)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT extra->>'quota_used' FROM accounts WHERE id=$1", account.ID).Scan(&cost))
	require.Equal(t, "0.35", cost)
	req := service.HashUsageRequestPayload([]byte("account-video:" + child))
	var count int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT actual_cost::text,account_stats_cost::text,account_rate_multiplier::text,video_count FROM usage_logs WHERE request_id=$1 AND api_key_id=$2", req, key.ID).Scan(&actual, &stats, &rate, &count))
	require.Equal(t, "0.8000000000", actual)
	require.Equal(t, "0.3500000000", stats)
	require.Equal(t, "1.0000", rate)
	require.Equal(t, 1, count)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_billing_dedup WHERE request_id=$1 AND api_key_id=$2", req, key.ID).Scan(&count))
	require.Equal(t, 1, count)
	// A zero-row Account update fails AFTER consuming the hold in the transaction.
	// Rollback must restore the hold and remove both dedup and Key quota effects.
	child2 := child + "_rollback"
	bad := *b
	bad.Offer.AccountID = 9223372036854775806
	bad.Accounting.AccountID = bad.Offer.AccountID
	second := *reserve
	second.ChildID = child2
	second.Binding = &bad
	second.CapabilityVersion = bad.CapabilityVersion()
	_, e = repo.ReserveStudioVideoOrder(ctx, &second)
	require.NoError(t, e)
	failed := *capture
	failed.ChildID = child2
	failed.Binding = &bad
	_, e = repo.CaptureStudioVideoOrder(ctx, &failed)
	require.Error(t, e)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "8.40000000", balance)
	require.Equal(t, "0.80000000", frozen)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT quota_used::text FROM api_keys WHERE id=$1", key.ID).Scan(&quota))
	require.Equal(t, "0.80000000", quota)
	failedReq := service.HashUsageRequestPayload([]byte("account-video:" + child2))
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_billing_dedup WHERE request_id=$1 AND api_key_id=$2", failedReq, key.ID).Scan(&count))
	require.Zero(t, count)
	_, e = repo.ReleaseStudioVideoOrder(ctx, &service.StudioVideoReleaseCommand{ChildID: child2, UserID: user.ID, Reason: "fixture_failed", EvidenceHash: b.RequestHash, Binding: &bad})
	require.NoError(t, e)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "9.20000000", balance)
	require.Equal(t, "0.00000000", frozen)
}

func TestVideoRetailPostgresUnknownCostAtomicCapture(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	// Restore the unchanged archived video table ONLY in the disposable fixture.
	// No migration is added and no production database is touched.
	ddl, e := os.ReadFile("testdata/studio_video_orders_legacy.sql")
	require.NoError(t, e)
	_, e = integrationDB.ExecContext(ctx, string(ddl))
	require.NoError(t, e)
	suffix := time.Now().UnixNano()
	user := mustCreateUser(t, client, &service.User{Email: fmt.Sprintf("video-%d@example.com", suffix), PasswordHash: "synthetic", Balance: 10})
	group := mustCreateGroup(t, client, &service.Group{Name: fmt.Sprintf("video-%d", suffix), Platform: service.PlatformOpenAI})
	key := mustCreateApiKey(t, client, &service.APIKey{UserID: user.ID, GroupID: &group.ID, Key: fmt.Sprintf("sk-video-fixture-%d", suffix), Quota: 100})
	account := mustCreateAccount(t, client, &service.Account{Name: "Video fixture", Type: service.AccountTypeAPIKey, Platform: service.PlatformOpenAI, Extra: map[string]any{"quota_used": 3.0}})
	t.Cleanup(func() {
		for _, v := range []struct {
			q  string
			id int64
		}{
			{"DELETE FROM studio_video_orders WHERE user_id=$1", user.ID}, {"DELETE FROM usage_logs WHERE api_key_id=$1", key.ID},
			{"DELETE FROM usage_billing_dedup WHERE api_key_id=$1", key.ID}, {"DELETE FROM usage_billing_dedup_archive WHERE api_key_id=$1", key.ID},
			{"DELETE FROM api_keys WHERE id=$1", key.ID}, {"DELETE FROM accounts WHERE id=$1", account.ID}, {"DELETE FROM groups WHERE id=$1", group.ID}, {"DELETE FROM users WHERE id=$1", user.ID},
		} {
			_, e := integrationDB.ExecContext(ctx, v.q, v.id)
			require.NoError(t, e)
		}
	})
	b := videoBindingFixture(t)
	b.Owner = service.StudioImageOwner{UserID: user.ID, APIKeyID: key.ID, GroupID: group.ID}
	b.Offer.AccountID = account.ID
	b.Accounting.AccountID = account.ID

	b.Version = service.StudioVideoRetailBindingVersion
	b.AccountQuotaEnabled = false
	b.Offer.SalePrice.Amount = "4"
	b.Accounting.SourceState = "unknown"
	b.Accounting.SourceType = service.StudioVideoRetailUsageMode
	b.Accounting.SourceID = fmt.Sprintf("account:%d/product:%s/published:%s", account.ID, b.Offer.ProductID, b.PublishedRevision)
	raw, e := json.Marshal([]string{b.Accounting.SourceID, b.SpecHash})
	require.NoError(t, e)
	b.Accounting.SourceHash = service.HashUsageRequestPayload(raw)
	b.Accounting.BaseAmount = ""
	b.Accounting.EffectiveAccountQuotaCost = ""
	require.NoError(t, b.Validate())
	child := fmt.Sprintf("av_retail_pg_%d", suffix)
	repo := NewStudioVideoOrderRepository(integrationDB)
	reserve := &service.StudioVideoReserveCommand{ChildID: child, UserID: user.ID, APIKeyID: key.ID, GroupID: group.ID, QuoteID: b.QuoteID, CapabilityVersion: b.CapabilityVersion(), RequestHash: b.RequestHash, HoldAmount: 4, Binding: b}
	_, e = repo.ReserveStudioVideoOrder(ctx, reserve)
	require.NoError(t, e)
	capture := &service.StudioVideoCaptureCommand{ChildID: child, UserID: user.ID, ActualAmount: 4, SupplierTaskID: "original-retail", EvidenceHash: b.RequestHash, ResultHash: b.RequestHash, Binding: b}
	// A failed usage insert must preserve the hold and roll back Key/dedup effects.
	_, e = integrationDB.ExecContext(ctx, `ALTER TABLE usage_logs ADD CONSTRAINT fixture_retail_reject CHECK (billing_mode <> 'studio_video_retail')`)
	require.NoError(t, e)
	t.Cleanup(func() {
		_, err := integrationDB.ExecContext(context.Background(), `ALTER TABLE usage_logs DROP CONSTRAINT IF EXISTS fixture_retail_reject`)
		require.NoError(t, err)
	})
	_, e = repo.CaptureStudioVideoOrder(ctx, capture)
	require.Error(t, e)
	var balance, frozen, quota string
	var count int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "6.00000000", balance)
	require.Equal(t, "4.00000000", frozen)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT quota_used::text FROM api_keys WHERE id=$1", key.ID).Scan(&quota))
	require.Equal(t, "0.00000000", quota)
	req := service.HashUsageRequestPayload([]byte("account-video:" + child))
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_billing_dedup WHERE request_id=$1", req).Scan(&count))
	require.Zero(t, count)
	_, e = integrationDB.ExecContext(ctx, `ALTER TABLE usage_logs DROP CONSTRAINT fixture_retail_reject`)
	require.NoError(t, e)
	// Actual repository SQL: the pre-fix empty string fails numeric conversion here.
	_, e = repo.CaptureStudioVideoOrder(ctx, capture)
	require.NoError(t, e)
	for i := 0; i < 3; i++ {
		_, e = repo.CaptureStudioVideoOrder(ctx, capture)
		require.NoError(t, e)
	}
	var stats sql.NullString
	var mode, actual, cost string
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT account_stats_cost::text,billing_mode,actual_cost::text FROM usage_logs WHERE request_id=$1", req).Scan(&stats, &mode, &actual))
	require.False(t, stats.Valid)
	require.Equal(t, service.StudioVideoRetailUsageMode, mode)
	require.Equal(t, "4.0000000000", actual)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text,frozen_balance::text FROM users WHERE id=$1", user.ID).Scan(&balance, &frozen))
	require.Equal(t, "6.00000000", balance)
	require.Equal(t, "0.00000000", frozen)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT quota_used::text FROM api_keys WHERE id=$1", key.ID).Scan(&quota))
	require.Equal(t, "4.00000000", quota)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT extra->>'quota_used' FROM accounts WHERE id=$1", account.ID).Scan(&cost))
	require.Equal(t, "3", cost)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_billing_dedup WHERE request_id=$1", req).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT count(*) FROM usage_logs WHERE request_id=$1", req).Scan(&count))
	require.Equal(t, 1, count)
}

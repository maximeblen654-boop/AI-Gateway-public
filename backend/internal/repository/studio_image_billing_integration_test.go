//go:build integration

package repository

import (
	"context"
	"fmt"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestStudioQuotedBillingPostgresSeparationAndReplay(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	user := mustCreateUser(t, client, &service.User{Email: fmt.Sprintf("studio-bound-%d@example.com", time.Now().UnixNano()), PasswordHash: "synthetic", Balance: 10})
	group := mustCreateGroup(t, client, &service.Group{Name: fmt.Sprintf("studio-bound-%d", time.Now().UnixNano()), Platform: service.PlatformOpenAI})
	key := mustCreateApiKey(t, client, &service.APIKey{UserID: user.ID, GroupID: &group.ID, Key: fmt.Sprintf("sk-synthetic-studio-%d", time.Now().UnixNano()), Quota: 100})
	account := mustCreateAccount(t, client, &service.Account{Name: "synthetic Studio", Type: service.AccountTypeAPIKey, Platform: service.PlatformOpenAI, Extra: map[string]any{"quota_limit": 100.0}})
	// This package shares one disposable database. Remove this fixture's usage
	// so native dashboard tests still observe only their own active users.
	t.Cleanup(func() {
		for _, cleanup := range []struct {
			query string
			id    int64
		}{
			{"DELETE FROM usage_logs WHERE api_key_id=$1", key.ID},
			{"DELETE FROM usage_billing_dedup WHERE api_key_id=$1", key.ID},
			{"DELETE FROM usage_billing_dedup_archive WHERE api_key_id=$1", key.ID},
			{"DELETE FROM api_keys WHERE id=$1", key.ID},
			{"DELETE FROM accounts WHERE id=$1", account.ID},
			{"DELETE FROM groups WHERE id=$1", group.ID},
			{"DELETE FROM users WHERE id=$1", user.ID},
		} {
			_, err := integrationDB.ExecContext(ctx, cleanup.query, cleanup.id)
			require.NoError(t, err)
		}
	})
	receipt := quotedBillingFixture(t, user.ID, key.ID, account.ID, group.ID)
	repo := NewUsageBillingRepository(client, integrationDB)
	first, e := service.SettleQuotedImage(ctx, repo, receipt)
	require.NoError(t, e)
	require.True(t, first.Applied)
	second, e := service.SettleQuotedImage(ctx, repo, receipt)
	require.NoError(t, e)
	require.False(t, second.Applied)
	var balance, keyCost, accountCost, customer, stats, rate string
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance::text FROM users WHERE id=$1", user.ID).Scan(&balance))
	require.Equal(t, "9.20000000", balance)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT quota_used::text FROM api_keys WHERE id=$1", key.ID).Scan(&keyCost))
	require.Equal(t, "0.80000000", keyCost)
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT extra->>'quota_used' FROM accounts WHERE id=$1", account.ID).Scan(&accountCost))
	require.Equal(t, "0.35", accountCost)
	requestID := service.HashUsageRequestPayload([]byte("studio-image:" + receipt.TaskID))
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT actual_cost::text,account_stats_cost::text,account_rate_multiplier::text FROM usage_logs WHERE request_id=$1 AND api_key_id=$2", requestID, key.ID).Scan(&customer, &stats, &rate))
	require.Equal(t, "0.8000000000", customer)
	require.Equal(t, "0.3500000000", stats)
	require.Equal(t, "1.0000", rate)
}

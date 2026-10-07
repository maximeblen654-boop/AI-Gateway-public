package repository

import (
	"context"
	"testing"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
)

func TestUpdateExtraMediaCatalogSnapshotIsSchedulerNeutral(t *testing.T) {
	updates := map[string]any{mediaworkbench.CatalogKey: map[string]any{"models": []string{"image-model"}}}
	require.True(t, isSchedulerNeutralExtraKey(mediaworkbench.CatalogKey))
	require.False(t, shouldEnqueueSchedulerOutboxForExtraUpdates(updates))
	require.False(t, isSchedulerNeutralExtraKey(mediaworkbench.CatalogKey+"_routing"), "only the exact discovery key is neutral")
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { mock.ExpectClose(); require.NoError(t, db.Close()) })
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	repo := newAccountRepositoryWithSQL(client, db, nil)
	// Only persist JSONB. Any transaction/outbox insertion fails the mock and the
	// call; without an outbox event the scheduler worker cannot rebuild buckets.
	mock.ExpectExec(`UPDATE accounts SET extra = COALESCE\(extra, '\{\}'::jsonb\) \|\| \$1::jsonb, updated_at = NOW\(\) WHERE id = \$2 AND deleted_at IS NULL`).
		WithArgs(`{"upstream_model_catalog_snapshot":{"models":["image-model"]}}`, int64(7)).WillReturnResult(sqlmock.NewResult(0, 1))
	require.NoError(t, repo.UpdateExtra(context.Background(), 7, updates))
	require.NoError(t, mock.ExpectationsWereMet())
	// Neutral metadata must not mask a real routing change in the same update.
	updates["openai_compact_supported"] = true
	require.True(t, shouldEnqueueSchedulerOutboxForExtraUpdates(updates))
}

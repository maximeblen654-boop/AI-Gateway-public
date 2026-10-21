package repository

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"testing"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestListStudioModelCatalogSyncAccountIDsLimitsCandidates(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	r := newAccountRepositoryWithSQL(nil, db, nil)
	// Assert the narrow ID query, not a native Account scan followed by filtering.
	pattern := `(?s)SELECT id FROM accounts.*` + regexp.QuoteMeta("WHERE deleted_at IS NULL AND parent_account_id IS NULL") + `.*` + regexp.QuoteMeta("AND platform = 'openai' AND type = 'apikey'") + `.*` + regexp.QuoteMeta("AND length(BTRIM(COALESCE(credentials ->> 'api_key', ''))) > 0") + `.*` + regexp.QuoteMeta("AND LOWER(BTRIM(credentials ->> 'base_url')) IN (") + `.*` + regexp.QuoteMeta("'https://api.image2pro.top/v1'") + `.*` + regexp.QuoteMeta("jsonb_typeof(extra #> '{media_workbench_v1,media_types}') = 'array'") + `.*` + regexp.QuoteMeta("WHERE configured_media.media_type IN ('image', 'video')") + `.*` + regexp.QuoteMeta("OR EXISTS (SELECT 1 FROM jsonb_array_elements(") + `.*` + regexp.QuoteMeta("jsonb_typeof(extra #> '{media_workbench_v1,draft,products}') = 'array'") + `.*` + regexp.QuoteMeta("WHERE p ->> 'media_type' IN ('image', 'video')") + `.*` + regexp.QuoteMeta("jsonb_typeof(extra #> '{media_workbench_v1,published,products}') = 'array'") + `.*ORDER BY id`
	mock.ExpectQuery(pattern).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(7)).AddRow(int64(77)))
	ids, err := r.ListStudioModelCatalogSyncAccountIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []int64{7, 77}, ids)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestUpdateStudioModelCatalogSnapshotUsesIdentityAndPreviousCatalogCAS(t *testing.T) {
	for _, tc := range []struct {
		name     string
		affected int64
		old      any
		wantErr  error
	}{
		{"first observation", 1, nil, nil},
		{"replace prior catalog", 1, map[string]any{"models": []string{"removed-model"}}, nil},
		{"rotated credential or newer snapshot rejects old response", 0, map[string]any{"models": []string{"old-model"}}, service.ErrStudioModelCatalogIdentityChanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			t.Cleanup(func() { _ = db.Close() })
			client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
			r := newAccountRepositoryWithSQL(client, db, nil)
			proxyID := int64(9)
			a := &service.Account{ID: 77, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1"}, ProxyID: &proxyID, Extra: map[string]any{mediaworkbench.CatalogKey: tc.old}}
			catalog := &mediaworkbench.Catalog{Source: "upstream", SyncedAt: "2026-10-21T00:00:00Z", Models: []string{"replacement-only"}, AccountIdentitySHA256: "sha256-fixture"}
			payload, err := json.Marshal(map[string]any{mediaworkbench.CatalogKey: catalog})
			require.NoError(t, err)
			old, err := json.Marshal(tc.old)
			require.NoError(t, err)
			require.NotContains(t, string(payload), "fixture-key")
			pattern := `(?s)UPDATE accounts.*` + regexp.QuoteMeta("SET extra = COALESCE(extra, '{}'::jsonb) || $1::jsonb, updated_at = NOW()") + `.*` + regexp.QuoteMeta("WHERE id = $2 AND platform = $3 AND type = $4") + `.*` + regexp.QuoteMeta("AND credentials = $5::jsonb") + `.*` + regexp.QuoteMeta("AND proxy_id IS NOT DISTINCT FROM $6") + `.*` + regexp.QuoteMeta("AND COALESCE(extra -> 'upstream_model_catalog_snapshot', 'null'::jsonb) = $7::jsonb") + `.*` + regexp.QuoteMeta("AND parent_account_id IS NULL AND deleted_at IS NULL")
			mock.ExpectExec(pattern).WithArgs(string(payload), int64(77), service.PlatformOpenAI, service.AccountTypeAPIKey, `{"api_key":"fixture-key","base_url":"https://api.image2pro.top/v1"}`, proxyID, string(old)).WillReturnResult(sqlmock.NewResult(0, tc.affected))
			err = r.UpdateStudioModelCatalogSnapshot(context.Background(), a, catalog)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
			} else {
				require.NoError(t, err)
			}
			require.NoError(t, mock.ExpectationsWereMet(), "catalog writes must not enqueue a scheduler outbox event or touch other fields")
		})
	}
}

func TestUpdateStudioModelCatalogSnapshotUsesCallerTransaction(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	mock.ExpectBegin()
	tx, err := client.Tx(context.Background())
	require.NoError(t, err)
	mock.ExpectExec(`(?s)UPDATE accounts.*AND credentials = \$5::jsonb.*AND proxy_id IS NOT DISTINCT FROM \$6`).
		WithArgs(sqlmock.AnyArg(), int64(7), service.PlatformOpenAI, service.AccountTypeAPIKey, `{"api_key":"fixture"}`, nil, "null").WillReturnResult(sqlmock.NewResult(0, 1))
	r := newAccountRepositoryWithSQL(client, &recordingSQLExecutor{err: errors.New("must use context transaction")}, nil)
	a := &service.Account{ID: 7, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture"}}
	require.NoError(t, r.UpdateStudioModelCatalogSnapshot(dbent.NewTxContext(context.Background(), tx), a, &mediaworkbench.Catalog{Models: []string{"model"}}))
	mock.ExpectRollback()
	require.NoError(t, tx.Rollback())
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestUpdateStudioModelCatalogSnapshotRejectsNilInputs(t *testing.T) {
	r := newAccountRepositoryWithSQL(nil, nil, nil)
	require.ErrorIs(t, r.UpdateStudioModelCatalogSnapshot(context.Background(), nil, &mediaworkbench.Catalog{}), service.ErrAccountNilInput)
	require.ErrorIs(t, r.UpdateStudioModelCatalogSnapshot(context.Background(), &service.Account{}, nil), service.ErrAccountNilInput)
}

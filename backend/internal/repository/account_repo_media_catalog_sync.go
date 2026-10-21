package repository

import (
	"context"
	"encoding/json"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// This query returns IDs only. Uninitialized native API Accounts without media
// products and unreviewed suppliers are never loaded or contacted by the loop.
const studioModelCatalogSyncAccountIDsSQL = `
SELECT id FROM accounts
WHERE deleted_at IS NULL AND parent_account_id IS NULL
 AND platform = 'openai' AND type = 'apikey'
 AND length(BTRIM(COALESCE(credentials ->> 'api_key', ''))) > 0
 AND LOWER(BTRIM(credentials ->> 'base_url')) IN (
 'https://api.image2pro.top', 'https://api.image2pro.top/',
 'https://api.image2pro.top/v1', 'https://api.image2pro.top/v1/',
 'https://api.image2pro.top:443', 'https://api.image2pro.top:443/',
 'https://api.image2pro.top:443/v1', 'https://api.image2pro.top:443/v1/')
 AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(
 CASE WHEN jsonb_typeof(extra #> '{media_workbench_v1,media_types}') = 'array'
 THEN extra #> '{media_workbench_v1,media_types}' ELSE '[]'::jsonb END) AS configured_media(media_type)
 WHERE configured_media.media_type IN ('image', 'video'))
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(
 CASE WHEN jsonb_typeof(extra #> '{media_workbench_v1,draft,products}') = 'array'
 THEN extra #> '{media_workbench_v1,draft,products}' ELSE '[]'::jsonb END) p
 WHERE p ->> 'media_type' IN ('image', 'video'))
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(
 CASE WHEN jsonb_typeof(extra #> '{media_workbench_v1,published,products}') = 'array'
 THEN extra #> '{media_workbench_v1,published,products}' ELSE '[]'::jsonb END) p
 WHERE p ->> 'media_type' IN ('image', 'video')))
ORDER BY id`

func (r *accountRepository) ListStudioModelCatalogSyncAccountIDs(ctx context.Context) ([]int64, error) {
	rows, err := r.sql.QueryContext(ctx, studioModelCatalogSyncAccountIDsSQL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// UpdateStudioModelCatalogSnapshot changes only the observation key. The exact
// request identity and previous catalog are compared atomically so a rotated
// credential or a newer manual/background sync cannot be overwritten.
func (r *accountRepository) UpdateStudioModelCatalogSnapshot(ctx context.Context, account *service.Account, catalog *mediaworkbench.Catalog) error {
	if account == nil || catalog == nil {
		return service.ErrAccountNilInput
	}
	payload, err := json.Marshal(map[string]any{mediaworkbench.CatalogKey: catalog})
	if err != nil {
		return err
	}
	credentials, err := json.Marshal(account.Credentials)
	if err != nil {
		return err
	}
	expected, err := json.Marshal(account.Extra[mediaworkbench.CatalogKey])
	if err != nil {
		return err
	}
	var proxyID any
	if account.ProxyID != nil {
		proxyID = *account.ProxyID
	}
	client := clientFromContext(ctx, r.client)
	result, err := client.ExecContext(ctx, `
UPDATE accounts
SET extra = COALESCE(extra, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
WHERE id = $2 AND platform = $3 AND type = $4
 AND credentials = $5::jsonb
 AND proxy_id IS NOT DISTINCT FROM $6
 AND COALESCE(extra -> 'upstream_model_catalog_snapshot', 'null'::jsonb) = $7::jsonb
 AND parent_account_id IS NULL AND deleted_at IS NULL
`, string(payload), account.ID, account.Platform, account.Type, string(credentials), proxyID, string(expected))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return service.ErrStudioModelCatalogIdentityChanged
	}
	// Observation metadata does not enqueue routing/bucket rebuilds.
	if dbent.TxFromContext(ctx) == nil {
		r.syncSchedulerAccountSnapshot(ctx, account.ID)
	}
	return nil
}

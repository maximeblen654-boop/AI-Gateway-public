package repository

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

type mediaConfigRepository struct{ db *sql.DB }

func NewMediaConfigRepository(db *sql.DB) mediaworkbench.Repository {
	return &mediaConfigRepository{db: db}
}

const mediaAccountProjection = `SELECT id, name, platform, type, status, schedulable,
 COALESCE(credentials->>'base_url', ''),
 extra->'upstream_model_catalog_snapshot', extra->'media_workbench_v1',
 jsonb_build_object('model_mapping', credentials->'model_mapping',
 'has_key', length(COALESCE(credentials->>'api_key',''))>0,
 'expires_at', expires_at, 'auto_pause_on_expired', auto_pause_on_expired,
 'rate_limit_reset_at', rate_limit_reset_at, 'overload_until', overload_until,
 'temp_unschedulable_until', temp_unschedulable_until, 'parent_account_id', parent_account_id,
 'proxy_id', proxy_id,
 'quota', (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb)
 FROM jsonb_each(COALESCE(extra,'{}'::jsonb)) WHERE key LIKE 'quota\_%' ESCAPE '\'))
 FROM accounts `

func scanMediaAccount(rows *sql.Rows) (*mediaworkbench.Account, error) {
	a := new(mediaworkbench.Account)
	var catalog, config, routing []byte
	if err := rows.Scan(&a.ID, &a.Name, &a.Platform, &a.Type, &a.Status, &a.Schedulable, &a.BaseURL, &catalog, &config, &routing); err != nil {
		return nil, err
	}
	if len(catalog) > 0 && string(catalog) != "null" {
		// Allowlist projection strips optional upstream metadata and any unexpected
		// fields instead of returning Account.extra or supplier response bodies.
		if err := json.Unmarshal(catalog, &a.Catalog); err != nil {
			return nil, fmt.Errorf("invalid model snapshot")
		}
	}
	if len(config) > 0 && string(config) != "null" {
		decoder := json.NewDecoder(bytes.NewReader(config))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&a.Config); err != nil {
			return nil, fmt.Errorf("unsupported media configuration schema")
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return nil, fmt.Errorf("invalid media configuration")
		}
		if a.Config == nil || a.Config.SchemaVersion != 1 || a.Config.RecordVersion < 1 {
			return nil, fmt.Errorf("unsupported media configuration version")
		}
	}
	var local struct {
		Mapping   map[string]any `json:"model_mapping"`
		HasKey    bool           `json:"has_key"`
		ExpiresAt *time.Time     `json:"expires_at"`
		AutoPause bool           `json:"auto_pause_on_expired"`
		RateLimit *time.Time     `json:"rate_limit_reset_at"`
		Overload  *time.Time     `json:"overload_until"`
		Temporary *time.Time     `json:"temp_unschedulable_until"`
		Parent    *int64         `json:"parent_account_id"`
		Proxy     *int64         `json:"proxy_id"`
		Quota     map[string]any `json:"quota"`
	}
	if err := json.Unmarshal(routing, &local); err != nil {
		return nil, fmt.Errorf("invalid local Account routing projection")
	}
	account := service.Account{ID: a.ID, Platform: a.Platform, Type: a.Type, Status: a.Status, Schedulable: a.Schedulable, Credentials: map[string]any{"model_mapping": local.Mapping}, Extra: local.Quota, ExpiresAt: local.ExpiresAt, AutoPauseOnExpired: local.AutoPause, RateLimitResetAt: local.RateLimit, OverloadUntil: local.Overload, TempUnschedulableUntil: local.Temporary}
	a.ModelMapping = account.GetModelMapping()
	a.ResolvedModels = map[string]string{}
	if a.Config != nil {
		products := append([]mediaworkbench.Product(nil), a.Config.Draft.Products...)
		if a.Config.Published != nil {
			products = append(products, a.Config.Published.Products...)
		}
		for _, p := range products {
			if !account.IsModelSupported(p.SiteModel) {
				a.ResolvedModels[p.SiteModel] = ""
			} else {
				a.ResolvedModels[p.SiteModel] = account.GetMappedModel(p.SiteModel)
			}
		}
	}
	// A shadow Account has no independent credential owner in this phase.
	// Reuse the native cooldown/expiry/quota gate without exposing its inputs.
	a.RuntimeReady = local.HasKey && local.Parent == nil && account.IsSchedulable() && mediaworkbench.ValidateRouting(a)
	routeBytes, _ := json.Marshal(struct{ Parent, Proxy *int64 }{local.Parent, local.Proxy})
	a.RoutingFingerprint = string(routeBytes)
	return a, nil
}

// Account edits, model sync and media CAS all contend on the same row lock.
// Dependency equality and the subsequent update are one transaction; the
// compiler itself remains outside the lock and never performs network I/O.
func (r *mediaConfigRepository) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps mediaworkbench.Dependencies, c *mediaworkbench.Config) (err error) {
	if c == nil || c.RecordVersion != expected+1 || c.SchemaVersion != 1 || expected < 1 || expected >= 9007199254740991 {
		return mediaworkbench.ErrInvalid
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	rows, err := tx.QueryContext(ctx, mediaAccountProjection+`WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id)
	if err != nil {
		return err
	}
	if !rows.Next() {
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return err
		}
		return mediaworkbench.ErrNotFound
	}
	current, readErr := scanMediaAccount(rows)
	if err = rows.Close(); err != nil {
		return err
	}
	if readErr != nil {
		return readErr
	}
	if current.Config == nil || current.Config.RecordVersion != expected || mediaworkbench.DependenciesFor(current) != deps {
		return mediaworkbench.ErrStale
	}
	if c.Sales.Enabled && !c.Sales.UpdatedAt.Equal(current.Config.Sales.UpdatedAt) && !current.RuntimeReady {
		return mediaworkbench.ErrSales
	}
	body, err := json.Marshal(c)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, mediaConfigCAS, string(body), id, expected)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return mediaworkbench.ErrStale
	}
	return tx.Commit()
}
func (r *mediaConfigRepository) Get(ctx context.Context, id int64) (_ *mediaworkbench.Account, err error) {
	rows, err := r.db.QueryContext(ctx, mediaAccountProjection+`WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return nil, mediaworkbench.ErrNotFound
	}
	return scanMediaAccount(rows)
}
func (r *mediaConfigRepository) List(ctx context.Context) (_ []mediaworkbench.Account, err error) {
	rows, err := r.db.QueryContext(ctx, mediaAccountProjection+`WHERE deleted_at IS NULL AND type='apikey' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	out := []mediaworkbench.Account{}
	for rows.Next() {
		a, err := scanMediaAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

const mediaConfigCAS = `UPDATE accounts SET extra=jsonb_set(COALESCE(extra, '{}'::jsonb),
 '{media_workbench_v1}', $1::jsonb, true), updated_at=NOW()
 WHERE id=$2 AND deleted_at IS NULL AND type='apikey'
 AND (($3::bigint=0 AND (extra->'media_workbench_v1' IS NULL OR extra->'media_workbench_v1'='null'::jsonb))
 OR ($3::bigint>0 AND extra->'media_workbench_v1'->>'schema_version'='1'
 AND extra->'media_workbench_v1'->>'record_version'=$3::text))`

func (r *mediaConfigRepository) CompareAndSwap(ctx context.Context, id, expected int64, c *mediaworkbench.Config) error {
	if c == nil || expected < 0 || expected >= 9007199254740991 || c.RecordVersion != expected+1 || c.SchemaVersion != 1 {
		return mediaworkbench.ErrInvalid
	}
	body, err := json.Marshal(c)
	if err != nil {
		return err
	}
	result, err := r.db.ExecContext(ctx, mediaConfigCAS, string(body), id, expected)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}
	a, err := r.Get(ctx, id)
	if err != nil {
		return err
	}
	if a.Type != "apikey" {
		return mediaworkbench.ErrUnsupported
	}
	return mediaworkbench.ErrStale
}

// Generic Account APIs cannot seed, replace or erase the CAS-owned document.
func stripMediaConfigExtra(extra map[string]any) map[string]any {
	if _, ok := extra["media_workbench_v1"]; !ok {
		return extra
	}
	out := make(map[string]any, len(extra))
	for k, v := range extra {
		if k != "media_workbench_v1" {
			out[k] = v
		}
	}
	return out
}

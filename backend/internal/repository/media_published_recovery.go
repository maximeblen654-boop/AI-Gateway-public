package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// PublishedRecoveryPlan is a one-off Account 77 maintenance contract, not an API.
// The pinned row includes credentials in its hash, never in its output or backup.
type PublishedRecoveryPlan struct {
	AccountID       int64                     `json:"account_id"`
	AccountSHA      string                    `json:"account_sha256"`
	BeforeConfigSHA string                    `json:"before_config_sha256"`
	AfterConfigSHA  string                    `json:"after_config_sha256"`
	ReplacementSHA  string                    `json:"replacement_sha256"`
	BeforeRevision  string                    `json:"before_published_revision"`
	RecordVersion   int64                     `json:"record_version"`
	Specs           int                       `json:"specs_checked"`
	At              time.Time                 `json:"at"`
	Replacement     *mediaworkbench.Published `json:"replacement"`
	Applied         bool                      `json:"applied"`
}

func recoverySHA(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }

// RecoverAccount77Published locks the Account against sync/save, reuses native
// validation on original Published products, and writes only Published + the CAS
// record version. A durable backup callback is mandatory before apply. Dry run
// always rolls back. No scheduler, billing, paid control, or upstream is called.
func RecoverAccount77Published(ctx context.Context, db interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}, at time.Time, expected *PublishedRecoveryPlan, backup func([]byte) error) (*PublishedRecoveryPlan, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'"); err != nil {
		return nil, err
	}
	var row, config []byte
	err = tx.QueryRowContext(ctx, `SELECT to_jsonb(a)::text, (extra->'media_workbench_v1')::text FROM accounts a WHERE id=77 AND deleted_at IS NULL FOR UPDATE`).Scan(&row, &config)
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, mediaAccountProjection+`WHERE id=77 AND deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		rows.Close()
		return nil, mediaworkbench.ErrNotFound
	}
	a, err := scanMediaAccount(rows)
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	replacement, inspection, err := mediaworkbench.RevalidatePublishedCatalog(ctx, a, at)
	if err != nil {
		return nil, err
	}
	if inspection.SpecCount != 1870 {
		return nil, mediaworkbench.ErrValidation
	}
	body, err := json.Marshal(replacement)
	if err != nil {
		return nil, err
	}
	// Have PostgreSQL canonicalize both plan and eventual persisted JSON identically.
	var after []byte
	err = tx.QueryRowContext(ctx, `SELECT jsonb_set(jsonb_set($1::jsonb,'{published}',$2::jsonb),'{record_version}',to_jsonb($3::bigint))::text`, string(config), string(body), a.Config.RecordVersion+1).Scan(&after)
	if err != nil {
		return nil, err
	}
	plan := &PublishedRecoveryPlan{AccountID: 77, AccountSHA: recoverySHA(row), BeforeConfigSHA: recoverySHA(config), AfterConfigSHA: recoverySHA(after), ReplacementSHA: recoverySHA(body), BeforeRevision: a.Config.Published.Revision, RecordVersion: a.Config.RecordVersion, Specs: inspection.SpecCount, At: at, Replacement: replacement}
	if expected == nil {
		return plan, nil
	}
	if expected.AccountID != 77 || expected.AccountSHA != plan.AccountSHA || expected.BeforeConfigSHA != plan.BeforeConfigSHA || expected.AfterConfigSHA != plan.AfterConfigSHA || expected.ReplacementSHA != plan.ReplacementSHA || expected.BeforeRevision != plan.BeforeRevision || expected.RecordVersion != plan.RecordVersion || !expected.At.Equal(at) || backup == nil {
		return nil, mediaworkbench.ErrStale
	}
	saved, err := json.Marshal(struct {
		Plan           *PublishedRecoveryPlan `json:"plan"`
		OriginalConfig json.RawMessage        `json:"original_config"`
	}{plan, config})
	if err != nil {
		return nil, err
	}
	if err = backup(saved); err != nil {
		return nil, err
	}
	// Recheck under the same lock immediately before mutation; no stale plan apply.
	var again []byte
	if err = tx.QueryRowContext(ctx, `SELECT to_jsonb(a)::text FROM accounts a WHERE id=77`).Scan(&again); err != nil {
		return nil, err
	}
	if recoverySHA(again) != plan.AccountSHA {
		return nil, mediaworkbench.ErrStale
	}
	result, err := tx.ExecContext(ctx, `UPDATE accounts SET extra=jsonb_set(jsonb_set(extra,'{media_workbench_v1,published}',$1::jsonb),'{media_workbench_v1,record_version}',to_jsonb($2::bigint)) WHERE id=77 AND extra->'media_workbench_v1'=$3::jsonb`, string(body), a.Config.RecordVersion+1, string(config))
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, mediaworkbench.ErrStale
	}
	var persisted []byte
	if err = tx.QueryRowContext(ctx, `SELECT (extra->'media_workbench_v1')::text FROM accounts WHERE id=77`).Scan(&persisted); err != nil {
		return nil, err
	}
	if recoverySHA(persisted) != plan.AfterConfigSHA {
		return nil, mediaworkbench.ErrStale
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	plan.Applied = true
	return plan, nil
}

package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type studioVideoOrderRepository struct{ db *sql.DB }

func NewStudioVideoOrderRepository(db *sql.DB) service.StudioVideoOrderRepository {
	return &studioVideoOrderRepository{db: db}
}

const studioVideoOrderColumns = `child_id, user_id, api_key_id, group_id, quote_id, capability_version, request_hash,
	hold_fingerprint, hold_amount, currency, state, actual_amount, final_fingerprint,
	supplier_task_id, release_reason, hold_balance, hold_frozen_balance, final_balance,
	final_frozen_balance, created_at, updated_at, finalized_at`

func scanStudioVideoOrder(row *sql.Row) (*service.StudioVideoOrder, error) {
	var o service.StudioVideoOrder
	var actual, finalBalance, finalFrozen sql.NullFloat64
	var finalFingerprint, supplierTaskID, releaseReason sql.NullString
	var finalized sql.NullTime
	err := row.Scan(&o.ChildID, &o.UserID, &o.APIKeyID, &o.GroupID, &o.QuoteID, &o.CapabilityVersion,
		&o.RequestHash, &o.HoldFingerprint, &o.HoldAmount, &o.Currency, &o.State, &actual,
		&finalFingerprint, &supplierTaskID, &releaseReason, &o.HoldBalance, &o.HoldFrozenBalance,
		&finalBalance, &finalFrozen, &o.CreatedAt, &o.UpdatedAt, &finalized)
	if err != nil {
		return nil, err
	}
	if actual.Valid {
		o.ActualAmount = &actual.Float64
	}
	if finalBalance.Valid {
		o.FinalBalance = &finalBalance.Float64
	}
	if finalFrozen.Valid {
		o.FinalFrozenBalance = &finalFrozen.Float64
	}
	o.FinalFingerprint, o.SupplierTaskID, o.ReleaseReason = finalFingerprint.String, supplierTaskID.String, releaseReason.String
	if finalized.Valid {
		o.FinalizedAt = &finalized.Time
	}
	return &o, nil
}

func (r *studioVideoOrderRepository) GetStudioVideoOrder(ctx context.Context, userID int64, childID string) (*service.StudioVideoOrder, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("studio video order db is nil")
	}
	o, err := scanStudioVideoOrder(r.db.QueryRowContext(ctx, `SELECT `+studioVideoOrderColumns+` FROM studio_video_orders WHERE child_id=$1 AND user_id=$2`, childID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrStudioVideoNotFound
	}
	return o, err
}

func (r *studioVideoOrderRepository) ReserveStudioVideoOrder(ctx context.Context, c *service.StudioVideoReserveCommand) (_ *service.StudioVideoOrder, err error) {
	if r == nil || r.db == nil {
		return nil, errors.New("studio video order db is nil")
	}
	if c == nil {
		return nil, service.ErrStudioVideoInvalidOrder
	}
	if err := service.ValidateVideoBindingChild(c.ChildID, c.Binding); err != nil {
		return nil, err
	}
	if c.Binding != nil && (c.UserID != c.Binding.Owner.UserID || c.APIKeyID != c.Binding.Owner.APIKeyID || c.GroupID != c.Binding.Owner.GroupID || c.QuoteID != c.Binding.QuoteID || c.RequestHash != c.Binding.RequestHash || c.CapabilityVersion != c.Binding.CapabilityVersion()) {
		return nil, service.ErrStudioVideoConflict
	}
	amount := service.QuantizeUsageBillingAmount(c.HoldAmount)
	if amount <= 0 {
		return nil, service.ErrStudioVideoInvalidOrder
	}
	copy := *c
	copy.HoldAmount = amount
	fingerprint := copy.Fingerprint()
	amountText := studioVideoSQLAmount(amount)
	if c.Binding != nil {
		amountText = c.Binding.Offer.SalePrice.Amount
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var inserted string
	err = tx.QueryRowContext(ctx, `INSERT INTO studio_video_orders
		(child_id,user_id,api_key_id,group_id,quote_id,capability_version,request_hash,hold_fingerprint,hold_amount,currency,state,hold_balance,hold_frozen_balance)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'USD','HELD',0,0)
		ON CONFLICT (child_id) DO NOTHING RETURNING child_id`, c.ChildID, c.UserID, c.APIKeyID,
		c.GroupID, c.QuoteID, c.CapabilityVersion, c.RequestHash, fingerprint, amountText).Scan(&inserted)
	if errors.Is(err, sql.ErrNoRows) {
		o, getErr := getStudioVideoOrderTx(ctx, tx, c.UserID, c.ChildID, false)
		if getErr != nil {
			return nil, getErr
		}
		if o.HoldFingerprint != fingerprint {
			return nil, service.ErrStudioVideoConflict
		}
		return o, nil
	}
	if err != nil {
		return nil, err
	}
	var balance, frozen string
	err = tx.QueryRowContext(ctx, `UPDATE users SET balance=balance-$1, frozen_balance=COALESCE(frozen_balance,0)+$1, updated_at=NOW()
		WHERE id=$2 AND deleted_at IS NULL AND balance >= $1 RETURNING balance,frozen_balance`, amountText, c.UserID).Scan(&balance, &frozen)
	if errors.Is(err, sql.ErrNoRows) {
		if exists, e := userExistsForBilling(ctx, tx, c.UserID); e != nil {
			return nil, e
		} else if !exists {
			return nil, service.ErrUserNotFound
		}
		return nil, service.ErrStudioVideoInsufficientBalance
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE studio_video_orders SET hold_balance=$2, hold_frozen_balance=$3 WHERE child_id=$1`, c.ChildID, balance, frozen); err != nil {
		return nil, err
	}
	o, err := getStudioVideoOrderTx(ctx, tx, c.UserID, c.ChildID, false)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return o, nil
}

func (r *studioVideoOrderRepository) CaptureStudioVideoOrder(ctx context.Context, c *service.StudioVideoCaptureCommand) (*service.StudioVideoOrder, error) {
	if c == nil {
		return nil, service.ErrStudioVideoInvalidOrder
	}
	copy := *c
	copy.ActualAmount = service.QuantizeUsageBillingAmount(copy.ActualAmount)
	return r.finalizeStudioVideoOrder(ctx, copy.UserID, copy.ChildID, service.StudioVideoCaptured, copy.Fingerprint(), copy.ActualAmount, copy.SupplierTaskID, "", copy.Binding, copy.ResultHash)
}

func (r *studioVideoOrderRepository) ReleaseStudioVideoOrder(ctx context.Context, c *service.StudioVideoReleaseCommand) (*service.StudioVideoOrder, error) {
	if c == nil {
		return nil, service.ErrStudioVideoInvalidOrder
	}
	return r.finalizeStudioVideoOrder(ctx, c.UserID, c.ChildID, service.StudioVideoReleased, c.Fingerprint(), 0, "", c.Reason, c.Binding, "")
}

func (r *studioVideoOrderRepository) finalizeStudioVideoOrder(ctx context.Context, userID int64, childID, terminal, fingerprint string, actual float64, supplierTaskID, reason string, binding *service.StudioVideoBinding, resultHash string) (*service.StudioVideoOrder, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("studio video order db is nil")
	}
	if err := service.ValidateVideoBindingChild(childID, binding); err != nil {
		return nil, err
	}
	if binding != nil && (binding.Owner.UserID != userID || (terminal == service.StudioVideoCaptured && (len(resultHash) != 64 || supplierTaskID == ""))) {
		return nil, service.ErrStudioVideoInvalidOrder
	}
	actualText := studioVideoSQLAmount(actual)
	if binding != nil && terminal == service.StudioVideoCaptured {
		actualText = binding.Offer.SalePrice.Amount
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	o, err := getStudioVideoOrderTx(ctx, tx, userID, childID, true)
	if err != nil {
		return nil, err
	}
	if binding != nil {
		expected := &service.StudioVideoReserveCommand{ChildID: childID, Binding: binding}
		if o.UserID != binding.Owner.UserID || o.APIKeyID != binding.Owner.APIKeyID || o.GroupID != binding.Owner.GroupID || o.QuoteID != binding.QuoteID || o.CapabilityVersion != binding.CapabilityVersion() || o.RequestHash != binding.RequestHash || o.HoldFingerprint != expected.Fingerprint() {
			return nil, service.ErrStudioVideoConflict
		}
	}
	if o.State != service.StudioVideoHeld {
		if o.State == terminal && o.FinalFingerprint == fingerprint {
			return o, nil
		}
		if o.State == terminal {
			return nil, service.ErrStudioVideoConflict
		}
		return nil, service.ErrStudioVideoTerminalConflict
	}
	// Read NUMERIC as text for arithmetic: float64 receipts cannot preserve every
	// cent of a large NUMERIC(20,8) balance or hold.
	var holdAmount string
	var withinHold bool
	if err := tx.QueryRowContext(ctx, `SELECT hold_amount::text, hold_amount >= $3
		FROM studio_video_orders WHERE child_id=$1 AND user_id=$2`, childID, userID, actualText).Scan(&holdAmount, &withinHold); err != nil {
		return nil, err
	}
	if terminal == service.StudioVideoCaptured && !withinHold {
		return nil, service.ErrStudioVideoSettlementExceedsHold
	}
	var balance, frozen string
	if terminal == service.StudioVideoCaptured {
		err = tx.QueryRowContext(ctx, `UPDATE users SET balance=balance+$1-$2, frozen_balance=COALESCE(frozen_balance,0)-$1, updated_at=NOW()
			WHERE id=$3 AND COALESCE(frozen_balance,0)>=$1 RETURNING balance,frozen_balance`, holdAmount, actualText, userID).Scan(&balance, &frozen)
	} else {
		err = tx.QueryRowContext(ctx, `UPDATE users SET balance=balance+$1, frozen_balance=COALESCE(frozen_balance,0)-$1, updated_at=NOW()
			WHERE id=$2 AND COALESCE(frozen_balance,0)>=$1 RETURNING balance,frozen_balance`, holdAmount, userID).Scan(&balance, &frozen)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrStudioVideoFrozenBalance
	}
	if err != nil {
		return nil, err
	}
	if binding != nil && terminal == service.StudioVideoCaptured {
		cmd, e := service.VideoAccountBillingCommand(childID, binding, fingerprint)
		if e != nil {
			return nil, e
		}
		native := &usageBillingRepository{db: r.db}
		claimed, e := native.claimUsageBillingKey(ctx, tx, cmd)
		if e != nil {
			return nil, e
		}
		// A committed dedup with a HELD order is inconsistent: never silently capture.
		if !claimed {
			return nil, service.ErrStudioVideoConflict
		}
		if e = native.applyUsageBillingEffects(ctx, tx, cmd, &service.UsageBillingApplyResult{}); e != nil {
			return nil, e
		}
		if e = insertVideoAccountUsage(ctx, tx, childID, supplierTaskID, binding); e != nil {
			return nil, e
		}
	}
	var actualArg any
	if terminal == service.StudioVideoCaptured {
		actualArg = actualText
	}
	var taskArg, reasonArg any
	if supplierTaskID != "" {
		taskArg = supplierTaskID
	}
	if reason != "" {
		reasonArg = reason
	}
	res, err := tx.ExecContext(ctx, `UPDATE studio_video_orders SET state=$3, actual_amount=$4, final_fingerprint=$5,
		supplier_task_id=$6, release_reason=$7, final_balance=$8, final_frozen_balance=$9,
		finalized_at=NOW(),updated_at=NOW() WHERE child_id=$1 AND user_id=$2 AND state='HELD'`,
		childID, userID, terminal, actualArg, fingerprint, taskArg, reasonArg, balance, frozen)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, service.ErrStudioVideoTerminalConflict
	}
	o, err = getStudioVideoOrderTx(ctx, tx, userID, childID, false)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return o, nil
}

func getStudioVideoOrderTx(ctx context.Context, tx *sql.Tx, userID int64, childID string, lock bool) (*service.StudioVideoOrder, error) {
	query := `SELECT ` + studioVideoOrderColumns + ` FROM studio_video_orders WHERE child_id=$1 AND user_id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	o, err := scanStudioVideoOrder(tx.QueryRowContext(ctx, query, childID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrStudioVideoNotFound
	}
	return o, err
}

func studioVideoSQLAmount(v float64) string {
	return fmt.Sprintf("%.8f", service.QuantizeUsageBillingAmount(v))
}

func insertVideoAccountUsage(ctx context.Context, tx *sql.Tx, childID, upstreamID string, b *service.StudioVideoBinding) error {
	log := service.VideoAccountUsage(childID, upstreamID, b)
	prepared := prepareUsageLogInsert(log)
	prepared.args[25] = b.Offer.SalePrice.Amount
	prepared.args[26] = b.Offer.SalePrice.Amount
	prepared.args[27] = "1"
	prepared.args[28] = b.Accounting.AccountRateMultiplier
	prepared.args[57] = b.Accounting.BaseAmount
	repo := newUsageLogRepositoryWithSQL(nil, tx)
	inserted, err := repo.createSinglePrepared(ctx, tx, log, prepared)
	if err == nil && !inserted {
		return service.ErrStudioVideoConflict
	}
	return err
}

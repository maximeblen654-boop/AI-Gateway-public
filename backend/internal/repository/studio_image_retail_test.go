package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func retailImageBillingFixture(t *testing.T, count, delivered int) *service.StudioImageReceipt {
	t.Helper()
	r := quotedBillingFixture(t, 1, 2, 7, 3)
	q := &r.Quote
	q.AccountQuotaEnabled = false
	q.Binding.Offer.ProductID = "retail"
	q.Binding.Offer.CostVersion = mediaworkbench.MediaRetailVersion
	q.Binding.PublishedRevision = "frozen-publication"
	q.Binding.Spec.Count, q.Quantity = count, count
	q.Binding.Offer.SalePrice.Amount = "0.025"
	unit, total, err := mediaworkbench.PriceForQuantity(q.Binding.Offer.SalePrice, count)
	require.NoError(t, err)
	q.UnitPrice, q.TotalPrice = &unit, &total
	source := fmt.Sprintf("account:%d/product:%s/published:%s", q.Binding.Offer.AccountID, q.Binding.Offer.ProductID, q.Binding.PublishedRevision)
	data, err := json.Marshal([]string{source, q.Binding.SpecHash})
	require.NoError(t, err)
	q.Accounting = service.AccountAccountingSnapshot{Version: service.StudioImageAccountingVersion, SourceState: "unknown", SourceType: service.StudioImageRetailUsageMode, SourceID: source, SourceHash: service.HashUsageRequestPayload(data), AccountID: q.Binding.Offer.AccountID, UpstreamModel: q.Binding.Offer.UpstreamModel, SpecHash: q.Binding.SpecHash, RequestCount: count, PricingAt: q.CreatedAt, Unit: "CNY", AccountRateMultiplier: "2"}
	if count > 1 {
		r.Version = service.StudioImageMultiReceiptVersion
		r.ExpectedCount, r.DeliveredCount, r.FailedCount = count, delivered, count-delivered
		q.Execution = &mediaworkbench.ImageExecutionPlan{}
	}
	store := service.NewStudioImageStore(t.TempDir())
	token, err := store.Issue(*q)
	require.NoError(t, err)
	*q, err = store.Quote(token, q.Owner, q.CreatedAt)
	require.NoError(t, err)
	return r
}

func retailImageInsertArgs(t *testing.T, r *service.StudioImageReceipt, sale string) []driver.Value {
	t.Helper()
	log := service.QuotedImageUsageLog(r)
	require.Nil(t, log.AccountStatsCost, "unknown procurement must not become zero or sale")
	require.Equal(t, service.StudioImageRetailUsageMode, *log.BillingMode)
	args := make([]driver.Value, len(prepareUsageLogInsert(log).args))
	for i := range args {
		args[i] = sqlmock.AnyArg()
	}
	args[25], args[26], args[28], args[57] = sale, sale, "2", nil
	return args
}

func TestStudioImageRetailUsageInsertUnknownCostIsSQLNull(t *testing.T) {
	for _, tc := range []struct {
		name             string
		count, delivered int
		sale             string
	}{
		{"single", 1, 1, "0.025"},
		{"all_five", 5, 5, "0.125"},
		{"partial_two", 5, 2, "0.050"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := retailImageBillingFixture(t, tc.count, tc.delivered)
			sale, base, quantity, err := service.QuotedImageUsageAmounts(r)
			require.NoError(t, err)
			require.Equal(t, tc.sale, sale)
			require.Empty(t, base)
			require.Equal(t, tc.delivered, quantity)
			cmd, err := service.QuotedImageBillingCommand(r)
			require.NoError(t, err)
			require.Equal(t, tc.sale, cmd.ExactAmounts.Balance)
			require.Equal(t, tc.sale, cmd.ExactAmounts.APIKeyQuota)
			require.Equal(t, tc.sale, cmd.ExactAmounts.APIKeyRateLimit)
			require.Equal(t, "0", cmd.ExactAmounts.AccountQuota)
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer func() { _ = db.Close() }()
			mock.ExpectBegin()
			tx, err := db.Begin()
			require.NoError(t, err)
			mock.ExpectQuery("INSERT INTO usage_logs").WithArgs(retailImageInsertArgs(t, r, tc.sale)...).WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow(1, time.Now()))
			require.NoError(t, insertQuotedImageUsage(t.Context(), tx, cmd))
			mock.ExpectRollback()
			require.NoError(t, tx.Rollback())
			require.NoError(t, mock.ExpectationsWereMet())
		})
	}
}

func TestStudioImageRetailNativeTransactionExactMoneyAndDedup(t *testing.T) {
	r := retailImageBillingFixture(t, 5, 2)
	cmd, err := service.QuotedImageBillingCommand(r)
	require.NoError(t, err)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	repo := NewUsageBillingRepository(nil, db)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO usage_billing_dedup").WithArgs(cmd.RequestID, int64(2), cmd.RequestFingerprint).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectQuery("SELECT request_fingerprint").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("UPDATE users").WithArgs("0.050", int64(1)).WillReturnRows(sqlmock.NewRows([]string{"balance"}).AddRow(9.95))
	mock.ExpectQuery("UPDATE api_keys").WithArgs("0.050", int64(2), service.StatusAPIKeyActive, service.StatusAPIKeyQuotaExhausted).WillReturnRows(sqlmock.NewRows([]string{"exhausted"}).AddRow(false))
	mock.ExpectExec("UPDATE api_keys SET").WithArgs("0.050", int64(2)).WillReturnResult(sqlmock.NewResult(0, 1))
	// No UPDATE accounts: unknown procurement is not an Account quota amount.
	mock.ExpectQuery("INSERT INTO usage_logs").WithArgs(retailImageInsertArgs(t, r, "0.050")...).WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow(1, time.Now()))
	mock.ExpectCommit()
	result, err := repo.Apply(context.Background(), cmd)
	require.NoError(t, err)
	require.True(t, result.Applied)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO usage_billing_dedup").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT request_fingerprint").WillReturnRows(sqlmock.NewRows([]string{"fingerprint"}).AddRow(cmd.RequestFingerprint))
	mock.ExpectRollback()
	result, err = repo.Apply(context.Background(), cmd)
	require.NoError(t, err)
	require.False(t, result.Applied)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestStudioImageRetailUsageFailureRollsBackCustomerCharge(t *testing.T) {
	r := retailImageBillingFixture(t, 1, 1)
	cmd, err := service.QuotedImageBillingCommand(r)
	require.NoError(t, err)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	repo := NewUsageBillingRepository(nil, db)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO usage_billing_dedup").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectQuery("SELECT request_fingerprint").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("UPDATE users").WithArgs("0.025", int64(1)).WillReturnRows(sqlmock.NewRows([]string{"balance"}).AddRow(9.975))
	mock.ExpectQuery("UPDATE api_keys").WithArgs("0.025", int64(2), service.StatusAPIKeyActive, service.StatusAPIKeyQuotaExhausted).WillReturnRows(sqlmock.NewRows([]string{"exhausted"}).AddRow(false))
	mock.ExpectExec("UPDATE api_keys SET").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("INSERT INTO usage_logs").WillReturnError(fmt.Errorf("synthetic insert failure"))
	mock.ExpectRollback()
	_, err = repo.Apply(context.Background(), cmd)
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

package repository

import (
	"context"
	"database/sql"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func quotedBillingFixture(t *testing.T, user, key, account, group int64) *service.StudioImageReceipt {
	t.Helper()
	now := time.Now().UTC()
	q := service.StudioImageQuote{Owner: service.StudioImageOwner{UserID: user, APIKeyID: key, GroupID: group}, Binding: mediaworkbench.ResolvedImageOffer{Version: mediaworkbench.ImageBindingVersion, Spec: mediaworkbench.Spec{Count: 1}, SpecHash: "spec", Offer: mediaworkbench.Offer{AccountID: account, SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", SalePrice: mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}, CreatedAt: now, ExpiresAt: now.Add(time.Minute), KeyQuotaEnabled: true, KeyRateEnabled: true, AccountQuotaEnabled: true}
	q.Accounting = service.AccountAccountingSnapshot{Version: service.StudioImageAccountingVersion, SourceState: "resolved", SourceType: "explicit_account_stats_rule", SourceID: "rule:1", SourceHash: service.HashUsageRequestPayload([]byte("explicit source")), AccountID: account, UpstreamModel: "gpt-image-2", SpecHash: "spec", RequestCount: 1, PricingAt: now, BaseAmount: "0.35", Unit: "CNY", AccountRateMultiplier: "1", EffectiveAccountQuotaCost: "0.35"}
	store := service.NewStudioImageStore(t.TempDir())
	token, e := store.Issue(q)
	require.NoError(t, e)
	q, e = store.Quote(token, q.Owner, now)
	require.NoError(t, e)
	body := []byte(`{"model":"gpt-image-2","prompt":"synthetic","n":1}`)
	return &service.StudioImageReceipt{Version: mediaworkbench.ImageBindingVersion, TaskID: "original-task", Quote: q, Request: body, PayloadHash: service.HashUsageRequestPayload(body), Endpoint: "/v1/images/generations", ResultHash: service.HashUsageRequestPayload([]byte("validated durable result")), BillingState: "billing_unknown"}
}

func TestStudioQuotedNativeTransactionAndDedup(t *testing.T) {
	db, mock, e := sqlmock.New()
	require.NoError(t, e)
	defer func() { _ = db.Close() }()
	r := NewUsageBillingRepository(nil, db)
	receipt := quotedBillingFixture(t, 1, 2, 7, 3)
	cmd, e := service.QuotedImageBillingCommand(receipt)
	require.NoError(t, e)
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO usage_billing_dedup").WithArgs(cmd.RequestID, int64(2), cmd.RequestFingerprint).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	mock.ExpectQuery("SELECT request_fingerprint").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("UPDATE users").WithArgs("0.80", int64(1)).WillReturnRows(sqlmock.NewRows([]string{"balance"}).AddRow(9.2))
	mock.ExpectQuery("UPDATE api_keys").WithArgs("0.80", int64(2), service.StatusAPIKeyActive, service.StatusAPIKeyQuotaExhausted).WillReturnRows(sqlmock.NewRows([]string{"exhausted"}).AddRow(false))
	mock.ExpectExec("UPDATE api_keys SET").WithArgs("0.80", int64(2)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("UPDATE accounts SET extra").WithArgs("0.35", int64(7)).WillReturnRows(sqlmock.NewRows([]string{"used", "limit", "daily_used", "daily_limit", "weekly_used", "weekly_limit"}).AddRow(.35, 100, 0, 0, 0, 0))
	mock.ExpectQuery("INSERT INTO usage_logs").WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow(1, time.Now()))
	mock.ExpectCommit()
	result, e := r.Apply(context.Background(), cmd)
	require.NoError(t, e)
	require.True(t, result.Applied)
	// Native dedup rejects a second increment, including account quota and usage.
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO usage_billing_dedup").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT request_fingerprint").WillReturnRows(sqlmock.NewRows([]string{"fingerprint"}).AddRow(cmd.RequestFingerprint))
	mock.ExpectRollback()
	result, e = r.Apply(context.Background(), cmd)
	require.NoError(t, e)
	require.False(t, result.Applied)
	require.NoError(t, mock.ExpectationsWereMet())
	tampered := *cmd
	values := *cmd.ExactAmounts
	values.AccountQuota = "0.80"
	tampered.ExactAmounts = &values
	_, e = r.Apply(context.Background(), &tampered)
	require.ErrorIs(t, e, service.ErrUsageBillingRequestConflict)
}
func TestStudioQuotedUsageExactNumericParameters(t *testing.T) {
	receipt := quotedBillingFixture(t, 1, 2, 7, 3)
	log := service.QuotedImageUsageLog(receipt)
	require.Equal(t, .8, log.ActualCost)
	require.Equal(t, .35, *log.AccountStatsCost)
	require.Equal(t, 1.0, *log.AccountRateMultiplier)
	require.Equal(t, "mixed", *log.ImageSize)
	require.Equal(t, "input", *log.ImageSizeSource)
	// Assert native INSERT positions so schema edits cannot silently put exact
	// money in a different column. Other log fields retain the native inserter.
	require.Equal(t, "numeric", usageLogInsertArgTypes[25])
	require.Equal(t, "numeric", usageLogInsertArgTypes[26])
	require.Equal(t, "numeric", usageLogInsertArgTypes[28])
	require.Equal(t, "numeric", usageLogInsertArgTypes[57])
}

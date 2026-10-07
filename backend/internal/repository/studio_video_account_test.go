package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func videoBindingFixture(t *testing.T) *service.StudioVideoBinding {
	t.Helper()
	spec := mediaworkbench.Spec{Count: 1, DurationSeconds: 5, Resolution: "720p", AspectRatio: "16:9"}
	data, _ := json.Marshal(spec)
	h := service.HashUsageRequestPayload(data)
	at := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	b := &service.StudioVideoBinding{Version: service.StudioVideoBindingVersion, QuoteID: "quote1", Owner: service.StudioImageOwner{UserID: 1, APIKeyID: 2, GroupID: 3},
		PublishedRevision: "published-original", Spec: spec, SpecHash: h, PlanHash: h, RequestHash: h, BaseURL: "https://fixture.invalid", CredentialFingerprint: h,
		Offer: mediaworkbench.Offer{OfferID: "offer1", AccountID: 7, MediaType: "video", SiteModel: "3.0", UpstreamModel: "original-model",
			Adapter:   mediaworkbench.AdapterBinding{Kind: "laoli_video", Revision: "laoli_video_json_v136_r1", Auth: "account_apikey", TaskFlow: "async"},
			SalePrice: mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}, CreatedAt: at, ExpiresAt: at.Add(time.Minute),
		Accounting: service.AccountAccountingSnapshot{Version: service.StudioImageAccountingVersion, SourceState: "resolved", SourceType: "explicit_account_stats_rule", SourceID: "rule1", SourceHash: h,
			AccountID: 7, UpstreamModel: "original-model", SpecHash: h, RequestCount: 1, PricingAt: at, BaseAmount: "0.35", Unit: "CNY", AccountRateMultiplier: "1", EffectiveAccountQuotaCost: "0.35"}, KeyQuotaEnabled: true, AccountQuotaEnabled: true}
	require.NoError(t, b.Validate())
	return b
}

func videoOrderRows(b *service.StudioVideoBinding, state, final string) *sqlmock.Rows {
	c := &service.StudioVideoReserveCommand{ChildID: "av_original", Binding: b}
	var actual, fp, task, finalBalance, finalFrozen, finalAt any
	if state == service.StudioVideoCaptured {
		actual = .8
		fp = final
		task = "upstream1"
		finalBalance = 9.2
		finalFrozen = 0.
		finalAt = b.CreatedAt
	}
	cols := strings.Split(strings.ReplaceAll(strings.ReplaceAll(studioVideoOrderColumns, "\n", ""), "\t", ""), ",")
	return sqlmock.NewRows(cols).AddRow("av_original", int64(1), int64(2), int64(3), b.QuoteID, b.CapabilityVersion(), b.RequestHash, c.Fingerprint(), .8, "USD", state, actual, fp, task, nil, 9.2, .8, finalBalance, finalFrozen, b.CreatedAt, b.CreatedAt, finalAt)
}

func TestVideoAccountCaptureAtomicAndRecovery(t *testing.T) {
	for _, failUsage := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit_and_retry", true: "usage_failure_rolls_back_everything"}[failUsage], func(t *testing.T) {
			db, m, e := sqlmock.New()
			require.NoError(t, e)
			defer func() { _ = db.Close() }()
			r := NewStudioVideoOrderRepository(db)
			b := videoBindingFixture(t)
			c := &service.StudioVideoCaptureCommand{ChildID: "av_original", UserID: 1, ActualAmount: .8, SupplierTaskID: "upstream1", EvidenceHash: b.RequestHash, ResultHash: b.RequestHash, Binding: b}
			m.ExpectBegin()
			m.ExpectQuery("SELECT .* FROM studio_video_orders.*FOR UPDATE").WillReturnRows(videoOrderRows(b, service.StudioVideoHeld, ""))
			m.ExpectQuery("SELECT hold_amount::text").WithArgs("av_original", int64(1), "0.80").WillReturnRows(sqlmock.NewRows([]string{"hold", "within"}).AddRow("0.80000000", true))
			// Exactly one user effect: consuming the original hold, never balance-$sale.
			m.ExpectQuery("UPDATE users SET balance=balance\\+\\$1-\\$2").WithArgs("0.80000000", "0.80", int64(1)).WillReturnRows(sqlmock.NewRows([]string{"balance", "frozen"}).AddRow("9.20000000", "0"))
			cmd, e := service.VideoAccountBillingCommand(c.ChildID, b, c.Fingerprint())
			require.NoError(t, e)
			require.Equal(t, "0", cmd.ExactAmounts.Balance)
			require.Equal(t, "0", cmd.ExactAmounts.Subscription)
			m.ExpectQuery("INSERT INTO usage_billing_dedup").WithArgs(cmd.RequestID, int64(2), c.Fingerprint()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
			m.ExpectQuery("SELECT request_fingerprint").WillReturnError(sql.ErrNoRows)
			m.ExpectQuery("UPDATE api_keys").WithArgs("0.80", int64(2), service.StatusAPIKeyActive, service.StatusAPIKeyQuotaExhausted).WillReturnRows(sqlmock.NewRows([]string{"exhausted"}).AddRow(false))
			m.ExpectQuery("UPDATE accounts SET extra").WithArgs("0.35", int64(7)).WillReturnRows(sqlmock.NewRows([]string{"used", "limit", "daily_used", "daily_limit", "weekly_used", "weekly_limit"}).AddRow(.35, 100, 0, 0, 0, 0))
			if failUsage {
				m.ExpectQuery("INSERT INTO usage_logs").WillReturnError(errors.New("fixture usage insert failure"))
				m.ExpectRollback()
				_, e = r.CaptureStudioVideoOrder(context.Background(), c)
				require.ErrorContains(t, e, "fixture usage")
			} else {
				m.ExpectQuery("INSERT INTO usage_logs").WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow(1, b.CreatedAt))
				m.ExpectExec("UPDATE studio_video_orders SET state").WillReturnResult(sqlmock.NewResult(0, 1))
				m.ExpectQuery("SELECT .* FROM studio_video_orders").WillReturnRows(videoOrderRows(b, service.StudioVideoCaptured, c.Fingerprint()))
				m.ExpectCommit()
				got, e := r.CaptureStudioVideoOrder(context.Background(), c)
				require.NoError(t, e)
				require.Equal(t, service.StudioVideoCaptured, got.State)
				// Lost commit response/restart: read back the same terminal fingerprint.
				m.ExpectBegin()
				m.ExpectQuery("SELECT .* FROM studio_video_orders.*FOR UPDATE").WillReturnRows(videoOrderRows(b, service.StudioVideoCaptured, c.Fingerprint()))
				m.ExpectRollback()
				_, e = r.CaptureStudioVideoOrder(context.Background(), c)
				require.NoError(t, e)
			}
			require.NoError(t, m.ExpectationsWereMet())
		})
	}
}

func TestVideoAccountIdentityAndLegacyCannotCross(t *testing.T) {
	b := videoBindingFixture(t)
	require.NoError(t, service.ValidateVideoBindingChild("op_old_c0", nil))
	require.Error(t, service.ValidateVideoBindingChild("op_old_c0", b))
	require.Error(t, service.ValidateVideoBindingChild("av_original", nil))
	for _, change := range []func(*service.StudioVideoBinding){
		func(b *service.StudioVideoBinding) { b.Accounting.AccountID++ },
		func(b *service.StudioVideoBinding) { b.Spec.DurationSeconds++ },
		func(b *service.StudioVideoBinding) { b.Accounting.BaseAmount = "0.8" },
		func(b *service.StudioVideoBinding) { b.Accounting.SourceState = "unknown" },
	} {
		copy := *b
		change(&copy)
		require.Error(t, copy.Validate())
	}
	legacy := videoBindingFixture(t)
	legacy.Offer.SalePrice.Currency = "USD"
	legacy.Accounting.Unit = "USD"
	require.NoError(t, legacy.Validate(), "historical USD bindings remain recoverable")
	log := service.VideoAccountUsage("av_original", "upstream1", b)
	require.Equal(t, .8, log.ActualCost)
	require.Equal(t, .35, *log.AccountStatsCost)
	require.Equal(t, int64(7), log.AccountID)
	require.Equal(t, 1, log.VideoCount)
}

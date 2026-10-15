//go:build unit

package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var _ OpsRepository = (*stubOpsRepo)(nil)

type stubOpsRepo struct {
	OpsRepository
	overview *OpsDashboardOverview
	err      error
}

func (s *stubOpsRepo) GetDashboardOverview(ctx context.Context, filter *OpsDashboardFilter) (*OpsDashboardOverview, error) {
	if s.err != nil {
		return nil, s.err
	}
	if s.overview != nil {
		return s.overview, nil
	}
	return &OpsDashboardOverview{}, nil
}

func TestComputeGroupAvailableRatio(t *testing.T) {
	t.Parallel()

	t.Run("正常情况: 10个账号, 8个可用 = 80%", func(t *testing.T) {
		t.Parallel()

		got := computeGroupAvailableRatio(&GroupAvailability{
			TotalAccounts:  10,
			AvailableCount: 8,
		})
		require.InDelta(t, 80.0, got, 0.0001)
	})

	t.Run("边界情况: TotalAccounts = 0 应返回 0", func(t *testing.T) {
		t.Parallel()

		got := computeGroupAvailableRatio(&GroupAvailability{
			TotalAccounts:  0,
			AvailableCount: 8,
		})
		require.Equal(t, 0.0, got)
	})

	t.Run("边界情况: AvailableCount = 0 应返回 0%", func(t *testing.T) {
		t.Parallel()

		got := computeGroupAvailableRatio(&GroupAvailability{
			TotalAccounts:  10,
			AvailableCount: 0,
		})
		require.Equal(t, 0.0, got)
	})
}

func TestCountAccountsByCondition(t *testing.T) {
	t.Parallel()

	t.Run("测试限流账号统计: acc.IsRateLimited", func(t *testing.T) {
		t.Parallel()

		accounts := map[int64]*AccountAvailability{
			1: {IsRateLimited: true},
			2: {IsRateLimited: false},
			3: {IsRateLimited: true},
		}

		got := countAccountsByCondition(accounts, func(acc *AccountAvailability) bool {
			return acc.IsRateLimited
		})
		require.Equal(t, int64(2), got)
	})

	t.Run("测试错误账号统计（排除临时不可调度）: acc.HasError && acc.TempUnschedulableUntil == nil", func(t *testing.T) {
		t.Parallel()

		until := time.Now().UTC().Add(5 * time.Minute)
		accounts := map[int64]*AccountAvailability{
			1: {HasError: true},
			2: {HasError: true, TempUnschedulableUntil: &until},
			3: {HasError: false},
		}

		got := countAccountsByCondition(accounts, func(acc *AccountAvailability) bool {
			return acc.HasError && acc.TempUnschedulableUntil == nil
		})
		require.Equal(t, int64(1), got)
	})

	t.Run("边界情况: 空 map 应返回 0", func(t *testing.T) {
		t.Parallel()

		got := countAccountsByCondition(map[int64]*AccountAvailability{}, func(acc *AccountAvailability) bool {
			return acc.IsRateLimited
		})
		require.Equal(t, int64(0), got)
	})
}

// TestComputeRuleMetric_AccountTempUnscheduledCount verifies the new
// account_temp_unscheduled_count metric counts accounts currently in the
// temp-unscheduled window and ignores those whose window has expired or
// were never temp-unscheduled.
func TestComputeRuleMetric_AccountTempUnscheduledCount(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	futureUntil := now.Add(5 * time.Minute)
	pastUntil := now.Add(-1 * time.Minute)

	availability := &OpsAccountAvailability{
		Accounts: map[int64]*AccountAvailability{
			// currently temp-unscheduled (window active)
			1: {TempUnschedulableUntil: &futureUntil},
			2: {TempUnschedulableUntil: &futureUntil},
			// temp-unsched window already expired → should NOT count
			3: {TempUnschedulableUntil: &pastUntil},
			// never temp-unscheduled
			4: {HasError: true},
			5: {IsRateLimited: true},
		},
	}

	opsService := &OpsService{
		getAccountAvailability: func(_ context.Context, _ string, _ *int64) (*OpsAccountAvailability, error) {
			return availability, nil
		},
	}
	svc := &OpsAlertEvaluatorService{
		opsService: opsService,
		opsRepo:    &stubOpsRepo{},
	}

	rule := &OpsAlertRule{MetricType: "account_temp_unscheduled_count"}
	val, ok, _ := svc.computeRuleMetric(context.Background(), rule, nil,
		now.Add(-5*time.Minute), now, "", nil)

	require.True(t, ok)
	require.InDelta(t, 2.0, val, 0.0001, "only 2 accounts have an active temp-unsched window")
}

func TestComputeRuleMetricNewIndicators(t *testing.T) {
	t.Parallel()

	groupID := int64(101)
	platform := "openai"

	availability := &OpsAccountAvailability{
		Group: &GroupAvailability{
			GroupID:        groupID,
			TotalAccounts:  10,
			AvailableCount: 8,
		},
		Accounts: map[int64]*AccountAvailability{
			1: {IsRateLimited: true},
			2: {IsRateLimited: true},
			3: {HasError: true},
			4: {HasError: true, TempUnschedulableUntil: timePtr(time.Now().UTC().Add(2 * time.Minute))},
			5: {HasError: false, IsRateLimited: false},
		},
	}

	opsService := &OpsService{
		getAccountAvailability: func(_ context.Context, _ string, _ *int64) (*OpsAccountAvailability, error) {
			return availability, nil
		},
	}

	svc := &OpsAlertEvaluatorService{
		opsService: opsService,
		opsRepo:    &stubOpsRepo{overview: &OpsDashboardOverview{}},
	}

	start := time.Now().UTC().Add(-5 * time.Minute)
	end := time.Now().UTC()
	ctx := context.Background()

	tests := []struct {
		name       string
		metricType string
		groupID    *int64
		wantValue  float64
		wantOK     bool
	}{
		{
			name:       "group_available_accounts",
			metricType: "group_available_accounts",
			groupID:    &groupID,
			wantValue:  8,
			wantOK:     true,
		},
		{
			name:       "group_available_ratio",
			metricType: "group_available_ratio",
			groupID:    &groupID,
			wantValue:  80.0,
			wantOK:     true,
		},
		{
			name:       "account_rate_limited_count",
			metricType: "account_rate_limited_count",
			groupID:    nil,
			wantValue:  2,
			wantOK:     true,
		},
		{
			name:       "account_error_count",
			metricType: "account_error_count",
			groupID:    nil,
			wantValue:  1,
			wantOK:     true,
		},
		{
			name:       "group_available_accounts without group_id returns false",
			metricType: "group_available_accounts",
			groupID:    nil,
			wantValue:  0,
			wantOK:     false,
		},
		{
			name:       "group_available_ratio without group_id returns false",
			metricType: "group_available_ratio",
			groupID:    nil,
			wantValue:  0,
			wantOK:     false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			rule := &OpsAlertRule{
				MetricType: tt.metricType,
			}
			gotValue, gotOK, _ := svc.computeRuleMetric(ctx, rule, nil, start, end, platform, tt.groupID)
			require.Equal(t, tt.wantOK, gotOK)
			if !tt.wantOK {
				return
			}
			require.InDelta(t, tt.wantValue, gotValue, 0.0001)
		})
	}
}

// Exercise the real evaluator, including a restart/zero-sample sustained-count reset.
type alertLifecycleRepo struct {
	stubOpsRepo
	rule              *OpsAlertRule
	active            *OpsAlertEvent
	created, resolved int
}

func (r *alertLifecycleRepo) ListAlertRules(context.Context) ([]*OpsAlertRule, error) {
	return []*OpsAlertRule{r.rule}, nil
}
func (r *alertLifecycleRepo) GetLatestSystemMetrics(context.Context, int) (*OpsSystemMetricsSnapshot, error) {
	return nil, nil
}
func (r *alertLifecycleRepo) UpsertJobHeartbeat(context.Context, *OpsUpsertJobHeartbeatInput) error {
	return nil
}
func (r *alertLifecycleRepo) GetActiveAlertEvent(context.Context, int64) (*OpsAlertEvent, error) {
	return r.active, nil
}
func (r *alertLifecycleRepo) GetLatestAlertEvent(context.Context, int64) (*OpsAlertEvent, error) {
	return nil, nil
}
func (r *alertLifecycleRepo) CreateAlertEvent(_ context.Context, e *OpsAlertEvent) (*OpsAlertEvent, error) {
	r.created++
	e.ID = 10
	r.active = e
	return e, nil
}
func (r *alertLifecycleRepo) UpdateAlertEventStatus(_ context.Context, _ int64, status string, _ *time.Time) error {
	if status == OpsAlertStatusResolved {
		r.resolved++
		r.active = nil
	}
	return nil
}
func TestOpsAlertLifecycleNoDataAndSustainedRecovery(t *testing.T) {
	for _, metric := range []string{"error_rate", "success_rate", "upstream_error_rate"} {
		t.Run(metric, func(t *testing.T) {
			rule := &OpsAlertRule{ID: 1, Name: "native SLA", Enabled: true, Severity: "P1", MetricType: metric, Operator: ">", Threshold: 5, WindowMinutes: 5, SustainedMinutes: 2}
			if metric == "success_rate" {
				rule.Operator = "<"
				rule.Threshold = 95
			}
			repo := &alertLifecycleRepo{rule: rule, active: &OpsAlertEvent{ID: 10, Status: OpsAlertStatusFiring}}
			svc := &OpsAlertEvaluatorService{opsRepo: repo, ruleStates: map[int64]*opsAlertRuleState{}}
			// Zero samples and query errors are not evidence of recovery.
			svc.evaluateOnce(time.Minute)
			require.NotNil(t, repo.active)
			require.Zero(t, repo.resolved)
			repo.err = errors.New("synthetic metrics query unavailable")
			svc.evaluateOnce(time.Minute)
			require.NotNil(t, repo.active)
			require.Zero(t, repo.resolved)
			repo.err = nil
			repo.overview = &OpsDashboardOverview{RequestCountSLA: 1, RequestCountTotal: 9, ErrorCountSLA: 1, UpstreamErrorCountExcl429529: 1, ErrorRate: 1, UpstreamErrorRate: 1, SLA: 0}
			svc.evaluateOnce(time.Minute)
			require.NotNil(t, repo.active, "a breached sample after reset must not resolve an existing incident")
			require.Zero(t, repo.resolved)
			// Real high-volume failure remains firing; no duplicate events.
			repo.overview.RequestCountSLA = 10000
			repo.overview.ErrorCountSLA = 10000
			for i := 0; i < 3; i++ {
				svc.evaluateOnce(time.Minute)
			}
			require.NotNil(t, repo.active)
			require.Zero(t, repo.created)
			// Only valid, non-breaching traffic confirms recovery.
			repo.overview = &OpsDashboardOverview{RequestCountSLA: 100, SuccessCount: 100, SLA: 1}
			svc.evaluateOnce(time.Minute)
			require.Nil(t, repo.active)
			require.Equal(t, 1, repo.resolved)
			// New incidents still require the configured sustained duration.
			repo.overview = &OpsDashboardOverview{RequestCountSLA: 1, RequestCountTotal: 9, ErrorCountSLA: 1, UpstreamErrorCountExcl429529: 1, ErrorRate: 1, UpstreamErrorRate: 1}
			svc.evaluateOnce(time.Minute)
			require.Nil(t, repo.active)
			svc.evaluateOnce(time.Minute)
			require.NotNil(t, repo.active)
			require.Equal(t, 1, repo.created)
			require.Equal(t, int64(1), repo.active.Dimensions["request_count_sla"])
			require.Equal(t, int64(1), repo.active.Dimensions["error_count_sla"])
			require.Equal(t, int64(1), repo.active.Dimensions["upstream_error_count_excl_429_529"])
			require.Equal(t, int64(0), repo.active.Dimensions["success_count"])
			require.Contains(t, repo.active.Description, "1 requests, 0 successful, 1 SLA errors")
			require.NotEmpty(t, repo.active.Dimensions["window_start"])
			repo.overview = &OpsDashboardOverview{}
			svc.evaluateOnce(time.Minute)
			require.NotNil(t, repo.active)
			require.Equal(t, 1, repo.resolved)
		})
	}
}

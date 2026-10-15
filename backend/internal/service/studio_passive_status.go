package service

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"time"
)

// StudioPassiveStatus is a deliberately narrow customer projection of native
// Monitor V2. It describes a group/model aggregate, never one Account's health.
// Counts, account identities, credentials, routing and raw errors stay private.
type StudioPassiveStatus struct {
	State         string     `json:"state"`
	Scope         string     `json:"scope"`
	WindowSeconds int        `json:"window_seconds"`
	Reason        string     `json:"reason,omitempty"`
	DataThrough   *time.Time `json:"data_through,omitempty"`
	ComputedAt    *time.Time `json:"computed_at,omitempty"`
	ErrorRate     *float64   `json:"error_rate,omitempty"`
}

func neutralStudioPassiveStatus(state, reason string) *StudioPassiveStatus {
	return &StudioPassiveStatus{State: state, Reason: reason, Scope: "platform_group_requested_model", WindowSeconds: 5400}
}

// Only catalog builders assign this private identity after their existing
// Account membership, published-offer and model-permission checks. Browser input
// cannot choose a monitoring group, platform or model independently of an offer.
func studioPassivePlatform(account *Account, key *APIKey) string {
	if account == nil || key == nil || key.Group == nil {
		return ""
	}
	platform := strings.ToLower(strings.TrimSpace(account.Platform))
	groupPlatform := strings.ToLower(strings.TrimSpace(key.Group.Platform))
	// Native usage aggregation resolves composite groups to the selected Account.
	// For a conflicting ordinary group/account platform, do not guess attribution.
	if groupPlatform != "" && groupPlatform != "composite" && groupPlatform != platform {
		return ""
	}
	return platform
}

// attachStudioPassiveStatuses performs one bounded native aggregation read for
// the whole authorized catalog. Monitoring errors never become catalog errors.
func attachStudioPassiveStatuses(ctx context.Context, monitor *ChannelMonitorV2Service, owner StudioImageOwner, key *APIKey, offers []StudioImageCatalogOffer) {
	for i := range offers {
		offers[i].PassiveStatus = neutralStudioPassiveStatus("unavailable", "unavailable")
	}
	if len(offers) == 0 {
		return
	}
	if key == nil || key.UserID != owner.UserID || key.ID != owner.APIKeyID || key.GroupID == nil || *key.GroupID != owner.GroupID || key.Group == nil || owner.GroupID <= 0 {
		for i := range offers {
			offers[i].PassiveStatus = neutralStudioPassiveStatus("unavailable", "no_identity")
		}
		return
	}
	if monitor == nil || monitor.repo == nil || monitor.settings == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	if !monitor.settings.GetChannelMonitorRuntime(ctx).PassiveAggregationAllowed() {
		for i := range offers {
			offers[i].PassiveStatus = neutralStudioPassiveStatus("unavailable", "monitor_disabled")
		}
		return
	}
	cfg, err := monitor.getEnabledConfig(ctx)
	if err != nil {
		if errors.Is(err, ErrChannelMonitorDisabled) {
			for i := range offers {
				offers[i].PassiveStatus = neutralStudioPassiveStatus("unavailable", "monitor_disabled")
			}
		}
		return
	}
	var platforms, models []string
	for i := range offers {
		if offers[i].statusPlatform == "" || offers[i].Model == "" || !key.Group.ModelAllowlist.Allows(offers[i].Model) {
			offers[i].PassiveStatus = neutralStudioPassiveStatus("unavailable", "no_identity")
			continue
		}
		if !slices.Contains(platforms, offers[i].statusPlatform) {
			platforms = append(platforms, offers[i].statusPlatform)
		}
		if !slices.Contains(models, offers[i].Model) {
			models = append(models, offers[i].Model)
		}
	}
	if len(platforms) == 0 || len(models) == 0 {
		return
	}
	filter, err := monitor.ParseFilter("90m", platforms, models, []int64{owner.GroupID})
	if err != nil {
		return
	}
	filter.RestrictGroups, filter.AllowedGroupIDs = true, []int64{owner.GroupID}
	// Read the existing native matrix with non-admin policy. Raw counts are used
	// only inside this projection to distinguish missing/insufficient samples;
	// unlike returning a Matrix, the DTO cannot expose fleet volume or identities.
	matrix, err := monitor.repo.GetMatrix(ctx, filter, *cfg, ChannelMonitorV2GroupByPlatformGroupModel, false)
	if err != nil || matrix == nil || ctx.Err() != nil {
		return
	}
	now := monitor.now().UTC()
	for i := range offers {
		offer := &offers[i]
		if offer.PassiveStatus.Reason == "no_identity" {
			continue
		}
		var row *ChannelMonitorV2MatrixRow
		for j := range matrix.Items {
			candidate := &matrix.Items[j]
			if candidate.GroupID != nil && *candidate.GroupID == owner.GroupID && candidate.Platform == offer.statusPlatform && candidate.Model == offer.Model {
				row = candidate
				break
			}
		}
		offer.PassiveStatus = projectStudioPassiveStatus(matrix.Coverage, row, cfg.HealthThresholds, now)
	}
}

func projectStudioPassiveStatus(coverage ChannelMonitorV2Coverage, row *ChannelMonitorV2MatrixRow, thresholds ChannelMonitorV2HealthThresholds, now time.Time) *StudioPassiveStatus {
	status := neutralStudioPassiveStatus("no_data", "")
	if !coverage.DataThrough.IsZero() {
		at := coverage.DataThrough.UTC()
		status.DataThrough = &at
	}
	if !coverage.ComputedAt.IsZero() {
		at := coverage.ComputedAt.UTC()
		status.ComputedAt = &at
	}
	if coverage.DataThrough.IsZero() || coverage.ComputedAt.IsZero() {
		return status
	}
	// Two native 90-minute-view buckets allow ordinary aggregation lag, without
	// presenting an old observation as a current channel-health claim.
	if now.Sub(coverage.DataThrough) > 10*time.Minute || now.Sub(coverage.ComputedAt) > 10*time.Minute || coverage.DataThrough.After(now.Add(5*time.Minute)) || coverage.ComputedAt.After(now.Add(time.Minute)) {
		status.State = "stale"
		return status
	}
	if row == nil || row.Metrics.RequestCount <= 0 {
		return status
	}
	minimum := NormalizeChannelMonitorV2HealthThresholds(thresholds).MinimumSample
	if !coverage.CoverageComplete || row.Metrics.RequestCount < minimum {
		status.State = "insufficient"
		return status
	}
	rate := row.Metrics.ErrorRate
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 || rate > 1 {
		status.State, status.Reason = "unavailable", "unavailable"
		return status
	}
	status.State, status.ErrorRate = "observed", &rate
	return status
}

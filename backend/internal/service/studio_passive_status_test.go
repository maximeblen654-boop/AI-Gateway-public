package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type studioPassiveRepo struct {
	channelMonitorV2RepoStub
	filter ChannelMonitorV2Filter
	calls  int
	err    error
	wait   bool
}

func (r *studioPassiveRepo) GetMatrix(ctx context.Context, f ChannelMonitorV2Filter, cfg ChannelMonitorV2Config, group ChannelMonitorV2GroupBy, admin bool) (*ChannelMonitorV2Matrix, error) {
	r.calls++
	r.filter, r.group, r.admin = f, group, admin
	if r.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return r.matrix, r.err
}
func studioPassiveFixture() (*ChannelMonitorV2Service, *studioPassiveRepo, StudioImageOwner, *APIKey, []StudioImageCatalogOffer) {
	now := time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)
	gid := int64(31)
	repo := &studioPassiveRepo{channelMonitorV2RepoStub: channelMonitorV2RepoStub{
		config: ChannelMonitorV2Config{Enabled: true, HealthThresholds: DefaultChannelMonitorV2HealthThresholds()},
		matrix: &ChannelMonitorV2Matrix{Coverage: ChannelMonitorV2Coverage{DataThrough: now.Add(-time.Minute), ComputedAt: now, CoverageComplete: true}, Items: []ChannelMonitorV2MatrixRow{{Platform: "openai", GroupID: &gid, Model: "site-image", Metrics: ChannelMonitorV2Metric{RequestCount: 100, ErrorRate: 0.2}}}},
	}}
	svc := NewChannelMonitorV2Service(repo)
	svc.now = func() time.Time { return now }
	svc.SetRuntimeReader(channelMonitorV2RuntimeStub{rt: ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV2}})
	owner := StudioImageOwner{UserID: 2, APIKeyID: 3, GroupID: gid}
	key := &APIKey{ID: 3, UserID: 2, GroupID: &gid, Group: &Group{ID: gid, Platform: "openai"}}
	offers := []StudioImageCatalogOffer{{OfferID: "one", ProductID: "a", Model: "site-image", UpstreamModel: "upstream-image", statusPlatform: "openai"}, {OfferID: "two", ProductID: "b", Model: "site-image", statusPlatform: "openai"}, {OfferID: "video", Model: "site-video", statusPlatform: "openai"}}
	return svc, repo, owner, key, offers
}
func TestStudioPassiveStatusBatchesAuthorizedAggregateWithoutIdentityLeaks(t *testing.T) {
	svc, repo, owner, key, offers := studioPassiveFixture()
	attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
	require.Equal(t, 1, repo.calls)
	require.False(t, repo.admin)
	require.Equal(t, ChannelMonitorV2GroupByPlatformGroupModel, repo.group)
	require.True(t, repo.filter.RestrictGroups)
	require.Equal(t, []int64{31}, repo.filter.AllowedGroupIDs)
	require.Equal(t, []int64{31}, repo.filter.GroupIDs)
	require.ElementsMatch(t, []string{"site-image", "site-video"}, repo.filter.Models)
	require.NotContains(t, repo.filter.Models, "upstream-image")
	for _, offer := range offers[:2] {
		require.Equal(t, "observed", offer.PassiveStatus.State)
		require.Equal(t, "platform_group_requested_model", offer.PassiveStatus.Scope)
		require.Equal(t, 0.2, *offer.PassiveStatus.ErrorRate)
		body, err := json.Marshal(offer.PassiveStatus)
		require.NoError(t, err)
		for _, private := range []string{"account", "group_id", "request_count", "success_requests", "error_requests", "api_key", "upstream"} {
			require.NotContains(t, string(body), private)
		}
	}
	require.Equal(t, "no_data", offers[2].PassiveStatus.State)
}
func TestStudioPassiveStatusExactScopeNoCrossGroupPlatformOrModelFallback(t *testing.T) {
	svc, repo, owner, key, offers := studioPassiveFixture()
	other := int64(99)
	repo.matrix.Items = []ChannelMonitorV2MatrixRow{
		{Platform: "openai", GroupID: &other, Model: "site-image", Metrics: ChannelMonitorV2Metric{RequestCount: 100}},
		{Platform: "gemini", GroupID: &owner.GroupID, Model: "site-image", Metrics: ChannelMonitorV2Metric{RequestCount: 100}},
		{Platform: "openai", GroupID: &owner.GroupID, Model: "upstream-image", Metrics: ChannelMonitorV2Metric{RequestCount: 100}},
		{Platform: "openai", GroupID: &owner.GroupID, Model: ChannelMonitorV2OtherModel, Metrics: ChannelMonitorV2Metric{RequestCount: 100}},
	}
	attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
	for _, o := range offers {
		require.Equal(t, "no_data", o.PassiveStatus.State)
		require.Nil(t, o.PassiveStatus.ErrorRate)
	}
}
func TestStudioPassiveStatusNeutralCasesAndNativeMinimum(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		mutate      func(*ChannelMonitorV2Service, *studioPassiveRepo)
	}{
		{"no watermark", "no_data", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.matrix.Coverage = ChannelMonitorV2Coverage{} }},
		{"zero samples", "no_data", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.matrix.Items[0].Metrics.RequestCount = 0 }},
		{"below native minimum", "insufficient", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.matrix.Items[0].Metrics.RequestCount = 49 }},
		{"partial coverage", "insufficient", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.matrix.Coverage.CoverageComplete = false }},
		{"stale data", "stale", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) {
			r.matrix.Coverage.DataThrough = s.now().Add(-11 * time.Minute)
		}},
		{"stale calculation", "stale", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) {
			r.matrix.Coverage.ComputedAt = s.now().Add(-11 * time.Minute)
		}},
		{"disabled config", "unavailable", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.config.Enabled = false }},
		{"v1 mode", "unavailable", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) {
			s.SetRuntimeReader(channelMonitorV2RuntimeStub{rt: ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV1}})
		}},
		{"missing runtime settings", "unavailable", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { s.settings = nil }},
		{"repository failure", "unavailable", func(s *ChannelMonitorV2Service, r *studioPassiveRepo) { r.err = errors.New("private database error") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, repo, owner, key, offers := studioPassiveFixture()
			tc.mutate(svc, repo)
			attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
			require.Equal(t, tc.state, offers[0].PassiveStatus.State)
			require.Nil(t, offers[0].PassiveStatus.ErrorRate)
			raw, _ := json.Marshal(offers[0].PassiveStatus)
			require.NotContains(t, string(raw), "private database")
		})
	}
}
func TestStudioPassiveStatusIdentityAndCancellation(t *testing.T) {
	svc, repo, owner, key, offers := studioPassiveFixture()
	owner.UserID = 999
	attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
	require.Zero(t, repo.calls)
	require.Equal(t, "no_identity", offers[0].PassiveStatus.Reason)
	svc, repo, owner, key, offers = studioPassiveFixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	repo.wait = true
	attachStudioPassiveStatuses(ctx, svc, owner, key, offers)
	require.Equal(t, "unavailable", offers[0].PassiveStatus.State)
	require.Equal(t, "one", offers[0].OfferID)
	require.Equal(t, "site-image", offers[0].Model)
}
func TestStudioPassivePlatformUsesNativeIdentityNotDisplayName(t *testing.T) {
	_, _, _, key, _ := studioPassiveFixture()
	account := &Account{Platform: "gemini", Name: "openai"}
	require.Empty(t, studioPassivePlatform(account, key))
	key.Group.Platform = "composite"
	require.Equal(t, "gemini", studioPassivePlatform(account, key))
	require.Empty(t, studioPassivePlatform(nil, key))
}
func TestStudioPassiveHTTP502UsesNativeClassification(t *testing.T) {
	source := ChannelMonitorV2ErrorInput{StatusCode: 502, UpstreamStatusCode: 502}
	require.Equal(t, "upstream_5xx", ClassifyChannelMonitorV2Error(source))
}

func TestStudioPassiveStatusModelPermissionAndBoundedTimeout(t *testing.T) {
	svc, repo, owner, key, offers := studioPassiveFixture()
	key.Group.ModelAllowlist = GroupModelAllowlist{Enabled: true, Models: []string{"site-video"}}
	attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
	require.Equal(t, "no_identity", offers[0].PassiveStatus.Reason)
	require.Equal(t, []string{"site-video"}, repo.filter.Models)
	svc, repo, owner, key, offers = studioPassiveFixture()
	repo.wait = true
	started := time.Now()
	attachStudioPassiveStatuses(context.Background(), svc, owner, key, offers)
	require.Less(t, time.Since(started), 2*time.Second)
	require.Equal(t, "unavailable", offers[0].PassiveStatus.State)
	require.Equal(t, "one", offers[0].OfferID)
}

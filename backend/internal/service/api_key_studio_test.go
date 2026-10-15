package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/stretchr/testify/require"
)

type studioAccessKeys struct {
	APIKeyRepository
	mu   sync.Mutex
	keys []APIKey
}

func (r *studioAccessKeys) ListByUserID(_ context.Context, owner int64, _ pagination.PaginationParams, filter APIKeyListFilters) ([]APIKey, *pagination.PaginationResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var keys []APIKey
	for _, k := range r.keys {
		if k.UserID == owner && k.GroupID != nil && filter.GroupID != nil && *k.GroupID == *filter.GroupID {
			keys = append(keys, k)
		}
	}
	return keys, nil, nil
}
func (r *studioAccessKeys) Create(_ context.Context, k *APIKey) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	k.ID = int64(len(r.keys) + 1)
	r.keys = append(r.keys, *k)
	return nil
}
func (r *studioAccessKeys) CountByUserID(_ context.Context, owner int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for _, k := range r.keys {
		if k.UserID == owner {
			n++
		}
	}
	return n, nil
}

type studioAccessUsers struct {
	UserRepository
	users map[int64]*User
}

func (r studioAccessUsers) GetByID(_ context.Context, id int64) (*User, error) {
	return r.users[id], nil
}

type studioAccessGroups struct {
	GroupRepository
	groups map[int64]*Group
}

func (r studioAccessGroups) GetByID(_ context.Context, id int64) (*Group, error) {
	return r.groups[id], nil
}

func studioAccessFixture(t *testing.T) (*APIKeyService, *studioAccessKeys) {
	t.Helper()
	t.Setenv("STUDIO_BRIDGE_SERVICE_TOKEN", "synthetic-bridge-token-32-characters")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/internal/studio/paid-control" || r.Header.Get("X-Studio-Service-Token") != "synthetic-bridge-token-32-characters" {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(paidSidecar{Version: StudioPaidControlVersion, Ready: true, CoreLoopback: true, ImageGroup: 31, VideoGroup: 32})
	}))
	t.Cleanup(server.Close)
	t.Setenv("STUDIO_CONTROL_BRIDGE_URL", server.URL)
	repo := &studioAccessKeys{}
	return &APIKeyService{apiKeyRepo: repo, cfg: &config.Config{},
		userRepo:  studioAccessUsers{users: map[int64]*User{1: {ID: 1, Status: StatusActive}, 2: {ID: 2, Status: StatusActive}, 3: {ID: 3, Status: StatusActive, RestrictPublicGroups: true}, 4: {ID: 4, Status: StatusDisabled}}},
		groupRepo: studioAccessGroups{groups: map[int64]*Group{31: {ID: 31, Status: StatusActive, AllowImageGeneration: true}, 32: {ID: 32, Status: StatusActive}}}}, repo
}

func TestStudioCredentialNativeCreationAndIsolation(t *testing.T) {
	svc, repo := studioAccessFixture(t)
	var wg sync.WaitGroup
	failures := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); failures <- svc.EnsureStudioCredential(context.Background(), 1, "image") }()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	require.Len(t, repo.keys, 1)
	require.Equal(t, int64(1), repo.keys[0].UserID)
	require.Equal(t, int64(31), *repo.keys[0].GroupID)
	require.Equal(t, StatusActive, repo.keys[0].Status)
	require.NotEmpty(t, repo.keys[0].Key)
	require.NoError(t, svc.EnsureStudioCredential(context.Background(), 2, "image"))
	require.NoError(t, svc.EnsureStudioCredential(context.Background(), 1, "video"))
	require.Len(t, repo.keys, 3)
	require.NotEqual(t, repo.keys[0].Key, repo.keys[1].Key)
	require.Equal(t, int64(32), *repo.keys[2].GroupID)
}

func TestStudioCredentialDoesNotReplaceRestrictedKeys(t *testing.T) {
	for _, status := range []string{StatusActive, StatusDisabled, "expired", "quota_exhausted"} {
		t.Run(status, func(t *testing.T) {
			svc, repo := studioAccessFixture(t)
			group := int64(31)
			expired := time.Now().Add(-time.Hour)
			old := APIKey{ID: 99, UserID: 1, GroupID: &group, Key: "synthetic-existing", Status: status, Quota: 1, QuotaUsed: 1, ExpiresAt: &expired, IPWhitelist: []string{"192.0.2.1"}}
			repo.keys = []APIKey{old}
			require.NoError(t, svc.EnsureStudioCredential(context.Background(), 1, "image"))
			require.Equal(t, []APIKey{old}, repo.keys)
		})
	}
}

func TestStudioCredentialPermissionsAndUnavailableBridge(t *testing.T) {
	svc, repo := studioAccessFixture(t)
	for _, owner := range []int64{3, 4, 999} {
		require.ErrorIs(t, svc.EnsureStudioCredential(context.Background(), owner, "image"), ErrGroupNotAllowed)
	}
	require.Error(t, svc.EnsureStudioCredential(context.Background(), 1, "other"))
	require.Empty(t, repo.keys)
	svc.cfg.APIKeyCreate.MaxActivePerUser = 1
	require.NoError(t, svc.EnsureStudioCredential(context.Background(), 1, "image"))
	require.ErrorIs(t, svc.EnsureStudioCredential(context.Background(), 1, "video"), ErrAPIKeyCountExceeded)
	t.Setenv("STUDIO_CONTROL_BRIDGE_URL", "https://supplier.invalid")
	require.Error(t, svc.EnsureStudioCredential(context.Background(), 2, "image"))
	require.Len(t, repo.keys, 1)
}

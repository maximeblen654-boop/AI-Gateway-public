package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
)

type studioCatalogFetchFunc func(context.Context, *Account) ([]string, error)

func (f studioCatalogFetchFunc) FetchUpstreamSupportedModels(ctx context.Context, a *Account) ([]string, error) {
	return f(ctx, a)
}

type studioCatalogSyncRepo struct {
	AccountRepository
	mu       sync.Mutex
	accounts map[int64]*Account
	ids      []int64
	gets     int
	writes   int
	writeErr error
}

func cloneStudioCatalogAccount(a *Account) *Account {
	if a == nil {
		return nil
	}
	b, _ := json.Marshal(a)
	var c Account
	_ = json.Unmarshal(b, &c)
	return &c
}

func (r *studioCatalogSyncRepo) GetByID(_ context.Context, id int64) (*Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gets++
	if a := r.accounts[id]; a != nil {
		return cloneStudioCatalogAccount(a), nil
	}
	return nil, ErrAccountNotFound
}
func (r *studioCatalogSyncRepo) ListStudioModelCatalogSyncAccountIDs(context.Context) ([]int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int64(nil), r.ids...), nil
}
func (r *studioCatalogSyncRepo) UpdateStudioModelCatalogSnapshot(_ context.Context, expected *Account, c *mediaworkbench.Catalog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.writeErr != nil {
		return r.writeErr
	}
	current := r.accounts[expected.ID]
	if current == nil {
		return ErrStudioModelCatalogIdentityChanged
	}
	a, _ := studioModelCatalogAccountIdentity(current)
	b, _ := studioModelCatalogAccountIdentity(expected)
	oldA, _ := json.Marshal(cloneStudioCatalogAccount(current).Extra[mediaworkbench.CatalogKey])
	oldB, _ := json.Marshal(cloneStudioCatalogAccount(expected).Extra[mediaworkbench.CatalogKey])
	if a != b || string(oldA) != string(oldB) {
		return ErrStudioModelCatalogIdentityChanged
	}
	r.writes++
	current.Extra[mediaworkbench.CatalogKey] = *c
	return nil
}

func studioCatalogAccount(id int64) *Account {
	return &Account{ID: id, Platform: PlatformOpenAI, Type: AccountTypeAPIKey,
		Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1"},
		Extra: map[string]any{mediaworkbench.ExtraKey: &mediaworkbench.Config{SchemaVersion: 1,
			Draft: mediaworkbench.Draft{Products: []mediaworkbench.Product{{ProductID: "product", MediaType: "image", UpstreamModel: "old-model"}}}}}}
}

func newStudioCatalogSyncTest(t *testing.T, accounts ...*Account) (*StudioModelCatalogSync, *studioCatalogSyncRepo) {
	t.Helper()
	r := &studioCatalogSyncRepo{accounts: map[int64]*Account{}}
	for _, a := range accounts {
		r.accounts[a.ID] = a
		r.ids = append(r.ids, a.ID)
	}
	s := NewStudioModelCatalogSync(r, nil)
	s.now = func() time.Time { return time.Date(2026, 10, 21, 3, 0, 0, 0, time.UTC) }
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) { return []string{"new-model"}, nil })
	t.Cleanup(s.Stop)
	return s, r
}

func setStudioCatalogSnapshot(t *testing.T, s *StudioModelCatalogSync, a *Account, at time.Time) {
	t.Helper()
	identity, err := studioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	a.Extra[mediaworkbench.CatalogKey] = mediaworkbench.Catalog{Source: "upstream", SyncedAt: at.Format(time.RFC3339Nano), Models: []string{"old-model"}, AccountIdentitySHA256: identity}
}

func TestStudioModelCatalogSyncFreshness(t *testing.T) {
	for _, tc := range []struct {
		name    string
		age     time.Duration
		mutate  func(*mediaworkbench.Catalog)
		fetches int32
		current bool
	}{
		{name: "recent success reused", age: 2*time.Minute - time.Nanosecond, current: true},
		{name: "refresh before admission expiry", age: 2 * time.Minute, fetches: 1, current: true},
		{name: "last valid instant still refreshed", age: 5*time.Minute - time.Nanosecond, fetches: 1, current: true},
		{name: "exactly expired", age: 5 * time.Minute, fetches: 1},
		{name: "older success", age: 6 * time.Minute, fetches: 1},
		{name: "future timestamp rejected", age: -time.Second, fetches: 1},
		{name: "legacy unbound success rejected", age: time.Minute, mutate: func(c *mediaworkbench.Catalog) { c.AccountIdentitySHA256 = "" }, fetches: 1},
		{name: "invalid timestamp rejected", mutate: func(c *mediaworkbench.Catalog) { c.SyncedAt = "invalid" }, fetches: 1},
		{name: "non-upstream snapshot rejected", mutate: func(c *mediaworkbench.Catalog) { c.Source = "configured" }, fetches: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := studioCatalogAccount(7)
			s, r := newStudioCatalogSyncTest(t, a)
			setStudioCatalogSnapshot(t, s, a, s.now().Add(-tc.age))
			if tc.mutate != nil {
				c, ok := a.Extra[mediaworkbench.CatalogKey].(mediaworkbench.Catalog)
				require.True(t, ok)
				tc.mutate(&c)
				a.Extra[mediaworkbench.CatalogKey] = c
			}
			var calls atomic.Int32
			s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) { calls.Add(1); return []string{"new-model"}, nil })
			require.Equal(t, tc.current, s.Current(a), "read-only admission keeps its original five-minute limit")
			require.NoError(t, s.Ensure(t.Context(), 7))
			require.Equal(t, tc.fetches, calls.Load())
			require.Equal(t, int(tc.fetches), r.writes)
		})
	}
}

func TestStudioModelCatalogSyncFailureRetainsSuccessAndBacksOff(t *testing.T) {
	a := studioCatalogAccount(7)
	s, r := newStudioCatalogSyncTest(t, a)
	clock := s.now()
	s.now = func() time.Time { return clock }
	setStudioCatalogSnapshot(t, s, a, clock.Add(-6*time.Minute))
	old := a.Extra[mediaworkbench.CatalogKey]
	var calls atomic.Int32
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
		calls.Add(1)
		return nil, errors.New("supplier secret URL must never escape")
	})
	for range 2 {
		err := s.Ensure(t.Context(), 7)
		require.ErrorIs(t, err, ErrStudioModelCatalogUnavailable)
		require.NotContains(t, err.Error(), "secret")
	}
	require.EqualValues(t, 1, calls.Load())
	require.Equal(t, old, a.Extra[mediaworkbench.CatalogKey])
	require.Zero(t, r.writes)
	clock = clock.Add(time.Minute)
	require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
	require.EqualValues(t, 2, calls.Load())
}

func TestStudioModelCatalogSyncReplacesEntireModelListOnly(t *testing.T) {
	a := studioCatalogAccount(7)
	s, r := newStudioCatalogSyncTest(t, a)
	setStudioCatalogSnapshot(t, s, a, s.now().Add(-6*time.Minute))
	a.Extra[UpstreamModelMetadataExtraKey] = map[string]any{"models": "preserve"}
	config := a.Extra[mediaworkbench.ExtraKey]
	require.NoError(t, s.Ensure(t.Context(), 7))
	require.Equal(t, 1, r.writes)
	c, ok := a.Extra[mediaworkbench.CatalogKey].(mediaworkbench.Catalog)
	require.True(t, ok)
	require.Equal(t, []string{"new-model"}, c.Models)
	require.NotContains(t, c.Models, "old-model")
	require.Equal(t, config, a.Extra[mediaworkbench.ExtraKey])
	require.Equal(t, map[string]any{"models": "preserve"}, a.Extra[UpstreamModelMetadataExtraKey])
	require.NotContains(t, c.AccountIdentitySHA256, "fixture-key")
}

func TestStudioModelCatalogSyncSkipsUnrelatedAccounts(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Account)
	}{
		{"OAuth", func(a *Account) { a.Type = AccountTypeOAuth }},
		{"native only", func(a *Account) { delete(a.Extra, mediaworkbench.ExtraKey) }},
		{"no media initialization or products", func(a *Account) { a.Extra[mediaworkbench.ExtraKey] = &mediaworkbench.Config{SchemaVersion: 1} }},
		{"non-media initialization", func(a *Account) {
			a.Extra[mediaworkbench.ExtraKey] = &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: 1, MediaTypes: []string{"text"}}
		}},
		{"non-media product", func(a *Account) {
			a.Extra[mediaworkbench.ExtraKey] = map[string]any{"draft": map[string]any{"products": []any{map[string]any{"media_type": "text"}}}}
		}},
		{"shadow", func(a *Account) { id := int64(8); a.ParentAccountID = &id }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := studioCatalogAccount(7)
			tc.change(a)
			s, r := newStudioCatalogSyncTest(t, a)
			s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
				t.Error("unrelated Account contacted")
				return nil, nil
			})
			require.NoError(t, s.RunDue(t.Context()))
			require.Zero(t, r.writes)
		})
	}
}

func TestStudioModelCatalogSyncConcurrentRequestsShareOneFetch(t *testing.T) {
	s, r := newStudioCatalogSyncTest(t, studioCatalogAccount(7), studioCatalogAccount(8))
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	s.fetcher = studioCatalogFetchFunc(func(ctx context.Context, a *Account) ([]string, error) {
		calls.Add(1)
		if a.ID == 7 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []string{"new-model"}, nil
	})
	results := make(chan error, 20)
	for range 20 {
		go func() { results <- s.Ensure(t.Context(), 7) }()
	}
	<-entered
	other := make(chan error, 1)
	go func() { other <- s.Ensure(t.Context(), 8) }()
	select {
	case err := <-other:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("other Account blocked behind global network lock")
	}
	close(release)
	for range 20 {
		require.NoError(t, <-results)
	}
	require.EqualValues(t, 2, calls.Load())
	require.Equal(t, 2, r.writes)
}

func TestStudioModelCatalogSyncRejectsInFlightIdentityAndSnapshotChanges(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Account)
	}{
		{"credential rotation", func(a *Account) { a.Credentials["api_key"] = "rotated-key" }},
		{"platform change", func(a *Account) { a.Platform = PlatformAnthropic }},
		{"type change", func(a *Account) { a.Type = AccountTypeOAuth }},
		{"proxy change", func(a *Account) { id := int64(17); a.ProxyID = &id }},
		{"newer catalog", func(a *Account) {
			a.Extra[mediaworkbench.CatalogKey] = map[string]any{"models": []string{"newest"}, "synced_at": "newer"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := studioCatalogAccount(7)
			s, r := newStudioCatalogSyncTest(t, a)
			setStudioCatalogSnapshot(t, s, a, s.now().Add(-6*time.Minute))
			entered := make(chan struct{})
			release := make(chan struct{})
			s.fetcher = studioCatalogFetchFunc(func(ctx context.Context, _ *Account) ([]string, error) {
				close(entered)
				select {
				case <-release:
					return []string{"late"}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			})
			done := make(chan error, 1)
			go func() { done <- s.Ensure(t.Context(), 7) }()
			<-entered
			r.mu.Lock()
			tc.change(a)
			retained := cloneStudioCatalogAccount(a).Extra[mediaworkbench.CatalogKey]
			r.mu.Unlock()
			close(release)
			require.ErrorIs(t, <-done, ErrStudioModelCatalogUnavailable)
			require.Zero(t, r.writes)
			require.Equal(t, retained, cloneStudioCatalogAccount(a).Extra[mediaworkbench.CatalogKey])
		})
	}
}

func TestStudioModelCatalogSyncDeadlineAndStopCancelFetch(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		a := studioCatalogAccount(7)
		s, r := newStudioCatalogSyncTest(t, a)
		require.Equal(t, 25*time.Second, s.requestTimeout)
		s.requestTimeout = 20 * time.Millisecond
		setStudioCatalogSnapshot(t, s, a, s.now().Add(-6*time.Minute))
		old := a.Extra[mediaworkbench.CatalogKey]
		s.fetcher = studioCatalogFetchFunc(func(ctx context.Context, _ *Account) ([]string, error) { <-ctx.Done(); return nil, ctx.Err() })
		start := time.Now()
		require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
		require.Less(t, time.Since(start), time.Second)
		require.Zero(t, r.writes)
		require.Equal(t, old, a.Extra[mediaworkbench.CatalogKey])
	})
	t.Run("startup and stop", func(t *testing.T) {
		s, r := newStudioCatalogSyncTest(t, studioCatalogAccount(7))
		entered := make(chan struct{})
		canceled := make(chan struct{})
		var calls atomic.Int32
		s.fetcher = studioCatalogFetchFunc(func(ctx context.Context, _ *Account) ([]string, error) {
			calls.Add(1)
			close(entered)
			<-ctx.Done()
			close(canceled)
			return nil, ctx.Err()
		})
		s.Start()
		s.Start()
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("startup did not check due Account")
		}
		s.Stop()
		<-canceled
		s.Stop()
		s.Start()
		require.EqualValues(t, 1, calls.Load())
		require.Zero(t, r.writes)
		require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
	})
}

func TestStudioModelCatalogSyncPeriodicLoopRefreshesExpiredOnly(t *testing.T) {
	a := studioCatalogAccount(7)
	s, r := newStudioCatalogSyncTest(t, a)
	var clock atomic.Int64
	clock.Store(s.now().UnixNano())
	s.now = func() time.Time { return time.Unix(0, clock.Load()) }
	setStudioCatalogSnapshot(t, s, a, s.now())
	s.interval = 5 * time.Millisecond
	var calls atomic.Int32
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) { calls.Add(1); return []string{"new-model"}, nil })
	s.Start()
	require.Eventually(t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.gets > 0
	}, time.Second, time.Millisecond)
	require.Zero(t, calls.Load())
	clock.Add(int64(6 * time.Minute))
	require.Eventually(t, func() bool { return calls.Load() == 1 }, time.Second, time.Millisecond)
	s.Stop()
	require.EqualValues(t, 1, calls.Load())
}

func TestStudioModelCatalogSyncScheduledRefreshHasNoNaturalExpiryGap(t *testing.T) {
	a := studioCatalogAccount(77)
	s, r := newStudioCatalogSyncTest(t, a)
	base := s.now()
	clock := base.Add(time.Second)
	s.now = func() time.Time { return clock }
	setStudioCatalogSnapshot(t, s, a, clock)
	config := cloneStudioCatalogAccount(a).Extra[mediaworkbench.ExtraKey]
	var calls int
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
		calls++
		// A completed observation is later than the scheduler tick that started it.
		clock = clock.Add(25 * time.Second)
		return []string{"old-model"}, nil
	})
	for tick := 1; tick <= 12; tick++ {
		clock = base.Add(time.Duration(tick) * s.interval)
		require.True(t, s.Current(a), "catalog expired before scheduled tick %d", tick)
		require.NoError(t, s.RunDue(t.Context()))
		require.True(t, s.Current(a), "refresh completed with stale evidence at tick %d", tick)
		clock = base.Add(time.Duration(tick+1)*s.interval - time.Nanosecond)
		require.True(t, s.Current(a), "healthy sequential refresh left an expiry gap after tick %d", tick)
	}
	require.Positive(t, calls)
	require.Less(t, calls, 12, "unchanged fresh snapshots must not cause a supplier request each tick")
	require.Equal(t, calls, r.writes)
	require.Equal(t, config, cloneStudioCatalogAccount(a).Extra[mediaworkbench.ExtraKey])
}

func TestStudioModelCatalogSyncFailedEarlyRefreshKeepsOriginalEvidenceAndExpiry(t *testing.T) {
	a := studioCatalogAccount(77)
	s, r := newStudioCatalogSyncTest(t, a)
	clock := s.now()
	s.now = func() time.Time { return clock }
	setStudioCatalogSnapshot(t, s, a, clock)
	original := a.Extra[mediaworkbench.CatalogKey]
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
		return nil, errors.New("temporary supplier failure")
	})
	clock = clock.Add(3 * time.Minute)
	require.ErrorIs(t, s.RunDue(t.Context()), ErrStudioModelCatalogUnavailable)
	require.True(t, s.Current(a), "early refresh failure must not rewrite the last success")
	require.Equal(t, original, a.Extra[mediaworkbench.CatalogKey])
	require.Zero(t, r.writes)
	clock = clock.Add(2 * time.Minute)
	require.False(t, s.Current(a), "failed refresh must not extend the original five-minute limit")
}

func TestStudioModelCatalogSyncEarlyRefreshFailureReusesOnlyCurrentBoundEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		age    time.Duration
		change func(*Account)
		allow  bool
	}{
		{name: "still valid snapshot", age: 3 * time.Minute, allow: true},
		{name: "exact hard expiry", age: 5 * time.Minute},
		{name: "credential changed during refresh", age: 3 * time.Minute, change: func(a *Account) { a.Credentials["api_key"] = "new-synthetic-key" }},
		{name: "supplier changed during refresh", age: 3 * time.Minute, change: func(a *Account) { a.Credentials["base_url"] = "https://other.example/v1" }},
		{name: "new malformed snapshot", age: 3 * time.Minute, change: func(a *Account) { a.Extra[mediaworkbench.CatalogKey] = map[string]any{"synced_at": "invalid"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := studioCatalogAccount(77)
			s, r := newStudioCatalogSyncTest(t, a)
			setStudioCatalogSnapshot(t, s, a, s.now().Add(-tc.age))
			var calls int
			s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
				calls++
				if tc.change != nil {
					r.mu.Lock()
					tc.change(a)
					r.mu.Unlock()
				}
				return nil, errors.New("temporary supplier failure")
			})
			attempts := 2
			if tc.change != nil {
				attempts = 1
			}
			for range attempts {
				err := s.Ensure(t.Context(), 77)
				if tc.allow {
					require.NoError(t, err, "valid existing evidence is reloaded and checked after an early refresh failure")
				} else {
					require.ErrorIs(t, err, ErrStudioModelCatalogUnavailable)
				}
			}
			require.Equal(t, 1, calls, "unchanged identity shares the bounded failure backoff")
			require.Zero(t, r.writes)
		})
	}
}

func TestStudioModelCatalogSyncDoesNotReuseValidEvidenceAfterCancellationOrStop(t *testing.T) {
	t.Run("stopped service", func(t *testing.T) {
		a := studioCatalogAccount(77)
		s, _ := newStudioCatalogSyncTest(t, a)
		setStudioCatalogSnapshot(t, s, a, s.now().Add(-3*time.Minute))
		s.Stop()
		require.ErrorIs(t, s.Ensure(t.Context(), 77), ErrStudioModelCatalogUnavailable)
	})
	t.Run("canceled caller", func(t *testing.T) {
		a := studioCatalogAccount(77)
		s, _ := newStudioCatalogSyncTest(t, a)
		setStudioCatalogSnapshot(t, s, a, s.now().Add(-3*time.Minute))
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
			cancel()
			return nil, errors.New("temporary supplier failure")
		})
		require.ErrorIs(t, s.Ensure(ctx, 77), ErrStudioModelCatalogUnavailable)
	})
}

func TestStudioModelCatalogSyncRunDueContinuesSequentiallyAfterFailure(t *testing.T) {
	s, r := newStudioCatalogSyncTest(t, studioCatalogAccount(7), studioCatalogAccount(8))
	var order []int64
	s.fetcher = studioCatalogFetchFunc(func(_ context.Context, a *Account) ([]string, error) {
		order = append(order, a.ID)
		if a.ID == 7 {
			return nil, errors.New("unavailable")
		}
		return []string{"new-model"}, nil
	})
	require.ErrorIs(t, s.RunDue(t.Context()), ErrStudioModelCatalogUnavailable)
	require.Equal(t, []int64{7, 8}, order)
	require.Equal(t, 1, r.writes)
}

func TestStudioModelCatalogSyncUsesExistingHTTPValidationWithoutMetadataEnrichment(t *testing.T) {
	a := studioCatalogAccount(7)
	s, _ := newStudioCatalogSyncTest(t, a)
	upstream := &httpUpstreamRecorder{resp: &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"exact-new-id"}]}`))}}
	s.fetcher = &AccountTestService{httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
	require.NoError(t, s.Ensure(t.Context(), 7))
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.image2pro.top/v1/models", upstream.lastReq.URL.String())
	require.Equal(t, http.MethodGet, upstream.lastReq.Method)
	require.NotContains(t, a.Extra, UpstreamModelMetadataExtraKey)
}

func TestStudioModelCatalogSyncPersistenceFailureRetainsSuccess(t *testing.T) {
	a := studioCatalogAccount(7)
	s, r := newStudioCatalogSyncTest(t, a)
	setStudioCatalogSnapshot(t, s, a, s.now().Add(-6*time.Minute))
	old := a.Extra[mediaworkbench.CatalogKey]
	r.writeErr = errors.New("storage failed")
	require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
	require.Equal(t, old, a.Extra[mediaworkbench.CatalogKey])
	require.Zero(t, r.writes)
}

func TestStudioModelCatalogSyncNewCredentialBypassesOldFailureBackoff(t *testing.T) {
	a := studioCatalogAccount(7)
	s, r := newStudioCatalogSyncTest(t, a)
	var calls atomic.Int32
	s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
		if calls.Add(1) == 1 {
			return nil, errors.New("old credential rejected")
		}
		return []string{"current-credential-model"}, nil
	})
	require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
	r.mu.Lock()
	a.Credentials["api_key"] = "rotated-key"
	r.mu.Unlock()
	require.NoError(t, s.Ensure(t.Context(), 7))
	require.EqualValues(t, 2, calls.Load())
	require.Equal(t, 1, r.writes)
}

func TestStudioModelCatalogSyncRunDueSkipsOverlappingCycle(t *testing.T) {
	s, r := newStudioCatalogSyncTest(t, studioCatalogAccount(7))
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s.fetcher = studioCatalogFetchFunc(func(ctx context.Context, _ *Account) ([]string, error) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
			return []string{"new-model"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	first := make(chan error, 1)
	go func() { first <- s.RunDue(t.Context()) }()
	<-entered
	require.NoError(t, s.RunDue(t.Context()))
	close(release)
	require.NoError(t, <-first)
	require.EqualValues(t, 1, calls.Load())
	require.Equal(t, 1, r.writes)
}

func TestStudioModelCatalogSyncUnconfiguredFailsClosed(t *testing.T) {
	s := NewStudioModelCatalogSync(nil, nil)
	t.Cleanup(s.Stop)
	require.ErrorIs(t, s.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
	require.ErrorIs(t, s.RunDue(t.Context()), ErrStudioModelCatalogUnavailable)
	r := &studioCatalogSyncRepo{accounts: map[int64]*Account{7: studioCatalogAccount(7)}}
	withNilFetcher := NewStudioModelCatalogSync(r, nil)
	t.Cleanup(withNilFetcher.Stop)
	require.ErrorIs(t, withNilFetcher.Ensure(t.Context(), 7), ErrStudioModelCatalogUnavailable)
}

type studioManualCatalogCASRepo struct {
	AccountRepository
	casCalls       int
	metadataWrites int
	casErr         error
	catalog        *mediaworkbench.Catalog
}

func (r *studioManualCatalogCASRepo) UpdateStudioModelCatalogSnapshot(_ context.Context, _ *Account, c *mediaworkbench.Catalog) error {
	r.casCalls++
	r.catalog = c
	return r.casErr
}
func (r *studioManualCatalogCASRepo) UpdateExtra(_ context.Context, _ int64, extra map[string]any) error {
	if _, exists := extra[UpstreamModelMetadataExtraKey]; exists {
		r.metadataWrites++
	}
	return nil
}

func TestSyncUpstreamModelCatalogUsesSharedCASBeforeMetadata(t *testing.T) {
	raw, err := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, err)
	var fixture struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	for _, tc := range []struct {
		name   string
		casErr error
	}{
		{"success binds current identity", nil},
		{"stale manual response rejected before metadata", ErrStudioModelCatalogIdentityChanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := studioCatalogAccount(7)
			old := map[string]any{"source": "upstream", "synced_at": "2026-10-15T00:00:00Z", "models": []string{"old"}}
			a.Extra[mediaworkbench.CatalogKey] = old
			repo := &studioManualCatalogCASRepo{casErr: tc.casErr}
			upstream := &httpUpstreamRecorder{resp: &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"` + fixture.Model + `","metadata":` + string(fixture.Metadata) + `}]}`))}}
			svc := &AccountTestService{accountRepo: repo, httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
			_, err := svc.SyncUpstreamModelCatalog(t.Context(), a)
			require.Equal(t, 1, repo.casCalls)
			require.Len(t, upstream.requests, 1, "CAS failure must return before registry enrichment")
			if tc.casErr != nil {
				require.ErrorIs(t, err, tc.casErr)
				var syncErr *UpstreamModelSyncError
				require.ErrorAs(t, err, &syncErr)
				require.Equal(t, UpstreamModelSyncErrorInternal, syncErr.Kind)
				require.Equal(t, "Failed to save upstream model catalog", syncErr.SafeMessage())
				require.Zero(t, repo.metadataWrites)
				require.Equal(t, old, a.Extra[mediaworkbench.CatalogKey])
				require.NotContains(t, a.Extra, UpstreamModelMetadataExtraKey)
			} else {
				require.NoError(t, err)
				require.Equal(t, 1, repo.metadataWrites)
				identity, e := studioModelCatalogAccountIdentity(a)
				require.NoError(t, e)
				require.Equal(t, identity, repo.catalog.AccountIdentitySHA256)
				require.Equal(t, []string{fixture.Model}, repo.catalog.Models)
				require.Same(t, repo.catalog, a.Extra[mediaworkbench.CatalogKey])
			}
		})
	}
}

func TestStudioModelCatalogSyncInitializedWorkbenchDiscoversModelsWithoutProducts(t *testing.T) {
	for _, mediaType := range []string{"image", "video"} {
		t.Run(mediaType, func(t *testing.T) {
			a := studioCatalogAccount(7)
			config := &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: 1, MediaTypes: []string{mediaType}}
			a.Extra[mediaworkbench.ExtraKey] = config
			s, r := newStudioCatalogSyncTest(t, a)
			var calls atomic.Int32
			s.fetcher = studioCatalogFetchFunc(func(context.Context, *Account) ([]string, error) {
				calls.Add(1)
				return []string{"discovered-first-model"}, nil
			})
			require.NoError(t, s.RunDue(t.Context()))
			require.EqualValues(t, 1, calls.Load())
			require.Equal(t, 1, r.writes)
			catalog, ok := a.Extra[mediaworkbench.CatalogKey].(mediaworkbench.Catalog)
			require.True(t, ok)
			require.Equal(t, []string{"discovered-first-model"}, catalog.Models)
			require.Same(t, config, a.Extra[mediaworkbench.ExtraKey], "discovery must not create products or mutate initialized media configuration")
			require.Empty(t, config.Draft.Products)
			require.Nil(t, config.Published)
		})
	}
}

func TestStudioModelCatalogSyncDoesNotFilterSupplierOrProtocol(t *testing.T) {
	for _, platform := range []string{PlatformOpenAI, PlatformGemini, PlatformAnthropic, PlatformGrok} {
		for _, base := range []string{"https://api.image2pro.top/v1", "https://video.laoliimage2.win/v1", "https://new-supplier.example/v1"} {
			t.Run(platform+base, func(t *testing.T) {
				a := studioCatalogAccount(44)
				a.Platform = platform
				a.Credentials["base_url"] = base
				s, r := newStudioCatalogSyncTest(t, a)
				calls := 0
				s.fetcher = studioCatalogFetchFunc(func(_ context.Context, got *Account) ([]string, error) {
					calls++
					require.Equal(t, base, got.GetCredential("base_url"))
					return []string{"new-model"}, nil
				})
				config, err := json.Marshal(a.Extra[mediaworkbench.ExtraKey])
				require.NoError(t, err)
				require.NoError(t, s.RunDue(t.Context()))
				require.Equal(t, 1, calls)
				require.Equal(t, 1, r.writes)
				after, err := json.Marshal(a.Extra[mediaworkbench.ExtraKey])
				require.NoError(t, err)
				require.Equal(t, config, after)
			})
		}
	}
}

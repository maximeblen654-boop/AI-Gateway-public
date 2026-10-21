package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"golang.org/x/sync/singleflight"
)

const (
	studioModelCatalogMaxAge         = 5 * time.Minute
	studioModelCatalogTimeout        = 25 * time.Second
	studioModelCatalogFailureBackoff = time.Minute
)

var (
	ErrStudioModelCatalogUnavailable     = errors.New("studio model catalog is unavailable; retry after its next successful refresh")
	ErrStudioModelCatalogIdentityChanged = errors.New("studio model catalog account identity or snapshot changed")
)

// This optional repository contract keeps catalog observation out of the native
// AccountRepository routing/configuration contract and its existing mocks.
type studioModelCatalogSnapshotWriter interface {
	UpdateStudioModelCatalogSnapshot(context.Context, *Account, *mediaworkbench.Catalog) error
}

type studioModelCatalogSyncRepository interface {
	GetByID(context.Context, int64) (*Account, error)
	ListStudioModelCatalogSyncAccountIDs(context.Context) ([]int64, error)
	studioModelCatalogSnapshotWriter
}

type studioModelCatalogFetcher interface {
	FetchUpstreamSupportedModels(context.Context, *Account) ([]string, error)
}

type studioModelCatalogFailure struct {
	identity   string
	retryAfter time.Time
}

// StudioModelCatalogSync observes the free Image2Pro model-list endpoint only
// for initialized media workbenches or configured Studio products. It never changes metadata,
// products, Published offers, prices, permissions, or native API model mapping.
type StudioModelCatalogSync struct {
	repo           studioModelCatalogSyncRepository
	fetcher        studioModelCatalogFetcher
	parentCtx      context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	started        bool
	stopped        bool
	wg             sync.WaitGroup
	cycleMu        sync.Mutex
	flights        singleflight.Group
	failures       map[int64]studioModelCatalogFailure
	now            func() time.Time
	interval       time.Duration
	requestTimeout time.Duration
}

func NewStudioModelCatalogSync(accountRepo AccountRepository, fetcher *AccountTestService) *StudioModelCatalogSync {
	ctx, cancel := context.WithCancel(context.Background())
	repo, _ := accountRepo.(studioModelCatalogSyncRepository)
	var catalogFetcher studioModelCatalogFetcher
	if fetcher != nil {
		catalogFetcher = fetcher
	}
	return &StudioModelCatalogSync{
		repo: repo, fetcher: catalogFetcher, parentCtx: ctx, cancel: cancel,
		failures: make(map[int64]studioModelCatalogFailure), now: time.Now,
		interval: studioModelCatalogMaxAge, requestTimeout: studioModelCatalogTimeout,
	}
}

func (s *StudioModelCatalogSync) Start() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started || s.stopped {
		return
	}
	s.started = true
	s.wg.Add(1)
	go s.runLoop()
}

func (s *StudioModelCatalogSync) Stop() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.stopped = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *StudioModelCatalogSync) runLoop() {
	defer s.wg.Done()
	s.runDueLogged()
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.parentCtx.Done():
			return
		case <-ticker.C:
			s.runDueLogged()
		}
	}
}

func (s *StudioModelCatalogSync) runDueLogged() {
	if err := s.RunDue(s.parentCtx); err != nil && s.parentCtx.Err() == nil {
		// Supplier errors may contain request URLs. Keep logs free of their text.
		slog.Warn("Studio model catalog refresh did not complete")
	}
}

// RunDue walks only configured media Accounts, sequentially. Individual failures
// do not prevent later Accounts from refreshing; overlapping cycles are skipped.
func (s *StudioModelCatalogSync) RunDue(ctx context.Context) error {
	if s == nil || s.repo == nil {
		return ErrStudioModelCatalogUnavailable
	}
	if !s.cycleMu.TryLock() {
		return nil
	}
	defer s.cycleMu.Unlock()
	ids, err := s.repo.ListStudioModelCatalogSyncAccountIDs(ctx)
	if err != nil {
		return ErrStudioModelCatalogUnavailable
	}
	var firstErr error
	for _, id := range ids {
		if ctx.Err() != nil {
			return ErrStudioModelCatalogUnavailable
		}
		if err := s.Ensure(ctx, id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Ensure is for new quotes only. A current successful observation is reused for
// five minutes. Historical task recovery must use its frozen identity instead.
// The caller reloads the Account/catalog after this returns successfully.
func (s *StudioModelCatalogSync) Ensure(ctx context.Context, accountID int64) error {
	if s == nil || s.repo == nil || s.fetcher == nil || accountID <= 0 || ctx.Err() != nil {
		return ErrStudioModelCatalogUnavailable
	}
	result := s.flights.DoChan(strconv.FormatInt(accountID, 10), func() (any, error) {
		return nil, s.ensureAccount(accountID)
	})
	select {
	case <-ctx.Done():
		return ErrStudioModelCatalogUnavailable
	case r := <-result:
		return r.Err
	}
}

func (s *StudioModelCatalogSync) ensureAccount(accountID int64) error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return ErrStudioModelCatalogUnavailable
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()

	ctx, cancel := context.WithTimeout(s.parentCtx, s.requestTimeout)
	defer cancel()
	account, err := s.repo.GetByID(ctx, accountID)
	if err != nil || account == nil {
		return ErrStudioModelCatalogUnavailable
	}
	if !studioModelCatalogSyncEligible(account) {
		return nil
	}
	identity, err := studioModelCatalogAccountIdentity(account)
	if err != nil {
		return ErrStudioModelCatalogUnavailable
	}
	now := s.now()
	if studioModelCatalogFresh(account, identity, now) {
		return nil
	}

	s.mu.Lock()
	failure := s.failures[accountID]
	s.mu.Unlock()
	if failure.identity == identity && now.Before(failure.retryAfter) {
		return ErrStudioModelCatalogUnavailable
	}
	if account.GetOpenAIProtocolAPIKey() == "" {
		return ErrStudioModelCatalogUnavailable
	}

	models, err := s.fetcher.FetchUpstreamSupportedModels(ctx, account)
	if err == nil {
		catalog := &mediaworkbench.Catalog{
			Source: "upstream", SyncedAt: s.now().UTC().Format(time.RFC3339Nano),
			Models: append([]string{}, models...), AccountIdentitySHA256: identity,
		}
		err = s.repo.UpdateStudioModelCatalogSnapshot(ctx, account, catalog)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.failures[accountID] = studioModelCatalogFailure{identity: identity, retryAfter: s.now().Add(studioModelCatalogFailureBackoff)}
		return ErrStudioModelCatalogUnavailable
	}
	delete(s.failures, accountID)
	return nil
}

func studioModelCatalogSyncEligible(a *Account) bool {
	if a == nil || a.ID <= 0 || a.ParentAccountID != nil || a.Platform != PlatformOpenAI || a.Type != AccountTypeAPIKey || !imagecontract.IsImage2ProBase(a.GetOpenAIBaseURL()) {
		return false
	}
	body, err := json.Marshal(a.Extra[mediaworkbench.ExtraKey])
	if err != nil {
		return false
	}
	var configured struct {
		MediaTypes []string `json:"media_types"`
		Draft      struct {
			Products []struct {
				MediaType string `json:"media_type"`
			} `json:"products"`
		} `json:"draft"`
		Published *struct {
			Products []struct {
				MediaType string `json:"media_type"`
			} `json:"products"`
		} `json:"published"`
	}
	if json.Unmarshal(body, &configured) != nil {
		return false
	}
	for _, mediaType := range configured.MediaTypes {
		if mediaType == "image" || mediaType == "video" {
			return true
		}
	}
	for _, product := range configured.Draft.Products {
		if product.MediaType == "image" || product.MediaType == "video" {
			return true
		}
	}
	if configured.Published != nil {
		for _, product := range configured.Published.Products {
			if product.MediaType == "image" || product.MediaType == "video" {
				return true
			}
		}
	}
	return false
}

func studioModelCatalogAccountIdentity(a *Account) (string, error) {
	body, err := json.Marshal(struct {
		ID          int64
		Platform    string
		Type        string
		Credentials map[string]any
		ProxyID     *int64
	}{a.ID, a.Platform, a.Type, a.Credentials, a.ProxyID})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(body)), nil
}

func studioModelCatalogFresh(a *Account, identity string, now time.Time) bool {
	body, err := json.Marshal(a.Extra[mediaworkbench.CatalogKey])
	if err != nil {
		return false
	}
	var catalog mediaworkbench.Catalog
	if json.Unmarshal(body, &catalog) != nil || catalog.Source != "upstream" || catalog.AccountIdentitySHA256 != identity || catalog.Models == nil {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, catalog.SyncedAt)
	return err == nil && !at.After(now) && now.Sub(at) < studioModelCatalogMaxAge
}

// Manual sync and the background observer use the same conditional catalog
// write. Capability enrichment remains in the manual path, after this succeeds.
func (s *AccountTestService) persistUpstreamModelCatalogSnapshot(ctx context.Context, account *Account, models []string) error {
	at := time.Now().UTC()
	var stored any
	var err error
	if writer, ok := s.accountRepo.(studioModelCatalogSnapshotWriter); ok {
		identity, identityErr := studioModelCatalogAccountIdentity(account)
		if identityErr != nil {
			return newUpstreamModelSyncInternalError("Failed to save upstream model catalog", identityErr)
		}
		catalog := &mediaworkbench.Catalog{
			Source: "upstream", SyncedAt: at.Format(time.RFC3339Nano),
			Models: append([]string{}, models...), AccountIdentitySHA256: identity,
		}
		err = writer.UpdateStudioModelCatalogSnapshot(ctx, account, catalog)
		stored = catalog
	} else {
		// Existing test repositories do not implement the optional writer. The
		// production accountRepository always uses the identity/catalog CAS above.
		snapshot := map[string]any{"source": "upstream", "synced_at": at.Format(time.RFC3339), "models": models}
		err = s.accountRepo.UpdateExtra(ctx, account.ID, map[string]any{mediaworkbench.CatalogKey: snapshot})
		stored = snapshot
	}
	if err != nil {
		return newUpstreamModelSyncInternalError("Failed to save upstream model catalog", err)
	}
	if account.Extra == nil {
		account.Extra = make(map[string]any)
	}
	account.Extra[mediaworkbench.CatalogKey] = stored
	return nil
}

// Current checks existing local evidence only. Status reads never fetch or write.
func (s *StudioModelCatalogSync) Current(account *Account) bool {
	if s == nil || account == nil {
		return false
	}
	if !studioModelCatalogSyncEligible(account) {
		return true
	}
	identity, err := studioModelCatalogAccountIdentity(account)
	return err == nil && studioModelCatalogFresh(account, identity, s.now())
}

package service

import (
	"context"
	"errors"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

type catalogCancelMediaRepo struct {
	mediaworkbench.Repository
	cancel context.CancelFunc
}

func (r catalogCancelMediaRepo) List(ctx context.Context) ([]mediaworkbench.Account, error) {
	rows, err := r.Repository.List(ctx)
	r.cancel()
	return rows, err
}

type catalogCancelAccountRepo struct {
	AccountRepository
	cancel context.CancelFunc
}

func (r catalogCancelAccountRepo) GetByID(ctx context.Context, id int64) (*Account, error) {
	a, err := r.AccountRepository.GetByID(ctx, id)
	r.cancel()
	return a, err
}

type videoCatalogTerminalContext struct {
	context.Context
	calls, after int
}

func (c *videoCatalogTerminalContext) Err() error {
	c.calls++
	if c.calls >= c.after {
		return context.Canceled
	}
	return nil
}

func TestVideoCatalogCancellationReturnsErrorWithoutPartialOffers(t *testing.T) {
	for _, phase := range []string{"repository", "native_account", "validation"} {
		t.Run(phase, func(t *testing.T) {
			p, _, key, _ := paidPerformanceFixture(t, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch phase {
			case "repository":
				p.video.Media = catalogCancelMediaRepo{p.video.Media, cancel}
			case "native_account":
				p.video.Core.accountRepo = catalogCancelAccountRepo{p.video.Core.accountRepo, cancel}
			case "validation":
				terminal := &videoCatalogTerminalContext{Context: context.Background(), after: 12}
				offers, err := p.video.Catalog(terminal, StudioImageOwner{1, 2, 3}, key)
				if offers != nil || !errors.Is(err, context.Canceled) {
					t.Fatalf("validation cancellation: count=%d err=%v", len(offers), err)
				}
				return
			}
			offers, err := p.video.Catalog(ctx, StudioImageOwner{1, 2, 3}, key)
			if offers != nil || !errors.Is(err, context.Canceled) {
				t.Fatalf("%s cancellation: count=%d err=%v", phase, len(offers), err)
			}
		})
	}
}

func TestVideoCatalogNewRequestRetainsLivePermissionsAndDependencies(t *testing.T) {
	p, repo, key, accounts := paidPerformanceFixture(t, false)
	owner := StudioImageOwner{1, 2, 3}
	ctx := mediaworkbench.WithPublishedValidationMemo(context.Background())
	check := func(want int) {
		t.Helper()
		reads := accounts.calls
		offers, err := p.video.Catalog(ctx, owner, key)
		if err != nil || len(offers) != want || accounts.calls != reads+1 {
			t.Fatalf("catalog count=%d want=%d native_reads=%d err=%v", len(offers), want, accounts.calls-reads, err)
		}
		for _, offer := range offers {
			found := false
			for _, published := range repo.a.Config.Published.Offers {
				if published.OfferID == offer.OfferID {
					found = published.SalePrice == offer.Price && published.ProductID == offer.ProductID && offer.Revision == repo.a.Config.Published.Revision
				}
			}
			if !found {
				t.Fatal("catalog changed the published offer or frozen price")
			}
		}
	}
	n := len(repo.a.Config.Published.Offers)
	check(n)
	groups := accounts.a.GroupIDs
	accounts.a.GroupIDs = nil
	check(0)
	accounts.a.GroupIDs = groups
	key.Group.ModelAllowlist = GroupModelAllowlist{Enabled: true, Models: []string{"another-model"}}
	check(0)
	key.Group.ModelAllowlist = GroupModelAllowlist{}
	check(n)
	url := repo.a.BaseURL
	repo.a.BaseURL = "https://changed.example.invalid/v1"
	check(0)
	repo.a.BaseURL = url
	repo.a.Config.ProductLifecycle = map[string]mediaworkbench.ProductLifecycle{"performance-video": {State: "unlisted"}}
	check(0)
	repo.a.Config.ProductLifecycle = nil
	check(n)
}

package service

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

type studioCatalogRefresher interface {
	Ensure(context.Context, int64) error
	Current(*Account) bool
}

func refreshStudioCatalog(ctx context.Context, repo mediaworkbench.Repository, refresh studioCatalogRefresher, a *mediaworkbench.Account) (*mediaworkbench.Account, error) {
	if refresh == nil {
		return a, nil
	}
	if err := refresh.Ensure(ctx, a.ID); err != nil {
		return nil, QuoteFailure("model_catalog", err)
	}
	current, err := repo.Get(ctx, a.ID)
	if err != nil {
		return nil, QuoteFailure("model_catalog", err)
	}
	return current, nil
}

package mediaworkbench

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type bindingIdentityContextRepo struct{ *memoryRepo }

func (r *bindingIdentityContextRepo) Get(ctx context.Context, id int64) (*Account, error) {
	if !ModelBindingCatalogIdentityRequired(ctx) {
		return nil, ErrModelBindingCatalogIdentity
	}
	return r.memoryRepo.Get(ctx, id)
}

func (r *bindingIdentityContextRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, deps Dependencies, c *Config) error {
	if !ModelBindingCatalogIdentityRequired(ctx) {
		return ErrModelBindingCatalogIdentity
	}
	return r.memoryRepo.CompareAndSwapChecked(ctx, id, expected, deps, c)
}

func TestModelBindingRequestsScopedIdentityAtReadAndCheckedSave(t *testing.T) {
	_, r, input := modelBindingFixture(t)
	ctx := context.Background()
	require.False(t, ModelBindingCatalogIdentityRequired(ctx))
	require.True(t, ModelBindingCatalogIdentityRequired(WithModelBindingCatalogIdentity(ctx)))
	s := NewService(&bindingIdentityContextRepo{memoryRepo: r})
	_, err := s.ModelBinding(ctx, 7, r.a.Config.RecordVersion, input)
	require.NoError(t, err)
	require.False(t, ModelBindingCatalogIdentityRequired(ctx), "the caller's ordinary read context remains unchanged")
}

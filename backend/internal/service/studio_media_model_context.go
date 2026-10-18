package service

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// Only a successfully resolved, current Published offer may grant catalog
// passthrough. Ordinary gateway requests retain their native mapping allowlist.
// Bind to the exact credential snapshot so fresh DB rechecks cannot inherit a
// grant after a mapping/credential change or for another Account/model.
type publishedMediaModelKey struct{}
type publishedMediaModel struct {
	accountID                        int64
	requested, upstream, credentials string
	exact                            bool
}

func withPublishedMediaModel(ctx context.Context, a *Account, requested, upstream string, direct ...bool) context.Context {
	exact := len(direct) > 0 && direct[0]
	version := 0
	if exact {
		version = 1
	}
	return context.WithValue(ctx, publishedMediaModelKey{}, publishedMediaModel{a.ID, requested, upstream, studioOfferCredentialFingerprint(a, mediaworkbench.Offer{CostVersion: version}), exact})
}
func hasPublishedMediaModel(ctx context.Context, a *Account, requested string) bool {
	grant, ok := ctx.Value(publishedMediaModelKey{}).(publishedMediaModel)
	return a != nil && ok && grant.exact && grant.accountID == a.ID && grant.requested == requested && grant.upstream != "" &&
		grant.credentials == studioOfferCredentialFingerprint(a, mediaworkbench.Offer{CostVersion: 1})
}

// A request-local execution view keeps the real Account identity, quotas,
// concurrency and credentials while excluding API alias maps. It never writes
// Account configuration or installs a replacement model mapping.
func publishedMediaExecutionAccount(ctx context.Context, a *Account, requested string) *Account {
	if !hasPublishedMediaModel(ctx, a, requested) {
		return a
	}
	copy := *a
	copy.Credentials = make(map[string]any, len(a.Credentials))
	for k, v := range a.Credentials {
		if k != "model_mapping" && k != "compact_model_mapping" {
			copy.Credentials[k] = v
		}
	}
	return &copy
}
func accountSupportsRequestedModel(ctx context.Context, a *Account, requested string) bool {
	if a == nil {
		return false
	}
	if a.IsModelSupported(requested) {
		return true
	}
	if hasPublishedMediaModel(ctx, a, requested) {
		return true
	}
	grant, ok := ctx.Value(publishedMediaModelKey{}).(publishedMediaModel)
	return ok && !grant.exact && grant.accountID == a.ID && grant.requested == requested &&
		grant.credentials == studioCredentialFingerprint(a) && a.GetMappedModel(requested) == grant.upstream
}

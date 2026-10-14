package service

import "context"

// Only a successfully resolved, current Published offer may grant catalog
// passthrough. Ordinary gateway requests retain their native mapping allowlist.
// Bind to the exact credential snapshot so fresh DB rechecks cannot inherit a
// grant after a mapping/credential change or for another Account/model.
type publishedMediaModelKey struct{}
type publishedMediaModel struct {
	accountID                        int64
	requested, upstream, credentials string
}

func withPublishedMediaModel(ctx context.Context, a *Account, requested, upstream string) context.Context {
	return context.WithValue(ctx, publishedMediaModelKey{}, publishedMediaModel{a.ID, requested, upstream, studioCredentialFingerprint(a)})
}
func accountSupportsRequestedModel(ctx context.Context, a *Account, requested string) bool {
	if a == nil {
		return false
	}
	if a.IsModelSupported(requested) {
		return true
	}
	grant, ok := ctx.Value(publishedMediaModelKey{}).(publishedMediaModel)
	return ok && grant.accountID == a.ID && grant.requested == requested &&
		grant.credentials == studioCredentialFingerprint(a) && a.GetMappedModel(requested) == grant.upstream
}

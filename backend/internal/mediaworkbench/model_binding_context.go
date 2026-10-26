package mediaworkbench

import (
	"context"

	apperrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var ErrModelBindingCatalogIdentity = apperrors.New(422, "MEDIA_MODEL_BINDING_CATALOG_IDENTITY_CHANGED", "模型目录未绑定当前 Account 的凭据、地址和代理，请先成功同步当前账号的完整目录，再处理缺失型号。")

type modelBindingCatalogIdentityKey struct{}

// WithModelBindingCatalogIdentity requests a current native identity check only
// for explicit binding maintenance. Existing published grants and ordinary
// Account reads retain their original dependency and credential-rotation rules.
func WithModelBindingCatalogIdentity(ctx context.Context) context.Context {
	return context.WithValue(ctx, modelBindingCatalogIdentityKey{}, true)
}

func ModelBindingCatalogIdentityRequired(ctx context.Context) bool {
	checked, _ := ctx.Value(modelBindingCatalogIdentityKey{}).(bool)
	return checked
}

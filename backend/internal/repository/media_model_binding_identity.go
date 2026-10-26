package repository

import (
	"context"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// Only binding maintenance reads these temporary native identity inputs. They
// share the same row observation (and CAS row lock) as the narrow projection;
// ordinary reads never select raw credentials and no DTO contains them.
func mediaAccountProjectionForBinding(ctx context.Context) string {
	if !mediaworkbench.ModelBindingCatalogIdentityRequired(ctx) {
		return mediaAccountProjection
	}
	return strings.Replace(mediaAccountProjection, "jsonb_build_object('model_mapping',", "jsonb_build_object('model_binding_credentials', credentials, 'model_mapping',", 1)
}

func checkMediaModelBindingCatalogIdentity(a *mediaworkbench.Account, credentials map[string]any, proxyID *int64) error {
	if a.Catalog == nil || a.Catalog.AccountIdentitySHA256 == "" || len(credentials) == 0 {
		return mediaworkbench.ErrModelBindingCatalogIdentity
	}
	identity, err := service.StudioModelCatalogAccountIdentity(&service.Account{ID: a.ID, Platform: a.Platform, Type: a.Type, Credentials: credentials, ProxyID: proxyID})
	if err != nil || identity != a.Catalog.AccountIdentitySHA256 {
		// Do not wrap decoding or hashing errors with credential-bearing inputs.
		return mediaworkbench.ErrModelBindingCatalogIdentity
	}
	return nil
}

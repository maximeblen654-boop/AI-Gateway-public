package repository

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

const bindingIdentityFixtureSecret = "fixture-private-binding-credential"

func nativeBindingIdentityFixture(t *testing.T) (*service.Account, *mediaworkbench.Catalog, *mediaworkbench.Config) {
	t.Helper()
	proxyID := int64(11)
	a := &service.Account{ID: 7, Platform: "openai", Type: "apikey", Credentials: map[string]any{"api_key": bindingIdentityFixtureSecret, "base_url": "https://supplier.example/v1", "model_mapping": map[string]any{"alias": "original"}}, ProxyID: &proxyID}
	identity, err := service.StudioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	catalog := &mediaworkbench.Catalog{Source: "upstream", SyncedAt: "2026-10-26T00:00:00Z", AccountIdentitySHA256: identity, Models: []string{"new-model"}}
	config := &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: 7, MediaTypes: []string{"image"}, Draft: mediaworkbench.Draft{Revision: "mwd-fixture", Products: []mediaworkbench.Product{{ProductID: "p", SiteModel: "stable-alias", UpstreamModel: "old-model", Enabled: true, MediaType: "image", CostVersion: mediaworkbench.MediaRetailVersion}}}, Published: &mediaworkbench.Published{Revision: "immutable-existing-published", SourceDraftRevision: "original-source", Dependencies: mediaworkbench.Dependencies{CatalogSHA256: "original-published-dependencies"}}}
	return a, catalog, config
}

func bindingIdentityRows(t *testing.T, native *service.Account, catalog *mediaworkbench.Catalog, config *mediaworkbench.Config, scoped bool) *sqlmock.Rows {
	t.Helper()
	routing := map[string]any{"has_key": true, "endpoint_capabilities": []string{}, "model_mapping": native.Credentials["model_mapping"], "proxy_id": native.ProxyID}
	if scoped {
		routing["model_binding_credentials"] = native.Credentials
	}
	cat, err := json.Marshal(catalog)
	require.NoError(t, err)
	cfg, err := json.Marshal(config)
	require.NoError(t, err)
	route, err := json.Marshal(routing)
	require.NoError(t, err)
	return sqlmock.NewRows(mediaColumns).AddRow(native.ID, "fixture", native.Platform, native.Type, "active", true, native.Credentials["base_url"], cat, cfg, route)
}

func requireBindingNoSecret(t *testing.T, a *mediaworkbench.Account, err error) {
	t.Helper()
	if err != nil {
		require.NotContains(t, err.Error(), bindingIdentityFixtureSecret)
		require.NotContains(t, err.Error(), "model_binding_credentials")
	}
	if a != nil {
		body, marshalErr := json.Marshal(a)
		require.NoError(t, marshalErr)
		require.NotContains(t, string(body), bindingIdentityFixtureSecret)
		require.NotContains(t, string(body), "api_key")
		require.NotContains(t, string(body), "model_binding_credentials")
	}
}

func TestMediaModelBindingIdentityProjectionIsScopedAndKeepsOneRowShape(t *testing.T) {
	ctx := mediaworkbench.WithModelBindingCatalogIdentity(context.Background())
	const original = "jsonb_build_object('model_mapping',"
	const scoped = "jsonb_build_object('model_binding_credentials', credentials, 'model_mapping',"
	require.Equal(t, 1, strings.Count(mediaAccountProjection, original))
	require.NotContains(t, mediaAccountProjection, "model_binding_credentials")
	require.Equal(t, mediaAccountProjection, mediaAccountProjectionForBinding(context.Background()))
	projection := mediaAccountProjectionForBinding(ctx)
	require.Equal(t, 1, strings.Count(projection, scoped))
	require.Equal(t, mediaAccountProjection, strings.Replace(projection, scoped, original, 1), "only the temporary routing JSON field may change")
}

func TestMediaModelBindingIdentityRejectsChangedOwnerBeforeRead(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*service.Account, *mediaworkbench.Catalog)
		valid  bool
	}{
		{"same identity", func(*service.Account, *mediaworkbench.Catalog) {}, true},
		{"key rotated", func(a *service.Account, _ *mediaworkbench.Catalog) { a.Credentials["api_key"] = "rotated-fixture" }, false},
		{"base URL changed", func(a *service.Account, _ *mediaworkbench.Catalog) {
			a.Credentials["base_url"] = "https://changed.example/v1"
		}, false},
		{"proxy changed", func(a *service.Account, _ *mediaworkbench.Catalog) { proxy := int64(99); a.ProxyID = &proxy }, false},
		{"native aliases changed", func(a *service.Account, _ *mediaworkbench.Catalog) {
			a.Credentials["model_mapping"] = map[string]any{"alias": "changed"}
		}, true},
		{"snapshot identity missing", func(_ *service.Account, c *mediaworkbench.Catalog) { c.AccountIdentitySHA256 = "" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native, catalog, config := nativeBindingIdentityFixture(t)
			tc.mutate(native, catalog)
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer func() { _ = db.Close() }()
			ctx := mediaworkbench.WithModelBindingCatalogIdentity(context.Background())
			mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjectionForBinding(ctx) + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(bindingIdentityRows(t, native, catalog, config, true))
			a, err := NewMediaConfigRepository(db).Get(ctx, 7)
			if tc.valid {
				require.NoError(t, err)
				require.NotNil(t, a)
			} else {
				require.ErrorIs(t, err, mediaworkbench.ErrModelBindingCatalogIdentity)
				require.Nil(t, a)
			}
			requireBindingNoSecret(t, a, err)
			require.NoError(t, mock.ExpectationsWereMet(), "a failed identity read must not write")
		})
	}
}

func TestMediaModelBindingIdentityRejectsOwnerChangesUnderRowLock(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*service.Account)
		valid  bool
	}{
		{"same identity", func(*service.Account) {}, true},
		{"key rotated after validation", func(a *service.Account) { a.Credentials["api_key"] = "rotated-fixture" }, false},
		{"base URL changed after validation", func(a *service.Account) { a.Credentials["base_url"] = "https://changed.example/v1" }, false},
		{"proxy changed after validation", func(a *service.Account) { proxy := int64(99); a.ProxyID = &proxy }, false},
		{"aliases changed after validation", func(a *service.Account) { a.Credentials["model_mapping"] = map[string]any{"alias": "changed"} }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native, catalog, config := nativeBindingIdentityFixture(t)
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer func() { _ = db.Close() }()
			ctx := mediaworkbench.WithModelBindingCatalogIdentity(context.Background())
			mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjectionForBinding(ctx) + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(bindingIdentityRows(t, native, catalog, config, true))
			r := NewMediaConfigRepository(db)
			observed, err := r.Get(ctx, 7)
			require.NoError(t, err)
			deps := mediaworkbench.DependenciesFor(observed)
			candidate := *observed.Config
			candidate.RecordVersion++
			body, err := json.Marshal(&candidate)
			require.NoError(t, err)
			tc.mutate(native)
			mock.ExpectBegin()
			mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjectionForBinding(ctx) + `WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`)).WithArgs(int64(7)).WillReturnRows(bindingIdentityRows(t, native, catalog, config, true))
			if tc.valid {
				mock.ExpectExec(regexp.QuoteMeta(mediaConfigCAS)).WithArgs(string(body), int64(7), int64(7)).WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectCommit()
			} else {
				mock.ExpectRollback()
			}
			err = r.CompareAndSwapChecked(ctx, 7, 7, deps, &candidate)
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, mediaworkbench.ErrModelBindingCatalogIdentity)
			}
			requireBindingNoSecret(t, observed, err)
			require.NoError(t, mock.ExpectationsWereMet(), "an identity race must roll back before UPDATE")
		})
	}
}

func TestMediaModelBindingIdentityDoesNotChangeOrdinaryProjectionOrDependencies(t *testing.T) {
	native, catalog, config := nativeBindingIdentityFixture(t)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	r := NewMediaConfigRepository(db)
	ctx := context.Background()
	mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(bindingIdentityRows(t, native, catalog, config, false))
	ordinary, err := r.Get(ctx, 7)
	require.NoError(t, err)
	ctx = mediaworkbench.WithModelBindingCatalogIdentity(ctx)
	mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjectionForBinding(ctx) + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(bindingIdentityRows(t, native, catalog, config, true))
	scoped, err := r.Get(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, ordinary, scoped)
	require.Equal(t, mediaworkbench.DependenciesFor(ordinary), mediaworkbench.DependenciesFor(scoped))
	require.Equal(t, mediaworkbench.PublishedDependenciesFor(ordinary), mediaworkbench.PublishedDependenciesFor(scoped))
	require.Equal(t, ordinary.RoutingFingerprint, scoped.RoutingFingerprint)
	require.Equal(t, ordinary.Config.Published, scoped.Config.Published)
	requireBindingNoSecret(t, scoped, nil)
	require.NoError(t, mock.ExpectationsWereMet())
}

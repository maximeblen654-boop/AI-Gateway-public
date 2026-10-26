package service

import (
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStudioModelCatalogAccountIdentityWrapperMatchesNativeHashOnly(t *testing.T) {
	proxy := int64(19)
	a := &Account{ID: 7, Platform: "openai", Type: "apikey", Credentials: map[string]any{"api_key": "fixture-secret-never-return", "base_url": "https://supplier.example/v1", "model_mapping": map[string]any{"alias": "old"}}, ProxyID: &proxy}
	before, err := json.Marshal(a)
	require.NoError(t, err)
	expected, err := studioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	actual, err := StudioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	require.Equal(t, expected, actual)
	require.Len(t, actual, 64)
	_, err = hex.DecodeString(actual)
	require.NoError(t, err)
	require.NotContains(t, actual, "fixture-secret-never-return")
	after, err := json.Marshal(a)
	require.NoError(t, err)
	require.Equal(t, string(before), string(after))
	a.Credentials["model_mapping"] = map[string]any{"alias": "changed"}
	aliased, err := StudioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	require.Equal(t, actual, aliased)
	for _, field := range []string{"api_key", "base_url"} {
		original := a.Credentials[field]
		a.Credentials[field] = "fixture-change-" + field
		changed, err := StudioModelCatalogAccountIdentity(a)
		require.NoError(t, err)
		require.NotEqual(t, actual, changed)
		a.Credentials[field] = original
	}
	proxy++
	changed, err := StudioModelCatalogAccountIdentity(a)
	require.NoError(t, err)
	require.NotEqual(t, actual, changed)
	_, err = StudioModelCatalogAccountIdentity(nil)
	require.ErrorIs(t, err, ErrAccountNilInput)
}

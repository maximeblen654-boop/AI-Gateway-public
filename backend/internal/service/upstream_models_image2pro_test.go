package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestImage2ProMediaMetadataPersistsIndependentlyOfCodexAndClearsMissing(t *testing.T) {
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, e)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	first := `{"data":[{"id":"public-video-fixture","metadata":` + string(f.Metadata) + `}]}`
	upstream := &httpUpstreamRecorder{responses: []*http.Response{
		{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(first))},
		{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"public-video-fixture","metadata":{"type":"video","protocol":"opaque-with-missing-limits"}}]}`))},
	}}
	repo := &upstreamModelMetadataRepoStub{}
	svc := &AccountTestService{accountRepo: repo, httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
	a := &Account{ID: 107, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1"}}
	catalog, e := svc.SyncUpstreamModelCatalog(context.Background(), a)
	require.NoError(t, e)
	require.Len(t, upstream.requests, 1, "media metadata must not fetch models.dev")
	require.NotNil(t, catalog.Metadata[f.Model].Image2ProVideo)
	saved, ok := a.GetUpstreamModelMetadata(f.Model)
	require.True(t, ok)
	require.Equal(t, "1080P", saved.Image2ProVideo.Size)
	require.Nil(t, saved.Reasoning)
	_, e = svc.SyncUpstreamModelCatalog(context.Background(), a)
	require.NoError(t, e)
	require.Len(t, upstream.requests, 2, "incomplete media metadata must not fetch models.dev")
	_, ok = a.GetUpstreamModelMetadata(f.Model)
	require.False(t, ok, "fresh incomplete metadata must revoke stale video capability")
	encoded, e := json.Marshal(repo.updates[UpstreamModelMetadataExtraKey])
	require.NoError(t, e)
	require.NotContains(t, string(encoded), "duration_min")
}

func TestSeedance2ObservedMetadataSyncPersistsWithoutSupplierSize(t *testing.T) {
	raw, err := os.ReadFile("../videoplan/testdata/image2pro_seedance2_video.json")
	require.NoError(t, err)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	body, err := json.Marshal(map[string]any{"data": []any{map[string]any{"id": f.Model, "metadata": f.Metadata}}})
	require.NoError(t, err)
	upstream := &httpUpstreamRecorder{responses: []*http.Response{{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(body)))}}}
	repo := &upstreamModelMetadataRepoStub{}
	svc := &AccountTestService{accountRepo: repo, httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
	a := &Account{ID: 77, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1"}}
	catalog, err := svc.SyncUpstreamModelCatalog(t.Context(), a)
	require.NoError(t, err)
	require.Len(t, upstream.requests, 1, "no registry fallback or generation")
	require.NotNil(t, catalog.Metadata[f.Model].Image2ProVideo)
	stored, ok := a.GetUpstreamModelMetadata(f.Model)
	require.True(t, ok)
	require.Empty(t, stored.Image2ProVideo.Size)
	require.Equal(t, 15, stored.Image2ProVideo.DurationMax)
	require.Equal(t, 9, stored.Image2ProVideo.MaxImages)
	require.True(t, a.GetUpstreamModelMetadataSnapshot().Image2ProSource.Matches(77, PlatformOpenAI, AccountTypeAPIKey, a.GetOpenAIBaseURL(), fmt.Sprintf("%x", sha256.Sum256([]byte("fixture-key")))))
}

func TestImage2ProObservedEntireMediaCatalogPreservesExactIDsAndTypes(t *testing.T) {
	raw, err := os.ReadFile("../videoplan/testdata/image2pro_public_media_20261023.json")
	require.NoError(t, err)
	var fixture struct {
		Data []struct {
			ID       string
			Metadata struct {
				Type     string
				Protocol string
			}
		}
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.Len(t, fixture.Data, 21)
	upstream := &httpUpstreamRecorder{responses: []*http.Response{{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw)))}}}
	repo := &upstreamModelMetadataRepoStub{}
	svc := &AccountTestService{accountRepo: repo, httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
	a := &Account{ID: 77, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1"}}
	catalog, err := svc.SyncUpstreamModelCatalog(t.Context(), a)
	require.NoError(t, err)
	require.Len(t, upstream.requests, 1, "media discovery must not generate or fetch text registry")
	require.Len(t, catalog.Metadata, 21)
	wantIDs := make([]string, 0, len(fixture.Data))
	counts := map[string]int{}
	for _, expected := range fixture.Data {
		wantIDs = append(wantIDs, expected.ID)
		counts[expected.Metadata.Type]++
		entry, found := catalog.Metadata[expected.ID]
		require.True(t, found, expected.ID)
		require.Equal(t, expected.ID, entry.ID)
		require.Equal(t, expected.Metadata.Type, entry.MediaType)
		if entry.MediaType == "video" {
			require.NotNil(t, entry.Image2ProVideo, expected.ID)
			require.True(t, entry.Image2ProVideo.Valid(), expected.ID)
			require.Equal(t, expected.Metadata.Protocol, entry.Image2ProVideo.Protocol)
			stored, found := a.GetUpstreamModelMetadata(expected.ID)
			require.True(t, found, expected.ID)
			require.Equal(t, entry.Image2ProVideo, stored.Image2ProVideo)
		} else {
			require.Nil(t, entry.Image2ProVideo, expected.ID)
		}
	}
	require.ElementsMatch(t, wantIDs, catalog.Models)
	require.Equal(t, map[string]int{"image": 19, "video": 2}, counts)
}

func TestImage2ProMetadataSourceBindsAccountEndpointAndCredential(t *testing.T) {
	a := &Account{ID: 107, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://api.image2pro.top/v1/"}}
	proof := NewUpstreamImage2ProMetadataSource(a, time.Now())
	require.NotNil(t, proof)
	require.True(t, proof.Matches(107, PlatformOpenAI, AccountTypeAPIKey, "https://API.IMAGE2PRO.TOP:443", proof.CredentialSHA256))
	for _, scenario := range []string{"account", "base", "key", "platform", "type", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			id, platform, accountType, base, fingerprint := int64(107), PlatformOpenAI, AccountTypeAPIKey, "https://api.image2pro.top/v1", proof.CredentialSHA256
			candidate := proof
			switch scenario {
			case "account":
				id = 108
			case "base":
				base = "https://other.example/v1"
			case "key":
				fingerprint = fmt.Sprintf("%x", sha256.Sum256([]byte("changed-key")))
			case "platform":
				platform = PlatformGrok
			case "type":
				accountType = AccountTypeOAuth
			case "missing":
				candidate = nil
			}
			require.False(t, candidate.Matches(id, platform, accountType, base, fingerprint))
		})
	}
	encoded, e := json.Marshal(proof)
	require.NoError(t, e)
	require.NotContains(t, string(encoded), "fixture-key")
}

func TestImage2ProMetadataNeverParsesOtherProviderVideoCapabilities(t *testing.T) {
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, e)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	body := `{"data":[{"id":"public-video-fixture","metadata":` + string(f.Metadata) + `}]}`
	upstream := &httpUpstreamRecorder{resp: &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}}
	repo := &upstreamModelMetadataRepoStub{}
	svc := &AccountTestService{accountRepo: repo, httpUpstream: upstream, cfg: upstreamModelSyncTestConfig()}
	account := &Account{ID: 107, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fixture-key", "base_url": "https://other.example/v1"}}
	catalog, e := svc.SyncUpstreamModelCatalog(t.Context(), account)
	require.NoError(t, e)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "video", catalog.Metadata[f.Model].MediaType)
	require.Nil(t, catalog.Metadata[f.Model].Image2ProVideo)
	_, ok := account.GetUpstreamModelMetadata(f.Model)
	require.False(t, ok)
	encoded, e := json.Marshal(repo.updates[UpstreamModelMetadataExtraKey])
	require.NoError(t, e)
	require.NotContains(t, string(encoded), "image2pro_source")
	require.NotContains(t, string(encoded), "max_images")
}

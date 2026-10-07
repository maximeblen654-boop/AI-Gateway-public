package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/stretchr/testify/require"
)

type loopbackReferenceHTTP struct{}

func (loopbackReferenceHTTP) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	return http.DefaultTransport.RoundTrip(req)
}
func (loopbackReferenceHTTP) DoWithTLS(req *http.Request, _ string, _ int64, _ int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return http.DefaultTransport.RoundTrip(req)
}

func TestHTTPAccountBoundReferenceUploaderUsesLocalHTTPInitAndResume(t *testing.T) {
	content := []byte("local-http-reference")
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	var chunks = map[string][]byte{}
	initCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/media/uploads" && r.Method == http.MethodPost {
			initCalls++
			require.Equal(t, "Bearer supplier-secret", r.Header.Get("Authorization"))
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			require.Equal(t, float64(len(content)), body["size"])
			require.Equal(t, digest, body["sha256"])
			require.Equal(t, "image/png", body["mime_type"])
			require.NotContains(t, body, "asset_ref")
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"u-local"}`)
			return
		}
		if r.URL.Path == "/v1/media/uploads/u-local" && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "u-local", "status": "uploading", "size": len(content), "sha256": digest, "chunk_size": 4, "chunk_count": (len(content) + 3) / 4, "received": []int{}})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/media/uploads/u-local/chunks/") && r.Method == http.MethodPut {
			idx := strings.TrimPrefix(r.URL.Path, "/v1/media/uploads/u-local/chunks/")
			b, _ := io.ReadAll(r.Body)
			chunks[idx] = b
			w.WriteHeader(http.StatusCreated)
			return
		}
		if r.URL.Path == "/v1/media/uploads/u-local/complete" && r.Method == http.MethodPost {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"complete","source":"https://supplier.invalid/r/1"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	core := &OpenAIGatewayService{httpUpstream: loopbackReferenceHTTP{}}
	account := &Account{ID: 7, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": server.URL, "api_key": "supplier-secret"}, Concurrency: 1}
	uploader := NewHTTPAccountBoundReferenceUploader(core)
	uploader.StateRoot = t.TempDir()
	input := StudioVideoReferenceAsset{AssetRef: "asset-1", Kind: "image", MimeType: "image/png", Size: len(content), SHA256: digest}
	receipt, err := uploader.Upload(context.Background(), account, StudioImageOwner{UserID: 1}, mediaworkbench.Offer{OfferID: "offer-1"}, input, content)
	require.NoError(t, err)
	require.Equal(t, "u-local", receipt.UploadID)
	restarted := NewHTTPAccountBoundReferenceUploader(core)
	restarted.StateRoot = uploader.StateRoot
	receipt, err = restarted.Upload(context.Background(), account, StudioImageOwner{UserID: 1}, mediaworkbench.Offer{OfferID: "offer-1"}, input, content)
	require.NoError(t, err)
	require.Equal(t, "u-local", receipt.UploadID)
	require.Equal(t, 1, initCalls)
}

func TestReferenceUploaderUnknownInitAndLostComplete(t *testing.T) {
	for _, fault := range []string{"init", "complete"} {
		t.Run(fault, func(t *testing.T) {
			content := []byte("fault-recovery-content")
			digest := fmt.Sprintf("%x", sha256.Sum256(content))
			inits, completes := 0, 0
			done := false
			received := []int{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				lose := func() {
					hijacker, ok := w.(http.Hijacker)
					require.True(t, ok, "local HTTP fixture must support response loss")
					conn, _, e := hijacker.Hijack()
					require.NoError(t, e)
					require.NoError(t, conn.Close())
				}
				switch {
				case r.Method == "POST" && r.URL.Path == "/v1/media/uploads":
					inits++
					if fault == "init" {
						lose()
						return
					}
					_, _ = io.WriteString(w, `{"id":"same-upload"}`)
				case r.Method == "GET" && r.URL.Path == "/v1/media/uploads/same-upload":
					status := "uploading"
					source := ""
					if done {
						status = "complete"
						source = "https://supplier.invalid/same"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "same-upload", "status": status, "source": source, "size": len(content), "sha256": digest, "chunk_size": len(content), "chunk_count": 1, "received": received})
				case r.Method == "PUT" && r.URL.Path == "/v1/media/uploads/same-upload/chunks/0":
					require.Equal(t, "application/octet-stream", r.Header.Get("Content-Type"))
					body, e := io.ReadAll(r.Body)
					require.NoError(t, e)
					require.Equal(t, content, body)
					received = []int{0}
					w.WriteHeader(200)
				case r.Method == "POST" && r.URL.Path == "/v1/media/uploads/same-upload/complete":
					completes++
					done = true
					lose()
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					w.WriteHeader(400)
				}
			}))
			defer server.Close()
			core := &OpenAIGatewayService{httpUpstream: loopbackReferenceHTTP{}}
			a := &Account{ID: 7, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": server.URL, "api_key": "isolated-dummy"}, Concurrency: 1}
			owner := StudioImageOwner{UserID: 1}
			asset := StudioVideoReferenceAsset{AssetRef: "asset-fault", Kind: "image", MimeType: "image/png", Size: len(content), SHA256: digest}
			u := NewHTTPAccountBoundReferenceUploader(core)
			u.StateRoot = t.TempDir()
			_, e := u.Upload(context.Background(), a, owner, mediaworkbench.Offer{}, asset, content)
			require.Error(t, e)
			restart := NewHTTPAccountBoundReferenceUploader(core)
			restart.StateRoot = u.StateRoot
			r, e := restart.Upload(context.Background(), a, owner, mediaworkbench.Offer{}, asset, content)
			if fault == "init" {
				require.ErrorContains(t, e, "init unknown")
				require.Zero(t, completes)
			} else {
				require.NoError(t, e)
				require.Equal(t, "same-upload", r.UploadID)
				require.Equal(t, 1, completes)
				saved, e := restart.loadState(7, asset.AssetRef, digest)
				require.NoError(t, e)
				require.Equal(t, "complete", saved.Status)
				_, e = restart.Upload(context.Background(), a, StudioImageOwner{UserID: 2}, mediaworkbench.Offer{}, asset, content)
				require.ErrorContains(t, e, "identity changed")
				a.Credentials["api_key"] = "changed"
				_, e = restart.Upload(context.Background(), a, owner, mediaworkbench.Offer{}, asset, content)
				require.ErrorContains(t, e, "identity changed")
			}
			require.Equal(t, 1, inits)
		})
	}
}

func TestReferenceStateExclusiveCreateAndUpdateErrors(t *testing.T) {
	u := &HTTPAccountBoundReferenceUploader{StateRoot: t.TempDir()}
	st := referenceUploadState{AccountID: 7, AssetRef: "asset", SHA256: strings.Repeat("a", 64), Status: "initializing"}
	require.NoError(t, u.saveState(st, true))
	st.Status = "corrupt"
	require.Error(t, u.saveState(st, true))
	old, e := u.loadState(7, st.AssetRef, st.SHA256)
	require.NoError(t, e)
	require.Equal(t, "initializing", old.Status)
	st.Status = "uploading"
	st.UploadID = "original"
	require.NoError(t, u.saveState(st, false))
	old, e = u.loadState(7, st.AssetRef, st.SHA256)
	require.NoError(t, e)
	require.Equal(t, "original", old.UploadID)
	target := u.statePath(7, st.AssetRef, st.SHA256)
	require.NoError(t, os.Remove(target))
	require.NoError(t, os.Mkdir(target, 0700))
	require.Error(t, u.saveState(st, false))
	u.StateRoot = ""
	require.Error(t, u.saveState(st, true))
}

func TestReferenceUploaderMissingProxyNeverUsesDirectConnection(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }))
	defer s.Close()
	id := int64(42)
	a := &Account{ID: 7, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, ProxyID: &id, Credentials: map[string]any{"base_url": s.URL, "api_key": "isolated-dummy"}}
	u := NewHTTPAccountBoundReferenceUploader(&OpenAIGatewayService{httpUpstream: loopbackReferenceHTTP{}})
	u.StateRoot = t.TempDir()
	b := []byte("local-proxy-check")
	_, e := u.Upload(context.Background(), a, StudioImageOwner{UserID: 1}, mediaworkbench.Offer{}, StudioVideoReferenceAsset{AssetRef: "asset-proxy", Kind: "image", MimeType: "image/png", Size: len(b), SHA256: fmt.Sprintf("%x", sha256.Sum256(b))}, b)
	require.Error(t, e)
	require.Zero(t, calls)
}

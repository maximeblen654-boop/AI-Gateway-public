package service

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLaoliVideoContentDocumentedHeaders(t *testing.T) {
	for _, tc := range []struct {
		name, base, mime string
		status           int
		partial, wantOK  bool
	}{
		{"documented-original", "https://video.laoliimage2.win/v1", "video/mp4", 200, false, true},
		{"mime-parameters", "https://video.laoliimage2.win", "video/webm; charset=binary", 200, false, true},
		{"other-supplier-unchanged", "https://other.example/v1", "video/mp4", 200, false, false},
		{"partial-rejected", "https://video.laoliimage2.win/v1", "video/mp4", 206, true, false},
		{"json-rejected", "https://video.laoliimage2.win/v1", "application/json", 200, false, false},
		{"redirect-rejected", "https://video.laoliimage2.win/v1", "video/mp4", 302, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _, _, accounts, _ := videoRuntimeFixture(t)
			accounts.a.Credentials["base_url"] = tc.base
			r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
				require.Equal(t, http.MethodGet, req.Method)
				require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
				require.Nil(t, req.GetBody)
				resp := image2ProResponse(tc.status, tc.mime, []byte("mock-original-bytes"))
				if tc.partial {
					resp.Header.Set("Content-Range", "bytes 0-1/20")
				}
				return resp, nil
			}}
			data, ct, err := r.requestHTTP(context.Background(), accounts.a, http.MethodGet, "/videos/original/content", nil)
			if tc.wantOK {
				require.NoError(t, err)
				require.Equal(t, "mock-original-bytes", string(data))
				require.NotContains(t, ct, ";")
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestLaoliSubmissionRecoveryUsesHeader(t *testing.T) {
	r, _, _, _, accounts, _ := videoRuntimeFixture(t)
	accounts.a.Credentials["base_url"] = "https://video.laoliimage2.win/v1"
	id := "av_" + strings.Repeat("a", 32)
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
		require.Equal(t, http.MethodGet, req.Method)
		require.Equal(t, "/v1/video-submissions/current", req.URL.Path)
		require.Empty(t, req.URL.RawQuery)
		require.Equal(t, id, req.Header.Get("Idempotency-Key"))
		return image2ProResponse(200, "application/json", []byte(`{"id":"original-task"}`)), nil
	}}
	ctx := context.WithValue(t.Context(), videoIdempotencyContextKey{}, id)
	_, _, err := r.requestHTTP(ctx, accounts.a, http.MethodGet, "/video-submissions/current", nil)
	require.NoError(t, err)
}

func TestLaoliLostReceiptRecoversWithoutResubmitOrSettlement(t *testing.T) {
	for _, tc := range []struct {
		name, receipt string
		wantOK        bool
	}{
		{"found", `{"id":"original-task"}`, true},
		{"malformed", `{"status":"queued"}`, false},
		{"conflicting-ids", `{"id":"task-a","data":{"id":"task-b"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, q, _, accounts, orders := videoRuntimeFixture(t)
			accounts.a.Credentials["base_url"] = "https://video.laoliimage2.win/v1"
			q.Binding.BaseURL = studioMediaBaseURL(accounts.a)
			q.BindingHash = q.Binding.Hash()
			id := "av_" + strings.Repeat("b", 32)
			task := StudioVideoTask{ID: id, TokenHash: HashUsageRequestPayload([]byte("original-token")), Quote: q}
			_, err := r.Store.Claim(task)
			require.NoError(t, err)
			_, err = orders.ReserveStudioVideoOrder(t.Context(), &StudioVideoReserveCommand{ChildID: id, UserID: q.Binding.Owner.UserID, APIKeyID: q.Binding.Owner.APIKeyID, GroupID: q.Binding.Owner.GroupID, QuoteID: q.Binding.QuoteID, CapabilityVersion: q.Binding.CapabilityVersion(), RequestHash: q.Binding.RequestHash, HoldAmount: 0.8, Binding: &q.Binding})
			require.NoError(t, err)
			_, err = r.Store.DispatchClaim(id)
			require.NoError(t, err)
			gets := 0
			r.request = func(ctx context.Context, _ *Account, method, path string, body []byte) ([]byte, string, error) {
				require.Equal(t, http.MethodGet, method)
				require.Nil(t, body)
				gets++
				if path == "/video-submissions/current" {
					require.Equal(t, id, ctx.Value(videoIdempotencyContextKey{}))
					return []byte(tc.receipt), "application/json", nil
				}
				require.Equal(t, "/videos/original-task", path)
				return []byte(`{"id":"original-task","status":"in_progress"}`), "application/json", nil
			}
			state, err := r.Recover(t.Context(), q.Binding.Owner, id)
			if tc.wantOK {
				require.NoError(t, err)
				require.Equal(t, "accepted", state.Status)
				state, err = r.Recover(t.Context(), q.Binding.Owner, id)
				require.NoError(t, err)
				require.Equal(t, "processing", state.Status)
				require.Equal(t, 2, gets)
			} else {
				require.Error(t, err)
				require.Equal(t, "unknown", state.Status)
			}
			require.Equal(t, 1, orders.reserves)
			require.Zero(t, orders.captures)
			require.Equal(t, StudioVideoHeld, orders.orders[id].State)
		})
	}
}

func TestLaoliVideoMultipartUsesRepeatedTypedFiles(t *testing.T) {
	fixture := map[string]any{"model": "sd-native-full-2.0", "prompt": "follow the subject", "seconds": 8, "resolution": "720p", "aspect_ratio": "16:9", "reference_images": []string{"data:image/png;base64,YWJjZGVmZ2g=", "data:image/jpeg;base64,aWprbG1ub3A="}, "reference_audios": []string{"data:audio/mpeg;base64,cXJzdHV2d3g="}}
	body, err := json.Marshal(fixture)
	require.NoError(t, err)
	wire, ct, err := laoliVideoMultipart(body)
	require.NoError(t, err)
	mt, params, err := mime.ParseMediaType(ct)
	require.NoError(t, err)
	require.Equal(t, "multipart/form-data", mt)
	reader := multipart.NewReader(bytes.NewReader(wire), params["boundary"])
	images, audios := 0, 0
	for {
		p, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		b, err := io.ReadAll(p)
		require.NoError(t, err)
		switch p.FormName() {
		case "reference_images":
			images++
			require.NotEmpty(t, p.FileName())
			require.True(t, strings.HasPrefix(p.Header.Get("Content-Type"), "image/"))
			require.Len(t, b, 8)
		case "reference_audios":
			audios++
			require.Equal(t, "audio/mpeg", p.Header.Get("Content-Type"))
			require.Equal(t, "qrstuvwx", string(b))
		case "model":
			require.Equal(t, "sd-native-full-2.0", string(b))
		case "seconds":
			require.Equal(t, "8", string(b))
		}
	}
	require.Equal(t, 2, images)
	require.Equal(t, 1, audios)
	fixture["reference_images"] = []string{"data:audio/mpeg;base64,YWJjZGVmZ2g="}
	body, _ = json.Marshal(fixture)
	_, _, err = laoliVideoMultipart(body)
	require.Error(t, err)
}

func TestLaoliAccountTestCannotGenerate(t *testing.T) {
	for _, base := range []string{"https://video.laoliimage2.win", "https://video.laoliimage2.win/v1"} {
		require.True(t, MeteredAccountTestsDisabled(&Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": base}}))
	}
	for _, base := range []string{"https://video.laoliimage2.win.evil.example", "https://other.example/v1"} {
		require.False(t, MeteredAccountTestsDisabled(&Account{Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Credentials: map[string]any{"base_url": base}}))
	}
}

func TestLaoliVideoHTTPMultipartIsScopedToFrozenRevision(t *testing.T) {
	for _, tc := range []struct {
		name, base, revision     string
		wantMultipart, wantError bool
	}{
		{"new-contract", "https://video.laoliimage2.win/v1", videoplan.LaoliMediaRevision, true, false},
		{"ordinary-openai", "https://other.example/v1", "generic-frozen-revision", false, false},
		{"wrong-supplier", "https://other.example/v1", videoplan.LaoliMediaRevision, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _, _, accounts, _ := videoRuntimeFixture(t)
			accounts.a.Credentials["base_url"] = tc.base
			calls := 0
			body := []byte(`{"model":"3.0","prompt":"a scene","seconds":6,"resolution":"720p","aspect_ratio":"16:9","reference_images":["data:image/png;base64,YWJjZGVmZ2g="]}`)
			r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
				calls++
				require.Equal(t, http.MethodPost, req.Method)
				require.Nil(t, req.GetBody)
				require.Equal(t, "av_0123456789abcdef", req.Header.Get("Idempotency-Key"))
				ct := req.Header.Get("Content-Type")
				if tc.wantMultipart {
					require.True(t, strings.HasPrefix(ct, "multipart/form-data;"))
					require.NoError(t, req.ParseMultipartForm(1<<20))
					require.Equal(t, "6", req.FormValue("seconds"))
					require.Len(t, req.MultipartForm.File["reference_images"], 1)
				} else {
					require.Equal(t, "application/json", ct)
					got, e := io.ReadAll(req.Body)
					require.NoError(t, e)
					require.Equal(t, body, got)
				}
				return image2ProResponse(200, "application/json", []byte(`{"id":"original-task"}`)), nil
			}}
			ctx := context.WithValue(t.Context(), videoPlanRevisionContextKey{}, tc.revision)
			ctx = context.WithValue(ctx, videoIdempotencyContextKey{}, "av_0123456789abcdef")
			_, _, err := r.requestHTTP(ctx, accounts.a, http.MethodPost, "/videos", body)
			if tc.wantError {
				require.Error(t, err)
				require.Zero(t, calls)
			} else {
				require.NoError(t, err)
				require.Equal(t, 1, calls)
			}
		})
	}
}

package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
)

const image2ProVideoFixtureID = "a1b2c3d4e5f6789012345678"

func image2ProVideoRuntimeFixture(t *testing.T) (*StudioVideoRuntime, string, StudioVideoQuote, *APIKey, *studioAccountFixture, *videoOrderFixture) {
	t.Helper()
	r, _, _, key, accounts, orders := videoRuntimeFixture(t)
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, e)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	caps, e := videoplan.DecodeImage2ProCapabilities(f.Metadata)
	require.NoError(t, e)
	accounts.a.Credentials["base_url"] = "https://api.image2pro.top/v1"
	accounts.a.Credentials["model_mapping"] = map[string]any{}
	ma := &studioMediaFixture{a: mediaworkbench.Account{ID: 7, Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true, BaseURL: "https://api.image2pro.top/v1", Catalog: &mediaworkbench.Catalog{Models: []string{f.Model}, SyncedAt: "fixture"}, Image2ProVideoCapabilities: map[string]videoplan.Image2ProCapabilities{f.Model: *caps}}}
	svc := mediaworkbench.NewService(ma)
	p := mediaworkbench.Product{ProductID: "fixture-video", MediaType: "video", SiteModel: f.Model, UpstreamModel: f.Model, Enabled: true, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"1080P"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5}, Count: mediaworkbench.Range{Min: 1, Max: 1}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 2}, Audio: mediaworkbench.Range{Max: 1}, Video: mediaworkbench.Range{Max: 1}, TotalMax: 4}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "4", Currency: "CNY", BillingMode: "per_request"}}}}
	d, e := svc.SaveDraft(t.Context(), 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, e)
	require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
	d, e = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, e)
	_, e = svc.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	require.NoError(t, e)
	r.Media = ma
	spec := mediaworkbench.Spec{Count: 1, Resolution: "1080P", AspectRatio: "16:9", DurationSeconds: 5}
	body := []byte(`{"model":"public-video-fixture","prompt":"A steady camera follows the subject.","duration":5,"ratio":"16:9"}`)
	token, q, e := r.Issue(t.Context(), StudioImageOwner{1, 2, 3}, key, ma.a.Config.Published.Offers[0].OfferID, spec, body)
	require.NoError(t, e)
	return r, token, q, key, accounts, orders
}

func image2ProResponse(status int, ct string, body []byte) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {ct}}, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body))}
}

func TestImage2ProVideoHTTPSubmitOnceRecoverAndOriginalURL(t *testing.T) {
	r, token, q, key, _, orders := image2ProVideoRuntimeFixture(t)
	posts, gets, downloads := 0, 0, 0
	original := []byte("fixture-original-mp4-bytes")
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, accountID int64) (*http.Response, error) {
		require.Equal(t, int64(7), accountID)
		require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
		switch req.URL.Host + req.URL.Path {
		case "api.image2pro.top/v1/videos":
			require.Equal(t, http.MethodPost, req.Method)
			posts++
			require.Equal(t, "av_image2pro_once", req.Header.Get("Idempotency-Key"))
			require.Equal(t, "Bearer synthetic-only", req.Header.Get("Authorization"))
			require.Nil(t, req.GetBody)
			body, e := io.ReadAll(req.Body)
			require.NoError(t, e)
			require.Equal(t, q.Plan.Body, body)
			require.NotContains(t, string(body), "resolution")
			return image2ProResponse(200, "application/json", []byte(`{"id":"`+image2ProVideoFixtureID+`","status":"processing"}`)), nil
		case "api.image2pro.top/v1/videos/" + image2ProVideoFixtureID:
			require.Equal(t, http.MethodGet, req.Method)
			gets++
			return image2ProResponse(200, "application/json", []byte(`{"id":"`+image2ProVideoFixtureID+`","status":"completed","url":"https://media.example/original.mp4"}`)), nil
		case "media.example/original.mp4":
			downloads++
			require.Equal(t, http.MethodGet, req.Method)
			require.Empty(t, req.Header.Get("Authorization"))
			require.Empty(t, req.Header.Get("Cookie"))
			require.True(t, HTTPUpstreamPublicHostsOnly(req.Context()))
			return image2ProResponse(200, "video/mp4", original), nil
		default:
			t.Fatalf("undocumented supplier endpoint %s %s", req.Method, req.URL.Path)
			return nil, ErrStudioVideoConflict
		}
	}}
	state, e := r.Submit(t.Context(), q.Binding.Owner, key, token, "av_image2pro_once")
	require.NoError(t, e)
	require.Equal(t, "accepted", state.Status)
	// Current sale/capability changes cannot redirect historical recovery.
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	ma.a.Config.Sales.Enabled = false
	ma.a.Image2ProVideoCapabilities = nil
	state, e = r.Submit(t.Context(), q.Binding.Owner, key, token, "av_image2pro_once")
	require.NoError(t, e)
	require.Equal(t, "completed", state.Status)
	data, ct, e := r.Original(t.Context(), q.Binding.Owner, "av_image2pro_once")
	require.NoError(t, e)
	require.Equal(t, original, data)
	require.Equal(t, "video/mp4", ct)
	require.Zero(t, orders.captures)
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	_, e = r.Capture(t.Context(), q.Binding.Owner, "av_image2pro_once", digest, testStudioVideoRetention(q))
	require.NoError(t, e)
	_, e = r.Capture(t.Context(), q.Binding.Owner, "av_image2pro_once", digest, testStudioVideoRetention(q))
	require.NoError(t, e)
	require.Equal(t, 1, posts)
	require.Equal(t, 2, gets)
	require.Equal(t, 1, downloads)
	require.Equal(t, 1, orders.reserves)
	require.Equal(t, 1, orders.captures)
}

func TestImage2ProVideoHTTPUnknownErrorRetainsSafeEvidenceAndNeverReposts(t *testing.T) {
	r, token, q, key, _, orders := image2ProVideoRuntimeFixture(t)
	posts := 0
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
		posts++
		require.Equal(t, http.MethodPost, req.Method)
		return image2ProResponse(400, "application/json", []byte(`{"error":{"code":"invalid_parameter","message":"do-not-log-fixture-secret"}}`)), nil
	}}
	_, e := r.Submit(t.Context(), q.Binding.Owner, key, token, "av_image2pro_error")
	require.ErrorIs(t, e, ErrStudioVideoUnknown)
	var safe *StudioVideoImage2ProHTTPError
	require.ErrorAs(t, e, &safe)
	require.Equal(t, 400, safe.Status)
	require.Empty(t, safe.Code)
	require.NotContains(t, e.Error(), "do-not-log-fixture-secret")
	var stored StudioVideoImage2ProHTTPError
	require.NoError(t, studioRead(r.Store.path("request-error", "av_image2pro_error"), &stored))
	require.Equal(t, *safe, stored)
	for i := 0; i < 2; i++ {
		state, e := r.Submit(t.Context(), q.Binding.Owner, key, token, "av_image2pro_error")
		require.NoError(t, e)
		require.Equal(t, "unknown", state.Status)
	}
	require.Equal(t, 1, posts)
	require.Zero(t, orders.captures)
}

func TestImage2ProVideoOriginalRejectsUnsafeOrIncompleteResult(t *testing.T) {
	for _, scenario := range []string{"id", "status", "missing_url", "http", "userinfo", "private", "redirect", "partial", "short", "mime"} {
		t.Run(scenario, func(t *testing.T) {
			r, token, q, key, _, orders := image2ProVideoRuntimeFixture(t)
			downloads := 0
			r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
				if req.Method == http.MethodPost {
					return image2ProResponse(200, "application/json", []byte(`{"id":"`+image2ProVideoFixtureID+`","status":"processing"}`)), nil
				}
				if req.URL.Host == "api.image2pro.top" {
					status, id, uri := "completed", image2ProVideoFixtureID, "https://media.example/original.mp4"
					switch scenario {
					case "id":
						id = "0000000000000000"
					case "status":
						status = "processing"
					case "missing_url":
						uri = ""
					case "http":
						uri = "http://media.example/original.mp4"
					case "userinfo":
						uri = "https://user:secret@media.example/original.mp4"
					case "private":
						uri = "https://127.0.0.1/original.mp4"
					}
					raw, _ := json.Marshal(map[string]string{"id": id, "status": status, "url": uri})
					return image2ProResponse(200, "application/json", raw), nil
				}
				downloads++
				resp := image2ProResponse(200, "video/mp4", []byte("incomplete-or-invalid-video"))
				switch scenario {
				case "redirect":
					resp.StatusCode = 302
					resp.Header.Set("Location", "https://evil.example/other")
				case "partial":
					resp.StatusCode = 206
					resp.Header.Set("Content-Range", "bytes 0-10/100")
				case "short":
					resp.ContentLength += 100
				case "mime":
					resp.Header.Set("Content-Type", "text/html")
				}
				return resp, nil
			}}
			_, e := r.Submit(t.Context(), q.Binding.Owner, key, token, "av_image2pro_result")
			require.NoError(t, e)
			_, _, e = r.Original(t.Context(), q.Binding.Owner, "av_image2pro_result")
			require.Error(t, e)
			require.Zero(t, orders.captures)
			if scenario == "id" || scenario == "status" || scenario == "missing_url" || scenario == "http" || scenario == "userinfo" || scenario == "private" {
				require.Zero(t, downloads)
			} else {
				require.Equal(t, 1, downloads)
			}
		})
	}
}

func image2ProAsset(kind, mime, ref string, b []byte) StudioVideoReferenceAsset {
	return StudioVideoReferenceAsset{Kind: kind, MimeType: mime, AssetRef: ref, Size: len(b), SHA256: fmt.Sprintf("%x", sha256.Sum256(b)), BytesBase64: base64.StdEncoding.EncodeToString(b)}
}

func TestImage2ProReferenceRawUploadAndAccountModelOwnerCache(t *testing.T) {
	r, _, q, _, accounts, _ := image2ProVideoRuntimeFixture(t)
	uploader := NewHTTPAccountBoundReferenceUploader(r.Core)
	uploader.StateRoot = t.TempDir()
	asset := image2ProAsset("audio", "audio/mpeg", "audio-fixture", []byte("ID3-public-fixture-audio"))
	content, _ := base64.StdEncoding.DecodeString(asset.BytesBase64)
	calls := 0
	expectedModel := q.Binding.Offer.UpstreamModel
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, accountID int64) (*http.Response, error) {
		calls++
		require.Equal(t, int64(7), accountID)
		require.Equal(t, "api.image2pro.top", req.URL.Host)
		require.Equal(t, "/api/v1/reference-media", req.URL.Path)
		require.Equal(t, "audio", req.URL.Query().Get("kind"))
		require.Equal(t, expectedModel, req.URL.Query().Get("model"))
		require.NotEmpty(t, req.URL.Query().Get("name"))
		require.Equal(t, "audio/mpeg", req.Header.Get("Content-Type"))
		require.Equal(t, int64(len(content)), req.ContentLength)
		require.Equal(t, "Bearer synthetic-only", req.Header.Get("Authorization"))
		require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
		require.Nil(t, req.GetBody)
		body, e := io.ReadAll(req.Body)
		require.NoError(t, e)
		require.Equal(t, content, body)
		response, _ := json.Marshal(map[string]any{"ok": true, "mediaId": fmt.Sprintf("media-fixture-%d", calls), "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
		return image2ProResponse(200, "application/json", response), nil
	}}
	receipt, e := uploader.Upload(t.Context(), accounts.a, q.Binding.Owner, q.Binding.Offer, asset, content)
	require.NoError(t, e)
	require.Equal(t, "media_id", receipt.SourceKind)
	require.NotEmpty(t, receipt.MediaID)
	require.Empty(t, receipt.Source)
	require.Empty(t, receipt.UploadID)
	require.True(t, receipt.ExpiresAt.After(time.Now()))
	again, e := uploader.Upload(t.Context(), accounts.a, q.Binding.Owner, q.Binding.Offer, asset, content)
	require.NoError(t, e)
	require.Equal(t, receipt.MediaID, again.MediaID)
	require.Equal(t, 1, calls)
	badAccount := *accounts.a
	badAccount.ID = 8
	_, e = uploader.Upload(t.Context(), &badAccount, q.Binding.Owner, q.Binding.Offer, asset, content)
	require.Error(t, e)
	require.Equal(t, 1, calls)
	otherModel := q.Binding.Offer
	otherModel.UpstreamModel = "另一个公开模型"
	expectedModel = otherModel.UpstreamModel
	other, e := uploader.Upload(t.Context(), accounts.a, q.Binding.Owner, otherModel, asset, content)
	require.NoError(t, e)
	require.NotEqual(t, receipt.MediaID, other.MediaID)
	require.Equal(t, 2, calls)
	otherOwner := q.Binding.Owner
	otherOwner.APIKeyID = 99
	_, e = uploader.Upload(t.Context(), accounts.a, otherOwner, otherModel, asset, content)
	require.NoError(t, e)
	require.Equal(t, 3, calls, "private upload cache must bind the complete owner")
	receipt.ExpiresAt = time.Now().Add(-time.Second)
	require.Error(t, validateImage2ProReferenceReceipt(asset, receipt, time.Now()))
}

func TestImage2ProReferencePreparationInlineImagesAndQuoteIntegrity(t *testing.T) {
	r, _, q, key, _, orders := image2ProVideoRuntimeFixture(t)
	uploader := NewHTTPAccountBoundReferenceUploader(r.Core)
	uploader.StateRoot = t.TempDir()
	r.SetReferenceUploader(uploader)
	uploads := 0
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
		uploads++
		require.Equal(t, "audio", req.URL.Query().Get("kind"), "inline images must never call the attachment upload endpoint")
		response, _ := json.Marshal(map[string]any{"ok": true, "mediaId": "prepared-audio-id", "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
		return image2ProResponse(200, "application/json", response), nil
	}}
	imageBytes := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	image := image2ProAsset("image", "image/png", "image-fixture", imageBytes)
	audio := image2ProAsset("audio", "audio/mpeg", "audio-fixture", []byte("ID3-reference-fixture"))
	spec := q.Binding.Spec
	spec.Images = 1
	spec.Audio = 1
	prep, e := r.PrepareReferenceAssets(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, []StudioVideoReferenceAsset{audio, image})
	require.NoError(t, e)
	require.Len(t, prep.Receipts, 2)
	require.Equal(t, 1, uploads)
	require.Equal(t, "media_id", prep.Receipts[0].SourceKind)
	require.Equal(t, "inline", prep.Receipts[1].SourceKind)
	require.Empty(t, prep.Receipts[1].Source)
	require.Empty(t, prep.Receipts[1].MediaID)
	body := []byte(`{"model":"public-video-fixture","prompt":"Follow the subject.","duration":5,"ratio":"16:9","images":["data:image/png;base64,iVBORw0KGgo="],"audios":[{"mediaId":"prepared-audio-id"}]}`)
	_, _, e = r.Issue(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, body)
	require.Error(t, e, "real references always require account-bound preparation")
	token, quoted, e := r.IssueWithPreparation(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, body, prep.PreparationID)
	require.NoError(t, e)
	require.NotEmpty(t, token)
	require.Equal(t, quoted.Plan.RequestHash, quoted.Binding.RequestHash)
	for _, replacement := range []string{strings.Replace(string(body), "prepared-audio-id", "foreign-account-or-model-id", 1), strings.Replace(string(body), "iVBORw0KGgo=", "iVBORw0KGgs=", 1)} {
		_, _, e = r.IssueWithPreparation(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, []byte(replacement), prep.PreparationID)
		require.Error(t, e)
	}
	record, e := r.Store.ReferencePreparation(prep.PreparationID, q.Binding.Owner)
	require.NoError(t, e)
	record.Receipts[0].ExpiresAt = time.Now().Add(-time.Second)
	require.NoError(t, r.Store.UpdateReferencePreparation(record))
	_, _, e = r.IssueWithPreparation(t.Context(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, body, prep.PreparationID)
	require.Error(t, e, "expired media IDs must be refused even when a final quote was previously cached")
	require.Equal(t, 1, uploads)
	require.Zero(t, orders.reserves)
	require.Zero(t, orders.captures)
}

func TestImage2ProHTTPErrorOnlyExposesDocumentedSafeCode(t *testing.T) {
	for _, code := range []string{"sk_fixture_secret_value", "token.fake.secret", "ordinary_business_identifier", "invalid_parameter", "invalid_request_error"} {
		body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": "sk_fixture_message_secret_value"}})
		safe := newImage2ProHTTPError(400, body)
		if code == "invalid_request_error" {
			require.Equal(t, code, safe.Code)
		} else {
			require.Empty(t, safe.Code)
			require.NotContains(t, safe.Error(), code)
		}
		encoded, e := json.Marshal(safe)
		require.NoError(t, e)
		require.NotContains(t, string(encoded), "sk_fixture_message_secret_value")
		require.NotContains(t, safe.Error(), "sk_fixture_message_secret_value")
		require.Len(t, safe.ResponseSHA256, 64)
	}
}

func TestImage2ProExpiredQuotedPreparationCreatesImmutableGeneration(t *testing.T) {
	for _, submitted := range []bool{false, true} {
		t.Run(fmt.Sprintf("unknown_dispatch_%t", submitted), func(t *testing.T) {
			r, _, initial, key, _, orders := image2ProVideoRuntimeFixture(t)
			now := time.Now().UTC()
			r.Store.clock = func() time.Time { return now }
			image := image2ProAsset("image", "image/png", "image-generation-fixture", []byte{137, 80, 78, 71, 13, 10, 26, 10})
			spec := initial.Binding.Spec
			spec.Images = 1
			first, e := r.PrepareReferenceAssets(t.Context(), initial.Binding.Owner, key, initial.Binding.Offer.OfferID, spec, []StudioVideoReferenceAsset{image})
			require.NoError(t, e)
			body := []byte(`{"model":"public-video-fixture","prompt":"Follow the subject.","duration":5,"ratio":"16:9","images":["data:image/png;base64,iVBORw0KGgo="]}`)
			oldToken, oldQuote, e := r.IssueWithPreparation(t.Context(), initial.Binding.Owner, key, initial.Binding.Offer.OfferID, spec, body, first.PreparationID)
			require.NoError(t, e)
			originalPrep, e := os.ReadFile(r.Store.path("reference-preparation", first.PreparationID))
			require.NoError(t, e)
			originalQuote, e := os.ReadFile(r.Store.path("quote", oldToken))
			require.NoError(t, e)
			posts := 0
			var originalTask []byte
			if submitted {
				r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
					posts++
					return nil, "", errors.New("synthetic lost response")
				}
				_, e = r.Submit(t.Context(), initial.Binding.Owner, key, oldToken, "av_image2pro_expired_unknown")
				require.ErrorIs(t, e, ErrStudioVideoUnknown)
				originalTask, e = os.ReadFile(r.Store.path("task", "av_image2pro_expired_unknown"))
				require.NoError(t, e)
			}
			now = oldQuote.Binding.ExpiresAt.Add(time.Second)
			var group sync.WaitGroup
			type preparedResult struct {
				p StudioVideoReferencePreparationResult
				e error
			}
			results := make(chan preparedResult, 8)
			for i := 0; i < 8; i++ {
				group.Add(1)
				go func() {
					defer group.Done()
					p, e := r.PrepareReferenceAssets(t.Context(), initial.Binding.Owner, key, initial.Binding.Offer.OfferID, spec, []StudioVideoReferenceAsset{image})
					results <- preparedResult{p, e}
				}()
			}
			group.Wait()
			close(results)
			nextID := ""
			for result := range results {
				require.NoError(t, result.e)
				if nextID == "" {
					nextID = result.p.PreparationID
				}
				require.Equal(t, nextID, result.p.PreparationID)
			}
			require.NotEqual(t, first.PreparationID, nextID)
			generation, e := r.Store.ReferencePreparation(nextID, initial.Binding.Owner)
			require.NoError(t, e)
			require.Equal(t, 1, generation.Generation)
			require.Empty(t, generation.FinalQuoteToken)
			latest, e := r.Store.FindReferencePreparation(initial.Binding.Owner, initial.Binding.Offer.OfferID, generation.AssetIntentHash, spec)
			require.NoError(t, e)
			require.Equal(t, nextID, latest.ID)
			newToken, newQuote, e := r.IssueWithPreparation(t.Context(), initial.Binding.Owner, key, initial.Binding.Offer.OfferID, spec, body, nextID)
			require.NoError(t, e)
			require.NotEqual(t, oldToken, newToken)
			require.True(t, newQuote.Binding.ExpiresAt.After(now))
			again, _, e := r.IssueWithPreparation(t.Context(), initial.Binding.Owner, key, initial.Binding.Offer.OfferID, spec, body, nextID)
			require.NoError(t, e)
			require.Equal(t, newToken, again)
			afterPrep, e := os.ReadFile(r.Store.path("reference-preparation", first.PreparationID))
			require.NoError(t, e)
			require.Equal(t, originalPrep, afterPrep)
			afterQuote, e := os.ReadFile(r.Store.path("quote", oldToken))
			require.NoError(t, e)
			require.Equal(t, originalQuote, afterQuote)
			if submitted {
				state, e := r.Submit(t.Context(), initial.Binding.Owner, key, oldToken, "av_image2pro_expired_unknown")
				require.NoError(t, e)
				require.Equal(t, "unknown", state.Status)
				afterTask, e := os.ReadFile(r.Store.path("task", "av_image2pro_expired_unknown"))
				require.NoError(t, e)
				require.Equal(t, originalTask, afterTask)
				require.Equal(t, 1, posts)
				require.Equal(t, 1, orders.reserves)
			} else {
				require.Zero(t, orders.reserves)
			}
			require.Zero(t, orders.captures)
		})
	}
}

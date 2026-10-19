package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

type studioNativeHTTP struct {
	HTTPUpstream
	call func(*http.Request, int64) (*http.Response, error)
}

func (s studioNativeHTTP) Do(r *http.Request, _ string, id int64, _ int) (*http.Response, error) {
	return s.call(r, id)
}

func TestStudioNativeImagesParity(t *testing.T) {
	for _, platform := range []string{PlatformOpenAI, PlatformGrok, PlatformGemini} {
		for _, edit := range []bool{false, true} {
			t.Run(platform+map[bool]string{false: "/generate", true: "/edit"}[edit], func(t *testing.T) {
				ctx := context.Background()
				r, old, key, accounts, billing := studioContractFixture(t)
				a := accounts.a
				a.Platform = platform
				key.Group.Platform = platform
				a.Extra = map[string]any{"quota_limit": 100.0}
				upstreamModel := map[string]string{PlatformOpenAI: "gemini-3.1-flash-image", PlatformGrok: "grok-imagine-image", PlatformGemini: "gemini-3.1-flash-image"}[platform]
				a.Credentials["model_mapping"] = map[string]any{"gpt-image-2": upstreamModel, upstreamModel: "must-not-map-twice"}
				ma, ok := r.Media.(*studioMediaFixture)
				require.True(t, ok)
				ma.a.Platform = platform
				ma.a.ModelMapping = map[string]string{"gpt-image-2": upstreamModel, upstreamModel: "must-not-map-twice"}
				ma.a.Catalog.Models = []string{upstreamModel}
				ma.a.Config = nil
				cost := studioAccountPrice("0.35")
				cost.AccountStatsPricingRules[0].Pricing[0].Platform = platform
				cost.AccountStatsPricingRules[0].Pricing[0].Models = []string{upstreamModel}
				r.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: cost}}
				p := mediaworkbench.Product{CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, ProductID: "native", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: upstreamModel, Enabled: true,
					Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"2K"}, AspectRatios: []string{"3:2"}, Count: mediaworkbench.Range{Min: 1, Max: 10}, References: mediaworkbench.References{Image: mediaworkbench.Range{Max: 1}, TotalMax: 1}},
					PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.70", Currency: "CNY", BillingMode: "per_request"}}}}
				admin := mediaworkbench.NewService(ma)
				d, err := admin.SaveDraft(ctx, 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
				require.NoError(t, err)
				require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
				d, err = admin.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
				require.NoError(t, err)
				_, err = admin.SetSales(ctx, 7, d.Config.RecordVersion, true)
				require.NoError(t, err)
				var requests [][]byte
				var paths, auth []string
				fixtureResult := studioResult(t, "png")
				imageB64 := gjson.GetBytes(fixtureResult, "data.0.b64_json").String()
				up := studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
					require.Equal(t, int64(7), id)
					b, e := io.ReadAll(req.Body)
					require.NoError(t, e)
					requests = append(requests, b)
					paths = append(paths, req.URL.Path)
					auth = append(auth, firstNonEmptyString(req.Header.Get("Authorization"), req.Header.Get("x-goog-api-key")))
					if isStudioNativeExecution(req.Context()) {
						require.Nil(t, req.GetBody)
						require.True(t, HTTPUpstreamRedirectsDisabled(req.Context()))
					}
					response := fixtureResult
					if platform == PlatformGemini {
						response = []byte(`{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"` + imageB64 + `"}}]}}]}`)
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}, "X-Request-Id": {"fixture-response"}}, Body: io.NopCloser(bytes.NewReader(response))}, nil
				}}
				r.Core.httpUpstream = up
				r.network = r.dispatchHTTP
				r.Core.cfg = &config.Config{}
				r.Gemini = &GeminiMessagesCompatService{cfg: &config.Config{}, httpUpstream: up}
				spec := mediaworkbench.Spec{Resolution: "2K", AspectRatio: "3:2", Count: 1}
				refs := []string{}
				if edit {
					spec.Images = 1
					refs = []string{"data:image/png;base64," + imageB64}
				}
				token, err := r.Issue(ctx, old.Owner, key, d.Config.Published.Offers[0].OfferID, spec, nil)
				require.NoError(t, err)
				q, err := r.Store.Quote(token, old.Owner, time.Now())
				require.NoError(t, err)
				require.Equal(t, platform, q.QuotaPlatform)
				require.Equal(t, "resolved", q.Accounting.SourceState)
				require.Equal(t, "0.35", q.Accounting.BaseAmount)
				receipt, err := r.Dispatch(ctx, nil, q, "native-parity", "same prompt", refs, key)
				require.NoError(t, err)
				require.Equal(t, "completed", receipt.Status)
				require.Equal(t, 1, billing.applied)
				require.Equal(t, "0.70", billing.cmd.ExactAmounts.Balance)
				saved, err := r.Store.Result(receipt)
				require.NoError(t, err)
				require.Equal(t, imageB64, gjson.GetBytes(saved, "data.0.b64_json").String())
				_, err = r.Dispatch(ctx, nil, q, "native-parity", "same prompt", refs, key)
				require.NoError(t, err)
				_, err = r.Recover(ctx, "native-parity", q.Owner)
				require.NoError(t, err)
				require.Len(t, requests, 1)
				require.Equal(t, 1, billing.applied)
				if platform == PlatformGemini {
					require.Equal(t, "2K", gjson.GetBytes(requests[0], "generationConfig.imageConfig.imageSize").String())
					require.Equal(t, "3:2", gjson.GetBytes(requests[0], "generationConfig.imageConfig.aspectRatio").String())
				} else {
					require.Equal(t, "2k", strings.ToLower(gjson.GetBytes(requests[0], "resolution").String()))
					require.Equal(t, "3:2", gjson.GetBytes(requests[0], "aspect_ratio").String())
					require.False(t, gjson.GetBytes(requests[0], "size").Exists())
				}
				// Compare with the actual native service using the same Account and
				// equivalent public request, not a second Studio implementation.
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				body := requests[0]
				if platform == PlatformGemini {
					c.Request = httptest.NewRequest("POST", paths[0], bytes.NewReader(body))
					_, err = r.Gemini.ForwardNative(ctx, c, a, "gpt-image-2", "generateContent", false, body)
				} else {
					var fields map[string]any
					require.NoError(t, json.Unmarshal(body, &fields))
					fields["model"] = "gpt-image-2"
					body, _ = json.Marshal(fields)
					c.Request = httptest.NewRequest("POST", paths[0], bytes.NewReader(body))
					c.Request.Header.Set("Content-Type", "application/json")
					if platform == PlatformGrok {
						op := GrokMediaEndpointImagesGenerations
						if edit {
							op = GrokMediaEndpointImagesEdits
						}
						_, err = r.Core.ForwardGrokMedia(ctx, c, a, op, "", body, "application/json")
					} else {
						parsed, e := r.Core.ParseOpenAIImagesRequest(c, body)
						require.NoError(t, e)
						_, err = r.Core.ForwardImages(ctx, c, a, body, parsed, "")
					}
				}
				require.NoError(t, err)
				require.Len(t, requests, 2)
				require.JSONEq(t, string(requests[0]), string(requests[1]))
				require.Equal(t, paths[0], paths[1])
				require.Equal(t, auth[0], auth[1])
				require.NotEmpty(t, auth[0])
				require.NotContains(t, string(requests[0]), "must-not-map-twice")
				require.Equal(t, 1, billing.applied, "native service must not add another Studio charge")
			})
		}
	}
}

func TestStudioNativeNoRetryOnUnknown(t *testing.T) {
	for _, platform := range []string{PlatformOpenAI, PlatformGrok, PlatformGemini} {
		t.Run(platform, func(t *testing.T) {
			calls := 0
			up := studioNativeHTTP{call: func(*http.Request, int64) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"message":"unavailable"}}`))}, nil
			}}
			core := &OpenAIGatewayService{cfg: &config.Config{}, httpUpstream: up}
			r := &StudioImageRuntime{Core: core, Gemini: &GeminiMessagesCompatService{cfg: &config.Config{}, httpUpstream: up}}
			a := &Account{ID: 7, Platform: platform, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "synthetic", "base_url": "https://mock.invalid"}}
			_, _, err := r.dispatchHTTP(context.Background(), nil, a, []byte(`{"model":"gpt-image-2","prompt":"test","n":1}`), "/v1/images/generations")
			require.ErrorIs(t, err, ErrStudioImageUnknown)
			require.Equal(t, 1, calls)
		})
	}
}

func TestStudioNativeVideoParity(t *testing.T) {
	for _, standard := range []bool{false, true} {
		t.Run(map[bool]string{false: "native", true: "standard"}[standard], func(t *testing.T) {
			ctx := context.Background()
			r, _, old, key, accounts, orders := videoRuntimeFixture(t)
			a := accounts.a
			a.Platform = PlatformGrok
			a.Extra = map[string]any{}
			if standard {
				a.Extra[GrokVideoAPIStyleExtraKey] = "standard"
			}
			a.Credentials["model_mapping"] = map[string]any{"video-alias": "grok-imagine-video", "grok-imagine-video": "must-not-map-twice"}
			ma, ok := r.Media.(*studioMediaFixture)
			require.True(t, ok)
			ma.a.Platform = PlatformGrok
			ma.a.Config = nil
			ma.a.ModelMapping = map[string]string{"video-alias": "grok-imagine-video", "grok-imagine-video": "must-not-map-twice"}
			ma.a.Catalog.Models = []string{"grok-imagine-video"}
			p := mediaworkbench.Product{CostRules: []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"}}, ProductID: "native-video", MediaType: "video", SiteModel: "video-alias", UpstreamModel: "grok-imagine-video", Enabled: true,
				Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5}, Count: mediaworkbench.Range{Min: 1, Max: 1}},
				PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}}
			admin := mediaworkbench.NewService(ma)
			d, err := admin.SaveDraft(ctx, 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
			require.NoError(t, err)
			require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
			d, err = admin.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision)
			require.NoError(t, err)
			_, err = admin.SetSales(ctx, 7, d.Config.RecordVersion, true)
			require.NoError(t, err)
			price := studioAccountPrice("0.35")
			price.AccountStatsPricingRules[0].Pricing[0].Models = []string{"grok-imagine-video"}
			price.AccountStatsPricingRules[0].Pricing[0].Platform = PlatformGrok
			price.AccountStatsPricingRules[0].Pricing[0].BillingMode = BillingModePerRequest
			r.Core.channelService = &ChannelService{repo: &studioChannelFixture{channel: price}}
			m, ok := mediaworkbench.VideoProfileModel(d.Config.Published.Products[0])
			require.True(t, ok)
			plan, err := videoplan.PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
			require.NoError(t, err)
			token, q, err := r.Issue(ctx, old.Binding.Owner, key, d.Config.Published.Offers[0].OfferID, mediaworkbench.Spec{Count: 1, Resolution: "720p", AspectRatio: "16:9", DurationSeconds: 5}, plan.Body)
			require.NoError(t, err)
			var posts [][]byte
			var paths, auth []string
			original := []byte("synthetic-original-video")
			r.Core.cfg = &config.Config{}
			r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, id int64) (*http.Response, error) {
				require.Equal(t, int64(7), id)
				response := []byte(`{"request_id":"native-video-1","status":"done","video":{"url":"https://vidgen.x.ai/native-video-1.mp4"}}`)
				mime := "application/json"
				if req.Method == "POST" {
					body, e := io.ReadAll(req.Body)
					require.NoError(t, e)
					posts = append(posts, body)
					paths = append(paths, req.URL.Path)
					auth = append(auth, req.Header.Get("Authorization"))
					response = []byte(`{"request_id":"native-video-1"}`)
				}
				if strings.HasSuffix(req.URL.Path, "/content") || strings.HasSuffix(req.URL.Path, ".mp4") {
					response = original
					mime = "video/mp4"
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {mime}}, Body: io.NopCloser(bytes.NewReader(response))}, nil
			}}
			r.request = r.requestHTTP
			state, err := r.Submit(ctx, q.Binding.Owner, key, token, "av_native_video")
			require.NoError(t, err)
			require.Equal(t, "accepted", state.Status)
			state, err = r.Recover(ctx, q.Binding.Owner, "av_native_video")
			require.NoError(t, err)
			require.Equal(t, "completed", state.Status)
			data, mime, err := r.Original(ctx, q.Binding.Owner, "av_native_video")
			require.NoError(t, err)
			require.Equal(t, original, data)
			require.Equal(t, "video/mp4", mime)
			_, err = r.Capture(ctx, q.Binding.Owner, "av_native_video", HashUsageRequestPayload(data), testStudioVideoRetention(q))
			require.NoError(t, err)
			_, err = r.Capture(ctx, q.Binding.Owner, "av_native_video", HashUsageRequestPayload(data), testStudioVideoRetention(q))
			require.NoError(t, err)
			_, err = r.Submit(ctx, q.Binding.Owner, key, token, "av_native_video")
			require.NoError(t, err)
			require.Len(t, posts, 1)
			require.Equal(t, 1, orders.reserves)
			require.Equal(t, 1, orders.captures)
			// Same native entry owns upstream mapping, auth and wire format.
			var request map[string]any
			require.NoError(t, json.Unmarshal(plan.Body, &request))
			request["model"] = "video-alias"
			body, _ := json.Marshal(request)
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/videos/generations", bytes.NewReader(body))
			_, err = r.Core.ForwardGrokMedia(ctx, c, a, GrokMediaEndpointVideosGenerations, "", body, "application/json")
			require.NoError(t, err)
			require.Len(t, posts, 2)
			require.JSONEq(t, string(posts[0]), string(posts[1]))
			require.Equal(t, paths[0], paths[1])
			require.Equal(t, auth[0], auth[1])
			require.NotEmpty(t, auth[0])
			require.NotContains(t, string(posts[0]), "must-not-map-twice")
			require.Equal(t, 1, orders.captures)
		})
	}
}

func TestStudioNativeOAuthRoutesAndUnknown(t *testing.T) {
	for _, model := range []string{"gpt-image-2", "gpt-image-1"} {
		for _, edit := range []bool{false, true} {
			t.Run(model+map[bool]string{false: "/generate", true: "/edit"}[edit], func(t *testing.T) {
				b64 := gjson.GetBytes(studioResult(t, "png"), "data.0.b64_json").String()
				request := map[string]any{"model": model, "prompt": "one unchanged prompt", "n": 1}
				endpoint := "/v1/images/generations"
				if edit {
					endpoint = "/v1/images/edits"
					request["images"] = []map[string]string{{"image_url": "data:image/png;base64," + b64}}
				}
				body, _ := json.Marshal(request)
				a := directImagesTestAccount()
				var bodies [][]byte
				var paths, auth []string
				up := studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
					b, e := io.ReadAll(req.Body)
					require.NoError(t, e)
					bodies = append(bodies, b)
					paths = append(paths, req.URL.Path)
					auth = append(auth, req.Header.Get("Authorization"))
					data := studioResult(t, "png")
					mime := "application/json"
					if strings.HasSuffix(req.URL.Path, "/responses") {
						mime = "text/event-stream"
						data = []byte(`data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"` + b64 + `","output_format":"png"}]}}` + "\n\ndata: [DONE]\n\n")
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {mime}}, Body: io.NopCloser(bytes.NewReader(data))}, nil
				}}
				core := &OpenAIGatewayService{cfg: &config.Config{}, httpUpstream: up}
				r := &StudioImageRuntime{Core: core}
				output, _, err := r.dispatchHTTP(context.Background(), nil, a, body, endpoint)
				require.NoError(t, err)
				require.Contains(t, string(output), b64)
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest("POST", endpoint, bytes.NewReader(body))
				c.Request.Header.Set("Content-Type", "application/json")
				parsed, err := core.ParseOpenAIImagesRequest(c, body)
				require.NoError(t, err)
				_, err = core.ForwardImages(context.Background(), c, a, body, parsed, "")
				require.NoError(t, err)
				require.Len(t, bodies, 2)
				require.JSONEq(t, string(bodies[0]), string(bodies[1]))
				require.Equal(t, paths[0], paths[1])
				require.Equal(t, auth[0], auth[1])
				if model == "gpt-image-1" {
					require.True(t, strings.HasSuffix(paths[0], "/responses"))
				} else {
					require.Contains(t, paths[0], "/images/")
				}
				calls := 0
				core.httpUpstream = studioNativeHTTP{call: func(*http.Request, int64) (*http.Response, error) {
					calls++
					return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"message":"route unavailable"}}`))}, nil
				}}
				_, _, err = r.dispatchHTTP(context.Background(), nil, a, body, endpoint)
				require.Error(t, err)
				require.Equal(t, 1, calls, "Studio must not fall back to a second paid endpoint")
			})
		}
	}
}

func TestStudioNativeURLPartialRecovery(t *testing.T) {
	r, _, key, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	r.network = r.dispatchHTTP
	r.Core.cfg = &config.Config{}
	originals, err := ValidateStudioImageResult(studioResult(t, "png"), 1)
	require.NoError(t, err)
	posts, gets := 0, 0
	r.Core.httpUpstream = studioNativeHTTP{call: func(req *http.Request, _ int64) (*http.Response, error) {
		code, mime := 200, "application/json"
		var data []byte
		if req.Method == "POST" {
			posts++
			if posts == 2 {
				code = 422
				data = []byte(`{"error":{"message":"synthetic reject"}}`)
			} else {
				data = []byte(`{"data":[{"url":"https://results.invalid/a.png"},{"url":"https://results.invalid/b.png"}]}`)
			}
		} else {
			gets++
			require.Empty(t, req.Header.Get("Authorization"))
			require.True(t, HTTPUpstreamPublicHostsOnly(req.Context()))
			data = originals[0]
			mime = "image/png"
		}
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {mime}}, Body: io.NopCloser(bytes.NewReader(data))}, nil
	}}
	receipt, err := r.Dispatch(context.Background(), nil, q, "native-url-partial", "one prompt", nil, key)
	require.NoError(t, err)
	require.Equal(t, "partial", receipt.Status)
	require.Equal(t, 2, receipt.DeliveredCount)
	require.Equal(t, 2, posts)
	require.Equal(t, 2, gets)
	require.Equal(t, 1, billing.applied)
	require.Equal(t, "1.60", billing.cmd.ExactAmounts.Balance)
	for i := 0; i < 3; i++ {
		receipt, err = r.Recover(context.Background(), "native-url-partial", q.Owner)
		require.NoError(t, err)
		require.Equal(t, "partial", receipt.Status)
	}
	data, err := r.Store.Result(receipt)
	require.NoError(t, err)
	images, err := ValidateStudioImageResult(data, 2)
	require.NoError(t, err)
	require.Equal(t, originals[0], images[1])
	require.Equal(t, 2, posts)
	require.Equal(t, 2, gets)
	require.Equal(t, 1, billing.applied)
	// A private URL is rejected before any downloader request.
	_, err = r.materializeResult(context.Background(), q, receipt.TaskID, []byte(`{"data":[{"url":"http://127.0.0.1/private"}]}`))
	require.Error(t, err)
	require.Equal(t, 2, gets)
	// URL-form data payloads reuse the same bounded inline decoder, without HTTP.
	data, err = r.materializeResult(context.Background(), q, receipt.TaskID, []byte(`{"data":[{"url":"data:image/png;base64,`+base64.StdEncoding.EncodeToString(originals[0])+`"}]}`))
	require.NoError(t, err)
	require.Contains(t, string(data), "b64_json")
	require.Equal(t, 2, gets)
}

func TestStudioNativeInlineRejectsExcessResultsBeforeDownload(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, nil
	})}
	items := make([]map[string]string, 11)
	for i := range items {
		items[i] = map[string]string{"url": "https://results.invalid/image.png"}
	}
	data, err := json.Marshal(map[string]any{"data": items})
	require.NoError(t, err)
	_, err = NewImageResultUploader(nil, "", 1024, client).Inline(context.Background(), data)
	require.Error(t, err)
	require.Zero(t, calls, "excess supplier results must not fan out into downloads")
}

package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const studioImage2ProPublicModel = "新公开图片模型-20261019"

// This supplier mock owns an independent documented schema; it never reads the
// compiler's allowlist or generated plan fields. HTTPUpstream is intercepted,
// so no real supplier request, credential or paid call can leave the process.
type studioImage2ProDocumentedHTTP struct {
	HTTPUpstream
	t            *testing.T
	endpoint     string
	references   []string
	response     []byte
	download     []byte
	downloads    int
	status       int
	failure      error
	bodies       [][]byte
	counts       []int
	allRequested bool
}

func (s *studioImage2ProDocumentedHTTP) Do(req *http.Request, proxy string, accountID int64, concurrency int) (*http.Response, error) {
	require.Equal(s.t, int64(7), accountID)
	require.Equal(s.t, 1, concurrency)
	require.Empty(s.t, proxy)
	require.Equal(s.t, "https", req.URL.Scheme)
	if req.Method == http.MethodGet {
		require.Equal(s.t, "https://results.image2pro.example/image.png", req.URL.String())
		require.Empty(s.t, req.Header.Get("Authorization"))
		require.Empty(s.t, req.Header.Get("Cookie"))
		s.downloads++
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(s.download)), Request: req}, nil
	}
	require.Equal(s.t, "api.image2pro.top", req.URL.Host)
	require.Equal(s.t, http.MethodPost, req.Method)
	require.Equal(s.t, s.endpoint, req.URL.Path)
	require.Equal(s.t, "Bearer synthetic-only", req.Header.Get("Authorization"))
	require.Nil(s.t, req.GetBody, "a synchronous POST must not become replayable")
	body, err := io.ReadAll(req.Body)
	require.NoError(s.t, err)
	s.bodies = append(s.bodies, append([]byte(nil), body...))
	var documented struct {
		Model       string   `json:"model"`
		Prompt      string   `json:"prompt"`
		N           int      `json:"n"`
		Size        string   `json:"size"`
		Resolution  string   `json:"resolution"`
		AspectRatio string   `json:"aspect_ratio"`
		Images      []string `json:"images"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	require.NoError(s.t, decoder.Decode(&documented), "only documented synchronous fields may reach this supplier")
	require.Equal(s.t, studioImage2ProPublicModel, documented.Model, "native aliases cannot remap the frozen public ID")
	require.NotEmpty(s.t, documented.Prompt)
	require.GreaterOrEqual(s.t, documented.N, 1)
	require.LessOrEqual(s.t, documented.N, 4)
	s.counts = append(s.counts, documented.N)
	require.Equal(s.t, s.references, documented.Images)
	if s.failure != nil {
		return nil, s.failure
	}
	status := s.status
	if status == 0 {
		status = http.StatusOK
	}
	response := s.response
	if s.allRequested {
		response = studioResultN(s.t, documented.N)
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}, "X-Request-Id": []string{"synthetic-image2pro-receipt"}}, Body: io.NopCloser(bytes.NewReader(response)), Request: req}, nil
}

func studioImage2ProSyncQuote(t *testing.T, count, references int, nativeMulti bool) (*StudioImageRuntime, StudioImageQuote, *APIKey, *studioBillingFixture) {
	t.Helper()
	r, original, key, account, billing := studioContractFixture(t)
	account.a.Credentials["base_url"] = "https://api.image2pro.top/v1"
	// If dispatch resolves an already-frozen public ID through the API aliases,
	// it would purchase this different model and the strict supplier will fail.
	account.a.Credentials["model_mapping"] = map[string]any{studioImage2ProPublicModel: "wrong-api-alias-model"}
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok, "the Studio fixture must provide its media repository")
	ma.a.BaseURL = account.a.GetOpenAIBaseURL()
	ma.a.Catalog.Models = []string{studioImage2ProPublicModel}
	p := ma.a.Config.Draft.Products[0]
	p.SiteModel, p.UpstreamModel = "customer-image2pro-alias", studioImage2ProPublicModel
	p.Capabilities.Count = mediaworkbench.Range{Min: 1, Max: 5}
	p.Capabilities.References = mediaworkbench.References{Image: mediaworkbench.Range{Min: 0, Max: 16}, TotalMax: 16}
	p.PricingRules[0].Match = mediaworkbench.Match{}
	if nativeMulti {
		p.AdapterConfig.Execution = &mediaworkbench.ImageExecutionConfig{Mode: mediaworkbench.ImageExecutionNativeMulti, MaxOutputImages: 4}
		p.AdapterConfig.EditExecution = &mediaworkbench.ImageExecutionConfig{Mode: mediaworkbench.ImageExecutionNativeMulti, MaxOutputImages: 4}
	}
	admin := mediaworkbench.NewService(ma)
	d, err := admin.SaveDraft(t.Context(), 7, ma.a.Config.RecordVersion, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{p}})
	require.NoError(t, err)
	require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
	d, err = admin.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	_, err = admin.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	require.NoError(t, err)
	spec := mediaworkbench.Spec{Resolution: "1K", AspectRatio: "1:1", Count: count, Images: references}
	var offer mediaworkbench.Offer
	for _, candidate := range ma.a.Config.Published.Offers {
		if candidate.Matches(spec) {
			offer = candidate
		}
	}
	token, err := r.Issue(t.Context(), original.Owner, key, offer.OfferID, spec, nil)
	require.NoError(t, err)
	quote, err := r.Store.Quote(token, original.Owner, time.Now())
	require.NoError(t, err)
	return r, quote, key, billing
}

func TestStudioImage2ProSyncUsesStrictSupplierAndFrozenModel(t *testing.T) {
	for _, refs := range [][]string{nil, {"https://example.com/reference.png", "data:image/png;base64,AQ=="}} {
		t.Run(string(rune('0'+len(refs))), func(t *testing.T) {
			r, quote, key, billing := studioImage2ProSyncQuote(t, 1, len(refs), false)
			endpoint := imageplan.Generations
			if len(refs) > 0 {
				endpoint = imageplan.Edits
			}
			mock := &studioImage2ProDocumentedHTTP{t: t, endpoint: endpoint, references: refs, response: studioResult(t, "png")}
			r.Core.httpUpstream = mock
			r.network = r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			receipt, err := r.Dispatch(t.Context(), c, quote, "image2pro-sync", "keep original prompt", refs, key)
			require.NoError(t, err)
			require.Equal(t, "completed", receipt.Status)
			require.Equal(t, "billed", receipt.BillingState)
			require.Len(t, mock.bodies, 1)
			require.Equal(t, HashUsageRequestPayload(mock.bodies[0]), receipt.Units[0].PayloadHash, "dispatch must not mutate a claimed payload")
			require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
			saved, err := r.Store.Result(receipt)
			require.NoError(t, err)
			require.Equal(t, mock.response, saved)
			require.Equal(t, HashUsageRequestPayload(saved), receipt.ResultHash)
			_, err = r.Recover(t.Context(), receipt.TaskID, quote.Owner)
			require.NoError(t, err)
			_, err = r.Dispatch(t.Context(), c, quote, receipt.TaskID, "keep original prompt", refs, key)
			require.NoError(t, err)
			require.Len(t, mock.bodies, 1)
			require.Equal(t, 1, billing.applied)
			require.Equal(t, 1, billing.calls)
		})
	}
}

func TestStudioImage2ProSyncPartialSuccessKeepsOnceOnlySettlement(t *testing.T) {
	r, quote, key, billing := studioImage2ProSyncQuote(t, 5, 0, true)
	mock := &studioImage2ProDocumentedHTTP{t: t, endpoint: imageplan.Generations, response: studioResultN(t, 2)}
	r.Core.httpUpstream = mock
	r.network = r.dispatchHTTP
	c, _ := newOpenAIImagesTestContext(t, nil)
	receipt, err := r.Dispatch(t.Context(), c, quote, "image2pro-partial", "synthetic", nil, key)
	require.NoError(t, err)
	require.Equal(t, "partial", receipt.Status)
	require.Equal(t, "billed", receipt.BillingState)
	require.Equal(t, 2, receipt.DeliveredCount)
	require.Equal(t, 3, receipt.FailedCount)
	require.Len(t, mock.bodies, 1, "partial delivery must not generate replacement images")
	require.Equal(t, []int{4}, mock.counts)
	require.Equal(t, "1.60", billing.cmd.ExactAmounts.Balance)
	require.Equal(t, 2, billing.cmd.ImageCount)
	t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", "true")
	restarted := NewStudioImageRuntime(r.Core, r.Media)
	restarted.Store = NewStudioImageStore(r.Store.Root)
	recovered, err := restarted.Recover(t.Context(), receipt.TaskID, quote.Owner)
	require.NoError(t, err)
	require.Equal(t, receipt.ResultHash, recovered.ResultHash)
	require.Equal(t, "partial", recovered.Status)
	require.Len(t, mock.bodies, 1)
	require.Equal(t, 1, billing.applied)
	require.Equal(t, 1, billing.calls)
}

func TestStudioImage2ProPlanMarkerDoesNotWidenOrdinaryImagesAPI(t *testing.T) {
	svc := &OpenAIGatewayService{}
	body := []byte(`{"model":"新公开图片模型-20261019","prompt":"synthetic","images":["https://example.com/reference.png"]}`)
	plan, err := imageplan.CompileImage2ProJSON(body, studioImage2ProPublicModel, imageplan.Edits)
	require.NoError(t, err)
	parsed, err := svc.ParsePublishedImagePlan(plan)
	require.NoError(t, err)
	require.Equal(t, []string{"https://example.com/reference.png"}, parsed.InputImageURLs)
	require.Equal(t, imageplan.Image2ProSyncProtocol, parsed.publishedImageProtocol)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, imageplan.Edits, bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	_, err = svc.ParseOpenAIImagesRequest(c, body)
	require.Error(t, err, "ordinary API input cannot opt into this internal protocol")
	var browserPlan imageplan.Plan
	encoded, err := json.Marshal(plan)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(encoded, &browserPlan))
	_, err = svc.ParsePublishedImagePlan(browserPlan)
	require.Error(t, err, "a browser object has no compiled private body")
	plan.Protocol = "unknown-protocol"
	_, err = svc.ParsePublishedImagePlan(plan)
	require.Error(t, err)
}

func TestStudioImage2ProSyncURLResultIsStoredBeforeBilling(t *testing.T) {
	r, quote, key, billing := studioImage2ProSyncQuote(t, 1, 0, false)
	var inline struct {
		Data []struct {
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(studioResult(t, "png"), &inline))
	imageBytes, err := base64.StdEncoding.DecodeString(inline.Data[0].B64)
	require.NoError(t, err)
	mock := &studioImage2ProDocumentedHTTP{t: t, endpoint: imageplan.Generations,
		response: []byte(`{"data":[{"url":"https://results.image2pro.example/image.png"}]}`), download: imageBytes}
	r.Core.httpUpstream = mock
	r.network = r.dispatchHTTP
	billing.before = func() {
		receipt, readErr := r.Store.Receipt("image2pro-url", quote.Owner)
		require.NoError(t, readErr)
		stored, readErr := r.Store.Result(receipt)
		require.NoError(t, readErr)
		require.Equal(t, HashUsageRequestPayload(stored), receipt.ResultHash)
	}
	c, _ := newOpenAIImagesTestContext(t, nil)
	receipt, err := r.Dispatch(t.Context(), c, quote, "image2pro-url", "synthetic", nil, key)
	require.NoError(t, err)
	saved, err := r.Store.Result(receipt)
	require.NoError(t, err)
	var result struct {
		Data []struct {
			URL string `json:"url"`
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(saved, &result))
	require.Equal(t, "https://results.image2pro.example/image.png", result.Data[0].URL)
	actual, err := base64.StdEncoding.DecodeString(result.Data[0].B64)
	require.NoError(t, err)
	require.Equal(t, imageBytes, actual)
	require.Equal(t, 1, mock.downloads)
	require.Equal(t, 1, billing.applied)
	_, err = r.Recover(t.Context(), receipt.TaskID, quote.Owner)
	require.NoError(t, err)
	require.Equal(t, 1, mock.downloads)
	require.Len(t, mock.bodies, 1)
}

func TestStudioImage2ProSyncFailuresNeverResubmitOrBill(t *testing.T) {
	for _, mode := range []string{"conflict", "bad_gateway", "lost_response"} {
		t.Run(mode, func(t *testing.T) {
			r, quote, key, billing := studioImage2ProSyncQuote(t, 1, 0, false)
			mock := &studioImage2ProDocumentedHTTP{t: t, endpoint: imageplan.Generations, response: []byte(`{"error":{"message":"synthetic original invocation needs reconciliation","type":"invalid_request_error"}}`)}
			switch mode {
			case "conflict":
				mock.status = http.StatusConflict
			case "bad_gateway":
				mock.status = http.StatusBadGateway
			case "lost_response":
				mock.failure = io.ErrUnexpectedEOF
			}
			r.Core.httpUpstream = mock
			r.network = r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			receipt, err := r.Dispatch(t.Context(), c, quote, "image2pro-unknown", "synthetic", nil, key)
			require.NotNil(t, receipt)
			check := func(got *StudioImageReceipt, callErr error) {
				t.Helper()
				if mode == "bad_gateway" {
					// Existing customer finality: a real Image2Pro HTTP 502 with
					// no image data ends failed/not_charged, without billing.
					require.NoError(t, callErr)
					require.Equal(t, "failed", got.Status)
					require.Equal(t, "not_charged", got.BillingState)
					require.Equal(t, studioImageNoCharge502, StudioImageFailureCode(got))
					require.True(t, got.Units[0].HTTPFailure.NoChargeFinal)
				} else {
					require.ErrorIs(t, callErr, ErrStudioImageUnknown)
					require.Equal(t, "unknown", got.Status)
				}
			}
			check(receipt, err)
			recovered, err := r.Recover(t.Context(), receipt.TaskID, quote.Owner)
			check(recovered, err)
			repeated, err := r.Dispatch(t.Context(), c, quote, receipt.TaskID, "synthetic", nil, key)
			check(repeated, err)
			require.Len(t, mock.bodies, 1, "409 and unknown execution outcomes cannot trigger a new submission")
			require.Zero(t, billing.calls)
		})
	}
}

func TestStudioImage2ProSyncCustomerFiveUsesBoundedExecutionUnits(t *testing.T) {
	r, quote, key, billing := studioImage2ProSyncQuote(t, 5, 0, true)
	mock := &studioImage2ProDocumentedHTTP{t: t, endpoint: imageplan.Generations, allRequested: true}
	r.Core.httpUpstream = mock
	r.network = r.dispatchHTTP
	c, _ := newOpenAIImagesTestContext(t, nil)
	receipt, err := r.Dispatch(t.Context(), c, quote, "image2pro-five", "synthetic", nil, key)
	require.NoError(t, err)
	require.Equal(t, "completed", receipt.Status)
	require.Equal(t, 5, receipt.DeliveredCount)
	require.Equal(t, []int{4, 1}, mock.counts)
	require.Equal(t, "4.00", billing.cmd.ExactAmounts.Balance)
	require.Equal(t, 5, billing.cmd.ImageCount)
	for i, body := range mock.bodies {
		require.Equal(t, HashUsageRequestPayload(body), receipt.Units[i].PayloadHash)
	}
	_, err = r.Recover(t.Context(), receipt.TaskID, quote.Owner)
	require.NoError(t, err)
	require.Len(t, mock.bodies, 2)
	require.Equal(t, 1, billing.applied)
	require.Equal(t, 1, billing.calls)
}

// Import a historical snapshot without invoking today's save/publish admission.
// Its dependency and envelope hashes are valid, so denial must come from the
// current Image2Pro product validation rather than an unrelated stale route.
func studioImage2ProRetiredQuote(t *testing.T, profile string) (*StudioImageRuntime, StudioImageQuote, *APIKey, *studioBillingFixture) {
	t.Helper()
	r, quote, key, account, billing := studioContractFixture(t)
	account.a.Credentials["base_url"] = "https://api.image2pro.top/v1"
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok, "the Studio fixture must provide its media repository")
	ma.a.BaseURL = account.a.GetOpenAIBaseURL()
	pub := ma.a.Config.Published
	for i := range pub.Products {
		pub.Products[i].CostVersion = 1
		pub.Products[i].CostRules = []mediaworkbench.CostRule{{Cost: &mediaworkbench.Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}}}
		pub.Products[i].AdapterConfig.ModelFamily = profile
		pub.Products[i].AdapterConfig.Version = 0
		if profile != "" {
			pub.Products[i].AdapterConfig.Version = 1
		}
	}
	for i := range pub.Offers {
		pub.Offers[i].CostVersion = 1
		pub.Offers[i].ResolvedConfig = pub.Products[0].AdapterConfig
		pub.Offers[i].OfferID = ""
		pub.Offers[i].OfferID = "mw_offer_" + studioHash(pub.Offers[i])
	}
	pub.ProductDependencies = nil
	pub.Dependencies = mediaworkbench.PublishedDependenciesFor(&ma.a)
	pub.Revision = "mwp_" + studioHash(struct {
		Source              string
		Products            []mediaworkbench.Product
		Offers              []mediaworkbench.Offer
		Dependencies        mediaworkbench.Dependencies
		ProductDependencies map[string]mediaworkbench.Dependencies `json:",omitempty"`
	}{pub.SourceDraftRevision, pub.Products, pub.Offers, pub.Dependencies, pub.ProductDependencies})
	_, validEnvelope := mediaworkbench.PublishedOfferIdentity(&ma.a, pub.Offers[0].OfferID)
	require.True(t, validEnvelope, "the old fixture must have a valid immutable envelope")
	quote.BaseURL = ma.a.BaseURL
	quote.Binding.Offer = pub.Offers[0]
	quote.Binding.PublishedRevision = pub.Revision
	quote.Binding.Dependencies = pub.Dependencies
	quote.CredentialFingerprint = studioOfferCredentialFingerprint(account.a, quote.Binding.Offer)
	quote = freezeLegacyImageAccounting(t, r, quote, 1)
	return r, quote, key, billing
}

func TestStudioImage2ProRetiredPublishedCannotQuoteOrFirstDispatch(t *testing.T) {
	for _, profile := range []string{"", "openai_json"} {
		t.Run("old_"+profile, func(t *testing.T) {
			r, quote, key, billing := studioImage2ProRetiredQuote(t, profile)
			calls := 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				calls++
				t.Fatal("retired Image2Pro products cannot send a first POST")
				return nil, "", nil
			}
			_, err := r.Issue(t.Context(), quote.Owner, key, quote.Binding.Offer.OfferID, quote.Binding.Spec, nil)
			require.Error(t, err)
			_, err = r.Dispatch(t.Context(), nil, quote, "retired-image2pro", "synthetic", nil, key)
			require.Error(t, err)
			_, err = r.Store.Receipt("retired-image2pro", quote.Owner)
			require.ErrorIs(t, err, os.ErrNotExist, "denied admission must not claim a new task")
			require.Zero(t, calls)
			require.Zero(t, billing.calls)
		})
	}
}

func TestStudioImage2ProRetiredReceiptRecoversOriginalResponseWithoutPOST(t *testing.T) {
	r, quote, key, billing := studioImage2ProRetiredQuote(t, "openai_json")
	plan, err := mediaworkbench.CompilePublishedImagePlan(quote.Binding, "original prompt", nil)
	require.NoError(t, err)
	requestHash := studioHash(struct {
		Prompt     string
		References []string
		Spec       mediaworkbench.Spec
	}{"original prompt", nil, quote.Binding.Spec})
	receipt, first, err := r.Store.Claim(StudioImageReceipt{Version: StudioImageReceiptVersion, TaskID: "retired-image2pro-recovery", Quote: quote,
		Request: plan.MaterializeJSON(), PayloadHash: HashUsageRequestPayload(plan.MaterializeJSON()), RequestHash: requestHash, Endpoint: plan.Path})
	require.NoError(t, err)
	require.True(t, first)
	original := studioResult(t, "png")
	require.NoError(t, r.Store.persistCopy(receipt.TaskID, "upstream", receipt.TaskID, original, true, nil))
	calls := 0
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		calls++
		t.Fatal("recovery cannot generate")
		return nil, "", nil
	}
	recovered, err := r.Recover(t.Context(), receipt.TaskID, quote.Owner)
	require.NoError(t, err)
	require.Equal(t, "billed", recovered.BillingState)
	data, err := r.Store.Result(recovered)
	require.NoError(t, err)
	require.Equal(t, original, data)
	require.Equal(t, HashUsageRequestPayload(original), recovered.ResultHash)
	_, err = r.Dispatch(t.Context(), nil, quote, receipt.TaskID, "original prompt", nil, key)
	require.NoError(t, err)
	require.Zero(t, calls)
	require.Equal(t, 1, billing.applied)
	require.Equal(t, 1, billing.calls)
}

package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
)

// This mock validates the supplier's documented schema independently of the
// request compiler. All I/O is intercepted; no real endpoint or Key is used.
type studioLaoliImageHTTP struct {
	HTTPUpstream
	t            *testing.T
	model        string
	endpoint     string
	references   []string
	response     []byte
	download     []byte
	downloadCode int
	status       int
	failure      error
	posts        int
	downloads    int
}

func (s *studioLaoliImageHTTP) Do(req *http.Request, proxy string, accountID int64, concurrency int) (*http.Response, error) {
	require.Equal(s.t, int64(7), accountID)
	require.Equal(s.t, 1, concurrency)
	require.Empty(s.t, proxy)
	status := http.StatusOK
	response := s.response
	if req.Method == http.MethodGet {
		s.downloads++
		require.Equal(s.t, "https://video.laoliimage2.win/v1/media/links/synthetic/0/opaque-signature", req.URL.String())
		require.Empty(s.t, req.Header.Get("Authorization"))
		require.Empty(s.t, req.Header.Get("Cookie"))
		response = s.download
		if s.downloadCode != 0 {
			status = s.downloadCode
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"image/png"}, "Location": []string{"https://private.invalid/redirect"}}, Body: io.NopCloser(bytes.NewReader(response)), Request: req}, nil
	}
	s.posts++
	require.Equal(s.t, http.MethodPost, req.Method)
	require.Equal(s.t, "video.laoliimage2.win", req.URL.Host)
	require.Equal(s.t, s.endpoint, req.URL.Path)
	require.Equal(s.t, "Bearer synthetic-only", req.Header.Get("Authorization"))
	require.Nil(s.t, req.GetBody, "supplier POST cannot be replayed")
	body, err := io.ReadAll(req.Body)
	require.NoError(s.t, err)
	var fields struct {
		Model      string   `json:"model"`
		Prompt     string   `json:"prompt"`
		N          int      `json:"n"`
		Size       string   `json:"size"`
		Resolution string   `json:"resolution"`
		Images     []string `json:"images"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	require.NoError(s.t, decoder.Decode(&fields))
	require.Equal(s.t, s.model, fields.Model, "exact frozen model cannot be remapped through API aliases")
	require.NotEmpty(s.t, fields.Prompt)
	require.Equal(s.t, 1, fields.N)
	require.Equal(s.t, s.references, fields.Images)
	if s.failure != nil {
		return nil, s.failure
	}
	if s.status != 0 {
		status = s.status
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}, "X-Request-Id": []string{"synthetic-laoli-result"}}, Body: io.NopCloser(bytes.NewReader(response)), Request: req}, nil
}

func studioLaoliImageQuote(t *testing.T, model string, count, references int) (*StudioImageRuntime, StudioImageQuote, *APIKey, *studioBillingFixture) {
	t.Helper()
	r, original, key, account, billing := studioContractFixture(t)
	account.a.Credentials["base_url"] = "https://video.laoliimage2.win/v1"
	account.a.Credentials["model_mapping"] = map[string]any{model: "wrong-api-alias-model"}
	ma, ok := r.Media.(*studioMediaFixture)
	require.True(t, ok)
	ma.a.BaseURL, ma.a.Catalog.Models = account.a.GetOpenAIBaseURL(), []string{model}
	p := ma.a.Config.Draft.Products[0]
	p.SiteModel, p.UpstreamModel = "customer-laoli-image-alias", model
	p.Capabilities.Count = mediaworkbench.Range{Min: 1, Max: 3}
	p.Capabilities.References = mediaworkbench.References{Image: mediaworkbench.Range{Min: 0, Max: 2}, TotalMax: 2}
	p.PricingRules[0].Match = mediaworkbench.Match{}
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
	for _, o := range ma.a.Config.Published.Offers {
		if o.Matches(spec) {
			offer = o
		}
	}
	token, err := r.Issue(t.Context(), original.Owner, key, offer.OfferID, spec, nil)
	require.NoError(t, err)
	quote, err := r.Store.Quote(token, original.Owner, time.Now())
	require.NoError(t, err)
	return r, quote, key, billing
}

func TestStudioLaoliImageSyncAndEditsFrozenIdentity(t *testing.T) {
	for _, model := range []string{"gpt-image-2.5-sr-flare", "nano-banana-2", "KS-Qwen-2.1NEW"} {
		for _, refs := range [][]string{nil, {"https://example.com/reference.png", "data:image/png;base64,AQ=="}} {
			t.Run(model+string(rune('0'+len(refs))), func(t *testing.T) {
				r, q, key, billing := studioLaoliImageQuote(t, model, 1, len(refs))
				endpoint := imageplan.Generations
				if len(refs) > 0 {
					endpoint = imageplan.Edits
				}
				mock := &studioLaoliImageHTTP{t: t, model: model, endpoint: endpoint, references: refs, response: studioResult(t, "png")}
				r.Core.httpUpstream, r.network = mock, r.dispatchHTTP
				c, _ := newOpenAIImagesTestContext(t, nil)
				receipt, err := r.Dispatch(t.Context(), c, q, "laoli-original", "synthetic", refs, key)
				require.NoError(t, err)
				require.Equal(t, "completed", receipt.Status)
				saved, err := r.Store.Result(receipt)
				require.NoError(t, err)
				require.Equal(t, mock.response, saved)
				_, err = r.Dispatch(t.Context(), c, q, receipt.TaskID, "synthetic", refs, key)
				require.NoError(t, err)
				require.Equal(t, 1, mock.posts)
				require.Equal(t, 1, billing.applied)
			})
		}
	}
}

func TestStudioLaoliImageURLPersistsBeforeBilling(t *testing.T) {
	r, q, key, billing := studioLaoliImageQuote(t, "gpt-image-2.5", 1, 0)
	var inline struct {
		Data []struct {
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(studioResult(t, "png"), &inline))
	imageBytes, err := base64.StdEncoding.DecodeString(inline.Data[0].B64)
	require.NoError(t, err)
	mock := &studioLaoliImageHTTP{t: t, model: "gpt-image-2.5", endpoint: imageplan.Generations, response: []byte(`{"data":[{"url":"https://video.laoliimage2.win/v1/media/links/synthetic/0/opaque-signature"}]}`), download: imageBytes}
	r.Core.httpUpstream, r.network = mock, r.dispatchHTTP
	billing.before = func() {
		receipt, err := r.Store.Receipt("laoli-url", q.Owner)
		require.NoError(t, err)
		stored, err := r.Store.Result(receipt)
		require.NoError(t, err)
		require.Equal(t, HashUsageRequestPayload(stored), receipt.ResultHash)
	}
	c, _ := newOpenAIImagesTestContext(t, nil)
	receipt, err := r.Dispatch(t.Context(), c, q, "laoli-url", "synthetic", nil, key)
	require.NoError(t, err)
	_, err = r.Recover(t.Context(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Equal(t, 1, mock.posts)
	require.Equal(t, 1, mock.downloads)
	require.Equal(t, 1, billing.applied)
}

func TestStudioLaoliImageUnknownNeverResubmitsOrBills(t *testing.T) {
	for _, mode := range []string{"conflict", "server_error", "lost_response", "private_result", "redirect_result"} {
		t.Run(mode, func(t *testing.T) {
			r, q, key, billing := studioLaoliImageQuote(t, "KS-Z-Image", 1, 0)
			mock := &studioLaoliImageHTTP{t: t, model: "KS-Z-Image", endpoint: imageplan.Generations, response: []byte(`{"error":{"message":"synthetic unknown result"}}`)}
			switch mode {
			case "conflict":
				mock.status = http.StatusConflict
			case "server_error":
				mock.status = http.StatusInternalServerError
			case "lost_response":
				mock.failure = io.ErrUnexpectedEOF
			case "private_result":
				mock.response = []byte(`{"data":[{"url":"https://127.0.0.1/private"}]}`)
			case "redirect_result":
				mock.response = []byte(`{"data":[{"url":"https://video.laoliimage2.win/v1/media/links/synthetic/0/opaque-signature"}]}`)
				mock.downloadCode = http.StatusFound
			}
			r.Core.httpUpstream, r.network = mock, r.dispatchHTTP
			c, _ := newOpenAIImagesTestContext(t, nil)
			receipt, err := r.Dispatch(t.Context(), c, q, "laoli-unknown", "synthetic", nil, key)
			require.NotNil(t, receipt)
			require.ErrorIs(t, err, ErrStudioImageUnknown)
			_, err = r.Dispatch(t.Context(), c, q, receipt.TaskID, "synthetic", nil, key)
			require.ErrorIs(t, err, ErrStudioImageUnknown)
			require.Equal(t, 1, mock.posts)
			require.Zero(t, billing.calls)
			if mode == "private_result" {
				require.Zero(t, mock.downloads)
			}
		})
	}
}

func TestStudioLaoliImageProtocolCannotWidenOtherSuppliers(t *testing.T) {
	body := []byte(`{"model":"gpt-image-2.5-sr-flare","prompt":"synthetic","images":["https://example.com/reference.png"]}`)
	plan, err := imageplan.CompileLaoliJSON(body, "gpt-image-2.5-sr-flare", imageplan.Edits)
	require.NoError(t, err)
	core := &OpenAIGatewayService{}
	_, err = core.ParsePublishedImagePlan(plan)
	require.NoError(t, err)
	_, err = parseOpenAIImagesRequest(imageplan.Edits, "application/json", body)
	require.Error(t, err, "ordinary OpenAI parsing cannot acquire supplier-private string references")
	r, _, _, account, _ := studioContractFixture(t)
	account.a.Credentials["base_url"] = "https://video.laoliimage2.win.attacker.invalid/v1"
	c, _ := newOpenAIImagesTestContext(t, nil)
	ctx := context.WithValue(t.Context(), studioImageProtocolContextKey{}, imageplan.LaoliSyncProtocol)
	_, _, err = r.dispatchHTTP(ctx, c, account.a, body, imageplan.Edits)
	require.ErrorIs(t, err, ErrStudioImageConflict)
}

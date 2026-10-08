//go:build unit

package service

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestImageReceiptExplicitZeroPriceAdmissionAndSettlement(t *testing.T) {
	for _, mode := range []BillingMode{BillingModeImage, BillingModePerRequest} {
		t.Run(string(mode), func(t *testing.T) {
			s, key, account, r, path, billing := receiptFixture(t)
			require.NoError(t, os.Remove(path))
			zero := 0.0
			key.Group.ModelPricing = []ChannelModelPricing{{Platform: PlatformOpenAI, Models: []string{"canvas-image-07"}, BillingMode: mode, PerRequestPrice: &zero}}
			s.resolver = NewModelPricingResolver(nil, s.billingService)
			account.Credentials["base_url"] = "https://api.image2pro.top"
			account.Credentials["model_mapping"] = map[string]any{"canvas-image-07": "免费GPT-image-2.5"}
			data := receiptPNG(t)
			up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
			}}
			s.httpUpstream = up
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)
			c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
			c.Request.Header.Set(ImageReceiptMaxUSDHeader, "0")
			parsed := &OpenAIImagesRequest{Model: "canvas-image-07", N: 1, SizeTier: "1K", ContentType: "application/json", Endpoint: openAIImagesGenerationsEndpoint}
			input := &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account}
			body := []byte(`{"model":"canvas-image-07","prompt":"fixture","n":1}`)
			_, err := s.DispatchImageReceipt(context.Background(), c, account, body, parsed, input)
			require.NoError(t, err)
			require.Eventually(t, func() bool { _, busy := imageReceiptActive.Load(path); return !busy }, 5*time.Second, 10*time.Millisecond)
			stored, err := readImageReceipt(path)
			require.NoError(t, err)
			require.Equal(t, "billed", stored.BillingState)
			require.Zero(t, stored.Cost.ActualCost)
			require.Zero(t, stored.Cost.TotalCost)
			require.Equal(t, 1, up.calls)
			require.Equal(t, 1, billing.calls)
			require.Zero(t, billing.lastCmd.BalanceCost)
			require.Zero(t, billing.lastCmd.APIKeyQuotaCost)
			require.Zero(t, billing.lastCmd.APIKeyRateLimitCost)
			require.Zero(t, billing.lastCmd.AccountQuotaCost)
			require.Equal(t, "image-receipt:44:local_"+r.ClientKey, billing.lastCmd.RequestID)
			_, err = s.DispatchImageReceipt(context.Background(), c, account, body, parsed, input)
			require.NoError(t, err)
			view, err := s.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
			require.NoError(t, err)
			require.Equal(t, "completed", view.Status)
			require.NoError(t, validateReceiptImageResult(view.Result))
			require.Equal(t, 1, up.calls)
			require.Equal(t, 1, billing.calls)
		})
	}
}

func TestImageReceiptZeroPriceRequiresExactExplicitGroupCard(t *testing.T) {
	zero := 0.0
	base := ChannelModelPricing{Platform: PlatformOpenAI, Models: []string{"canvas-image-07"}, BillingMode: BillingModeImage, PerRequestPrice: &zero}
	resolved := &ResolvedPricing{Source: PricingSourceGroup, Mode: BillingModeImage}
	group := &Group{ModelPricing: []ChannelModelPricing{base}}
	require.True(t, imageReceiptAllowsZeroPrice("canvas-image-07", "canvas-image-07", group, resolved))
	for _, tc := range []struct {
		name   string
		change func(*Group, *ResolvedPricing)
	}{
		{"missing", func(g *Group, _ *ResolvedPricing) { g.ModelPricing = nil }},
		{"omitted", func(g *Group, _ *ResolvedPricing) { g.ModelPricing[0].PerRequestPrice = nil }},
		{"wildcard", func(g *Group, _ *ResolvedPricing) { g.ModelPricing[0].Models = []string{"canvas-image-*"} }},
		{"duplicate", func(g *Group, _ *ResolvedPricing) { g.ModelPricing = append(g.ModelPricing, base) }},
		{"channel", func(_ *Group, r *ResolvedPricing) { r.Source = PricingSourceChannel }},
		{"token", func(g *Group, r *ResolvedPricing) {
			g.ModelPricing[0].BillingMode = BillingModeToken
			r.Mode = BillingModeToken
		}},
		{"platform", func(g *Group, _ *ResolvedPricing) { g.ModelPricing[0].Platform = PlatformAnthropic }},
		{"interval", func(g *Group, _ *ResolvedPricing) { g.ModelPricing[0].Intervals = []PricingInterval{{TierLabel: "1K"}} }},
		{"time", func(g *Group, _ *ResolvedPricing) { g.ModelPricing[0].TimePricing = &ChannelTimePricing{} }},
		{"negative", func(g *Group, _ *ResolvedPricing) { v := -1.0; g.ModelPricing[0].PerRequestPrice = &v }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := &Group{ModelPricing: []ChannelModelPricing{base}}
			r := *resolved
			tc.change(g, &r)
			require.False(t, imageReceiptAllowsZeroPrice("canvas-image-07", "canvas-image-07", g, &r))
		})
	}
	require.False(t, imageReceiptAllowsZeroPrice("canvas-image-06", "canvas-image-06", group, resolved))
	require.False(t, imageReceiptAllowsZeroPrice("gpt-image-2.5-flare", "gpt-image-2.5-flare", group, resolved))
	require.False(t, imageReceiptAllowsZeroPrice("canvas-image-07", "different-billing-model", group, resolved))
}

func TestImageReceiptZeroPriceCapCannotRepricePaidWork(t *testing.T) {
	h := http.Header{}
	for _, cap := range []string{"0", "0.000000", "0.01"} {
		h.Set(ImageReceiptMaxUSDHeader, cap)
		require.NoError(t, checkImageReceiptPriceCapWithZero(h, 0, true))
	}
	h.Set(ImageReceiptMaxUSDHeader, "0")
	require.ErrorIs(t, checkImageReceiptPriceCap(h, 0), ErrImageReceiptInvalidPriceCap)
	require.ErrorIs(t, checkImageReceiptPriceCapWithZero(h, 0.03, true), ErrImageReceiptPriceCapExceeded)
	for _, cost := range []float64{-1, math.NaN(), math.Inf(1)} {
		require.ErrorIs(t, checkImageReceiptPriceCapWithZero(h, cost, true), ErrImageReceiptInvalidPriceCap)
	}
	for _, cap := range []string{"", "-0", "NaN", "0.0000000", "9223372036855"} {
		h.Set(ImageReceiptMaxUSDHeader, cap)
		require.ErrorIs(t, checkImageReceiptPriceCapWithZero(h, 0, true), ErrImageReceiptInvalidPriceCap)
	}
	h.Add(ImageReceiptMaxUSDHeader, "0")
	require.ErrorIs(t, checkImageReceiptPriceCapWithZero(h, 0, true), ErrImageReceiptInvalidPriceCap)
}

func TestImageReceiptReferencePriceIsFrozenAndSettledOnce(t *testing.T) {
	for _, mode := range []BillingMode{BillingModeImage, BillingModePerRequest} {
		for _, model := range []string{"canvas-image-01", "canvas-image-07"} {
			t.Run(string(mode)+"/"+model, func(t *testing.T) {
				s, key, account, r, path, billing := receiptFixture(t)
				require.NoError(t, os.Remove(path))
				base, reference := 0.03, 0.06
				upstreamID, cap := "无限制-Seedream-5-Pro", "0.060000"
				if model == "canvas-image-07" {
					base, reference, upstreamID, cap = 0, 0, "免费GPT-image-2.5", "0"
				}
				key.Group.ModelPricing = []ChannelModelPricing{{Platform: PlatformOpenAI, Models: []string{model}, BillingMode: mode, PerRequestPrice: &base, ImageReferencePrice: &reference}}
				s.resolver = NewModelPricingResolver(nil, s.billingService)
				account.Credentials["base_url"] = "https://api.image2pro.top"
				account.Credentials["model_mapping"] = map[string]any{model: upstreamID}
				data := receiptPNG(t)
				var result struct {
					Data []struct {
						B64 string `json:"b64_json"`
					} `json:"data"`
				}
				require.NoError(t, json.Unmarshal(data, &result))
				ref := "data:image/png;base64," + result.Data[0].B64
				body, err := json.Marshal(map[string]any{"model": model, "prompt": "fixture", "n": 1, "images": []string{ref}})
				require.NoError(t, err)
				parsed := &OpenAIImagesRequest{Model: model, N: 1, SizeTier: "1K", ContentType: "application/json", Endpoint: openAIImagesEditsEndpoint, InputImageURLs: []string{ref}}
				started, release := make(chan struct{}), make(chan struct{})
				t.Cleanup(func() {
					select {
					case <-release:
					default:
						close(release)
					}
				})
				up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
					if req.URL.Path != "/v1/images/edits" {
						return nil, io.ErrUnexpectedEOF
					}
					close(started)
					<-release
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
				}}
				s.httpUpstream = up
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/edits", nil)
				c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
				c.Request.Header.Set(ImageReceiptMaxUSDHeader, cap)
				_, err = s.DispatchImageReceipt(context.Background(), c, account, body, parsed, &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account})
				require.NoError(t, err)
				select {
				case <-started:
				case <-time.After(5 * time.Second):
					t.Fatal("mock did not start")
				}
				stored, err := readImageReceipt(path)
				require.NoError(t, err)
				require.InDelta(t, reference, stored.Cost.ActualCost, 1e-9)
				// Mutable Group cards cannot reprice the persisted admission quote.
				changed := 0.99
				key.Group.ModelPricing[0].ImageReferencePrice = &changed
				close(release)
				require.Eventually(t, func() bool { _, busy := imageReceiptActive.Load(path); return !busy }, 5*time.Second, 10*time.Millisecond)
				require.Equal(t, 1, billing.calls)
				require.InDelta(t, reference, billing.lastCmd.BalanceCost, 1e-9)
				view, err := s.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
				require.NoError(t, err)
				require.Equal(t, "completed", view.Status)
				require.NoError(t, validateReceiptImageResult(view.Result))
				require.Equal(t, 1, up.calls)
				require.Equal(t, 1, billing.calls)
			})
		}
	}
}

func TestImageReceiptReferencePriceRequiresIndependentExplicitField(t *testing.T) {
	base, reference, tokenInput := 0.03, 0.06, 0.000002
	for _, mode := range []BillingMode{BillingModeImage, BillingModePerRequest} {
		card := ChannelModelPricing{Platform: PlatformOpenAI, Models: []string{"canvas-image-01"}, BillingMode: mode, PerRequestPrice: &base, ImageReferencePrice: &reference, ImageInputPrice: &tokenInput}
		group := &Group{ID: 31, ModelPricing: []ChannelModelPricing{card}}
		resolver := NewModelPricingResolver(nil, nil)
		resolved := resolver.Resolve(context.Background(), PricingInput{Model: "canvas-image-01", Group: group, GroupID: &group.ID})
		cost, free, err := imageReceiptReferenceCost("canvas-image-01", "canvas-image-01", group, resolved, 1, 2)
		require.NoError(t, err)
		require.False(t, free)
		require.InDelta(t, 0.12, cost.ActualCost, 1e-9)
		for _, price := range []*float64{nil, imageReceiptReferenceTestPrice(0), imageReceiptReferenceTestPrice(-1), imageReceiptReferenceTestPrice(math.NaN()), imageReceiptReferenceTestPrice(math.Inf(1))} {
			group.ModelPricing[0].ImageReferencePrice = price
			resolved = resolver.Resolve(context.Background(), PricingInput{Model: "canvas-image-01", Group: group, GroupID: &group.ID})
			_, _, err = imageReceiptReferenceCost("canvas-image-01", "canvas-image-01", group, resolved, 1, 1)
			require.Error(t, err)
		}
	}
	card := ChannelModelPricing{Platform: PlatformOpenAI, Models: []string{"canvas-image-01"}, BillingMode: BillingModeImage, PerRequestPrice: &base, ImageReferencePrice: &reference}
	encoded, err := json.Marshal(card)
	require.NoError(t, err)
	require.Contains(t, string(encoded), "image_reference_price")
	var reread ChannelModelPricing
	require.NoError(t, json.Unmarshal(encoded, &reread))
	require.Equal(t, reference, *reread.ImageReferencePrice)
	negative := -1.0
	reread.ImageReferencePrice = &negative
	require.Error(t, checkPricesNotNegative(reread))
}

func imageReceiptReferenceTestPrice(value float64) *float64 { return &value }

func TestImageReceiptReferenceAdmissionRejectsBeforeClaimOrPOST(t *testing.T) {
	for _, test := range []string{"missing_price", "cap_only_covers_text", "references_on_generation", "parsed_body_mismatch"} {
		t.Run(test, func(t *testing.T) {
			s, key, account, r, path, billing := receiptFixture(t)
			require.NoError(t, os.Remove(path))
			base, reference := 0.03, 0.06
			card := ChannelModelPricing{Platform: PlatformOpenAI, Models: []string{"canvas-image-01"}, BillingMode: BillingModeImage, PerRequestPrice: &base, ImageReferencePrice: &reference}
			if test == "missing_price" {
				card.ImageReferencePrice = nil
			}
			key.Group.ModelPricing = []ChannelModelPricing{card}
			s.resolver = NewModelPricingResolver(nil, s.billingService)
			account.Credentials["base_url"] = "https://api.image2pro.top"
			account.Credentials["model_mapping"] = map[string]any{"canvas-image-01": "无限制-Seedream-5-Pro"}
			var data struct {
				Data []struct {
					B64 string `json:"b64_json"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(receiptPNG(t), &data))
			ref := "data:image/png;base64," + data.Data[0].B64
			envelope := map[string]any{"model": "canvas-image-01", "prompt": "fixture", "n": 1, "images": []string{ref}}
			parsed := &OpenAIImagesRequest{Model: "canvas-image-01", N: 1, SizeTier: "1K", ContentType: "application/json", Endpoint: openAIImagesEditsEndpoint, InputImageURLs: []string{ref}}
			if test == "references_on_generation" {
				parsed.Endpoint = openAIImagesGenerationsEndpoint
				parsed.InputImageURLs = nil
			}
			if test == "parsed_body_mismatch" {
				delete(envelope, "images")
			}
			body, err := json.Marshal(envelope)
			require.NoError(t, err)
			up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF }}
			s.httpUpstream = up
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/edits", nil)
			c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
			c.Request.Header.Set(ImageReceiptMaxUSDHeader, "0.03")
			_, err = s.DispatchImageReceipt(context.Background(), c, account, body, parsed, &OpenAIRecordUsageInput{APIKey: key, User: key.User, Account: account})
			require.Error(t, err)
			if test == "cap_only_covers_text" {
				require.ErrorIs(t, err, ErrImageReceiptPriceCapExceeded)
			}
			require.Zero(t, up.calls)
			require.Zero(t, billing.calls)
			_, err = os.Stat(imageReceiptClaimPath(r.UserID, r.ClientKey))
			require.ErrorIs(t, err, os.ErrNotExist)
		})
	}
}

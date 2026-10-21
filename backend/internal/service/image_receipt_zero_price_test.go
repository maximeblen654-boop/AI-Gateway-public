//go:build unit

package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestImageReceiptHistoricalZeroPriceRestoresWithoutNewGeneration(t *testing.T) {
	for _, mode := range []BillingMode{BillingModeImage, BillingModePerRequest} {
		t.Run(string(mode), func(t *testing.T) {
			s, key, _, r, path := image2ProFixture(t)
			r.Model, r.UpstreamModel = "canvas-image-07", "免费GPT-image-2.5"
			r.Cost = &CostBreakdown{TotalCost: 0, ActualCost: 0, BillingMode: string(mode)}
			r.RequestBody, _ = json.Marshal(map[string]any{"model": r.UpstreamModel, "prompt": "historical-free", "n": 1})
			r.UpstreamPayloadHash = HashUsageRequestPayload(r.RequestBody)
			require.NoError(t, saveImageReceipt(path, r))
			require.NoError(t, persistImage2ProResponse(path, receiptPNG(t)))
			up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
				t.Fatal("historical free receipt cannot generate")
				return nil, nil
			}}
			s.httpUpstream = up
			require.NoError(t, s.runImage2ProReceipt(t.Context(), path, key, nil))
			stored, err := readImageReceipt(path)
			require.NoError(t, err)
			require.Equal(t, "billed", stored.BillingState)
			require.Zero(t, stored.Cost.ActualCost)
			require.Zero(t, stored.Cost.TotalCost)
			billing := s.usageBillingRepo.(*openAIRecordUsageBillingRepoStub)
			require.Equal(t, 1, billing.calls)
			require.Zero(t, billing.lastCmd.BalanceCost)
			require.Zero(t, billing.lastCmd.APIKeyQuotaCost)
			require.Zero(t, billing.lastCmd.APIKeyRateLimitCost)
			require.Zero(t, billing.lastCmd.AccountQuotaCost)
			require.NoError(t, s.runImage2ProReceipt(t.Context(), path, key, nil))
			view, err := s.GetImageReceipt(t.Context(), key, r.ClientKey, nil)
			require.NoError(t, err)
			require.Equal(t, "completed", view.Status)
			require.NoError(t, validateReceiptImageResult(view.Result))
			require.Zero(t, up.calls)
			require.Equal(t, 1, billing.calls)
		})
	}
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

func TestImageReceiptHistoricalReferencePriceStaysFrozenOnRecovery(t *testing.T) {
	for _, mode := range []BillingMode{BillingModeImage, BillingModePerRequest} {
		for _, model := range []string{"canvas-image-01", "canvas-image-07"} {
			t.Run(string(mode)+"/"+model, func(t *testing.T) {
				s, key, _, r, path := image2ProFixture(t)
				reference, upstream := 0.06, "无限制-Seedream-5-Pro"
				if model == "canvas-image-07" {
					reference, upstream = 0, "免费GPT-image-2.5"
				}
				r.Model, r.UpstreamModel, r.CreatePath = model, upstream, openAIImagesEditsEndpoint
				r.Cost = &CostBreakdown{TotalCost: reference, ActualCost: reference, BillingMode: string(mode)}
				r.RequestBody, _ = json.Marshal(map[string]any{"model": upstream, "prompt": "historical-reference", "n": 1, "images": []string{"data:image/png;base64,AQ=="}})
				r.UpstreamPayloadHash = HashUsageRequestPayload(r.RequestBody)
				require.NoError(t, saveImageReceipt(path, r))
				// Current Group data cannot reprice a persisted historical receipt.
				changed := 0.99
				key.Group.ModelPricing = []ChannelModelPricing{{Platform: PlatformOpenAI, Models: []string{model}, BillingMode: mode, PerRequestPrice: &changed, ImageReferencePrice: &changed}}
				require.NoError(t, persistImage2ProResponse(path, receiptPNG(t)))
				up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
					t.Fatal("historical reference receipt cannot generate")
					return nil, nil
				}}
				s.httpUpstream = up
				require.NoError(t, s.runImage2ProReceipt(t.Context(), path, key, nil))
				billing := s.usageBillingRepo.(*openAIRecordUsageBillingRepoStub)
				require.Equal(t, 1, billing.calls)
				require.InDelta(t, reference, billing.lastCmd.BalanceCost, 1e-9)
				stored, err := readImageReceipt(path)
				require.NoError(t, err)
				require.InDelta(t, reference, stored.Cost.ActualCost, 1e-9)
				require.NoError(t, s.runImage2ProReceipt(t.Context(), path, key, nil))
				require.Equal(t, 1, billing.calls)
				require.Zero(t, up.calls)
			})
		}
	}
}

func TestImageReceiptHistoricalReferencePriceFieldRemainsReadable(t *testing.T) {
	base, reference := 0.03, 0.06
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

// Preserve the original alias price calculation only as historical unit-test
// evidence. No runtime path creates receipts through this retired contract.
func imageReceiptReferenceCost(model, pricingModel string, group *Group, resolved *ResolvedPricing, count int, multiplier float64) (*CostBreakdown, bool, error) {
	card := imageReceiptFlatGroupCard(model, group, resolved)
	if !isImage2ProModel(model) || pricingModel != model || card == nil || card.PerRequestPrice == nil || *card.PerRequestPrice < 0 || card.ImageReferencePrice == nil || resolved.ImageReferencePrice == nil {
		return nil, false, errors.New("explicit reference image customer price unavailable")
	}
	unit := *card.ImageReferencePrice
	if unit != *resolved.ImageReferencePrice || math.IsNaN(unit) || math.IsInf(unit, 0) || unit < 0 || (unit == 0 && model != "canvas-image-07") || math.IsNaN(multiplier) || math.IsInf(multiplier, 0) || multiplier <= 0 || count < 1 {
		return nil, false, errors.New("invalid reference image customer price")
	}
	cost := &CostBreakdown{TotalCost: unit * float64(count), ActualCost: unit * float64(count) * multiplier, BillingMode: string(resolved.Mode)}
	if math.IsNaN(cost.ActualCost) || math.IsInf(cost.ActualCost, 0) {
		return nil, false, errors.New("invalid reference image customer cost")
	}
	return cost, model == "canvas-image-07" && unit == 0, nil
}

package service

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLegacyGroupImageReferencePriceRoundTrip(t *testing.T) {
	for _, value := range []string{"null", "0", "0.237891"} {
		input := []byte(`{"models":["08GPT-Image-2.5-1K"],"billing_mode":"image","per_request_price":0.123456,"image_reference_price":` + value + `,"intervals":[]}`)
		var price ChannelModelPricing
		require.NoError(t, json.Unmarshal(input, &price))
		require.NoError(t, checkPricesNotNegative(price))
		raw, err := json.Marshal(price)
		require.NoError(t, err)
		var restored ChannelModelPricing
		require.NoError(t, json.Unmarshal(raw, &restored))
		require.Equal(t, price.ImageReferencePrice, restored.ImageReferencePrice)
		require.Equal(t, price.PerRequestPrice, restored.PerRequestPrice)
		var resolved ResolvedPricing
		(&ModelPricingResolver{}).applyRequestTierOverrides(&restored, &resolved)
		require.Equal(t, restored.ImageReferencePrice, resolved.ImageReferencePrice)
		require.Equal(t, 0.123456, resolved.DefaultPerRequestPrice)
	}
	for _, v := range []float64{-0.01, math.NaN(), math.Inf(1)} {
		require.Error(t, checkPricesNotNegative(ChannelModelPricing{ImageReferencePrice: &v}))
	}
}

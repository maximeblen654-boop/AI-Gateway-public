package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestStudioImageReceiptResponsePreservesV2TotalAndV3Counters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	quote := service.StudioImageQuote{Binding: mediaworkbench.ResolvedImageOffer{Spec: mediaworkbench.Spec{Count: 1}, Offer: mediaworkbench.Offer{SalePrice: mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}}
	for _, tc := range []struct {
		name         string
		version      string
		wantCounters bool
	}{
		{name: "v2", version: service.StudioImageReceiptVersion},
		{name: "v3", version: service.StudioImageMultiReceiptVersion, wantCounters: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &service.StudioImageReceipt{Version: tc.version, TaskID: "img_receipt", Quote: quote, Status: "completed", BillingState: "billed", ResultHash: "hash", ExpectedCount: 1, DeliveredCount: 1}
			if tc.wantCounters {
				r.Quote.Execution = &mediaworkbench.ImageExecutionPlan{Mode: mediaworkbench.ImageExecutionSingle, MaxOutputImages: 1}
			}
			if !tc.wantCounters {
				r.DeliveredCount = 0
			}
			out := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(out)
			studioReceiptResponse(c, r)
			var body map[string]any
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &body))
			require.Equal(t, tc.version, body["receipt_version"])
			settledPrice, ok := body["settled_price"].(map[string]any)
			require.True(t, ok)
			require.Equal(t, "0.80", settledPrice["amount"])
			if tc.wantCounters {
				require.Equal(t, float64(1), body["delivered_count"])
			} else {
				_, exists := body["delivered_count"]
				require.False(t, exists)
			}
		})
	}
}

func TestStudioImageUnknownReceiptRemainsReadableDuringGenerationPause(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := service.NewStudioImageStore(t.TempDir())
	now := time.Now().UTC()
	owner := service.StudioImageOwner{UserID: 1, APIKeyID: 2, GroupID: 3}
	q := service.StudioImageQuote{Owner: owner, CreatedAt: now, ExpiresAt: now.Add(time.Minute), Binding: mediaworkbench.ResolvedImageOffer{Version: mediaworkbench.ImageBindingVersion, Spec: mediaworkbench.Spec{Count: 1}, SpecHash: "spec", Offer: mediaworkbench.Offer{AccountID: 7, UpstreamModel: "gpt-image-2"}}, Accounting: service.AccountAccountingSnapshot{Version: service.StudioImageAccountingVersion, SourceState: "not_required", SourceType: "unavailable", AccountID: 7, UpstreamModel: "gpt-image-2", SpecHash: "spec", RequestCount: 1, PricingAt: now, Unit: "CNY", BaseAmount: "0", AccountRateMultiplier: "1", EffectiveAccountQuotaCost: "0"}}
	token, err := store.Issue(q)
	require.NoError(t, err)
	q, err = store.Quote(token, owner, now)
	require.NoError(t, err)
	body := []byte(`{"model":"gpt-image-2","n":1,"prompt":"synthetic"}`)
	_, first, err := store.Claim(service.StudioImageReceipt{Version: service.StudioImageReceiptVersion, TaskID: "original", Quote: q, Request: body, PayloadHash: service.HashUsageRequestPayload(body)})
	require.NoError(t, err)
	require.True(t, first)
	h := &OpenAIGatewayHandler{studioImage: &service.StudioImageRuntime{Store: store, Core: &service.OpenAIGatewayService{}}}
	key := &service.APIKey{ID: 2, UserID: 1, GroupID: &owner.GroupID, User: &service.User{ID: 1}, Group: &service.Group{ID: 3, AllowImageGeneration: false}}
	call := func(read bool, userID int64) *httptest.ResponseRecorder {
		out := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(out)
		c.Request = httptest.NewRequest("GET", "/v1/studio/images/tasks/original", nil)
		c.Params = gin.Params{{Key: "task_id", Value: "original"}}
		c.Set(string(middleware2.ContextKeyAPIKey), key)
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: userID})
		if read {
			h.StudioImageReceipt(c)
		} else {
			h.StudioImageReadiness(c)
		}
		return out
	}
	result := call(true, 1)
	require.Equal(t, 200, result.Code)
	require.Contains(t, result.Body.String(), `"status":"unknown"`)
	require.NotContains(t, result.Body.String(), "account_accounting")
	require.Equal(t, 403, call(false, 1).Code)
	require.Equal(t, 403, call(true, 9).Code)
}

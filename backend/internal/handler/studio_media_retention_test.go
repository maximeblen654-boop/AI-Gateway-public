package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestStudioReceiptExpiredResultRemainsFinanciallyReadable(t *testing.T) {
	first := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	expires := first.Add(72 * time.Hour)
	receipt := &service.StudioImageReceipt{TaskID: "original", ResultHash: "preserved-hash", BillingState: "billed", Status: "completed", Version: service.StudioImageReceiptVersion, ResultRetention: &service.StudioResultRetention{PersistedAt: &first, ExpiresAt: &expires, Expired: true, Policy: service.StudioImageRetentionPolicy}}
	out := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(out)
	studioReceiptResponse(ctx, receipt)
	var body map[string]any
	require.NoError(t, json.Unmarshal(out.Body.Bytes(), &body))
	require.Equal(t, 200, out.Code)
	require.Equal(t, "billed", body["billing_state"])
	require.Equal(t, false, body["result_available"])
	require.Equal(t, true, body["result_retention"].(map[string]any)["expired"])
}

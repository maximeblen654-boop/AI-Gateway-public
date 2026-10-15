package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func studioOpsFailedReceipt() *service.StudioImageReceipt {
	return &service.StudioImageReceipt{TaskID: "image-failed", Status: "failed", BillingState: "not_charged", FailedCount: 1,
		HTTPFailure: &service.StudioImageHTTPFailure{Status: 502, NoChargeFinal: true}}
}

// Controlled ablation: only the native marker differs. Before the fix a real
// failed image was labelled recovered (200), excluded by the V2 status>=400 SQL.
func TestStudioImageTerminalOpsFailureCountsNative502Once(t *testing.T) {
	for _, mark := range []bool{false, true} {
		name := "previous_unmarked"
		if mark {
			name = "marked"
		}
		t.Run(name, func(t *testing.T) {
			setupOpsErrorLogTestQueue(t, 4)
			gin.SetMode(gin.TestMode)
			repo := &ingressRejectOpsRepo{}
			ops := service.NewOpsService(repo, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
			router := gin.New()
			router.Use(OpsErrorLoggerMiddleware(ops))
			router.POST("/v1/studio/images/tasks", func(c *gin.Context) {
				gid := int64(31)
				c.Set(string(middleware2.ContextKeyAPIKey), &service.APIKey{ID: 3, UserID: 2, GroupID: &gid, Group: &service.Group{ID: gid, Platform: "openai"}, User: &service.User{ID: 2}})
				c.Header("X-Request-Id", "request-synthetic")
				setOpsRequestContext(c, "site-image", false)
				setOpsSelectedAccount(c, 77)
				c.Set(service.OpsUpstreamModelKey, "upstream-image")
				service.SetOpsUpstreamError(c, 502, "capacity unavailable", "")
				c.Set(service.OpsUpstreamErrorsKey, []*service.OpsUpstreamErrorEvent{{AccountID: 77, UpstreamStatusCode: 502, Message: "capacity unavailable"}})
				receipt := studioOpsFailedReceipt()
				if mark {
					markStudioImageTerminalOpsFailure(c, receipt)
					markStudioImageTerminalOpsFailure(c, receipt)
				}
				studioReceiptResponse(c, receipt)
			})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/studio/images/tasks", nil))
			require.Equal(t, http.StatusOK, w.Code)
			require.Contains(t, w.Body.String(), `"status":"failed"`)
			require.Contains(t, w.Body.String(), `"billing_state":"not_charged"`)
			require.Equal(t, int64(1), OpsErrorLogQueueLength())
			job := <-opsErrorLogQueue
			flushOpsErrorLogBatch([]opsErrorLogJob{job})
			require.Len(t, repo.entries, 1)
			row := repo.entries[0]
			require.Equal(t, "site-image", row.RequestedModel)
			require.Equal(t, "upstream-image", row.UpstreamModel)
			require.Equal(t, int64(31), *row.GroupID)
			require.Equal(t, int64(77), *row.AccountID)
			require.Equal(t, int64(2), *row.UserID)
			require.Equal(t, int64(3), *row.APIKeyID)
			require.Equal(t, "request-synthetic", row.RequestID)
			require.Equal(t, 502, *row.UpstreamStatusCode)
			require.False(t, row.Stream)
			if mark {
				require.Equal(t, 502, row.StatusCode)
				require.Equal(t, "provider", row.ErrorOwner)
				require.NotContains(t, row.ErrorMessage, "Recovered")
				require.Equal(t, "upstream_5xx", service.ClassifyChannelMonitorV2Error(service.ChannelMonitorV2ErrorInput{StatusCode: row.StatusCode, UpstreamStatusCode: *row.UpstreamStatusCode, ErrorOwner: row.ErrorOwner}))
			} else {
				require.Equal(t, 200, row.StatusCode)
				require.Contains(t, row.ErrorMessage, "Recovered")
			}
		})
	}
}
func TestStudioImageTerminalOpsFailureDoesNotCountQueriesReplaysOrPartial(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		native       bool
		change       func(*service.StudioImageReceipt)
	}{
		{"original GET", http.MethodGet, true, func(r *service.StudioImageReceipt) {}},
		{"idempotent POST no new attempt", http.MethodPost, false, func(r *service.StudioImageReceipt) {}},
		{"partial delivery", http.MethodPost, true, func(r *service.StudioImageReceipt) {
			r.Status = "partial"
			r.DeliveredCount = 1
			r.ResultHash = "saved-result"
			r.BillingState = "settled"
		}},
		{"success", http.MethodPost, true, func(r *service.StudioImageReceipt) {
			r.Status = "completed"
			r.DeliveredCount = 1
			r.BillingState = "settled"
		}},
		{"unknown timeout", http.MethodPost, false, func(r *service.StudioImageReceipt) {
			r.Status = "unknown"
			r.BillingState = "pending"
			r.HTTPFailure = nil
		}},
		{"no trusted terminal proof", http.MethodPost, true, func(r *service.StudioImageReceipt) { r.HTTPFailure = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(tc.method, "/v1/studio/images/tasks", nil)
			if tc.native {
				service.SetOpsUpstreamError(c, 502, "capacity", "")
			}
			r := studioOpsFailedReceipt()
			tc.change(r)
			markStudioImageTerminalOpsFailure(c, r)
			require.Empty(t, service.GetOpsStreamErrors(c))
		})
	}
}

func TestStudioImageTerminalOpsFailureAcceptsMultiUnitTerminalProof(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/studio/images/tasks", nil)
	service.SetOpsUpstreamError(c, 502, "capacity", "")
	r := studioOpsFailedReceipt()
	proof := r.HTTPFailure
	r.HTTPFailure = nil
	r.Units = []service.StudioImageUnitReceipt{{Status: "failed", Error: "upstream_http_502_no_delivery", HTTPFailure: proof}}
	markStudioImageTerminalOpsFailure(c, r)
	marks := service.GetOpsStreamErrors(c)
	require.Len(t, marks, 1)
	require.True(t, marks[0].NonStream)
	require.True(t, marks[0].CountTowardsSLA)
	require.Equal(t, 502, marks[0].IntendedStatus)
}

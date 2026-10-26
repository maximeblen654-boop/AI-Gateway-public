package handler

import (
	"encoding/json"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStudioPaidApplyModeHandlerContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, body string
		auth       bool
		status     int
		echo       bool
	}{
		{"default", `{"enabled":true,"expected_revision":"synthetic","fingerprint":"synthetic"}`, true, 409, false},
		{"explicit-renew", `{"enabled":true,"expected_revision":"synthetic","fingerprint":"synthetic","mode":"renew-existing"}`, true, 409, true},
		{"unknown-mode", `{"enabled":true,"mode":"unknown"}`, true, 400, false},
		{"renew-disable", `{"enabled":false,"mode":"renew-existing"}`, true, 400, false},
		{"client-grants-forbidden", `{"enabled":true,"mode":"renew-existing","offer_grants":{"synthetic":"synthetic"}}`, true, 400, false},
		{"client-actor-forbidden", `{"enabled":true,"mode":"renew-existing","actor":91001}`, true, 400, false},
		{"unauthenticated", `{"enabled":true,"mode":"renew-existing"}`, false, 401, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest("PUT", "/synthetic-paid-control/video", strings.NewReader(tc.body))
			c.Params = gin.Params{{Key: "media", Value: "video"}}
			if tc.auth {
				c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: 91001})
			}
			h := &OpenAIGatewayHandler{studioPaidControl: &service.StudioPaidControl{}}
			h.StudioPaidApply(c)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			var reply struct {
				Data map[string]json.RawMessage `json:"data"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &reply)
			mode, exists := reply.Data["mode"]
			if exists != tc.echo || exists && string(mode) != `"renew-existing"` {
				t.Fatalf("mode echo changed: %s", w.Body.String())
			}
		})
	}
}

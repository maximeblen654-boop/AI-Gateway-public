package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"net/http"
	"os"
)

func (h *OpenAIGatewayHandler) StudioPaidStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	response.Success(c, h.studioPaidControl.Status(c.Request.Context(), c.Param("media")))
}
func (h *OpenAIGatewayHandler) StudioPaidCheck(c *gin.Context) {
	actor, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		c.AbortWithStatus(401)
		return
	}
	c.Header("Cache-Control", "no-store")
	response.Success(c, h.studioPaidControl.Preflight(c.Request.Context(), c.Param("media"), actor.UserID))
}
func (h *OpenAIGatewayHandler) StudioPaidApply(c *gin.Context) {
	actor, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		c.AbortWithStatus(401)
		return
	}
	var in struct {
		Enabled     *bool  `json:"enabled"`
		Revision    string `json:"expected_revision"`
		Fingerprint string `json:"fingerprint"`
	}
	if studioDecode(c, &in) != nil || in.Enabled == nil {
		response.BadRequest(c, "Invalid switch request")
		return
	}
	state, report, err := h.studioPaidControl.Apply(c.Request.Context(), c.Param("media"), actor.UserID, *in.Enabled, in.Revision, in.Fingerprint)
	c.Header("Cache-Control", "no-store")
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "付费开关未开启，请重新检查", "data": gin.H{"state": state, "report": report}})
		return
	}
	response.Success(c, gin.H{"state": state, "report": report})
}
func (h *OpenAIGatewayHandler) StudioPaidInternal(c *gin.Context) {
	secret := os.Getenv("STUDIO_BRIDGE_SERVICE_TOKEN")
	expected := sha256.Sum256([]byte(secret))
	actual := sha256.Sum256([]byte(c.GetHeader("X-Studio-Service-Token")))
	if len(secret) < 32 || subtle.ConstantTimeCompare(expected[:], actual[:]) != 1 {
		c.AbortWithStatus(401)
		return
	}
	m := c.Param("media")
	if m != "image" && m != "video" {
		c.AbortWithStatus(404)
		return
	}
	state := h.studioPaidControl.Status(c.Request.Context(), m)
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"mode": state.Mode, "paid_enabled": state.Effective})
}

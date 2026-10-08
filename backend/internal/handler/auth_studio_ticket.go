package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"os"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

// EnableStudioTickets reuses the existing Redis connection. The consumption
// endpoint remains disabled until a dedicated service secret is configured.
func (h *AuthHandler) EnableStudioTickets(rdb service.StudioTicketStore) {
	if h != nil && rdb != nil {
		h.studioTickets = service.NewStudioTicketService(rdb, h.userService)
		if h.authService != nil {
			h.authService.SetStudioTicketService(h.studioTickets)
		}
	}
}

func (h *AuthHandler) ConsumeStudioTicket(c *gin.Context) {
	if !h.authorizeStudioService(c) {
		return
	}
	var req struct {
		Ticket string `json:"ticket" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid ticket request")
		return
	}
	identity, err := h.studioTickets.Consume(c.Request.Context(), req.Ticket)
	if err != nil {
		response.Unauthorized(c, "Invalid or expired ticket")
		return
	}
	c.Header("Cache-Control", "no-store")
	response.Success(c, identity)
}

func (h *AuthHandler) VerifyStudioSession(c *gin.Context) {
	if !h.authorizeStudioService(c) {
		return
	}
	var req struct {
		SessionProof string `json:"session_proof" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid session request")
		return
	}
	identity, err := h.studioTickets.Verify(c.Request.Context(), req.SessionProof)
	if err != nil {
		response.Unauthorized(c, "Invalid Studio session")
		return
	}
	c.Header("Cache-Control", "no-store")
	response.Success(c, identity)
}

func (h *AuthHandler) authorizeStudioService(c *gin.Context) bool {
	secret := os.Getenv("STUDIO_BRIDGE_SERVICE_TOKEN")
	if h.studioTickets == nil || len(secret) < 32 {
		response.Unauthorized(c, "Studio bridge disabled")
		return false
	}
	presented := c.GetHeader("X-Studio-Service-Token")
	if len(presented) != len(secret) {
		response.Unauthorized(c, "Unauthorized service")
		return false
	}
	want, got := sha256.Sum256([]byte(secret)), sha256.Sum256([]byte(presented))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		response.Unauthorized(c, "Unauthorized service")
		return false
	}
	return true
}

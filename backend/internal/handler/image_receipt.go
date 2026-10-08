package handler

import (
	"errors"
	"net/http"
	"os"
	"strings"

	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func firstReceiptModel(mapped, original string) string {
	if strings.TrimSpace(mapped) != "" {
		return mapped
	}
	return original
}

func (h *OpenAIGatewayHandler) ImageReceipt(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	key, ok := middleware2.GetAPIKeyFromContext(c)
	if !ok || key == nil || key.User == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error_code": "unauthorized"})
		return
	}
	if !service.ValidImageReceiptKey(c.Param("client_key")) {
		c.JSON(http.StatusNotFound, gin.H{"error_code": "receipt_not_found"})
		return
	}
	view, err := h.gatewayService.GetImageReceipt(c.Request.Context(), key, c.Param("client_key"), h.apiKeyService)
	if err != nil {
		status := http.StatusServiceUnavailable
		code := "receipt_unavailable"
		if errors.Is(err, os.ErrNotExist) {
			status = http.StatusNotFound
			code = "receipt_not_found"
		}
		c.JSON(status, gin.H{"error_code": code})
		return
	}
	if view.Status != "completed" {
		c.Header("Retry-After", "3")
	}
	c.JSON(http.StatusOK, view)
}

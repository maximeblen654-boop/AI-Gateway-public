package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
)

// EnsureStudioCredential never returns key material or accepts caller-selected
// identity, Group, limits or pricing. JWT identity and native permissions apply.
func (h *APIKeyHandler) EnsureStudioCredential(c *gin.Context) {
	subject, ok := middleware.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	var input struct {
		Media string `json:"media"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 128))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		response.BadRequest(c, "Invalid Studio request")
		return
	}
	if err := h.apiKeyService.EnsureStudioCredential(c.Request.Context(), subject.UserID, input.Media); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"prepared": true})
}

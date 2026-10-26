package admin

import (
	"errors"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

func (h *MediaWorkbenchHandler) ModelBinding(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		Expected *int64 `json:"expected_record_version"`
		mediaworkbench.ModelBindingInput
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	if in.Expected == nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return
	}
	detail, err := h.service.ModelBinding(c.Request.Context(), id, *in.Expected, in.ModelBindingInput)
	if errors.Is(err, mediaworkbench.ErrValidation) {
		c.JSON(http.StatusUnprocessableEntity, response.Response{Code: 422, Reason: "MEDIA_VALIDATION_FAILED", Message: "Model binding validation failed; no changes were saved", Data: detail})
		return
	}
	if !response.ErrorFrom(c, err) {
		response.Success(c, detail)
	}
}

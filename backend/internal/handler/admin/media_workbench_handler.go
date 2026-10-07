package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

type MediaWorkbenchHandler struct{ service *mediaworkbench.Service }

func (h *MediaWorkbenchHandler) BindVideoAdapter(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		Expected *int64 `json:"expected_record_version"`
		Kind     string `json:"kind"`
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	if in.Expected == nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return
	}
	v, e := h.service.BindVideoAdapter(c.Request.Context(), id, *in.Expected, in.Kind)
	if !response.ErrorFrom(c, e) {
		response.Success(c, v)
	}
}

func NewMediaWorkbenchHandler(s *mediaworkbench.Service) *MediaWorkbenchHandler {
	return &MediaWorkbenchHandler{service: s}
}

func (h *MediaWorkbenchHandler) Publish(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		Expected *int64  `json:"expected_record_version"`
		Revision *string `json:"expected_draft_revision"`
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	if in.Expected == nil || in.Revision == nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return
	}
	v, err := h.service.Publish(c.Request.Context(), id, *in.Expected, *in.Revision)
	if errors.Is(err, mediaworkbench.ErrValidation) {
		c.JSON(http.StatusUnprocessableEntity, response.Response{Code: 422, Reason: "MEDIA_VALIDATION_FAILED", Message: "Draft validation prevents publishing", Data: v})
		return
	}
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}
func (h *MediaWorkbenchHandler) Suppliers(c *gin.Context) {
	v, err := h.service.Suppliers(c.Request.Context())
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}
func mediaAccountID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return 0, false
	}
	return id, true
}

// Bound input size, reject unknown/server-owned fields and trailing JSON. Never
// echo the decoder error (which can contain caller-provided secret field names).
func decodeMediaInput(c *gin.Context, v any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	d := json.NewDecoder(c.Request.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return false
	}
	return true
}
func (h *MediaWorkbenchHandler) Detail(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	v, err := h.service.Detail(c.Request.Context(), id)
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}
func (h *MediaWorkbenchHandler) Initialize(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		MediaTypes []string `json:"media_types"`
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	v, err := h.service.Initialize(c.Request.Context(), id, in.MediaTypes)
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}
func (h *MediaWorkbenchHandler) SaveDraft(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		Expected *int64                     `json:"expected_record_version"`
		Draft    *mediaworkbench.DraftInput `json:"draft"`
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	if in.Expected == nil || in.Draft == nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return
	}
	v, err := h.service.SaveDraft(c.Request.Context(), id, *in.Expected, *in.Draft)
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}
func (h *MediaWorkbenchHandler) SetSales(c *gin.Context) {
	id, ok := mediaAccountID(c)
	if !ok {
		return
	}
	var in struct {
		Expected *int64 `json:"expected_record_version"`
		Enabled  *bool  `json:"enabled"`
	}
	if !decodeMediaInput(c, &in) {
		return
	}
	if in.Expected == nil || in.Enabled == nil {
		response.ErrorFrom(c, mediaworkbench.ErrInvalid)
		return
	}
	v, err := h.service.SetSales(c.Request.Context(), id, *in.Expected, *in.Enabled)
	if !response.ErrorFrom(c, err) {
		response.Success(c, v)
	}
}

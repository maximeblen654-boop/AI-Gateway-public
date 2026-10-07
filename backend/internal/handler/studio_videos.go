package handler

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func (h *OpenAIGatewayHandler) videoOwner(c *gin.Context) (service.StudioImageOwner, *service.APIKey, bool) {
	key, ok := middleware2.GetAPIKeyFromContext(c)
	subject, auth := middleware2.GetAuthSubjectFromContext(c)
	if !ok || !auth || key.GroupID == nil || key.Group == nil || key.User == nil || key.UserID != subject.UserID || h.studioVideo == nil || !middleware2.StudioVideoServiceAuthorized(c.Request) {
		c.JSON(403, gin.H{"error": "video_identity_unavailable"})
		return service.StudioImageOwner{}, nil, false
	}
	return service.StudioImageOwner{UserID: subject.UserID, APIKeyID: key.ID, GroupID: *key.GroupID}, key, true
}
func videoError(c *gin.Context, e error) {
	c.JSON(http.StatusConflict, gin.H{"error": "video_binding_unavailable"})
}

func (h *OpenAIGatewayHandler) StudioVideoCatalog(c *gin.Context) {
	owner, key, ok := h.videoOwner(c)
	if !ok {
		return
	}
	offers, e := h.studioVideo.Catalog(c.Request.Context(), owner, key)
	if e != nil {
		videoError(c, e)
		return
	}
	c.JSON(200, gin.H{"contract": service.StudioVideoBindingVersion, "offers": offers})
}
func (h *OpenAIGatewayHandler) StudioVideoReadiness(c *gin.Context) {
	if _, _, ok := h.videoOwner(c); !ok {
		return
	}
	c.JSON(200, gin.H{"contract": service.StudioVideoBindingVersion, "paid_enabled": h.studioVideo.Enabled()})
}
func (h *OpenAIGatewayHandler) StudioVideoQuote(c *gin.Context) {
	owner, key, ok := h.videoOwner(c)
	if !ok {
		return
	}
	var input struct {
		OfferID       string              `json:"offer_id"`
		Spec          mediaworkbench.Spec `json:"spec"`
		Request       json.RawMessage     `json:"request"`
		PreparationID string              `json:"preparation_id"`
	}
	if e := studioDecode(c, &input); e != nil {
		videoError(c, e)
		return
	}
	if key.Group.IsSubscriptionType() || h.billingCacheService == nil {
		videoError(c, service.ErrStudioVideoInvalidOrder)
		return
	}
	if e := h.billingCacheService.CheckBillingEligibility(c.Request.Context(), key.User, key, key.Group, nil, service.QuotaPlatform(c.Request.Context(), key)); e != nil {
		videoError(c, e)
		return
	}
	token, q, e := h.studioVideo.IssueWithPreparation(c.Request.Context(), owner, key, input.OfferID, input.Spec, input.Request, input.PreparationID)
	if e != nil {
		videoError(c, e)
		return
	}
	// Internal Bridge/BFF response. Browser serializers expose only price/token/spec.
	c.JSON(200, gin.H{"contract": service.StudioVideoBindingVersion, "quote_token": token, "binding": q.Binding, "binding_hash": q.BindingHash})
}

func (h *OpenAIGatewayHandler) StudioVideoPrepare(c *gin.Context) {
	owner, key, ok := h.videoOwner(c)
	if !ok {
		return
	}
	if os.Getenv("STUDIO_VIDEO_REFERENCE_UPLOAD") != "true" {
		c.JSON(503, gin.H{"error": "reference_upload_gate_off"})
		return
	}
	var input struct {
		OfferID string                              `json:"offer_id"`
		Spec    mediaworkbench.Spec                 `json:"spec"`
		Assets  []service.StudioVideoReferenceAsset `json:"assets"`
	}
	if e := studioDecode(c, &input); e != nil || input.OfferID == "" || len(input.Assets) == 0 {
		videoError(c, service.ErrStudioVideoInvalidOrder)
		return
	}
	prepared, e := h.studioVideo.PrepareReferenceAssets(c.Request.Context(), owner, key, input.OfferID, input.Spec, input.Assets)
	if e != nil {
		videoError(c, e)
		return
	}
	c.JSON(200, gin.H{"contract": service.StudioVideoReferencePreparationVersion, "offer_id": input.OfferID, "preparation_id": prepared.PreparationID, "receipts": prepared.Receipts})
}
func (h *OpenAIGatewayHandler) StudioVideoSubmit(c *gin.Context) {
	owner, key, ok := h.videoOwner(c)
	if !ok {
		return
	}
	if !h.studioVideo.Enabled() {
		c.JSON(503, gin.H{"error": "account_video_paid_gate_off"})
		return
	}
	var input struct {
		Token  string `json:"quote_token"`
		TaskID string `json:"task_id"`
	}
	if e := studioDecode(c, &input); e != nil {
		videoError(c, e)
		return
	}
	q, e := h.studioVideo.Store.Quote(input.Token, owner)
	if e != nil {
		videoError(c, e)
		return
	}
	log := requestLogger(c, "handler.studio_videos")
	if !h.ensureResponsesDependencies(c, log) {
		return
	}
	subject, _ := middleware2.GetAuthSubjectFromContext(c)
	if decision := h.checkSecurityAudit(c, log, key, subject, service.ContentModerationProtocolOpenAIImages, q.Binding.Offer.SiteModel, q.Plan.Body); decision != nil && !decision.AllowNextStage {
		h.openAISecurityAuditError(c, decision)
		return
	}
	if e := h.billingCacheService.CheckBillingEligibility(c.Request.Context(), key.User, key, key.Group, nil, service.QuotaPlatform(c.Request.Context(), key)); e != nil {
		videoError(c, e)
		return
	}
	state, e := h.studioVideo.Submit(c.Request.Context(), owner, key, input.Token, input.TaskID)
	if e != nil && state.TaskID == "" {
		videoError(c, e)
		return
	}
	c.JSON(200, state)
}
func (h *OpenAIGatewayHandler) StudioVideoReceipt(c *gin.Context) {
	owner, _, ok := h.videoOwner(c)
	if !ok {
		return
	}
	state, e := h.studioVideo.Recover(c.Request.Context(), owner, c.Param("task_id"))
	if e != nil && state.TaskID == "" {
		videoError(c, e)
		return
	}
	c.JSON(200, state)
}
func (h *OpenAIGatewayHandler) StudioVideoResult(c *gin.Context) {
	owner, _, ok := h.videoOwner(c)
	if !ok {
		return
	}
	body, mime, e := h.studioVideo.Original(c.Request.Context(), owner, c.Param("task_id"))
	if e != nil {
		videoError(c, e)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Video-Quality", "original")
	c.Data(200, mime, body)
}
func (h *OpenAIGatewayHandler) StudioVideoCapture(c *gin.Context) {
	owner, _, ok := h.videoOwner(c)
	if !ok {
		return
	}
	var input struct {
		ResultHash string `json:"result_hash"`
	}
	if e := studioDecode(c, &input); e != nil {
		videoError(c, e)
		return
	}
	order, e := h.studioVideo.Capture(c.Request.Context(), owner, c.Param("task_id"), input.ResultHash)
	if e != nil {
		videoError(c, e)
		return
	}
	c.JSON(200, gin.H{"contract": service.StudioVideoBindingVersion, "task_id": order.ChildID, "status": "captured"})
}
func (h *OpenAIGatewayHandler) StudioVideoRelease(c *gin.Context) {
	owner, _, ok := h.videoOwner(c)
	if !ok {
		return
	}
	order, e := h.studioVideo.Release(c.Request.Context(), owner, c.Param("task_id"))
	if e != nil {
		videoError(c, e)
		return
	}
	c.JSON(200, gin.H{"contract": service.StudioVideoBindingVersion, "task_id": order.ChildID, "status": "released"})
}

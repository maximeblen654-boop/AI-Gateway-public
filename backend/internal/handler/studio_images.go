package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func (h *OpenAIGatewayHandler) studioOwner(c *gin.Context, readOnly bool) (service.StudioImageOwner, *service.APIKey, bool) {
	key, ok := middleware2.GetAPIKeyFromContext(c)
	subject, auth := middleware2.GetAuthSubjectFromContext(c)
	if !ok || !auth || key.GroupID == nil || key.User == nil || subject.UserID != key.UserID || !readOnly && !service.GroupAllowsImageGeneration(key.Group) || h.studioImage == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "studio_image_not_available"})
		return service.StudioImageOwner{}, nil, false
	}
	return service.StudioImageOwner{UserID: subject.UserID, APIKeyID: key.ID, GroupID: *key.GroupID}, key, true
}
func studioDecode(c *gin.Context, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return mediaworkbench.ErrRuntimeBinding
	}
	return nil
}
func studioError(c *gin.Context, err error) {
	c.JSON(http.StatusConflict, gin.H{"error": "studio_image_binding_unavailable", "message": err.Error()})
}

func (h *OpenAIGatewayHandler) StudioImageQuote(c *gin.Context) {
	owner, key, ok := h.studioOwner(c, false)
	if !ok {
		return
	}
	var input struct {
		OfferID string              `json:"offer_id"`
		Spec    mediaworkbench.Spec `json:"spec"`
	}
	if err := studioDecode(c, &input); err != nil {
		studioError(c, err)
		return
	}
	subscription, _ := middleware2.GetSubscriptionFromContext(c)
	var subscriptionID *int64
	if subscription != nil && key.Group.IsSubscriptionType() {
		subscriptionID = &subscription.ID
	}
	if h.billingCacheService == nil {
		studioError(c, mediaworkbench.ErrRuntimeBinding)
		return
	}
	if err := h.billingCacheService.CheckBillingEligibility(c.Request.Context(), key.User, key, key.Group, subscription, service.QuotaPlatform(c.Request.Context(), key)); err != nil {
		studioError(c, err)
		return
	}
	token, err := h.studioImage.Issue(c.Request.Context(), owner, key, input.OfferID, input.Spec, subscriptionID)
	if err != nil {
		studioError(c, err)
		return
	}
	quote, err := h.studioImage.Store.Quote(token, owner, time.Now().UTC())
	if err != nil {
		studioError(c, err)
		return
	}
	unitPrice, totalPrice, quantity, err := service.StudioImagePrices(quote)
	if err != nil {
		studioError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"contract": mediaworkbench.ImageBindingVersion, "quote_token": token, "spec": quote.Binding.Spec, "sale_price": totalPrice, "unit_price": unitPrice, "quantity": quantity, "total_price": totalPrice, "execution": quote.Execution, "expires_at": quote.ExpiresAt})
}

func (h *OpenAIGatewayHandler) StudioImageSubmit(c *gin.Context) {
	owner, key, ok := h.studioOwner(c, false)
	if !ok {
		return
	}
	if !h.studioImage.Enabled() || c.GetHeader("X-Studio-Binding-Contract") != mediaworkbench.ImageBindingVersion {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "published_image_paid_gate_off"})
		return
	}
	var input struct {
		Token      string   `json:"quote_token"`
		TaskID     string   `json:"task_id"`
		Prompt     string   `json:"prompt"`
		References []string `json:"references"`
	}
	if err := studioDecode(c, &input); err != nil {
		studioError(c, err)
		return
	}
	q, err := h.studioImage.Store.Quote(input.Token, owner, time.Now().UTC())
	if err != nil {
		studioError(c, err)
		return
	}
	plan, err := mediaworkbench.CompilePublishedImagePlan(q.Binding, input.Prompt, input.References)
	if err != nil {
		studioError(c, err)
		return
	}
	parsed, err := h.gatewayService.ParsePublishedImagePlan(plan)
	if err != nil {
		studioError(c, err)
		return
	}
	reqLog := requestLogger(c, "handler.studio_images")
	if !h.ensureResponsesDependencies(c, reqLog) {
		return
	}
	subject, _ := middleware2.GetAuthSubjectFromContext(c)
	if decision := h.checkSecurityAudit(c, reqLog, key, subject, service.ContentModerationProtocolOpenAIImages, q.Binding.Offer.SiteModel, parsed.ModerationBody()); decision != nil && !decision.AllowNextStage {
		h.openAISecurityAuditError(c, decision)
		return
	}
	imageRelease, acquired := h.acquireImageGenerationSlot(c, false)
	if !acquired {
		return
	}
	if imageRelease != nil {
		defer imageRelease()
	}
	streamStarted := false
	userRelease, acquired := h.acquireResponsesUserSlot(c, subject.UserID, subject.Concurrency, false, &streamStarted, reqLog)
	if !acquired {
		return
	}
	if userRelease != nil {
		defer userRelease()
	}
	subscription, _ := middleware2.GetSubscriptionFromContext(c)
	if key.Group.IsSubscriptionType() && (subscription == nil || q.SubscriptionID == nil || subscription.ID != *q.SubscriptionID) {
		studioError(c, mediaworkbench.ErrRuntimeBinding)
		return
	}
	if err = h.billingCacheService.CheckBillingEligibility(c.Request.Context(), key.User, key, key.Group, subscription, service.QuotaPlatform(c.Request.Context(), key)); err != nil {
		studioError(c, err)
		return
	}
	receipt, err := h.studioImage.Dispatch(c.Request.Context(), c, q, input.TaskID, input.Prompt, input.References, key)
	if err != nil {
		studioError(c, err)
		return
	}
	studioReceiptResponse(c, receipt)
}
func studioReceiptResponse(c *gin.Context, r *service.StudioImageReceipt) {
	c.JSON(http.StatusOK, gin.H{"contract": mediaworkbench.ImageBindingVersion, "task_id": r.TaskID, "status": r.Status, "billing_state": r.BillingState, "result_available": r.ResultHash != "", "expected_count": r.ExpectedCount, "delivered_count": r.DeliveredCount, "failed_count": r.FailedCount, "pending_count": r.PendingCount, "execution": r.Execution})
}
func (h *OpenAIGatewayHandler) StudioImageReceipt(c *gin.Context) {
	owner, _, ok := h.studioOwner(c, true)
	if !ok {
		return
	}
	r, err := h.studioImage.Recover(c.Request.Context(), c.Param("task_id"), owner)
	if r != nil && errors.Is(err, service.ErrStudioImageUnknown) {
		studioReceiptResponse(c, r)
		return
	}
	if err != nil {
		studioError(c, err)
		return
	}
	studioReceiptResponse(c, r)
}
func (h *OpenAIGatewayHandler) StudioImageResult(c *gin.Context) {
	owner, _, ok := h.studioOwner(c, true)
	if !ok {
		return
	}
	r, err := h.studioImage.Store.Receipt(c.Param("task_id"), owner)
	if err != nil || r.BillingState != "billed" {
		studioError(c, mediaworkbench.ErrRuntimeBinding)
		return
	}
	b, err := h.studioImage.Store.Result(r)
	if err != nil {
		studioError(c, err)
		return
	}
	c.Data(http.StatusOK, "application/json", bytes.Clone(b))
}
func (h *OpenAIGatewayHandler) StudioImageReadiness(c *gin.Context) {
	if _, _, ok := h.studioOwner(c, false); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"contract": mediaworkbench.ImageBindingVersion, "paid_enabled": h.studioImage.Enabled()})
}

func (h *OpenAIGatewayHandler) StudioImageCatalog(c *gin.Context) {
	owner, key, ok := h.studioOwner(c, false)
	if !ok {
		return
	}
	offers, err := h.studioImage.Catalog(c.Request.Context(), owner, key)
	if err != nil {
		studioError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"contract": mediaworkbench.ImageBindingVersion, "offers": offers})
}

package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/gin-gonic/gin"
)

// Inherits existing admin authentication, audit and compliance middleware.
func registerMediaWorkbenchRoutes(admin *gin.RouterGroup, h *handler.Handlers) {
	media := admin.Group("/media-workbench")
	media.GET("/suppliers", h.Admin.MediaWorkbench.Suppliers)
	media.GET("/accounts/:id", h.Admin.MediaWorkbench.Detail)
	media.POST("/accounts/:id/initialize", h.Admin.MediaWorkbench.Initialize)
	media.PUT("/accounts/:id/video-adapter", h.Admin.MediaWorkbench.BindVideoAdapter)
	media.PUT("/accounts/:id/draft", h.Admin.MediaWorkbench.SaveDraft)
	media.PUT("/accounts/:id/sales", h.Admin.MediaWorkbench.SetSales)
	media.POST("/accounts/:id/publish", h.Admin.MediaWorkbench.Publish)
}

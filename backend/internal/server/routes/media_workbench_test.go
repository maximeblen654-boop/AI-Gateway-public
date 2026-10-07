package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/gin-gonic/gin"
)

func TestMediaWorkbenchRoutesInheritAdminBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	group := r.Group("/api/v1/admin")
	group.Use(func(c *gin.Context) { c.AbortWithStatus(http.StatusUnauthorized) })
	// A nil service would panic if the auth boundary allowed execution.
	h := &handler.Handlers{Admin: &handler.AdminHandlers{MediaWorkbench: admin.NewMediaWorkbenchHandler(nil)}}
	registerMediaWorkbenchRoutes(group, h)
	for _, route := range []struct{ method, path string }{{"GET", "/suppliers"}, {"GET", "/accounts/7"}, {"POST", "/accounts/7/initialize"}, {"PUT", "/accounts/7/draft"}, {"PUT", "/accounts/7/sales"}, {"POST", "/accounts/7/publish"}, {"PUT", "/accounts/7/video-adapter"}} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(route.method, "/api/v1/admin/media-workbench"+route.path, nil))
		if w.Code != 401 {
			t.Fatalf("%s: %d", route.path, w.Code)
		}
	}
	if len(r.Routes()) != 7 {
		t.Fatal("unexpected media surface")
	}
}

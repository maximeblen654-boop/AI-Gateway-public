package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
)

type mediaReadTerminalContext struct {
	context.Context
	calls int
}

func (c *mediaReadTerminalContext) Err() error {
	c.calls++
	if c.calls >= 2 {
		return context.Canceled
	}
	return nil
}

func TestMediaReadHTTPCancellationNeverReturnsSuccessfulEmptyData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &mediaHandlerRepo{a: mediaworkbench.Account{ID: 7, Platform: "openai", Type: "apikey", Status: "active", Schedulable: true, RuntimeReady: true}}
	handler := NewMediaWorkbenchHandler(mediaworkbench.NewService(repo))
	router := gin.New()
	router.GET("/suppliers", handler.Suppliers)
	router.GET("/accounts/:id", handler.Detail)
	for _, path := range []string{"/suppliers", "/accounts/7"} {
		request := httptest.NewRequest(http.MethodGet, path, nil).WithContext(&mediaReadTerminalContext{Context: context.Background()})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code == http.StatusOK {
			t.Fatalf("canceled %s returned success: %s", path, response.Body.String())
		}
	}
}

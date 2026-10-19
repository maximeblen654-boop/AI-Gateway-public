package handler

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestVideoQuotaFailureUsesSafeCode(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		err  error
		code string
	}{
		{service.QuoteFailure("account_quota_requires_cost", errors.New("private supplier credential")), "video_account_quota_requires_cost"},
		{errors.New("private database connection"), "video_binding_unavailable"},
	} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		videoError(c, tc.err)
		require.Equal(t, 409, w.Code)
		require.Contains(t, w.Body.String(), tc.code)
		require.NotContains(t, w.Body.String(), "private")
	}
}

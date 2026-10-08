package service

import (
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestStudioImagePublishedPlanUsesCompiledIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := &OpenAIGatewayService{}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/studio/images/tasks", nil)
	c.Request.Header.Set("Content-Type", "application/json")
	for _, endpoint := range []string{imageplan.Generations, imageplan.Edits} {
		body := []byte(`{"model":"phase5-native-image-v1","prompt":"synthetic","n":1,"size":"1024x1024"}`)
		if endpoint == imageplan.Edits {
			body = []byte(`{"model":"phase5-native-image-v1","prompt":"synthetic","n":1,"size":"1024x1024","images":[{"image_url":"data:image/png;base64,c3ludGhldGlj"}]}`)
		}
		plan, err := imageplan.CompileJSON(body, "phase5-native-image-v1", endpoint)
		require.NoError(t, err)
		// The old Studio handler called this native parser and failed at its URL.
		_, err = svc.ParseOpenAIImagesRequest(c, plan.MaterializeJSON())
		require.ErrorContains(t, err, "unsupported images endpoint")
		parsed, err := svc.ParsePublishedImagePlan(plan)
		require.NoError(t, err)
		require.Equal(t, endpoint, parsed.Endpoint)
		require.Equal(t, "phase5-native-image-v1", parsed.Model)
		if endpoint == imageplan.Edits {
			require.Len(t, parsed.InputImageURLs, 1)
			require.Contains(t, string(parsed.ModerationBody()), "data:image/png;")
		} else {
			require.Empty(t, parsed.InputImageURLs)
		}
		require.Equal(t, "/v1/studio/images/tasks", c.Request.URL.Path)
		native := c.Request.Clone(c.Request.Context())
		native.URL.Path = endpoint
		c.Request = native
		_, err = svc.ParseOpenAIImagesRequest(c, plan.MaterializeJSON())
		require.Error(t, err, "native family validation remains in force")
		c.Request.URL.Path = "/v1/studio/images/tasks"
		plan.Path = "/v1/unsafe"
		_, err = svc.ParsePublishedImagePlan(plan)
		require.Error(t, err)
	}
	_, err := svc.ParsePublishedImagePlan(imageplan.Plan{Method: "POST", Path: imageplan.Generations, Encoding: "application/json"})
	require.Error(t, err, "a deserialized browser object cannot fabricate compiled bytes")
}

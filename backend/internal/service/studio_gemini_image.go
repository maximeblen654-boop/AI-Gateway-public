package service

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

// Only the Studio parameter envelope changes here. ForwardNative owns the
// Account authentication, model endpoint, native response and usage parsing.
func (r *StudioImageRuntime) forwardGeminiImage(c *gin.Context, capture *studioNativeResponse, a *Account, parsed *OpenAIImagesRequest, body []byte) ([]byte, string, error) {
	if r.Gemini == nil || parsed.N != 1 || parsed.Quality != "" {
		return nil, "", ErrStudioImageConflict
	}
	parts := []map[string]any{{"text": parsed.Prompt}}
	reader := NewImageResultUploader(nil, "", 16<<20, &http.Client{Transport: studioImageDownloadTransport{r.Core, a}, Timeout: 60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
	for _, source := range parsed.InputImageURLs {
		encoded, _ := json.Marshal(source)
		data, mime, err := reader.fetchImageBytes(c.Request.Context(), map[string]json.RawMessage{"url": encoded})
		if err != nil {
			return nil, "", err
		}
		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": mime, "data": base64.StdEncoding.EncodeToString(data)}})
	}
	config := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
	imageConfig := map[string]string{}
	if size := gjson.GetBytes(body, "image_size").String(); size != "" {
		imageConfig["imageSize"] = size
	}
	if ratio := gjson.GetBytes(body, "aspect_ratio").String(); ratio != "" {
		imageConfig["aspectRatio"] = ratio
	}
	if len(imageConfig) > 0 {
		config["imageConfig"] = imageConfig
	}
	nativeBody, err := json.Marshal(map[string]any{"contents": []any{map[string]any{"role": "user", "parts": parts}}, "generationConfig": config})
	if err != nil {
		return nil, "", err
	}
	result, err := r.Gemini.ForwardNative(c.Request.Context(), c, a, parsed.Model, "generateContent", false, nativeBody)
	var common *OpenAIForwardResult
	if result != nil {
		common = &OpenAIForwardResult{RequestID: result.RequestID}
	}
	response, id, err := studioNativeResult(capture, common, err)
	if err != nil {
		return nil, id, err
	}
	items := []map[string]string{}
	gjson.GetBytes(response, "candidates").ForEach(func(_, candidate gjson.Result) bool {
		candidate.Get("content.parts").ForEach(func(_, part gjson.Result) bool {
			if !geminiPartIsInlineImage(part) {
				return true
			}
			inline := part.Get("inlineData")
			if !inline.Exists() {
				inline = part.Get("inline_data")
			}
			mime := firstNonEmptyString(inline.Get("mimeType").String(), inline.Get("mime_type").String())
			items = append(items, map[string]string{"b64_json": inline.Get("data").String(), "mime_type": mime})
			return true
		})
		return true
	})
	if len(items) != countGeminiInlineImageOutputs(response) {
		return nil, id, ErrStudioImageUnknown
	}
	out, err := json.Marshal(map[string]any{"data": items})
	return out, id, err
}

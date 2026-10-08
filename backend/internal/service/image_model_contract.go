package service

// IsDurableImageModel identifies the reviewed NEW pool, not account entitlement.
func IsDurableImageModel(model string) bool {
	switch model {
	case "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "seedream-v5-pro", "nano-banana-2", "nano-banana-pro", "midjourney":
		return true
	default:
		return false
	}
}
func IsStudioReceiptModel(model string) bool {
	return model == "gpt-image-2.5" || IsDurableImageModel(model) || isImage2ProModel(model)
}

func imageReceiptExpectedCount(r *imageReceiptRecord) int {
	// Old journals omitted this field and retain their original single-image meaning.
	switch r.ExpectedCount {
	case 0, 1:
		return 1
	case 4:
		return 4
	default:
		return 0
	}
}
func imageReceiptEndpoint(r *imageReceiptRecord) string {
	if r.CreatePath == "/v1/images/edits/async" || r.CreatePath == "/v1/images/edits" {
		return openAIImagesEditsEndpoint
	}
	return openAIImagesGenerationsEndpoint
}
func imageReceiptAsyncPath(endpoint string) string { return endpoint + "/async" }

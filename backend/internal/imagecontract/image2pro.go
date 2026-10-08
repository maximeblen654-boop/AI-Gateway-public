package imagecontract

import (
	"net/url"
	"strings"
)

// Server-only routing contract, reviewed against the public API on 2026-10-03.
// An entry grants neither account entitlement nor a customer selling price.
type Image2ProModel struct {
	ID, UpstreamID         string
	References, MemberOnly bool
}

var Image2ProModels = []Image2ProModel{
	{"canvas-image-01", "无限制-Seedream-5-Pro", true, false},
	{"canvas-image-02", "国内Seedream-5-Pro", true, false},
	{"canvas-image-03", "无限制-NovelAI-V5", false, false},
	{"canvas-image-04", "完全无限制-Z-Image", true, true},
	{"canvas-image-05", "无限制-Flash-MAX", true, true},
	{"canvas-image-06", "Grok-image-2.0", true, false},
	{"canvas-image-07", "免费GPT-image-2.5", true, false},
	{"canvas-image-08", "GPT-Image-2.5-1K", true, false},
	{"canvas-image-09", "GPT-Image-2.5-4K", true, false},
	{"canvas-image-10", "GPT-Image-2.5-flare-1K", true, false},
	{"canvas-image-11", "GPT-Image-2.5-flare-4K", true, false},
	{"canvas-image-12", "GPT-Image-2-1K", true, false},
	{"canvas-image-13", "GPT-Image-2-4K", true, false},
	{"canvas-image-14", "Banana-2-Pro", true, false},
}

func LookupImage2ProModel(id string) (Image2ProModel, bool) {
	for _, model := range Image2ProModels {
		if id == model.ID {
			return model, true
		}
	}
	return Image2ProModel{}, false
}

func IsImage2ProBase(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "api.image2pro.top") &&
		(u.Port() == "" || u.Port() == "443") && u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		(u.Path == "" || u.Path == "/" || u.Path == "/v1" || u.Path == "/v1/")
}

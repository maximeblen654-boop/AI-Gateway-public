package service

import (
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/pkg/geminicli"
)

// Studio freezes the same endpoint selected by the native Account adapter.
func studioMediaBaseURL(a *Account) string {
	switch a.Platform {
	case PlatformGrok:
		return a.GetGrokMediaBaseURL()
	case PlatformGemini:
		return a.GetGeminiBaseURL(geminicli.AIStudioBaseURL)
	default:
		return a.GetOpenAIBaseURL()
	}
}

func studioMediaAccountSupported(a *Account) bool {
	return a != nil && mediaworkbench.SupportsAccount(&mediaworkbench.Account{Platform: a.Platform, Type: a.Type}) &&
		(a.Platform == PlatformOpenAI || a.Platform == PlatformGrok || a.Platform == PlatformGemini)
}

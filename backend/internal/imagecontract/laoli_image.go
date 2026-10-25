package imagecontract

// IsLaoliSyncImageModel is the documented 2026-10-24 OpenAI-compatible pool.
// Midjourney is deliberately absent: its four-output batch has no documented
// n/count contract that can safely use the workbench's per-image execution.
// Catalog membership and Account/model permissions remain separate checks.
func IsLaoliSyncImageModel(model string) bool {
	switch model {
	case "gpt-image-2.5-sr-flare", "gpt-image-2.5-sr-sunburst", "gpt-image-2.5",
		"gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "seedream-v5-pro",
		"nano-banana-2", "nano-banana-pro", "KS-Qwen-2.1NEW", "KS-Z-Image":
		return true
	default:
		return false
	}
}

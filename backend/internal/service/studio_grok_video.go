package service

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/tidwall/gjson"
)

// Reuse the native Grok forwarder for create/status/original. Do not call the
// public handler: its pending-billing owner is different from Studio's hold.
func (r *StudioVideoRuntime) requestGrok(ctx context.Context, a *Account, method, path string, body []byte) ([]byte, string, error) {
	endpoint := GrokMediaEndpointVideosGenerations
	id := ""
	limit := 2 << 20
	if method == http.MethodGet {
		endpoint = GrokMediaEndpointVideoStatus
		id = strings.TrimPrefix(path, "/videos/")
		if strings.HasSuffix(id, "/content") {
			id = strings.TrimSuffix(id, "/content")
			endpoint, limit = GrokMediaEndpointVideoContent, 100_000_000
		}
		if !studioImageTaskID.MatchString(id) {
			return nil, "", ErrStudioVideoConflict
		}
	} else if method != http.MethodPost || path != "/videos/generations" {
		return nil, "", ErrStudioVideoConflict
	}
	c, capture := newStudioNativeContext(ctx, method, "/v1"+path, body, limit)
	result, err := r.Core.ForwardGrokMedia(c.Request.Context(), c, a, endpoint, id, body, "application/json")
	data, _, err := studioNativeResult(capture, result, err)
	if err != nil {
		return nil, "", ErrStudioVideoUnknown
	}
	if endpoint == GrokMediaEndpointVideoContent {
		mime := capture.Header().Get("Content-Type")
		if (mime != "video/mp4" && mime != "video/webm") || capture.Header().Get("Content-Range") != "" {
			return nil, "", ErrStudioVideoUnknown
		}
		return data, mime, nil
	}
	remote := extractGrokMediaVideoRequestID(data)
	if method == http.MethodPost {
		if remote == "" {
			return nil, "", ErrStudioVideoUnknown
		}
		id = remote
	} else if remote != "" && remote != id {
		return nil, "", ErrStudioVideoConflict
	}
	status := "unknown"
	if endpoint == GrokMediaEndpointVideosGenerations {
		status = "queued"
	} else {
		switch strings.ToLower(gjson.GetBytes(data, "status").String()) {
		case "pending", "queued":
			status = "queued"
		case "processing", "in_progress":
			status = "processing"
		case "failed", "expired":
			status = "failed"
		case "done", "completed":
			if IsGrokVideoStatusBillable(grokVideoStatusBodyForBilling(a, data)) {
				status = "completed"
			}
		}
	}
	out, err := json.Marshal(map[string]string{"id": id, "status": status})
	return out, "application/json", err
}

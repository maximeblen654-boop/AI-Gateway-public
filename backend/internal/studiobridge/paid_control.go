package studiobridge

import (
	"context"
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"io"
	"net/http"
	"net/url"
	"time"
)

func (b *ImageBridge) paidEnabled(ctx context.Context) bool {
	if !b.managed {
		return b.enabled
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	media := "image"
	if b.video {
		media = "video"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base.ResolveReference(&url.URL{Path: "/api/v1/internal/studio/paid-control/" + media}).String(), nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Studio-Service-Token", b.opts.ServiceToken)
	response, err := b.client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var state struct {
		Mode    string `json:"mode"`
		Enabled bool   `json:"paid_enabled"`
	}
	return response.StatusCode == 200 && json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&state) == nil && state.Mode == service.StudioPaidControlVersion && state.Enabled
}

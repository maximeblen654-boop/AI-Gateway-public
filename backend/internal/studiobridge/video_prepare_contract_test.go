package studiobridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type prepareBridgeKeys struct{}

func (prepareBridgeKeys) Resolve(context.Context, int64, int64, int64) (ImageCredential, error) {
	return ImageCredential{ID: 42, Key: "customer-key"}, nil
}
func (prepareBridgeKeys) ResolveReceipt(context.Context, int64, int64, int64) (ImageCredential, error) {
	return ImageCredential{ID: 42, Key: "customer-key"}, nil
}

func TestVideoPrepareKeepsBridgeEnvelopeAndCorePayloadContract(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/studio/videos/prepare", r.URL.Path)
		require.Equal(t, "account_video_v1", r.Header.Get("X-Studio-Binding-Contract"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"contract":"account_video_reference_prepare_v1","preparation_id":"prep-1","receipts":[{"asset_ref":"asset-1","kind":"image","mime_type":"image/png","size":8,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":"https://supplier.invalid/r/1","upload_id":"u-1"}]}`))
	}))
	defer core.Close()
	b, err := NewVideo(ImageOptions{VideoSubmissionEnabled: false, ServiceToken: strings.Repeat("s", 32), GroupID: 3, CoreURL: core.URL, Verify: func(context.Context, string) (int64, error) { return 1, nil }, Keys: prepareBridgeKeys{}, Client: core.Client()})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, VideoPath+"prepare", strings.NewReader(`{"key_ref":42,"payload":{"offer_id":"offer-1"}}`))
	req.Header.Set("X-Studio-Service-Token", strings.Repeat("s", 32))
	req.Header.Set("X-Studio-Binding-Contract", "account_video_v1")
	req.Header.Set("X-Studio-Session-Proof", "proof")
	rec := httptest.NewRecorder()
	b.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var envelope struct {
		Data struct {
			Contract string          `json:"contract"`
			Payload  json.RawMessage `json:"payload"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	require.Equal(t, "account_video_v1", envelope.Data.Contract)
	var payload struct {
		Contract      string `json:"contract"`
		PreparationID string `json:"preparation_id"`
	}
	require.NoError(t, json.Unmarshal(envelope.Data.Payload, &payload))
	require.Equal(t, "account_video_reference_prepare_v1", payload.Contract)
	require.Equal(t, "prep-1", payload.PreparationID)
}

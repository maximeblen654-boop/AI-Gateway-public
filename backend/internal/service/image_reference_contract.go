package service

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// Site protection is intentionally below the upstream reference limits.
func validateReceiptReferences(parsed *OpenAIImagesRequest) error {
	if parsed.Model == "gpt-image-2.5" {
		if parsed.HasMask {
			return errors.New("legacy mask contract unknown")
		}
		return nil
	}
	if parsed.Endpoint != openAIImagesEditsEndpoint {
		return nil
	}
	if parsed.HasMask || len(parsed.InputImageURLs) < 1 || len(parsed.InputImageURLs) > 4 {
		return errors.New("unsupported image references")
	}
	total := 0
	for _, ref := range parsed.InputImageURLs {
		prefix, b64, ok := strings.Cut(ref, ";base64,")
		if !ok || (prefix != "data:image/png" && prefix != "data:image/jpeg" && prefix != "data:image/webp") || len(b64) > ((4<<20)+2)/3*4 {
			return errors.New("invalid image reference")
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(raw) == 0 || len(raw) > 4<<20 || base64.StdEncoding.EncodeToString(raw) != b64 {
			return errors.New("invalid reference encoding")
		}
		total += len(raw)
		if total > 8<<20 {
			return errors.New("reference total exceeds site limit")
		}
		envelope, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": b64, "mime_type": strings.TrimPrefix(prefix, "data:")}}})
		if err := validateReceiptImageResult(envelope); err != nil {
			return errors.New("invalid reference image content")
		}
	}
	return nil
}

// ValidateStudioReferenceImage validates bounded original bytes without rewriting.
func ValidateStudioReferenceImage(raw []byte, mime string) error {
	if len(raw) == 0 || len(raw) > 4<<20 {
		return errors.New("reference too large")
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	envelope, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": b64, "mime_type": mime}}})
	return validateReceiptImageResult(envelope)
}

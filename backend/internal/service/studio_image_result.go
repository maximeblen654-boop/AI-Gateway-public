package service

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	_ "golang.org/x/image/webp"
	"hash/crc32"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
)

func validateStudioImageReceiptResult(r *StudioImageReceipt, body []byte) ([][]byte, error) {
	// Dispatch validates the frozen wire request before the sole POST. Recovery
	// keeps its identity and quoted count, without reinterpreting old mappings or
	// comparing delivered pixels with a requested size.
	count := r.Quote.Binding.Spec.Count
	if r.Version == StudioImageMultiReceiptVersion && r.DeliveredCount > 0 {
		count = r.DeliveredCount
	}
	return ValidateStudioImageResult(body, count)
}

// Bound V1 accepts complete inline image containers. An upstream URL or task ID
// alone is never a completed/persisted result and never authorizes settlement.
func ValidateStudioImageResult(body []byte, count int) ([][]byte, error) {
	var response struct {
		Data []struct {
			B64    string `json:"b64_json"`
			MIME   string `json:"mime_type"`
			Format string `json:"output_format"`
		} `json:"data"`
	}
	if len(body) > 32<<20 || json.Unmarshal(body, &response) != nil || len(response.Data) != count || count < 1 {
		return nil, errors.New("image result count/container mismatch")
	}
	result := make([][]byte, count)
	for i, item := range response.Data {
		b, err := base64.StdEncoding.Strict().DecodeString(item.B64)
		if err != nil || len(b) == 0 || len(b) > 16<<20 || base64.StdEncoding.EncodeToString(b) != item.B64 {
			return nil, errors.New("invalid image bytes")
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 32768 || cfg.Height > 32768 || int64(cfg.Width)*int64(cfg.Height) > (128<<20)/4 {
			return nil, errors.New("invalid image dimensions")
		}
		if format != "png" && format != "jpeg" && format != "webp" {
			return nil, errors.New("unsupported image format")
		}
		if item.MIME != "" && item.MIME != "image/"+format || item.Format != "" && item.Format != format {
			return nil, errors.New("image format metadata mismatch")
		}
		if err = validateStudioImageContainer(b, format); err != nil {
			return nil, err
		}
		if _, _, err = image.Decode(bytes.NewReader(b)); err != nil {
			return nil, errors.New("corrupt image container")
		}
		result[i] = b
	}
	return result, nil
}

// Strict container boundaries supplement decoders that tolerate trailing data.
func validateStudioImageContainer(b []byte, format string) error {
	fail := errors.New("corrupt image container boundary")
	switch format {
	case "png":
		offset := 8
		var packed []byte
		ended := false
		for offset < len(b) {
			if offset+12 > len(b) {
				return fail
			}
			size := int(binary.BigEndian.Uint32(b[offset : offset+4]))
			if size > len(b)-offset-12 {
				return fail
			}
			chunk := b[offset+4 : offset+8+size]
			if crc32.ChecksumIEEE(chunk) != binary.BigEndian.Uint32(b[offset+8+size:offset+12+size]) {
				return fail
			}
			name := string(chunk[:4])
			if name == "IDAT" {
				packed = append(packed, chunk[4:]...)
			}
			if name == "acTL" || name == "fcTL" || name == "fdAT" {
				return fail
			}
			offset += 12 + size
			if name == "IEND" {
				if size != 0 || offset != len(b) {
					return fail
				}
				ended = true
			}
		}
		if !ended || len(packed) == 0 {
			return fail
		}
		source := bytes.NewReader(packed)
		decoder, err := zlib.NewReader(source)
		if err != nil {
			return fail
		}
		// Bound decompression independent of dimensions to stop malformed bombs.
		n, err := io.Copy(io.Discard, io.LimitReader(decoder, (256<<20)+1))
		closeErr := decoder.Close()
		if err != nil || closeErr != nil || n > 256<<20 || source.Len() != 0 {
			return fail
		}
	case "jpeg":
		offset, scans := 2, 0
		for offset < len(b) {
			if b[offset] != 0xff {
				return fail
			}
			offset++
			for offset < len(b) && b[offset] == 0xff {
				offset++
			}
			if offset >= len(b) {
				return fail
			}
			marker := b[offset]
			offset++
			if marker == 0xd9 {
				if scans < 1 || offset != len(b) {
					return fail
				}
				return nil
			}
			if marker == 0 || marker == 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset+2 > len(b) {
				return fail
			}
			size := int(binary.BigEndian.Uint16(b[offset : offset+2]))
			if size < 2 || offset+size > len(b) {
				return fail
			}
			offset += size
			if marker == 0xda {
				scans++
				for offset < len(b) {
					if b[offset] != 0xff {
						offset++
						continue
					}
					next := offset + 1
					for next < len(b) && b[next] == 0xff {
						next++
					}
					if next >= len(b) {
						return fail
					}
					if b[next] == 0 || b[next] >= 0xd0 && b[next] <= 0xd7 {
						offset = next + 1
						continue
					}
					break
				}
			}
		}
		return fail
	case "webp":
		if len(b) < 12 || int64(binary.LittleEndian.Uint32(b[4:8]))+8 != int64(len(b)) {
			return fail
		}
		for offset := 12; offset < len(b); {
			if offset+8 > len(b) {
				return fail
			}
			name := string(b[offset : offset+4])
			size := int(binary.LittleEndian.Uint32(b[offset+4 : offset+8]))
			if size > len(b)-offset-8 || name == "ANIM" || name == "ANMF" {
				return fail
			}
			offset += 8 + size + (size & 1)
			if offset > len(b) {
				return fail
			}
		}
	}
	return nil
}

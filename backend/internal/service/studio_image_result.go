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

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

var ErrStudioImageSpecMismatch = errors.New("image_result_spec_mismatch: decoded pixels or count differ from the frozen request")

func validateStudioImageReceiptResult(r *StudioImageReceipt, body []byte) ([][]byte, error) {
	size, w, h, err := mediaworkbench.ImageDimensions(r.Quote.Binding.Offer.ResolvedConfig, r.Quote.Binding.Spec)
	if err != nil {
		return nil, err
	}
	var sent struct {
		Size string `json:"size"`
		N    int    `json:"n"`
	}
	if json.Unmarshal(r.Request, &sent) != nil || sent.Size != size || sent.N != r.Quote.Binding.Spec.Count {
		return nil, ErrStudioImageSpecMismatch
	}
	return validateStudioImageResult(body, sent.N, w, h)
}

// Bound V1 accepts complete inline image containers. An upstream URL or task ID
// alone is never a completed/persisted result and never authorizes settlement.
func ValidateStudioImageResult(body []byte, count int) ([][]byte, error) {
	return validateStudioImageResult(body, count, 0, 0)
}

func validateStudioImageResult(body []byte, count, width, height int) ([][]byte, error) {
	var response struct {
		Data []struct {
			B64    string `json:"b64_json"`
			MIME   string `json:"mime_type"`
			Format string `json:"output_format"`
		} `json:"data"`
	}
	if len(body) > 32<<20 || json.Unmarshal(body, &response) != nil || len(response.Data) != count || count < 1 {
		return nil, ErrStudioImageSpecMismatch
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
		if width > 0 && (cfg.Width != width || cfg.Height != height) {
			return nil, ErrStudioImageSpecMismatch
		}
		if format != "png" && format != "jpeg" && format != "webp" {
			return nil, errors.New("unsupported image format")
		}
		if item.MIME != "" && item.MIME != "image/"+format || item.Format != "" && item.Format != format {
			return nil, errors.New("image format metadata mismatch")
		}
		if err = validateStudioImageContainer(b, format, width > 0); err != nil {
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
func validateStudioImageContainer(b []byte, format string, fixedDimensions bool) error {
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
			if fixedDimensions && name == "eXIf" {
				if err := unrotatedImageExif(chunk[4:]); err != nil {
					return err
				}
			}
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
			if fixedDimensions && marker == 0xe1 && bytes.HasPrefix(b[offset+2:offset+size], []byte("Exif\x00\x00")) {
				if err := unrotatedImageExif(b[offset+8 : offset+size]); err != nil {
					return err
				}
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
			if fixedDimensions && name == "EXIF" {
				if err := unrotatedImageExif(bytes.TrimPrefix(b[offset+8:offset+8+size], []byte("Exif\x00\x00"))); err != nil {
					return err
				}
			}
			offset += 8 + size + (size & 1)
			if offset > len(b) {
				return fail
			}
		}
	}
	return nil
}

// Browsers can rotate original JPEG/PNG/WebP bytes using IFD0 orientation even
// when a pixel decoder reports the unrotated grid. Do not silently deliver that
// different display geometry or rewrite originals. Bounds remain file-local.
func unrotatedImageExif(data []byte) error {
	if len(data) < 8 {
		return ErrStudioImageSpecMismatch
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return ErrStudioImageSpecMismatch
	}
	if order.Uint16(data[2:4]) != 42 {
		return ErrStudioImageSpecMismatch
	}
	offset := uint64(order.Uint32(data[4:8]))
	if offset < 8 || offset+2 > uint64(len(data)) {
		return ErrStudioImageSpecMismatch
	}
	count := uint64(order.Uint16(data[offset : offset+2]))
	if offset+2+count*12+4 > uint64(len(data)) {
		return ErrStudioImageSpecMismatch
	}
	for i := uint64(0); i < count; i++ {
		entry := data[offset+2+i*12 : offset+2+(i+1)*12]
		if order.Uint16(entry[:2]) == 0x0112 && (order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 || order.Uint16(entry[8:10]) != 1) {
			return ErrStudioImageSpecMismatch
		}
	}
	return nil
}

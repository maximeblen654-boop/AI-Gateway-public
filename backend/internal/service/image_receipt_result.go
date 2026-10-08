package service

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"strings"

	"golang.org/x/image/riff"
	"golang.org/x/image/vp8"
	"golang.org/x/image/vp8l"
	_ "golang.org/x/image/webp"
)

// Validate without rewriting either the envelope or the supplier's image bytes.
// The same validation protects fresh results and historical durable cache reads.
func validateReceiptImageResult(data []byte) error { return validateReceiptImageResultCount(data, 1) }

func validateReceiptImageResultCount(data []byte, expected int) error {
	if expected != 1 && expected != 4 {
		return errors.New("unsupported receipt image count")
	}
	if len(data) > int(imageReceiptResultReserve) {
		return errors.New("image result exceeds receipt size limit")
	}
	var body struct {
		Error json.RawMessage `json:"error"`
		Data  []struct {
			B64          string  `json:"b64_json"`
			MIME         *string `json:"mime_type"`
			OutputFormat *string `json:"output_format"`
			Width        *int    `json:"width"`
			Height       *int    `json:"height"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &body) != nil || len(body.Data) != expected || (len(body.Error) > 0 && string(body.Error) != "null") {
		return errors.New("invalid image result")
	}
	for _, item := range body.Data {
		if len(item.B64) > ((20<<20)+2)/3*4 {
			return errors.New("image exceeds receipt size limit")
		}
		raw, err := base64.StdEncoding.DecodeString(item.B64)
		if err != nil || len(raw) == 0 || len(raw) > 20<<20 {
			return errors.New("invalid image bytes")
		}
		if base64.StdEncoding.EncodeToString(raw) != item.B64 {
			return errors.New("noncanonical image base64")
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
		if err != nil || !validReceiptImageDimensions(cfg.Width, cfg.Height) {
			return errors.New("invalid image dimensions")
		}
		mime := ""
		switch format {
		case "png", "jpeg", "webp":
			mime = "image/" + format
		default:
			return errors.New("unsupported image format")
		}
		if item.MIME != nil && strings.ToLower(strings.TrimSpace(*item.MIME)) != mime {
			return errors.New("image MIME does not match content")
		}
		if item.OutputFormat != nil {
			declared := strings.ToLower(strings.TrimSpace(*item.OutputFormat))
			if declared == "jpg" {
				declared = "jpeg"
			}
			if declared != format {
				return errors.New("image output format does not match content")
			}
		}
		if (item.Width != nil && *item.Width != cfg.Width) || (item.Height != nil && *item.Height != cfg.Height) {
			return errors.New("image dimensions do not match content")
		}
		switch format {
		case "png":
			err = validateReceiptPNGContainer(raw)
		case "jpeg":
			err = validateReceiptJPEGContainer(raw)
		case "webp":
			err = validateReceiptWebPContainer(raw, cfg)
		}
		if err != nil {
			return err
		}
		decoded, decodedFormat, err := image.Decode(bytes.NewReader(raw))
		if err != nil || decodedFormat != format || decoded.Bounds().Dx() != cfg.Width || decoded.Bounds().Dy() != cfg.Height {
			return errors.New("invalid image content")
		}
	}
	return nil
}

// Decoders can legally stop at the first terminator. Storage must reject bytes
// after that terminator, including a second marker masquerading as the end.
func validateReceiptPNGContainer(raw []byte) error {
	seenIDAT, endedIDAT := false, false
	var compressed []byte
	for offset := 8; offset < len(raw); {
		if len(raw)-offset < 12 {
			return errors.New("truncated PNG chunk")
		}
		length := int(binary.BigEndian.Uint32(raw[offset : offset+4]))
		if length < 0 || length > len(raw)-offset-12 {
			return errors.New("invalid PNG chunk length")
		}
		name := raw[offset+4 : offset+8]
		if offset == 8 && string(name) != "IHDR" {
			return errors.New("PNG header must be first")
		}
		for _, letter := range name {
			if (letter < 'A' || letter > 'Z') && (letter < 'a' || letter > 'z') {
				return errors.New("invalid PNG chunk name")
			}
		}
		if name[2]&32 != 0 {
			return errors.New("invalid PNG reserved bit")
		}
		switch string(name) {
		case "IHDR", "PLTE":
			// The standard decoder checks header/palette content and ordering.
		case "IDAT":
			if endedIDAT {
				return errors.New("noncontiguous PNG image data")
			}
			seenIDAT = true
			compressed = append(compressed, raw[offset+8:offset+8+length]...)
		case "IEND":
			if length != 0 || !seenIDAT || offset+12 != len(raw) {
				return errors.New("invalid PNG terminator")
			}
			// The standard PNG decoder tolerates extra IDAT bytes/chunks after
			// the first zlib stream. Require one fully consumed bounded stream.
			input := bytes.NewReader(compressed)
			stream, err := zlib.NewReader(input)
			if err != nil {
				return errors.New("invalid PNG compression")
			}
			const limit = 128 << 20
			n, readErr := io.Copy(io.Discard, io.LimitReader(stream, limit+1))
			closeErr := stream.Close()
			if readErr != nil || closeErr != nil || n > limit || input.Len() != 0 {
				return errors.New("invalid PNG compressed stream")
			}
			return nil
		case "acTL", "fcTL", "fdAT":
			return errors.New("animated PNG is unsupported")
		default:
			if name[0]&32 == 0 {
				return errors.New("unknown critical PNG chunk")
			}
		}
		if seenIDAT && string(name) != "IDAT" {
			endedIDAT = true
		}
		offset += length + 12
	}
	return errors.New("missing PNG terminator")
}

func validateReceiptJPEGContainer(raw []byte) error {
	offset, scans := 2, 0
	for offset < len(raw) {
		if raw[offset] != 0xff {
			return errors.New("invalid JPEG marker")
		}
		for offset < len(raw) && raw[offset] == 0xff {
			offset++
		}
		if offset == len(raw) {
			return errors.New("truncated JPEG marker")
		}
		marker := raw[offset]
		offset++
		if marker == 0xd9 {
			if scans == 0 || offset != len(raw) {
				return errors.New("invalid JPEG terminator")
			}
			return nil
		}
		if marker == 0 || marker == 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || len(raw)-offset < 2 {
			return errors.New("invalid JPEG segment")
		}
		length := int(binary.BigEndian.Uint16(raw[offset : offset+2]))
		if length < 2 || length > len(raw)-offset {
			return errors.New("truncated JPEG segment")
		}
		offset += length
		if marker == 0xda {
			scans++
			for offset < len(raw) {
				if raw[offset] != 0xff {
					offset++
					continue
				}
				next := offset + 1
				for next < len(raw) && raw[next] == 0xff {
					next++
				}
				if next < len(raw) && (raw[next] == 0 || (raw[next] >= 0xd0 && raw[next] <= 0xd7)) {
					offset = next + 1
					continue
				}
				break
			}
		}
	}
	return errors.New("missing JPEG terminator")
}

func validReceiptImageDimensions(width, height int) bool {
	// Preserve the existing pixel ceiling, including headroom for RGBA16 PNG.
	return width > 0 && height > 0 && width <= 32768 && height <= 32768 && int64(width)*int64(height) <= 16_000_000
}

// x/image/webp's DecodeConfig returns VP8X canvas dimensions, while Decode can
// allocate from a different inner frame header and stop before trailing chunks.
// Check the complete RIFF and inner configuration before any pixel allocation.
func validateReceiptWebPContainer(raw []byte, canvas image.Config) error {
	if len(raw) < 12 || uint64(binary.LittleEndian.Uint32(raw[4:8]))+8 != uint64(len(raw)) {
		return errors.New("invalid WebP container length")
	}
	_, chunks, err := riff.NewReader(bytes.NewReader(raw))
	if err != nil {
		return errors.New("invalid WebP container")
	}
	frames, count := 0, 0
	for {
		id, size, chunk, err := chunks.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("invalid WebP chunk")
		}
		var width, height int
		switch string(id[:]) {
		case "VP8X":
			if count != 0 || size != 10 {
				return errors.New("invalid WebP extended header")
			}
			var flags [1]byte
			if _, err := io.ReadFull(chunk, flags[:]); err != nil || flags[0]&2 != 0 {
				return errors.New("animated or invalid WebP is unsupported")
			}
		case "ANIM", "ANMF":
			return errors.New("animated WebP is unsupported")
		case "VP8 ":
			decoder := vp8.NewDecoder()
			decoder.Init(chunk, int(size))
			header, err := decoder.DecodeFrameHeader()
			if err != nil {
				return errors.New("invalid WebP frame header")
			}
			width, height = header.Width, header.Height
		case "VP8L":
			cfg, err := vp8l.DecodeConfig(chunk)
			if err != nil {
				return errors.New("invalid WebP frame header")
			}
			width, height = cfg.Width, cfg.Height
		}
		if width != 0 || height != 0 {
			frames++
			if frames > 1 || !validReceiptImageDimensions(width, height) || width != canvas.Width || height != canvas.Height {
				return errors.New("invalid WebP frame dimensions")
			}
		}
		if _, err := io.Copy(io.Discard, chunk); err != nil {
			return errors.New("truncated WebP chunk")
		}
		count++
	}
	if frames != 1 {
		return errors.New("invalid WebP frame count")
	}
	return nil
}

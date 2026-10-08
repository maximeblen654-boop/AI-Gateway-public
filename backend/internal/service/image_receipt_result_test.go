//go:build unit

package service

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func receiptNativeFixtures(t *testing.T) map[string][]byte {
	t.Helper()
	var pngBytes, jpegBytes bytes.Buffer
	im := image.NewRGBA(image.Rect(0, 0, 1, 1))
	require.NoError(t, png.Encode(&pngBytes, im))
	require.NoError(t, jpeg.Encode(&jpegBytes, im, nil))
	webpLossy, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	require.NoError(t, err)
	webpLossless, err := base64.StdEncoding.DecodeString("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
	require.NoError(t, err)
	// Valid extended WebP with a 1x1 alpha plane. No image transcoding occurs.
	webpAlpha := receiptWebPWithChunks(webpLossy, receiptRIFFChunk("VP8X", []byte{16, 0, 0, 0, 0, 0, 0, 0, 0, 0}), receiptRIFFChunk("ALPH", []byte{0, 255}))
	return map[string][]byte{"png": pngBytes.Bytes(), "jpeg": jpegBytes.Bytes(), "webp_lossy": webpLossy, "webp_lossless": webpLossless, "webp_alpha": webpAlpha}
}

func receiptNativeEnvelope(t *testing.T, raw []byte, metadata map[string]any) []byte {
	t.Helper()
	item := map[string]any{"b64_json": base64.StdEncoding.EncodeToString(raw)}
	for k, v := range metadata {
		item[k] = v
	}
	data, err := json.Marshal(map[string]any{"data": []any{item}})
	require.NoError(t, err)
	return data
}

func receiptRIFFChunk(id string, body []byte) []byte {
	chunk := make([]byte, 8+len(body)+(len(body)&1))
	copy(chunk, id)
	binary.LittleEndian.PutUint32(chunk[4:8], uint32(len(body)))
	copy(chunk[8:], body)
	return chunk
}

func receiptWebPWithChunks(raw []byte, before ...[]byte) []byte {
	result := append([]byte(nil), raw[:12]...)
	for _, chunk := range before {
		result = append(result, chunk...)
	}
	result = append(result, raw[12:]...)
	binary.LittleEndian.PutUint32(result[4:8], uint32(len(result)-8))
	return result
}

func TestImageReceiptNativeFormatsAndMetadata(t *testing.T) {
	for name, raw := range receiptNativeFixtures(t) {
		t.Run(name, func(t *testing.T) {
			_, format, err := image.DecodeConfig(bytes.NewReader(raw))
			require.NoError(t, err)
			// Old envelopes without metadata remain readable.
			require.NoError(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw, nil)))
			require.NoError(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw, map[string]any{"mime_type": "image/" + format, "output_format": format, "width": 1, "height": 1})))
			for field, value := range map[string]any{"mime_type": "image/gif", "output_format": "gif", "width": 2, "height": 0} {
				require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw, map[string]any{field: value})), field)
			}
			require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw[:len(raw)-2], nil)))
		})
	}
	fixtures := receiptNativeFixtures(t)
	require.NoError(t, validateReceiptImageResult(receiptNativeEnvelope(t, fixtures["jpeg"], map[string]any{"output_format": "jpg"})))
	require.NoError(t, validateReceiptImageResult(receiptNativeEnvelope(t, fixtures["jpeg"], map[string]any{"mime_type": " IMAGE/JPEG ", "output_format": " JPG "})))
	require.NoError(t, validateReceiptImageResult(receiptNativeEnvelope(t, fixtures["webp_lossless"], map[string]any{"mime_type": nil, "output_format": nil})))
	for _, value := range []any{1, true, map[string]any{}, []any{}} {
		for _, field := range []string{"mime_type", "output_format"} {
			require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, fixtures["jpeg"], map[string]any{field: value})))
		}
	}
	require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, fixtures["jpeg"], map[string]any{"mime_type": "image/png", "output_format": "png"})))
	require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, []byte("GIF89a\x01\x00\x01\x00"), nil)))
}

func receiptPNGChunk(name string, body []byte) []byte {
	chunk := make([]byte, len(body)+12)
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(body)))
	copy(chunk[4:8], name)
	copy(chunk[8:], body)
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	return chunk
}

func TestImageReceiptNativeRejectsContainerTrailingData(t *testing.T) {
	fixtures := receiptNativeFixtures(t)
	png, jpeg, webp := fixtures["png"], fixtures["jpeg"], fixtures["webp_lossless"]
	withTail := func(raw, tail []byte) []byte { return append(append([]byte(nil), raw...), tail...) }
	lateWebPHeader := withTail(webp, receiptRIFFChunk("VP8X", []byte{0}))
	binary.LittleEndian.PutUint32(lateWebPHeader[4:8], uint32(len(lateWebPHeader)-8))
	// A trailing extra compressed chunk can be ignored by Go's PNG decoder.
	pngExtraIDAT := withTail(png[:len(png)-12], receiptPNGChunk("IDAT", []byte("garbage")))
	pngExtraIDAT = append(pngExtraIDAT, png[len(png)-12:]...)
	pngAnimation := withTail(png[:33], receiptPNGChunk("acTL", []byte{0, 0, 0, 1, 0, 0, 0, 0}))
	pngAnimation = append(pngAnimation, png[33:]...)
	pngBeforeHeader := withTail(png[:8], receiptPNGChunk("tEXt", []byte("note\x00value")))
	pngBeforeHeader = append(pngBeforeHeader, png[8:]...)
	for name, raw := range map[string][]byte{
		"png_tail":                withTail(png, []byte("garbage")),
		"png_duplicate_iend":      withTail(png, png[len(png)-12:]),
		"png_extra_idat":          pngExtraIDAT,
		"animated_png":            pngAnimation,
		"png_chunk_before_header": pngBeforeHeader,
		"jpeg_tail":               withTail(jpeg, []byte("garbage")),
		"jpeg_false_eoi_tail":     withTail(jpeg, []byte{0, 0xff, 0xd9}),
		"webp_late_short_vp8x":    lateWebPHeader,
	} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw, nil)))
		})
	}
}

func TestImageReceiptNativeRejectsMalformedAndOversizedImages(t *testing.T) {
	fixtures := receiptNativeFixtures(t)
	largePNG := append([]byte(nil), fixtures["png"]...)
	binary.BigEndian.PutUint32(largePNG[16:20], 32768)
	binary.BigEndian.PutUint32(largePNG[20:24], 32768)
	binary.BigEndian.PutUint32(largePNG[29:33], crc32.ChecksumIEEE(largePNG[12:29]))
	largeJPEG := append([]byte(nil), fixtures["jpeg"]...)
	sof := bytes.Index(largeJPEG, []byte{0xff, 0xc0})
	require.GreaterOrEqual(t, sof, 0)
	binary.BigEndian.PutUint16(largeJPEG[sof+5:sof+7], 32768)
	binary.BigEndian.PutUint16(largeJPEG[sof+7:sof+9], 32768)
	largeWebP := append([]byte(nil), fixtures["webp_lossless"]...)
	binary.LittleEndian.PutUint32(largeWebP[21:25], (1<<28)-1)
	forgedCanvas := receiptWebPWithChunks(largeWebP, receiptRIFFChunk("VP8X", make([]byte, 10)))
	animated := receiptWebPWithChunks(fixtures["webp_lossless"], receiptRIFFChunk("VP8X", []byte{2, 0, 0, 0, 0, 0, 0, 0, 0, 0}))
	duplicate := receiptWebPWithChunks(fixtures["webp_lossless"], fixtures["webp_lossless"][12:])
	badLength := append([]byte(nil), fixtures["webp_lossy"]...)
	binary.LittleEndian.PutUint32(badLength[4:8], 999)
	truncatedMetadata := append(append([]byte(nil), fixtures["webp_lossy"]...), []byte("EXIF\x08\x00\x00\x00xx")...)
	binary.LittleEndian.PutUint32(truncatedMetadata[4:8], uint32(len(truncatedMetadata)-8))
	corruptPNG := append([]byte(nil), fixtures["png"]...)
	corruptPNG[len(corruptPNG)-1] ^= 0xff
	for name, raw := range map[string][]byte{"large_png": largePNG, "large_jpeg": largeJPEG, "large_webp": largeWebP, "forged_webp_canvas": forgedCanvas, "animated_webp": animated, "duplicate_webp_frames": duplicate, "webp_length": badLength, "truncated_webp_metadata": truncatedMetadata, "corrupt_png": corruptPNG} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, validateReceiptImageResult(receiptNativeEnvelope(t, raw, nil)))
		})
	}
}

func TestImageReceiptNativeRejectsNoncanonicalBase64(t *testing.T) {
	fixtures := receiptNativeFixtures(t)
	for name, raw := range fixtures {
		t.Run(name+"_line_break", func(t *testing.T) {
			encoded := base64.StdEncoding.EncodeToString(raw)
			data, err := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": encoded[:12] + "\r\n" + encoded[12:]}}})
			require.NoError(t, err)
			require.ErrorContains(t, validateReceiptImageResult(data), "noncanonical")
		})
	}
	// Go's default decoder ignores nonzero unused padding bits. BFF canonical
	// validation rejects them, so Core must reject before persisting or billing.
	encoded := base64.StdEncoding.EncodeToString(fixtures["webp_lossless"])
	require.True(t, strings.HasSuffix(encoded, "=="))
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	position := len(encoded) - 3
	index := strings.IndexByte(alphabet, encoded[position])
	changed := encoded[:position] + string(alphabet[index|1]) + encoded[position+1:]
	decoded, err := base64.StdEncoding.DecodeString(changed)
	require.NoError(t, err)
	require.Equal(t, fixtures["webp_lossless"], decoded)
	data, err := json.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": changed}}})
	require.NoError(t, err)
	require.ErrorContains(t, validateReceiptImageResult(data), "noncanonical")
}

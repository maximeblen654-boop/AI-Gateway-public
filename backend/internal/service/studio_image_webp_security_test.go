package service

import (
	"bytes"
	"compress/bzip2"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"io"
	"testing"
)

func TestStudioImageWebPSecurityRegression(t *testing.T) {
	// The compressed large-Huffman-index fixture is from golang.org/x/image
	// v0.45.0/testdata/large-huffman-index.lossless.webp.bz2 (GO-2026-6222).
	// Its upstream BSD notice is retained below. Decode must reject excessive
	// Huffman groups before allocating their unreferenced trees.
	const packedFixture = "QlpoOTFBWSZTWdD9D0AABRR+zdwAyACAAIBAVyRRgAACRAAAAMAAQAAADiAAUKAAAAACSkBoNAGmR6SbqnOnIsnOD++mypKryggARGSBAJJsPfvWaUIY/M1I0suEACPH/i7kinChIaH6HoA="
	packed, err := base64.StdEncoding.DecodeString(packedFixture)
	if err != nil {
		t.Fatal(err)
	}
	huffman, err := io.ReadAll(io.LimitReader(bzip2.NewReader(bytes.NewReader(packed)), 1<<20))
	if err != nil || len(huffman) != 163879 {
		t.Fatal("invalid regression fixture", err)
	}
	// The upstream sample omits the odd-sized VP8L chunk's RIFF padding.
	// Add it so our strict container gate admits the sample to full decoding.
	huffman = append(huffman, 0)
	binary.LittleEndian.PutUint32(huffman[4:8], binary.LittleEndian.Uint32(huffman[4:8])+1)

	// A locally encoded 1x1 VP8 image with an explicit 2x2 VP8X canvas tests
	// the mismatched dimensions that previously could panic (GO-2026-5061).
	var valid struct {
		Data []map[string]string `json:"data"`
	}
	if err = json.Unmarshal(studioResult(t, "webp"), &valid); err != nil {
		t.Fatal(err)
	}
	imageBytes, err := base64.StdEncoding.DecodeString(valid.Data[0]["b64_json"])
	if err != nil {
		t.Fatal(err)
	}
	canvas := make([]byte, 18)
	copy(canvas, "VP8X")
	binary.LittleEndian.PutUint32(canvas[4:8], 10)
	canvas[12], canvas[15] = 1, 1 // Width/height minus one.
	mismatch := append(append(append([]byte{}, imageBytes[:12]...), canvas...), imageBytes[12:]...)
	binary.LittleEndian.PutUint32(mismatch[4:8], binary.LittleEndian.Uint32(imageBytes[4:8])+18)

	for name, data := range map[string][]byte{"excessive_huffman_groups": huffman, "canvas_frame_mismatch": mismatch} {
		t.Run(name, func(t *testing.T) {
			// Both samples have valid bounded headers/container boundaries;
			// rejection must come from the full decoder, not an earlier gate.
			cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
			if err != nil || format != "webp" || cfg.Width < 1 || cfg.Height < 1 ||
				int64(cfg.Width)*int64(cfg.Height) > (128<<20)/4 || validateStudioImageContainer(data, format) != nil {
				t.Fatal("regression does not reach full WebP decoding", err)
			}
			body, err := json.Marshal(map[string]any{"data": []any{map[string]string{
				"b64_json": base64.StdEncoding.EncodeToString(data), "mime_type": "image/webp", "output_format": "webp",
			}}})
			if err != nil {
				t.Fatal(err)
			}
			if result, err := ValidateStudioImageResult(body, 1); err == nil || result != nil {
				t.Fatal("unsafe WebP admitted")
			}
		})
	}
}

// Copyright 2009 The Go Authors. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func studioPixelResult(t *testing.T, width, height int) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, width, height))))
	out, err := json.Marshal(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(b.Bytes())}}})
	require.NoError(t, err)
	return out
}

func TestStudioImageOriginalOrientationIsPreserved(t *testing.T) {
	for _, orientation := range []uint16{1, 6} {
		var original bytes.Buffer
		require.NoError(t, jpeg.Encode(&original, image.NewNRGBA(image.Rect(0, 0, 16, 9)), nil))
		// Synthetic TIFF IFD0 with one SHORT orientation entry; no real metadata.
		exif := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.LittleEndian.PutUint16(exif[18:20], orientation)
		payload := append([]byte("Exif\x00\x00"), exif...)
		segment := []byte{0xff, 0xe1, 0, 0}
		binary.BigEndian.PutUint16(segment[2:4], uint16(len(payload)+2))
		b := append(append(append(bytes.Clone(original.Bytes()[:2]), segment...), payload...), original.Bytes()[2:]...)
		body, err := json.Marshal(map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(b)}}})
		require.NoError(t, err)
		decoded, err := ValidateStudioImageResult(body, 1)
		require.NoError(t, err)
		require.Equal(t, b, decoded[0], "original EXIF and image bytes must not be rewritten")
	}
}

func TestStudioImageReceiptVersionRetainsHistoricalIdentity(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t)
	receipt, err := r.Dispatch(context.Background(), nil, q, "versioned-result", "synthetic", nil, key)
	require.NoError(t, err)
	require.Equal(t, StudioImageReceiptVersion, receipt.Version)
	// Reconstruct an old on-disk receipt; its quote/request/accounting identity
	// remains readable, and an existing charge is not repeated or rewritten.
	receipt.Version = mediaworkbench.ImageBindingVersion
	require.NoError(t, r.Store.Save(receipt))
	recovered, err := r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Equal(t, receipt.Quote.BindingHash, recovered.Quote.BindingHash)
	require.Equal(t, receipt.RequestHash, recovered.RequestHash)
	require.Equal(t, mediaworkbench.ImageBindingVersion, recovered.Version)
	require.Equal(t, 1, billing.applied)
	require.Equal(t, 1, billing.calls)
}

func TestStudioImageValidDifferentPixelsSettleOnceWithoutRewriting(t *testing.T) {
	for _, size := range [][2]int{{512, 512}, {1024, 576}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			posts := 0
			result := studioPixelResult(t, size[0], size[1])
			r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
				posts++
				var fields map[string]any
				require.NoError(t, json.Unmarshal(body, &fields))
				require.Equal(t, "1024x1024", fields["size"])
				return result, "original-receipt", nil
			}
			_, err := r.Dispatch(context.Background(), nil, q, "spec-mismatch", "synthetic", nil, key)
			require.NoError(t, err)
			// Only disk and the frozen quote survive a process restart.
			restarted := NewStudioImageRuntime(r.Core, r.Media)
			restarted.Store = NewStudioImageStore(r.Store.Root)
			restarted.enabled = true
			_, err = restarted.Dispatch(context.Background(), nil, q, "spec-mismatch", "synthetic", nil, key)
			require.NoError(t, err)
			_, err = restarted.Recover(context.Background(), "spec-mismatch", q.Owner)
			require.NoError(t, err)
			receipt, err := restarted.Store.Receipt("spec-mismatch", q.Owner)
			require.NoError(t, err)
			require.Equal(t, StudioImageReceiptVersion, receipt.Version)
			require.Equal(t, "completed", receipt.Status)
			require.Equal(t, "billed", receipt.BillingState)
			saved, err := restarted.Store.Result(receipt)
			require.NoError(t, err)
			require.Equal(t, result, saved)
			require.Equal(t, HashUsageRequestPayload(result), receipt.ResultHash)
			require.Equal(t, 1, posts)
			require.Equal(t, 1, billing.applied)
			require.Equal(t, 1, billing.calls)
			require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
		})
	}
}

func TestStudioImageHistoricalReceiptVersionsResumeValidResultOnce(t *testing.T) {
	for _, version := range []string{mediaworkbench.ImageBindingVersion, StudioImageReceiptVersion} {
		t.Run(version, func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			result, posts := studioPixelResult(t, 512, 288), 0
			r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
				posts++
				return result, "original-receipt", nil
			}
			// The upstream response survives, but no result/settlement was committed.
			r.Store.writeFile = func(path string, b []byte, exclusive bool) error {
				if path == r.Store.path("result", "historical") {
					return errors.New("injected result write interruption")
				}
				return studioWrite(path, b, exclusive)
			}
			_, err := r.Dispatch(context.Background(), nil, q, "historical", "synthetic", nil, key)
			require.Error(t, err)
			receipt, err := r.Store.Receipt("historical", q.Owner)
			require.NoError(t, err)
			receipt.Version = version // reconstruct either historical on-disk version
			require.NoError(t, r.Store.Save(receipt))
			require.Zero(t, billing.applied)
			restarted := NewStudioImageRuntime(r.Core, r.Media)
			restarted.Store = NewStudioImageStore(r.Store.Root)
			for i := 0; i < 2; i++ {
				recovered, err := restarted.Recover(context.Background(), "historical", q.Owner)
				require.NoError(t, err)
				require.Equal(t, version, recovered.Version)
				require.Equal(t, receipt.Quote.BindingHash, recovered.Quote.BindingHash)
				require.Equal(t, receipt.PayloadHash, recovered.PayloadHash)
				require.Equal(t, receipt.RequestHash, recovered.RequestHash)
				saved, err := restarted.Store.Result(recovered)
				require.NoError(t, err)
				require.Equal(t, result, saved)
			}
			require.Equal(t, 1, posts)
			require.Equal(t, 1, billing.calls)
			require.Equal(t, 1, billing.applied)
			require.Equal(t, "0.80", billing.cmd.ExactAmounts.Balance)
			_, err = restarted.Recover(context.Background(), "historical", StudioImageOwner{9, 2, 3})
			require.Error(t, err)
		})
	}
}

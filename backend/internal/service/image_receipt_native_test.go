//go:build unit

package service

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestImageReceiptNativeDurabilitySnapshotAndBillingOnce(t *testing.T) {
	for format, raw := range receiptNativeFixtures(t) {
		t.Run(format, func(t *testing.T) {
			svc, key, account, r, path, billing := asyncReceiptFixture(t)
			r.ReceiptID = "original-native-receipt"
			// An old explicit PNG request stays untouched even when the supplier
			// returns its native JPEG/WebP bytes instead of converting them.
			r.RequestBody = []byte(`{ "model":"gpt-image-2.5-flare", "prompt":"original  spaces", "output_format":"png" }`)
			r.PayloadHash = HashUsageRequestPayload(r.RequestBody)
			require.NoError(t, saveImageReceipt(path, r))
			originalRequest := append([]byte(nil), r.RequestBody...)
			originalHash, originalKey, originalCost := r.PayloadHash, r.IdempotencyKey, *r.Cost
			changedPrice := 8.0
			key.Group.ImagePrice1K = &changedPrice
			data := receiptNativeEnvelope(t, raw, nil)
			view, err := svc.completeImageReceipt(context.Background(), path, r, account, key, nil, data)
			require.NoError(t, err)
			require.Equal(t, "completed", view.Status)
			require.Equal(t, data, []byte(view.Result))
			require.Equal(t, 1, billing.calls)
			require.InDelta(t, originalCost.ActualCost, billing.lastCmd.BalanceCost, 0.000001)
			require.Equal(t, "image-receipt:44:original-native-receipt", billing.lastCmd.RequestID)
			stored, err := readImageReceipt(path)
			require.NoError(t, err)
			require.Equal(t, originalRequest, stored.RequestBody)
			require.Equal(t, originalHash, stored.PayloadHash)
			require.Equal(t, originalKey, stored.IdempotencyKey)
			require.Equal(t, r.ReceiptID, stored.ReceiptID)
			require.Equal(t, r.APIKeyID, stored.APIKeyID)
			require.Equal(t, originalCost, *stored.Cost)
			cached, err := os.ReadFile(path + ".result")
			require.NoError(t, err)
			require.Equal(t, data, cached)
			// Cache delivery after restart does not need the old supplier key.
			restarted := restartReceiptService(svc)
			account.Credentials["api_key"] = "rotated-test-key"
			view, err = restarted.GetImageReceipt(context.Background(), key, r.ClientKey, nil)
			require.NoError(t, err)
			require.Equal(t, data, []byte(view.Result))
			view, err = restarted.completeImageReceipt(context.Background(), path, r, account, key, nil, receiptPNG(t))
			require.NoError(t, err)
			require.Equal(t, data, []byte(view.Result))
			require.Equal(t, 1, billing.calls)
		})
	}
}

func TestImageReceiptNativeValidationAndStorageFailureNeverBill(t *testing.T) {
	for format, raw := range receiptNativeFixtures(t) {
		for _, failure := range []string{"storage", "corrupt", "mime_mismatch", "trailing_garbage", "base64_newline"} {
			t.Run(format+"_"+failure, func(t *testing.T) {
				svc, key, account, r, path, billing := receiptFixture(t)
				metadata := map[string]any{}
				input := raw
				switch failure {
				case "storage":
					require.NoError(t, os.Mkdir(path+".result", 0700))
				case "corrupt":
					input = raw[:len(raw)-2]
				case "mime_mismatch":
					metadata["mime_type"] = "image/gif"
				case "trailing_garbage":
					input = append(append([]byte(nil), raw...), []byte("garbage")...)
				}
				data := receiptNativeEnvelope(t, input, metadata)
				if failure == "base64_newline" {
					data = bytes.Replace(data, []byte(`"b64_json":"`), []byte(`"b64_json":"\r\n`), 1)
				}
				view, err := svc.completeImageReceipt(context.Background(), path, r, account, key, nil, data)
				require.NoError(t, err)
				require.NotEqual(t, "completed", view.Status)
				require.NotEmpty(t, view.ErrorCode)
				require.Empty(t, view.Result)
				require.Equal(t, "not_billed", view.BillingState)
				require.Zero(t, billing.calls)
				stored, err := readImageReceipt(path)
				require.NoError(t, err)
				require.Empty(t, stored.ResultHash)
				require.Equal(t, "not_billed", stored.BillingState)
			})
		}
	}
}

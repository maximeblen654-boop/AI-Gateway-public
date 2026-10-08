//go:build unit

package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func asyncReceiptFixture(t *testing.T) (*OpenAIGatewayService, *APIKey, *Account, *imageReceiptRecord, string, *openAIRecordUsageBillingRepoStub) {
	s, k, a, r, p, b := receiptFixture(t)
	r.Protocol = "durable-async-v1"
	r.CreatePath = "/v1/images/generations/async"
	r.IdempotencyKey = r.ClientKey
	r.ReceiptID = ""
	r.RequestBody = []byte(`{"model":"gpt-image-2.5-flare","prompt":"exact  spaces"}`)
	r.PayloadHash = HashUsageRequestPayload(r.RequestBody)
	k.Status = StatusActive
	require.NoError(t, saveImageReceipt(p, r))
	return s, k, a, r, p, b
}

func dispatchAsyncFixture(t *testing.T, s *OpenAIGatewayService, k *APIKey, a *Account, r *imageReceiptRecord, p string) (*ImageReceiptView, error) {
	t.Helper()
	t.Setenv("IMAGE_RECEIPT_ASYNC_ENABLED", "true")
	require.NoError(t, os.Remove(p))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)
	c.Request.Header.Set(ImageReceiptHeader, r.ClientKey)
	parsed := &OpenAIImagesRequest{Model: r.Model, N: 1, SizeTier: "1K", Endpoint: openAIImagesGenerationsEndpoint, ContentType: "application/json"}
	return s.DispatchImageReceipt(context.Background(), c, a, r.RequestBody, parsed, &OpenAIRecordUsageInput{APIKey: k, User: k.User, Account: a})
}

func TestImageReceiptAsyncFirstDispatchAndRestartNeverRepeatsPOST(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprint(lost), func(t *testing.T) {
			s, k, a, r, p, b := asyncReceiptFixture(t)
			posts, gets := 0, 0
			up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
				if req.Method == http.MethodPost {
					posts++
					require.Equal(t, "/v1/images/generations/async", req.URL.Path)
					require.Nil(t, req.GetBody)
					body, _ := io.ReadAll(req.Body)
					require.Equal(t, r.RequestBody, body)
					disk, e := readImageReceipt(p)
					require.NoError(t, e)
					require.False(t, disk.DispatchStartedAt.IsZero())
					if lost {
						return nil, errors.New("lost accepted response")
					}
					return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"request_id":"original-id","poll_url":"/v1/images/tasks/original-id"}`))}, nil
				}
				gets++
				require.Equal(t, "/v1/images/tasks/original-id", req.URL.Path)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"state":"completed","result":` + string(receiptPNG(t)) + `}`))}, nil
			}}
			s.httpUpstream = up
			_, e := dispatchAsyncFixture(t, s, k, a, r, p)
			require.NoError(t, e)
			require.Equal(t, 1, posts)
			require.Zero(t, b.calls)
			restarted := restartReceiptService(s)
			for i := 0; i < 3; i++ {
				disk, e := readImageReceipt(p)
				require.NoError(t, e)
				disk.NextPollAt = time.Time{}
				require.NoError(t, saveImageReceipt(p, disk))
				restarted.runImageReceiptWorkerPass(context.Background(), &receiptKeyLookupStub{original: k})
				v, e := restarted.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
				require.NoError(t, e)
				if lost {
					require.Equal(t, "unknown", v.Status)
					require.Equal(t, "upstream_original_result_required", v.ErrorCode)
				} else {
					require.Equal(t, "completed", v.Status)
				}
			}
			require.Equal(t, 1, posts)
			if lost {
				require.Zero(t, gets)
				require.Zero(t, b.calls)
			} else {
				require.Equal(t, 1, gets)
				require.Equal(t, 1, b.calls)
			}
			k.UserID++
			_, e = restarted.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
			require.ErrorIs(t, e, os.ErrNotExist)
		})
	}
}

func TestImageReceiptAsyncExistingIntentWithoutIDNeverSubmits(t *testing.T) {
	s, k, _, r, _, b := asyncReceiptFixture(t)
	up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		t.Fatal("ambiguous journal must not POST")
		return nil, nil
	}}
	s.httpUpstream = up
	v, e := s.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
	require.NoError(t, e)
	require.Equal(t, "unknown", v.Status)
	require.Zero(t, up.calls)
	require.Zero(t, b.calls)
}

func TestImageReceiptStorageFailureBeforeCharge(t *testing.T) {
	s, k, a, r, p, b := receiptFixture(t)
	require.NoError(t, os.Mkdir(p+".result", 0700))
	v, e := s.completeImageReceipt(context.Background(), p, r, a, k, nil, receiptPNG(t))
	require.NoError(t, e)
	require.Equal(t, "result_storage_unavailable", v.ErrorCode)
	require.Zero(t, b.calls)
}

func TestImageReceiptAsyncRejectsUntrustedPollURL(t *testing.T) {
	s, k, a, r, p, b := asyncReceiptFixture(t)
	s.httpUpstream = &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"request_id":"original-id","poll_url":"https://evil.example/v1/images/tasks/original-id"}`))}, nil
	}}
	_, e := dispatchAsyncFixture(t, s, k, a, r, p)
	require.NoError(t, e)
	r, e = readImageReceipt(p)
	require.NoError(t, e)
	require.Empty(t, r.ReceiptID)
	require.Zero(t, b.calls)
}

func TestImageReceiptAsync202ReconcilingAndLegacyNeverRePOST(t *testing.T) {
	s, k, _, r, p, b := asyncReceiptFixture(t)
	r.ReceiptID = "known"
	require.NoError(t, saveImageReceipt(p, r))
	up := &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
		require.Equal(t, http.MethodGet, req.Method)
		return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(`{"state":"reconciling","retry_after":30}`))}, nil
	}}
	s.httpUpstream = up
	v, e := s.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
	require.NoError(t, e)
	require.Equal(t, "reconciling", v.Status)
	require.Zero(t, b.calls)
	r.Protocol = ""
	r.ReceiptID = ""
	require.NoError(t, saveImageReceipt(p, r))
	s.runImageReceiptWorkerPass(context.Background(), &receiptKeyLookupStub{original: k})
	_, e = s.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
	require.NoError(t, e)
	require.Equal(t, 1, up.calls)
}

func TestImageReceiptStoreReservesBoundedCapacity(t *testing.T) {
	_, _, _, r, p, _ := asyncReceiptFixture(t)
	for i := 0; i < 15; i++ {
		r.ClientKey = "img_" + strings.Repeat("b", 30) + string("0123456789abcdef"[i]) + "0"
		path, e := imageReceiptPath(r.UserID, r.APIKeyID, r.ClientKey)
		require.NoError(t, e)
		require.NoError(t, saveImageReceipt(path, r))
	}
	require.ErrorContains(t, imageReceiptStorePreflight(), "capacity")
	require.NoError(t, os.Remove(p))
	// Journal bytes count too, so release another reservation for the next task.
	entries, _ := os.ReadDir(imageReceiptRoot())
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			require.NoError(t, os.Remove(imageReceiptRoot()+string(os.PathSeparator)+entry.Name()))
			break
		}
	}
	require.NoError(t, imageReceiptStorePreflight())
}

func TestImageReceiptAsyncFirstPOST200Completed(t *testing.T) {
	s, k, a, r, p, b := asyncReceiptFixture(t)
	count := 0
	png := receiptPNG(t)
	s.httpUpstream = &receiptUpstreamStub{run: func(req *http.Request) (*http.Response, error) {
		count++
		require.Equal(t, http.MethodPost, req.Method)
		require.Equal(t, "/v1/images/generations/async", req.URL.Path)
		require.Equal(t, r.IdempotencyKey, req.Header.Get("Idempotency-Key"))
		data, _ := io.ReadAll(req.Body)
		require.Equal(t, r.RequestBody, data)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"request_id":"original-completed","state":"completed","result":` + string(png) + `}`))}, nil
	}}
	_, e := dispatchAsyncFixture(t, s, k, a, r, p)
	require.NoError(t, e)
	require.Equal(t, 1, b.calls)
	r, e = readImageReceipt(p)
	require.NoError(t, e)
	r.NextPollAt = time.Time{}
	require.NoError(t, saveImageReceipt(p, r))
	v, e := s.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
	require.NoError(t, e)
	require.Equal(t, "completed", v.Status)
	require.Equal(t, "original-completed", v.UpstreamRequestID)
	require.Equal(t, png, []byte(v.Result))
	require.Equal(t, 1, b.calls)
	v, e = s.GetImageReceipt(context.Background(), k, r.ClientKey, nil)
	require.NoError(t, e)
	require.Equal(t, "completed", v.Status)
	require.Equal(t, 1, count)
	require.Equal(t, 1, b.calls)
	r, e = readImageReceipt(p)
	require.NoError(t, e)
	disk, e := loadImageReceiptResult(p, r)
	require.NoError(t, e)
	require.Equal(t, png, disk)
}

func TestImageReceiptReturnsPersistedBytesDespiteDifferentLaterResult(t *testing.T) {
	s, k, a, r, p, b := receiptFixture(t)
	original := receiptPNG(t)
	_, e := s.completeImageReceipt(context.Background(), p, r, a, k, nil, original)
	require.NoError(t, e)
	// Distinct, valid response JSON: the stored image/result remains authoritative.
	later := append([]byte(" \n"), original...)
	v, e := s.completeImageReceipt(context.Background(), p, r, a, k, nil, later)
	require.NoError(t, e)
	require.Equal(t, original, []byte(v.Result))
	require.Equal(t, 1, b.calls)
}

func TestImageReceiptWorkerSkipsLegacyBilledWithoutCache(t *testing.T) {
	s, k, _, r, p, _ := receiptFixture(t)
	k.Status = StatusActive
	r.BillingState = "billed"
	r.Status = "completed"
	require.NoError(t, saveImageReceipt(p, r))
	up := &receiptUpstreamStub{run: func(*http.Request) (*http.Response, error) {
		t.Fatal("legacy billed task should not be background polled")
		return nil, nil
	}}
	s.httpUpstream = up
	s.runImageReceiptWorkerPass(context.Background(), &receiptKeyLookupStub{original: k})
	require.Zero(t, up.calls)
}

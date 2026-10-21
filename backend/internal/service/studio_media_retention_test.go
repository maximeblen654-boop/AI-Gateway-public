package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Existing native-money tests emulate the trusted delivery adapter's durable put.
func testStudioVideoRetention(q StudioVideoQuote) *StudioResultRetention {
	at := time.Now().UTC()
	if at.Before(q.Binding.CreatedAt) {
		at = q.Binding.CreatedAt
	}
	expires := at.Add(48 * time.Hour)
	return &StudioResultRetention{PersistedAt: &at, ExpiresAt: &expires, Policy: StudioVideoRetentionPolicy}
}

func testStudioLegacyImageClaim(t *testing.T, s *StudioImageStore, r *StudioImageReceipt) {
	t.Helper()
	require.NoError(t, s.write(s.path("task", r.TaskID)+".sync-dispatch", []byte(r.Quote.BindingHash+"|"+r.PayloadHash), false))
}

func TestStudioImageRetentionFixedAcrossCopiesRecoveryAndRestart(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t)
	now := q.CreatedAt.Add(time.Second)
	first := now
	r.Store.clock = func() time.Time { return now }
	posts := 0
	data := studioResult(t, "png")
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		posts++
		return data, "original", nil
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-fixed", "synthetic", nil, key)
	require.NoError(t, err)
	retention, err := r.Store.ResultRetention(receipt)
	require.NoError(t, err)
	require.Equal(t, StudioImageRetentionPolicy, retention.Policy)
	require.True(t, retention.PersistedAt.Equal(first))
	require.True(t, retention.ExpiresAt.Equal(first.Add(72*time.Hour)))
	now = first.Add(24 * time.Hour)
	require.NoError(t, r.Store.persistCopy(receipt.TaskID, "materialized", receipt.TaskID, data, true, nil))
	require.NoError(t, r.Store.PersistResult(receipt, data))
	restarted := *r
	restarted.Store = NewStudioImageStore(r.Store.Root)
	restarted.Store.clock = func() time.Time { return now }
	got, err := restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.True(t, got.ResultRetention.ExpiresAt.Equal(first.Add(72*time.Hour)))
	now = first.Add(72 * time.Hour)
	_, err = restarted.Store.Result(got)
	require.ErrorIs(t, err, ErrStudioResultExpired)
	_, err = restarted.materializeResult(context.Background(), q, receipt.TaskID, []byte(`{"data":[{"url":"https://supplier.example/original.png"}]}`))
	require.ErrorIs(t, err, ErrStudioResultExpired)
	require.ErrorIs(t, restarted.Store.PersistResult(got, data), ErrStudioResultExpired)
	report := restarted.Store.CleanupExpired(64)
	require.Equal(t, 1, report.Expired)
	require.Equal(t, 3, report.Deleted)
	require.Zero(t, report.Failures)
	require.Positive(t, report.Bytes)
	for _, kind := range []string{"result", "upstream", "materialized"} {
		_, err := os.Stat(r.Store.path(kind, receipt.TaskID))
		require.True(t, os.IsNotExist(err))
	}
	_, err = os.Stat(r.Store.path("task", receipt.TaskID))
	require.NoError(t, err)
	_, err = os.Stat(r.Store.path("task", receipt.TaskID) + ".sync-dispatch")
	require.NoError(t, err)
	_, err = restarted.Dispatch(context.Background(), nil, q, receipt.TaskID, "synthetic", nil, key)
	require.NoError(t, err)
	require.Equal(t, 1, posts)
	require.Equal(t, 1, billing.applied)
}

func TestStudioImageRetentionUnitDeadlineAndUnresolvedProof(t *testing.T) {
	r, _, _, _, billing := studioContractFixture(t)
	q := enableStudioNativeMulti(t, r)
	units, _, body, err := imageExecutionUnits(q, "retention-units", "synthetic", nil)
	require.NoError(t, err)
	receipt, _, err := r.Store.Claim(StudioImageReceipt{Version: StudioImageMultiReceiptVersion, TaskID: "retention-units", Quote: q, Request: body, PayloadHash: HashUsageRequestPayload(body), RequestHash: strings.Repeat("b", 64), Endpoint: units[0].Endpoint, Execution: *q.Execution, Units: units, ExpectedCount: 5, PendingCount: 5})
	require.NoError(t, err)
	now := q.CreatedAt.Add(time.Second)
	first := now
	r.Store.clock = func() time.Time { return now }
	data := studioResultN(t, units[0].OutputCount)
	require.NoError(t, r.Store.writeUnitOutcome(units[0], "response", data, "first", receipt.TaskID))
	require.NoError(t, r.Store.persistCopy(receipt.TaskID, "materialized", units[0].ID, data, true, nil))
	now = first.Add(71 * time.Hour)
	require.NoError(t, r.Store.writeUnitOutcome(units[1], "unknown", []byte(`{"pending":true}`), "second", receipt.TaskID))
	retention, err := r.Store.ResultRetention(receipt)
	require.NoError(t, err)
	require.True(t, retention.ExpiresAt.Equal(first.Add(72*time.Hour)))
	now = first.Add(72 * time.Hour)
	paths := []string{r.Store.path("unit-response", units[0].ID), r.Store.path("unit-response", units[1].ID), r.Store.path("materialized", units[0].ID)}
	var beforeBytes int64
	for _, path := range paths {
		info, e := os.Stat(path)
		require.NoError(t, e)
		beforeBytes += info.Size()
	}
	report := r.Store.CleanupExpired(64)
	require.Zero(t, report.Failures)
	require.Equal(t, 3, report.Deleted)
	var afterBytes int64
	for _, path := range paths {
		if info, e := os.Stat(path); e == nil {
			afterBytes += info.Size()
		} else {
			require.True(t, os.IsNotExist(e))
		}
	}
	require.Equal(t, beforeBytes-afterBytes, report.Bytes, "bytes must reflect the actual JSON/base64 file shrink")
	for _, u := range units[:2] {
		var out studioImageUnitOutcome
		require.NoError(t, studioRead(r.Store.path("unit-response", u.ID), &out))
		require.Empty(t, out.Data)
		require.Equal(t, u.PayloadHash, out.PayloadHash)
	}
	var rec studioRetentionRecord
	require.NoError(t, studioRead(r.Store.path("retention", receipt.TaskID), &rec))
	require.Equal(t, 2, rec.UnitProofs[units[0].ID].ActualCount)
	require.Equal(t, HashUsageRequestPayload(data), rec.UnitProofs[units[0].ID].ResultHash)
	require.Equal(t, "unknown", rec.UnitProofs[units[1].ID].State)
	require.NotEmpty(t, rec.UnitProofs[units[1].ID].DataHash)
	got, err := r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.ErrorIs(t, err, ErrStudioResultExpired)
	require.Equal(t, "pending", got.BillingState)
	require.Zero(t, billing.applied)
	require.ErrorIs(t, r.Store.writeUnitOutcome(units[2], "response", studioResultN(t, 1), "late", receipt.TaskID), ErrStudioResultExpired)
}

func TestStudioImageRetentionCleanupFailureRetries(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	now := q.CreatedAt.Add(time.Second)
	r.Store.clock = func() time.Time { return now }
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-retry", "synthetic", nil, key)
	require.NoError(t, err)
	now = now.Add(73 * time.Hour)
	r.Store.removeFile = func(path string) error {
		if strings.HasPrefix(filepath.Base(path), "upstream-") {
			return errors.New("synthetic sharing violation")
		}
		return os.Remove(path)
	}
	first := r.Store.CleanupExpired(64)
	require.Equal(t, 1, first.Failures)
	require.Equal(t, 1, first.Deleted)
	r.Store.removeFile = nil
	second := r.Store.CleanupExpired(64)
	require.Equal(t, 1, second.Retries)
	require.Zero(t, second.Failures)
	require.Equal(t, 1, second.Deleted)
	var rec studioRetentionRecord
	require.NoError(t, studioRead(r.Store.path("retention", receipt.TaskID), &rec))
	require.True(t, rec.Cleaned)
	require.Equal(t, 1, rec.CleanupFailures)
}

type retentionCommitFault struct {
	UsageBillingRepository
	inner *studioBillingFixture
	fail  bool
}

func (f *retentionCommitFault) Apply(ctx context.Context, cmd *UsageBillingCommand) (*UsageBillingApplyResult, error) {
	res, err := f.inner.Apply(ctx, cmd)
	if err == nil && f.fail {
		f.fail = false
		return nil, errors.New("synthetic lost SQL acknowledgement")
	}
	return res, err
}

func TestStudioImageRetentionExpiredFinancialRecoveryKeepsFingerprint(t *testing.T) {
	for _, multi := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "multi"}[multi], func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			if multi {
				q = enableStudioNativeMulti(t, r)
			}
			now := q.CreatedAt.Add(time.Second)
			r.Store.clock = func() time.Time { return now }
			posts := 0
			r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
				posts++
				var v struct {
					N int `json:"n"`
				}
				require.NoError(t, json.Unmarshal(body, &v))
				if v.N < 1 {
					v.N = 1
				}
				return studioResultN(t, v.N), "original", nil
			}
			r.Core.usageBillingRepo = &retentionCommitFault{inner: billing, fail: true}
			receipt, err := r.Dispatch(context.Background(), nil, q, "retention-billing", "synthetic", nil, key)
			require.Error(t, err)
			require.Equal(t, 1, billing.applied)
			fingerprint := billing.cmd.RequestFingerprint
			calls := posts
			now = now.Add(73 * time.Hour)
			require.Zero(t, r.Store.CleanupExpired(64).Failures)
			restarted := *r
			restarted.Store = NewStudioImageStore(r.Store.Root)
			restarted.Store.clock = func() time.Time { return now }
			got, err := restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
			require.NoError(t, err)
			require.Equal(t, "billed", got.BillingState)
			require.True(t, got.ResultRetention.Expired)
			require.Equal(t, fingerprint, billing.cmd.RequestFingerprint)
			require.Equal(t, 1, billing.applied)
			require.Equal(t, calls, posts)
			_, err = restarted.Store.Result(got)
			require.ErrorIs(t, err, ErrStudioResultExpired)
		})
	}
}

func TestStudioImageRetentionLegacySevenDaysAndUnknownPreserved(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-legacy", "synthetic", nil, key)
	require.NoError(t, err)
	require.NoError(t, os.Remove(r.Store.path("retention", receipt.TaskID)))
	testStudioLegacyImageClaim(t, r.Store, receipt)
	first := time.Now().UTC().Add(-6 * 24 * time.Hour)
	require.NoError(t, os.Chtimes(r.Store.path("result", receipt.TaskID), first, first))
	now := first.Add(6 * 24 * time.Hour)
	r.Store.clock = func() time.Time { return now }
	retention, err := r.Store.ResultRetention(receipt)
	require.NoError(t, err)
	require.Equal(t, StudioLegacyImageRetentionPolicy, retention.Policy)
	require.True(t, retention.ExpiresAt.Equal(first.Add(7*24*time.Hour)))
	_, err = r.Store.Result(receipt)
	require.NoError(t, err)
	now = first.Add(7 * 24 * time.Hour)
	require.Zero(t, r.Store.CleanupExpired(64).Failures)
	_, err = r.Store.Result(receipt)
	require.ErrorIs(t, err, ErrStudioResultExpired)
	// A legacy response without a verified persisted-result identity is unknown.
	r2, q2, key2, _, _ := studioContractFixture(t)
	r2.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		return nil, "", errors.New("synthetic lost response")
	}
	unknown, err := r2.Dispatch(context.Background(), nil, q2, "retention-unknown", "synthetic", nil, key2)
	require.Error(t, err)
	require.NoError(t, os.Remove(r2.Store.path("retention", unknown.TaskID)))
	testStudioLegacyImageClaim(t, r2.Store, unknown)
	require.NoError(t, os.WriteFile(r2.Store.path("upstream", unknown.TaskID), studioResult(t, "png"), 0600))
	r2.Store.clock = func() time.Time { return time.Now().Add(365 * 24 * time.Hour) }
	retention, err = r2.Store.ResultRetention(unknown)
	require.NoError(t, err)
	require.Equal(t, StudioLegacyRetentionPolicy, retention.Policy)
	require.Nil(t, retention.ExpiresAt)
	report := r2.Store.CleanupExpired(64)
	require.Zero(t, report.Deleted)
	_, err = os.Stat(r2.Store.path("upstream", unknown.TaskID))
	require.NoError(t, err)
}

func TestStudioImageRetentionCrashRecoveryUsesOriginalFileTime(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	r.Store.writeFile = func(path string, data []byte, exclusive bool) error {
		if strings.HasPrefix(filepath.Base(path), "retention-") && strings.Contains(string(data), `"persisted_at":"`) {
			return errors.New("synthetic sidecar fsync failure")
		}
		return studioWrite(path, data, exclusive)
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-crash", "synthetic", nil, key)
	require.Error(t, err)
	info, err := os.Stat(r.Store.path("upstream", receipt.TaskID))
	require.NoError(t, err)
	first := info.ModTime().UTC()
	restarted := *r
	restarted.Store = NewStudioImageStore(r.Store.Root)
	restarted.Store.clock = func() time.Time { return first.Add(2 * time.Hour) }
	got, err := restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.True(t, got.ResultRetention.PersistedAt.Equal(first))
	require.True(t, got.ResultRetention.ExpiresAt.Equal(first.Add(72*time.Hour)))
}

func TestStudioImageRetentionConcurrentRestartDoesNotRenew(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	first := q.CreatedAt.Add(time.Second)
	r.Store.clock = func() time.Time { return first }
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-concurrent", "synthetic", nil, key)
	require.NoError(t, err)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func(offset int) {
			defer wg.Done()
			store := NewStudioImageStore(r.Store.Root)
			store.clock = func() time.Time { return first.Add(time.Duration(offset) * time.Hour) }
			copy := *receipt
			v, e := store.ResultRetention(&copy)
			if e == nil && !v.ExpiresAt.Equal(first.Add(72*time.Hour)) {
				e = errors.New("deadline renewed")
			}
			errs <- e
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
}

func TestStudioImageRetentionCleanupFreezesFinalProofAfterCrash(t *testing.T) {
	for _, multi := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "multi"}[multi], func(t *testing.T) {
			r, q, key, _, billing := studioContractFixture(t)
			if multi {
				q = enableStudioNativeMulti(t, r)
			}
			now := q.CreatedAt.Add(time.Second)
			r.Store.clock = func() time.Time { return now }
			r.network = func(_ context.Context, _ *gin.Context, _ *Account, body []byte, _ string) ([]byte, string, error) {
				var v struct {
					N int `json:"n"`
				}
				require.NoError(t, json.Unmarshal(body, &v))
				if v.N < 1 {
					v.N = 1
				}
				return studioResultN(t, v.N), "original", nil
			}
			r.Store.writeFile = func(path string, data []byte, exclusive bool) error {
				if strings.HasPrefix(filepath.Base(path), "retention-") && strings.Contains(string(data), `"image_proof":`) {
					return errors.New("synthetic final proof fsync failure")
				}
				return studioWrite(path, data, exclusive)
			}
			receipt, err := r.Dispatch(context.Background(), nil, q, "retention-final-proof", "synthetic", nil, key)
			require.Error(t, err)
			require.Zero(t, billing.applied)
			original, err := os.ReadFile(r.Store.path("result", receipt.TaskID))
			require.NoError(t, err)
			expectedHash := HashUsageRequestPayload(original)
			r.Store.writeFile = nil
			now = now.Add(73 * time.Hour)
			report := r.Store.CleanupExpired(64)
			require.Zero(t, report.Failures)
			require.Positive(t, report.Deleted)
			got, err := r.Recover(context.Background(), receipt.TaskID, q.Owner)
			require.NoError(t, err)
			require.Equal(t, "billed", got.BillingState)
			require.Equal(t, expectedHash, got.ResultHash)
			require.Equal(t, 1, billing.applied)
		})
	}
}

func TestStudioImageRetentionCorruptSidecarPreservesOriginals(t *testing.T) {
	r, q, key, _, _ := studioContractFixture(t)
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-corrupt", "synthetic", nil, key)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(r.Store.path("retention", receipt.TaskID), []byte(`{"version":"studio_original_retention_v1","unknown":true}`), 0600))
	_, err = r.Store.Result(receipt)
	require.Error(t, err)
	report := r.Store.CleanupExpired(64)
	require.Zero(t, report.Deleted)
	require.Positive(t, report.Failures)
	_, err = os.Stat(r.Store.path("result", receipt.TaskID))
	require.NoError(t, err)
}

func TestStudioImageRetentionProofWriteFailureKeepsRecoveryBytes(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t)
	now := q.CreatedAt.Add(time.Second)
	r.Store.clock = func() time.Time { return now }
	r.Store.writeFile = func(path string, data []byte, exclusive bool) error {
		if strings.HasPrefix(filepath.Base(path), "retention-") && strings.Contains(string(data), `"image_proof":`) {
			return errors.New("synthetic proof fsync failure")
		}
		return studioWrite(path, data, exclusive)
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-proof-retry", "synthetic", nil, key)
	require.Error(t, err)
	require.Zero(t, billing.applied)
	now = now.Add(73 * time.Hour)
	report := r.Store.CleanupExpired(64)
	require.Positive(t, report.Failures)
	require.Zero(t, report.Deleted)
	_, err = os.Stat(r.Store.path("result", receipt.TaskID))
	require.NoError(t, err)
	r.Store.writeFile = nil
	report = r.Store.CleanupExpired(64)
	require.Zero(t, report.Failures)
	require.Equal(t, 1, report.Retries)
	require.Positive(t, report.Deleted)
	_, err = r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Equal(t, 1, billing.applied)
}

func TestStudioImageRetentionCleanupRotatesAcross120MixedTasks(t *testing.T) {
	r, q, _, _, _ := studioContractFixture(t)
	first := q.CreatedAt.Add(time.Second)
	now := first
	r.Store.clock = func() time.Time { return now }
	body := []byte(`{"model":"gpt-image-2","prompt":"synthetic","n":1}`)
	data := studioPixelResult(t, 2, 2)
	var expiredIDs, liveIDs, unknownIDs, legacyIDs []string
	for i := range 120 {
		id := fmt.Sprintf("retention-rotation-%03d", i)
		now = first
		receipt, created, err := r.Store.Claim(StudioImageReceipt{Version: StudioImageReceiptVersion, TaskID: id, Quote: q, Request: body, PayloadHash: HashUsageRequestPayload(body), RequestHash: studioHash(id)})
		require.NoError(t, err)
		require.True(t, created)
		switch i % 4 {
		case 0:
			require.NoError(t, r.Store.PersistResult(receipt, data))
			expiredIDs = append(expiredIDs, id)
		case 1:
			now = first.Add(71 * time.Hour)
			require.NoError(t, r.Store.PersistResult(receipt, data))
			liveIDs = append(liveIDs, id)
		case 2:
			unknownIDs = append(unknownIDs, id)
		case 3:
			require.NoError(t, os.Remove(r.Store.path("retention", id)))
			testStudioLegacyImageClaim(t, r.Store, receipt)
			require.NoError(t, r.Store.write(r.Store.path("upstream", id), []byte(`{"pending":"synthetic"}`), false))
			legacyIDs = append(legacyIDs, id)
		}
	}
	now = first.Add(73 * time.Hour)
	deleted := 0
	for range 18 {
		report := r.Store.CleanupExpired(7)
		require.LessOrEqual(t, report.Scanned, 7)
		require.Zero(t, report.Failures)
		deleted += report.Deleted
	}
	require.Equal(t, 30, deleted, "later expired tasks must not starve behind live or unknown tasks")
	for _, id := range expiredIDs {
		_, err := os.Stat(r.Store.path("result", id))
		require.True(t, os.IsNotExist(err))
	}
	for _, id := range liveIDs {
		_, err := os.Stat(r.Store.path("result", id))
		require.NoError(t, err)
	}
	for _, id := range legacyIDs {
		_, err := os.Stat(r.Store.path("upstream", id))
		require.NoError(t, err)
	}
	for _, id := range append(unknownIDs, expiredIDs...) {
		_, err := os.Stat(r.Store.path("task", id))
		require.NoError(t, err)
		_, err = os.Stat(r.Store.path("task", id) + ".sync-dispatch")
		require.NoError(t, err)
	}
}

func TestStudioMediaRetentionMaintenanceUsesExistingShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	previousStopped := false
	core := &OpenAIGatewayService{imageReceiptWorkerCancel: func() { previousStopped = true }}
	StartStudioMediaRetentionMaintenance(ctx, core, NewStudioImageStore(t.TempDir()))
	core.StopImageReceiptWorker()
	require.True(t, previousStopped)
}

func TestStudioVideoRetentionCaptureFixedAndExpiredSettlement(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	now := q.Binding.CreatedAt.Add(time.Second)
	first := now
	r.Store.clock = func() time.Time { return now }
	posts, gets := 0, 0
	r.request = func(_ context.Context, _ *Account, method, path string, _ []byte) ([]byte, string, error) {
		if method == http.MethodPost {
			posts++
			return []byte(`{"id":"upstream-original"}`), "application/json", nil
		}
		gets++
		return []byte("synthetic original"), "video/mp4", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_retention")
	require.NoError(t, err)
	hash := strings.Repeat("a", 64)
	expires := first.Add(48 * time.Hour)
	input := &StudioResultRetention{PersistedAt: &first, ExpiresAt: &expires, Policy: StudioVideoRetentionPolicy}
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_retention", hash)
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_retention", hash, input)
	require.NoError(t, err)
	proof, err := os.ReadFile(r.Store.path("result", "av_retention"))
	require.NoError(t, err)
	now = first.Add(49 * time.Hour)
	restarted := *r
	restarted.Store = &StudioVideoStore{Root: r.Store.Root, clock: func() time.Time { return now }}
	later := now
	laterExpiry := later.Add(48 * time.Hour)
	_, err = restarted.Capture(context.Background(), q.Binding.Owner, "av_retention", hash, &StudioResultRetention{PersistedAt: &later, ExpiresAt: &laterExpiry, Policy: StudioVideoRetentionPolicy})
	require.NoError(t, err)
	retention, err := restarted.Store.ResultRetention("av_retention")
	require.NoError(t, err)
	require.True(t, retention.Expired)
	require.True(t, retention.ExpiresAt.Equal(expires))
	_, _, err = restarted.Original(context.Background(), q.Binding.Owner, "av_retention")
	require.ErrorIs(t, err, ErrStudioResultExpired)
	require.Zero(t, gets)
	state, err := restarted.Recover(context.Background(), q.Binding.Owner, "av_retention")
	require.NoError(t, err)
	require.True(t, state.ResultRetention.Expired)
	after, err := os.ReadFile(r.Store.path("result", "av_retention"))
	require.NoError(t, err)
	require.Equal(t, proof, after)
	require.Equal(t, 1, orders.captures)
	require.Equal(t, 1, posts)
}

func TestStudioVideoRetentionFirstCaptureAfterExpiryStillSettlesProof(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	first := q.Binding.CreatedAt.Add(time.Second)
	now := first
	r.Store.clock = func() time.Time { return now }
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		return []byte(`{"id":"upstream-original"}`), "application/json", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_late_capture")
	require.NoError(t, err)
	// Submit within the original quote TTL, then delay only the first capture.
	now = first.Add(49 * time.Hour)
	expires := first.Add(48 * time.Hour)
	input := &StudioResultRetention{PersistedAt: &first, ExpiresAt: &expires, Policy: StudioVideoRetentionPolicy}
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_late_capture", strings.Repeat("a", 64), input)
	require.NoError(t, err)
	require.Equal(t, 1, orders.captures)
	_, _, err = r.Original(context.Background(), q.Binding.Owner, "av_late_capture")
	require.ErrorIs(t, err, ErrStudioResultExpired)
}

func TestStudioVideoRetentionInvalidTimestampsCannotCreateMoneyProof(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	now := q.Binding.CreatedAt.Add(time.Second)
	r.Store.clock = func() time.Time { return now }
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		return []byte(`{"id":"upstream-original"}`), "application/json", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_invalid_retention")
	require.NoError(t, err)
	for _, variant := range []string{"short", "future", "before_quote", "wrong_policy"} {
		at := now
		duration := 48 * time.Hour
		policy := StudioVideoRetentionPolicy
		switch variant {
		case "short":
			duration = 47 * time.Hour
		case "future":
			at = now.Add(2 * time.Minute)
		case "before_quote":
			at = q.Binding.CreatedAt.Add(-time.Second)
		case "wrong_policy":
			policy = StudioImageRetentionPolicy
			duration = 72 * time.Hour
		}
		expires := at.Add(duration)
		_, err = r.Capture(context.Background(), q.Binding.Owner, "av_invalid_retention", strings.Repeat("a", 64), &StudioResultRetention{PersistedAt: &at, ExpiresAt: &expires, Policy: policy})
		require.ErrorIs(t, err, ErrStudioVideoConflict, variant)
	}
	retention, err := r.Store.ResultRetention("av_invalid_retention")
	require.NoError(t, err)
	require.Nil(t, retention.PersistedAt)
	require.Zero(t, orders.captures)
	_, err = os.Stat(r.Store.path("result", "av_invalid_retention"))
	require.True(t, os.IsNotExist(err))
}

func TestStudioVideoRetentionLegacyUnknownPreservesOriginalContract(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	r.request = func(_ context.Context, _ *Account, method, _ string, _ []byte) ([]byte, string, error) {
		if method == http.MethodPost {
			return []byte(`{"id":"upstream-original"}`), "application/json", nil
		}
		return []byte("synthetic original"), "video/mp4", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_legacy_retention")
	require.NoError(t, err)
	require.NoError(t, os.Remove(r.Store.path("retention", "av_legacy_retention")))
	require.NoError(t, os.Remove(r.Store.path("task", "av_legacy_retention")+".retention-policy"))
	r.Store.clock = func() time.Time { return time.Now().Add(365 * 24 * time.Hour) }
	retention, err := r.Store.ResultRetention("av_legacy_retention")
	require.NoError(t, err)
	require.Equal(t, StudioLegacyRetentionPolicy, retention.Policy)
	require.Nil(t, retention.ExpiresAt)
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_legacy_retention", strings.Repeat("a", 64))
	require.NoError(t, err)
	require.Equal(t, 1, orders.captures)
	_, _, err = r.Original(context.Background(), q.Binding.Owner, "av_legacy_retention")
	require.NoError(t, err)
}

func TestStudioImageRetentionMissingSidecarNeverBecomesLegacy(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t)
	now := q.CreatedAt.Add(time.Second)
	r.Store.clock = func() time.Time { return now }
	posts := 0
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		posts++
		return studioPixelResult(t, 2, 2), "original", nil
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "retention-lost-sidecar", "synthetic", nil, key)
	require.NoError(t, err)
	now = now.Add(73 * time.Hour)
	require.NoError(t, os.Remove(r.Store.path("retention", receipt.TaskID)))
	_, err = r.Store.ResultRetention(receipt)
	require.ErrorIs(t, err, ErrStudioImageConflict)
	_, err = r.Store.Result(receipt)
	require.Error(t, err)
	_, err = r.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.Error(t, err)
	_, err = r.materializeResult(context.Background(), q, receipt.TaskID, []byte(`{"data":[{"url":"https://supplier.example/original.png"}]}`))
	require.Error(t, err)
	_, err = r.Dispatch(context.Background(), nil, q, receipt.TaskID, "synthetic", nil, key)
	require.Error(t, err)
	_, err = os.Stat(r.Store.path("retention", receipt.TaskID))
	require.True(t, os.IsNotExist(err), "missing policy must not be recreated with legacy TTL")
	require.Equal(t, 1, posts)
	require.Equal(t, 1, billing.applied)
}

func TestStudioVideoRetentionMissingSidecarNeverBecomesLegacy(t *testing.T) {
	r, token, q, key, _, orders := videoRuntimeFixture(t)
	first := q.Binding.CreatedAt.Add(time.Second)
	now := first
	r.Store.clock = func() time.Time { return now }
	posts, gets := 0, 0
	r.request = func(_ context.Context, _ *Account, method, _ string, _ []byte) ([]byte, string, error) {
		if method == http.MethodPost {
			posts++
			return []byte(`{"id":"upstream-original"}`), "application/json", nil
		}
		gets++
		return []byte("synthetic-original"), "video/mp4", nil
	}
	_, err := r.Submit(context.Background(), q.Binding.Owner, key, token, "av_lost_retention")
	require.NoError(t, err)
	expires := first.Add(48 * time.Hour)
	hash := strings.Repeat("a", 64)
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_lost_retention", hash, &StudioResultRetention{PersistedAt: &first, ExpiresAt: &expires, Policy: StudioVideoRetentionPolicy})
	require.NoError(t, err)
	now = first.Add(49 * time.Hour)
	require.NoError(t, os.Remove(r.Store.path("retention", "av_lost_retention")))
	_, err = r.Store.ResultRetention("av_lost_retention")
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	_, _, err = r.Original(context.Background(), q.Binding.Owner, "av_lost_retention")
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	_, err = r.Recover(context.Background(), q.Binding.Owner, "av_lost_retention")
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	laterExpires := now.Add(48 * time.Hour)
	_, err = r.Capture(context.Background(), q.Binding.Owner, "av_lost_retention", hash, &StudioResultRetention{PersistedAt: &now, ExpiresAt: &laterExpires, Policy: StudioVideoRetentionPolicy})
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	_, err = r.Submit(context.Background(), q.Binding.Owner, key, token, "av_lost_retention")
	require.ErrorIs(t, err, ErrStudioVideoConflict)
	_, err = os.Stat(r.Store.path("retention", "av_lost_retention"))
	require.True(t, os.IsNotExist(err))
	require.Zero(t, gets)
	require.Equal(t, 1, posts)
	require.Equal(t, 1, orders.captures)
}

type studioRetentionWhitespace struct{}

func (studioRetentionWhitespace) Read(data []byte) (int, error) {
	for i := range data {
		data[i] = ' '
	}
	return len(data), nil
}

func TestStudioUnitResponseDecoderHasPrivate64MiBBound(t *testing.T) {
	unitPath := filepath.Join(t.TempDir(), "unit-response-"+strings.Repeat("a", 64))
	unitLimit := studioJSONReadLimit(unitPath)
	require.Equal(t, int64(64<<20), unitLimit)
	generalLimit := studioJSONReadLimit(filepath.Join(t.TempDir(), "task-"+strings.Repeat("a", 64)))
	require.Equal(t, int64(40<<20), generalLimit)
	require.Equal(t, generalLimit, studioJSONReadLimit("unit-response-untrusted"))
	reader := func() io.Reader {
		return io.MultiReader(io.LimitReader(studioRetentionWhitespace{}, (40<<20)+1), strings.NewReader(`{"id":"synthetic"}`))
	}
	var outcome studioImageUnitOutcome
	require.Error(t, studioDecodeJSON(reader(), &outcome, generalLimit))
	require.NoError(t, studioDecodeJSON(reader(), &outcome, unitLimit))
	require.Equal(t, "synthetic", outcome.ID)
	require.Error(t, studioDecodeJSON(strings.NewReader(`{"id":"synthetic","unexpected":true}`), &outcome, unitLimit))
	require.Error(t, studioDecodeJSON(strings.NewReader(`{"id":"synthetic"} {}`), &outcome, unitLimit))
}

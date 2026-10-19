package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
)

var ErrStudioResultExpired = errors.New("original media retention expired")

const (
	StudioImageRetentionPolicy       = "image_original_72h"
	StudioLegacyImageRetentionPolicy = "image_legacy_7d"
	StudioVideoRetentionPolicy       = "video_original_48h"
	StudioLegacyRetentionPolicy      = "legacy_unknown"
	studioRetentionVersion           = "studio_original_retention_v1"
)

// This describes original-media availability, independently of quote validity
// and financial retention. Nil times are intentional for unpersisted/unknown data.
type StudioResultRetention struct {
	PersistedAt *time.Time `json:"persisted_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	Expired     bool       `json:"expired"`
	Policy      string     `json:"policy"`
}

type studioImageRetentionProof struct {
	UpstreamID     string                   `json:"upstream_id,omitempty"`
	ResultHash     string                   `json:"result_hash"`
	ExpectedCount  int                      `json:"expected_count"`
	DeliveredCount int                      `json:"delivered_count"`
	FailedCount    int                      `json:"failed_count"`
	PendingCount   int                      `json:"pending_count"`
	Units          []StudioImageUnitReceipt `json:"units,omitempty"`
}

type studioImageUnitRetentionProof struct {
	ID          string `json:"id"`
	PayloadHash string `json:"payload_hash"`
	UpstreamID  string `json:"upstream_id"`
	State       string `json:"state"`
	DataHash    string `json:"data_hash"`
	ResultHash  string `json:"result_hash,omitempty"`
	ActualCount int    `json:"actual_count,omitempty"`
}

// Keep this outside old receipt/quote schemas and their monetary fingerprints.
// Older executors do not enforce this file: rollback needs an equally capable
// executor or must keep original-media recovery disabled.
type studioRetentionRecord struct {
	Version         string                                   `json:"version"`
	TaskID          string                                   `json:"task_id"`
	BindingHash     string                                   `json:"binding_hash"`
	PayloadHash     string                                   `json:"payload_hash,omitempty"`
	Retention       StudioResultRetention                    `json:"retention"`
	ImageProof      *studioImageRetentionProof               `json:"image_proof,omitempty"`
	UnitProofs      map[string]studioImageUnitRetentionProof `json:"unit_proofs,omitempty"`
	CleanupAttempts int                                      `json:"cleanup_attempts,omitempty"`
	CleanupFailures int                                      `json:"cleanup_failures,omitempty"`
	Cleaned         bool                                     `json:"cleaned,omitempty"`
}

func (v StudioResultRetention) at(now time.Time) StudioResultRetention {
	v.Expired = v.ExpiresAt != nil && !now.Before(*v.ExpiresAt)
	return v
}

func (v StudioResultRetention) validate() error {
	duration := time.Duration(0)
	switch v.Policy {
	case StudioImageRetentionPolicy:
		duration = 72 * time.Hour
	case StudioLegacyImageRetentionPolicy:
		duration = 7 * 24 * time.Hour
	case StudioVideoRetentionPolicy:
		duration = 48 * time.Hour
	case StudioLegacyRetentionPolicy:
		if v.PersistedAt == nil && v.ExpiresAt == nil {
			return nil
		}
		return ErrStudioImageConflict
	default:
		return ErrStudioImageConflict
	}
	if v.PersistedAt == nil && v.ExpiresAt == nil {
		return nil
	}
	if v.PersistedAt == nil || v.ExpiresAt == nil || v.PersistedAt.IsZero() || !v.ExpiresAt.Equal(v.PersistedAt.Add(duration)) {
		return ErrStudioImageConflict
	}
	return nil
}

func (s *StudioImageStore) now() time.Time {
	if s.clock != nil {
		return s.clock().UTC()
	}
	return time.Now().UTC()
}

func (s *StudioImageStore) retentionLock(id string) (func(), error) {
	if err := s.init(); err != nil {
		return nil, err
	}
	return studioFileLock(s.path("retention", id) + ".lock")
}

func (s *StudioImageStore) saveRetention(v studioRetentionRecord) error {
	v.Retention.Expired = false // computed at read time, never a mutable deadline
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.write(s.path("retention", v.TaskID), b, false)
}

func (s *StudioImageStore) claimRetention(r *StudioImageReceipt) error {
	unlock, err := s.retentionLock(r.TaskID)
	if err != nil {
		return err
	}
	defer unlock()
	var old studioRetentionRecord
	if err = studioRead(s.path("retention", r.TaskID), &old); err == nil {
		if old.TaskID != r.TaskID || old.BindingHash != r.Quote.BindingHash || old.PayloadHash != r.PayloadHash {
			return ErrStudioImageConflict
		}
		return old.Retention.validate()
	} else if !os.IsNotExist(err) {
		return err
	}
	return s.saveRetention(studioRetentionRecord{Version: studioRetentionVersion, TaskID: r.TaskID, BindingHash: r.Quote.BindingHash, PayloadHash: r.PayloadHash, Retention: StudioResultRetention{Policy: StudioImageRetentionPolicy}})
}

func imageRetentionProof(r *StudioImageReceipt) *studioImageRetentionProof {
	return &studioImageRetentionProof{UpstreamID: r.UpstreamID, ResultHash: r.ResultHash, ExpectedCount: r.ExpectedCount, DeliveredCount: r.DeliveredCount, FailedCount: r.FailedCount, PendingCount: r.PendingCount, Units: append([]StudioImageUnitReceipt(nil), r.Units...)}
}

// Caller holds the per-task OS lock. Legacy timestamps are adopted only from a
// verified final result; unknown or incomplete historic files are preserved.
func (s *StudioImageStore) imageRetentionLocked(id string) (studioRetentionRecord, error) {
	var rec studioRetentionRecord
	err := studioRead(s.path("retention", id), &rec)
	var receipt StudioImageReceipt
	if e := studioRead(s.path("task", id), &receipt); e != nil {
		return rec, e
	}
	if receipt.TaskID != id || receipt.Quote.BindingHash != studioQuoteHash(receipt.Quote) || receipt.PayloadHash != HashUsageRequestPayload(receipt.Request) || receipt.Quote.Accounting.Validate(receipt.Quote) != nil {
		return rec, ErrStudioImageConflict
	}
	if err == nil {
		if rec.Version != studioRetentionVersion || rec.TaskID != id || rec.BindingHash != receipt.Quote.BindingHash || rec.PayloadHash != receipt.PayloadHash || rec.Retention.validate() != nil {
			return rec, ErrStudioImageConflict
		}
		if rec.Retention.Policy != StudioImageRetentionPolicy && rec.Retention.Policy != StudioLegacyImageRetentionPolicy && rec.Retention.Policy != StudioLegacyRetentionPolicy {
			return rec, ErrStudioImageConflict
		}
	} else if os.IsNotExist(err) {
		if modern, markerErr := s.imageRetentionMarker(&receipt); markerErr != nil {
			return rec, markerErr
		} else if modern {
			return rec, ErrStudioImageConflict
		}
		rec = studioRetentionRecord{Version: studioRetentionVersion, TaskID: id, BindingHash: receipt.Quote.BindingHash, PayloadHash: receipt.PayloadHash, Retention: StudioResultRetention{Policy: StudioLegacyRetentionPolicy}}
		data, e := os.ReadFile(s.path("result", id))    // #nosec G703 -- path hashes id with SHA-256 under the server-configured private root; result is a fixed prefix.
		info, statErr := os.Lstat(s.path("result", id)) // #nosec G703 -- Same hashed result path; caller-controlled id is never a filesystem component.
		if e != nil || statErr != nil || !info.Mode().IsRegular() || receipt.ResultHash == "" || HashUsageRequestPayload(data) != receipt.ResultHash {
			return rec, nil
		}
		if _, e = validateStudioImageReceiptResult(&receipt, data); e != nil {
			return rec, nil
		}
		at := info.ModTime().UTC()
		expires := at.Add(7 * 24 * time.Hour)
		rec.Retention = StudioResultRetention{PersistedAt: &at, ExpiresAt: &expires, Policy: StudioLegacyImageRetentionPolicy}
		rec.ImageProof = imageRetentionProof(&receipt)
		return rec, s.saveRetention(rec)
	} else {
		return rec, err
	}
	if rec.Retention.PersistedAt != nil {
		return rec, nil
	}
	// Recover a crash between a durable media write and its sidecar update.
	// Use the existing file's timestamp, never a recovery/read timestamp.
	var first time.Time
	consider := func(kind, copyID string, expected int, outcome bool) {
		path := s.path(kind, copyID)
		info, e := os.Lstat(path) // #nosec G703 -- Private configured root plus SHA-256 identity; closure callers supply only fixed media kinds.
		if e != nil || !info.Mode().IsRegular() {
			return
		}
		var data []byte
		if outcome {
			var v studioImageUnitOutcome
			if studioRead(path, &v) != nil || v.ID != copyID || v.State != "response" {
				return
			}
			data = v.Data
		} else {
			data, e = os.ReadFile(path) // #nosec G703 -- Same hashed copy path; kind is a fixed closure-call constant, not request input.
			if e != nil {
				return
			}
		}
		if _, count, e := studioExecutionResult(data, expected); e != nil || count == 0 {
			return
		}
		at := info.ModTime().UTC()
		if first.IsZero() || at.Before(first) {
			first = at
		}
	}
	consider("result", id, receipt.Quote.Binding.Spec.Count, false)
	consider("upstream", id, receipt.Quote.Binding.Spec.Count, false)
	consider("materialized", id, receipt.Quote.Binding.Spec.Count, false)
	for _, u := range receipt.Units {
		consider("unit-response", u.ID, u.OutputCount, true)
		consider("materialized", u.ID, u.OutputCount, false)
	}
	if !first.IsZero() {
		expires := first.Add(72 * time.Hour)
		rec.Retention.PersistedAt, rec.Retention.ExpiresAt = &first, &expires
		if err := s.saveRetention(rec); err != nil {
			return rec, err
		}
	}
	return rec, nil
}

func (s *StudioImageStore) imageRetentionMarker(r *StudioImageReceipt) (bool, error) {
	path := s.path("task", r.TaskID) + ".sync-dispatch"
	info, err := os.Lstat(path) // #nosec G703 -- Task ID is SHA-256 encoded beneath the private root; marker suffix is constant.
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 512 {
		return false, ErrStudioImageConflict
	}
	data, err := os.ReadFile(path) // #nosec G703 -- Same private hashed task path with a fixed retention/dispatch marker suffix.
	if err != nil {
		return false, err
	}
	legacy := r.Quote.BindingHash + "|" + r.PayloadHash
	switch string(data) {
	case legacy:
		return false, nil
	case legacy + "|retention:" + StudioImageRetentionPolicy:
		return true, nil
	default:
		return false, ErrStudioImageConflict
	}
}

func (s *StudioImageStore) ResultRetention(r *StudioImageReceipt) (StudioResultRetention, error) {
	unlock, err := s.retentionLock(r.TaskID)
	if err != nil {
		return StudioResultRetention{}, err
	}
	defer unlock()
	rec, err := s.imageRetentionLocked(r.TaskID)
	retention := rec.Retention.at(s.now())
	if err == nil {
		r.ResultRetention = &retention
	}
	return retention, err
}

func (s *StudioImageStore) checkRetention(id string) error {
	var r StudioImageReceipt
	if err := studioRead(s.path("task", id), &r); err != nil {
		return err
	}
	v, err := s.ResultRetention(&r)
	if err == nil && v.Expired {
		return ErrStudioResultExpired
	}
	return err
}

// All original-media writes take the same lock as cleanup. Completion is
// recorded once; partial responses and upstream URLs do not start a new clock.
func (s *StudioImageStore) persistCopy(taskID, kind, copyID string, data []byte, complete bool, proof *StudioImageReceipt) error {
	unlock, err := s.retentionLock(taskID)
	if err != nil {
		return err
	}
	defer unlock()
	rec, err := s.imageRetentionLocked(taskID)
	if err != nil {
		return err
	}
	if rec.Retention.at(s.now()).Expired {
		return ErrStudioResultExpired
	}
	if proof != nil && rec.ImageProof != nil && rec.ImageProof.ResultHash != proof.ResultHash {
		return ErrStudioImageConflict
	}
	if err = s.write(s.path(kind, copyID), data, false); err != nil {
		return err
	}
	if complete && rec.Retention.PersistedAt == nil {
		at := s.now()
		duration := 72 * time.Hour
		if rec.Retention.Policy == StudioLegacyRetentionPolicy {
			rec.Retention.Policy = StudioLegacyImageRetentionPolicy
			duration = 7 * 24 * time.Hour
		}
		expires := at.Add(duration)
		rec.Retention.PersistedAt, rec.Retention.ExpiresAt = &at, &expires
	}
	if proof != nil {
		rec.ImageProof = imageRetentionProof(proof)
	}
	return s.saveRetention(rec)
}

// Financial recovery uses the frozen proof after bytes expire. No URL GET or
// generation POST is needed, and the existing native billing fingerprint stays.
func (s *StudioImageStore) restoreResultProof(r *StudioImageReceipt) error {
	unlock, err := s.retentionLock(r.TaskID)
	if err != nil {
		return err
	}
	defer unlock()
	rec, err := s.imageRetentionLocked(r.TaskID)
	if err != nil {
		return err
	}
	if err = s.freezeImageProof(&rec, r); err != nil {
		return err
	}
	p := rec.ImageProof
	if p == nil || !videoDigest(p.ResultHash) || (r.ResultHash != "" && r.ResultHash != p.ResultHash) {
		return ErrStudioResultExpired
	}
	r.ResultHash = p.ResultHash
	if r.UpstreamID != "" && p.UpstreamID != "" && r.UpstreamID != p.UpstreamID {
		return ErrStudioImageConflict
	}
	if p.UpstreamID != "" {
		r.UpstreamID = p.UpstreamID
	}
	r.ExpectedCount, r.DeliveredCount, r.FailedCount, r.PendingCount = p.ExpectedCount, p.DeliveredCount, p.FailedCount, p.PendingCount
	r.Units = append([]StudioImageUnitReceipt(nil), p.Units...)
	return nil
}

type StudioRetentionCleanupReport struct {
	Scanned  int   `json:"scanned"`
	Expired  int   `json:"expired"`
	Deleted  int   `json:"deleted"`
	Failures int   `json:"failures"`
	Retries  int   `json:"retries"`
	Bytes    int64 `json:"bytes"`
}

// This maintenance performs local filesystem I/O only. Claims, quotes, receipts,
// hash proofs and SQL financial records are never deleted.
func (s *StudioImageStore) CleanupExpired(limit int) StudioRetentionCleanupReport {
	s.cleanupMu.Lock()
	defer s.cleanupMu.Unlock()
	var report StudioRetentionCleanupReport
	if limit <= 0 {
		limit = 64
	}
	if limit > 256 {
		limit = 256
	}
	entries, err := os.ReadDir(s.Root) // #nosec G703 -- Root is server deployment configuration, never a request field.
	if os.IsNotExist(err) {
		return report
	}
	if err != nil {
		report.Failures++
		return report
	}
	names := make([]string, 0)
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), "task-") && !strings.Contains(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	start := sort.SearchStrings(names, s.cleanupAfter)
	if start < len(names) && names[start] == s.cleanupAfter {
		start++
	}
	if start >= len(names) {
		start = 0
	}
	for n := 0; n < len(names) && n < limit; n++ {
		name := names[(start+n)%len(names)]
		s.cleanupAfter = name
		report.Scanned++
		var r StudioImageReceipt
		if studioRead(filepath.Join(s.Root, name), &r) != nil || s.path("task", r.TaskID) != filepath.Join(s.Root, name) {
			report.Failures++
			continue
		}
		unlock, e := s.retentionLock(r.TaskID)
		if e != nil {
			report.Failures++
			continue
		}
		func() {
			defer unlock()
			rec, e := s.imageRetentionLocked(r.TaskID)
			if e != nil {
				report.Failures++
				return
			}
			if !rec.Retention.at(s.now()).Expired || rec.Cleaned {
				return
			}
			report.Expired++
			if rec.CleanupAttempts > 0 {
				report.Retries++
			}
			rec.CleanupAttempts++
			failures := report.Failures
			previousProof := rec.ImageProof
			if e = s.freezeImageProof(&rec, &r); e != nil {
				rec.ImageProof = previousProof
				rec.CleanupFailures++
				_ = s.saveRetention(rec)
				report.Failures++
				return
			}
			remove := func(kind, id string) {
				path := s.path(kind, id)
				info, e := os.Lstat(path) // #nosec G703 -- Private configured root plus SHA-256 identity; closure callers supply only fixed media kinds.
				if os.IsNotExist(e) {
					return
				}
				if e != nil || !info.Mode().IsRegular() {
					report.Failures++
					return
				}
				removeFile := os.Remove
				if s.removeFile != nil {
					removeFile = s.removeFile
				}
				if e = removeFile(path); e != nil { // #nosec G703 -- Fixed media kind plus SHA-256 identity under the private root; non-regular entries are rejected above.
					report.Failures++
					return
				}
				report.Deleted++
				report.Bytes += info.Size()
			}
			for _, kind := range []string{"result", "upstream", "materialized"} {
				remove(kind, r.TaskID)
			}
			for _, u := range r.Units {
				path := s.path("unit-response", u.ID)
				beforeInfo, statErr := os.Lstat(path) // #nosec G703 -- Fixed unit-response prefix plus SHA-256 unit ID beneath the private root.
				var out studioImageUnitOutcome
				if e := studioRead(path, &out); os.IsNotExist(e) {
					if data, e := s.readOriginalCopy("materialized", u.ID); e == nil {
						if _, count, e := studioExecutionResult(data, u.OutputCount); e == nil && count > 0 {
							if rec.UnitProofs == nil {
								rec.UnitProofs = make(map[string]studioImageUnitRetentionProof)
							}
							rec.UnitProofs[u.ID] = studioImageUnitRetentionProof{ID: u.ID, PayloadHash: u.PayloadHash, UpstreamID: u.UpstreamID, State: "unknown", DataHash: HashUsageRequestPayload(data), ResultHash: HashUsageRequestPayload(data), ActualCount: count}
							if e = s.saveRetention(rec); e != nil {
								report.Failures++
								continue
							}
						}
					}
					remove("materialized", u.ID)
					continue
				} else if e != nil || out.ID != u.ID || out.PayloadHash != u.PayloadHash {
					report.Failures++
					continue
				}
				if len(out.Data) == 0 {
					remove("materialized", u.ID)
					continue
				}
				if statErr != nil || !beforeInfo.Mode().IsRegular() {
					report.Failures++
					continue
				}
				unitProof := studioImageUnitRetentionProof{ID: out.ID, PayloadHash: out.PayloadHash, UpstreamID: out.UpstreamID, State: out.State, DataHash: HashUsageRequestPayload(out.Data)}
				if _, count, e := studioExecutionResult(out.Data, u.OutputCount); e == nil && count > 0 {
					unitProof.ResultHash = unitProof.DataHash
					unitProof.ActualCount = count
				} else if data, e := s.readOriginalCopy("materialized", u.ID); e == nil {
					if _, count, e := studioExecutionResult(data, u.OutputCount); e == nil && count > 0 {
						unitProof.ResultHash = HashUsageRequestPayload(data)
						unitProof.ActualCount = count
					}
				}
				if rec.UnitProofs == nil {
					rec.UnitProofs = make(map[string]studioImageUnitRetentionProof)
				}
				rec.UnitProofs[u.ID] = unitProof
				// Persist the proof before stripping bytes. A failed proof write must
				// leave the only recovery/settlement evidence intact for a retry.
				if e := s.saveRetention(rec); e != nil {
					report.Failures++
					continue
				}
				remove("materialized", u.ID)
				out.Data = nil
				data, e := json.Marshal(out)
				if e == nil {
					e = s.write(path, data, false)
				}
				if e != nil {
					report.Failures++
					continue
				}
				report.Deleted++
				if afterInfo, e := os.Lstat(path); e == nil { // #nosec G703 -- Same hashed unit-response path used for the protected rewrite above.
					report.Bytes += beforeInfo.Size() - afterInfo.Size()
				} else {
					report.Failures++
				}
			}
			rec.CleanupFailures += report.Failures - failures
			rec.Cleaned = report.Failures == failures
			if e = s.saveRetention(rec); e != nil {
				report.Failures++
			}
		}()
	}
	return report
}

// The wire provider starts one maintenance loop for the process lifetime. An
// explicit context allows cancellation in shorter-lived hosts and tests.
func StartStudioMediaRetentionMaintenance(ctx context.Context, core *OpenAIGatewayService, image *StudioImageStore) {
	if image == nil {
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	if core != nil {
		previous := core.imageReceiptWorkerCancel
		core.imageReceiptWorkerCancel = func() {
			cancel()
			if previous != nil {
				previous()
			}
		}
	}
	go func() {
		defer cancel()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			report := image.CleanupExpired(64)
			if report.Expired > 0 || report.Failures > 0 {
				logger.LegacyPrintf("service.studio_retention", "cleanup scanned=%d expired=%d deleted=%d bytes=%d failures=%d retries=%d", report.Scanned, report.Expired, report.Deleted, report.Bytes, report.Failures, report.Retries)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *StudioVideoStore) now() time.Time {
	if s.clock != nil {
		return s.clock().UTC()
	}
	return time.Now().UTC()
}

func (s *StudioVideoStore) retentionLock(id string) (func(), error) {
	if err := s.init(); err != nil {
		return nil, err
	}
	return studioFileLock(s.path("retention", id) + ".lock")
}

func (s *StudioVideoStore) retentionLocked(id string) (studioRetentionRecord, error) {
	var task StudioVideoTask
	if err := studioRead(s.path("task", id), &task); err != nil {
		return studioRetentionRecord{}, err
	}
	if task.ID != id || task.Quote.Validate() != nil {
		return studioRetentionRecord{}, ErrStudioVideoConflict
	}
	var rec studioRetentionRecord
	err := studioRead(s.path("retention", id), &rec)
	if os.IsNotExist(err) {
		if modern, markerErr := s.videoRetentionMarker(task); markerErr != nil {
			return rec, markerErr
		} else if modern {
			return rec, ErrStudioVideoConflict
		}
		return studioRetentionRecord{Version: studioRetentionVersion, TaskID: id, Retention: StudioResultRetention{Policy: StudioLegacyRetentionPolicy}}, nil
	}
	if err != nil {
		return rec, err
	}
	if rec.Version != studioRetentionVersion || rec.TaskID != id || rec.BindingHash != task.Quote.BindingHash || rec.Retention.validate() != nil || rec.Retention.Policy != StudioVideoRetentionPolicy {
		return rec, ErrStudioVideoConflict
	}
	return rec, nil
}

func (s *StudioVideoStore) claimRetention(t StudioVideoTask) error {
	unlock, err := s.retentionLock(t.ID)
	if err != nil {
		return err
	}
	defer unlock()
	marker := s.path("task", t.ID) + ".retention-policy"
	want := studioRetentionVersion + "|" + StudioVideoRetentionPolicy + "|" + t.Quote.BindingHash
	if err = studioWrite(marker, []byte(want), true); os.IsExist(err) {
		if data, e := os.ReadFile(marker); e != nil { // #nosec G703 -- Video task ID is hashed under the private root; retention-policy suffix is constant.
			return e
		} else if string(data) != want {
			return ErrStudioVideoConflict
		}
	} else if err != nil {
		return err
	}
	var old studioRetentionRecord
	if err := studioRead(s.path("retention", t.ID), &old); err == nil {
		if old.Version != studioRetentionVersion || old.TaskID != t.ID || old.BindingHash != t.Quote.BindingHash || old.Retention.validate() != nil {
			return ErrStudioVideoConflict
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	rec := studioRetentionRecord{Version: studioRetentionVersion, TaskID: t.ID, BindingHash: t.Quote.BindingHash, Retention: StudioResultRetention{Policy: StudioVideoRetentionPolicy}}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return studioWrite(s.path("retention", t.ID), data, true)
}

func (s *StudioVideoStore) videoRetentionMarker(t StudioVideoTask) (bool, error) {
	path := s.path("task", t.ID) + ".retention-policy"
	info, err := os.Lstat(path) // #nosec G703 -- Task ID is SHA-256 encoded beneath the private root; marker suffix is constant.
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 512 {
		return false, ErrStudioVideoConflict
	}
	data, err := os.ReadFile(path) // #nosec G703 -- Same private hashed task path with a fixed retention/dispatch marker suffix.
	if err != nil {
		return false, err
	}
	if string(data) != studioRetentionVersion+"|"+StudioVideoRetentionPolicy+"|"+t.Quote.BindingHash {
		return false, ErrStudioVideoConflict
	}
	return true, nil
}

func (s *StudioVideoStore) ResultRetention(id string) (StudioResultRetention, error) {
	unlock, err := s.retentionLock(id)
	if err != nil {
		return StudioResultRetention{}, err
	}
	defer unlock()
	rec, err := s.retentionLocked(id)
	return rec.Retention.at(s.now()), err
}

// Accept only the trusted BFF's complete durable-put timestamp. A repeated
// capture reuses the original sidecar even if the caller supplies later dates.
func (s *StudioVideoStore) captureRetention(t StudioVideoTask, input *StudioResultRetention) error {
	unlock, err := s.retentionLock(t.ID)
	if err != nil {
		return err
	}
	defer unlock()
	rec, err := s.retentionLocked(t.ID)
	if err != nil {
		return err
	}
	if rec.Retention.Policy == StudioLegacyRetentionPolicy {
		return nil
	}
	if rec.BindingHash != t.Quote.BindingHash {
		return ErrStudioVideoConflict
	}
	if rec.Retention.PersistedAt != nil {
		return nil
	}
	if input == nil || input.Policy != StudioVideoRetentionPolicy || input.PersistedAt == nil || input.validate() != nil || input.PersistedAt.After(s.now().Add(time.Minute)) || input.PersistedAt.Before(t.Quote.Binding.CreatedAt) {
		return ErrStudioVideoConflict
	}
	rec.Retention = *input
	rec.Retention.Expired = false
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return studioWrite(s.path("retention", t.ID), data, false)
}

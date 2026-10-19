package service

import (
	"encoding/json"
	"os"
)

func (s *StudioImageStore) readOriginalCopy(kind, id string) ([]byte, error) {
	path := s.path(kind, id)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrStudioImageConflict
	}
	root, err := os.OpenRoot(s.Root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	return root.ReadFile(kind + "-" + HashUsageRequestPayload([]byte(id)))
}

// Freeze only complete, validated original response facts before deleting any
// bytes. This also covers a crash before PersistResult saved its final proof.
// Unknown dispatch outcomes remain unknown; this function never uses a network.
func (s *StudioImageStore) freezeImageProof(rec *studioRetentionRecord, r *StudioImageReceipt) error {
	if rec.ImageProof != nil {
		return nil
	}
	snapshot := *r
	snapshot.Units = append([]StudioImageUnitReceipt(nil), r.Units...)
	var complete []byte
	if r.Version != StudioImageMultiReceiptVersion {
		for _, kind := range []string{"result", "materialized", "upstream"} {
			data, err := s.readOriginalCopy(kind, r.TaskID)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			if _, err = validateStudioImageReceiptResult(r, data); err == nil {
				complete = data
				break
			}
		}
		if len(complete) == 0 {
			return nil
		}
	} else {
		if r.Quote.Execution == nil || studioHash(r.Execution) != studioHash(*r.Quote.Execution) || len(r.Units) != len(r.Execution.Units) {
			return ErrStudioImageConflict
		}
		for i, u := range r.Units {
			plan := r.Execution.Units[i]
			if u.ID != studioHash([]any{r.TaskID, r.Quote.BindingHash, i}) || u.Index != i || u.OutputOffset != plan.OutputOffset || u.OutputCount != plan.OutputCount {
				return ErrStudioImageConflict
			}
		}
		snapshot.DeliveredCount, snapshot.FailedCount, snapshot.PendingCount = 0, 0, 0
		var items []json.RawMessage
		for i := range snapshot.Units {
			u := &snapshot.Units[i]
			var out studioImageUnitOutcome
			if err := studioRead(s.path("unit-response", u.ID), &out); os.IsNotExist(err) {
				return nil
			} else if err != nil {
				return err
			}
			if out.ID != u.ID || out.PayloadHash != u.PayloadHash {
				return ErrStudioImageConflict
			}
			u.UpstreamID, u.HTTPFailure = out.UpstreamID, out.HTTPFailure
			switch out.State {
			case "response":
				data := out.Data
				part, count, err := studioExecutionResult(data, u.OutputCount)
				if err != nil {
					data, err = s.readOriginalCopy("materialized", u.ID)
					if os.IsNotExist(err) {
						return nil
					}
					if err != nil {
						return err
					}
					part, count, err = studioExecutionResult(data, u.OutputCount)
				}
				if err != nil {
					return nil
				}
				u.ActualCount = count
				u.ResultHash = HashUsageRequestPayload(data)
				u.Status = "persisted"
				snapshot.DeliveredCount += count
				snapshot.FailedCount += u.OutputCount - count
				items = append(items, part...)
				if len(snapshot.Units) == 1 {
					complete = data
					snapshot.UpstreamID = out.UpstreamID
				}
			case "rejected", "not_attempted":
				u.ActualCount = 0
				u.ResultHash = ""
				u.Status = "failed"
				u.Error = out.State
				snapshot.FailedCount += u.OutputCount
			case studioImageNoCharge502:
				if out.HTTPFailure == nil || !out.HTTPFailure.NoChargeFinal || out.HTTPFailure.Status != 502 || len(out.Data) != 0 {
					return ErrStudioImageConflict
				}
				u.ActualCount = 0
				u.ResultHash = ""
				u.Status = "failed"
				u.Error = out.State
				snapshot.FailedCount += u.OutputCount
			default:
				return nil
			}
		}
		if snapshot.DeliveredCount == 0 {
			return nil
		}
		if len(snapshot.Units) != 1 {
			var err error
			complete, err = json.Marshal(struct {
				Data []json.RawMessage `json:"data"`
			}{items})
			if err != nil {
				return err
			}
		}
		if existing, err := s.readOriginalCopy("result", r.TaskID); err == nil {
			if HashUsageRequestPayload(existing) != HashUsageRequestPayload(complete) {
				return ErrStudioImageConflict
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	snapshot.ResultHash = HashUsageRequestPayload(complete)
	if r.ResultHash != "" && r.ResultHash != snapshot.ResultHash {
		return ErrStudioImageConflict
	}
	rec.ImageProof = imageRetentionProof(&snapshot)
	return s.saveRetention(*rec)
}

package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
)

// Transport/server errors do not prove that a supplier rejected execution.
// Only explicit client rejections terminate a unit; neither case permits replay.
type StudioImageUpstreamError struct {
	Status    int
	RequestID string
}

func (e *StudioImageUpstreamError) Error() string {
	return "upstream image response requires receipt reconciliation"
}
func (e *StudioImageUpstreamError) Unwrap() error { return ErrStudioImageUnknown }
func (e *StudioImageUpstreamError) rejected() bool {
	return e.Status == 400 || e.Status == 401 || e.Status == 403 || e.Status == 404 || e.Status == 422 || e.Status == 429
}

// One immutable response envelope per claimed unit. Save this before parsing
// image bytes, so a result-store/fsync failure can recover the original response.
type studioImageUnitOutcome struct {
	ID          string `json:"id"`
	PayloadHash string `json:"payload_hash"`
	UpstreamID  string `json:"upstream_id"`
	State       string `json:"state"`
	Data        []byte `json:"data,omitempty"`
}

func (s *StudioImageStore) writeUnitOutcome(u StudioImageUnitReceipt, state string, data []byte, id string) error {
	b, err := json.Marshal(studioImageUnitOutcome{u.ID, u.PayloadHash, id, state, data})
	if err != nil {
		return err
	}
	return s.write(s.path("unit-response", u.ID), b, false)
}

func imageExecutionUnits(q StudioImageQuote, taskID, prompt string, references []string) ([]StudioImageUnitReceipt, [][]byte, []byte, error) {
	if q.Execution == nil || q.BindingHash != studioQuoteHash(q) {
		return nil, nil, nil, ErrStudioImageConflict
	}
	expected, err := mediaworkbench.PublishedImageExecution(q.Binding)
	if err != nil || expected.Mode == mediaworkbench.ImageExecutionProviderAsync || studioHash(expected) != studioHash(*q.Execution) {
		return nil, nil, nil, ErrStudioImageConflict
	}
	plan, err := mediaworkbench.CompilePublishedImagePlan(q.Binding, prompt, references)
	if err != nil {
		return nil, nil, nil, err
	}
	units := make([]StudioImageUnitReceipt, len(expected.Units))
	bodies := make([][]byte, len(units))
	for i, u := range expected.Units {
		p, e := mediaworkbench.CompilePublishedImagePlanForCount(q.Binding, prompt, references, u.OutputCount)
		if e != nil {
			return nil, nil, nil, e
		}
		bodies[i] = p.MaterializeJSON()
		units[i] = StudioImageUnitReceipt{ID: studioHash([]any{taskID, q.BindingHash, i}), Index: i, OutputOffset: u.OutputOffset, OutputCount: u.OutputCount, Endpoint: p.Path, PayloadHash: HashUsageRequestPayload(bodies[i]), Status: "pending"}
	}
	return units, bodies, plan.MaterializeJSON(), nil
}

func (r *StudioImageRuntime) dispatchExecution(ctx context.Context, c *gin.Context, q StudioImageQuote, taskID, prompt string, references []string, key *APIKey) (*StudioImageReceipt, error) {
	if !r.Enabled() {
		return nil, errors.New("published image paid gate off")
	}
	if !studioImageTaskID.MatchString(taskID) || !studioGroupAllows(key, q.Binding.Offer.SiteModel) || key.ID != q.Owner.APIKeyID || key.UserID != q.Owner.UserID || key.GroupID == nil || *key.GroupID != q.Owner.GroupID {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	units, bodies, body, err := imageExecutionUnits(q, taskID, prompt, references)
	if err != nil {
		return nil, err
	}
	requestHash := studioHash(struct {
		Prompt     string
		References []string
		Spec       mediaworkbench.Spec
	}{prompt, references, q.Binding.Spec})
	if old, e := r.Store.Receipt(taskID, q.Owner); e == nil {
		if old.Quote.BindingHash != q.BindingHash || old.RequestHash != requestHash || old.PayloadHash != HashUsageRequestPayload(body) {
			return nil, ErrStudioImageConflict
		}
		return r.Recover(ctx, taskID, q.Owner)
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if !time.Now().Before(q.ExpiresAt) || time.Now().Before(q.CreatedAt) || (key.Quota > 0) != q.KeyQuotaEnabled || key.HasRateLimits() != q.KeyRateEnabled || key.Group.IsSubscriptionType() != (q.SubscriptionID != nil) {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	a, release, err := r.Core.SelectQuotedImageAccount(ctx, q, r.Media, true)
	if err != nil {
		return nil, err
	}
	defer release()
	if q.Accounting.Validate(q) != nil || (a.HasAnyQuotaLimit() && !q.AccountQuotaEnabled) {
		return nil, ErrStudioImageAccounting
	}
	receipt, first, err := r.Store.Claim(StudioImageReceipt{Version: StudioImageMultiReceiptVersion, TaskID: taskID, Quote: q, Request: body, PayloadHash: HashUsageRequestPayload(body), RequestHash: requestHash, Endpoint: units[0].Endpoint, Execution: *q.Execution, Units: units, ExpectedCount: q.Binding.Spec.Count, PendingCount: q.Binding.Spec.Count})
	if err != nil {
		return nil, err
	}
	if !first {
		return r.Recover(ctx, taskID, q.Owner)
	}
	// The original invocation alone dispatches. Unit claims survive crashes and
	// remain permanent, independently of result or settlement status.
	for i, u := range units {
		if err = r.Store.write(r.Store.path("unit-claim", u.ID), []byte(u.PayloadHash), true); err != nil {
			return receipt, ErrStudioImageUnknown
		}
		data, id, callErr := r.network(ctx, c, a, bodies[i], u.Endpoint)
		state := "response"
		if callErr != nil {
			state = "unknown"
			var rejected *StudioImageUpstreamError
			if errors.As(callErr, &rejected) && rejected.rejected() {
				state = "rejected"
			}
		}
		if err = r.Store.writeUnitOutcome(u, state, data, id); err != nil {
			return receipt, err
		}
		_, count, validationErr := studioExecutionResult(data, u.OutputCount)
		if state != "response" || validationErr != nil || count != u.OutputCount {
			// Unstarted units were never charged. Do not create replacement or
			// compensating supplier requests after this unit's failure/ambiguity.
			for _, rest := range units[i+1:] {
				if err = r.Store.writeUnitOutcome(rest, "not_attempted", nil, ""); err != nil {
					return receipt, err
				}
			}
			break
		}
	}
	return r.Recover(ctx, taskID, q.Owner)
}

func studioExecutionResult(data []byte, expected int) ([]json.RawMessage, int, error) {
	var payload struct {
		Data []json.RawMessage `json:"data"`
	}
	if len(data) > 32<<20 || json.Unmarshal(data, &payload) != nil || payload.Data == nil || len(payload.Data) > expected {
		return nil, 0, ErrStudioImageUnknown
	}
	if len(payload.Data) == 0 {
		return payload.Data, 0, nil
	}
	if _, err := ValidateStudioImageResult(data, len(payload.Data)); err != nil {
		return nil, 0, ErrStudioImageUnknown
	}
	return payload.Data, len(payload.Data), nil
}

func (r *StudioImageRuntime) recoverExecution(ctx context.Context, receipt *StudioImageReceipt) (*StudioImageReceipt, error) {
	if receipt.Quote.Execution == nil || studioHash(receipt.Execution) != studioHash(*receipt.Quote.Execution) || len(receipt.Units) != len(receipt.Execution.Units) {
		return nil, ErrStudioImageConflict
	}
	if receipt.BillingState == "billed" {
		_, err := r.Store.Result(receipt)
		return receipt, err
	}
	receipt.DeliveredCount, receipt.FailedCount, receipt.PendingCount = 0, 0, 0
	var results []json.RawMessage
	var single []byte
	allResponses := true
	for i := range receipt.Units {
		u := &receipt.Units[i]
		plan := receipt.Execution.Units[i]
		if u.ID != studioHash([]any{receipt.TaskID, receipt.Quote.BindingHash, i}) || u.Index != i || u.OutputOffset != plan.OutputOffset || u.OutputCount != plan.OutputCount {
			return nil, ErrStudioImageConflict
		}
		var outcome studioImageUnitOutcome
		err := studioRead(r.Store.path("unit-response", u.ID), &outcome)
		if os.IsNotExist(err) {
			allResponses = false
			u.Status = "pending"
			receipt.PendingCount += u.OutputCount
			continue
		}
		if err != nil || outcome.ID != u.ID || outcome.PayloadHash != u.PayloadHash {
			return receipt, ErrStudioImageUnknown
		}
		u.UpstreamID = outcome.UpstreamID
		u.ActualCount = 0
		switch outcome.State {
		case "not_attempted", "rejected":
			u.Status, u.Error = "failed", outcome.State
			receipt.FailedCount += u.OutputCount
		case "response":
			items, count, e := studioExecutionResult(outcome.Data, u.OutputCount)
			if e != nil {
				u.Status, u.Error = "unknown", "invalid_result"
				receipt.PendingCount += u.OutputCount
				continue
			}
			u.ActualCount = count
			u.ResultHash = HashUsageRequestPayload(outcome.Data)
			u.Status = "persisted"
			results = append(results, items...)
			receipt.DeliveredCount += count
			receipt.FailedCount += u.OutputCount - count
			single = outcome.Data
		case "unknown":
			u.Status = "unknown"
			receipt.PendingCount += u.OutputCount
		default:
			return receipt, fmt.Errorf("%w: invalid execution response", ErrStudioImageConflict)
		}
	}
	// While the original dispatcher is advancing it owns only response files.
	// Recovery never rewrites a partly advanced parent snapshot or submits I/O.
	if !allResponses || receipt.PendingCount > 0 {
		receipt.Status = "unknown"
		return receipt, ErrStudioImageUnknown
	}
	if receipt.DeliveredCount == 0 {
		receipt.Status, receipt.BillingState = "failed", "not_charged"
		return receipt, r.Store.Save(receipt)
	}
	combined, err := json.Marshal(struct {
		Data []json.RawMessage `json:"data"`
	}{results})
	if err != nil {
		return receipt, err
	}
	if len(receipt.Units) == 1 {
		combined = single
		receipt.UpstreamID = receipt.Units[0].UpstreamID
	}
	if err = r.Store.PersistResult(receipt, combined); err != nil {
		return receipt, err
	}
	return r.settle(ctx, receipt)
}

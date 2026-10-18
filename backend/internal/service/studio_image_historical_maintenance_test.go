package service

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Exercise the offline maintenance transform against the actual 4f10 store,
// recovery, permanent dispatch claims and native billing guards. No supplier.
func TestStudioHistorical502Maintenance(t *testing.T) {
	r, q, key, _, billing := studioContractFixture(t, "https://api.image2pro.top/v1")
	plan, planErr := mediaworkbench.PublishedImageExecution(q.Binding)
	require.NoError(t, planErr)
	q.Execution = &plan
	q.BindingHash = studioQuoteHash(q)
	calls := 0
	r.network = func(context.Context, *gin.Context, *Account, []byte, string) ([]byte, string, error) {
		calls++
		return nil, "", &StudioImageUpstreamError{Status: 502}
	}
	receipt, err := r.Dispatch(context.Background(), nil, q, "historical-maintenance", "fixture", nil, key)
	require.ErrorIs(t, err, ErrStudioImageUnknown)
	require.Len(t, receipt.Units, 1)
	// Preserve a stale in-flight read to prove it cannot settle after the change.
	stale, err := r.Store.Receipt(receipt.TaskID, q.Owner)
	require.NoError(t, err)
	beforeClaim, err := os.ReadFile(r.Store.path("task", receipt.TaskID) + ".sync-dispatch")
	require.NoError(t, err)
	var outcome studioImageUnitOutcome
	require.NoError(t, studioRead(r.Store.path("unit-response", receipt.Units[0].ID), &outcome))
	journal := map[string]any{"task_id": receipt.TaskID, "owner": q.Owner.UserID, "keyRef": q.Owner.APIKeyID,
		"status": "unknown", "billing_state": "pending", "quote": map[string]any{"spec": q.Binding.Spec}, "results": []any{}}
	input, err := json.Marshal(map[string]any{"receipt": receipt, "outcome": outcome, "journal": journal})
	require.NoError(t, err)
	python := "python3"
	if runtime.GOOS == "windows" {
		python = "python"
	}
	cmd := exec.Command(python, "../../../tools/maintenance/historical_image_502.py")
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", output)
	var changed struct {
		Receipt json.RawMessage `json:"receipt"`
		Outcome json.RawMessage `json:"outcome"`
	}
	require.NoError(t, json.Unmarshal(output, &changed))
	// Unit envelope commits first; recovery must safely finish after interruption.
	require.NoError(t, r.Store.write(r.Store.path("unit-response", receipt.Units[0].ID), changed.Outcome, false))
	got, err := r.recoverExecution(context.Background(), stale)
	require.NoError(t, err)
	require.Equal(t, "not_charged", got.BillingState)
	require.NoError(t, r.Store.write(r.Store.path("task", receipt.TaskID), changed.Receipt, false))
	restarted := *r
	restarted.Store = NewStudioImageStore(r.Store.Root)
	for range 3 {
		got, err = restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
		require.NoError(t, err)
		require.Equal(t, "failed", got.Status)
		require.Equal(t, "not_charged", got.BillingState)
		require.Equal(t, studioImageNoCharge502, StudioImageFailureCode(got))
		require.Empty(t, got.Units[0].HTTPFailure.ResponseHash)
	}
	_, err = restarted.Dispatch(context.Background(), nil, q, receipt.TaskID, "fixture", nil, key)
	require.NoError(t, err)
	require.Equal(t, 1, calls)
	late := studioResultN(t, 1)
	require.ErrorIs(t, restarted.Store.writeUnitOutcome(got.Units[0], "response", late, "late"), ErrStudioImageConflict)
	require.ErrorIs(t, restarted.Store.PersistResult(got, late), ErrStudioImageConflict)
	_, err = SettleQuotedImage(context.Background(), billing, got)
	require.Error(t, err)
	// Even an injected late raw response cannot revive a finalized parent.
	require.NoError(t, os.WriteFile(r.Store.path("upstream", receipt.TaskID), late, 0600))
	got, err = restarted.Recover(context.Background(), receipt.TaskID, q.Owner)
	require.NoError(t, err)
	require.Equal(t, "not_charged", got.BillingState)
	require.Zero(t, billing.calls)
	afterClaim, err := os.ReadFile(r.Store.path("task", receipt.TaskID) + ".sync-dispatch")
	require.NoError(t, err)
	require.Equal(t, beforeClaim, afterClaim)
	_, err = restarted.Recover(context.Background(), receipt.TaskID, StudioImageOwner{99, 2, 3})
	require.Error(t, err)
}

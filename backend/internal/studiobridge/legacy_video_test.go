package studiobridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type legacyOrders struct {
	service.StudioVideoOrderRepository
	order    service.StudioVideoOrder
	captures int
	releases int
}

func (f *legacyOrders) ReleaseStudioVideoOrder(_ context.Context, c *service.StudioVideoReleaseCommand) (*service.StudioVideoOrder, error) {
	if c.Binding != nil || c.EvidenceHash == "" || c.Reason == "" {
		return nil, service.ErrStudioVideoConflict
	}
	if f.order.State != "RELEASED" {
		f.releases++
		f.order.State = "RELEASED"
	}
	return &f.order, nil
}

func (f *legacyOrders) GetStudioVideoOrder(_ context.Context, user int64, child string) (*service.StudioVideoOrder, error) {
	if user != f.order.UserID || child != f.order.ChildID {
		return nil, service.ErrStudioVideoNotFound
	}
	return &f.order, nil
}
func (f *legacyOrders) CaptureStudioVideoOrder(_ context.Context, c *service.StudioVideoCaptureCommand) (*service.StudioVideoOrder, error) {
	if c.Binding != nil || c.ActualAmount != f.order.HoldAmount {
		return nil, service.ErrStudioVideoConflict
	}
	if f.order.State != "CAPTURED" {
		f.captures++
		f.order.State = "CAPTURED"
		f.order.SupplierTaskID = c.SupplierTaskID
	}
	return &f.order, nil
}
func TestLegacyVideoExistingLedgerProtocol(t *testing.T) {
	cache := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer func() { _ = rdb.Close() }()
	repo := &legacyOrders{order: service.StudioVideoOrder{ChildID: "op_original_c0", UserID: 1, QuoteID: "original", RequestHash: strings.Repeat("a", 64), HoldAmount: .8, Currency: "USD", State: "HELD"}}
	h, err := NewLegacyVideoRecovery(LegacyVideoOptions{ServiceToken: strings.Repeat("s", 32), Orders: service.NewStudioVideoOrderService(repo), Redis: rdb, Verify: func(_ context.Context, p string) (int64, error) {
		if p == "other" {
			return 2, nil
		}
		if p != "proof" {
			return 0, ErrInvalidBridgeConfig
		}
		return 1, nil
	}})
	require.NoError(t, err)
	call := func(method, path, proof, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-Studio-Service-Token", strings.Repeat("s", 32))
		r.Header.Set("X-Studio-Session-Proof", proof)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, 401, call("GET", LegacyVideoOrdersPath+repo.order.ChildID, "bad", "").Code)
	require.Equal(t, 404, call("GET", LegacyVideoOrdersPath+repo.order.ChildID, "other", "").Code)
	require.Equal(t, 400, call("GET", LegacyVideoOrdersPath+"av_original", "proof", "").Code)
	require.Equal(t, 404, call("POST", VideoPath+"holds", "proof", `{}`).Code)
	require.Equal(t, 409, call("POST", LegacyVideoOrdersPath+repo.order.ChildID+"/capture", "proof", `{}`).Code)
	evidence := legacyVideoEvidence{UserID: 1, ChildID: repo.order.ChildID, RequestHash: repo.order.RequestHash, Status: "completed", SupplierTaskID: "original-task"}
	body, _ := json.Marshal(evidence)
	for i := 0; i < 2; i++ {
		require.Equal(t, 201, call("POST", LegacyVideoEvidencePath, "proof", string(body)).Code)
		require.Equal(t, 200, call("POST", LegacyVideoOrdersPath+repo.order.ChildID+"/capture", "proof", `{}`).Code)
	}
	require.Equal(t, 1, repo.captures)
	evidence.RequestHash = strings.Repeat("b", 64)
	body, _ = json.Marshal(evidence)
	require.Equal(t, 409, call("POST", LegacyVideoEvidencePath, "proof", string(body)).Code)
	require.Equal(t, 200, call(http.MethodGet, LegacyVideoOrdersPath+repo.order.ChildID, "proof", "").Code)
	for _, status := range []string{"failed", "not_submitted"} {
		repo.order.ChildID = "op_" + status + "_c0"
		repo.order.State = "HELD"
		evidence = legacyVideoEvidence{UserID: 1, ChildID: repo.order.ChildID, RequestHash: repo.order.RequestHash, Status: status, Reason: "synthetic_failure"}
		if status == "failed" {
			evidence.SupplierTaskID = "original-task"
		}
		body, _ = json.Marshal(evidence)
		for i := 0; i < 2; i++ {
			require.Equal(t, 201, call("POST", LegacyVideoEvidencePath, "proof", string(body)).Code)
			require.Equal(t, 409, call("POST", LegacyVideoOrdersPath+repo.order.ChildID+"/capture", "proof", `{}`).Code)
			require.Equal(t, 200, call("POST", LegacyVideoOrdersPath+repo.order.ChildID+"/release", "proof", `{}`).Code)
		}
	}
	require.Equal(t, 2, repo.releases)
}

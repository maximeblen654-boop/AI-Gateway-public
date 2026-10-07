package studiobridge

// Recovery subset of the existing slot/USD billing bridge. No quote, hold,
// scheduler, migration or new ledger is installed by this handler.
import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/redis/go-redis/v9"
)

const LegacyVideoOrdersPath = VideoPath + "orders/"
const LegacyVideoEvidencePath = VideoPath + "snapshots/evidence"

type LegacyVideoOptions struct {
	ServiceToken string
	Verify       func(context.Context, string) (int64, error)
	Orders       *service.StudioVideoOrderService
	Redis        *redis.Client
}

type legacyVideoEvidence struct {
	UserID         int64  `json:"userId"`
	ChildID        string `json:"childId"`
	RequestHash    string `json:"requestHash"`
	Status         string `json:"status"`
	SupplierTaskID string `json:"supplierTaskId"`
	Reason         string `json:"reason"`
	Hash           string `json:"hash"`
}

var legacyVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var legacyVideoHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func NewLegacyVideoRecovery(opts LegacyVideoOptions) (http.Handler, error) {
	if len(opts.ServiceToken) < 32 || opts.Verify == nil || opts.Orders == nil || opts.Redis == nil {
		return nil, ErrInvalidBridgeConfig
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		fail := func(status int, reason string) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
		}
		want, got := sha256.Sum256([]byte(opts.ServiceToken)), sha256.Sum256([]byte(r.Header.Get("X-Studio-Service-Token")))
		if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
			fail(401, "unauthorized_service")
			return
		}
		uid, err := opts.Verify(r.Context(), r.Header.Get("X-Studio-Session-Proof"))
		// Retain the original service-authenticated recovery worker protocol.
		if r.Header.Get("X-Studio-Session-Proof") == "" {
			uid, err = strconv.ParseInt(r.Header.Get("X-Studio-Owner-Id"), 10, 64)
		}
		if err != nil || uid <= 0 {
			fail(401, "invalid_session")
			return
		}
		if r.URL.RawQuery != "" {
			fail(400, "invalid_path")
			return
		}
		var evidence legacyVideoEvidence
		var child, action string
		register := r.URL.Path == LegacyVideoEvidencePath
		if register {
			if r.Method != http.MethodPost {
				fail(405, "method_not_allowed")
				return
			}
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
			dec.DisallowUnknownFields()
			if dec.Decode(&evidence) != nil || dec.Decode(new(any)) != io.EOF || evidence.UserID != uid || !legacyVideoHash.MatchString(evidence.RequestHash) ||
				(evidence.Status != "completed" && evidence.Status != "failed" && evidence.Status != "not_submitted") ||
				(evidence.Status == "completed" && !legacyVideoID.MatchString(evidence.SupplierTaskID)) ||
				(evidence.Status == "not_submitted" && evidence.SupplierTaskID != "") ||
				(evidence.Status != "completed" && strings.TrimSpace(evidence.Reason) == "") {
				fail(400, "invalid_evidence_snapshot")
				return
			}
			child = evidence.ChildID
		} else {
			if !strings.HasPrefix(r.URL.Path, LegacyVideoOrdersPath) {
				fail(404, "not_found")
				return
			}
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, LegacyVideoOrdersPath), "/")
			if len(parts) < 1 || len(parts) > 2 {
				fail(404, "not_found")
				return
			}
			child = parts[0]
			if len(parts) == 2 {
				action = parts[1]
			}
			if action == "" && r.Method != http.MethodGet || action != "" && (r.Method != http.MethodPost || action != "capture" && action != "release") {
				fail(405, "method_not_allowed")
				return
			}
		}
		if !legacyVideoID.MatchString(child) || !strings.HasPrefix(child, "op_") {
			fail(400, "legacy_identity_required")
			return
		}
		order, err := opts.Orders.Get(r.Context(), uid, child)
		if err != nil {
			if errors.Is(err, service.ErrStudioVideoNotFound) {
				fail(404, "order_not_found")
			} else {
				fail(503, "billing_unavailable")
			}
			return
		}
		if order.Currency != "USD" {
			fail(409, "legacy_identity_required")
			return
		}
		key := "studio:video:evidence:" + child
		if register {
			if order.RequestHash != evidence.RequestHash {
				fail(409, "evidence_unconfirmed")
				return
			}
			h := sha256.Sum256([]byte(child + "\x00" + evidence.RequestHash + "\x00" + evidence.Status + "\x00" + evidence.SupplierTaskID + "\x00" + evidence.Reason))
			evidence.Hash = hex.EncodeToString(h[:])
			encoded, _ := json.Marshal(evidence)
			created, storeErr := opts.Redis.SetNX(r.Context(), key, encoded, 7*24*time.Hour).Result()
			if storeErr != nil {
				fail(503, "snapshot_store_unavailable")
				return
			}
			if !created {
				old, e := opts.Redis.Get(r.Context(), key).Bytes()
				if e != nil || string(old) != string(encoded) {
					fail(409, "snapshot_conflict")
					return
				}
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		if action != "" {
			data, e := opts.Redis.Get(r.Context(), key).Bytes()
			if e != nil || json.Unmarshal(data, &evidence) != nil || evidence.UserID != uid || evidence.ChildID != child || evidence.RequestHash != order.RequestHash || !legacyVideoHash.MatchString(evidence.Hash) {
				fail(409, "evidence_unconfirmed")
				return
			}
			if action == "capture" {
				if evidence.Status != "completed" || !legacyVideoID.MatchString(evidence.SupplierTaskID) {
					fail(409, "evidence_unconfirmed")
					return
				}
				order, err = opts.Orders.Capture(r.Context(), &service.StudioVideoCaptureCommand{ChildID: child, UserID: uid, ActualAmount: order.HoldAmount, SupplierTaskID: evidence.SupplierTaskID, EvidenceHash: evidence.Hash})
			} else {
				if evidence.Status != "failed" && evidence.Status != "not_submitted" || strings.TrimSpace(evidence.Reason) == "" {
					fail(409, "evidence_unconfirmed")
					return
				}
				order, err = opts.Orders.Release(r.Context(), &service.StudioVideoReleaseCommand{ChildID: child, UserID: uid, Reason: evidence.Reason, EvidenceHash: evidence.Hash})
			}
			if err != nil {
				fail(409, "settlement_unavailable")
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ownerId": order.UserID, "childId": order.ChildID, "quoteId": order.QuoteID, "currency": order.Currency, "amountMinor": int64(math.Round(order.HoldAmount * 100)), "requestHash": order.RequestHash, "receiptId": "hold_" + child, "status": strings.ToLower(order.State), "taskId": order.SupplierTaskID})
	}), nil
}

package studiobridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// Real Node BFF and Go Bridge HTTP transports, with a synthetic Core contract
// server. Native Core persistence/accounting are tested separately with real SQL.
func TestImageBFFBridgeCoreLoopbackRecovery(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for the cross-language contract test")
	}
	var mu sync.Mutex
	posts, reads := 0, 0
	taskID := ""
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer synthetic-customer-key" || r.Header.Get("X-Studio-Binding-Contract") != mediaworkbench.ImageBindingVersion {
			t.Error("Core credential/version mismatch")
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/studio/images/quotes":
			_ = json.NewEncoder(w).Encode(map[string]any{"contract": mediaworkbench.ImageBindingVersion, "quote_token": strings.Repeat("a", 64), "spec": map[string]int{"count": 1, "images": 0}, "sale_price": map[string]string{"amount": "0.80", "currency": "CNY", "billing_mode": "per_request"}, "expires_at": time.Now().Add(time.Minute).UTC()})
		case r.Method == "POST" && r.URL.Path == "/v1/studio/images/tasks":
			var body struct {
				TaskID string `json:"task_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			taskID = body.TaskID
			posts++
			// Core completed/persisted but its HTTP response was lost.
			w.WriteHeader(502)
			_, _ = w.Write([]byte(`{"error":"synthetic response loss"}`))
		case r.Method == "GET" && r.URL.Path == "/v1/studio/images/tasks/"+taskID:
			reads++
			_ = json.NewEncoder(w).Encode(map[string]any{"contract": mediaworkbench.ImageBindingVersion, "task_id": taskID, "status": "completed", "billing_state": "billed", "result_available": true})
		case r.Method == "GET" && r.URL.Path == "/v1/studio/images/tasks/"+taskID+"/result":
			reads++
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}`))
		default:
			t.Error("unexpected Core operation", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer core.Close()
	keys := &imageKeys{}
	bridge, err := NewImage(ImageOptions{ServiceToken: strings.Repeat("s", 32), GroupID: 3, CoreURL: core.URL, Keys: keys, Verify: func(_ context.Context, proof string) (int64, error) {
		if proof != "valid-proof" {
			return 0, errors.New("bad proof")
		}
		return 1, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	bridge.enabled = true // inaccessible outside this test/package; production stays hard OFF
	server := httptest.NewServer(bridge)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	probe, err := filepath.Abs(filepath.Join("..", "..", "..", "studio", "bff", "test", "bridge-contract-probe.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.CommandContext(ctx, node, probe, server.URL, t.TempDir()).CombinedOutput()
	if err != nil {
		t.Fatalf("BFF probe: %v: %s", err, out)
	}
	mu.Lock()
	defer mu.Unlock()
	if posts != 1 || reads != 2 || keys.last != 42 || keys.receiptCalls != 2 {
		t.Fatal("recovery replayed or changed key", posts, reads, keys.last, keys.receiptCalls)
	}
	t.Log(string(out))
}

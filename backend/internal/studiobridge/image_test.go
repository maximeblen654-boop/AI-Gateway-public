package studiobridge

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestImageSQLCredentialRecoveryScope(t *testing.T) {
	db, mock, e := sqlmock.New()
	if e != nil {
		t.Fatal(e)
	}
	defer func() { _ = db.Close() }()
	r := SQLImageCredentialReader{DB: db}
	for _, receipt := range []bool{false, true} {
		gate := "k.status='active' AND (k.expires_at IS NULL OR k.expires_at>NOW())"
		if receipt {
			gate = "k.status IN ('active','expired','quota_exhausted')"
		}
		groupGate := "g.status='active' AND g.allow_image_generation=TRUE AND g.platform='openai'"
		if receipt {
			groupGate = "g.status='active' AND g.platform='openai'"
		}
		mock.ExpectQuery("SELECT k.id,k.key .*"+regexp.QuoteMeta(gate)+".*u.status='active'.*"+regexp.QuoteMeta(groupGate)).WithArgs(int64(1), int64(3), int64(42)).WillReturnRows(sqlmock.NewRows([]string{"id", "key"}).AddRow(42, "synthetic-only"))
		var k ImageCredential
		if receipt {
			k, e = r.ResolveReceipt(context.Background(), 1, 3, 42)
		} else {
			k, e = r.Resolve(context.Background(), 1, 3, 42)
		}
		if e != nil || k.ID != 42 {
			t.Fatal(k, e)
		}
	}
	if _, e = r.ResolveReceipt(context.Background(), 1, 3, 0); e == nil {
		t.Fatal("recovery selected another key")
	}
	if e = mock.ExpectationsWereMet(); e != nil {
		t.Fatal(e)
	}
}

type imageKeys struct {
	calls        int
	last         int64
	receiptCalls int
}

func (k *imageKeys) ResolveReceipt(ctx context.Context, user, group, key int64) (ImageCredential, error) {
	k.receiptCalls++
	if key <= 0 {
		return ImageCredential{}, errors.New("original key required")
	}
	return k.Resolve(ctx, user, group, key)
}

func (k *imageKeys) Resolve(_ context.Context, user, group, key int64) (ImageCredential, error) {
	k.calls++
	k.last = key
	if user != 1 || group != 3 || key != 0 && key != 42 {
		return ImageCredential{}, errors.New("wrong identity")
	}
	return ImageCredential{42, "synthetic-customer-key"}, nil
}
func TestImageBridgeContractAndFrozenKeyGET(t *testing.T) {
	calls := 0
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer synthetic-customer-key" || r.Header.Get("X-Studio-Binding-Contract") != mediaworkbench.ImageBindingVersion {
			t.Error("credential/contract mismatch")
		}
		if r.Method != http.MethodGet || r.URL.Path != "/v1/studio/images/tasks/known-original" {
			t.Error("recovery replayed POST")
		}
		_, _ = w.Write([]byte(`{"contract":"published_image_binding_v1","task_id":"known-original","status":"unknown","billing_state":"pending"}`))
	}))
	defer core.Close()
	keys := &imageKeys{}
	opts := ImageOptions{ServiceToken: strings.Repeat("s", 32), GroupID: 3, CoreURL: core.URL, Keys: keys, Verify: func(_ context.Context, proof string) (int64, error) {
		if proof != "valid-proof" {
			return 0, errors.New("bad proof")
		}
		return 1, nil
	}}
	bridge, e := NewImage(opts)
	if e != nil {
		t.Fatal(e)
	}
	request := func(method, path, token, proof, contract, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, ImagePath+path, strings.NewReader(`{"key_ref":42,"payload":{}}`))
		req.Header.Set("X-Studio-Service-Token", token)
		req.Header.Set("X-Studio-Session-Proof", proof)
		req.Header.Set("X-Studio-Binding-Contract", contract)
		req.Header.Set("X-Studio-Key-Ref", key)
		out := httptest.NewRecorder()
		bridge.ServeHTTP(out, req)
		return out
	}
	out := request("GET", "tasks/known-original", opts.ServiceToken, "valid-proof", mediaworkbench.ImageBindingVersion, "42")
	if out.Code != 200 || keys.last != 42 || calls != 1 || keys.receiptCalls != 1 {
		t.Fatal(out.Code, out.Body.String())
	}
	for _, tc := range []struct {
		name, method, path, token, proof, version, key string
		status                                         int
	}{
		{"service_auth", "GET", "catalog", "wrong", "valid-proof", mediaworkbench.ImageBindingVersion, "", 401},
		{"session_auth", "GET", "catalog", opts.ServiceToken, "bad", mediaworkbench.ImageBindingVersion, "", 401},
		{"version_drift", "GET", "catalog", opts.ServiceToken, "valid-proof", "old", "", 409},
		{"missing_original_key", "GET", "tasks/known-original", opts.ServiceToken, "valid-proof", mediaworkbench.ImageBindingVersion, "", 400},
		{"cross_key", "GET", "tasks/known-original", opts.ServiceToken, "valid-proof", mediaworkbench.ImageBindingVersion, "99", 403},
		{"unknown_path", "GET", "video/tasks", opts.ServiceToken, "valid-proof", mediaworkbench.ImageBindingVersion, "", 404},
		{"paid_hard_off", "POST", "tasks", opts.ServiceToken, "valid-proof", mediaworkbench.ImageBindingVersion, "42", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls
			reply := request(tc.method, tc.path, tc.token, tc.proof, tc.version, tc.key)
			if reply.Code != tc.status || calls != before {
				t.Fatal(reply.Code, reply.Body.String(), "core calls", calls-before)
			}
		})
	}
	t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", "true")
	t.Setenv("STUDIO_IMAGE_BFF_AT_MOST_ONCE_ACK", "true")
	fresh, e := NewImage(opts)
	if e != nil || fresh.enabled {
		t.Fatal("environment enabled paid Bridge")
	}
}

type imageUsers struct{ user service.User }

func (u *imageUsers) GetByID(context.Context, int64) (*service.User, error) { return &u.user, nil }
func TestImageStudioTicketNativeRevocation(t *testing.T) {
	cache := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: cache.Addr()})
	defer func() { _ = rdb.Close() }()
	ctx := context.Background()
	users := &imageUsers{user: service.User{ID: 1, Status: service.StatusActive, TokenVersion: 7}}
	tickets := NewStudioTicketService(rdb, users)
	record, _ := json.Marshal(service.RefreshTokenData{UserID: 1, FamilyID: "family", ExpiresAt: time.Now().Add(time.Hour)})
	if e := cache.Set("refresh_token:hash", string(record)); e != nil {
		t.Fatal(e)
	}
	if _, e := cache.SAdd("token_family:family", "hash"); e != nil {
		t.Fatal(e)
	}
	ticket, e := tickets.Issue(ctx, 1, "family", time.Now().Unix(), time.Now().Add(time.Hour).Unix())
	if e != nil {
		t.Fatal(e)
	}
	identity, e := tickets.Consume(ctx, ticket)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tickets.Consume(ctx, ticket); e == nil {
		t.Fatal("ticket consumed twice")
	}
	if _, e = tickets.Verify(ctx, identity.SessionProof); e != nil {
		t.Fatal(e)
	}
	cache.Del("refresh_token:hash")
	if _, e = tickets.Verify(ctx, identity.SessionProof); e == nil {
		t.Fatal("native revocation ignored")
	}
}

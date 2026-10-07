// Package studiobridge contains the deliberately small HTTP surface used by
// Image Studio to exchange short-lived identity tickets with Sub2API.
//
// The package does not import the server router or any application wire set.
// A caller supplies the already configured AuthService, a read-only user
// reader, and a Redis client. This keeps the bridge independent from pricing,
// dashboard, and other Sub2API workers.
package studiobridge

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/redis/go-redis/v9"
)

const (
	IssuePath   = "/api/v1/auth/studio-ticket"
	ConsumePath = "/api/v1/internal/studio/tickets/consume"
	VerifyPath  = "/api/v1/internal/studio/sessions/verify"

	maxJSONBodyBytes = 4 << 10
)

var (
	ErrInvalidBridgeConfig = errors.New("invalid studio bridge configuration")
	ErrInvalidServiceToken = errors.New("invalid studio bridge service token")
)

// UserReader is the only database capability required by the bridge. Its
// implementation must perform a read-only lookup and return the same
// token-version fingerprint used by the main authentication service.
type UserReader interface {
	GetByID(ctx context.Context, id int64) (*service.User, error)
}

// Options are the complete dependency boundary for a bridge instance.
type Options struct {
	Auth         *service.AuthService
	Users        UserReader
	Redis        *redis.Client
	ServiceToken string
}

// Bridge exposes only the three Studio identity endpoints. No route is
// registered for general Sub2API APIs.
type Bridge struct {
	auth         *service.AuthService
	users        UserReader
	tickets      *StudioTicketService
	serviceToken string
}

// New constructs a bridge without opening a database, running migrations, or
// starting any worker. The caller owns the supplied Redis client and user
// reader.
func New(opts Options) (*Bridge, error) {
	serviceToken := strings.TrimSpace(opts.ServiceToken)
	if opts.Auth == nil || opts.Users == nil || opts.Redis == nil || len(serviceToken) < 32 {
		return nil, ErrInvalidBridgeConfig
	}
	return &Bridge{
		auth:         opts.Auth,
		users:        opts.Users,
		tickets:      NewStudioTicketService(opts.Redis, opts.Users),
		serviceToken: serviceToken,
	}, nil
}

// Handler returns a standard-library handler so the bridge can run without
// importing the full Gin router and its middleware graph.
func (b *Bridge) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(IssuePath, b.handleIssue)
	mux.HandleFunc(ConsumePath, b.handleConsume)
	mux.HandleFunc(VerifyPath, b.handleVerify)
	mux.HandleFunc("/health", b.handleHealth)
	return mux
}

// VerifySession lets the isolated billing handler reuse the same Redis-backed
// session proof validation without exposing the ticket service itself.
func (b *Bridge) VerifySession(ctx context.Context, proof string) (int64, error) {
	identity, err := b.tickets.Verify(ctx, strings.TrimSpace(proof))
	if err != nil || identity == nil || identity.UserID <= 0 {
		return 0, errors.New("invalid studio session")
	}
	return identity.UserID, nil
}

func (b *Bridge) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeSuccess(w, map[string]string{"status": "ok"})
}

type apiResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type issueResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expires_in"`
	Purpose   string `json:"purpose"`
}

type consumeRequest struct {
	Ticket string `json:"ticket"`
}

type verifyRequest struct {
	SessionProof string `json:"session_proof"`
}

func (b *Bridge) handleIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	claims, _, err := b.authenticate(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Invalid token")
		return
	}

	ticket, err := b.tickets.Issue(
		r.Context(),
		claims.UserID,
		claims.SessionID,
		claims.IssuedAt.Unix(),
		claims.ExpiresAt.Unix(),
	)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Studio ticket unavailable")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeSuccess(w, issueResponse{
		Ticket:    ticket,
		ExpiresIn: int(StudioTicketTTL / time.Second),
		Purpose:   "image-studio",
	})
}

func (b *Bridge) handleConsume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !b.authorizeService(r) {
		writeError(w, http.StatusUnauthorized, "Unauthorized service")
		return
	}

	var req consumeRequest
	if !decodeJSON(w, r, &req) || strings.TrimSpace(req.Ticket) == "" {
		writeError(w, http.StatusBadRequest, "Invalid ticket request")
		return
	}
	identity, err := b.tickets.Consume(r.Context(), strings.TrimSpace(req.Ticket))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Invalid or expired ticket")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeSuccess(w, identity)
}

func (b *Bridge) handleVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !b.authorizeService(r) {
		writeError(w, http.StatusUnauthorized, "Unauthorized service")
		return
	}

	var req verifyRequest
	if !decodeJSON(w, r, &req) || strings.TrimSpace(req.SessionProof) == "" {
		writeError(w, http.StatusBadRequest, "Invalid session request")
		return
	}
	identity, err := b.tickets.Verify(r.Context(), strings.TrimSpace(req.SessionProof))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Invalid Studio session")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	writeSuccess(w, identity)
}

func (b *Bridge) authenticate(r *http.Request) (*service.JWTClaims, *service.User, error) {
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, nil, service.ErrInvalidToken
	}
	claims, err := b.auth.ValidateToken(parts[1])
	if err != nil || claims == nil || claims.UserID <= 0 || claims.SessionID == "" || claims.IssuedAt == nil || claims.ExpiresAt == nil {
		return nil, nil, service.ErrInvalidToken
	}
	if !claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Unix() <= time.Now().Unix() {
		return nil, nil, service.ErrInvalidToken
	}

	user, err := b.users.GetByID(r.Context(), claims.UserID)
	if err != nil || user == nil || !user.IsActive() || claims.TokenVersion != user.TokenVersion {
		return nil, nil, service.ErrInvalidToken
	}
	return claims, user, nil
}

func (b *Bridge) authorizeService(r *http.Request) bool {
	presented := r.Header.Get("X-Studio-Service-Token")
	if len(presented) != len(b.serviceToken) {
		return false
	}
	want := sha256.Sum256([]byte(b.serviceToken))
	got := sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return false
	}
	return true
}

func writeSuccess(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, apiResponse{Code: 0, Message: "success", Data: data})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, apiResponse{Code: status, Message: message})
}

func writeJSON(w http.ResponseWriter, status int, payload apiResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

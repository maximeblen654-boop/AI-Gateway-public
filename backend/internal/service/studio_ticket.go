package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

const StudioTicketTTL = 45 * time.Second
const StudioProofMaxTTL = 15 * time.Minute
const studioRevocationTTL = 8 * 24 * time.Hour // exceeds the maximum configured access JWT lifetime

var ErrStudioTicketInvalid = errors.New("invalid studio ticket")

type StudioIdentity struct {
	UserID       int64  `json:"user_id"`
	SessionProof string `json:"session_proof,omitempty"`
}

type studioTicketRecord struct {
	Purpose      string `json:"purpose"`
	UserID       int64  `json:"user_id"`
	SessionID    string `json:"session_id"`
	TokenVersion int64  `json:"token_version"`
	UserEpoch    string `json:"user_epoch"`
	SessionEpoch string `json:"session_epoch"`
	ExpiresAt    int64  `json:"expires_at"`
}

// StudioTicketStore preserves the legacy Redis keys and atomic GETDEL contract.
// Transport types stay in the repository, as with the native refresh cache.
type StudioTicketStore interface {
	MGet(context.Context, ...string) ([]any, error)
	Get(context.Context, string) ([]byte, error)
	GetDel(context.Context, string) ([]byte, error)
	Set(context.Context, string, any, time.Duration) error
	Del(context.Context, string) error
}

type StudioTicketService struct {
	redis StudioTicketStore
	users interface {
		GetByID(context.Context, int64) (*User, error)
	}
}

func NewStudioTicketService(rdb StudioTicketStore, users interface {
	GetByID(context.Context, int64) (*User, error)
}) *StudioTicketService {
	return &StudioTicketService{redis: rdb, users: users}
}

func studioTicketKey(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return "studio:ticket:" + hex.EncodeToString(sum[:])
}

func studioUserEpochKey(userID int64) string { return fmt.Sprintf("studio:user-epoch:%d", userID) }
func studioSessionEpochKey(userID int64, sid string) string {
	sum := sha256.Sum256([]byte(sid))
	return fmt.Sprintf("studio:session-epoch:%d:%x", userID, sum[:])
}

func legacyStudioRandom() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *StudioTicketService) epochs(ctx context.Context, userID int64, sid string) (string, string, error) {
	if s == nil || s.redis == nil || sid == "" {
		return "", "", ErrStudioTicketInvalid
	}
	values, err := s.redis.MGet(ctx, studioUserEpochKey(userID), studioSessionEpochKey(userID, sid))
	if err != nil {
		return "", "", err
	}
	u, _ := values[0].(string)
	v, _ := values[1].(string)
	return u, v, nil
}

func (s *StudioTicketService) Issue(ctx context.Context, userID int64, sid string, issuedAt, expiresAt int64) (string, error) {
	if s == nil || s.redis == nil || s.users == nil || userID <= 0 || sid == "" {
		return "", ErrStudioTicketInvalid
	}
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return "", err
	}
	if user == nil || !user.IsActive() {
		return "", ErrStudioTicketInvalid
	}
	u, v, err := s.epochs(ctx, userID, sid)
	if err != nil {
		return "", err
	}
	if v != "" || issuedAt <= 0 || expiresAt <= time.Now().Unix() {
		return "", ErrStudioTicketInvalid
	}
	if u != "" {
		revokedAt, parseErr := strconv.ParseInt(u, 10, 64)
		if parseErr != nil || issuedAt <= revokedAt {
			return "", ErrStudioTicketInvalid
		}
	}
	ticket, err := legacyStudioRandom()
	if err != nil {
		return "", err
	}
	record, err := json.Marshal(studioTicketRecord{Purpose: "video-studio", UserID: userID, SessionID: sid, TokenVersion: user.TokenVersion, UserEpoch: u, SessionEpoch: v, ExpiresAt: expiresAt})
	if err != nil {
		return "", err
	}
	if err := s.redis.Set(ctx, studioTicketKey(ticket), record, StudioTicketTTL); err != nil {
		return "", err
	}
	// A concurrent revocation between the epoch read and SET must not leave a usable ticket.
	currentU, currentV, err := s.epochs(ctx, userID, sid)
	if err != nil || u != currentU || v != currentV {
		_ = s.redis.Del(ctx, studioTicketKey(ticket))
		return "", ErrStudioTicketInvalid
	}
	return ticket, nil
}

func (s *StudioTicketService) Consume(ctx context.Context, ticket string) (*StudioIdentity, error) {
	if s == nil || s.redis == nil || s.users == nil || len(ticket) != 43 {
		return nil, ErrStudioTicketInvalid
	}
	if _, err := base64.RawURLEncoding.DecodeString(ticket); err != nil {
		return nil, ErrStudioTicketInvalid
	}
	// GETDEL is atomic: even a failed downstream validation burns the ticket.
	data, err := s.redis.GetDel(ctx, studioTicketKey(ticket))
	if err != nil {
		return nil, ErrStudioTicketInvalid
	}
	var record studioTicketRecord
	if json.Unmarshal(data, &record) != nil || record.Purpose != "video-studio" || record.UserID <= 0 || record.SessionID == "" || record.ExpiresAt <= time.Now().Unix() {
		return nil, ErrStudioTicketInvalid
	}
	if err := s.validateRecord(ctx, &record); err != nil {
		return nil, err
	}
	proof, err := legacyStudioRandom()
	if err != nil {
		return nil, err
	}
	record.Purpose = "video-studio-session"
	payload, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	ttl := time.Until(time.Unix(record.ExpiresAt, 0))
	if ttl > StudioProofMaxTTL {
		ttl = StudioProofMaxTTL
	}
	if ttl <= 0 || s.redis.Set(ctx, studioProofKey(proof), payload, ttl) != nil {
		return nil, ErrStudioTicketInvalid
	}
	return &StudioIdentity{UserID: record.UserID, SessionProof: proof}, nil
}

func studioProofKey(proof string) string {
	return "studio:proof:" + studioTicketKey(proof)[len("studio:ticket:"):]
}

func (s *StudioTicketService) Verify(ctx context.Context, proof string) (*StudioIdentity, error) {
	if s == nil || s.redis == nil || s.users == nil || len(proof) != 43 {
		return nil, ErrStudioTicketInvalid
	}
	if _, err := base64.RawURLEncoding.DecodeString(proof); err != nil {
		return nil, ErrStudioTicketInvalid
	}
	data, err := s.redis.Get(ctx, studioProofKey(proof))
	if err != nil {
		return nil, ErrStudioTicketInvalid
	}
	var record studioTicketRecord
	if json.Unmarshal(data, &record) != nil || record.Purpose != "video-studio-session" || record.ExpiresAt <= time.Now().Unix() {
		return nil, ErrStudioTicketInvalid
	}
	if err := s.validateRecord(ctx, &record); err != nil {
		return nil, err
	}
	return &StudioIdentity{UserID: record.UserID}, nil
}

func (s *StudioTicketService) validateRecord(ctx context.Context, record *studioTicketRecord) error {
	u, v, err := s.epochs(ctx, record.UserID, record.SessionID)
	if err != nil || u != record.UserEpoch || v != record.SessionEpoch {
		return ErrStudioTicketInvalid
	}
	user, err := s.users.GetByID(ctx, record.UserID)
	if err != nil || user == nil || !user.IsActive() || user.TokenVersion != record.TokenVersion {
		return ErrStudioTicketInvalid
	}
	return nil
}

func (s *StudioTicketService) RevokeSession(ctx context.Context, userID int64, sid string) error {
	if s == nil || s.redis == nil || userID <= 0 || sid == "" {
		return ErrStudioTicketInvalid
	}
	epoch, err := legacyStudioRandom()
	if err != nil {
		return err
	}
	return s.redis.Set(ctx, studioSessionEpochKey(userID, sid), epoch, studioRevocationTTL)
}

func (s *StudioTicketService) RevokeUser(ctx context.Context, userID int64) error {
	if s == nil || s.redis == nil || userID <= 0 {
		return ErrStudioTicketInvalid
	}
	return s.redis.Set(ctx, studioUserEpochKey(userID), strconv.FormatInt(time.Now().Unix(), 10), studioRevocationTTL)
}

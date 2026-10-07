package studiobridge

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// SQLUserReader loads only the fields needed for JWT and Studio ticket
// validation. It never exposes a write method and never runs migrations.
type SQLUserReader struct {
	db *sql.DB
}

func NewSQLUserReader(db *sql.DB) *SQLUserReader {
	return &SQLUserReader{db: db}
}

func (r *SQLUserReader) GetByID(ctx context.Context, id int64) (*service.User, error) {
	if r == nil || r.db == nil || id <= 0 {
		return nil, service.ErrUserNotFound
	}

	var user service.User
	err := r.db.QueryRowContext(ctx, `
SELECT id, email, password_hash, status
FROM users
WHERE id = $1 AND deleted_at IS NULL`, id).Scan(
		&user.ID,
		&user.Email,
		&user.PasswordHash,
		&user.Status,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load studio user: %w", err)
	}

	user.TokenVersion = ResolveTokenVersion(user.Email, user.PasswordHash)
	user.TokenVersionResolved = true
	return &user, nil
}

// ResolveTokenVersion mirrors service.resolvedTokenVersion. The current users
// schema has no token_version column, so the legacy integer component is zero;
// changing email or password_hash changes this fingerprint and invalidates
// access JWTs and Studio proofs together.
func ResolveTokenVersion(email, passwordHash string) int64 {
	material := strings.ToLower(strings.TrimSpace(email)) + "\n" + passwordHash
	sum := sha256.Sum256([]byte(material))
	return int64(binary.BigEndian.Uint64(sum[:8]) & 0x7fffffffffffffff)
}

package service

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

var ErrStudioImageUnknown = errors.New("original image dispatch outcome unknown; POST replay disabled")
var ErrStudioImageConflict = errors.New("image task binding conflict")

// StudioImageReceiptVersion retains the existing durable receipt format.
// Readers accept historical v1 and v2 without rewriting their frozen identity.
// Rollback executors must support the file version and the current relay policy.
const StudioImageReceiptVersion = "published_image_receipt_v2"

type StudioImageOwner struct {
	UserID   int64 `json:"user_id"`
	APIKeyID int64 `json:"api_key_id"`
	GroupID  int64 `json:"group_id"`
}
type StudioImageQuote struct {
	ID                    string                            `json:"id"`
	Owner                 StudioImageOwner                  `json:"owner"`
	Binding               mediaworkbench.ResolvedImageOffer `json:"binding"`
	BindingHash           string                            `json:"binding_hash"`
	BaseURL               string                            `json:"base_url"`
	CredentialFingerprint string                            `json:"credential_fingerprint"`
	Accounting            AccountAccountingSnapshot         `json:"account_accounting"`
	CreatedAt             time.Time                         `json:"created_at"`
	ExpiresAt             time.Time                         `json:"expires_at"`
	SubscriptionID        *int64                            `json:"subscription_id,omitempty"`
	KeyQuotaEnabled       bool                              `json:"key_quota_enabled"`
	KeyRateEnabled        bool                              `json:"key_rate_enabled"`
	AccountQuotaEnabled   bool                              `json:"account_quota_enabled"`
	// UnitPrice, Quantity and TotalPrice are populated for new quotes. They are
	// optional so receipts written before quantity pricing was introduced keep
	// their original immutable sale_price semantics during recovery.
	UnitPrice  *mediaworkbench.Price `json:"unit_price,omitempty"`
	Quantity   int                   `json:"quantity,omitempty"`
	TotalPrice *mediaworkbench.Price `json:"total_price,omitempty"`
}

type StudioImageReceipt struct {
	Version      string           `json:"version"`
	TaskID       string           `json:"task_id"`
	Quote        StudioImageQuote `json:"quote"`
	Request      []byte           `json:"request"`
	PayloadHash  string           `json:"payload_hash"`
	RequestHash  string           `json:"request_hash"`
	Endpoint     string           `json:"endpoint"`
	UpstreamID   string           `json:"upstream_id,omitempty"`
	ResultHash   string           `json:"result_hash,omitempty"`
	Status       string           `json:"status"`
	BillingState string           `json:"billing_state"`
}

// One receipt is both the authoritative task and receipt binding. The permanent
// .sync-dispatch claim is independent of mutable status and is never removed.
type StudioImageStore struct {
	Root      string
	mu        sync.Mutex
	writeFile func(string, []byte, bool) error
}

func (s *StudioImageStore) write(path string, b []byte, exclusive bool) error {
	if s.writeFile != nil {
		return s.writeFile(path, b, exclusive)
	}
	return studioWrite(path, b, exclusive)
}

func NewStudioImageStore(root string) *StudioImageStore { return &StudioImageStore{Root: root} }
func studioRandom() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}
func studioHash(v any) string { b, _ := json.Marshal(v); return HashUsageRequestPayload(b) }
func (s *StudioImageStore) path(kind, id string) string {
	return filepath.Join(s.Root, kind+"-"+HashUsageRequestPayload([]byte(id)))
}
func (s *StudioImageStore) init() error {
	if s == nil || strings.TrimSpace(s.Root) == "" {
		return mediaworkbench.ErrRuntimeBinding
	}
	if err := os.MkdirAll(s.Root, 0700); err != nil { //nolint:gosec // G703: protected server root, never a browser path; task names are SHA-256.
		return err
	}
	info, err := os.Lstat(s.Root) //nolint:gosec // G703: same protected server root; reject symlink roots below.
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return ErrStudioImageConflict
	}
	// MkdirAll can create several ancestors. Persist their directory entries as
	// well as the later receipt/claim files, before any external effect.
	for parent := filepath.Dir(filepath.Clean(s.Root)); ; parent = filepath.Dir(parent) {
		if err := studioSyncDir(parent); err != nil {
			return err
		}
		if parent == "." || filepath.Dir(parent) == parent {
			break
		}
	}
	return nil
}

func studioSyncDir(root string) error {
	// Paid activation is Linux-only. Windows is supported for deterministic local
	// tests; it cannot assert durable directory-entry persistence for activation.
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(root) //nolint:gosec // G703: configured private root/ancestors; fsync metadata only, never a browser path.
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}
func studioWrite(path string, data []byte, exclusive bool) error {
	if exclusive {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600) //nolint:gosec // G703: private configured root plus hashed identity, never an input path.
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		return studioSyncDir(filepath.Dir(path))
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".studio-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }() //nolint:gosec // G703: cleanup only the CreateTemp name from the private directory.
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, path); err != nil { //nolint:gosec // G703: private-root temp and hashed destination, never a browser path.
		return err
	}
	return studioSyncDir(filepath.Dir(path))
}
func studioRead(path string, v any) error {
	info, err := os.Lstat(path) //nolint:gosec // G703: private configured root plus hashed identity; reject non-regular entries below.
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrStudioImageConflict
	}
	f, err := os.Open(path) //nolint:gosec // G703: same private hashed path, never a browser path.
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	d := json.NewDecoder(io.LimitReader(f, 40<<20))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return ErrStudioImageConflict
	}
	return nil
}
func (s *StudioImageStore) Issue(q StudioImageQuote) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.init(); err != nil {
		return "", err
	}
	token, err := studioRandom()
	if err != nil {
		return "", err
	}
	id, err := studioRandom()
	if err != nil {
		return "", err
	}
	q.ID = id
	q.BindingHash = studioQuoteHash(q)
	if err := q.Accounting.Validate(q); err != nil {
		return "", err
	}
	if q.CreatedAt.IsZero() || q.ExpiresAt.Sub(q.CreatedAt) <= 0 || q.ExpiresAt.Sub(q.CreatedAt) > 5*time.Minute {
		return "", mediaworkbench.ErrRuntimeBinding
	}
	b, err := json.Marshal(q)
	if err != nil {
		return "", err
	}
	return token, s.write(s.path("quote", token), b, true)
}
func (s *StudioImageStore) Quote(token string, owner StudioImageOwner, now time.Time) (StudioImageQuote, error) {
	var q StudioImageQuote
	if len(token) != 64 {
		return q, mediaworkbench.ErrRuntimeBinding
	}
	if err := studioRead(s.path("quote", token), &q); err != nil {
		return q, mediaworkbench.ErrRuntimeBinding
	}
	if q.BindingHash != studioQuoteHash(q) || q.Owner != owner || !now.Before(q.ExpiresAt) || now.Before(q.CreatedAt) || q.Accounting.Validate(q) != nil {
		return StudioImageQuote{}, mediaworkbench.ErrRuntimeBinding
	}
	return q, nil
}
func (s *StudioImageStore) Claim(r StudioImageReceipt) (*StudioImageReceipt, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.init(); err != nil {
		return nil, false, err
	}
	if r.TaskID == "" || r.Version != StudioImageReceiptVersion || r.Quote.BindingHash != studioQuoteHash(r.Quote) || r.Quote.Accounting.Validate(r.Quote) != nil || HashUsageRequestPayload(r.Request) != r.PayloadHash {
		return nil, false, ErrStudioImageConflict
	}
	path := s.path("task", r.TaskID)
	old := new(StudioImageReceipt)
	err := studioRead(path, old)
	if err == nil {
		if old.Quote.BindingHash != r.Quote.BindingHash || old.PayloadHash != r.PayloadHash || old.RequestHash != r.RequestHash || old.Quote.Owner != r.Quote.Owner {
			return nil, false, ErrStudioImageConflict
		}
		return old, false, nil
	}
	if !os.IsNotExist(err) {
		return nil, false, err
	}
	r.Status = "unknown"
	r.BillingState = "pending"
	b, err := json.Marshal(r)
	if err != nil {
		return nil, false, err
	}
	// Cross-process races must fail closed. An incomplete receipt or orphan marker
	// is retained for recovery; it never authorizes another POST.
	if err = s.write(path, b, true); err != nil {
		return nil, false, err
	}
	if err = s.write(path+".sync-dispatch", []byte(r.Quote.BindingHash+"|"+r.PayloadHash), true); err != nil {
		return nil, false, err
	}
	return &r, true, nil
}
func (s *StudioImageStore) Save(r *StudioImageReceipt) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return s.write(s.path("task", r.TaskID), b, false)
}
func (s *StudioImageStore) Receipt(taskID string, owner StudioImageOwner) (*StudioImageReceipt, error) {
	r := new(StudioImageReceipt)
	if err := studioRead(s.path("task", taskID), r); err != nil {
		return nil, err
	}
	if r.TaskID != taskID || r.Quote.Owner != owner || (r.Version != mediaworkbench.ImageBindingVersion && r.Version != StudioImageReceiptVersion) || r.PayloadHash != HashUsageRequestPayload(r.Request) || r.Quote.BindingHash != studioQuoteHash(r.Quote) || r.Quote.Accounting.Validate(r.Quote) != nil {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	return r, nil
}

func studioQuoteHash(q StudioImageQuote) string { q.BindingHash = ""; return studioHash(q) }
func (s *StudioImageStore) PersistResult(r *StudioImageReceipt, data []byte) error {
	if _, err := validateStudioImageReceiptResult(r, data); err != nil {
		return err
	}
	if err := s.write(s.path("result", r.TaskID), data, false); err != nil {
		return err
	}
	r.ResultHash = HashUsageRequestPayload(data)
	r.Status = "persisted"
	return s.Save(r)
}
func (s *StudioImageStore) Result(r *StudioImageReceipt) ([]byte, error) {
	// Read only the hashed original under the configured private root. Root
	// confinement also rejects a result symlink that escapes that directory.
	root, err := os.OpenRoot(s.Root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	b, err := root.ReadFile("result-" + HashUsageRequestPayload([]byte(r.TaskID)))
	if err != nil {
		return nil, err
	}
	if r.ResultHash == "" || HashUsageRequestPayload(b) != r.ResultHash {
		return nil, ErrStudioImageUnknown
	}
	_, err = validateStudioImageReceiptResult(r, b)
	return b, err
}

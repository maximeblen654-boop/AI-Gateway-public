package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

var ErrStudioVideoUnknown = errors.New("original video outcome unknown; generation replay prohibited")

type StudioVideoQuote struct {
	Binding     StudioVideoBinding `json:"binding"`
	BindingHash string             `json:"binding_hash"`
	Plan        videoplan.Plan     `json:"plan"`
}
type StudioVideoTask struct {
	ID        string           `json:"id"`
	TokenHash string           `json:"token_hash"`
	Quote     StudioVideoQuote `json:"quote"`
}
type StudioVideoReferencePreparation struct {
	Accounting            AccountAccountingSnapshot         `json:"account_accounting"`
	FinalQuoteToken       string                            `json:"final_quote_token,omitempty"`
	FinalRequestHash      string                            `json:"final_request_hash,omitempty"`
	Version               string                            `json:"version"`
	ID                    string                            `json:"id"`
	Owner                 StudioImageOwner                  `json:"owner"`
	OfferID               string                            `json:"offer_id"`
	PublishedRevision     string                            `json:"published_revision"`
	AdapterRevision       string                            `json:"adapter_revision"`
	AccountID             int64                             `json:"account_id"`
	EndpointFingerprint   string                            `json:"endpoint_fingerprint"`
	CredentialFingerprint string                            `json:"credential_fingerprint"`
	ProxyFingerprint      string                            `json:"proxy_fingerprint"`
	SalePrice             mediaworkbench.Price              `json:"sale_price"`
	Spec                  mediaworkbench.Spec               `json:"spec"`
	AssetIntentHash       string                            `json:"asset_intent_hash"`
	Assets                []StudioVideoReferenceIntentAsset `json:"assets"`
	Status                string                            `json:"status"`
	Receipts              []StudioVideoReferenceReceipt     `json:"receipts"`
	ExpiresAt             time.Time                         `json:"expires_at"`
}
type StudioVideoReferenceIntentAsset struct {
	AssetRef        string  `json:"asset_ref"`
	Kind            string  `json:"kind"`
	MimeType        string  `json:"mime_type"`
	SHA256          string  `json:"sha256"`
	Size            int     `json:"size"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
}
type StudioVideoStore struct{ Root string }

func (s *StudioVideoStore) path(kind, id string) string {
	return filepath.Join(s.Root, "video-"+kind+"-"+HashUsageRequestPayload([]byte(id)))
}
func (s *StudioVideoStore) init() error { return NewStudioImageStore(s.Root).init() }
func (s *StudioVideoStore) put(kind, id string, v any) error {
	if err := s.init(); err != nil {
		return err
	}
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return studioWrite(s.path(kind, id), data, true)
}
func (q StudioVideoQuote) Validate() error {
	if q.Binding.Validate() != nil || q.BindingHash != q.Binding.Hash() || q.Binding.PlanHash != studioHash(q.Plan) || q.Binding.RequestHash != q.Plan.RequestHash {
		return ErrStudioVideoConflict
	}
	_, _, e := q.Plan.Materialize()
	return e
}
func (s *StudioVideoStore) Issue(q StudioVideoQuote) (string, error) {
	if e := q.Validate(); e != nil {
		return "", e
	}
	token, e := studioRandom()
	if e != nil {
		return "", e
	}
	return token, s.put("quote", token, q)
}
func (s *StudioVideoStore) IssueReferencePreparation(p StudioVideoReferencePreparation) error {
	if p.Version != StudioVideoReferencePreparationVersion || p.ID == "" || p.Owner.UserID <= 0 || p.AccountID <= 0 || p.AssetIntentHash == "" || p.Status == "" || time.Now().UTC().After(p.ExpiresAt) {
		return ErrStudioVideoConflict
	}
	return s.put("reference-preparation", p.ID, p)
}
func (s *StudioVideoStore) UpdateReferencePreparation(p StudioVideoReferencePreparation) error {
	if p.Version != StudioVideoReferencePreparationVersion || p.ID == "" || p.Owner.UserID <= 0 || p.AccountID <= 0 || p.AssetIntentHash == "" || p.Status == "" {
		return ErrStudioVideoConflict
	}
	if err := s.init(); err != nil {
		return err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return studioWrite(s.path("reference-preparation", p.ID), data, false)
}
func (s *StudioVideoStore) ReferencePreparation(id string, owner StudioImageOwner) (StudioVideoReferencePreparation, error) {
	var p StudioVideoReferencePreparation
	if id == "" || owner.UserID <= 0 || studioRead(s.path("reference-preparation", id), &p) != nil {
		return p, ErrStudioVideoConflict
	}
	if p.Version != StudioVideoReferencePreparationVersion || p.ID != id || p.Owner != owner || time.Now().UTC().After(p.ExpiresAt) {
		return StudioVideoReferencePreparation{}, ErrStudioVideoConflict
	}
	return p, nil
}
func (s *StudioVideoStore) FindReferencePreparation(owner StudioImageOwner, offerID, intentHash string, spec mediaworkbench.Spec) (StudioVideoReferencePreparation, error) {
	var p StudioVideoReferencePreparation
	if owner.UserID <= 0 || intentHash == "" {
		return p, ErrStudioVideoConflict
	}
	err := studioRead(s.path("reference-preparation", "prep_"+intentHash), &p)
	if os.IsNotExist(err) {
		// Historical random-ID records are read as-is, including expired upload facts.
		entries, listErr := os.ReadDir(s.Root)
		if listErr != nil {
			return p, listErr
		}
		for _, entry := range entries {
			if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), "video-reference-preparation-") {
				var old StudioVideoReferencePreparation
				if e := studioRead(filepath.Join(s.Root, entry.Name()), &old); e != nil {
					return p, e
				}
				if old.Owner == owner && old.OfferID == offerID && old.AssetIntentHash == intentHash && old.Spec == spec {
					p = old
					err = nil
					break
				}
			}
		}
	}
	if err != nil {
		return p, err
	}
	if p.Version != StudioVideoReferencePreparationVersion || p.Owner != owner || p.OfferID != offerID || p.AssetIntentHash != intentHash || p.Spec != spec {
		return StudioVideoReferencePreparation{}, ErrStudioVideoConflict
	}
	return p, nil
}
func (s *StudioVideoStore) Quote(token string, owner StudioImageOwner) (StudioVideoQuote, error) {
	var q StudioVideoQuote
	if !videoDigest(token) {
		return q, ErrStudioVideoConflict
	}
	if e := studioRead(s.path("quote", token), &q); e != nil {
		return q, e
	}
	if q.Binding.Owner != owner {
		return StudioVideoQuote{}, ErrStudioVideoConflict
	}
	return q, q.Validate()
}
func (s *StudioVideoStore) Task(id string, owner StudioImageOwner) (StudioVideoTask, error) {
	var t StudioVideoTask
	if !AccountVideoChild(id) || !studioImageTaskID.MatchString(id) {
		return t, ErrStudioVideoConflict
	}
	if e := studioRead(s.path("task", id), &t); e != nil {
		return t, e
	}
	if t.ID != id || t.Quote.Binding.Owner != owner {
		return StudioVideoTask{}, ErrStudioVideoConflict
	}
	return t, t.Quote.Validate()
}
func (s *StudioVideoStore) Claim(t StudioVideoTask) (bool, error) {
	if t.Quote.Validate() != nil || !AccountVideoChild(t.ID) || !studioImageTaskID.MatchString(t.ID) || !videoDigest(t.TokenHash) {
		return false, ErrStudioVideoConflict
	}
	// One opaque quote cannot be rebound to another task, including concurrent calls.
	e := s.put("quote-claim", t.TokenHash, t.ID)
	if os.IsExist(e) {
		var old string
		e = studioRead(s.path("quote-claim", t.TokenHash), &old)
		if e == nil && old != t.ID {
			e = ErrStudioVideoConflict
		}
	}
	if e != nil {
		return false, e
	}
	e = s.put("task", t.ID, t)
	if os.IsExist(e) {
		old, readErr := s.Task(t.ID, t.Quote.Binding.Owner)
		if readErr != nil {
			return false, readErr
		}
		if studioHash(old) != studioHash(t) {
			return false, ErrStudioVideoConflict
		}
		return false, nil
	}
	return e == nil, e
}
func (s *StudioVideoStore) DispatchClaim(id string) (bool, error) {
	e := s.put("dispatch", id, struct {
		ID string `json:"id"`
	}{id})
	if os.IsExist(e) {
		return false, nil
	}
	return e == nil, e
}
func (s *StudioVideoStore) Accept(id, upstreamID string) error {
	if !studioImageTaskID.MatchString(upstreamID) {
		return ErrStudioVideoUnknown
	}
	e := s.put("accepted", id, upstreamID)
	if os.IsExist(e) {
		old, readErr := s.Upstream(id)
		if readErr != nil {
			return readErr
		}
		if old != upstreamID {
			return ErrStudioVideoConflict
		}
		return nil
	}
	return e
}
func (s *StudioVideoStore) Upstream(id string) (string, error) {
	var v string
	e := studioRead(s.path("accepted", id), &v)
	if e != nil {
		return "", e
	}
	if !studioImageTaskID.MatchString(v) {
		return "", ErrStudioVideoConflict
	}
	return v, nil
}

package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

const StudioPaidControlVersion = "managed-v1"

var ErrPaidControl = errors.New("media paid control preflight failed")

type PaidCheck struct {
	Code      string `json:"code"`
	AccountID int64  `json:"account_id,omitempty"`
	ProductID string `json:"product_id,omitempty"`
	Path      string `json:"path,omitempty"`
	Pass      bool   `json:"pass"`
}
type PaidReport struct {
	Media       string      `json:"media"`
	Pass        bool        `json:"pass"`
	Fingerprint string      `json:"fingerprint"`
	Checks      []PaidCheck `json:"checks"`
	CheckedAt   time.Time   `json:"checked_at"`
}
type PaidState struct {
	Media       string `json:"media"`
	Mode        string `json:"mode"`
	Requested   bool   `json:"requested_enabled"`
	Effective   bool   `json:"effective_enabled"`
	Revision    string `json:"revision"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Reason      string `json:"reason"`
	Actor       int64  `json:"-"`
}
type paidRecord struct {
	Enabled     bool   `json:"enabled"`
	Actor       int64  `json:"actor"`
	Revision    string `json:"revision"`
	Fingerprint string `json:"fingerprint"`
	Epoch       string `json:"epoch"`
}

// The existing settings repository is the only persistent switch authority.
// A single Core owns mutations. Sidecars delegate admission to this Core and
// never keep an enabled cache. A Core restart invalidates prior grants, including
// a disable that could not be persisted. An observed dependency failure is latched
// closed until a fresh Apply. Legacy deployments keep their startup gates.
type StudioPaidControl struct {
	Settings    SettingRepository
	Check       func(context.Context, string, int64) PaidReport
	Fingerprint func(context.Context, string, int64) (string, error)
	Managed     bool
	mu          sync.Mutex
	failed      sync.Map
	once        sync.Once
	epoch       string
}

func validPaidMedia(m string) bool { return m == "image" || m == "video" }
func paidSetting(m string) string  { return "studio_paid_control_" + m + "_v1" }
func (s *StudioPaidControl) read(ctx context.Context, m string) (paidRecord, error) {
	var r paidRecord
	if s == nil || s.Settings == nil || !validPaidMedia(m) {
		return r, ErrPaidControl
	}
	raw, err := s.Settings.GetValue(ctx, paidSetting(m))
	if errors.Is(err, ErrSettingNotFound) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if raw == "" {
		return r, nil
	}
	if json.Unmarshal([]byte(raw), &r) != nil {
		return r, ErrPaidControl
	}
	return r, nil
}
func (s *StudioPaidControl) Status(ctx context.Context, m string) PaidState {
	out := PaidState{Media: m, Mode: "legacy", Reason: "deployment_mode", Revision: ""}
	if s == nil || !s.Managed {
		return out
	}
	s.once.Do(func() { s.epoch, _ = studioRandom() })
	out.Mode = StudioPaidControlVersion
	r, err := s.read(ctx, m)
	if err != nil {
		out.Reason = "state_unavailable"
		return out
	}
	out.Requested = r.Enabled
	out.Revision = r.Revision
	out.Fingerprint = r.Fingerprint
	out.Actor = r.Actor
	if blocked, _ := s.failed.Load(m); blocked == true {
		out.Reason = "apply_failed"
		return out
	}
	if !r.Enabled {
		out.Reason = "closed"
		return out
	}
	if s.epoch == "" || r.Epoch != s.epoch || s.Fingerprint == nil {
		out.Reason = "runtime_restarted"
		return out
	}
	current, err := s.Fingerprint(ctx, m, r.Actor)
	if err != nil {
		s.failed.Store(m, true)
		out.Reason = "dependencies_unavailable"
		return out
	}
	if current == "" || current != r.Fingerprint {
		s.failed.Store(m, true)
		out.Reason = "dependencies_changed"
		return out
	}
	out.Effective = true
	out.Reason = "open"
	return out
}
func (s *StudioPaidControl) Effective(ctx context.Context, m string) bool {
	return s.Status(ctx, m).Effective
}
func (s *StudioPaidControl) Preflight(ctx context.Context, m string, actor int64) PaidReport {
	if s == nil || !s.Managed || !validPaidMedia(m) || actor <= 0 || s.Check == nil {
		return PaidReport{Media: m, Checks: []PaidCheck{{Code: "deployment_mode"}}, CheckedAt: time.Now().UTC()}
	}
	return s.Check(ctx, m, actor)
}
func (s *StudioPaidControl) Apply(ctx context.Context, m string, actor int64, enable bool, revision, fingerprint string) (PaidState, *PaidReport, error) {
	if s == nil || !s.Managed || !validPaidMedia(m) || actor <= 0 {
		return PaidState{Media: m, Reason: "deployment_mode"}, nil, ErrPaidControl
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.read(ctx, m)
	if err != nil {
		return PaidState{Media: m, Reason: "state_unavailable"}, nil, err
	}
	if current.Revision != revision {
		return PaidState{Media: m, Reason: "revision_changed"}, nil, ErrPaidControl
	}
	// Stop admission immediately while enabling is revalidated or disabling is
	// persisted. Failed applies stay closed in this process and are reported.
	s.failed.Store(m, true)
	s.once.Do(func() { s.epoch, _ = studioRandom() })
	if s.epoch == "" {
		return PaidState{Media: m, Reason: "apply_failed"}, nil, ErrPaidControl
	}
	next := paidRecord{Actor: actor, Epoch: s.epoch}
	next.Revision, err = studioRandom()
	if err != nil {
		return PaidState{Media: m, Reason: "apply_failed"}, nil, err
	}
	raw, _ := json.Marshal(next)
	if err = s.Settings.Set(ctx, paidSetting(m), string(raw)); err != nil {
		return PaidState{Media: m, Reason: "apply_failed"}, nil, err
	}
	s.failed.Store(m, false)
	if !enable {
		return s.Status(ctx, m), nil, nil
	}
	report := s.Preflight(ctx, m, actor)
	if !report.Pass || fingerprint == "" || report.Fingerprint != fingerprint {
		return s.Status(ctx, m), &report, ErrPaidControl
	}
	// Re-read all dependencies after checking, before granting admission.
	latest, e := s.Fingerprint(ctx, m, actor)
	if e != nil || latest != report.Fingerprint {
		return s.Status(ctx, m), &report, ErrPaidControl
	}
	next.Enabled = true
	next.Fingerprint = latest
	raw, _ = json.Marshal(next)
	if err = s.Settings.Set(ctx, paidSetting(m), string(raw)); err != nil {
		s.failed.Store(m, true)
		return PaidState{Media: m, Reason: "apply_failed"}, &report, err
	}
	out := s.Status(ctx, m)
	if !out.Effective {
		s.failed.Store(m, true)
		next.Enabled = false
		raw, _ = json.Marshal(next)
		_ = s.Settings.Set(ctx, paidSetting(m), string(raw))
		return out, &report, ErrPaidControl
	}
	return out, &report, nil
}
func StudioManagedPaidMode() bool {
	return os.Getenv("STUDIO_PAID_CONTROL_MODE") == StudioPaidControlVersion
}
func StudioPaidMode() string {
	if StudioManagedPaidMode() {
		return StudioPaidControlVersion
	}
	return "legacy"
}

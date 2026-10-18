package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
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

// Aggregate admin-only diagnostics; no credentials, request bodies or routes.
type PaidCheckMetrics struct {
	AccountsValidated int              `json:"accounts_validated"`
	SpecsChecked      int              `json:"specs_checked"`
	TimingsMS         map[string]int64 `json:"timings_ms"`
}
type paidDependencies struct {
	Shared string            `json:"shared"`
	Offers map[string]string `json:"offers"`
}

func paidOfferKey(account int64, offer string) string {
	return strconv.FormatInt(account, 10) + ":" + offer
}

// An observed offer may disappear without revoking unrelated grants. New or
// changed identities are never authorized by this subset comparison.
func paidDependenciesContain(current, approved paidDependencies) bool {
	if current.Shared == "" || current.Shared != approved.Shared || len(approved.Offers) == 0 {
		return false
	}
	for id, identity := range approved.Offers {
		if identity == "" || current.Offers[id] != identity {
			return false
		}
	}
	return true
}

type PaidReport struct {
	GroupID       int64 `json:"group_id,omitempty"` // Administrator diagnostic context, never a routing override.
	dependencies  paidDependencies
	sharedFailure bool
	Metrics       *PaidCheckMetrics `json:"metrics,omitempty"`
	Media         string            `json:"media"`
	Pass          bool              `json:"pass"`
	Fingerprint   string            `json:"fingerprint"`
	Checks        []PaidCheck       `json:"checks"`
	CheckedAt     time.Time         `json:"checked_at"`
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
	SharedFingerprint string            `json:"shared_fingerprint,omitempty"`
	Grants            map[string]string `json:"offer_grants,omitempty"`
	Enabled           bool              `json:"enabled"`
	Actor             int64             `json:"actor"`
	Revision          string            `json:"revision"`
	Fingerprint       string            `json:"fingerprint"`
	Epoch             string            `json:"epoch"`
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
	Snapshot    func(context.Context, string, int64) (paidDependencies, error)
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
	return s.status(ctx, m, "")
}

// AllowsOffer is only for new paid admission, never historical receipt recovery.
func (s *StudioPaidControl) AllowsOffer(ctx context.Context, m string, account int64, offer string) bool {
	if s == nil || !s.Managed {
		return true
	}
	return s.status(ctx, m, paidOfferKey(account, offer)).Effective
}

func (s *StudioPaidControl) status(ctx context.Context, m, offer string) PaidState {
	out := PaidState{Media: m, Mode: "legacy", Reason: "deployment_mode", Revision: ""}
	if s == nil || !s.Managed {
		return out
	}
	s.once.Do(func() { s.epoch, _ = studioRandom() })
	out.Mode = StudioPaidControlVersion
	r, err := s.read(ctx, m)
	if err != nil {
		s.failed.Store(m, true)
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
	if s.epoch == "" || r.Epoch != s.epoch || (s.Fingerprint == nil && s.Snapshot == nil) {
		out.Reason = "runtime_restarted"
		return out
	}
	if s.Snapshot != nil {
		current, err := s.Snapshot(ctx, m, r.Actor)
		if err != nil {
			s.failed.Store(m, true)
			out.Reason = "dependencies_unavailable"
			return out
		}
		if current.Shared == "" || current.Shared != r.SharedFingerprint {
			s.failed.Store(m, true)
			out.Reason = "dependencies_changed"
			return out
		}
		matched := false
		for id, identity := range r.Grants {
			if identity != "" && current.Offers[id] == identity && (offer == "" || id == offer) {
				matched = true
				break
			}
		}
		if !matched {
			out.Reason = "no_approved_offer"
			return out
		}
	} else {
		// Compatibility for explicitly supplied legacy dependency checkers. Production
		// managed control always supplies Snapshot and requires persisted offer grants.
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
		if offer != "" {
			out.Reason = "no_approved_offer"
			return out
		}
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
	report := s.Check(ctx, m, actor)
	if !report.Pass {
		s.failed.Store(m, true)
	}
	return report
}
func (s *StudioPaidControl) Apply(ctx context.Context, m string, actor int64, enable bool, revision, fingerprint string) (PaidState, *PaidReport, error) {
	if s == nil || !s.Managed || !validPaidMedia(m) || actor <= 0 {
		return PaidState{Media: m, Reason: "deployment_mode"}, nil, ErrPaidControl
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.read(ctx, m)
	if err != nil {
		s.failed.Store(m, true)
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
	if ctx.Err() != nil || !report.Pass || fingerprint == "" || report.Fingerprint != fingerprint {
		return s.Status(ctx, m), &report, ErrPaidControl
	}
	// Re-read shared dependencies and every checked grant before admission.
	if s.Snapshot != nil {
		latest, e := s.Snapshot(ctx, m, actor)
		if ctx.Err() != nil || e != nil || !paidDependenciesContain(latest, report.dependencies) {
			return s.Status(ctx, m), &report, ErrPaidControl
		}
		next.SharedFingerprint = report.dependencies.Shared
		next.Grants = report.dependencies.Offers
	} else {
		latest, e := s.Fingerprint(ctx, m, actor)
		if ctx.Err() != nil || e != nil || latest != report.Fingerprint {
			return s.Status(ctx, m), &report, ErrPaidControl
		}
	}
	next.Enabled = true
	next.Fingerprint = report.Fingerprint
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

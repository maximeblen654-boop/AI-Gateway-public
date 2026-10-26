package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
)

type renewalSettingsFake struct {
	*paidSettingsFake
	writes int
}

func (s *renewalSettingsFake) Set(ctx context.Context, k, v string) error {
	s.writes++
	return s.paidSettingsFake.Set(ctx, k, v)
}

type renewalFixture struct {
	gate    *StudioPaidControl
	store   *renewalSettingsFake
	old     paidRecord
	current paidDependencies
	checks  int
}

func renewalCopy(v paidDependencies) paidDependencies {
	out := paidDependencies{Shared: v.Shared, Offers: map[string]string{}}
	for k, x := range v.Offers {
		out.Offers[k] = x
	}
	return out
}
func newRenewalFixture(t *testing.T) *renewalFixture {
	t.Helper()
	f := &renewalFixture{store: &renewalSettingsFake{paidSettingsFake: &paidSettingsFake{values: map[string]string{}}}, current: paidDependencies{Shared: "synthetic-shared", Offers: map[string]string{"1001:synthetic-approved": "synthetic-identity"}}}
	for i := 1; i <= 12; i++ {
		f.current.Offers[fmt.Sprintf("2001:synthetic-new-%02d", i)] = fmt.Sprintf("synthetic-new-identity-%02d", i)
	}
	approved := paidDependencies{Shared: f.current.Shared, Offers: map[string]string{"1001:synthetic-approved": "synthetic-identity"}}
	f.old = paidRecord{SharedFingerprint: approved.Shared, Grants: approved.Offers, Enabled: true, Actor: 91001, Revision: "synthetic-old-revision", Fingerprint: studioHash(approved), Epoch: "synthetic-prior-runtime"}
	f.gate = &StudioPaidControl{Managed: true, Settings: f.store}
	f.gate.Check = func(_ context.Context, m string, actor int64) PaidReport {
		f.checks++
		if actor != f.old.Actor {
			t.Errorf("check actor=%d", actor)
		}
		d := renewalCopy(f.current)
		return PaidReport{Media: m, Pass: true, Fingerprint: studioHash(d), dependencies: d}
	}
	f.gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) { return renewalCopy(f.current), nil }
	f.save(t)
	if got := f.gate.Status(context.Background(), "video"); got.Reason != "runtime_restarted" {
		t.Fatalf("fixture: %+v", got)
	}
	return f
}
func (f *renewalFixture) save(t *testing.T) {
	t.Helper()
	b, e := json.Marshal(f.old)
	if e != nil {
		t.Fatal(e)
	}
	var fields map[string]any
	_ = json.Unmarshal(b, &fields)
	fields["synthetic_opaque"] = map[string]any{"keep": []any{"opaque", float64(7)}}
	b, _ = json.Marshal(fields)
	f.store.values[paidSetting("video")] = string(b)
}
func (f *renewalFixture) renew(ctx context.Context) (PaidState, *PaidReport, error) {
	return f.gate.ApplyWithMode(ctx, "video", f.old.Actor, true, f.old.Revision, f.old.Fingerprint, StudioPaidRenewExistingMode)
}
func TestStudioPaidRenewExistingThirteenEligibleOnlyOneApproved(t *testing.T) {
	f := newRenewalFixture(t)
	raw := f.store.values[paidSetting("video")]
	state, report, err := f.renew(context.Background())
	if err != nil || !state.Effective || state.Mode != StudioPaidControlVersion || state.Fingerprint != f.old.Fingerprint || report.Fingerprint == f.old.Fingerprint || len(report.dependencies.Offers) != 13 || f.store.writes != 1 {
		t.Fatalf("state=%+v report=%+v writes=%d err=%v", state, report, f.store.writes, err)
	}
	var before, after map[string]any
	_ = json.Unmarshal([]byte(raw), &before)
	_ = json.Unmarshal([]byte(f.store.values[paidSetting("video")]), &after)
	if before["revision"] == after["revision"] || before["epoch"] == after["epoch"] {
		t.Fatal("runtime identity did not change")
	}
	delete(before, "revision")
	delete(before, "epoch")
	delete(after, "revision")
	delete(after, "epoch")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("scope/opaque fields changed: before=%v after=%v", before, after)
	}
	if !f.gate.AllowsOffer(context.Background(), "video", 1001, "synthetic-approved") || f.gate.AllowsOffer(context.Background(), "video", 2001, "synthetic-new-01") {
		t.Fatal("new eligible offer borrowed old grant")
	}
}
func TestStudioPaidRenewExistingRefusesBeforePersistentWrite(t *testing.T) {
	for _, name := range []string{"actor", "revision", "fingerprint", "inconsistent-record-fingerprint", "disabled", "same-runtime", "latched-failure", "no-snapshot", "wrong-media", "failed-check", "old-grant-missing", "old-grant-changed", "shared-changed", "latest-old-grant-changed", "cancelled-check", "out-of-band-disable", "out-of-band-scope"} {
		t.Run(name, func(t *testing.T) {
			f := newRenewalFixture(t)
			actor, revision, fingerprint := f.old.Actor, f.old.Revision, f.old.Fingerprint
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch name {
			case "actor":
				actor++
			case "revision":
				revision = "synthetic-stale-revision"
			case "fingerprint":
				fingerprint = "synthetic-wrong-fingerprint"
			case "inconsistent-record-fingerprint":
				f.old.Fingerprint = "synthetic-inconsistent"
				fingerprint = f.old.Fingerprint
				f.save(t)
			case "disabled":
				f.old.Enabled = false
				f.save(t)
			case "same-runtime":
				f.old.Epoch = f.gate.epoch
				f.save(t)
			case "latched-failure":
				f.gate.failed.Store("video", true)
			case "no-snapshot":
				f.gate.Snapshot = nil
			case "old-grant-missing":
				delete(f.current.Offers, "1001:synthetic-approved")
			case "old-grant-changed":
				f.current.Offers["1001:synthetic-approved"] = "synthetic-changed"
			case "shared-changed":
				f.current.Shared = "synthetic-changed-shared"
			case "latest-old-grant-changed":
				f.gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) {
					d := renewalCopy(f.current)
					d.Offers["1001:synthetic-approved"] = "synthetic-changed"
					return d, nil
				}
			case "wrong-media", "failed-check", "cancelled-check", "out-of-band-disable", "out-of-band-scope":
				original := f.gate.Check
				f.gate.Check = func(c context.Context, m string, a int64) PaidReport {
					r := original(c, m, a)
					switch name {
					case "wrong-media":
						r.Media = "image"
					case "failed-check":
						r.Pass = false
					case "cancelled-check":
						cancel()
					case "out-of-band-disable":
						f.old.Enabled = false
						f.save(t)
					case "out-of-band-scope":
						f.old.Grants["synthetic-out-of-band"] = "synthetic-value"
						f.save(t)
					}
					return r
				}
			}
			_, _, err := f.gate.ApplyWithMode(ctx, "video", actor, true, revision, fingerprint, StudioPaidRenewExistingMode)
			if err == nil || f.store.writes != 0 {
				t.Fatalf("accepted %s: writes=%d err=%v", name, f.store.writes, err)
			}
		})
	}
}
func TestStudioPaidRenewExistingAllowsUnrelatedNewOfferDrift(t *testing.T) {
	f := newRenewalFixture(t)
	f.gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) {
		d := renewalCopy(f.current)
		delete(d.Offers, "2001:synthetic-new-01")
		return d, nil
	}
	if state, _, err := f.renew(context.Background()); err != nil || !state.Effective || f.store.writes != 1 {
		t.Fatal(state, err, f.store.writes)
	}
}
func TestStudioPaidApplyModeExplicitAndDefaultUnchanged(t *testing.T) {
	for _, mode := range []string{"unknown", StudioPaidRenewExistingMode} {
		f := newRenewalFixture(t)
		enable := mode != "renew-existing"
		_, _, err := f.gate.ApplyWithMode(context.Background(), "video", f.old.Actor, enable, f.old.Revision, f.old.Fingerprint, mode)
		if err == nil || f.store.writes != 0 || f.checks != 0 {
			t.Fatal(mode, err, f.store.writes, f.checks)
		}
	}
	f := newRenewalFixture(t)
	state, _, err := f.gate.ApplyWithMode(context.Background(), "video", f.old.Actor, true, f.old.Revision, studioHash(f.current), "")
	if err != nil || !state.Effective || f.store.writes != 2 {
		t.Fatal(state, err, f.store.writes)
	}
	r, _ := f.gate.read(context.Background(), "video")
	if len(r.Grants) != 13 {
		t.Fatal("ordinary Apply behavior changed", len(r.Grants))
	}
}
func TestStudioPaidRenewExistingSameRevisionOnlyOneCheckAndWrite(t *testing.T) {
	f := newRenewalFixture(t)
	started, release := make(chan struct{}), make(chan struct{})
	original := f.gate.Check
	f.gate.Check = func(c context.Context, m string, a int64) PaidReport {
		close(started)
		<-release
		return original(c, m, a)
	}
	type result struct {
		state PaidState
		err   error
	}
	results := make(chan result, 2)
	call := func() { s, _, e := f.renew(context.Background()); results <- result{s, e} }
	go call()
	<-started
	go call()
	close(release)
	success := 0
	for range 2 {
		r := <-results
		if r.err == nil {
			success++
		} else if r.state.Reason != "revision_changed" {
			t.Fatal(r)
		}
	}
	if success != 1 || f.checks != 1 || f.store.writes != 1 {
		t.Fatal(success, f.checks, f.store.writes)
	}
}

func TestStudioPaidRenewExistingFinalObservationRequiresAllOldGrants(t *testing.T) {
	f := newRenewalFixture(t)
	const second = "1001:synthetic-second-approved"
	f.old.Grants[second] = "synthetic-second-identity"
	f.current.Offers[second] = "synthetic-second-identity"
	f.old.Fingerprint = studioHash(paidDependencies{Shared: f.old.SharedFingerprint, Offers: f.old.Grants})
	f.save(t)
	snapshots := 0
	f.gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) {
		snapshots++
		d := renewalCopy(f.current)
		if snapshots == 3 {
			delete(d.Offers, second)
		}
		return d, nil
	}
	state, _, err := f.renew(context.Background())
	if err == nil || state.Effective || snapshots != 3 || f.store.writes != 1 {
		t.Fatalf("lost old grant accepted: state=%+v snapshots=%d writes=%d err=%v", state, snapshots, f.store.writes, err)
	}
	if f.gate.Status(context.Background(), "video").Effective {
		t.Fatal("failed final renewal observation did not latch closed")
	}
	stored, readErr := f.gate.read(context.Background(), "video")
	if readErr != nil || !stored.Enabled || stored.Actor != f.old.Actor || stored.Fingerprint != f.old.Fingerprint || !reflect.DeepEqual(stored.Grants, f.old.Grants) {
		t.Fatal("failure cleared or changed persisted scope", stored, readErr)
	}
}

func TestStudioPaidRenewExistingWriteOrFinalObservationFailureStaysClosed(t *testing.T) {
	for _, stage := range []string{"set", "final-snapshot", "final-cancel"} {
		t.Run(stage, func(t *testing.T) {
			f := newRenewalFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if stage == "set" {
				f.store.fail = true
			} else {
				snapshots := 0
				f.gate.Snapshot = func(context.Context, string, int64) (paidDependencies, error) {
					snapshots++
					if snapshots == 3 {
						if stage == "final-snapshot" {
							return paidDependencies{}, errors.New("synthetic snapshot unavailable")
						}
						cancel()
					}
					return renewalCopy(f.current), nil
				}
			}
			state, _, err := f.renew(ctx)
			if err == nil || state.Effective || f.store.writes != 1 || f.gate.Status(context.Background(), "video").Effective {
				t.Fatalf("failed renewal reopened: state=%+v writes=%d err=%v", state, f.store.writes, err)
			}
			stored, readErr := f.gate.read(context.Background(), "video")
			if readErr != nil || !stored.Enabled || stored.Actor != f.old.Actor || stored.Fingerprint != f.old.Fingerprint || !reflect.DeepEqual(stored.Grants, f.old.Grants) {
				t.Fatal("failure cleared or changed persisted scope", stored, readErr)
			}
		})
	}
}

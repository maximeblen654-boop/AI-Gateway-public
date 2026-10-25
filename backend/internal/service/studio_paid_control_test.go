package service

import (
	"context"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"os"
	"strings"
	"testing"
)

type paidSettingsFake struct {
	SettingRepository
	values   map[string]string
	fail     bool
	readFail bool
}

func (f *paidSettingsFake) GetValue(_ context.Context, k string) (string, error) {
	if f.readFail {
		return "", errors.New("read unavailable")
	}
	v, ok := f.values[k]
	if !ok {
		return "", ErrSettingNotFound
	}
	return v, nil
}
func (f *paidSettingsFake) Set(_ context.Context, k, v string) error {
	if f.fail {
		return errors.New("storage unavailable")
	}
	f.values[k] = v
	return nil
}
func TestStudioPaidControlAdmission(t *testing.T) {
	ctx := context.Background()
	store := &paidSettingsFake{values: map[string]string{}}
	fingerprint := strings.Repeat("a", 64)
	pass := true
	calls := 0
	gate := &StudioPaidControl{Settings: store, Managed: true}
	gate.Fingerprint = func(context.Context, string, int64) (string, error) { return fingerprint, nil }
	gate.Check = func(_ context.Context, m string, actor int64) PaidReport {
		calls++
		return PaidReport{Media: m, Pass: pass, Fingerprint: fingerprint}
	}
	if gate.Status(ctx, "image").Effective {
		t.Fatal("default open")
	}
	state, _, err := gate.Apply(ctx, "image", 1, true, "", fingerprint)
	if err != nil || !state.Effective || calls != 1 {
		t.Fatal(state, err, calls)
	}
	if gate.Status(ctx, "video").Requested || gate.Status(ctx, "video").Effective {
		t.Fatal("image opened video")
	}
	fingerprint = strings.Repeat("b", 64)
	if gate.Status(ctx, "image").Effective {
		t.Fatal("stale PASS survived drift")
	}
	state, _, err = gate.Apply(ctx, "image", 1, true, state.Revision, strings.Repeat("a", 64))
	if err == nil || state.Requested || state.Effective {
		t.Fatal("stale preflight accepted", state)
	}
	pass = false
	state, _, err = gate.Apply(ctx, "image", 1, true, state.Revision, fingerprint)
	if err == nil || state.Effective {
		t.Fatal("failed quote opened gate")
	}
	pass = true
	state, _, err = gate.Apply(ctx, "image", 1, true, state.Revision, fingerprint)
	if err != nil || !state.Effective {
		t.Fatal(state, err)
	}
	store.fail = true
	_, _, err = gate.Apply(ctx, "image", 1, false, state.Revision, "")
	if err == nil || gate.Status(ctx, "image").Effective {
		t.Fatal("failed apply reported open")
	}
}
func TestStudioPaidControlChangeDuringApply(t *testing.T) {
	store := &paidSettingsFake{values: map[string]string{}}
	gate := &StudioPaidControl{Settings: store, Managed: true}
	gate.Check = func(context.Context, string, int64) PaidReport { return PaidReport{Pass: true, Fingerprint: "before"} }
	gate.Fingerprint = func(context.Context, string, int64) (string, error) { return "after", nil }
	state, _, err := gate.Apply(context.Background(), "image", 1, true, "", "before")
	if err == nil || state.Effective || state.Requested {
		t.Fatal("check/use drift opened", state)
	}
	for _, m := range []string{"image", "video"} {
		if gate.Status(context.Background(), m).Effective {
			t.Fatal(m)
		}
	}
}
func TestStudioPaidControlRequiresManagedDeployment(t *testing.T) {
	gate := &StudioPaidControl{}
	if gate.Preflight(context.Background(), "image", 1).Pass {
		t.Fatal("legacy deployment passed")
	}
	if _, _, e := gate.Apply(context.Background(), "image", 1, true, "", ""); e == nil {
		t.Fatal("legacy changed")
	}
}

func TestStudioPaidControlRestartAndRestoredDependenciesStayClosed(t *testing.T) {
	ctx := context.Background()
	store := &paidSettingsFake{values: map[string]string{}}
	dependency := "a"
	makeGate := func() *StudioPaidControl {
		return &StudioPaidControl{Settings: store, Managed: true, Check: func(context.Context, string, int64) PaidReport {
			return PaidReport{Pass: true, Fingerprint: dependency}
		}, Fingerprint: func(context.Context, string, int64) (string, error) { return dependency, nil }}
	}
	gate := makeGate()
	state, _, err := gate.Apply(ctx, "image", 1, true, "", "a")
	if err != nil || !state.Effective {
		t.Fatal(state, err)
	}
	if makeGate().Effective(ctx, "image") {
		t.Fatal("restart restored old admission")
	}
	dependency = "b"
	if gate.Effective(ctx, "image") {
		t.Fatal("drift accepted")
	}
	dependency = "a"
	if gate.Effective(ctx, "image") {
		t.Fatal("restoring config silently reopened")
	}
	state, _, err = gate.Apply(ctx, "image", 1, true, state.Revision, "a")
	if err != nil || !state.Effective {
		t.Fatal("fresh preflight cannot reopen", state, err)
	}
}

func TestStudioVideoPreflightReusesQuoteWithoutSubmissionOrToken(t *testing.T) {
	r, _, q, key, _, orders := videoRuntimeFixture(t)
	r.enabled = false
	r.request = func(context.Context, *Account, string, string, []byte) ([]byte, string, error) {
		t.Fatal("preflight reached supplier")
		return nil, "", nil
	}
	before, e := os.ReadDir(r.Store.Root)
	if e != nil {
		t.Fatal(e)
	}
	for _, refs := range []int{0, 1} {
		spec := q.Binding.Spec
		spec.Images = refs
		model := videoplan.Model{ID: "generic-video", Upstream: q.Binding.Offer.UpstreamModel, Status: "enabled", Mode: "images", Resolutions: []string{spec.Resolution}, Ratios: []string{spec.AspectRatio}, Durations: []int{spec.DurationSeconds}}
		model.Limits.Image, model.Limits.Total = 1, 1
		plan, e := videoplan.PreviewWithModel(model, model.Upstream, spec.Resolution, spec.AspectRatio, spec.DurationSeconds, refs, 0, 0)
		if e != nil {
			t.Fatal(e)
		}
		if e = r.quotePreflight(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, spec, plan.Body); e != nil {
			t.Fatal(e)
		}
	}
	after, e := os.ReadDir(r.Store.Root)
	if e != nil || len(before) != len(after) || orders.reserves != 0 {
		t.Fatal("preflight created executable state", e)
	}
}

func TestStudioPaidControlReadFailureCannotRestoreOldOpenState(t *testing.T) {
	ctx := context.Background()
	for _, apply := range []bool{false, true} {
		store := &paidSettingsFake{values: map[string]string{}}
		gate := &StudioPaidControl{Settings: store, Managed: true, Check: func(context.Context, string, int64) PaidReport { return PaidReport{Pass: true, Fingerprint: "a"} }, Fingerprint: func(context.Context, string, int64) (string, error) { return "a", nil }}
		state, _, err := gate.Apply(ctx, "image", 1, true, "", "a")
		if err != nil || !state.Effective {
			t.Fatal(state, err)
		}
		store.readFail = true
		if apply {
			_, _, err = gate.Apply(ctx, "image", 1, false, state.Revision, "")
			if err == nil {
				t.Fatal("failed disable not reported")
			}
		} else if gate.Effective(ctx, "image") {
			t.Fatal("read failure admitted")
		}
		store.readFail = false
		if gate.Effective(ctx, "image") {
			t.Fatal("read recovery reopened old enabled record")
		}
	}
}

func TestStudioPaidControlFailedCheckClosesExistingGrant(t *testing.T) {
	ctx := context.Background()
	pass := true
	gate := &StudioPaidControl{Managed: true, Settings: &paidSettingsFake{values: map[string]string{}}, Check: func(context.Context, string, int64) PaidReport { return PaidReport{Pass: pass, Fingerprint: "a"} }, Fingerprint: func(context.Context, string, int64) (string, error) { return "a", nil }}
	if state, _, err := gate.Apply(ctx, "image", 1, true, "", "a"); err != nil || !state.Effective {
		t.Fatal(state, err)
	}
	pass = false
	if gate.Preflight(ctx, "image", 1).Pass || gate.Effective(ctx, "image") {
		t.Fatal("failed preflight left old grant open")
	}
}

func TestStudioPaidControlCancelledEnableStaysClosed(t *testing.T) {
	for _, stage := range []string{"check", "final_fingerprint"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store := &paidSettingsFake{values: map[string]string{}}
			gate := &StudioPaidControl{Settings: store, Managed: true}
			gate.Check = func(context.Context, string, int64) PaidReport {
				if stage == "check" {
					cancel()
				}
				return PaidReport{Pass: true, Fingerprint: "same"}
			}
			gate.Fingerprint = func(context.Context, string, int64) (string, error) { cancel(); return "same", nil }
			state, _, err := gate.Apply(ctx, "image", 1, true, "", "same")
			if err == nil || state.Effective || state.Requested || gate.Status(context.Background(), "image").Effective || gate.Status(context.Background(), "video").Effective {
				t.Fatal("cancelled recheck granted admission", state, err)
			}
		})
	}
}

func TestStudioPaidPreflightCancelledRequest(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		want := "check_cancelled"
		if deadline {
			cancel()
			ctx, cancel = context.WithTimeout(context.Background(), -1)
			want = "check_timeout"
		} else {
			cancel()
		}
		report := (&studioPaidPreflight{}).check(ctx, "image", 1)
		cancel()
		if report.Pass || len(report.Checks) != 1 || report.Checks[0].Code != want || report.Metrics.SpecsChecked != 0 {
			t.Fatalf("cancelled preflight: %+v", report)
		}
	}
}

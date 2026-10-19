package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const testSubmissionID = "550e8400-e29b-41d4-a716-446655440000"
const nextSubmissionID = "550e8400-e29b-41d4-a716-446655440001"

func TestSaveDraftHumanRetryCompetesWithLateOriginalUnderCAS(t *testing.T) {
	for _, retryFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "original_wins", true: "retry_wins"}[retryFirst], func(t *testing.T) {
			s, repo := validatorFixture(t)
			original := DraftInput{SubmissionID: testSubmissionID, Products: []Product{validProduct()}}
			original.Products[0].DisplayName = "Earlier submitted draft"
			retry := DraftInput{SubmissionID: nextSubmissionID, Products: []Product{validProduct()}}
			retry.Products[0].DisplayName = "Newest user input"
			first, late := original, retry
			if retryFirst {
				first, late = retry, original
			}
			// Both requests were created after reading record_version 1. Only
			// the first reaches the atomic write; the delayed request is stale.
			d, err := s.SaveDraft(t.Context(), 7, 1, first)
			must(t, err)
			before, err := json.Marshal(repo.a.Config)
			must(t, err)
			writes := repo.writes
			if got, err := s.SaveDraft(t.Context(), 7, 1, late); !errors.Is(err, ErrStale) || got != nil {
				t.Fatalf("late request bypassed CAS: detail=%v err=%v", got, err)
			}
			after, err := json.Marshal(repo.a.Config)
			must(t, err)
			if string(before) != string(after) || repo.writes != writes || d.Config.Draft.SaveReceipt.SubmissionID != first.SubmissionID {
				t.Fatal("late request changed the winning draft or receipt")
			}
		})
	}
}

type afterDraftSaveRepo struct {
	*memoryRepo
	afterSave func(context.Context, int64)
}

func (r *afterDraftSaveRepo) CompareAndSwap(ctx context.Context, id, expected int64, c *Config) error {
	if err := r.memoryRepo.CompareAndSwap(ctx, id, expected, c); err != nil {
		return err
	}
	if r.afterSave != nil {
		r.afterSave(ctx, id)
	}
	return nil
}

func TestSaveDraftReceiptIsAtomicAndAvailableAfterLostResponse(t *testing.T) {
	for _, initialized := range []bool{false, true} {
		t.Run(map[bool]string{false: "first_save", true: "existing_config"}[initialized], func(t *testing.T) {
			_, base := fixture()
			expected := int64(0)
			if initialized {
				_, err := NewService(base).Initialize(t.Context(), 7, []string{"image"})
				must(t, err)
				expected = 1
			}
			observed := false
			r := &afterDraftSaveRepo{memoryRepo: base}
			r.afterSave = func(ctx context.Context, id int64) {
				a, err := base.Get(ctx, id)
				must(t, err)
				receipt := a.Config.Draft.SaveReceipt
				if receipt == nil || receipt.SubmissionID != testSubmissionID || receipt.BaseRecordVersion != expected || receipt.DraftRevision != a.Config.Draft.Revision || len(a.Config.Draft.Products) != 1 || a.Config.RecordVersion != expected+1 || a.Config.Validation.Status != "UNKNOWN" {
					t.Fatalf("first CAS did not persist draft and receipt together: %+v", a.Config)
				}
				observed = true
			}
			s := NewService(r)
			input := DraftInput{SubmissionID: testSubmissionID, Products: []Product{{ProductID: "p", MediaType: "image", UpstreamModel: "model-a"}}}
			// Intentionally ignore the PUT-like result: a GET alone must identify
			// the submission even when its response never reaches the client.
			_, err := s.SaveDraft(t.Context(), 7, expected, input)
			must(t, err)
			d, err := s.Detail(t.Context(), 7)
			must(t, err)
			if !observed || d.Config.Draft.SaveReceipt == nil || *d.Config.Draft.SaveReceipt != (SaveReceipt{SubmissionID: testSubmissionID, BaseRecordVersion: expected, DraftRevision: d.Config.Draft.Revision}) {
				t.Fatalf("GET did not identify the lost-response submission: %+v", d.Config.Draft)
			}
			if d.Config.Validation.Status != "FAIL" {
				t.Fatalf("incomplete business fields must save with normal validation FAIL: %+v", d.Config.Validation)
			}
			writes := base.writes
			if d, err := s.SaveDraft(t.Context(), 7, expected, input); !errors.Is(err, ErrStale) || d != nil || base.writes != writes {
				t.Fatalf("repeating an old CAS wrote or returned a false receipt: detail=%v err=%v writes=%d want=%d", d, err, base.writes, writes)
			}
		})
	}
}

func TestSaveDraftRejectsInvalidSubmissionIDBeforeWriting(t *testing.T) {
	for _, id := range []string{"not-a-uuid", strings.Repeat("a", 1024), "550e8400e29b41d4a716446655440000", "550e8400-e29b-41d4-a716-44665544000z", " 550e8400-e29b-41d4-a716-446655440000"} {
		s, r := validatorFixture(t)
		writes := r.writes
		if d, err := s.SaveDraft(t.Context(), 7, 1, DraftInput{SubmissionID: id, Products: []Product{validProduct()}}); !errors.Is(err, ErrInvalid) || d != nil || r.writes != writes {
			t.Fatalf("invalid ID must fail without persistence: detail=%v err=%v writes=%d", d, err, r.writes)
		}
	}
}

func TestSaveDraftLegacyClientClearsPreviousReceipt(t *testing.T) {
	s, _ := validatorFixture(t)
	d, err := s.SaveDraft(t.Context(), 7, 1, DraftInput{SubmissionID: testSubmissionID, Products: []Product{validProduct()}})
	must(t, err)
	d, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion, DraftInput{Products: d.Config.Draft.Products})
	must(t, err)
	if d.Config.Draft.SaveReceipt != nil || d.Config.Validation.Status != "PASS" {
		t.Fatalf("old client inherited a receipt or could not save: %+v", d.Config.Draft)
	}
	encoded, err := json.Marshal(d.Config.Draft)
	must(t, err)
	if strings.Contains(string(encoded), "save_receipt") {
		t.Fatal("absent receipt must remain omitted for legacy drafts")
	}
	var legacy Draft
	must(t, json.Unmarshal([]byte(`{"revision":"legacy","based_on_published_revision":"","updated_at":"2026-10-01T00:00:00Z","products":[]}`), &legacy))
	if legacy.SaveReceipt != nil || legacy.Revision != "legacy" {
		t.Fatal("old persisted draft is no longer readable")
	}
}

func TestSaveDraftUnknownPreservesOwnReceipt(t *testing.T) {
	_, base := validatorFixture(t)
	s := NewService(&unavailableRepo{memoryRepo: base})
	d, err := s.SaveDraft(t.Context(), 7, 1, DraftInput{SubmissionID: testSubmissionID, Products: []Product{validProduct()}})
	must(t, err)
	if d.Config.Validation.Status != "UNKNOWN" || d.Config.Draft.SaveReceipt == nil || d.Config.Draft.SaveReceipt.SubmissionID != testSubmissionID || *d.Config.Draft.SaveReceipt != *base.a.Config.Draft.SaveReceipt {
		t.Fatalf("read failure lost this submission's receipt: %+v", d.Config)
	}
}

func TestSaveDraftCannotConfirmReplacement(t *testing.T) {
	cases := []struct {
		name       string
		submission string
		replace    func(*Draft)
	}{
		{"different_revision", testSubmissionID, func(d *Draft) { d.Revision = "newer-draft" }},
		{"same_revision_different_submission", testSubmissionID, func(d *Draft) { d.SaveReceipt.SubmissionID = nextSubmissionID }},
		{"same_revision_different_base", testSubmissionID, func(d *Draft) { d.SaveReceipt.BaseRecordVersion++ }},
		{"same_revision_missing_receipt", testSubmissionID, func(d *Draft) { d.SaveReceipt = nil }},
		{"legacy_same_content_new_write", "", func(d *Draft) { d.UpdatedAt = d.UpdatedAt.Add(time.Second) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, base := validatorFixture(t)
			r := &afterDraftSaveRepo{memoryRepo: base}
			r.afterSave = func(ctx context.Context, id int64) {
				a, err := base.Get(ctx, id)
				must(t, err)
				expected := a.Config.RecordVersion
				tc.replace(&a.Config.Draft)
				a.Config.RecordVersion++
				must(t, base.CompareAndSwap(ctx, id, expected, a.Config))
			}
			d, err := NewService(r).SaveDraft(t.Context(), 7, 1, DraftInput{SubmissionID: tc.submission, Products: []Product{validProduct()}})
			if !errors.Is(err, ErrStale) || d != nil || base.writes != 3 {
				t.Fatalf("replacement was confirmed or overwritten: detail=%v err=%v writes=%d", d, err, base.writes)
			}
		})
	}
}

type staleValidationReceiptRepo struct {
	*memoryRepo
	checks   int
	replace  bool
	failRead bool
}

func (r *staleValidationReceiptRepo) Get(ctx context.Context, id int64) (*Account, error) {
	if r.failRead && r.checks == 3 {
		return nil, errors.New("local read unavailable")
	}
	return r.memoryRepo.Get(ctx, id)
}

func (r *staleValidationReceiptRepo) CompareAndSwapChecked(ctx context.Context, id, expected int64, _ Dependencies, _ *Config) error {
	r.checks++
	if r.replace && r.checks == 3 {
		a, err := r.memoryRepo.Get(ctx, id)
		if err != nil {
			return err
		}
		a.Config.Draft.SaveReceipt.SubmissionID = nextSubmissionID
		a.Config.RecordVersion++
		if err := r.CompareAndSwap(ctx, id, expected, a.Config); err != nil {
			return err
		}
	}
	return ErrStale
}

func TestSaveDraftValidationRetryLimitChecksOwnReceipt(t *testing.T) {
	for _, tc := range []struct {
		name              string
		replace, failRead bool
	}{
		{"own_receipt", false, false},
		{"replacement", true, false},
		{"read_failure", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, base := validatorFixture(t)
			r := &staleValidationReceiptRepo{memoryRepo: base, replace: tc.replace, failRead: tc.failRead}
			d, err := NewService(r).SaveDraft(t.Context(), 7, 1, DraftInput{SubmissionID: testSubmissionID, Products: []Product{validProduct()}})
			if r.checks != 3 {
				t.Fatalf("unexpected local validation attempts: %d", r.checks)
			}
			if tc.replace {
				if !errors.Is(err, ErrStale) || d != nil {
					t.Fatalf("retry fallback returned someone else's receipt: detail=%v err=%v", d, err)
				}
				return
			}
			must(t, err)
			if d.Config.Draft.SaveReceipt == nil || d.Config.Draft.SaveReceipt.SubmissionID != testSubmissionID || d.Config.Validation.Status != "UNKNOWN" || base.writes != 2 {
				t.Fatalf("retry fallback lost receipt or repeated submission: %+v writes=%d", d.Config, base.writes)
			}
		})
	}
}

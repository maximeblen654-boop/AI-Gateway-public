package repository

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

var mediaColumns = []string{"id", "name", "platform", "type", "status", "schedulable", "base_url", "catalog", "config", "routing"}

func TestMediaCASNoSchedulerSideEffects(t *testing.T) {
	for _, tc := range []struct {
		name     string
		expected int64
		affected int64
		deleted  bool
		want     error
	}{{"initialize", 0, 1, false, nil}, {"draft", 4, 1, false, nil}, {"stale", 4, 0, false, mediaworkbench.ErrStale}, {"deleted", 4, 0, true, mediaworkbench.ErrNotFound}} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				mock.ExpectClose()
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			})
			r := NewMediaConfigRepository(db)
			c := &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: tc.expected + 1}
			body, _ := json.Marshal(c)
			mock.ExpectExec(regexp.QuoteMeta(mediaConfigCAS)).WithArgs(string(body), int64(7), tc.expected).WillReturnResult(sqlmock.NewResult(0, tc.affected))
			if tc.affected == 0 {
				rows := sqlmock.NewRows(mediaColumns)
				if !tc.deleted {
					rows.AddRow(7, "supplier", "openai", "apikey", "active", true, "https://example.com", nil, nil, `{"has_key":true}`)
				}
				mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(rows)
			}
			err = r.CompareAndSwap(context.Background(), 7, tc.expected, c)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
			// No outbox insert, generic account update, or cache query is permitted.
			if err = mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestMediaReadProjection(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		mock.ExpectClose()
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	r := NewMediaConfigRepository(db)
	mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE deleted_at IS NULL AND type='apikey' ORDER BY id`)).WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(7, "supplier", "openai", "apikey", "inactive", false, "https://user:secret@example.com/private?key=secret", `{"models":["m"],"synced_at":"now","api_key":"secret"}`, nil, `{"has_key":true}`))
	d, err := mediaworkbench.NewService(r).Suppliers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "api_key") || d[0].EffectiveState != "ACCOUNT_INACTIVE" {
		t.Fatal(string(b))
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
func TestMediaGenericExtraProtection(t *testing.T) {
	in := map[string]any{"media_workbench_v1": map[string]any{"record_version": 99}, "other": true}
	out := stripMediaConfigExtra(in)
	if _, ok := out["media_workbench_v1"]; ok {
		t.Fatal("generic write bypass")
	}
	if len(in) != 2 || out["other"] != true {
		t.Fatal("mutated input/unrelated fields")
	}
}

func TestMediaGenericWritesCannotBypassCAS(t *testing.T) {
	r := newAccountRepositoryWithSQL(nil, nil, nil)
	if err := r.UpdateExtra(context.Background(), 7, map[string]any{"media_workbench_v1": nil}); err != nil {
		t.Fatal(err)
	}
	n, err := r.BulkUpdate(context.Background(), []int64{7}, service.AccountBulkUpdate{Extra: map[string]any{"media_workbench_v1": map[string]any{"record_version": 999}}})
	if err != nil || n != 0 {
		t.Fatalf("generic write was not ignored: %d %v", n, err)
	}
}

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
					rows.AddRow(7, "supplier", "openai", "apikey", "active", true, "https://example.com", nil, nil, `{"has_key":true,"endpoint_capabilities":[]}`)
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
	mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE deleted_at IS NULL AND (type='apikey' OR (platform IN ('openai','grok','gemini') AND type IN ('oauth','setup-token','service_account'))) ORDER BY id`)).WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(7, "supplier", "openai", "apikey", "inactive", false, "https://user:secret@example.com/private?key=secret", `{"models":["m"],"synced_at":"now","api_key":"secret"}`, nil, `{"has_key":true,"endpoint_capabilities":["seedance"]}`))
	d, err := mediaworkbench.NewService(r).Suppliers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "api_key") || d[0].EffectiveState != "ACCOUNT_INACTIVE" {
		t.Fatal(string(b))
	}
	if got := d[0].NativeAdapters["video"].Kind; got != "seedance_video" {
		t.Fatalf("native video adapter = %q", got)
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

func TestMediaCatalogChangeProjectionDoesNotAffectRoutingOrDependencies(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	r := NewMediaConfigRepository(db)
	if !strings.Contains(mediaAccountProjection, "'model_catalog_change', extra->'studio_model_catalog_change_v1'") {
		t.Fatal("change metadata must use the existing narrow JSON projection")
	}
	const catalog = `{"source":"upstream","models":["keep"],"synced_at":"2026-10-21T00:00:00Z","account_identity_sha256":"identity-a"}`
	const config = `{"schema_version":1,"record_version":1,"published":{"dependencies":{"catalog_sha256":"legacy"},"products":[]}}`
	var baseline *mediaworkbench.Account
	for _, tc := range []struct{ name, routing string }{
		{"old row without change", `{"has_key":true,"endpoint_capabilities":[]}`},
		{"new notice", `{"has_key":true,"endpoint_capabilities":[],"model_catalog_change":{"schema_version":1,"account_identity_sha256":"identity-a","detected_at":"2026-10-21T00:00:00Z","previous_synced_at":"2026-10-20T00:00:00Z","added_count":1,"missing_count":0,"added_models":["keep"],"missing_models":[],"truncated":false,"api_key":"secret-not-projected"}}`},
		{"cleared notice", `{"has_key":true,"endpoint_capabilities":[],"model_catalog_change":null}`},
		{"malformed notice", `{"has_key":true,"endpoint_capabilities":[],"model_catalog_change":{"schema_version":1,"added_count":"invalid"}}`},
		{"future schema", `{"has_key":true,"endpoint_capabilities":[],"model_catalog_change":{"schema_version":2,"account_identity_sha256":"identity-a"}}`},
		{"wrong catalog identity", `{"has_key":true,"endpoint_capabilities":[],"model_catalog_change":{"schema_version":1,"account_identity_sha256":"identity-b"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).
				WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(7, "supplier", "openai", "apikey", "active", true, "https://api.image2pro.top/v1", catalog, config, tc.routing))
			a, err := r.Get(context.Background(), 7)
			if err != nil {
				t.Fatal(err)
			}
			if baseline == nil {
				baseline = a
				if a.CatalogChange != nil || !a.RuntimeReady {
					t.Fatalf("old row failed compatibility: %+v", a)
				}
			}
			if a.RuntimeReady != baseline.RuntimeReady || a.RoutingFingerprint != baseline.RoutingFingerprint || mediaworkbench.DependenciesFor(a) != mediaworkbench.DependenciesFor(baseline) || mediaworkbench.PublishedDependenciesFor(a) != mediaworkbench.PublishedDependenciesFor(baseline) {
				t.Fatal("change notice entered runtime readiness, routing, or immutable dependency identity")
			}
			body, _ := json.Marshal(a)
			if strings.Contains(string(body), "secret-not-projected") || strings.Contains(string(body), "api_key") {
				t.Fatalf("projection leaked an unexpected field: %s", body)
			}
			if tc.name == "new notice" {
				if a.CatalogChange == nil || a.CatalogChange.AddedCount != 1 || len(a.CatalogChange.AddedModels) != 1 || a.CatalogChange.AddedModels[0] != "keep" {
					t.Fatalf("notice missing from narrow projection: %s", body)
				}
			} else if a.CatalogChange != nil || strings.Contains(string(body), "model_catalog_change") {
				t.Fatalf("absent notice is not omitted for legacy/cleared rows: %s", body)
			}
		})
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

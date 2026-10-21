package mediaworkbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func catalogChangeFixture(at string, models ...string) *Catalog {
	return &Catalog{Source: "upstream", SyncedAt: at, AccountIdentitySHA256: "identity-a", Models: models}
}

func TestCatalogChangeFirstObservationAndIdentityChangeOnlyEstablishBaseline(t *testing.T) {
	for _, tc := range []struct {
		name string
		old  *Catalog
	}{
		{"first success", nil},
		{"legacy identity", &Catalog{Source: "upstream", SyncedAt: "old", Models: []string{"old"}}},
		{"different identity", &Catalog{Source: "upstream", SyncedAt: "old", AccountIdentitySHA256: "identity-b", Models: []string{"old"}}},
		{"no successful timestamp", &Catalog{Source: "upstream", AccountIdentitySHA256: "identity-a", Models: []string{"old"}}},
		{"not an upstream observation", &Catalog{Source: "configured", SyncedAt: "old", AccountIdentitySHA256: "identity-a", Models: []string{"old"}}},
		{"empty old catalog", catalogChangeFixture("old")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			last := &CatalogChange{SchemaVersion: 1, AccountIdentitySHA256: "identity-b", AddedCount: 1, AddedModels: []string{"old"}}
			got, err := CatalogChangeFor(tc.old, catalogChangeFixture("new", "new"), last)
			if err != nil || got != nil {
				t.Fatalf("new baseline must clear prior notice: got %+v, %v", got, err)
			}
		})
	}
}

func TestCatalogChangeRejectsEmptyCurrentObservation(t *testing.T) {
	for _, current := range []*Catalog{nil, catalogChangeFixture("new"), catalogChangeFixture("new", "", " \t ")} {
		got, err := CatalogChangeFor(catalogChangeFixture("old", "keep"), current, nil)
		if !errors.Is(err, ErrInvalid) || got != nil {
			t.Fatalf("empty response must not become a missing-model observation: %+v, %v", got, err)
		}
	}
}

func TestCatalogChangeComparesNormalizedSetsWithoutChangingCatalogs(t *testing.T) {
	old := catalogChangeFixture("2026-10-20T00:00:00Z", "old-z", "keep", "old-a", "old-z", " ")
	current := catalogChangeFixture("2026-10-21T00:00:00Z", "new-z", " keep ", "new-a", "new-a", "")
	oldBody, _ := json.Marshal(old)
	currentBody, _ := json.Marshal(current)
	got, err := CatalogChangeFor(old, current, nil)
	want := &CatalogChange{
		SchemaVersion: 1, AccountIdentitySHA256: "identity-a",
		DetectedAt: current.SyncedAt, PreviousSyncedAt: old.SyncedAt,
		AddedCount: 2, MissingCount: 2,
		AddedModels: []string{"new-a", "new-z"}, MissingModels: []string{"old-a", "old-z"},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, %v; want %+v", got, err, want)
	}
	afterOld, _ := json.Marshal(old)
	afterCurrent, _ := json.Marshal(current)
	if string(oldBody) != string(afterOld) || string(currentBody) != string(afterCurrent) {
		t.Fatal("comparison changed the business catalog")
	}
}

func TestCatalogChangeUnchangedKeepsLastNoticeWithoutTimestampGrowth(t *testing.T) {
	last := &CatalogChange{SchemaVersion: 1, AccountIdentitySHA256: "identity-a", DetectedAt: "earlier", AddedCount: 1, AddedModels: []string{"keep"}, MissingModels: []string{}}
	old := catalogChangeFixture("old", "keep", "another")
	for _, at := range []string{"new", "newer", "newest"} {
		got, err := CatalogChangeFor(old, catalogChangeFixture(at, " another ", "keep", "keep"), last)
		if err != nil || !reflect.DeepEqual(got, last) || got.DetectedAt != "earlier" {
			t.Fatalf("unchanged success grew or lost the notice: %+v, %v", got, err)
		}
	}
	for _, stale := range []*CatalogChange{nil, {SchemaVersion: 2, AccountIdentitySHA256: "identity-a"}, {SchemaVersion: 1, AccountIdentitySHA256: "identity-b"}} {
		got, err := CatalogChangeFor(old, catalogChangeFixture("new", "keep", "another"), stale)
		if err != nil || got != nil {
			t.Fatalf("retained a notice from another identity/schema: %+v, %v", got, err)
		}
	}
}

func TestCatalogChangeBoundsDisplayWithoutTruncatingIDsOrCounts(t *testing.T) {
	old := catalogChangeFixture("old", "keep")
	current := catalogChangeFixture("new", "keep")
	for i := 24; i >= 0; i-- {
		old.Models = append(old.Models, fmt.Sprintf("old-%02d", i))
		current.Models = append(current.Models, fmt.Sprintf("new-%02d", i))
	}
	long := strings.Repeat("x", 257)
	old.Models = append(old.Models, long)
	current.Models = append(current.Models, "a"+long)
	got, err := CatalogChangeFor(old, current, nil)
	if err != nil || got.AddedCount != 26 || got.MissingCount != 26 || !got.Truncated || len(got.AddedModels) != 20 || len(got.MissingModels) != 20 {
		t.Fatalf("incorrect bounded counts: %+v, %v", got, err)
	}
	if got.AddedModels[0] != "new-00" || got.AddedModels[19] != "new-19" || got.MissingModels[19] != "old-19" || len(current.Models) != 27 {
		t.Fatalf("display order or business catalog was truncated: %+v", got)
	}
	for _, model := range append(append([]string{}, got.AddedModels...), got.MissingModels...) {
		if len(model) > 256 || model == long[:256] || model == ("a" + long)[:256] {
			t.Fatalf("displayed oversized or partial ID: %q", model)
		}
	}
}

func TestCatalogChangeByteBoundaryAndEmptyArrays(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
		show bool
	}{
		{"exact byte limit", strings.Repeat("a", 256), true},
		{"over byte limit", strings.Repeat("a", 257), false},
		{"unicode within byte limit", strings.Repeat("图", 85), true},
		{"unicode over byte limit", strings.Repeat("图", 86), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CatalogChangeFor(catalogChangeFixture("old", "keep"), catalogChangeFixture("new", "keep", tc.id), nil)
			if err != nil || got.AddedCount != 1 || got.MissingCount != 0 || got.Truncated == tc.show || len(got.MissingModels) != 0 {
				t.Fatalf("incorrect byte-boundary notice: %+v, %v", got, err)
			}
			if tc.show && (len(got.AddedModels) != 1 || got.AddedModels[0] != tc.id) || !tc.show && len(got.AddedModels) != 0 {
				t.Fatalf("must preserve or omit complete ID: %+v", got)
			}
			body, _ := json.Marshal(got)
			if !strings.Contains(string(body), `"missing_models":[]`) || strings.Contains(string(body), `"added_models":null`) {
				t.Fatalf("display lists must be arrays: %s", body)
			}
		})
	}
}

func TestCatalogChangeDoesNotAffectBusinessOrPublishedDependencies(t *testing.T) {
	for _, scope := range []string{"legacy", publishedCatalogPrefix + "fixture"} {
		t.Run(scope, func(t *testing.T) {
			a := &Account{
				ID: 7, Platform: "openai", Type: "apikey", BaseURL: "https://api.image2pro.top/v1",
				Catalog: catalogChangeFixture("old", "keep"), ModelMapping: map[string]string{"site": "keep"},
				Config: &Config{Published: &Published{Dependencies: Dependencies{CatalogSHA256: scope}, Products: []Product{{Enabled: true, UpstreamModel: "keep"}}}},
			}
			deps, published := DependenciesFor(a), PublishedDependenciesFor(a)
			catalogHash := hash(a.Catalog)
			config, _ := json.Marshal(a.Config)
			a.CatalogChange = &CatalogChange{SchemaVersion: 1, AccountIdentitySHA256: "identity-a", AddedModels: []string{"observed"}, AddedCount: 1, MissingModels: []string{}}
			if DependenciesFor(a) != deps || PublishedDependenciesFor(a) != published || hash(a.Catalog) != catalogHash {
				t.Fatal("observation metadata changed routing, catalog, or Published dependency identity")
			}
			afterConfig, _ := json.Marshal(a.Config)
			if string(config) != string(afterConfig) {
				t.Fatal("observation changed stored draft or Published document")
			}
		})
	}
}

func TestCatalogChangeIncludesImageVideoAndMixedCatalogIDs(t *testing.T) {
	for _, tc := range []struct {
		name              string
		previous, current []string
	}{
		{"image only", []string{"gpt-image-2-old"}, []string{"gpt-image-2-new"}},
		{"video only", []string{"sora-2-old"}, []string{"sora-2-new"}},
		{"mixed", []string{"gpt-image-2-old", "sora-2-old"}, []string{"gpt-image-2-new", "sora-2-new"}},
		{"opaque IDs need no media inference", []string{"id-12345"}, []string{"id-98765"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CatalogChangeFor(catalogChangeFixture("old", tc.previous...), catalogChangeFixture("new", tc.current...), nil)
			if err != nil || got.AddedCount != len(tc.current) || got.MissingCount != len(tc.previous) || !reflect.DeepEqual(got.AddedModels, tc.current) || !reflect.DeepEqual(got.MissingModels, tc.previous) {
				t.Fatalf("ID observation must include every media kind without classifying it: %+v, %v", got, err)
			}
		})
	}
}

func TestCatalogChangeUnchangedBoundsPreviouslyStoredNotice(t *testing.T) {
	last := &CatalogChange{SchemaVersion: 1, AccountIdentitySHA256: "identity-a", DetectedAt: "earlier", PreviousSyncedAt: "earliest", MissingModels: []string{}}
	for i := 0; i < 25; i++ {
		last.AddedModels = append(last.AddedModels, fmt.Sprintf("id-%02d", i))
	}
	last.AddedModels = append([]string{strings.Repeat("a", 257)}, last.AddedModels...)
	last.AddedCount = len(last.AddedModels)
	before, _ := json.Marshal(last)
	got, err := CatalogChangeFor(catalogChangeFixture("old", "keep"), catalogChangeFixture("new", "keep"), last)
	if err != nil || got.DetectedAt != "earlier" || got.PreviousSyncedAt != "earliest" || got.AddedCount != 26 || len(got.AddedModels) != 20 || got.AddedModels[0] != "id-00" || !got.Truncated {
		t.Fatalf("unchanged observation spread an unbounded prior notice: %+v, %v", got, err)
	}
	after, _ := json.Marshal(last)
	if string(before) != string(after) {
		t.Fatal("bounding mutated the input notice")
	}
}

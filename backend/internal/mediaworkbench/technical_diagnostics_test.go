package mediaworkbench

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func persistedLegacyTechnicalFixture(t *testing.T) (*Service, *memoryRepo) {
	t.Helper()
	s, r := validatorFixture(t)
	a := &r.a
	a.BaseURL = "https://video.laoliimage2.win"
	a.Catalog.Models = []string{"3.0"}
	d, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{laoliVideoProduct("3.0")}})
	require.NoError(t, err)
	_, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	a.Config.Draft.Products[0].AdapterConfig.WireProfile = "inline_multimedia"
	a.Config.Validation = Validation{
		Status: "FAIL", PublishReady: false, CheckedAt: time.Date(2026, 10, 24, 1, 2, 3, 0, time.UTC),
		DraftRevision: a.Config.Draft.Revision,
		Diagnostics: []Diagnostic{
			diagnostic("NEEDS_DEVELOPMENT", "VIDEO_PROFILE_UNSUPPORTED", "new-video", "adapter_config.wire_profile", "旧持久化视频错误"),
			diagnostic("UI_FIXABLE", "PRICE_REQUIRED", "new-video", "pricing_rules", "保留售价错误"),
			diagnostic("UI_FIXABLE", "INVALID_REFERENCE_LIMIT", "new-video", "capabilities.count", "保留普通能力错误"),
			diagnostic("UI_FIXABLE", "ACCOUNT_ENDPOINT_INVALID", "", "account", "保留账号错误"),
			diagnostic("NEEDS_DEVELOPMENT", "VIDEO_PROFILE_UNSUPPORTED", "another-product", "adapter_config.wire_profile", "保留其他商品错误"),
		},
	}
	return s, r
}

func requireModelState(t *testing.T, d *Detail, model, state string) {
	t.Helper()
	for _, m := range d.Models {
		if m.ModelID == model {
			require.Equal(t, state, m.State)
			return
		}
	}
	t.Fatalf("model %s missing", model)
}

func TestCurrentTechnicalDiagnosticsRefreshesPersistedFailureWithoutWrites(t *testing.T) {
	for _, read := range []string{"detail", "suppliers"} {
		t.Run(read, func(t *testing.T) {
			s, r := persistedLegacyTechnicalFixture(t)
			before, writes := hash(r.a.Config), r.writes
			oldValidation, published := hash(r.a.Config.Validation), hash(r.a.Config.Published)
			var d *Detail
			if read == "detail" {
				var err error
				d, err = s.Detail(t.Context(), 7)
				require.NoError(t, err)
			} else {
				details, err := s.Suppliers(t.Context())
				require.NoError(t, err)
				require.Len(t, details, 1)
				d = &details[0]
			}
			require.NotNil(t, d.CurrentTechnicalDiagnostics)
			projection := d.CurrentTechnicalDiagnostics
			require.Equal(t, "current_local_video_technical_check", projection.Source)
			require.True(t, projection.CheckedAt.After(r.a.Config.Validation.CheckedAt))
			require.Equal(t, []string{"new-video"}, projection.TargetProductIDs)
			projected := Validation{Diagnostics: projection.Diagnostics}
			requireVideoDiagnostic(t, projected, "VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED", "UI_FIXABLE", "adapter_config.wire_profile")
			for _, diagnostic := range projection.Diagnostics {
				require.False(t, diagnostic.Code == "VIDEO_PROFILE_UNSUPPORTED" && diagnostic.Scope == "new-video")
			}
			for _, keep := range r.a.Config.Validation.Diagnostics[1:] {
				require.Contains(t, projection.Diagnostics, keep)
			}
			requireModelState(t, d, "3.0", "UI_FIXABLE")
			require.Equal(t, writes, r.writes)
			require.Equal(t, before, hash(r.a.Config))
			require.Equal(t, before, hash(d.Config))
			require.Equal(t, oldValidation, hash(d.Config.Validation))
			require.Equal(t, published, hash(d.Config.Published))
			require.False(t, d.Config.Validation.PublishReady)
		})
	}
}

func TestCurrentTechnicalDiagnosticsKeepsRealDevelopmentRequirementFirst(t *testing.T) {
	s, r := persistedLegacyTechnicalFixture(t)
	r.a.Config.Draft.Products[0].Capabilities.Count.Max = 2
	before, writes := hash(r.a.Config), r.writes
	d, err := s.Detail(t.Context(), 7)
	require.NoError(t, err)
	require.NotNil(t, d.CurrentTechnicalDiagnostics)
	v := Validation{Diagnostics: d.CurrentTechnicalDiagnostics.Diagnostics}
	requireVideoDiagnostic(t, v, "VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED", "UI_FIXABLE", "adapter_config.wire_profile")
	requireVideoDiagnostic(t, v, "VIDEO_COUNT_UNSUPPORTED", "NEEDS_DEVELOPMENT", "capabilities.count")
	requireModelState(t, d, "3.0", "NEEDS_DEVELOPMENT")
	require.Equal(t, writes, r.writes)
	require.Equal(t, before, hash(r.a.Config))
}

func TestCurrentTechnicalDiagnosticsPreservesMissingCatalogAndModelPriority(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		change     func(*Account)
	}{
		{"missing catalog", "MODEL_SYNC_REQUIRED", func(a *Account) { a.Catalog = nil }},
		{"unsynced catalog", "MODEL_SYNC_REQUIRED", func(a *Account) { a.Catalog.SyncedAt = "" }},
		{"unsynced empty catalog with published product", "MODEL_SYNC_REQUIRED", func(a *Account) { a.Catalog.SyncedAt = ""; a.Catalog.Models = nil }},
		{"removed model", "UPSTREAM_NOT_DISCOVERED", func(a *Account) { a.Catalog.Models = []string{"3.5"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := persistedLegacyTechnicalFixture(t)
			tc.change(&r.a)
			before, writes := hash(r.a.Config), r.writes
			d, err := s.Detail(t.Context(), 7)
			require.NoError(t, err)
			require.Nil(t, d.CurrentTechnicalDiagnostics)
			requireModelState(t, d, "3.0", tc.want)
			require.Equal(t, writes, r.writes)
			require.Equal(t, before, hash(d.Config))
		})
	}
}

func TestCurrentTechnicalDiagnosticsPreservesGenericMalformedRatio(t *testing.T) {
	s, r := persistedLegacyTechnicalFixture(t)
	r.a.Config.Draft.Products[0].Capabilities.AspectRatios = []string{"", ""}
	generic := diagnostic("UI_FIXABLE", "VIDEO_RATIO_INVALID", "new-video", "capabilities.aspect_ratios", "保留普通能力比例错误")
	r.a.Config.Validation.Diagnostics = append(r.a.Config.Validation.Diagnostics, generic)
	d, err := s.Detail(t.Context(), 7)
	require.NoError(t, err)
	require.Contains(t, d.CurrentTechnicalDiagnostics.Diagnostics, generic)
}

func TestCurrentTechnicalDiagnosticsDeduplicatesScopedFieldDiagnostics(t *testing.T) {
	s, r := persistedLegacyTechnicalFixture(t)
	r.a.Config.Validation.Diagnostics = append(r.a.Config.Validation.Diagnostics, r.a.Config.Validation.Diagnostics[1:]...)
	d, err := s.Detail(t.Context(), 7)
	require.NoError(t, err)
	seen := map[[3]string]bool{}
	for _, diagnostic := range d.CurrentTechnicalDiagnostics.Diagnostics {
		key := [3]string{diagnostic.Scope, diagnostic.Code, diagnostic.Path}
		require.False(t, seen[key], "duplicate diagnostic %v", key)
		seen[key] = true
	}
}

func TestCurrentTechnicalDiagnosticsLeavesImageModelStateOrderUnchanged(t *testing.T) {
	s, r := persistedLegacyTechnicalFixture(t)
	p := validProduct()
	p.ProductID = "other-model-product"
	r.a.Config.Draft.Products = append(r.a.Config.Draft.Products, p)
	r.a.Catalog.Models = append(r.a.Catalog.Models, p.UpstreamModel)
	r.a.Config.Validation.Diagnostics = append(r.a.Config.Validation.Diagnostics,
		diagnostic("UI_FIXABLE", "PRICE_REQUIRED", p.ProductID, "pricing_rules", "保留首条普通错误"),
		diagnostic("NEEDS_DEVELOPMENT", "OTHER_CAPABILITY_UNSUPPORTED", p.ProductID, "capabilities", "保留原先其他型号排序"))
	d, err := s.Detail(t.Context(), 7)
	require.NoError(t, err)
	require.Equal(t, []string{"new-video"}, d.CurrentTechnicalDiagnostics.TargetProductIDs)
	requireModelState(t, d, p.UpstreamModel, "UI_FIXABLE")
}

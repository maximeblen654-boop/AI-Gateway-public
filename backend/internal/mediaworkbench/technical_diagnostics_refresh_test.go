package mediaworkbench

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func projectedProductValidation(projection *TechnicalDiagnostics, productID string) Validation {
	v := Validation{Diagnostics: []Diagnostic{}}
	for _, d := range projection.Diagnostics {
		if d.Scope == productID {
			v.Diagnostics = append(v.Diagnostics, d)
		}
	}
	return v
}

// The persisted validation was written by an older program. The draft already
// uses the installed profile, so saving it again must not be needed to refresh.
func TestCurrentTechnicalDiagnosticsRechecksInstalledProfilesOnRead(t *testing.T) {
	for _, model := range []string{"3.0", "wan-3.0-video-ref", "wan-3.0-no-video-ref", "sd-native-full-2.5"} {
		for _, read := range []string{"detail", "suppliers"} {
			t.Run(model+"/"+read, func(t *testing.T) {
				s, r := persistedLegacyTechnicalFixture(t)
				p := &r.a.Config.Draft.Products[0]
				p.AdapterConfig = r.a.Config.Published.Products[0].AdapterConfig
				p.UpstreamModel, p.SiteModel = model, model
				p.Capabilities.AspectRatios = nil
				r.a.Catalog.Models = []string{model}
				before, writes := hash(r.a.Config), r.writes
				for range 2 {
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
					require.Equal(t, []string{p.ProductID}, projection.TargetProductIDs)
					v := projectedProductValidation(projection, p.ProductID)
					require.False(t, hasCode(v, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT"))
					require.False(t, hasCode(v, "VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED", "UI_FIXABLE"))
					requireVideoDiagnostic(t, v, "VIDEO_RATIO_REQUIRED", "UI_FIXABLE", "capabilities.aspect_ratios")
					require.Contains(t, projection.Diagnostics, r.a.Config.Validation.Diagnostics[1])
					requireModelState(t, d, model, "UI_FIXABLE")
					require.Equal(t, before, hash(d.Config))
					require.Equal(t, before, hash(r.a.Config))
					require.Equal(t, writes, r.writes)
					require.False(t, d.Config.Validation.PublishReady)
				}
			})
		}
	}
}

func TestCurrentTechnicalDiagnosticsRechecksUnsupportedAndCorrectedSiblings(t *testing.T) {
	for _, tc := range []struct {
		name, code, path string
		change           func(*Product)
	}{
		{"count", "VIDEO_COUNT_UNSUPPORTED", "capabilities.count", func(p *Product) { p.Capabilities.Count.Max = 2 }},
		{"profile", "VIDEO_PROFILE_UNSUPPORTED", "adapter_config.wire_profile", func(p *Product) { p.AdapterConfig.WireProfile = "future_profile" }},
		{"version", "VIDEO_PROFILE_UNSUPPORTED", "adapter_config.version", func(p *Product) { p.AdapterConfig.Version = 2 }},
		{"model family", "VIDEO_MODEL_FAMILY_UNSUPPORTED", "adapter_config.model_family", func(p *Product) { p.AdapterConfig.ModelFamily = "future_family" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := persistedLegacyTechnicalFixture(t)
			p := &r.a.Config.Draft.Products[0]
			p.AdapterConfig = r.a.Config.Published.Products[0].AdapterConfig
			sibling := *p
			sibling.ProductID = "corrected-sibling"
			sibling.UpstreamModel, sibling.SiteModel = "wan-3.0-video-ref", "wan-3.0-video-ref"
			tc.change(p)
			r.a.Config.Draft.Products = append(r.a.Config.Draft.Products, sibling)
			r.a.Catalog.Models = append(r.a.Catalog.Models, sibling.UpstreamModel)
			r.a.Config.Validation.Diagnostics = append(r.a.Config.Validation.Diagnostics,
				diagnostic("NEEDS_DEVELOPMENT", "VIDEO_PROFILE_UNSUPPORTED", sibling.ProductID, "adapter_config.wire_profile", "stale sibling failure"))
			before, writes := hash(r.a.Config), r.writes
			d, err := s.Detail(t.Context(), 7)
			require.NoError(t, err)
			require.NotNil(t, d.CurrentTechnicalDiagnostics)
			require.Equal(t, []string{"corrected-sibling", "new-video"}, d.CurrentTechnicalDiagnostics.TargetProductIDs)
			requireVideoDiagnostic(t, projectedProductValidation(d.CurrentTechnicalDiagnostics, p.ProductID), tc.code, "NEEDS_DEVELOPMENT", tc.path)
			requireModelState(t, d, "3.0", "NEEDS_DEVELOPMENT")
			requireModelState(t, d, sibling.UpstreamModel, "DRAFT")
			for _, diagnostic := range d.CurrentTechnicalDiagnostics.Diagnostics {
				require.False(t, diagnostic.Scope == sibling.ProductID && diagnostic.Class == "NEEDS_DEVELOPMENT")
			}
			require.Equal(t, before, hash(d.Config))
			require.Equal(t, before, hash(r.a.Config))
			require.Equal(t, writes, r.writes)
		})
	}
}

func TestCurrentTechnicalDiagnosticsRefreshesProviderMetadataChecks(t *testing.T) {
	for _, drift := range []bool{false, true} {
		t.Run(map[bool]string{false: "current metadata", true: "missing metadata"}[drift], func(t *testing.T) {
			s, r, p := image2ProVideoFixture(t)
			_, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
			require.NoError(t, err)
			r.a.Config.Validation.Status, r.a.Config.Validation.PublishReady = "FAIL", false
			r.a.Config.Validation.Diagnostics = []Diagnostic{diagnostic("NEEDS_DEVELOPMENT", "IMAGE2PRO_VIDEO_ACCOUNT_UNSUPPORTED", p.ProductID, "adapter_config.wire_profile", "stale provider failure")}
			if drift {
				r.a.Image2ProVideoCapabilities = nil
			}
			before, writes := hash(r.a.Config), r.writes
			d, err := s.Detail(t.Context(), 7)
			require.NoError(t, err)
			require.NotNil(t, d.CurrentTechnicalDiagnostics)
			v := Validation{Diagnostics: d.CurrentTechnicalDiagnostics.Diagnostics}
			require.False(t, hasCode(v, "IMAGE2PRO_VIDEO_ACCOUNT_UNSUPPORTED", "NEEDS_DEVELOPMENT"))
			if drift {
				requireVideoDiagnostic(t, v, "IMAGE2PRO_VIDEO_METADATA_REQUIRED", "UI_FIXABLE", "adapter_config.image2pro")
				requireModelState(t, d, p.UpstreamModel, "UI_FIXABLE")
			} else {
				require.Empty(t, v.Diagnostics)
				requireModelState(t, d, p.UpstreamModel, "DRAFT")
			}
			require.Equal(t, before, hash(d.Config))
			require.Equal(t, before, hash(r.a.Config))
			require.Equal(t, writes, r.writes)
		})
	}
}

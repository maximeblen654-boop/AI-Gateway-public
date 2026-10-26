package mediaworkbench

import (
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
)

func TestLaoliLegacyVideoProfileSaveUpgradesOnlyTechnicalProfile(t *testing.T) {
	for _, model := range []string{"wan-3.0-video-ref", "wan-3.0-no-video-ref", "sd-native-full-2.5"} {
		for _, profile := range []string{"images", "inline_multimedia"} {
			t.Run(model+"/"+profile, func(t *testing.T) {
				s, r := validatorFixture(t)
				r.a.BaseURL = "https://video.laoliimage2.win/v1"
				r.a.Catalog.Models = []string{model}
				p := laoliVideoProduct(model)
				p.AdapterConfig = ImageConfig{Version: 1, WireProfile: profile}
				p.CostVersion = MediaRetailVersion
				before := hash(p)
				saved, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
				require.NoError(t, err)
				got := saved.Config.Draft.Products[0]
				require.Equal(t, videoplan.LaoliMediaProfile, got.AdapterConfig.WireProfile)
				got.AdapterConfig.WireProfile = profile
				require.Equal(t, before, hash(got), "upgrade must preserve all operator fields")
				require.True(t, saved.Config.Validation.PublishReady, saved.Config.Validation.Diagnostics)
			})
		}
	}
}

func TestLaoliLegacyVideoProfileValidationExplainsExplicitUpgradeWithoutMutation(t *testing.T) {
	_, r := validatorFixture(t)
	r.a.BaseURL = "https://video.laoliimage2.win"
	r.a.Catalog.Models = []string{"3.0"}
	p := laoliVideoProduct("3.0")
	p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "inline_multimedia"}
	p.CostVersion = MediaRetailVersion
	draft := Draft{Revision: "legacy-profile", Products: []Product{p}}
	before := hash([]any{r.a.Config, draft})
	v, offers := Validate(&r.a, draft, time.Now())
	requireVideoDiagnostic(t, v, "VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED", "UI_FIXABLE", "adapter_config.wire_profile")
	require.False(t, hasCode(v, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT"), v.Diagnostics)
	require.False(t, v.PublishReady)
	require.Empty(t, offers)
	require.Equal(t, before, hash([]any{r.a.Config, draft}))
}

func TestLaoliLegacyVideoProfileRebindPreservesPublishedAndDivergentDraft(t *testing.T) {
	for _, model := range []string{"wan-3.0-video-ref", "wan-3.0-no-video-ref", "sd-native-full-2.5"} {
		for _, profile := range []string{"images", "inline_multimedia"} {
			t.Run(model+"/"+profile, func(t *testing.T) {
				s, r := validatorFixture(t)
				a := &r.a
				a.BaseURL = "https://video.laoliimage2.win"
				a.Catalog.Models = []string{model}
				p := laoliVideoProduct(model)
				p.SiteModel = "customer-video-alias"
				saved, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{p}})
				require.NoError(t, err)
				_, err = s.Publish(t.Context(), 7, saved.Config.RecordVersion, saved.Config.Draft.Revision)
				require.NoError(t, err)
				// Represent the persisted legacy snapshots before the explicit repair.
				oldID := "removed-" + model
				a.Config.Published.Products[0].UpstreamModel = oldID
				a.Config.Published.Products[0].AdapterConfig.WireProfile = profile
				a.Config.Published.Revision = publishedRevision(a.Config.Published)
				a.Config.Draft.Products[0].UpstreamModel = oldID
				a.Config.Draft.Products[0].AdapterConfig.WireProfile = profile
				a.Config.Draft.Products[0].DisplayName = "unsaved new name"
				a.Config.Draft.Products[0].Capabilities.AspectRatios = []string{"9:16"}
				a.Config.Draft.Products[0].PricingRules = []PricingRule{{SalePrice: &Price{Amount: "9.99", Currency: "CNY", BillingMode: "per_request"}}}
				a.Config.ProductLifecycle = map[string]ProductLifecycle{p.ProductID: {State: "unlisted", Revision: 4}}
				a.Catalog.Source, a.Catalog.AccountIdentitySHA256 = "upstream", "same-account-catalog"
				snapshot, err := bindingCandidate(a)
				require.NoError(t, err)
				original, draft := snapshot.Config.Published.Products[0], snapshot.Config.Draft.Products[0]
				beforeSource := a.Config.Published.SourceDraftRevision
				lifecycle, sales, mapping := hash(a.Config.ProductLifecycle), hash(a.Config.Sales), hash(a.ModelMapping)
				historicalHash := hash(snapshot.Config)
				d, err := s.ModelBinding(t.Context(), 7, a.Config.RecordVersion, ModelBindingInput{
					ExpectedDraftRevision: a.Config.Draft.Revision, OldModelID: oldID, NewModelID: model,
					Action: "rebind", ProductIDs: []string{p.ProductID},
				})
				require.NoError(t, err)
				wantPublished := original
				wantPublished.UpstreamModel, wantPublished.AdapterConfig.WireProfile = model, videoplan.LaoliMediaProfile
				require.Equal(t, wantPublished, d.Config.Published.Products[0])
				wantDraft := draft
				wantDraft.UpstreamModel, wantDraft.AdapterConfig.WireProfile = model, videoplan.LaoliMediaProfile
				require.Equal(t, wantDraft, d.Config.Draft.Products[0])
				require.Equal(t, beforeSource, d.Config.Published.SourceDraftRevision)
				require.Equal(t, lifecycle, hash(d.Config.ProductLifecycle))
				require.Equal(t, sales, hash(d.Config.Sales))
				require.Equal(t, mapping, hash(a.ModelMapping))
				require.Equal(t, historicalHash, hash(snapshot.Config), "historical snapshot stays untouched")
				require.NotEmpty(t, productOffers(a, p.ProductID))
				for _, offer := range productOffers(a, p.ProductID) {
					require.Equal(t, model, offer.UpstreamModel)
					require.Equal(t, videoplan.LaoliMediaProfile, offer.ResolvedConfig.WireProfile)
					require.Equal(t, original.PricingRules[0].SalePrice.Amount, offer.SalePrice.Amount)
					require.Equal(t, original.SiteModel, offer.SiteModel)
				}
				require.False(t, d.EffectiveSales, "explicit repair must preserve manual unlisting and paused sales")
			})
		}
	}
}

func TestLaoliLegacyVideoProfileUpgradeRejectsOtherIdentities(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Account, *Product)
	}{
		{"other origin", func(a *Account, _ *Product) { a.BaseURL = "https://supplier.example" }},
		{"lookalike origin", func(a *Account, _ *Product) { a.BaseURL = "https://video.laoliimage2.win.evil" }},
		{"other native adapter", func(a *Account, _ *Product) { a.EndpointCapabilities = []string{"seedance"} }},
		{"other binding", func(a *Account, _ *Product) { a.Config.AdapterBindings["video"] = AdapterBinding{Kind: "grok_video"} }},
		{"binding auth mismatch", func(a *Account, _ *Product) {
			b := a.Config.AdapterBindings["video"]
			b.Auth = "other"
			a.Config.AdapterBindings["video"] = b
		}},
		{"binding task mismatch", func(a *Account, _ *Product) {
			b := a.Config.AdapterBindings["video"]
			b.TaskFlow = "other"
			a.Config.AdapterBindings["video"] = b
		}},
		{"unknown profile", func(_ *Account, p *Product) { p.AdapterConfig.WireProfile = "future_profile" }},
		{"unknown version", func(_ *Account, p *Product) { p.AdapterConfig.Version = 2 }},
		{"unknown exact model", func(a *Account, p *Product) {
			p.UpstreamModel = "future-laoli-model"
			a.Catalog.Models = []string{p.UpstreamModel}
		}},
		{"removed installed model", func(a *Account, _ *Product) { a.Catalog.Models = []string{"3.5"} }},
		{"missing catalog", func(a *Account, _ *Product) { a.Catalog = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := validatorFixture(t)
			a := &r.a
			a.BaseURL = "https://video.laoliimage2.win"
			a.Catalog.Models = []string{"3.0"}
			p := laoliVideoProduct("3.0")
			p.CostVersion = MediaRetailVersion
			p.AdapterConfig = ImageConfig{Version: 1, WireProfile: "inline_multimedia"}
			tc.change(a, &p)
			before := p.AdapterConfig
			require.False(t, canUpgradeLegacyLaoliVideoProfile(a, p, bindingsFor(a, a.Config.MediaTypes)["video"]))
			// Explicit saves preserve unsupported input for diagnosis; they do
			// not silently migrate another account, model, version or profile.
			d, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			require.NoError(t, err)
			require.Equal(t, before, d.Config.Draft.Products[0].AdapterConfig)
			if tc.name != "other origin" && tc.name != "lookalike origin" {
				require.False(t, d.Config.Validation.PublishReady)
			}
			require.False(t, hasCode(d.Config.Validation, "VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED", "UI_FIXABLE"))
		})
	}
}

func TestLaoliLegacyVideoProfileRebindRejectsUnsupportedContractAtomically(t *testing.T) {
	for _, tc := range []struct {
		name     string
		newModel string
		change   func(*Account)
	}{
		{"unknown new model", "future-laoli-model", func(_ *Account) {}},
		{"unknown profile", "wan-3.0-video-ref", func(a *Account) {
			a.Config.Published.Products[0].AdapterConfig.WireProfile = "future_profile"
			a.Config.Draft.Products[0].AdapterConfig.WireProfile = "future_profile"
		}},
		{"unknown version", "wan-3.0-video-ref", func(a *Account) {
			a.Config.Published.Products[0].AdapterConfig.Version = 2
			a.Config.Draft.Products[0].AdapterConfig.Version = 2
		}},
		{"foreign origin with new Laoli contract", "wan-3.0-video-ref", func(a *Account) {
			a.BaseURL = "https://supplier.example"
			a.Config.Published.Products[0].AdapterConfig.WireProfile = videoplan.LaoliMediaProfile
			a.Config.Draft.Products[0].AdapterConfig.WireProfile = videoplan.LaoliMediaProfile
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := validatorFixture(t)
			a := &r.a
			a.BaseURL = "https://video.laoliimage2.win"
			a.Catalog.Models = []string{"3.0"}
			p := laoliVideoProduct("3.0")
			d, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			require.NoError(t, err)
			_, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
			require.NoError(t, err)
			a.Config.Published.Products[0].AdapterConfig.WireProfile = "inline_multimedia"
			a.Config.Draft.Products[0].AdapterConfig.WireProfile = "inline_multimedia"
			a.Catalog.Models = []string{tc.newModel}
			a.Catalog.Source, a.Catalog.AccountIdentitySHA256 = "upstream", "same-account-catalog"
			tc.change(a)
			a.Config.Published.Revision = publishedRevision(a.Config.Published)
			before, writes := hash(a.Config), r.writes
			d, err = s.ModelBinding(t.Context(), 7, a.Config.RecordVersion, ModelBindingInput{
				ExpectedDraftRevision: a.Config.Draft.Revision, OldModelID: "3.0", NewModelID: tc.newModel,
				Action: "rebind", ProductIDs: []string{p.ProductID},
			})
			require.ErrorIs(t, err, ErrValidation)
			require.Equal(t, before, hash(a.Config))
			require.Equal(t, before, hash(d.Config))
			require.Equal(t, writes, r.writes)
			require.True(t, hasCode(*d.PublishValidation, "VIDEO_PROFILE_UNSUPPORTED", "NEEDS_DEVELOPMENT"), d.PublishValidation.Diagnostics)
			require.Len(t, d.BindingValidationProducts, 1)
			require.Equal(t, tc.newModel, d.BindingValidationProducts[0].UpstreamModel)
		})
	}
}

func TestLaoliLegacyVideoProfileSaveLeavesPublishedSnapshotUntouched(t *testing.T) {
	s, r := validatorFixture(t)
	a := &r.a
	a.BaseURL = "https://video.laoliimage2.win"
	a.Catalog.Models = []string{"3.0"}
	d, err := s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{laoliVideoProduct("3.0")}})
	require.NoError(t, err)
	_, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	require.NoError(t, err)
	a.Config.Published.Products[0].AdapterConfig.WireProfile = "inline_multimedia"
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	beforePublished := hash(a.Config.Published)
	p := a.Config.Draft.Products[0]
	p.AdapterConfig.WireProfile = "inline_multimedia"
	d, err = s.SaveDraft(t.Context(), 7, a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	require.NoError(t, err)
	require.Equal(t, videoplan.LaoliMediaProfile, d.Config.Draft.Products[0].AdapterConfig.WireProfile)
	require.Equal(t, beforePublished, hash(d.Config.Published), "saving a draft cannot migrate or republish its published snapshot and offers")
}

package mediaworkbench

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"testing"
	"time"
)

func TestThirtyReferencesRemainModelBounded(t *testing.T) {
	for _, n := range []int{0, 1, 16, 20, 30, 31} {
		service, r := validatorFixture(t)
		d, _ := Descriptor("laoli_video")
		r.a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
		m := genericReferenceVideoModel()
		r.a.Catalog.Models = append(r.a.Catalog.Models, m.Upstream)
		r.a.ModelMapping = map[string]string{m.ID: m.Upstream}
		p := validProduct()
		p.MediaType = "video"
		p.SiteModel = m.ID
		p.UpstreamModel = m.Upstream
		p.AdapterConfig = ImageConfig{Version: 1, WireProfile: m.Mode}
		p.Capabilities = Capabilities{Resolutions: []string{m.Resolutions[0]}, AspectRatios: []string{m.Ratios[0]}, DurationsSeconds: []int{m.Durations[0]}, Count: Range{1, 1}, References: References{Image: Range{0, n}, TotalMax: n}}
		p.PricingRules = []PricingRule{{SalePrice: &Price{Amount: "0.1", Currency: "CNY", BillingMode: "per_request"}}}
		v, _ := Validate(&r.a, Draft{Revision: "refs", Products: []Product{p}}, time.Now())
		if v.PublishReady != (n <= 30) {
			t.Fatalf("n=%d diagnostics=%+v", n, v.Diagnostics)
		}
		if n == 30 {
			saved, err := service.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
			must(t, err)
			saved, err = service.Publish(context.Background(), 7, saved.Config.RecordVersion, saved.Config.Draft.Revision)
			must(t, err)
			_, err = service.SetSales(context.Background(), 7, saved.Config.RecordVersion, true)
			must(t, err)
			spec := Spec{Resolution: m.Resolutions[0], AspectRatio: m.Ratios[0], DurationSeconds: m.Durations[0], Count: 1, Images: 30}
			resolved, err := ResolvePublishedVideoOffer(&r.a, r.a.Config.Published.Offers[0].OfferID, spec)
			must(t, err)
			wire, err := videoplan.PreviewWithModel(m, m.Upstream, spec.Resolution, spec.AspectRatio, spec.DurationSeconds, 30, 0, 0)
			must(t, err)
			_, err = CompilePublishedVideoPlan(resolved, wire.Body)
			must(t, err)
			spec.Images = 31
			if _, err = ResolvePublishedVideoOffer(&r.a, r.a.Config.Published.Offers[0].OfferID, spec); err == nil {
				t.Fatal("31 bypassed frozen offer")
			}
		}

	}
	_, r := validatorFixture(t)
	p := validProduct()
	p.Capabilities.References = References{Image: Range{0, 20}, TotalMax: 20}
	v, _ := Validate(&r.a, Draft{Revision: "image", Products: []Product{p}}, time.Now())
	if !hasCode(v, "REFERENCE_LIMIT_EXCEEDED", "UI_FIXABLE") {
		t.Fatal("image adapter lost 16 cap", v)
	}
}

func TestReferencesIndependentTotalAndBudget(t *testing.T) {
	c := validProduct().Capabilities
	c.References = References{Image: Range{0, 30}, Video: Range{0, 10}, Audio: Range{0, 10}, TotalMax: 30}
	if !validCapabilities(c) {
		t.Fatal("category sum is not total limit")
	}
	cases, err := specs(c, maxCases)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range cases {
		if s.Images+s.Videos+s.Audio > 30 {
			t.Fatal(s)
		}
	}
	c.DurationsSeconds = make([]int, 27)
	for i := range c.DurationsSeconds {
		c.DurationsSeconds[i] = i + 4
	}
	if _, err := specs(c, maxCases); err == nil {
		t.Fatal("budget removed")
	}
}

func TestExplicitLaoliProfileCannotWidenKnownContract(t *testing.T) {
	m, _ := videoplan.LaoliMediaModel("3.0", nil)
	p := Product{MediaType: "video", SiteModel: m.ID, UpstreamModel: m.Upstream, AdapterConfig: ImageConfig{Version: 1, WireProfile: videoplan.LaoliMediaProfile}, Capabilities: Capabilities{DurationsSeconds: []int{4}, References: References{Image: Range{0, 30}, TotalMax: 30}}}
	resolved, ok := VideoProfileModel(p)
	if !ok || resolved.Limits.Image != 9 {
		t.Fatal("documented contract widened")
	}
	if _, err := videoplan.PreviewWithModel(resolved, m.Upstream, m.Resolutions[0], m.Ratios[0], 4, 30, 0, 0); err == nil {
		t.Fatal("invalid configured duration/reference accepted")
	}
}

func genericReferenceVideoModel() videoplan.Model {
	m := videoplan.Model{ID: "reference-video", Upstream: "reference-upstream", Status: "enabled", Mode: "images", Durations: []int{5}, Resolutions: []string{"720p"}, Ratios: []string{"16:9"}}
	m.Limits.Image = 30
	m.Limits.Total = 30
	return m
}

func TestUnsupportedReferenceKindsStayClosed(t *testing.T) {
	for _, profile := range []string{"images", "grok", "seedance"} {
		p := Product{SiteModel: "configured-new", UpstreamModel: "configured-new", AdapterConfig: ImageConfig{Version: 1, WireProfile: profile}, Capabilities: Capabilities{References: References{Video: Range{0, 1}, TotalMax: 1}}}
		if _, ok := VideoProfileModel(p); ok {
			t.Fatalf("%s accepted video input", profile)
		}
	}
}

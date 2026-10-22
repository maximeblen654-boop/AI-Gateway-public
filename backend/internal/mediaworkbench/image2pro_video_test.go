package mediaworkbench

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func image2ProVideoFixture(t *testing.T) (*Service, *memoryRepo, Product) {
	t.Helper()
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	must(t, json.Unmarshal(raw, &f))
	caps, e := videoplan.DecodeImage2ProCapabilities(f.Metadata)
	must(t, e)
	svc, repo := fixture()
	repo.a.BaseURL = "https://api.image2pro.top/v1"
	repo.a.Catalog.Models = []string{f.Model}
	repo.a.Image2ProVideoCapabilities = map[string]videoplan.Image2ProCapabilities{f.Model: *caps}
	p := Product{ProductID: "image2pro-fixture", MediaType: "video", SiteModel: f.Model, UpstreamModel: f.Model, Enabled: true, Capabilities: Capabilities{Resolutions: []string{"1080p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{4, 5}, Count: Range{Min: 1, Max: 1}, References: References{Image: Range{Max: 2}, Audio: Range{Max: 1}, Video: Range{Max: 1}, TotalMax: 4}}, PricingRules: []PricingRule{{SalePrice: &Price{Amount: "4", Currency: "CNY", BillingMode: "per_request"}}}}
	return svc, repo, p
}

func TestImage2ProVideoDraftInheritsAccountMetadataAndRevokesOnDrift(t *testing.T) {
	svc, repo, p := image2ProVideoFixture(t)
	forged := repo.a.Image2ProVideoCapabilities[p.UpstreamModel]
	forged.Size = "2K"
	forged.MaxImages = 9
	p.AdapterConfig.Image2Pro = &forged
	d, e := svc.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	must(t, e)
	if !d.Config.Validation.PublishReady {
		t.Fatalf("%+v", d.Config.Validation.Diagnostics)
	}
	saved := d.Config.Draft.Products[0]
	if saved.AdapterConfig.Image2Pro.Size != "1080P" || saved.AdapterConfig.Image2Pro.MaxImages != 8 || saved.AdapterConfig.WireProfile != "image2pro" || d.Config.AdapterBindings["video"].Kind != "image2pro_video" {
		t.Fatalf("forged caps survived %+v", saved)
	}
	d, e = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, e)
	d, e = svc.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	must(t, e)
	offer := d.Config.Published.Offers[0]
	spec := Spec{Count: 1, Resolution: "1080p", AspectRatio: "16:9", DurationSeconds: 5}
	if _, e := ResolvePublishedVideoOffer(&repo.a, offer.OfferID, spec); e != nil {
		t.Fatal(e)
	}
	cap := repo.a.Image2ProVideoCapabilities[p.UpstreamModel]
	cap.Protocol = "different-opaque-identity"
	repo.a.Image2ProVideoCapabilities[p.UpstreamModel] = cap
	if _, e := ResolvePublishedVideoOffer(&repo.a, offer.OfferID, spec); e == nil {
		t.Fatal("changed metadata still offered")
	}
}

func TestImage2ProVideoMissingAndOutOfCapabilityProductsCannotPublish(t *testing.T) {
	for _, scenario := range []string{"missing", "duration", "ratio", "resolution", "images", "audio", "video", "mode"} {
		t.Run(scenario, func(t *testing.T) {
			svc, repo, p := image2ProVideoFixture(t)
			switch scenario {
			case "missing":
				repo.a.Image2ProVideoCapabilities = nil
			case "duration":
				p.Capabilities.DurationsSeconds = []int{3}
			case "ratio":
				p.Capabilities.AspectRatios = []string{"1:1"}
			case "resolution":
				p.Capabilities.Resolutions = []string{"1K"}
			case "images":
				p.Capabilities.References.Image.Max = 9
				p.Capabilities.References.TotalMax = 11
			case "audio":
				p.Capabilities.References.Audio.Max = 4
				p.Capabilities.References.TotalMax = 7
			case "video":
				p.Capabilities.References.Video.Max = 2
				p.Capabilities.References.TotalMax = 5
			case "mode":
				c := repo.a.Image2ProVideoCapabilities[p.UpstreamModel]
				c.Modes = []string{"text", "keyframe"}
				repo.a.Image2ProVideoCapabilities[p.UpstreamModel] = c
			}
			d, e := svc.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
			must(t, e)
			if d.Config.Validation.PublishReady {
				t.Fatal("invalid capability published", scenario)
			}
		})
	}
}

func TestImage2ProVideoSelectionRequiresExactAccountEndpoint(t *testing.T) {
	_, repo, _ := image2ProVideoFixture(t)
	for _, raw := range []string{"https://api.image2pro.top.evil.test/v1", "http://api.image2pro.top/v1", "https://api.image2pro.top/v1?key=x", "https://api.image2pro.top:8443/v1", "https://other.example/v1"} {
		repo.a.BaseURL = raw
		if nativeAdapterKind(&repo.a, "video") == "image2pro_video" {
			t.Fatal("foreign Account inferred as Image2Pro", raw)
		}
	}
}

func TestImage2ProVideoPreservesPricedResolutionSpelling(t *testing.T) {
	svc, repo, p := image2ProVideoFixture(t)
	p.PricingRules[0].Match.Resolution = []string{"1080p"}
	d, e := svc.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	must(t, e)
	if !d.Config.Validation.PublishReady {
		t.Fatalf("%+v", d.Config.Validation.Diagnostics)
	}
	saved := d.Config.Draft.Products[0]
	if saved.Capabilities.Resolutions[0] != "1080p" || saved.PricingRules[0].Match.Resolution[0] != "1080p" || saved.PricingRules[0].SalePrice.Amount != "4" {
		t.Fatal("save changed a priced specification")
	}
	d, e = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, e)
	d, e = svc.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	must(t, e)
	spec := Spec{Count: 1, Resolution: "1080p", AspectRatio: "16:9", DurationSeconds: 5}
	resolved, e := ResolvePublishedVideoOffer(&repo.a, d.Config.Published.Offers[0].OfferID, spec)
	must(t, e)
	if _, e = CompilePublishedVideoPlan(resolved, []byte(`{"model":"`+p.UpstreamModel+`","prompt":"synthetic","duration":5,"ratio":"16:9"}`)); e != nil {
		t.Fatal(e)
	}
	wrong := spec
	wrong.Resolution = "1K"
	if _, e = ResolvePublishedVideoOffer(&repo.a, resolved.Offer.OfferID, wrong); e == nil {
		t.Fatal("different resolution substituted")
	}
}

func seedance2VideoFixture(t *testing.T) (*Service, *memoryRepo, Product) {
	t.Helper()
	svc, repo, p := image2ProVideoFixture(t)
	raw, err := os.ReadFile("../videoplan/testdata/image2pro_seedance2_video.json")
	must(t, err)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	must(t, json.Unmarshal(raw, &f))
	caps, err := videoplan.DecodeImage2ProCapabilities(f.Metadata)
	must(t, err)
	p.SiteModel, p.UpstreamModel = f.Model, f.Model
	p.Capabilities.Resolutions = []string{"supplier-default"}
	p.Capabilities.DurationsSeconds = []int{4, 15}
	p.Capabilities.References = References{Image: Range{Max: 9}, Audio: Range{Max: 3}, TotalMax: 12}
	p.PricingRules[0].Match.Resolution = []string{"supplier-default"}
	repo.a.Catalog.Models = []string{f.Model}
	repo.a.Image2ProVideoCapabilities = map[string]videoplan.Image2ProCapabilities{f.Model: *caps}
	return svc, repo, p
}

func TestSeedance2SingleProductLabelPreviewOfferAndCompile(t *testing.T) {
	svc, repo, p := seedance2VideoFixture(t)
	d, err := svc.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
	must(t, err)
	if !d.Config.Validation.PublishReady {
		t.Fatalf("%+v", d.Config.Validation.Diagnostics)
	}
	saved := d.Config.Draft.Products[0]
	if saved.AdapterConfig.Image2Pro.Size != "" || saved.Capabilities.Resolutions[0] != "supplier-default" || saved.PricingRules[0].SalePrice.Amount != "4" {
		t.Fatal("save invented supplier size or changed pricing")
	}
	spec := Spec{Count: 1, Resolution: "supplier-default", AspectRatio: "16:9", DurationSeconds: 15, Audio: 1}
	preview, err := compilePlan(saved, spec)
	must(t, err)
	for _, key := range []string{"resolution", "size", "mode", "n"} {
		if _, present := preview.Fields[key]; present {
			t.Fatal("undocumented field", key)
		}
	}
	d, err = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, err)
	d, err = svc.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
	must(t, err)
	offer := d.Config.Published.Offers[0]
	resolved, err := ResolvePublishedVideoOffer(&repo.a, offer.OfferID, spec)
	must(t, err)
	_, err = CompilePublishedVideoPlan(resolved, []byte(`{"model":"Seedance2.0","prompt":"synthetic","duration":15,"ratio":"16:9","audios":[{"mediaId":"audio-fixture"}]}`))
	must(t, err)
	for _, label := range []string{"480P", "SUPPLIER-DEFAULT"} {
		wrong := spec
		wrong.Resolution = label
		if _, err := ResolvePublishedVideoOffer(&repo.a, offer.OfferID, wrong); err == nil {
			t.Fatal("unpriced label accepted", label)
		}
	}
	if _, err := CompilePublishedVideoPlan(resolved, []byte(`{"model":"Seedance2.0","prompt":"synthetic","duration":4,"ratio":"16:9","audios":[{"mediaId":"audio-fixture"}]}`)); err == nil {
		t.Fatal("different duration substituted after quote")
	}
	caps := repo.a.Image2ProVideoCapabilities[p.UpstreamModel]
	caps.MaxAudioReferences = 2
	repo.a.Image2ProVideoCapabilities[p.UpstreamModel] = caps
	if _, err := ResolvePublishedVideoOffer(&repo.a, offer.OfferID, spec); err == nil {
		t.Fatal("metadata drift retained old grant")
	}
}

func TestSeedance2RejectsAmbiguousLabelsAndOutOfContractProducts(t *testing.T) {
	for _, scenario := range []string{"multiple labels", "no label", "duration", "ratio", "video", "size"} {
		t.Run(scenario, func(t *testing.T) {
			svc, repo, p := seedance2VideoFixture(t)
			switch scenario {
			case "multiple labels":
				p.Capabilities.Resolutions = []string{"supplier-default", "480P"}
			case "no label":
				p.Capabilities.Resolutions = nil
			case "duration":
				p.Capabilities.DurationsSeconds = []int{30}
			case "ratio":
				p.Capabilities.AspectRatios = []string{"1:1"}
			case "video":
				p.Capabilities.References.Video.Max = 1
			case "size":
				c := repo.a.Image2ProVideoCapabilities[p.UpstreamModel]
				c.Size = "480P"
				repo.a.Image2ProVideoCapabilities[p.UpstreamModel] = c
			}
			d, err := svc.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{p}})
			must(t, err)
			if d.Config.Validation.PublishReady {
				t.Fatal("invalid product accepted", scenario)
			}
		})
	}
}

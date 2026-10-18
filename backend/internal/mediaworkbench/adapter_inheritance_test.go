package mediaworkbench

import "testing"

func TestBindingsForReplacesStaleUnboundMarkersWithNativeAdapters(t *testing.T) {
	a := &Account{
		Platform:             "openai",
		Type:                 "apikey",
		EndpointCapabilities: []string{"seedance"},
		Config: &Config{AdapterBindings: map[string]AdapterBinding{
			"image": {Kind: "unbound_image"},
			"video": {Kind: "unbound_video"},
		}},
	}

	got := bindingsFor(a, []string{"image", "video"})
	if got["image"].Kind != "openai_images" {
		t.Fatalf("stale image binding was not inherited: %+v", got["image"])
	}
	if got["video"].Kind != "seedance_video" {
		t.Fatalf("stale video binding was not inherited: %+v", got["video"])
	}
}

func TestBindingsForPreservesExplicitBindingsAcrossMediaTypes(t *testing.T) {
	video, _ := Descriptor("laoli_video")
	a := &Account{
		Platform: "openai",
		Type:     "apikey",
		Config: &Config{AdapterBindings: map[string]AdapterBinding{
			"image": {Kind: "unbound_image"},
			"video": {Kind: video.Kind, Revision: "old-revision", Auth: video.Auth, TaskFlow: video.TaskFlow},
		}},
	}

	got := bindingsFor(a, []string{"image", "video"})
	if got["image"].Kind != "openai_images" {
		t.Fatalf("image native binding missing: %+v", got["image"])
	}
	if got["video"].Kind != video.Kind || got["video"].Revision != video.Revision {
		t.Fatalf("explicit video binding was changed incorrectly: %+v", got["video"])
	}
}

func TestOrdinaryCompatibleVideoUsesNativeContractOnFirstSave(t *testing.T) {
	s, r := fixture()
	r.a.BaseURL = "https://compat.example/v1"
	r.a.Catalog.Models = []string{"compat-upstream"}
	r.a.ModelMapping = map[string]string{"compat-video": "compat-upstream"}
	product := Product{
		CostRules:     []CostRule{{Cost: &Price{Amount: "0.35", Currency: "CNY", BillingMode: "per_request"}}},
		ProductID:     "compat-video-offer",
		MediaType:     "video",
		SiteModel:     "compat-video",
		UpstreamModel: "compat-upstream",
		Enabled:       true,
		Capabilities: Capabilities{
			Resolutions:      []string{"720p"},
			AspectRatios:     []string{"16:9"},
			DurationsSeconds: []int{5},
			Count:            Range{Min: 1, Max: 1},
			References:       References{Image: Range{Min: 0, Max: 1}, TotalMax: 1},
		},
		PricingRules: []PricingRule{{SalePrice: &Price{Amount: "1.00", Currency: "CNY", BillingMode: "per_request"}}},
	}

	d, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{product}})
	if err != nil {
		t.Fatal(err)
	}
	if got := d.Config.AdapterBindings["video"].Kind; got != "laoli_video" {
		t.Fatalf("ordinary video did not inherit the compatible adapter: %q", got)
	}
	saved := d.Config.Draft.Products[0]
	if saved.AdapterConfig.Version != 1 || saved.AdapterConfig.WireProfile != "images" {
		t.Fatalf("ordinary video profile was not derived from the product capabilities: %+v", saved.AdapterConfig)
	}
	if !d.Config.Validation.PublishReady {
		t.Fatalf("ordinary compatible video was rejected: %+v", d.Config.Validation.Diagnostics)
	}
}

func TestSaveDraftRepairsStaleBindingsAndPreservesMixedMediaState(t *testing.T) {
	s, r := fixture()
	r.a.BaseURL = "https://compat.example/v1"
	r.a.Catalog.Models = []string{"gpt-image-2", "compat-video"}
	if _, err := s.Initialize(t.Context(), 7, []string{"image", "video"}); err != nil {
		t.Fatal(err)
	}
	r.a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "unbound_image"}
	r.a.Config.AdapterBindings["video"] = AdapterBinding{Kind: "unbound_video"}

	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{validProduct()}})
	if err != nil {
		t.Fatal(err)
	}
	if d.Config.AdapterBindings["image"].Kind != "openai_images" || d.Config.AdapterBindings["video"].Kind != "laoli_video" {
		t.Fatalf("save did not repair both stale bindings: %+v", d.Config.AdapterBindings)
	}
	readBack, err := s.Detail(t.Context(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if readBack.Config.AdapterBindings["image"].Kind != "openai_images" || readBack.Config.AdapterBindings["video"].Kind != "laoli_video" {
		t.Fatalf("read-back changed repaired bindings: %+v", readBack.Config.AdapterBindings)
	}
}

package mediaworkbench

import (
	"context"
	"errors"
	"testing"
)

const representativeUpstreamModel = "特价2.0-需要过人脸技术-可参考过人脸素材库"

func representativeVideoProduct(salePrice *Price) Product {
	return Product{
		ProductID: "video-3-0", MediaType: "video", SiteModel: "3.0", DisplayName: "本站产品别名",
		UpstreamModel: representativeUpstreamModel, Enabled: true,
		Capabilities: Capabilities{Resolutions: []string{"720p"}, AspectRatios: []string{"16:9"}, DurationsSeconds: []int{5}, Count: Range{Min: 1, Max: 1}, References: References{Image: Range{0, 0}, Video: Range{0, 0}, Audio: Range{0, 0}, TotalMax: 0}},
		PricingRules: []PricingRule{{Match: Match{Resolution: []string{"720p"}, DurationSeconds: []int{5}, AspectRatio: []string{"16:9"}, Count: &Range{Min: 1, Max: 1}}, SalePrice: salePrice}},
	}
}

func TestAdminVideoSaveValidateReadbackPublishLoop(t *testing.T) {
	ctx := context.Background()
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
	r.a.ResolvedModels = map[string]string{"3.0": representativeUpstreamModel}
	r.a.Catalog.Models = []string{representativeUpstreamModel, "3.0-native"}
	d, err := s.Initialize(ctx, 7, []string{"video"})
	if err != nil {
		t.Fatal(err)
	}
	d, err = s.BindVideoAdapter(ctx, 7, d.Config.RecordVersion, "laoli_video")
	if err != nil {
		t.Fatal(err)
	}
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{representativeVideoProduct(&Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"})}})
	if err != nil {
		t.Fatal(err)
	}
	if d.Config.Validation.Status != "PASS" || !d.Config.Validation.PublishReady || d.Config.Validation.CaseCount != 1 {
		t.Fatalf("representative spec did not validate: %+v", d.Config.Validation)
	}
	if d.Config.Draft.Products[0].UpstreamModel != representativeUpstreamModel || d.Config.Draft.Products[0].SiteModel != "3.0" {
		t.Fatalf("identity changed: %+v", d.Config.Draft.Products[0])
	}
	version, revision := d.Config.RecordVersion, d.Config.Draft.Revision
	// A fresh repository read is the read-back evidence used by the UI.
	d, err = s.Detail(ctx, 7)
	if err != nil || d.Config.Draft.Revision != revision || d.Config.Validation.DraftRevision != revision {
		t.Fatalf("read-back: %v %+v", err, d)
	}
	d, err = s.Publish(ctx, 7, version, revision)
	if err != nil {
		t.Fatal(err)
	}
	if d.Config.Published == nil || len(d.Config.Published.Offers) != 1 || d.Config.Published.Offers[0].UpstreamModel != representativeUpstreamModel || d.Config.Published.Offers[0].SiteModel != "3.0" {
		t.Fatalf("published truth mismatch: %+v", d.Config.Published)
	}
	if _, err = s.Publish(ctx, 7, version, revision); !errors.Is(err, ErrStale) {
		t.Fatalf("repeated publish must use CAS: %v", err)
	}

	// Missing price and an unsupported combination are explicit UI-fixable gates.
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{representativeVideoProduct(nil)}})
	if err != nil || d.Config.Validation.Status != "FAIL" || !hasCode(d.Config.Validation, "MISSING_PRICE", "UI_FIXABLE") {
		t.Fatalf("missing price gate: %v %+v", err, d.Config.Validation)
	}
	bad := representativeVideoProduct(&Price{Amount: "2.50", Currency: "CNY", BillingMode: "per_request"})
	bad.Capabilities.Resolutions = []string{"1080p"}
	d, err = s.SaveDraft(ctx, 7, d.Config.RecordVersion, DraftInput{Products: []Product{bad}})
	if err != nil || d.Config.Validation.Status != "FAIL" || !hasCode(d.Config.Validation, "VIDEO_RESOLUTION_UNSUPPORTED", "UI_FIXABLE") {
		t.Fatalf("unsupported spec gate: %v %+v", err, d.Config.Validation)
	}
	if _, err = s.Publish(ctx, 7, d.Config.RecordVersion, d.Config.Draft.Revision); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid draft published: %v", err)
	}
	if _, err = s.SaveDraft(ctx, 7, 1, DraftInput{}); !errors.Is(err, ErrStale) {
		t.Fatalf("stale save: %v", err)
	}

	// The paused/deleted Account cannot become a runtime offer, and deletion is fail-closed.
	r.a.Status = "inactive"
	paused := r.a
	paused.Config.Sales.Enabled = true
	if len(PublishedVideoOffers(&paused)) != 0 {
		t.Fatal("paused Account exposed video offers")
	}
	r.deleted = true
	if _, err = s.Detail(ctx, 7); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted Account read: %v", err)
	}
}

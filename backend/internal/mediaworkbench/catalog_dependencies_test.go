package mediaworkbench

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestPublishedCatalogScope(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Account)
		ready  bool
	}{
		{"timestamp", func(a *Account) { a.Catalog.SyncedAt = "2030-01-01T00:00:00Z" }, true},
		{"unrelated model", func(a *Account) { a.Catalog.Models = append(a.Catalog.Models, "Nano-banana-2.1") }, true},
		{"ordering and duplicates", func(a *Account) { a.Catalog.Models = []string{"other", "gpt-image-2", "gpt-image-2"} }, true},
		{"draft only", func(a *Account) {
			a.Config.Draft.Products = append(a.Config.Draft.Products, Product{ProductID: "banana", UpstreamModel: "banana"})
		}, true},
		{"deleted model", func(a *Account) { a.Catalog.Models = []string{"other"} }, false},
		{"mapping", func(a *Account) { a.ModelMapping = map[string]string{"gpt-image-2": "other"} }, false},
		{"routing", func(a *Account) { a.BaseURL = "https://changed.example.invalid" }, false},
		{"protocol", func(a *Account) {
			a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "gemini_images", Auth: "account_native", TaskFlow: "sync"}
		}, false},
		{"missing catalog", func(a *Account) { a.Catalog = nil }, false},
		{"missing sync", func(a *Account) { a.Catalog.SyncedAt = "" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := preflight1870Fixture(t)
			before := PublishedDependenciesFor(a)
			tc.change(a)
			got := publishedReady(a)
			if got != tc.ready {
				t.Fatalf("ready=%v want=%v", got, tc.ready)
			}
			if tc.ready && PublishedDependenciesFor(a) != before {
				t.Fatal("irrelevant change invalidated paid grant fingerprint")
			}
		})
	}
}

func TestLegacyCatalogStaysStrictUntilExplicitRecovery(t *testing.T) {
	a := preflight1870Fixture(t)
	// Old records omit the scope field. Their revision/quote identity stays intact.
	a.Config.Published.Dependencies = DependenciesFor(a)
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	before := hash(a.Config.Published)
	if !publishedReady(a) {
		t.Fatal("unchanged legacy unavailable")
	}
	a.Catalog.SyncedAt = "2030-01-01T00:00:00Z"
	if publishedReady(a) {
		t.Fatal("legacy dependency silently rewritten/bypassed")
	}
	if hash(a.Config.Published) != before {
		t.Fatal("read mutated snapshot")
	}
	a.Config.Published.Dependencies.CatalogSHA256 = "unsupported:hash"
	a.Config.Published.Revision = publishedRevision(a.Config.Published)
	if publishedReady(a) {
		t.Fatal("unknown scope accepted")
	}
}

func recoveryAccount(t *testing.T) *Account {
	a := preflight1870Fixture(t)
	a.ID = 77
	old := a.Config.Published
	v, offers := Validate(a, Draft{Revision: old.SourceDraftRevision, Products: old.Products}, old.PublishedAt)
	if !v.PublishReady {
		t.Fatal(v.Diagnostics)
	}
	old.Offers = offers
	old.Dependencies = v.Dependencies
	old.Revision = publishedRevision(old)
	a.Catalog.Models = append(a.Catalog.Models, "Nano-banana-2.1")
	a.Catalog.SyncedAt = "2030-01-01T00:00:00Z"
	a.Config.Draft.Products = append(a.Config.Draft.Products, Product{ProductID: "banana-draft", UpstreamModel: "Nano-banana-2.1"})
	return a
}

func TestRecoveryOriginalProducts1870DraftUntouched(t *testing.T) {
	a := recoveryAccount(t)
	before := hash(a)
	if publishedReady(a) {
		t.Fatal("must reproduce stale published catalog")
	}
	next, inspection, err := RevalidatePublishedCatalog(context.Background(), a, time.Now())
	must(t, err)
	if inspection.SpecCount != 1870 || len(inspection.Offers) != 1 || len(inspection.Offers[0].Selected) != 2 {
		t.Fatalf("coverage %+v", inspection)
	}
	if before != hash(a) {
		t.Fatal("preparation mutated account or drafts")
	}
	old := a.Config.Published
	if hash(next.Products) != hash(old.Products) || hash(next.Offers) != hash(old.Offers) || next.SourceDraftRevision != old.SourceDraftRevision {
		t.Fatal("commercial contract changed")
	}
	a.Config.Published = next
	if !publishedReady(a) {
		t.Fatal("replacement unavailable")
	}
	for _, images := range []int{0, 1, 16} {
		resolved, e := ResolvePublishedImageOffer(a, next.Offers[0].OfferID, Spec{Resolution: "4K", AspectRatio: "16:9", Count: 3, Images: images})
		must(t, e)
		unit, total, e := PriceForQuantity(resolved.Offer.SalePrice, 3)
		must(t, e)
		if unit.Amount != "0.025" || total.Amount != "0.075" {
			t.Fatal(unit, total)
		}
	}
	a.Catalog.SyncedAt = "2031-01-01T00:00:00Z"
	a.Catalog.Models = append(a.Catalog.Models, "unrelated")
	if !publishedReady(a) {
		t.Fatal("recovered snapshot invalidated by unrelated sync")
	}
}

func TestRecoveryRejectsDriftAndCancellation(t *testing.T) {
	for _, change := range []func(*Account){
		func(a *Account) { a.ID = 78 }, func(a *Account) { a.Catalog.Models = []string{"banana"} },
		func(a *Account) { a.ModelMapping = map[string]string{"gpt-image-2": "other"} },
		func(a *Account) { a.BaseURL = "https://other.example.invalid" },
		func(a *Account) { a.Config.Published.Offers[0].SalePrice.Amount = "99" },
		func(a *Account) { a.Config.Published.Products[0].UpstreamModel = "banana" },
	} {
		a := recoveryAccount(t)
		change(a)
		if _, _, err := RevalidatePublishedCatalog(context.Background(), a, time.Now()); err == nil {
			t.Fatal("unsafe recovery accepted")
		}
	}
	a := recoveryAccount(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := RevalidatePublishedCatalog(ctx, a, time.Now()); err == nil {
		t.Fatal("cancelled recovery accepted")
	}
	b, _ := json.Marshal(DependenciesFor(a))
	var d map[string]any
	_ = json.Unmarshal(b, &d)
	if _, ok := d["catalog_scope"]; ok {
		t.Fatal("legacy byte contract changed")
	}
}

func TestCatalogSyncKeepsFrozenQuoteAndVideo(t *testing.T) {
	a := preflight1870Fixture(t)
	spec := Spec{Resolution: "4K", AspectRatio: "16:9", Count: 3}
	old, e := ResolvePublishedImageOffer(a, a.Config.Published.Offers[0].OfferID, spec)
	must(t, e)
	a.Catalog.Models = append(a.Catalog.Models, "unrelated")
	a.Catalog.SyncedAt = "2030-01-01T00:00:00Z"
	next, e := ResolvePublishedImageOffer(a, old.Offer.OfferID, spec)
	must(t, e)
	if hash(old) != hash(next) {
		t.Fatal("unrelated sync changed frozen binding")
	}
	a.ModelMapping = map[string]string{"gpt-image-2": "changed"}
	if _, e = ResolvePublishedImageOffer(a, old.Offer.OfferID, spec); e == nil {
		t.Fatal("mapping drift accepted")
	}
	s, r := fixture()
	r.a.BaseURL = "https://supplier.example/v1"
	r.a.Catalog.Models = []string{representativeUpstreamModel}
	r.a.ModelMapping = map[string]string{"3.0": representativeUpstreamModel}
	d, e := s.Initialize(context.Background(), 7, []string{"video"})
	must(t, e)
	d, e = s.SaveDraft(context.Background(), 7, d.Config.RecordVersion, DraftInput{Products: []Product{representativeVideoProduct(&Price{Amount: "2.5", Currency: "CNY", BillingMode: "per_request"})}})
	must(t, e)
	_, e = s.Publish(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
	must(t, e)
	if !publishedReady(&r.a) {
		t.Fatal("video not ready")
	}
	before := PublishedDependenciesFor(&r.a)
	r.a.Catalog.Models = append(r.a.Catalog.Models, "unrelated")
	r.a.Catalog.SyncedAt = "later"
	if !publishedReady(&r.a) || before != PublishedDependenciesFor(&r.a) {
		t.Fatal("video invalidated by unrelated catalog change")
	}
	r.a.Catalog.Models = []string{"unrelated"}
	if publishedReady(&r.a) {
		t.Fatal("removed video model accepted")
	}
}

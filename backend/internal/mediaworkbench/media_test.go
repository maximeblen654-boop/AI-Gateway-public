package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

type memoryRepo struct {
	mu      sync.Mutex
	a       Account
	deleted bool
	writes  int
}

func (r *memoryRepo) Get(_ context.Context, id int64) (*Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deleted || id != r.a.ID {
		return nil, ErrNotFound
	}
	b, _ := json.Marshal(r.a)
	var a Account
	_ = json.Unmarshal(b, &a)
	a.BaseURL = r.a.BaseURL
	a.ModelMapping = r.a.ModelMapping
	a.ResolvedModels = r.a.ResolvedModels
	a.RoutingFingerprint = r.a.RoutingFingerprint
	return &a, nil
}
func (r *memoryRepo) List(ctx context.Context) ([]Account, error) {
	a, err := r.Get(ctx, r.a.ID)
	if errors.Is(err, ErrNotFound) {
		return []Account{}, nil
	}
	if err != nil {
		return nil, err
	}
	return []Account{*a}, nil
}
func (r *memoryRepo) CompareAndSwap(_ context.Context, id, expected int64, c *Config) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.swap(id, expected, c)
}
func (r *memoryRepo) CompareAndSwapChecked(_ context.Context, id, expected int64, deps Dependencies, c *Config) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if DependenciesFor(&r.a) != deps {
		return ErrStale
	}
	if c.Sales.Enabled && !c.Sales.UpdatedAt.Equal(r.a.Config.Sales.UpdatedAt) && !r.a.RuntimeReady {
		return ErrSales
	}
	return r.swap(id, expected, c)
}
func (r *memoryRepo) swap(id, expected int64, c *Config) error {
	if r.deleted {
		return ErrNotFound
	}
	v := int64(0)
	if r.a.Config != nil {
		v = r.a.Config.RecordVersion
	}
	if v != expected {
		return ErrStale
	}
	b, _ := json.Marshal(c)
	_ = json.Unmarshal(b, &r.a.Config)
	r.writes++
	return nil
}
func fixture() (*Service, *memoryRepo) {
	r := &memoryRepo{a: Account{ID: 7, Name: "supplier", Platform: "openai", RuntimeReady: true, Type: "apikey", Status: "active", Schedulable: true, BaseURL: "https://user:secret@example.com/private?api_key=secret", Catalog: &Catalog{Models: []string{"model-a", "model-b"}, SyncedAt: "2026-10-05T00:00:00Z"}}}
	return NewService(r), r
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func TestFoundationLifecycle(t *testing.T) {
	ctx := context.Background()
	s, r := fixture()
	d, err := s.Initialize(ctx, 7, []string{"image"})
	must(t, err)
	if d.Config.RecordVersion != 1 || d.Config.Sales.Enabled || d.Config.Validation.PublishReady || d.Config.Validation.Status != "FAIL" {
		t.Fatalf("unsafe initialization: %+v", d.Config)
	}
	first, _ := json.Marshal(d.Config)
	d, err = s.Initialize(ctx, 7, []string{"video"})
	must(t, err)
	repeat, _ := json.Marshal(d.Config)
	if string(first) != string(repeat) || r.writes != 1 {
		t.Fatal("repeat initialize mutated configuration")
	}
	input := DraftInput{Products: []Product{{ProductID: "p", MediaType: "image", UpstreamModel: "model-a", PricingRules: []PricingRule{{SalePrice: &Price{Amount: "0.100000000000000001", Currency: "USD"}}, {SalePrice: nil}, {SalePrice: &Price{Amount: "0"}}}}}}
	d, err = s.SaveDraft(ctx, 7, 1, input)
	must(t, err)
	if d.Config.RecordVersion != 3 || len(d.Config.Draft.Products) != 1 || d.Config.Validation.DraftRevision != d.Config.Draft.Revision {
		t.Fatal("draft/revision not saved")
	}
	if d.Config.Draft.Products[0].PricingRules[0].SalePrice.Amount != "0.100000000000000001" {
		t.Fatal("decimal changed")
	}
	if _, err = s.SaveDraft(ctx, 7, 1, DraftInput{}); !errors.Is(err, ErrStale) {
		t.Fatalf("stale write: %v", err)
	}
	draft, _ := json.Marshal(d.Config.Draft)
	validation, _ := json.Marshal(d.Config.Validation)
	d, err = s.SetSales(ctx, 7, 3, false)
	must(t, err)
	after, _ := json.Marshal(d.Config.Draft)
	afterValidation, _ := json.Marshal(d.Config.Validation)
	if d.Config.RecordVersion != 4 || string(draft) != string(after) || string(validation) != string(afterValidation) {
		t.Fatal("sales destroyed draft/validation")
	}
	if _, err = s.SetSales(ctx, 7, 4, true); !errors.Is(err, ErrSales) {
		t.Fatal("enabled without valid published offers")
	}
	if r.a.Status != "active" || !r.a.Schedulable || r.a.Config.RecordVersion != 4 {
		t.Fatal("generic status or rejected mutation changed")
	}
	encoded, _ := json.Marshal(d)
	if strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "private") || d.Host != "example.com" {
		t.Fatal("URL credentials leaked")
	}
	if d.Pending != 1 || d.Configured != 1 {
		t.Fatalf("counts: %+v", d)
	}
}
func TestPreservePublishedAndProcurement(t *testing.T) {
	s, r := fixture()
	ctx := context.Background()
	_, err := s.Initialize(ctx, 7, []string{"image"})
	must(t, err)
	r.a.Config.Sales.Enabled = true // existing gate can always be paused
	r.a.Config.Published = &Published{Revision: "mwp_old", Offers: []Offer{{OfferID: "offer-old", AccountID: 7}}}
	r.a.Config.Procurement = Procurement{Revision: 9, Entries: []ProcurementEntry{{ProductID: "old", Cost: Price{Amount: "12"}}}}
	before, _ := json.Marshal(r.a.Config.Published)
	costs, _ := json.Marshal(r.a.Config.Procurement)
	_, err = s.SaveDraft(ctx, 7, 1, DraftInput{})
	must(t, err)
	d, err := s.SetSales(ctx, 7, 3, false)
	must(t, err)
	after, _ := json.Marshal(d.Config.Published)
	afterCosts, _ := json.Marshal(d.Config.Procurement)
	if string(before) != string(after) || string(costs) != string(afterCosts) || d.Config.Draft.BasedOnPublishedRevision != "mwp_old" {
		t.Fatal("immutable envelopes changed")
	}
}
func TestAccountStatesAndDeletion(t *testing.T) {
	s, r := fixture()
	ctx := context.Background()
	_, err := s.Initialize(ctx, 7, []string{"video"})
	must(t, err)
	r.a.Status = "inactive"
	d, err := s.Detail(ctx, 7)
	must(t, err)
	if d.EffectiveState != "ACCOUNT_INACTIVE" || d.EffectiveSales {
		t.Fatal("inactive state")
	}
	r.a.Status = "active"
	r.a.Schedulable = false
	d, err = s.Detail(ctx, 7)
	must(t, err)
	if d.EffectiveState != "ACCOUNT_UNSCHEDULABLE" {
		t.Fatal("schedulable state")
	}
	r.deleted = true
	if _, err = s.SaveDraft(ctx, 7, 1, DraftInput{}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = s.Initialize(ctx, 7, []string{"image"}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	list, err := s.Suppliers(ctx)
	must(t, err)
	if len(list) != 0 {
		t.Fatal("deleted listed")
	}
}
func TestConcurrentMutations(t *testing.T) {
	s, r := fixture()
	ctx := context.Background()
	_, err := s.Initialize(ctx, 7, []string{"image"})
	must(t, err)
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var err error
			if i%2 == 0 {
				_, err = s.SaveDraft(ctx, 7, 1, DraftInput{})
			} else {
				_, err = s.SetSales(ctx, 7, 1, false)
			}
			results <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrStale) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stale != 23 || (r.a.Config.RecordVersion != 2 && r.a.Config.RecordVersion != 3) {
		t.Fatalf("success=%d stale=%d", success, stale)
	}
}
func TestInitializeBoundaries(t *testing.T) {
	s, r := fixture()
	ctx := context.Background()
	for _, types := range [][]string{nil, {"image", "image"}, {"audio"}} {
		if _, err := s.Initialize(ctx, 7, types); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	r.a.Type = "oauth"
	if _, err := s.Initialize(ctx, 7, []string{"image"}); !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
}

func TestMissingModelIsNotRediscoveredByDuplicateProducts(t *testing.T) {
	s, _ := fixture()
	ctx := context.Background()
	_, err := s.Initialize(ctx, 7, []string{"image"})
	must(t, err)
	d, err := s.SaveDraft(ctx, 7, 1, DraftInput{Products: []Product{{ProductID: "a", UpstreamModel: "missing"}, {ProductID: "b", UpstreamModel: "missing"}}})
	must(t, err)
	for _, m := range d.Models {
		if m.ModelID == "missing" && m.State != "UPSTREAM_NOT_DISCOVERED" {
			t.Fatal("draft presence was mistaken for discovery")
		}
	}
}

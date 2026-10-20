package mediaworkbench

import (
	"context"
	"errors"
	"testing"
)

func TestCatalogSnapshotValidationDeduplicatesProduct(t *testing.T) {
	a := preflight1870Fixture(t)
	ctx, cancel := context.WithCancel(WithPublishedValidationMemo(context.Background()))
	ready := publishedSnapshotValidator(ctx, a)
	for i := 0; i < 13; i++ {
		if !ready(a.Config.Published.Products[0].ProductID) {
			t.Fatal("same immutable product became unavailable")
		}
	}
	if runs, reuses := PublishedValidationMemoStats(ctx); runs != 1 || reuses != 0 {
		t.Fatalf("snapshot loop re-marshaled or revalidated its product: runs=%d reuses=%d", runs, reuses)
	}
	cancel()
	if ready(a.Config.Published.Products[0].ProductID) {
		t.Fatal("canceled request reused a successful snapshot result")
	}
}

func TestMediaReadRequestsObserveFreshSnapshots(t *testing.T) {
	base := preflight1870Fixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*Account)
	}{
		{"routing_base_url", func(a *Account) { a.BaseURL = "https://changed.example.invalid/v1" }},
		{"hidden_routing_fingerprint", func(a *Account) { a.RoutingFingerprint = "changed" }},
		{"catalog_membership", func(a *Account) { a.Catalog.Models = nil }},
		{"account_status", func(a *Account) { a.Status = "disabled" }},
		{"account_schedulable", func(a *Account) { a.Schedulable = false }},
		{"account_runtime", func(a *Account) { a.RuntimeReady = false }},
		{"sales", func(a *Account) { a.Config.Sales.Enabled = false }},
		{"published_price", func(a *Account) { a.Config.Published.Offers[0].SalePrice.Amount = "0" }},
		{"product_unlisted", func(a *Account) { a.Config.ProductLifecycle = map[string]ProductLifecycle{"p": {State: "unlisted"}} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &memoryRepo{a: *memoAccountSnapshot(t, base)}
			svc := NewService(repo)
			// A caller reusing its outer context must not carry a previous request's
			// validation grant into a fresh repository read.
			ctx := WithPublishedValidationMemo(context.Background())
			before, err := svc.Detail(ctx, repo.a.ID)
			must(t, err)
			if !before.EffectiveSales {
				t.Fatal("initial published account not selling")
			}
			tc.mutate(&repo.a)
			after, err := svc.Detail(ctx, repo.a.ID)
			must(t, err)
			if after.EffectiveSales {
				t.Fatal("new request reused stale sales availability")
			}
			repo.a = *memoAccountSnapshot(t, base)
			restored, err := svc.Detail(ctx, repo.a.ID)
			must(t, err)
			if !restored.EffectiveSales {
				t.Fatal("new request retained a stale rejection")
			}
		})
	}
}

type catalogRowsRepo struct {
	Repository
	rows []Account
}

func (r *catalogRowsRepo) List(context.Context) ([]Account, error) { return r.rows, nil }

func TestSuppliersUnlistedAccountDoesNotCloseOtherPublishedAccount(t *testing.T) {
	first := preflight1870Fixture(t)
	svc, second := validatorFixture(t)
	second.a.ID = 8
	detail, err := svc.SaveDraft(t.Context(), 8, second.a.Config.RecordVersion, DraftInput{Products: []Product{validProduct()}})
	must(t, err)
	detail, err = svc.Publish(t.Context(), 8, detail.Config.RecordVersion, detail.Config.Draft.Revision)
	must(t, err)
	_, err = svc.SetSales(t.Context(), 8, detail.Config.RecordVersion, true)
	must(t, err)
	repo := &catalogRowsRepo{rows: []Account{*first, second.a}}
	svc = NewService(repo)
	before, err := svc.Suppliers(t.Context())
	must(t, err)
	if len(before) != 2 || !before[0].EffectiveSales || !before[1].EffectiveSales {
		t.Fatal("fixture lost published accounts")
	}
	repo.rows[0].Config.ProductLifecycle = map[string]ProductLifecycle{"p": {State: "unlisted"}}
	after, err := svc.Suppliers(t.Context())
	must(t, err)
	if len(after) != 2 || after[0].EffectiveSales || !after[1].EffectiveSales || !after[1].ProductStates[0].PublishedReady {
		t.Fatal("one unlisted Account affected another valid published product")
	}
}

func TestMediaReadCancellationDoesNotReturnSuccessfulPartialData(t *testing.T) {
	a := preflight1870Fixture(t)
	svc := NewService(&memoryRepo{a: *a})
	for _, deadline := range []error{context.Canceled, context.DeadlineExceeded} {
		for _, operation := range []string{"detail", "suppliers"} {
			t.Run(deadline.Error()+"/"+operation, func(t *testing.T) {
				ctx := &memoTerminalContext{Context: context.Background(), after: 12, err: deadline}
				if operation == "detail" {
					got, err := svc.Detail(ctx, a.ID)
					if got != nil || !errors.Is(err, deadline) {
						t.Fatalf("detail: value=%v err=%v", got, err)
					}
				} else {
					got, err := svc.Suppliers(ctx)
					if got != nil || !errors.Is(err, deadline) {
						t.Fatalf("suppliers: count=%d err=%v", len(got), err)
					}
				}
			})
		}
	}
}

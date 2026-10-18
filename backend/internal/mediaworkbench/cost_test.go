package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCostCoverageIndependentOfRetailRules(t *testing.T) {
	_, r := validatorFixture(t)
	for _, tc := range []struct {
		name, code string
		change     func(*Product)
	}{
		{"missing", "MISSING_COST", func(p *Product) { p.CostRules = nil }},
		{"blank", "MISSING_COST", func(p *Product) { p.CostRules[0].Cost = nil }},
		{"overlap", "COST_RULE_OVERLAP", func(p *Product) { p.CostRules = append(p.CostRules, p.CostRules[0]) }},
		{"gap", "MISSING_COST", func(p *Product) { p.CostRules[0].Match.AspectRatio = []string{"1:1"} }},
		{"obsolete", "INVALID_COST_MATCH", func(p *Product) { p.CostRules[0].Match.AspectRatio = []string{"99:1"} }},
		{"negative", "INVALID_COST", func(p *Product) { p.CostRules[0].Cost.Amount = "-1" }},
		{"precision", "INVALID_COST", func(p *Product) { p.CostRules[0].Cost.Amount = "0.123456789" }},
		{"currency", "INVALID_COST", func(p *Product) { p.CostRules[0].Cost.Currency = "USD" }},
		{"source", "INVALID_COST_SOURCE", func(p *Product) { p.CostRules[0].Source = "supplier_bill" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := validProduct()
			p.CostVersion = 1
			tc.change(&p)
			v, _ := Validate(&r.a, Draft{Revision: "cost", Products: []Product{p}}, time.Now())
			if v.PublishReady || !hasCode(v, tc.code, "UI_FIXABLE") {
				t.Fatalf("missing %s: %+v", tc.code, v.Diagnostics)
			}
			for _, d := range v.Diagnostics {
				if d.Code == tc.code && (d.Scope != p.ProductID || !strings.HasPrefix(d.Path, "cost_rules") || !strings.Contains(d.Action, "4")) {
					t.Fatal(d)
				}
			}
		})
	}
	p := validProduct()
	p.CostVersion = 1
	p.CostRules = []CostRule{
		{Match: Match{AspectRatio: []string{"1:1"}}, Cost: &Price{Amount: "0", Currency: "CNY", BillingMode: "per_request"}, Source: "manual"},
		{Match: Match{AspectRatio: []string{"16:9"}}, Cost: &Price{Amount: "0.12345678", Currency: "CNY", BillingMode: "per_request"}, Source: "calculator"},
	}
	v, offers := Validate(&r.a, Draft{Revision: "cost", Products: []Product{p}}, time.Now())
	if !v.PublishReady || len(offers) != len(p.PricingRules) {
		t.Fatal(v.Diagnostics)
	}
	// Cost has two independent ratio rules; retail still has its two creation
	// mode rules. Cost is not copied into any customer-facing offer.
	encoded, _ := json.Marshal(offers)
	if strings.Contains(string(encoded), "0.12345678") || strings.Contains(string(encoded), "cost_rules") {
		t.Fatal("private cost leaked into offers")
	}
}

func TestCostDraftSaveCASAndExplicitPublishGate(t *testing.T) {
	s, r, b := runtimeFixture(t)
	old := hash(r.a.Config.Published)
	p := r.a.Config.Draft.Products[0]
	p.CostVersion, p.CostRules = 0, nil // client cannot request legacy admission
	d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{p}})
	must(t, err)
	if d.Config.Draft.Products[0].CostVersion != 1 || !hasCode(d.Config.Validation, "MISSING_COST", "UI_FIXABLE") {
		t.Fatal(d.Config.Validation.Diagnostics)
	}
	if hash(d.Config.Published) != old {
		t.Fatal("incomplete cost draft changed publication")
	}
	if _, err = s.PublishSelected(context.Background(), 7, d.Config.RecordVersion, d.Config.Draft.Revision, []string{p.ProductID}); !errors.Is(err, ErrValidation) {
		t.Fatal(err)
	}
	if _, err = s.SaveDraft(context.Background(), 7, d.Config.RecordVersion-1, DraftInput{Products: []Product{p}}); !errors.Is(err, ErrStale) {
		t.Fatal(err)
	}
	bound, err := ResolvePublishedImageOffer(&r.a, b.Offer.OfferID, b.Spec)
	must(t, err)
	cost, _, err := ResolvePublishedCost(&r.a, bound)
	must(t, err)
	if cost.Amount != "0.35" {
		t.Fatal("draft repriced publication", cost)
	}
}

func TestCostPublishedExactModelIgnoresAPIMapping(t *testing.T) {
	_, r, b := runtimeFixture(t)
	before, _, err := ResolvePublishedCost(&r.a, b)
	must(t, err)
	r.a.ModelMapping = map[string]string{"gpt-image-2": "api-only-other-model", "*": "api-only-fallback"}
	after, err := ResolvePublishedImageOffer(&r.a, b.Offer.OfferID, b.Spec)
	must(t, err)
	if hash(b) != hash(after) {
		t.Fatal("API alias mutation invalidated Studio quote")
	}
	cost, _, err := ResolvePublishedCost(&r.a, after)
	must(t, err)
	if cost != before {
		t.Fatal("API mapping changed cost")
	}
	if _, err := InspectPublishedOffers(context.Background(), &r.a, "image"); err != nil {
		t.Fatal(err)
	}
}

package mediaworkbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imageplan"
	"github.com/shopspring/decimal"
)

const ImageBindingVersion = "published_image_binding_v1"

var ErrRuntimeBinding = errors.New("published image binding unavailable; obtain a new quote")
var moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$`)

// DecimalAmount never rounds or parses through float. The text is authoritative.
func DecimalAmount(text string) (decimal.Decimal, error) {
	if len(text) > 21 || !moneyPattern.MatchString(text) {
		return decimal.Zero, ErrRuntimeBinding
	}
	n, err := decimal.NewFromString(text)
	if err != nil || n.IsNegative() || !n.LessThan(decimal.New(1, 12)) {
		return decimal.Zero, ErrRuntimeBinding
	}
	return n, nil
}

func ValidateImageSalePrice(p Price) error {
	if p.Currency != "CNY" || p.BillingMode != "per_request" {
		return ErrRuntimeBinding
	}
	_, err := DecimalAmount(p.Amount)
	return err
}

// PriceForQuantity freezes the customer unit price and the exact total for an
// image request. Quantity is part of the quoted request, but never a pricing
// matrix dimension; it is applied once at quote time and carried through the
// native settlement command.
func PriceForQuantity(p Price, quantity int) (Price, Price, error) {
	if ValidateImageSalePrice(p) != nil || quantity < 1 || quantity > 10 {
		return Price{}, Price{}, ErrRuntimeBinding
	}
	unit, err := DecimalAmount(p.Amount)
	if err != nil {
		return Price{}, Price{}, err
	}
	total := unit.Mul(decimal.NewFromInt(int64(quantity)))
	// Keep the unit amount's decimal scale in the frozen total so existing
	// exact-text billing and display contracts remain stable (0.80 stays 0.80).
	precision := int32(0)
	if dot := strings.IndexByte(p.Amount, '.'); dot >= 0 {
		precision = int32(len(p.Amount) - dot - 1)
	}
	amount := total.StringFixed(precision)
	if _, err = DecimalAmount(amount); err != nil {
		return Price{}, Price{}, err
	}
	return p, Price{Amount: amount, Currency: p.Currency, BillingMode: p.BillingMode}, nil
}

type ResolvedImageOffer struct {
	Version           string       `json:"version"`
	PublishedRevision string       `json:"published_revision"`
	Dependencies      Dependencies `json:"dependencies"`
	Offer             Offer        `json:"offer"`
	Spec              Spec         `json:"spec"`
	SpecHash          string       `json:"spec_hash"`
}

func NormalizeImageSpec(s Spec) (Spec, string, error) {
	if s.Count < 1 || s.Count > 10 || s.Images < 0 || s.Images > 16 || s.Videos != 0 || s.Audio != 0 || s.DurationSeconds != 0 {
		return s, "", ErrRuntimeBinding
	}
	for _, v := range []string{s.Resolution, s.AspectRatio, s.Quality} {
		if strings.TrimSpace(v) != v || len(v) > 128 {
			return s, "", ErrRuntimeBinding
		}
	}
	// Struct field order is fixed; hash never depends on map traversal.
	return s, hash(s), nil
}

func ResolvePublishedImageOffer(a *Account, offerID string, s Spec) (ResolvedImageOffer, error) {
	var r ResolvedImageOffer
	if a == nil || a.Config == nil || !a.Config.Sales.Enabled || !publishedReady(a) {
		return r, ErrRuntimeBinding
	}
	s, h, err := NormalizeImageSpec(s)
	if err != nil {
		return r, err
	}
	for _, o := range a.Config.Published.Offers {
		if o.OfferID != offerID {
			continue
		}
		d, ok := Descriptor(o.Adapter.Kind)
		config := o.ResolvedConfig
		if s.Images > 0 {
			config.Execution = config.EditExecution
		}
		exec, execErr := PlanImageExecution(config, 1)
		if !ok || execErr != nil || exec.Mode == ImageExecutionProviderAsync || d.Kind != "openai_images" || o.AccountID != a.ID || o.MediaType != "image" || d.Auth != "account_apikey" || d.Transport != "https_json" || d.TaskFlow != "sync" || o.Adapter != (AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}) || s.Images > d.MaxReferences || !o.Matches(s) || ValidateImageSalePrice(o.SalePrice) != nil {
			return r, ErrRuntimeBinding
		}
		r = ResolvedImageOffer{ImageBindingVersion, a.Config.Published.Revision, a.Config.Published.Dependencies, o, s, h}
		return r, nil
	}
	return r, ErrRuntimeBinding
}

// Enumerate the validator's executable cases rather than assuming the first
// Cartesian spec survives an offer's exclusions.
func PublishedImageOfferQuoteable(a *Account, offerID string) bool {
	if a == nil || a.Config == nil || a.Config.Published == nil || !publishedReady(a) {
		return false
	}
	p := a.Config.Published
	v, _ := Validate(a, Draft{Revision: p.SourceDraftRevision, Products: p.Products}, p.PublishedAt)
	for _, preview := range v.Previews {
		if _, err := ResolvePublishedImageOffer(a, offerID, preview.Spec); err == nil {
			return true
		}
	}
	return false
}

// Public offer identifiers are resolved across authorized accounts; no caller
// supplied Account ID participates in dispatch selection.
func (s *Service) ResolvePublishedImageOffer(ctx context.Context, offerID string, spec Spec, allowed func(int64) bool) (ResolvedImageOffer, error) {
	rows, err := s.repo.List(ctx)
	if err != nil {
		return ResolvedImageOffer{}, err
	}
	var found *ResolvedImageOffer
	for i := range rows {
		if allowed == nil || !allowed(rows[i].ID) {
			continue
		}
		r, e := ResolvePublishedImageOffer(&rows[i], offerID, spec)
		if e == nil {
			if found != nil {
				return r, ErrRuntimeBinding
			}
			found = &r
		}
	}
	if found == nil {
		return ResolvedImageOffer{}, ErrRuntimeBinding
	}
	return *found, nil
}

func CompilePublishedImagePlan(r ResolvedImageOffer, prompt string, references []string) (imageplan.Plan, error) {
	return CompilePublishedImagePlanForCount(r, prompt, references, r.Spec.Count)
}

// CompilePublishedImagePlanForCount preserves the frozen binding while
// changing only the upstream output count for one execution unit.
func CompilePublishedImagePlanForCount(r ResolvedImageOffer, prompt string, references []string, count int) (imageplan.Plan, error) {
	if r.Version != ImageBindingVersion || r.SpecHash != hash(r.Spec) || len(references) != r.Spec.Images || !r.Offer.Matches(r.Spec) || strings.TrimSpace(prompt) == "" {
		return imageplan.Plan{}, ErrRuntimeBinding
	}
	if count < 1 || count > r.Spec.Count {
		return imageplan.Plan{}, ErrRuntimeBinding
	}
	d, ok := Descriptor(r.Offer.Adapter.Kind)
	if !ok || d.Kind != "openai_images" || r.Offer.Adapter != (AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}) {
		return imageplan.Plan{}, ErrRuntimeBinding
	}
	// Use the validator's compiler to establish the same field mappings, then
	// replace only prompt and reference asset slots before materialization.
	p := Product{SiteModel: r.Offer.SiteModel, UpstreamModel: r.Offer.UpstreamModel, AdapterConfig: r.Offer.ResolvedConfig}
	spec := r.Spec
	spec.Count = count
	dry, err := compilePlan(p, spec)
	if err != nil {
		return dry, err
	}
	fields := dry.Fields
	fields["prompt"] = prompt
	if len(references) > 0 {
		images := make([]map[string]string, len(references))
		for i, v := range references {
			if v == "" {
				return dry, fmt.Errorf("missing reference")
			}
			images[i] = map[string]string{"image_url": v}
		}
		fields["images"] = images
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return dry, err
	}
	return imageplan.CompileJSON(body, r.Offer.UpstreamModel, dry.Path)
}

func PublishedImageExecution(r ResolvedImageOffer) (ImageExecutionPlan, error) {
	config := r.Offer.ResolvedConfig
	if r.Spec.Images > 0 {
		config.Execution = config.EditExecution
	}
	return PlanImageExecution(config, r.Spec.Count)
}

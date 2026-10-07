package mediaworkbench

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"slices"
	"time"
)

// Explicit administrator action on an existing native Account. Never derives
// protocol support from a host, slot name, model discovery or credentials.
func (s *Service) BindVideoAdapter(ctx context.Context, id, expected int64, kind string) (*Detail, error) {
	a, e := s.mutable(ctx, id, expected)
	if e != nil {
		return nil, e
	}
	d, ok := Descriptor(kind)
	if !ok || d.Kind != "laoli_video" || a.Platform != "openai" || !slices.Contains(a.Config.MediaTypes, "video") || a.Config.Sales.Enabled {
		return nil, ErrInvalid
	}
	if a.Config.AdapterBindings == nil {
		a.Config.AdapterBindings = map[string]AdapterBinding{}
	}
	a.Config.AdapterBindings["video"] = AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow}
	a.Config.RecordVersion++
	a.Config.Validation, _ = Validate(a, a.Config.Draft, time.Now().UTC())
	if e = s.repo.CompareAndSwap(ctx, id, expected, a.Config); e != nil {
		return nil, e
	}
	return describe(a), nil
}

type ResolvedVideoOffer struct {
	PublishedRevision string       `json:"published_revision"`
	Dependencies      Dependencies `json:"dependencies"`
	Offer             Offer        `json:"offer"`
	Spec              Spec         `json:"spec"`
	SpecHash          string       `json:"spec_hash"`
}

func ValidateVideoSalePrice(p Price) error {
	if p.Currency != "CNY" || p.BillingMode != "per_request" {
		return ErrRuntimeBinding
	}
	n, err := DecimalAmount(p.Amount)
	if err != nil || !n.IsPositive() {
		return ErrRuntimeBinding
	}
	return nil
}

func PublishedVideoOffers(a *Account) []Offer {
	if a == nil || a.Config == nil || !a.Config.Sales.Enabled || !publishedReady(a) {
		return nil
	}
	out := []Offer{}
	for _, o := range a.Config.Published.Offers {
		if o.MediaType == "video" && o.Adapter.Kind == "laoli_video" && ValidateVideoSalePrice(o.SalePrice) == nil {
			out = append(out, o)
		}
	}
	return out
}

func ResolvePublishedVideoOffer(a *Account, offerID string, spec Spec) (ResolvedVideoOffer, error) {
	var r ResolvedVideoOffer
	if a == nil || a.Config == nil || !a.Config.Sales.Enabled || !publishedReady(a) || spec.Count != 1 || spec.DurationSeconds <= 0 || spec.Quality != "" {
		return r, ErrRuntimeBinding
	}
	for _, o := range a.Config.Published.Offers {
		if o.OfferID != offerID {
			continue
		}
		if o.MediaType != "video" || o.AccountID != a.ID || o.Adapter != (AdapterBinding{"laoli_video", videoplan.Revision, "account_apikey", "async"}) || !o.Matches(spec) || ValidateVideoSalePrice(o.SalePrice) != nil {
			return r, ErrRuntimeBinding
		}
		n, e := DecimalAmount(o.SalePrice.Amount)
		if e != nil || !n.IsPositive() {
			return r, ErrRuntimeBinding
		}
		return ResolvedVideoOffer{a.Config.Published.Revision, a.Config.Published.Dependencies, o, spec, hash(spec)}, nil
	}
	return r, ErrRuntimeBinding
}

func (s *Service) ResolvePublishedVideoOffer(ctx context.Context, id string, spec Spec, allowed func(int64) bool) (ResolvedVideoOffer, error) {
	rows, e := s.repo.List(ctx)
	if e != nil {
		return ResolvedVideoOffer{}, e
	}
	var found *ResolvedVideoOffer
	for i := range rows {
		if allowed == nil || !allowed(rows[i].ID) {
			continue
		}
		r, e := ResolvePublishedVideoOffer(&rows[i], id, spec)
		if e != nil {
			continue
		}
		if found != nil {
			return r, ErrRuntimeBinding
		}
		found = &r
	}
	if found == nil {
		return ResolvedVideoOffer{}, ErrRuntimeBinding
	}
	return *found, nil
}

func CompilePublishedVideoPlan(r ResolvedVideoOffer, body []byte) (videoplan.Plan, error) {
	if r.SpecHash != hash(r.Spec) || !r.Offer.Matches(r.Spec) {
		return videoplan.Plan{}, ErrRuntimeBinding
	}
	m, ok := VideoProfileModel(Product{SiteModel: r.Offer.SiteModel, UpstreamModel: r.Offer.UpstreamModel, MediaType: "video", Capabilities: Capabilities{Resolutions: []string{r.Spec.Resolution}, AspectRatios: []string{r.Spec.AspectRatio}, DurationsSeconds: []int{r.Spec.DurationSeconds}, Count: Range{Min: 1, Max: 1}, References: References{Image: Range{Min: 0, Max: r.Spec.Images}, Video: Range{Min: 0, Max: r.Spec.Videos}, Audio: Range{Min: 0, Max: r.Spec.Audio}, TotalMax: r.Spec.Images + r.Spec.Videos + r.Spec.Audio}}, AdapterConfig: r.Offer.ResolvedConfig})
	if !ok {
		return videoplan.Plan{}, ErrRuntimeBinding
	}
	p, e := videoplan.CompilePlanForModel(m, r.Offer.UpstreamModel, body)
	if e != nil {
		return p, e
	}
	resolution, ratio, duration, images, videos, audio, e := videoplan.InspectForModel(m, body)
	actual := Spec{Count: 1, Resolution: resolution, AspectRatio: ratio, DurationSeconds: duration, Images: images, Videos: videos, Audio: audio}
	if e != nil || actual != r.Spec {
		return videoplan.Plan{}, ErrRuntimeBinding
	}
	return p, nil
}

package mediaworkbench

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"slices"
	"strings"
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
	return ValidateMediaSalePrice(p)
}

func PublishedVideoOffers(a *Account) []Offer {
	offers, _ := PublishedVideoOffersContext(context.Background(), a)
	return offers
}

// All products are checked against this fresh immutable Account; results live
// only for this loop and never grant availability to a later repository read.
func PublishedVideoOffersContext(ctx context.Context, a *Account) ([]Offer, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ready := publishedSnapshotValidator(ctx, a)
	if a == nil || a.Config == nil || !a.Config.Sales.Enabled || !publishedReadyWithValidation(ctx, a, ready) {
		return nil, ctx.Err()
	}
	out := []Offer{}
	for _, o := range a.Config.Published.Offers {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if o.MediaType == "video" && ready(o.ProductID) && validVideoBinding(o.Adapter) && ValidateVideoSalePrice(o.SalePrice) == nil {
			out = append(out, o)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func ResolvePublishedVideoOffer(a *Account, offerID string, spec Spec) (ResolvedVideoOffer, error) {
	return ResolvePublishedVideoOfferContext(context.Background(), a, offerID, spec)
}

// ResolvePublishedVideoOfferContext keeps validation scoped to the current
// request while resolving the supplied fresh Account snapshot on every call.
func ResolvePublishedVideoOfferContext(ctx context.Context, a *Account, offerID string, spec Spec) (ResolvedVideoOffer, error) {
	var r ResolvedVideoOffer
	if ctx.Err() != nil || a == nil || a.Config == nil || !a.Config.Sales.Enabled || !publishedOfferReady(ctx, a, offerID) || ctx.Err() != nil {
		return r, ErrRuntimeBinding
	}
	return resolvePublishedVideoOffer(a, offerID, spec)
}

func resolvePublishedVideoOffer(a *Account, offerID string, spec Spec) (ResolvedVideoOffer, error) {
	return resolvePublishedVideoOfferWithSnapshot(a, offerID, spec, func(o Offer) (string, Dependencies) {
		return offerSnapshot(a, o)
	})
}

// The inspection caller may reuse an Offer snapshot only while inspecting the
// same immutable Account. All spec, offer, price and adapter checks stay here.
func resolvePublishedVideoOfferWithSnapshot(a *Account, offerID string, spec Spec, snapshot func(Offer) (string, Dependencies)) (ResolvedVideoOffer, error) {
	var r ResolvedVideoOffer
	if spec.Count != 1 || spec.DurationSeconds <= 0 || spec.Quality != "" {
		return r, ErrRuntimeBinding
	}
	for _, o := range a.Config.Published.Offers {
		if o.OfferID != offerID {
			continue
		}
		if o.MediaType != "video" || o.AccountID != a.ID || !validVideoBinding(o.Adapter) || !adapterOwnsPlatform(o.Adapter.Kind, a.Platform) || !o.Matches(spec) || ValidateVideoSalePrice(o.SalePrice) != nil {
			return r, ErrRuntimeBinding
		}
		n, e := DecimalAmount(o.SalePrice.Amount)
		if e != nil || !n.IsPositive() {
			return r, ErrRuntimeBinding
		}
		revision, deps := snapshot(o)
		return ResolvedVideoOffer{revision, deps, o, spec, hash(spec)}, nil
	}
	return r, ErrRuntimeBinding
}

func validVideoBinding(b AdapterBinding) bool {
	d, ok := Descriptor(b.Kind)
	return ok && d.MediaType == "video" && b == (AdapterBinding{d.Kind, d.Revision, d.Auth, d.TaskFlow})
}
func ValidVideoBinding(b AdapterBinding) bool { return validVideoBinding(b) }

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
		r, e := ResolvePublishedVideoOfferContext(ctx, &rows[i], id, spec)
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
	// This provider fixes output size in model metadata, rather than a request
	// field. Preserve the exact sold specification; only letter case is equal.
	if e == nil && m.Mode == "image2pro" && strings.EqualFold(resolution, r.Spec.Resolution) {
		resolution = r.Spec.Resolution
	}
	actual := Spec{Count: 1, Resolution: resolution, AspectRatio: ratio, DurationSeconds: duration, Images: images, Videos: videos, Audio: audio}
	if e != nil || actual != r.Spec {
		return videoplan.Plan{}, ErrRuntimeBinding
	}
	return p, nil
}

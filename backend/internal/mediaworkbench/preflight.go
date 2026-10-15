package mediaworkbench

import (
	"context"
	"time"
)

// PublishedInspection is a completed, non-paid check, not an admission grant.
// No validated Account or reusable validation bypass is exposed to callers.
// The service must re-read dependencies after checking and before enabling.
type PublishedInspection struct {
	Offers          []PublishedOfferInspection
	SpecCount       int
	ValidationTime  time.Duration
	CompilationTime time.Duration
}
type PublishedOfferInspection struct {
	Offer     Offer
	Selected  map[string]Spec
	SpecCount int
	Err       error
}

// InspectPublishedOffers validates each published product once, then
// checks EVERY allowed spec with the same resolvers/compilers as native quotes.
// a must be the caller's request-local repository snapshot. Nothing is cached
// between requests, and mutable Draft never supplies the checked specifications.
func InspectPublishedOffers(ctx context.Context, a *Account, media string) (out PublishedInspection, err error) {
	if err = ctx.Err(); err != nil {
		return
	}
	start := time.Now()
	ready := publishedEnvelopeReady(a) && a.Config.Sales.Enabled
	valid := map[string]bool{}
	if ready {
		for _, p := range a.Config.Published.Products {
			valid[p.ProductID] = publishedProductReady(ctx, a, p.ProductID)
		}
	}
	out.ValidationTime = time.Since(start)
	if err = ctx.Err(); err != nil {
		return
	}
	if !ready || (media != "image" && media != "video") {
		return out, ErrRuntimeBinding
	}
	start = time.Now()
	defer func() { out.CompilationTime = time.Since(start) }()
	for _, o := range a.Config.Published.Offers {
		if err = ctx.Err(); err != nil {
			return
		}
		if o.MediaType != media {
			continue
		}
		checked := PublishedOfferInspection{Offer: o, Selected: map[string]Spec{}}
		if !valid[o.ProductID] {
			checked.Err = ErrRuntimeBinding
			out.Offers = append(out.Offers, checked)
			continue
		}
		cases, e := publishedOfferSpecs(a, o)
		for _, spec := range cases {
			if err = ctx.Err(); err != nil {
				return
			}
			if e != nil {
				break
			}
			if media == "image" {
				var resolved ResolvedImageOffer
				resolved, e = resolvePublishedImageOffer(a, o.OfferID, spec)
				if e == nil {
					_, e = PublishedImageExecution(resolved)
				}
				if e == nil {
					refs := make([]string, spec.Images)
					for i := range refs {
						refs[i] = "data:image/png;base64,c3ludGhldGlj"
					}
					_, e = CompilePublishedImagePlan(resolved, "non-paid preflight", refs)
				}
			} else {
				_, e = resolvePublishedVideoOffer(a, o.OfferID, spec)
			}
			if e != nil {
				break
			}
			checked.SpecCount++
			out.SpecCount++
			path := "text"
			if spec.Images+spec.Videos+spec.Audio > 0 {
				path = "edit"
			}
			if _, ok := checked.Selected[path]; !ok {
				checked.Selected[path] = spec
			}
		}
		checked.Err = e
		out.Offers = append(out.Offers, checked)
	}
	if err = ctx.Err(); err != nil {
		return
	}
	validOffers := 0
	for _, checked := range out.Offers {
		if checked.Err == nil {
			validOffers++
		}
	}
	if validOffers == 0 {
		return out, ErrRuntimeBinding
	}
	return out, nil
}

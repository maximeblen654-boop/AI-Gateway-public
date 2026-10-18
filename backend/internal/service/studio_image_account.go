package service

import (
	"context"
	"errors"
	"slices"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// Trusted selector loads exactly one DB identity. No scheduler, sticky binding,
// guardian redirect, proxy quarantine bypass or account fallback is invoked.
func (s *OpenAIGatewayService) SelectQuotedImageAccount(ctx context.Context, q StudioImageQuote, mediaRepo mediaworkbench.Repository, admit bool, gemini ...*GeminiMessagesCompatService) (*Account, func(), error) {
	fail := func() (*Account, func(), error) { return nil, nil, mediaworkbench.ErrRuntimeBinding }
	if s == nil || s.accountRepo == nil || mediaRepo == nil || q.Owner.GroupID <= 0 {
		return fail()
	}
	a, err := s.accountRepo.GetByID(ctx, q.Binding.Offer.AccountID)
	if err != nil || a == nil {
		return fail()
	}
	if !studioMediaAccountSupported(a) || a.Type != firstNonEmptyString(q.AccountType, AccountTypeAPIKey) || a.Platform != firstNonEmptyString(q.Platform, PlatformOpenAI) || a.ParentAccountID != nil || !a.IsSchedulable() || !slices.Contains(a.GroupIDs, q.Owner.GroupID) {
		return fail()
	}
	if a.HasAnyQuotaLimit() && !q.AccountQuotaEnabled {
		return fail()
	}
	if a.Platform == PlatformGrok {
		if eligible, _ := a.GrokMediaGenerationEligibility(); !eligible {
			return fail()
		}
	}
	ma, err := mediaRepo.Get(ctx, a.ID)
	if err != nil {
		return fail()
	}
	current, err := mediaworkbench.ResolvePublishedImageOffer(ma, q.Binding.Offer.OfferID, q.Binding.Spec)
	if err != nil || studioHash(current) != studioHash(q.Binding) {
		return fail()
	}
	requested := current.Offer.SiteModel
	if current.Offer.CostVersion >= 1 {
		requested = current.Offer.UpstreamModel
	}
	ctx = withPublishedMediaModel(ctx, a, requested, current.Offer.UpstreamModel, current.Offer.CostVersion >= 1)
	a = publishedMediaExecutionAccount(ctx, a, requested)
	ctx = s.withOpenAIQuotaAutoPauseContext(ctx)
	gid := q.Owner.GroupID
	if a.Platform == PlatformGemini {
		if len(gemini) == 0 || gemini[0] == nil || !gemini[0].isAccountUsableForRequest(ctx, a, requested, PlatformGemini, false) {
			return fail()
		}
	} else {
		a = s.recheckSelectedOpenAIAccountFromDBBeforeProfit(ctx, a, &gid, a.Platform, requested, false, "")
	}
	checker := defaultOpenAIAccountScheduler{service: s}
	capability := OpenAIImagesCapability("")
	if a != nil && a.Platform == PlatformOpenAI {
		capability = OpenAIImagesCapabilityNative
	}
	req := OpenAIAccountScheduleRequest{GroupID: &gid, Platform: q.Platform, RequestedModel: requested, RequiredImageCapability: capability, RequirePrivacySet: s.openAIGroupRequiresPrivacySet(ctx, &gid)}
	if a == nil || !a.IsSchedulable() || !slices.Contains(a.GroupIDs, gid) || !checker.isAccountRequestCompatible(ctx, a, req) || s.isOpenAIAccountRequestRuntimeBlocked(a, requested) {
		return fail()
	}
	if (q.Binding.Offer.CostVersion == 0 && a.GetMappedModel(q.Binding.Offer.SiteModel) != q.Binding.Offer.UpstreamModel) || studioMediaBaseURL(a) != q.BaseURL || studioOfferCredentialFingerprint(a, q.Binding.Offer) != q.CredentialFingerprint {
		return fail()
	}
	if a.ProxyID != nil && (a.Proxy == nil || a.Proxy.ID != *a.ProxyID) {
		return fail()
	}
	if _, err = s.validateUpstreamBaseURL(q.BaseURL); err != nil {
		return fail()
	}
	release := func() {}
	if admit {
		if s.concurrencyService == nil {
			return nil, nil, errors.New("exact image admission unavailable")
		}
		slot, e := s.concurrencyService.AcquireAccountSlot(ctx, a.ID, a.Concurrency)
		if e != nil || slot == nil || !slot.Acquired {
			return fail()
		}
		release = slot.ReleaseFunc
		// Recheck after acquiring the slot; do not return to candidate selection.
		fresh, _, e := s.SelectQuotedImageAccount(ctx, q, mediaRepo, false, gemini...)
		if e != nil {
			release()
			return fail()
		}
		a = fresh
	}
	return a, release, nil
}

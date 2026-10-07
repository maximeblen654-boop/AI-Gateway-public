package service

import (
	"context"
	"errors"
	"slices"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

// Trusted selector loads exactly one DB identity. No scheduler, sticky binding,
// guardian redirect, proxy quarantine bypass or account fallback is invoked.
func (s *OpenAIGatewayService) SelectQuotedImageAccount(ctx context.Context, q StudioImageQuote, mediaRepo mediaworkbench.Repository, admit bool) (*Account, func(), error) {
	fail := func() (*Account, func(), error) { return nil, nil, mediaworkbench.ErrRuntimeBinding }
	if s == nil || s.accountRepo == nil || mediaRepo == nil || q.Owner.GroupID <= 0 {
		return fail()
	}
	a, err := s.accountRepo.GetByID(ctx, q.Binding.Offer.AccountID)
	if err != nil || a == nil {
		return fail()
	}
	if a.Type != AccountTypeAPIKey || a.Platform != PlatformOpenAI || a.ParentAccountID != nil || !a.IsSchedulable() || !slices.Contains(a.GroupIDs, q.Owner.GroupID) {
		return fail()
	}
	ctx = s.withOpenAIQuotaAutoPauseContext(ctx)
	gid := q.Owner.GroupID
	a = s.recheckSelectedOpenAIAccountFromDBBeforeProfit(ctx, a, &gid, PlatformOpenAI, q.Binding.Offer.SiteModel, false, "")
	checker := defaultOpenAIAccountScheduler{service: s}
	req := OpenAIAccountScheduleRequest{GroupID: &gid, Platform: PlatformOpenAI, RequestedModel: q.Binding.Offer.SiteModel, RequiredImageCapability: OpenAIImagesCapabilityNative, RequirePrivacySet: s.openAIGroupRequiresPrivacySet(ctx, &gid)}
	if a == nil || !a.IsSchedulable() || !slices.Contains(a.GroupIDs, gid) || !checker.isAccountRequestCompatible(ctx, a, req) || s.isOpenAIAccountRequestRuntimeBlocked(a, q.Binding.Offer.SiteModel) {
		return fail()
	}
	if a.GetMappedModel(q.Binding.Offer.SiteModel) != q.Binding.Offer.UpstreamModel || a.GetOpenAIBaseURL() != q.BaseURL || studioCredentialFingerprint(a) != q.CredentialFingerprint || a.GetOpenAIProtocolAPIKey() == "" {
		return fail()
	}
	if a.ProxyID != nil && (a.Proxy == nil || a.Proxy.ID != *a.ProxyID) {
		return fail()
	}
	if _, err = s.validateUpstreamBaseURL(q.BaseURL); err != nil {
		return fail()
	}
	ma, err := mediaRepo.Get(ctx, a.ID)
	if err != nil {
		return fail()
	}
	current, err := mediaworkbench.ResolvePublishedImageOffer(ma, q.Binding.Offer.OfferID, q.Binding.Spec)
	if err != nil || studioHash(current) != studioHash(q.Binding) {
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
		fresh, _, e := s.SelectQuotedImageAccount(ctx, q, mediaRepo, false)
		if e != nil {
			release()
			return fail()
		}
		a = fresh
	}
	return a, release, nil
}

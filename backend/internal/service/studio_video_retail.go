package service

import (
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/shopspring/decimal"
)

// This existing usage-log discriminator represents unknown procurement cost,
// not zero cost. It is never used by native API or image billing.
const StudioVideoRetailUsageMode = "studio_video_retail"
const StudioVideoRetailBindingVersion = "account_video_v2"

func videoRetailAccounting(a *Account, resolved mediaworkbench.ResolvedVideoOffer, at time.Time) (AccountAccountingSnapshot, error) {
	if a.HasAnyQuotaLimit() {
		return AccountAccountingSnapshot{}, QuoteFailure("account_quota_requires_cost", ErrStudioImageAccounting)
	}
	rateValue := 1.0
	if a.RateMultiplier != nil {
		rateValue = *a.RateMultiplier
	}
	rate, err := studioAccountingDecimal(rateValue)
	if err != nil || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) {
		return AccountAccountingSnapshot{}, ErrStudioImageAccounting
	}
	source := studioPublishedCostSourceID(a.ID, resolved.Offer.ProductID, resolved.PublishedRevision)
	return AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "unknown", SourceType: StudioVideoRetailUsageMode, SourceID: source, SourceHash: studioHash([]string{source, resolved.SpecHash}), AccountID: a.ID, UpstreamModel: resolved.Offer.UpstreamModel, SpecHash: resolved.SpecHash, RequestCount: 1, PricingAt: at, Unit: "CNY", AccountRateMultiplier: rate.String()}, nil
}

func validateVideoRetailAccounting(b *StudioVideoBinding) error {
	a := b.Accounting
	source := studioPublishedCostSourceID(b.Offer.AccountID, b.Offer.ProductID, b.PublishedRevision)
	rate, err := mediaworkbench.DecimalAmount(a.AccountRateMultiplier)
	if b.AccountQuotaEnabled || a.Version != StudioImageAccountingVersion || a.SourceState != "unknown" || a.SourceType != StudioVideoRetailUsageMode || a.SourceID != source || a.SourceHash != studioHash([]string{source, b.SpecHash}) || a.AccountID != b.Offer.AccountID || a.UpstreamModel != b.Offer.UpstreamModel || a.SpecHash != b.SpecHash || a.RequestCount != 1 || a.Unit != "CNY" || a.PricingAt.IsZero() || a.BaseAmount != "" || a.EffectiveAccountQuotaCost != "" || err != nil || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) {
		return ErrStudioVideoInvalidOrder
	}
	return nil
}

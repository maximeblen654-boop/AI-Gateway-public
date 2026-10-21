package service

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/shopspring/decimal"
)

const StudioImageAccountingVersion = "account_stats_snapshot_v1"

func studioPublishedCostSourceID(account int64, product, revision string) string {
	return fmt.Sprintf("account:%d/product:%s/published:%s", account, product, revision)
}

var ErrStudioImageAccounting = errors.New("independent Account-scoped image accounting unavailable")

// Independent of customer pricing. Stored with the quote, before a
// dispatch can be claimed; recovery never calls the live pricing resolver.
type AccountAccountingSnapshot struct {
	Version                   string    `json:"version"`
	SourceState               string    `json:"source_state"`
	SourceType                string    `json:"source_type"`
	SourceID                  string    `json:"source_id"`
	SourceHash                string    `json:"source_hash"`
	AccountID                 int64     `json:"account_id"`
	UpstreamModel             string    `json:"upstream_model"`
	SpecHash                  string    `json:"spec_hash"`
	RequestCount              int       `json:"request_count"`
	PricingAt                 time.Time `json:"pricing_at"`
	BaseAmount                string    `json:"base_amount"`
	Unit                      string    `json:"unit"`
	AccountRateMultiplier     string    `json:"account_rate_multiplier"`
	EffectiveAccountQuotaCost string    `json:"effective_account_quota_cost"`
}

func studioAccountingDecimal(v float64) (decimal.Decimal, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return decimal.Zero, ErrStudioImageAccounting
	}
	return mediaworkbench.DecimalAmount(strconv.FormatFloat(v, 'f', -1, 64))
}

// New Studio quotes never infer procurement from Published metadata, Channel
// pricing or customer sale. Historical snapshots are validated below solely for
// already-persisted receipts and settlement.
func imageRetailAccounting(a *Account, binding mediaworkbench.ResolvedImageOffer, at time.Time) (AccountAccountingSnapshot, error) {
	return mediaRetailAccounting(a, binding.Offer, binding.PublishedRevision, binding.SpecHash, binding.Spec.Count, at, StudioImageRetailUsageMode)
}

const StudioImageRetailUsageMode = "studio_image_retail"

func mediaRetailAccounting(a *Account, offer mediaworkbench.Offer, revision, specHash string, count int, at time.Time, mode string) (AccountAccountingSnapshot, error) {
	if a == nil || a.ID != offer.AccountID || count < 1 || at.IsZero() {
		return AccountAccountingSnapshot{}, ErrStudioImageAccounting
	}
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
	source := studioPublishedCostSourceID(a.ID, offer.ProductID, revision)
	return AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "unknown", SourceType: mode, SourceID: source, SourceHash: studioHash([]string{source, specHash}), AccountID: a.ID, UpstreamModel: offer.UpstreamModel, SpecHash: specHash, RequestCount: count, PricingAt: at, Unit: "CNY", AccountRateMultiplier: rate.String()}, nil
}

func validateMediaRetailAccounting(s AccountAccountingSnapshot, quota bool, offer mediaworkbench.Offer, revision, specHash string, count int, mode string) error {
	source := studioPublishedCostSourceID(offer.AccountID, offer.ProductID, revision)
	rate, err := mediaworkbench.DecimalAmount(s.AccountRateMultiplier)
	if quota || s.Version != StudioImageAccountingVersion || s.SourceState != "unknown" || s.SourceType != mode || s.SourceID != source || s.SourceHash != studioHash([]string{source, specHash}) || s.AccountID != offer.AccountID || s.UpstreamModel != offer.UpstreamModel || s.SpecHash != specHash || count < 1 || s.RequestCount != count || s.Unit != "CNY" || s.PricingAt.IsZero() || s.BaseAmount != "" || s.EffectiveAccountQuotaCost != "" || err != nil || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) {
		return ErrStudioImageAccounting
	}
	return nil
}

func (s AccountAccountingSnapshot) Validate(q StudioImageQuote) error {
	if s.SourceState == "unknown" {
		return validateMediaRetailAccounting(s, q.AccountQuotaEnabled, q.Binding.Offer, q.Binding.PublishedRevision, q.Binding.SpecHash, q.Binding.Spec.Count, StudioImageRetailUsageMode)
	}
	if s.Version != StudioImageAccountingVersion || s.AccountID != q.Binding.Offer.AccountID || s.UpstreamModel != q.Binding.Offer.UpstreamModel || s.SpecHash != q.Binding.SpecHash || s.RequestCount != q.Binding.Spec.Count || s.Unit != "CNY" || s.PricingAt.IsZero() {
		return ErrStudioImageAccounting
	}
	base, e1 := mediaworkbench.DecimalAmount(s.BaseAmount)
	rate, e2 := mediaworkbench.DecimalAmount(s.AccountRateMultiplier)
	effective, e3 := mediaworkbench.DecimalAmount(s.EffectiveAccountQuotaCost)
	if e1 != nil || e2 != nil || e3 != nil || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) || base.GreaterThanOrEqual(decimalSubscriptionLimit) || !base.Mul(rate).Equal(effective) {
		return ErrStudioImageAccounting
	}
	switch s.SourceState {
	case "resolved":
		if (s.SourceType != "explicit_account_stats_rule" && s.SourceType != "studio_published_cost") || s.SourceID == "" || len(s.SourceHash) != 64 {
			return ErrStudioImageAccounting
		}
	case "not_required":
		if q.AccountQuotaEnabled || s.SourceType != "unavailable" || !base.IsZero() || !effective.IsZero() {
			return ErrStudioImageAccounting
		}
	default:
		return ErrStudioImageAccounting
	}
	if q.Binding.Offer.CostVersion >= 1 && (s.SourceState != "resolved" || s.SourceType != "studio_published_cost" || s.SourceID != studioPublishedCostSourceID(s.AccountID, q.Binding.Offer.ProductID, q.Binding.PublishedRevision) || !videoDigest(s.SourceHash)) {
		return ErrStudioImageAccounting
	}
	return nil
}

package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/shopspring/decimal"
)

const StudioImageAccountingVersion = "account_stats_snapshot_v1"

var ErrStudioImageAccounting = errors.New("independent Account-scoped image accounting unavailable")

// Independent of Published/customer pricing. Stored with the quote, before a
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

// V1 deliberately accepts only flat per-request/image AccountStats rules with
// an explicit Account match. Group-only and customer pricing fallbacks do not
// participate. RequestCount is the frozen image count, as in native stats.
func ResolveStudioImageAccountCost(a *Account, binding mediaworkbench.ResolvedImageOffer, channel *Channel, at time.Time) (AccountAccountingSnapshot, error) {
	return resolveStudioAccountCost(a, binding, channel, at, "CNY", true)
}

// Flat native Account Stats rules are shared. Video does not inherit image
// fallback behavior: missing independent cost always prevents a new quote.
func resolveStudioAccountCost(a *Account, binding mediaworkbench.ResolvedImageOffer, channel *Channel, at time.Time, unitName string, image bool) (AccountAccountingSnapshot, error) {
	var out AccountAccountingSnapshot
	if a == nil || a.ID != binding.Offer.AccountID || binding.Spec.Count < 1 || at.IsZero() {
		return out, ErrStudioImageAccounting
	}
	rateValue := 1.0
	if a.RateMultiplier != nil {
		rateValue = *a.RateMultiplier
	}
	rate, err := studioAccountingDecimal(rateValue)
	if err != nil || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) {
		return out, ErrStudioImageAccounting
	}
	out = AccountAccountingSnapshot{Version: StudioImageAccountingVersion, SourceState: "not_required", SourceType: "unavailable", AccountID: a.ID, UpstreamModel: binding.Offer.UpstreamModel, SpecHash: binding.SpecHash, RequestCount: binding.Spec.Count, PricingAt: at, BaseAmount: "0", Unit: unitName, AccountRateMultiplier: rate.String(), EffectiveAccountQuotaCost: "0"}
	if channel != nil && channel.IsActive() {
		for _, rule := range channel.AccountStatsPricingRules {
			if !slices.Contains(rule.AccountIDs, a.ID) {
				continue
			}
			p := findPricingForModel(rule.Pricing, PlatformOpenAI, strings.ToLower(binding.Offer.UpstreamModel))
			if p == nil {
				continue
			}
			if (p.BillingMode != BillingModePerRequest && (!image || p.BillingMode != BillingModeImage)) || len(p.Intervals) > 0 || p.TimePricing != nil {
				return out, ErrStudioImageAccounting
			}
			var unit decimal.Decimal
			if p.AccountStatsPerRequestExact != nil {
				// NUMERIC may append zeroes to its declared scale; strip only insignificant
				// zeroes, never round. Significant ninth decimal digits are rejected.
				unit, err = decimal.NewFromString(*p.AccountStatsPerRequestExact)
				if err == nil {
					unit, err = mediaworkbench.DecimalAmount(unit.String())
				}
			} else if p.PerRequestPrice != nil {
				unit, err = studioAccountingDecimal(*p.PerRequestPrice)
			} else {
				return out, ErrStudioImageAccounting
			}
			if err != nil {
				return out, err
			}
			base := unit.Mul(decimal.NewFromInt(int64(binding.Spec.Count)))
			effective := base.Mul(rate)
			if _, err = mediaworkbench.DecimalAmount(base.String()); err != nil {
				return out, err
			}
			if _, err = mediaworkbench.DecimalAmount(effective.String()); err != nil {
				return out, err
			}
			out.SourceState = "resolved"
			out.SourceType = "explicit_account_stats_rule"
			out.SourceID = fmt.Sprintf("channel:%d/rule:%d/pricing:%d", channel.ID, rule.ID, p.ID)
			out.SourceHash = studioHash(struct {
				Rule       AccountStatsPricingRule
				ExactPrice string
			}{rule, unit.String()})
			out.BaseAmount = base.String()
			out.EffectiveAccountQuotaCost = effective.String()
			if base.GreaterThanOrEqual(decimalSubscriptionLimit) {
				return out, ErrStudioImageAccounting
			}
			return out, nil
		}
	}
	if a.HasAnyQuotaLimit() || !image {
		return out, ErrStudioImageAccounting
	}
	return out, nil
}

func (s *OpenAIGatewayService) studioImageAccountCost(ctx context.Context, a *Account, b mediaworkbench.ResolvedImageOffer, groupID int64, at time.Time) (AccountAccountingSnapshot, error) {
	var ch *Channel
	if s.channelService != nil && s.channelService.repo != nil {
		// Fresh native reads, including group-to-channel ownership; no cache revision
		// is misrepresented as the pricing source's current revision.
		id, err := s.channelService.repo.GetChannelIDByGroupID(ctx, groupID)
		if err != nil {
			return AccountAccountingSnapshot{}, err
		}
		if id > 0 {
			ch, err = s.channelService.repo.GetByID(ctx, id)
			if err != nil {
				return AccountAccountingSnapshot{}, err
			}
		}
	}
	return ResolveStudioImageAccountCost(a, b, ch, at)
}

func (s AccountAccountingSnapshot) Validate(q StudioImageQuote) error {
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
		if s.SourceType != "explicit_account_stats_rule" || s.SourceID == "" || len(s.SourceHash) != 64 {
			return ErrStudioImageAccounting
		}
	case "not_required":
		if q.AccountQuotaEnabled || s.SourceType != "unavailable" || !base.IsZero() || !effective.IsZero() {
			return ErrStudioImageAccounting
		}
	default:
		return ErrStudioImageAccounting
	}
	return nil
}

package service

import (
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/shopspring/decimal"
)

const StudioVideoBindingVersion = "account_video_v1"

// Private server snapshot. It contains no credentials and is never reconstructed
// from a slot, the live catalog or the customer's request during recovery.
type StudioVideoBinding struct {
	Version               string                    `json:"version"`
	QuoteID               string                    `json:"quote_id"`
	Owner                 StudioImageOwner          `json:"owner"`
	PublishedRevision     string                    `json:"published_revision"`
	Offer                 mediaworkbench.Offer      `json:"offer"`
	Spec                  mediaworkbench.Spec       `json:"spec"`
	SpecHash              string                    `json:"spec_hash"`
	PlanHash              string                    `json:"plan_hash"`
	RequestHash           string                    `json:"request_hash"`
	BaseURL               string                    `json:"base_url"`
	CredentialFingerprint string                    `json:"credential_fingerprint"`
	Accounting            AccountAccountingSnapshot `json:"account_accounting"`
	KeyQuotaEnabled       bool                      `json:"key_quota_enabled"`
	KeyRateEnabled        bool                      `json:"key_rate_enabled"`
	AccountQuotaEnabled   bool                      `json:"account_quota_enabled"`
	CreatedAt             time.Time                 `json:"created_at"`
	ExpiresAt             time.Time                 `json:"expires_at"`
}

func (b *StudioVideoBinding) Hash() string              { return studioHash(b) }
func (b *StudioVideoBinding) CapabilityVersion() string { return "av1_" + b.Hash() }

func (b *StudioVideoBinding) Validate() error {
	if b == nil || b.Version != StudioVideoBindingVersion || !studioImageTaskID.MatchString(b.QuoteID) ||
		b.Owner.UserID <= 0 || b.Owner.APIKeyID <= 0 || b.Owner.GroupID <= 0 || b.Offer.AccountID <= 0 ||
		b.PublishedRevision == "" || b.Offer.OfferID == "" || b.Offer.MediaType != "video" ||
		b.Offer.SiteModel == "" || b.Offer.UpstreamModel == "" ||
		b.Offer.Adapter != (mediaworkbench.AdapterBinding{Kind: "laoli_video", Revision: "laoli_video_json_v136_r1", Auth: "account_apikey", TaskFlow: "async"}) ||
		b.Spec.Count != 1 || b.Spec.DurationSeconds <= 0 || !b.Offer.Matches(b.Spec) ||
		b.SpecHash != studioHash(b.Spec) || !videoDigest(b.PlanHash) || !videoDigest(b.RequestHash) ||
		!strings.HasPrefix(b.BaseURL, "https://") || !videoDigest(b.CredentialFingerprint) ||
		b.CreatedAt.IsZero() || !b.ExpiresAt.After(b.CreatedAt) {
		return ErrStudioVideoInvalidOrder
	}
	// New Published video sale prices and Account cost snapshots use CNY. Keep
	// already-persisted USD snapshots readable for recovery; never rewrite them.
	sale := b.Offer.SalePrice
	n, err := mediaworkbench.DecimalAmount(sale.Amount)
	if err != nil || n.IsZero() || n.GreaterThanOrEqual(decimalSubscriptionLimit) || (sale.Currency != "CNY" && sale.Currency != "USD") || sale.BillingMode != "per_request" {
		return ErrStudioVideoInvalidOrder
	}
	a := b.Accounting
	base, e1 := mediaworkbench.DecimalAmount(a.BaseAmount)
	rate, e2 := mediaworkbench.DecimalAmount(a.AccountRateMultiplier)
	effective, e3 := mediaworkbench.DecimalAmount(a.EffectiveAccountQuotaCost)
	if e1 != nil || e2 != nil || e3 != nil || a.Version != StudioImageAccountingVersion ||
		a.SourceState != "resolved" || a.SourceType != "explicit_account_stats_rule" || a.SourceID == "" || !videoDigest(a.SourceHash) ||
		a.AccountID != b.Offer.AccountID || a.UpstreamModel != b.Offer.UpstreamModel || a.SpecHash != b.SpecHash || a.RequestCount != 1 ||
		a.Unit != sale.Currency || a.PricingAt.IsZero() || rate.Exponent() < -4 || rate.GreaterThanOrEqual(decimal.New(1, 6)) ||
		base.GreaterThanOrEqual(decimalSubscriptionLimit) || !base.Mul(rate).Equal(effective) {
		return ErrStudioVideoInvalidOrder
	}
	return nil
}

func videoDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Prefix is a persisted version discriminator, not an inferred Account mapping.
func AccountVideoChild(id string) bool { return strings.HasPrefix(id, "av_") }

func ValidateVideoBindingChild(id string, b *StudioVideoBinding) error {
	if b == nil {
		if AccountVideoChild(id) {
			return ErrStudioVideoInvalidOrder
		}
		return nil
	}
	if !AccountVideoChild(id) || !studioImageTaskID.MatchString(id) {
		return ErrStudioVideoInvalidOrder
	}
	return b.Validate()
}

func VideoAccountBillingCommand(childID string, b *StudioVideoBinding, finalFingerprint string) (*UsageBillingCommand, error) {
	if err := ValidateVideoBindingChild(childID, b); err != nil || b == nil {
		return nil, ErrStudioVideoInvalidOrder
	}
	// Capture already consumes the customer's hold. Native effects must never
	// deduct customer balance or subscription a second time.
	m := &UsageBillingExactAmounts{Balance: "0", Subscription: "0", APIKeyQuota: "0", APIKeyRateLimit: "0", AccountQuota: "0"}
	if b.KeyQuotaEnabled {
		m.APIKeyQuota = b.Offer.SalePrice.Amount
	}
	if b.KeyRateEnabled {
		m.APIKeyRateLimit = b.Offer.SalePrice.Amount
	}
	if b.AccountQuotaEnabled {
		m.AccountQuota = b.Accounting.EffectiveAccountQuotaCost
	}
	c := &UsageBillingCommand{RequestID: HashUsageRequestPayload([]byte("account-video:" + childID)), APIKeyID: b.Owner.APIKeyID,
		RequestFingerprint: finalFingerprint, RequestPayloadHash: b.RequestHash, UserID: b.Owner.UserID, AccountID: b.Offer.AccountID,
		AccountType: AccountTypeAPIKey, Model: b.Offer.SiteModel, MediaType: "video", ExactAmounts: m}
	return c, m.Validate()
}

func VideoAccountUsage(childID, upstreamID string, b *StudioVideoBinding) *UsageLog {
	sale, _ := decimal.NewFromString(b.Offer.SalePrice.Amount)
	base, _ := decimal.NewFromString(b.Accounting.BaseAmount)
	rate, _ := decimal.NewFromString(b.Accounting.AccountRateMultiplier)
	cost, multiplier := base.InexactFloat64(), rate.InexactFloat64()
	model, media, mode, inbound, endpoint := b.Offer.UpstreamModel, "video", "per_request", "/v1/studio/videos/tasks", "/v1/videos"
	return &UsageLog{UserID: b.Owner.UserID, APIKeyID: b.Owner.APIKeyID, AccountID: b.Offer.AccountID, GroupID: &b.Owner.GroupID,
		RequestID: HashUsageRequestPayload([]byte("account-video:" + childID)), Model: b.Offer.SiteModel, RequestedModel: b.Offer.SiteModel, UpstreamModel: &model,
		TotalCost: sale.InexactFloat64(), ActualCost: sale.InexactFloat64(), RateMultiplier: 1, AccountStatsCost: &cost, AccountRateMultiplier: &multiplier,
		BillingMode: &mode, RequestType: RequestTypeSync, MediaType: &media, VideoCount: 1, VideoResolution: &b.Spec.Resolution, VideoDurationSeconds: &b.Spec.DurationSeconds,
		InboundEndpoint: &inbound, UpstreamEndpoint: &endpoint, UpstreamRequestID: &upstreamID, CreatedAt: b.CreatedAt}
}

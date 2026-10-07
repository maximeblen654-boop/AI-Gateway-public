package service

import (
	"context"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/shopspring/decimal"
)

// These decimal strings enter the native transaction as numeric SQL parameters.
// No second balance ledger and no float conversion is used for ledger effects.
type UsageBillingExactAmounts struct {
	Balance         string
	Subscription    string
	APIKeyQuota     string
	APIKeyRateLimit string
	AccountQuota    string
}

func (m *UsageBillingExactAmounts) Validate() error {
	if m == nil {
		return nil
	}
	for _, s := range []string{m.Balance, m.Subscription, m.APIKeyQuota, m.APIKeyRateLimit, m.AccountQuota} {
		if _, err := mediaworkbench.DecimalAmount(s); err != nil {
			return err
		}
	}
	// Existing subscription columns are DECIMAL(20,10), not NUMERIC(20,8).
	n, _ := mediaworkbench.DecimalAmount(m.Subscription)
	if n.GreaterThanOrEqual(decimalSubscriptionLimit) {
		return mediaworkbench.ErrRuntimeBinding
	}
	return nil
}

func QuotedImageUsageLog(r *StudioImageReceipt) *UsageLog {
	q := r.Quote
	sale, _ := mediaworkbench.DecimalAmount(q.Binding.Offer.SalePrice.Amount)
	base, _ := mediaworkbench.DecimalAmount(q.Accounting.BaseAmount)
	rate, _ := mediaworkbench.DecimalAmount(q.Accounting.AccountRateMultiplier)
	baseFloat, rateFloat := base.InexactFloat64(), rate.InexactFloat64()
	upstream, mode, inbound := q.Binding.Offer.UpstreamModel, "image", "/v1/studio/images/tasks"
	log := &UsageLog{UserID: q.Owner.UserID, APIKeyID: q.Owner.APIKeyID, AccountID: q.Binding.Offer.AccountID, RequestID: HashUsageRequestPayload([]byte("studio-image:" + r.TaskID)), Model: q.Binding.Offer.SiteModel, RequestedModel: q.Binding.Offer.SiteModel, UpstreamModel: &upstream, GroupID: &q.Owner.GroupID, SubscriptionID: q.SubscriptionID, TotalCost: sale.InexactFloat64(), ActualCost: sale.InexactFloat64(), RateMultiplier: 1, AccountStatsCost: &baseFloat, AccountRateMultiplier: &rateFloat, BillingMode: &mode, RequestType: RequestTypeSync, ImageCount: q.Binding.Spec.Count, InboundEndpoint: &inbound, UpstreamEndpoint: &r.Endpoint, CreatedAt: q.CreatedAt}
	// Native schema accepts only these display buckets. Other administrator
	// resolutions retain their exact commercial spec in the immutable receipt.
	size := q.Binding.Spec.Resolution
	if size != "1K" && size != "2K" && size != "4K" {
		size = "mixed"
	}
	source := "input"
	log.ImageSize = &size
	log.ImageSizeSource = &source
	if q.SubscriptionID != nil {
		log.BillingType = BillingTypeSubscription
	}
	return log
}

var decimalSubscriptionLimit = mustStudioDecimal("10000000000")

func mustStudioDecimal(s string) decimal.Decimal { n, _ := decimal.NewFromString(s); return n }

func SettleQuotedImage(ctx context.Context, repo UsageBillingRepository, receipt *StudioImageReceipt) (*UsageBillingApplyResult, error) {
	cmd, err := QuotedImageBillingCommand(receipt)
	if err != nil || repo == nil {
		if err == nil {
			err = mediaworkbench.ErrRuntimeBinding
		}
		return nil, err
	}
	return repo.Apply(ctx, cmd)
}

func QuotedImageBillingCommand(receipt *StudioImageReceipt) (*UsageBillingCommand, error) {
	if receipt == nil {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	q, taskID, payloadHash, subscriptionID := receipt.Quote, receipt.TaskID, receipt.PayloadHash, receipt.Quote.SubscriptionID
	if mediaworkbench.ValidateImageSalePrice(q.Binding.Offer.SalePrice) != nil || q.BindingHash != studioQuoteHash(q) || receipt.PayloadHash != HashUsageRequestPayload(receipt.Request) || q.ID == "" || taskID == "" {
		return nil, mediaworkbench.ErrRuntimeBinding
	}
	if err := q.Accounting.Validate(q); err != nil {
		return nil, err
	}
	amount := q.Binding.Offer.SalePrice.Amount
	accountCost := q.Accounting.EffectiveAccountQuotaCost
	m := &UsageBillingExactAmounts{amount, "0", amount, amount, accountCost}
	if !q.KeyQuotaEnabled {
		m.APIKeyQuota = "0"
	}
	if !q.KeyRateEnabled {
		m.APIKeyRateLimit = "0"
	}
	if !q.AccountQuotaEnabled {
		m.AccountQuota = "0"
	}
	if subscriptionID != nil {
		m.Subscription = amount
		m.Balance = "0"
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	fingerprint := HashUsageRequestPayload([]byte(fmt.Sprintf("%s|%s|%s|%s|%s|CNY|%s|%d", q.BindingHash, q.ID, taskID, payloadHash, amount, studioHash(q.Accounting), valueOrZero(subscriptionID))))
	// Native request_id is VARCHAR(64); opaque task identifiers are hashed.
	cmd := &UsageBillingCommand{RequestID: HashUsageRequestPayload([]byte("studio-image:" + taskID)), RequestFingerprint: fingerprint, RequestPayloadHash: payloadHash, UserID: q.Owner.UserID, APIKeyID: q.Owner.APIKeyID, AccountID: q.Binding.Offer.AccountID, SubscriptionID: subscriptionID, AccountType: AccountTypeAPIKey, Model: q.Binding.Offer.SiteModel, MediaType: "image", ImageCount: q.Binding.Spec.Count, ExactAmounts: m, QuotedImage: receipt}
	if subscriptionID != nil {
		cmd.BillingType = BillingTypeSubscription
	}
	return cmd, nil
}

func ValidateQuotedImageBillingCommand(cmd *UsageBillingCommand) error {
	if cmd.QuotedImage == nil {
		return nil
	}
	expected, err := QuotedImageBillingCommand(cmd.QuotedImage)
	if err != nil {
		return err
	}
	// The native transaction must see the same immutable monetary event, rather
	// than arbitrary exact amounts accompanying a valid snapshot.
	if studioHash(cmd) != studioHash(expected) {
		return ErrUsageBillingRequestConflict
	}
	return nil
}

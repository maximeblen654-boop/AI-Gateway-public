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

// studioImagePrices preserves the old receipt meaning when the optional
// quantity fields are absent. New quotes carry an explicit unit and total;
// recovery of older quotes must continue to treat their sale_price as the
// already-frozen total and never silently reprice them.
func studioImagePrices(q StudioImageQuote) (unit mediaworkbench.Price, total mediaworkbench.Price, quantity int, err error) {
	quantity = q.Quantity
	if quantity < 1 {
		quantity = q.Binding.Spec.Count
	}
	if quantity < 1 || quantity > 10 {
		return unit, total, 0, mediaworkbench.ErrRuntimeBinding
	}
	if q.TotalPrice == nil {
		if mediaworkbench.ValidateImageSalePrice(q.Binding.Offer.SalePrice) != nil {
			return unit, total, 0, mediaworkbench.ErrRuntimeBinding
		}
		return q.Binding.Offer.SalePrice, q.Binding.Offer.SalePrice, quantity, nil
	}
	unit = q.Binding.Offer.SalePrice
	if q.UnitPrice != nil {
		unit = *q.UnitPrice
	}
	total = *q.TotalPrice
	if mediaworkbench.ValidateImageSalePrice(unit) != nil || mediaworkbench.ValidateImageSalePrice(total) != nil {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, mediaworkbench.ErrRuntimeBinding
	}
	_, expected, e := mediaworkbench.PriceForQuantity(unit, quantity)
	if e != nil || expected != total {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, mediaworkbench.ErrRuntimeBinding
	}
	return unit, total, quantity, nil
}

func studioImagePricesForQuantity(q StudioImageQuote, delivered int) (mediaworkbench.Price, mediaworkbench.Price, int, error) {
	unit, frozen, quoted, err := studioImagePrices(q)
	if err != nil || delivered < 1 || delivered > quoted {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, mediaworkbench.ErrRuntimeBinding
	}
	if delivered == quoted {
		return unit, frozen, delivered, nil
	}
	if q.UnitPrice == nil && q.TotalPrice == nil {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, mediaworkbench.ErrRuntimeBinding
	}
	_, partial, err := mediaworkbench.PriceForQuantity(unit, delivered)
	if err != nil {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, err
	}
	return unit, partial, delivered, nil
}

// StudioImagePrices exposes the frozen quote breakdown to the HTTP adapter
// without allowing the adapter to recompute or alter settlement values.
func StudioImagePrices(q StudioImageQuote) (mediaworkbench.Price, mediaworkbench.Price, int, error) {
	return studioImagePrices(q)
}

// StudioImageSettledPrice exposes the amount used by the already-applied
// native billing transaction.  It is deliberately available only after the
// durable receipt says billed; callers must never calculate a charge in the
// browser from a frozen quote.
func StudioImageSettledPrice(r *StudioImageReceipt) (mediaworkbench.Price, error) {
	if r == nil || r.BillingState != "billed" {
		return mediaworkbench.Price{}, mediaworkbench.ErrRuntimeBinding
	}
	_, total, _, err := studioImageReceiptPrices(r)
	if err != nil {
		return mediaworkbench.Price{}, err
	}
	return total, nil
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
	_, frozenTotal, quantity, err := studioImageReceiptPrices(r)
	if err != nil {
		frozenTotal = q.Binding.Offer.SalePrice
		quantity = q.Binding.Spec.Count
	}
	sale, _ := mediaworkbench.DecimalAmount(frozenTotal.Amount)
	base, _ := mediaworkbench.DecimalAmount(q.Accounting.BaseAmount)
	if r.Version == StudioImageMultiReceiptVersion {
		base, _ = scaleImageAccountAmount(q.Accounting.BaseAmount, quantity, q.Binding.Spec.Count)
	}
	rate, _ := mediaworkbench.DecimalAmount(q.Accounting.AccountRateMultiplier)
	baseFloat, rateFloat := base.InexactFloat64(), rate.InexactFloat64()
	upstream, mode, inbound := q.Binding.Offer.UpstreamModel, "image", "/v1/studio/images/tasks"
	log := &UsageLog{UserID: q.Owner.UserID, APIKeyID: q.Owner.APIKeyID, AccountID: q.Binding.Offer.AccountID, RequestID: HashUsageRequestPayload([]byte("studio-image:" + r.TaskID)), Model: q.Binding.Offer.SiteModel, RequestedModel: q.Binding.Offer.SiteModel, UpstreamModel: &upstream, GroupID: &q.Owner.GroupID, SubscriptionID: q.SubscriptionID, TotalCost: sale.InexactFloat64(), ActualCost: sale.InexactFloat64(), RateMultiplier: 1, AccountStatsCost: &baseFloat, AccountRateMultiplier: &rateFloat, BillingMode: &mode, RequestType: RequestTypeSync, ImageCount: quantity, InboundEndpoint: &inbound, UpstreamEndpoint: &r.Endpoint, CreatedAt: q.CreatedAt}
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
	_, frozenTotal, quantity, err := studioImageReceiptPrices(receipt)
	if err != nil {
		return nil, err
	}
	amount := frozenTotal.Amount
	accountCost := q.Accounting.EffectiveAccountQuotaCost
	if receipt.Version == StudioImageMultiReceiptVersion {
		scaled, e := scaleImageAccountAmount(accountCost, quantity, q.Binding.Spec.Count)
		if e != nil {
			return nil, e
		}
		accountCost = scaled.String()
	}
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
	if receipt.Version == StudioImageMultiReceiptVersion {
		fingerprint = studioHash([]any{fingerprint, quantity, receipt.ResultHash})
	}
	// Native request_id is VARCHAR(64); opaque task identifiers are hashed.
	cmd := &UsageBillingCommand{RequestID: HashUsageRequestPayload([]byte("studio-image:" + taskID)), RequestFingerprint: fingerprint, RequestPayloadHash: payloadHash, UserID: q.Owner.UserID, APIKeyID: q.Owner.APIKeyID, AccountID: q.Binding.Offer.AccountID, SubscriptionID: subscriptionID, AccountType: AccountTypeAPIKey, Model: q.Binding.Offer.SiteModel, MediaType: "image", ImageCount: quantity, ExactAmounts: m, QuotedImage: receipt}
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

func studioImageReceiptPrices(r *StudioImageReceipt) (mediaworkbench.Price, mediaworkbench.Price, int, error) {
	if r.Version != StudioImageMultiReceiptVersion {
		return studioImagePrices(r.Quote)
	}
	if r.Quote.Execution == nil || r.ResultHash == "" || r.PendingCount != 0 || r.DeliveredCount < 1 || r.ExpectedCount != r.Quote.Binding.Spec.Count || r.DeliveredCount+r.FailedCount != r.ExpectedCount {
		return mediaworkbench.Price{}, mediaworkbench.Price{}, 0, mediaworkbench.ErrRuntimeBinding
	}
	return studioImagePricesForQuantity(r.Quote, r.DeliveredCount)
}

func scaleImageAccountAmount(total string, quantity, quoted int) (decimal.Decimal, error) {
	value, err := mediaworkbench.DecimalAmount(total)
	if err != nil || quoted < 1 || quantity < 1 || quantity > quoted {
		return decimal.Zero, ErrStudioImageAccounting
	}
	scaled := value.Mul(decimal.NewFromInt(int64(quantity))).Div(decimal.NewFromInt(int64(quoted)))
	if !scaled.Mul(decimal.NewFromInt(int64(quoted))).Equal(value.Mul(decimal.NewFromInt(int64(quantity)))) {
		return decimal.Zero, ErrStudioImageAccounting
	}
	return mediaworkbench.DecimalAmount(scaled.String())
}

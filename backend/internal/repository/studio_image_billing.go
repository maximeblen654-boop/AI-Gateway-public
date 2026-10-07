package repository

import (
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/shopspring/decimal"
)

// Keep the original float parameter semantics for untyped integral Go literals.
// Published decimal text is unchanged and never converted through float.
func usageBillingSQLAmount(v any) any {
	if n, ok := v.(int); ok {
		return float64(n)
	}
	return v
}

func usageBillingPositive(c *service.UsageBillingCommand, kind string) bool {
	v := usageBillingMoney(c, kind)
	if s, ok := v.(string); ok {
		n, _ := decimal.NewFromString(s)
		return n.IsPositive()
	}
	n, ok := v.(float64)
	return ok && n > 0
}

func usageBillingDisplayFloat(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	text, ok := v.(string)
	if !ok {
		return 0
	}
	n, _ := decimal.NewFromString(text)
	return n.InexactFloat64()
}

// The float mirrors are used only for the existing positive/zero branches;
// authoritative SQL values for a quoted settlement remain decimal text.
func usageBillingMoney(c *service.UsageBillingCommand, kind string) any {
	if c.ExactAmounts != nil {
		switch kind {
		case "balance":
			return c.ExactAmounts.Balance
		case "subscription":
			return c.ExactAmounts.Subscription
		case "key_quota":
			return c.ExactAmounts.APIKeyQuota
		case "key_rate":
			return c.ExactAmounts.APIKeyRateLimit
		case "account":
			return c.ExactAmounts.AccountQuota
		}
	}
	switch kind {
	case "balance":
		return c.BalanceCost
	case "subscription":
		return c.SubscriptionCost
	case "key_quota":
		return c.APIKeyQuotaCost
	case "key_rate":
		return c.APIKeyRateLimitCost
	default:
		return c.AccountQuotaCost
	}
}

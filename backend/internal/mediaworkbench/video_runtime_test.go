package mediaworkbench

import "testing"

func TestValidateVideoSalePriceRejectsMissingAndZeroPrices(t *testing.T) {
	for _, p := range []Price{{Currency: "CNY", BillingMode: "per_request"}, {Amount: "0", Currency: "CNY", BillingMode: "per_request"}, {Amount: "0.80", Currency: "USD", BillingMode: "per_request"}} {
		if ValidateVideoSalePrice(p) == nil {
			t.Fatalf("expected rejection: %+v", p)
		}
	}
	if err := ValidateVideoSalePrice(Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}); err != nil {
		t.Fatal(err)
	}
}

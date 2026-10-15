package service

import (
	"errors"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

const studioImageHTTPFailureKey = "studio_image_explicit_http_failure"
const studioImageNoCharge502 = "upstream_http_502_no_delivery"

// Customer finality, not a claim about supplier execution or refunds. This is
// recorded only at the native synchronous HTTP response boundary, never from
// a gateway-generated 502, timeout, connection failure or model display name.
type StudioImageHTTPFailure struct {
	Status        int    `json:"status"`
	RequestID     string `json:"request_id,omitempty"`
	Message       string `json:"message,omitempty"`
	ResponseHash  string `json:"response_hash"`
	NoChargeFinal bool   `json:"no_charge_final,omitempty"`
}

func recordStudioImageHTTPFailure(c *gin.Context, a *Account, status int, id string, body []byte) {
	if c == nil || c.Request == nil || !isStudioNativeExecution(c.Request.Context()) {
		return
	}
	proof := &StudioImageHTTPFailure{Status: status, RequestID: id,
		Message: sanitizeUpstreamErrorMessage(extractUpstreamErrorMessage(body)), ResponseHash: HashUsageRequestPayload(body)}
	if a != nil {
		if secret := a.GetCredential("api_key"); secret != "" {
			proof.Message = strings.ReplaceAll(proof.Message, secret, "[redacted]")
		}
	}
	proof.Message = truncateString(proof.Message, 512)
	// Do not discard a response that also contains possible image output. Such
	// contradictory responses retain the existing reconciliation semantics.
	possibleOutput := gjson.GetBytes(body, "data.#").Int() > 0 || gjson.GetBytes(body, "images.#").Int() > 0 || gjson.GetBytes(body, "b64_json").Exists() || gjson.GetBytes(body, "url").Exists()
	proof.NoChargeFinal = a != nil && a.Type == AccountTypeAPIKey && a.Platform == PlatformOpenAI && imagecontract.IsImage2ProBase(a.GetOpenAIBaseURL()) && status == http.StatusBadGateway && !possibleOutput
	c.Set(studioImageHTTPFailureKey, proof)
}

func studioImageFinalFailure(err error) *StudioImageHTTPFailure {
	var upstream *StudioImageUpstreamError
	if errors.As(err, &upstream) && upstream.HTTPFailure != nil && upstream.HTTPFailure.NoChargeFinal && upstream.HTTPFailure.Status == http.StatusBadGateway {
		return upstream.HTTPFailure
	}
	return nil
}

// Only a fixed public code crosses the customer boundary. Supplier text, IDs,
// hashes and routing remain in the private receipt and existing Ops evidence.
func StudioImageFailureCode(r *StudioImageReceipt) string {
	if r == nil {
		return ""
	}
	if r.Status == "failed" && r.BillingState == "not_charged" && r.HTTPFailure != nil && r.HTTPFailure.NoChargeFinal {
		return studioImageNoCharge502
	}
	for _, unit := range r.Units {
		if unit.Status == "failed" && unit.Error == studioImageNoCharge502 && unit.HTTPFailure != nil && unit.HTTPFailure.NoChargeFinal {
			return studioImageNoCharge502
		}
	}
	return ""
}

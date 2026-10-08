package service

import (
	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"net/url"
	"strings"
)

// Saving/rotating this supplier's key must never trigger a metered capability
// probe. Model and balance discovery are separate read-only operations.
func MeteredAccountTestsDisabled(account *Account) bool {
	if account == nil || account.Type != AccountTypeAPIKey {
		return false
	}
	u, err := url.Parse(account.GetOpenAIBaseURL())
	return err == nil && strings.EqualFold(strings.TrimSuffix(u.Hostname(), "."), "api.image2pro.top")
}

func isImage2ProModel(id string) bool {
	_, ok := imagecontract.LookupImage2ProModel(id)
	return ok
}

func IsProtectedStudioImageModel(id string) bool { return isImage2ProModel(id) }

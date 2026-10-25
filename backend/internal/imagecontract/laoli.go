package imagecontract

import (
	"net/url"
	"strings"
)

// IsLaoliMediaBase scopes the 2026-10-24 public media contract to its documented
// HTTPS origin. A familiar model ID alone never selects a supplier contract.
func IsLaoliMediaBase(base string) bool {
	u, err := url.Parse(base)
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "video.laoliimage2.win") &&
		(u.Port() == "" || u.Port() == "443") && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" &&
		u.RawPath == "" && (u.Path == "" || u.Path == "/" || u.Path == "/v1" || u.Path == "/v1/")
}

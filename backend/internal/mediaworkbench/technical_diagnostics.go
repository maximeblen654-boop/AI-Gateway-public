package mediaworkbench

import (
	"sort"
	"strings"
	"time"
)

// TechnicalDiagnostics is a current, read-only check of selected video technical
// fields. It does not revalidate the full draft or authorize publication/offers.
type TechnicalDiagnostics struct {
	CheckedAt        time.Time    `json:"checked_at"`
	Source           string       `json:"source"`
	Diagnostics      []Diagnostic `json:"diagnostics"`
	TargetProductIDs []string     `json:"target_product_ids"`
}

func currentTechnicalDiagnostics(a *Account, now time.Time) *TechnicalDiagnostics {
	if a == nil || a.Config == nil || a.Catalog == nil || a.Catalog.SyncedAt == "" {
		return nil
	}
	binding := bindingsFor(a, a.Config.MediaTypes)["video"]
	targets := map[string]Product{}
	current := []Diagnostic{}
	for _, p := range a.Config.Draft.Products {
		if canUpgradeLegacyLaoliVideoProfile(a, p, binding) {
			targets[p.ProductID] = p
			current = append(current, validateVideoProduct(a, p, binding, false)...)
		}
	}
	if len(targets) == 0 {
		return nil
	}
	projection := &TechnicalDiagnostics{CheckedAt: now, Source: "current_local_video_technical_check", Diagnostics: []Diagnostic{}, TargetProductIDs: []string{}}
	seen := map[[3]string]bool{}
	appendDiagnostic := func(d Diagnostic) {
		key := [3]string{d.Scope, d.Code, d.Path}
		if !seen[key] {
			projection.Diagnostics = append(projection.Diagnostics, d)
			seen[key] = true
		}
	}
	for _, d := range a.Config.Validation.Diagnostics {
		p, targeted := targets[d.Scope]
		// VIDEO_RATIO_INVALID can also come from the generic capability check
		// for blank/duplicate strings. That check is outside this projection.
		genericRatio := d.Code == "VIDEO_RATIO_INVALID" && !validStrings(p.Capabilities.AspectRatios)
		if targeted && strings.HasPrefix(d.Code, "VIDEO_") && !genericRatio {
			continue
		}
		appendDiagnostic(d)
	}
	for _, d := range current {
		appendDiagnostic(d)
	}
	for id := range targets {
		projection.TargetProductIDs = append(projection.TargetProductIDs, id)
	}
	sort.Strings(projection.TargetProductIDs)
	return projection
}

func diagnosticClassPriority(class string) int {
	switch class {
	case "NEEDS_DEVELOPMENT":
		return 3
	case "UNKNOWN":
		return 2
	case "UI_FIXABLE":
		return 1
	}
	return 0
}

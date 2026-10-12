// Package modelmapping contains the canonical Account model-mapping rules.
//
// Keep this package free of service or Studio imports so both the native
// Account service and media workbench validation use the same precedence.
package modelmapping

import (
	"sort"
	"strings"
)

// ResolveRequestedModel applies the Sub2API model-mapping contract: an exact
// key always wins; otherwise the longest matching trailing-* pattern wins,
// with lexical ordering making equal-length matches deterministic.
// When nothing matches, the requested model is returned with matched=false.
func ResolveRequestedModel(mapping map[string]string, requestedModel string) (mappedModel string, matched bool) {
	if requestedModel == "" {
		return "", false
	}
	if mappedModel, exists := mapping[requestedModel]; exists {
		return mappedModel, true
	}

	type patternMatch struct {
		pattern string
		target  string
	}
	matches := make([]patternMatch, 0)
	for pattern, target := range mapping {
		if MatchPattern(pattern, requestedModel) {
			matches = append(matches, patternMatch{pattern: pattern, target: target})
		}
	}
	if len(matches) == 0 {
		return requestedModel, false
	}
	sort.Slice(matches, func(i, j int) bool {
		if len(matches[i].pattern) != len(matches[j].pattern) {
			return len(matches[i].pattern) > len(matches[j].pattern)
		}
		return matches[i].pattern < matches[j].pattern
	})
	return matches[0].target, true
}

// MatchPattern implements the mapping wildcard syntax: only a trailing '*'
// is special; all other patterns are exact strings.
func MatchPattern(pattern, requestedModel string) bool {
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(requestedModel, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == requestedModel
}

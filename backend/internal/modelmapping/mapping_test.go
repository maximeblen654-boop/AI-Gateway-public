package modelmapping

import "testing"

func TestResolveRequestedModelExactMappingPrecedesWildcard(t *testing.T) {
	mapping := map[string]string{
		"gpt-image-2": "exact-target",
		"gpt-image-*": "wildcard-target",
	}
	if got, matched := ResolveRequestedModel(mapping, "gpt-image-2"); got != "exact-target" || !matched {
		t.Fatalf("ResolveRequestedModel() = (%q, %v), want (exact-target, true)", got, matched)
	}
}

func TestResolveRequestedModelMatchesNativeWildcardRules(t *testing.T) {
	tests := []struct {
		name      string
		mapping   map[string]string
		requested string
		want      string
		matched   bool
	}{
		{
			name:      "longest wildcard",
			mapping:   map[string]string{"gpt-*": "generic", "gpt-image-*": "image"},
			requested: "gpt-image-2",
			want:      "image",
			matched:   true,
		},
		{
			name:      "no mapping falls through",
			mapping:   map[string]string{"gpt-*": "generic"},
			requested: "claude-4",
			want:      "claude-4",
			matched:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, matched := ResolveRequestedModel(tt.mapping, tt.requested)
			if got != tt.want || matched != tt.matched {
				t.Fatalf("ResolveRequestedModel() = (%q, %v), want (%q, %v)", got, matched, tt.want, tt.matched)
			}
		})
	}
}

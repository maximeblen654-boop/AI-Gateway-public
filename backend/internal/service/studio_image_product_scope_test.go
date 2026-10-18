package service

import "testing"

func TestStudioImageProductScopeIsolatesIdentity(t *testing.T) {
	base := studioImageProductScope(77, "product", "revision")
	if base != studioImageProductScope(77, "product", "revision") || len(base) != 64 {
		t.Fatal("unstable scope")
	}
	for _, other := range []string{studioImageProductScope(78, "product", "revision"), studioImageProductScope(77, "other", "revision"), studioImageProductScope(77, "product", "next")} {
		if base == other {
			t.Fatal("distinct sale identities combined")
		}
	}
}

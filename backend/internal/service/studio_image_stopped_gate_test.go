package service

import "testing"

// A flag alone cannot activate an incompletely constructed runtime.
func TestStudioImageStoppedCandidateCannotActivate(t *testing.T) {
	t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", "true")
	t.Setenv("STUDIO_IMAGE_BINDING_VERSION", "published_image_binding_v1")
	r := NewStudioImageRuntime(&OpenAIGatewayService{}, nil)
	if r.Enabled() {
		t.Fatal("incomplete paid path activated")
	}
}

func TestStudioImageExplicitServerGate(t *testing.T) {
	fixture, _, _, _, _ := studioContractFixture(t)
	for _, setting := range []string{"", "false", "TRUE", "true"} {
		t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", setting)
		r := NewStudioImageRuntime(fixture.Core, fixture.Media)
		if r.Enabled() != (setting == "true") {
			t.Fatalf("explicit gate %q: got %v", setting, r.Enabled())
		}
	}
}

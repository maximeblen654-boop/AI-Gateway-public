package service

import "testing"

// The complete review candidate still cannot be activated by deployment flags.
// This test performs no I/O or dispatch.
func TestStudioImageStoppedCandidateCannotActivate(t *testing.T) {
	t.Setenv("STUDIO_IMAGE_PUBLISHED_SUBMISSION", "true")
	t.Setenv("STUDIO_IMAGE_BINDING_VERSION", "published_image_binding_v1")
	r := NewStudioImageRuntime(&OpenAIGatewayService{}, nil)
	if r.enabled || r.Enabled() {
		t.Fatal("incomplete paid path activated")
	}
}

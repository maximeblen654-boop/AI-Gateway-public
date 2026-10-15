package service

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestExtractUpstreamErrorMessageShapes(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"error":"synthetic_upstream_outcome_unknown"}`, "synthetic_upstream_outcome_unknown"},
		{`{"error":{"message":"nested"},"message":"top","detail":"detail"}`, "nested"},
		{`{"error":"scalar","detail":"detail","message":"top"}`, "detail"},
		{`{"error":"scalar","message":"top"}`, "top"},
		{`{"error":"scalar","message":" "}`, "scalar"},
		{`{"error":{"code":"only-code"}}`, ""},
		{`{"error":["not-a-message"]}`, ""},
		{`{"error":502}`, ""},
		{`<html>upstream unavailable</html>`, ""},
	} {
		t.Run(tc.body, func(t *testing.T) { require.Equal(t, tc.want, extractUpstreamErrorMessage([]byte(tc.body))) })
	}
}

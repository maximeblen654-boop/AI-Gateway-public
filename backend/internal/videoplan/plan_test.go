package videoplan

import (
	"bytes"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestPlanExactBytesSurviveJournalAndCatalogChange(t *testing.T) {
	m, ok := Lookup("3.0")
	require.True(t, ok)
	p, e := Preview("3.0", m.Upstream, "720p", "16:9", 5)
	require.NoError(t, e)
	body := bytes.Replace(p.Body, []byte(`\u003cdry-run-prompt\u003e`), []byte("<a>&中文\\u2028"), 1)
	// Include whitespace, HTML and unicode escapes: re-encoding JSON is forbidden.
	body = append([]byte(" "), body...)
	p, e = CompilePlan("3.0", m.Upstream, body)
	require.NoError(t, e)
	wire, e := json.Marshal(p)
	require.NoError(t, e)
	var saved Plan
	require.NoError(t, json.Unmarshal(wire, &saved))
	old := registry.Models
	registry.Models = nil
	defer func() { registry.Models = old }()
	got, h, e := saved.Materialize()
	require.NoError(t, e)
	require.Equal(t, body, got)
	require.Equal(t, p.RequestHash, h)
	saved.Body[0] = 'X'
	_, _, e = saved.Materialize()
	require.Error(t, e)
}

func TestPlanRejectsUnsupportedAndMediaLimits(t *testing.T) {
	m, _ := Lookup("3.0")
	p, e := Preview("3.0", m.Upstream, "720p", "16:9", 5)
	require.NoError(t, e)
	var f map[string]any
	require.NoError(t, json.Unmarshal(p.Body, &f))
	f["face_direct"] = "false"
	b, _ := json.Marshal(f)
	_, e = CompilePlan("3.0", m.Upstream, b)
	require.Error(t, e)
	delete(f, "face_direct")
	f["unexpected_field"] = true
	b, _ = json.Marshal(f)
	_, e = CompilePlan("3.0", m.Upstream, b)
	require.Error(t, e)
	_, e = PreviewWithMedia("3.0", m.Upstream, "720p", "16:9", 5, 17, 0, 0)
	require.Error(t, e)
	for _, m := range registry.Models {
		if m.Status == "enabled" && len(m.Required) > 0 {
			_, e = Preview(m.ID, m.Upstream, m.Resolutions[0], m.Ratios[0], m.Durations[0])
			require.Error(t, e, m.ID)
		}
	}
}

func TestDefaultContractExcludesLocalFixtureAndPaused(t *testing.T) {
	for _, id := range []string{"phase5-local-reference-test", "3.0-native", "minimax-h3-1080p"} {
		_, ok := Lookup(id)
		require.False(t, ok, id)
	}
}

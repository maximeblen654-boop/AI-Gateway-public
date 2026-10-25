package videoplan

import (
	"bytes"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"testing"
)

func genericTestModel() Model {
	m := Model{ID: "generic-video", Upstream: "generic-upstream", Status: "enabled", Mode: "images", Durations: []int{5}, Resolutions: []string{"720p"}, Ratios: []string{"16:9"}}
	m.Limits.Image = 9
	m.Limits.Total = 9
	return m
}

func TestPlanExactBytesSurviveJournalAndProfileChanges(t *testing.T) {
	m := genericTestModel()
	p, e := PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
	require.NoError(t, e)
	body := bytes.Replace(p.Body, []byte(`\u003cdry-run-prompt\u003e`), []byte("<a>&中文"), 1)
	body = append([]byte(" "), body...)
	p, e = CompilePlanForModel(m, m.Upstream, body)
	require.NoError(t, e)
	wire, e := json.Marshal(p)
	require.NoError(t, e)
	var saved Plan
	require.NoError(t, json.Unmarshal(wire, &saved))
	m.Upstream = "changed"
	m.Status = "disabled"
	got, h, e := saved.Materialize()
	require.NoError(t, e)
	require.Equal(t, body, got)
	require.Equal(t, p.RequestHash, h)
	saved.Body[0] = 'X'
	_, _, e = saved.Materialize()
	require.Error(t, e)
}

func TestPlanRejectsUnsupportedAndMediaLimits(t *testing.T) {
	m := genericTestModel()
	p, e := PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
	require.NoError(t, e)
	var f map[string]any
	require.NoError(t, json.Unmarshal(p.Body, &f))
	f["face_direct"] = "false"
	b, _ := json.Marshal(f)
	_, e = CompilePlanForModel(m, m.Upstream, b)
	require.Error(t, e)
	f["face_direct"] = false
	f["unexpected_field"] = true
	b, _ = json.Marshal(f)
	_, e = CompilePlanForModel(m, m.Upstream, b)
	require.Error(t, e)
	_, e = PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 17, 0, 0)
	require.Error(t, e)
	m.Required = []string{"image"}
	_, e = PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
	require.Error(t, e)
}

func TestWireProfilesDoNotDeclareSupplierModels(t *testing.T) {
	var v map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(contract, &v))
	require.NotContains(t, v, "models")
	require.Equal(t, "media-video-wire-profiles-r1", registry.Revision)
}

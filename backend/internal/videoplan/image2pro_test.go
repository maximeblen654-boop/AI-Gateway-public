package videoplan

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func image2ProDocumentFixture(t *testing.T) (Model, []byte) {
	t.Helper()
	raw, e := os.ReadFile("testdata/image2pro_public_video.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Model    string
		Metadata json.RawMessage
		Request  json.RawMessage
	}
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	c, e := DecodeImage2ProCapabilities(f.Metadata)
	if e != nil {
		t.Fatal(e)
	}
	m := Model{ID: f.Model, Upstream: f.Model, Status: "enabled", Mode: "image2pro", Durations: []int{4, 5, 6, 7, 8, 9, 10, 11, 12}, Resolutions: []string{"1080P"}, Ratios: []string{"16:9", "9:16"}, PromptMax: 6000, Image2Pro: c}
	m.Limits.Image = 8
	m.Limits.Audio = 3
	m.Limits.Video = 1
	m.Limits.Total = 12
	return m, f.Request
}

func TestImage2ProDocumentedVideoCompileFreeze(t *testing.T) {
	m, body := image2ProDocumentFixture(t)
	p, e := CompilePlanForModel(m, m.Upstream, body)
	if e != nil {
		t.Fatal(e)
	}
	if p.AdapterRevision != Image2ProRevision || p.ContractRevision != Image2ProContractRevision || p.Path != "/v1/videos" {
		t.Fatalf("wrong frozen plan %+v", p)
	}
	r, ratio, d, im, vi, au, e := InspectForModel(m, body)
	if e != nil || r != "1080P" || ratio != "16:9" || d != 5 || im != 1 || vi != 1 || au != 1 {
		t.Fatalf("bad inspection %s %s %d %d %d %d %v", r, ratio, d, im, vi, au, e)
	}
	got, _, e := p.Materialize()
	if e != nil || string(got) != string(body) {
		t.Fatalf("frozen bytes changed %v", e)
	}
	// Original bytes remain recoverable after today's model metadata disappears.
	m.Image2Pro = nil
	if _, _, e = p.Materialize(); e != nil {
		t.Fatal(e)
	}
	p.Body = append(p.Body, ' ')
	if _, _, e = p.Materialize(); e == nil {
		t.Fatal("tampered frozen bytes accepted")
	}
}

func TestImage2ProRejectsUnsupportedVideoWireFields(t *testing.T) {
	for _, key := range []string{"resolution", "size", "n", "mode", "first_frame", "last_frame", "seed", "crop", "seconds", "aspect_ratio", "references", "input_image", "audio_url", "client_request_id"} {
		t.Run(key, func(t *testing.T) {
			m, body := image2ProDocumentFixture(t)
			var f map[string]json.RawMessage
			_ = json.Unmarshal(body, &f)
			f[key] = json.RawMessage(`"unsupported"`)
			raw, _ := json.Marshal(f)
			if _, e := CompilePlanForModel(m, m.Upstream, raw); e == nil {
				t.Fatalf("unsupported %s accepted", key)
			}
		})
	}
	m, body := image2ProDocumentFixture(t)
	for _, raw := range []string{
		strings.Replace(string(body), `"duration":5`, `"duration":5,"duration":6`, 1),
		strings.Replace(string(body), `{"mediaId":"audio-fixture-id"}`, `{"url":"https://example.com/audio.mp3"}`, 1),
		strings.Replace(string(body), `{"mediaId":"audio-fixture-id"}`, `{"mediaId":"audio-fixture-id","mediaId":"shadowed-id"}`, 1),
		strings.Replace(string(body), `{"mediaId":"video-fixture-id"}`, `{"mediaId":"video-fixture-id","require_audio":false}`, 1),
		strings.Replace(string(body), `data:image/png;base64,iVBORw0KGgo=`, `https://example.com/image.png`, 1),
		strings.Replace(string(body), `"duration":5`, `"duration":"5"`, 1),
		strings.Replace(string(body), `"ratio":"16:9"`, `"ratio":"1:1"`, 1),
	} {
		if _, e := CompilePlanForModel(m, m.Upstream, []byte(raw)); e == nil {
			t.Fatal("invalid documented-shape request accepted", raw)
		}
	}
}

func TestImage2ProMissingLimitsAndOpaqueProtocolFailClosed(t *testing.T) {
	m, body := image2ProDocumentFixture(t)
	for _, mutate := range []func(*Model){
		func(m *Model) { m.Image2Pro = nil }, func(m *Model) { m.Image2Pro.MaxImages = 0 }, func(m *Model) { m.Image2Pro.MaxAudioReferences = 0 }, func(m *Model) { m.Image2Pro.MaxVideoReferences = 0 }, func(m *Model) { m.Image2Pro.DurationMin = 6 }, func(m *Model) { m.Image2Pro.Size = "1K" }, func(m *Model) { m.Image2Pro.Protocol = "" }, func(m *Model) { m.Image2Pro.Modes = []string{"text", "keyframe"} },
	} {
		candidate, _ := image2ProDocumentFixture(t)
		mutate(&candidate)
		if _, e := CompilePlanForModel(candidate, candidate.Upstream, body); e == nil {
			t.Fatal("unavailable/changed capability accepted")
		}
	}
	m.Image2Pro.Protocol = "another-completely-opaque-tag"
	if _, e := CompilePlanForModel(m, m.Upstream, body); e != nil {
		t.Fatal("protocol identity was incorrectly treated as an enum", e)
	}
	if _, e := PreviewWithModel(m, m.Upstream, "1K", "16:9", 5, 0, 0, 0); e == nil {
		t.Fatal("1K was guessed equivalent to 1080P")
	}
	if _, e := PreviewWithModel(m, m.Upstream, "1080p", "16:9", 5, 0, 0, 0); e != nil {
		t.Fatal(e)
	}
	if _, e := DecodeImage2ProCapabilities([]byte(`{"protocol":"opaque","modes":["text"],"max_images":0,"duration_min":4,"duration_max":12,"aspect_ratios":["16:9"]}`)); e == nil {
		t.Fatal("missing fixed size accepted")
	}
}

func seedance2DocumentFixture(t *testing.T) (Model, json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile("testdata/image2pro_seedance2_video.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Model    string
		Metadata json.RawMessage
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	caps, err := DecodeImage2ProCapabilities(fixture.Metadata)
	if err != nil {
		t.Fatal(err)
	}
	m := Model{ID: fixture.Model, Upstream: fixture.Model, Status: "enabled", Mode: "image2pro", Image2Pro: caps, Resolutions: []string{"supplier-default"}, Ratios: []string{"16:9", "9:16"}, PromptMax: 6000}
	for d := 4; d <= 15; d++ {
		m.Durations = append(m.Durations, d)
	}
	m.Limits.Image, m.Limits.Audio, m.Limits.Total = 9, 3, 12
	return m, fixture.Metadata
}

func TestSeedance2DocumentedDefaultsAndExactResolutionLabel(t *testing.T) {
	m, _ := seedance2DocumentFixture(t)
	c := m.Image2Pro
	if c.Size != "" || c.DurationMin != 4 || c.DurationMax != 15 || c.MaxImages != 9 || c.MaxAudioReferences != 3 || c.ReferenceAudioMaxBytes != 15728640 || c.MaxVideoReferences != 0 {
		t.Fatalf("incorrect protocol capabilities: %+v", c)
	}
	for _, duration := range []int{4, 15} {
		plan, err := PreviewWithModel(m, m.Upstream, "supplier-default", "16:9", duration, 1, 0, 1)
		if err != nil {
			t.Fatal(err)
		}
		body, _, err := plan.Materialize()
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(body, &fields); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"size", "resolution", "mode", "n"} {
			if _, exists := fields[key]; exists {
				t.Fatalf("undocumented wire field %s", key)
			}
		}
		resolution, ratio, seconds, images, videos, audio, err := InspectForModel(m, body)
		if err != nil || resolution != "supplier-default" || ratio != "16:9" || seconds != duration || images != 1 || videos != 0 || audio != 1 {
			t.Fatalf("inspection drift: %s %s %d %d %d %d %v", resolution, ratio, seconds, images, videos, audio, err)
		}
	}
	for _, label := range []string{"480P", "Supplier-default", ""} {
		if _, err := PreviewWithModel(m, m.Upstream, label, "16:9", 5, 0, 0, 0); err == nil {
			t.Fatalf("different label accepted: %q", label)
		}
	}
	for _, labels := range [][]string{nil, {"supplier-default", "480P"}, {" supplier-default"}} {
		m.Resolutions = labels
		if _, err := PreviewWithModel(m, m.Upstream, "supplier-default", "16:9", 5, 0, 0, 0); err == nil {
			t.Fatal("ambiguous/missing label accepted")
		}
		if _, _, _, _, _, _, err := InspectForModel(m, []byte(`{"model":"Seedance2.0","prompt":"test","duration":5,"ratio":"16:9"}`)); err == nil {
			t.Fatal("ambiguous inspection accepted")
		}
	}
}

func TestSeedance2ExplicitInvalidCapabilitiesNeverAcquireDefaults(t *testing.T) {
	_, raw := seedance2DocumentFixture(t)
	for _, scenario := range []struct {
		key   string
		value any
	}{
		{"protocol", "unrecognized-incomplete-protocol"}, {"modes", nil}, {"modes", []string{}}, {"modes", []string{"keyframe"}},
		{"max_images", -1}, {"max_images", 10}, {"duration_min", 0}, {"duration_max", 30}, {"duration_min", "4"},
		{"aspect_ratios", []string{"1:1"}}, {"aspect_ratios", nil}, {"size", "480P"}, {"size", nil},
		{"max_audio_references", 4}, {"max_audio_references", nil}, {"supports_audio_reference", false}, {"reference_audio_max_bytes", 0},
		{"max_video_references", 1}, {"reference_video_max_bytes", 1},
	} {
		t.Run(scenario.key+"/"+stringMustJSON(scenario.value), func(t *testing.T) {
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			fields[scenario.key] = scenario.value
			candidate, _ := json.Marshal(fields)
			if _, err := DecodeImage2ProCapabilities(candidate); err == nil {
				t.Fatalf("invalid %s accepted", scenario.key)
			}
		})
	}
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	delete(fields, "max_audio_references")
	candidate, _ := json.Marshal(fields)
	if _, err := DecodeImage2ProCapabilities(candidate); err == nil {
		t.Fatal("audio limits guessed")
	}
}

func stringMustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestSeedance2RequestLimitsAndFrozenPlan(t *testing.T) {
	m, _ := seedance2DocumentFixture(t)
	for _, spec := range []struct {
		duration, images, videos, audio int
		ratio                           string
	}{
		{3, 0, 0, 0, "16:9"}, {16, 0, 0, 0, "16:9"}, {5, 10, 0, 0, "16:9"}, {5, 0, 1, 0, "16:9"}, {5, 0, 0, 4, "16:9"}, {5, 0, 0, 0, "1:1"},
	} {
		if _, err := PreviewWithModel(m, m.Upstream, "supplier-default", spec.ratio, spec.duration, spec.images, spec.videos, spec.audio); err == nil {
			t.Fatalf("unsupported request accepted: %+v", spec)
		}
	}
	plan, err := PreviewWithModel(m, m.Upstream, "supplier-default", "9:16", 15, 9, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	m.Image2Pro = nil
	if _, _, err = plan.Materialize(); err != nil {
		t.Fatal("frozen plan depends on current metadata", err)
	}
}

func TestSeedance2AbsentAudioCapabilityDoesNotAuthorizeAudio(t *testing.T) {
	caps, err := DecodeImage2ProCapabilities([]byte(`{"type":"video","protocol":"seedance2-video"}`))
	if err != nil {
		t.Fatal(err)
	}
	if caps.SupportsAudioReference || caps.MaxAudioReferences != 0 || caps.ReferenceAudioMaxBytes != 0 {
		t.Fatal("absent audio capability invented support")
	}
	m, _ := seedance2DocumentFixture(t)
	m.Image2Pro = caps
	if _, err := PreviewWithModel(m, m.Upstream, "supplier-default", "16:9", 5, 1, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := PreviewWithModel(m, m.Upstream, "supplier-default", "16:9", 5, 1, 0, 1); err == nil {
		t.Fatal("undeclared audio accepted")
	}
	for _, body := range []string{
		`{"protocol":"seedance2-video","supports_audio_reference":null}`,
		`{"protocol":"seedance2-video","supports_audio_reference":true}`,
		`{"protocol":"seedance2-video","supports_audio_reference":true,"max_audio_references":3}`,
		`{"protocol":"seedance2-video","supports_audio_reference":true,"reference_audio_max_bytes":15728640}`,
		`{"protocol":"seedance2-video","max_audio_references":3}`,
	} {
		if _, err := DecodeImage2ProCapabilities([]byte(body)); err == nil {
			t.Fatal("incomplete/invalid explicit audio support accepted", body)
		}
	}
}

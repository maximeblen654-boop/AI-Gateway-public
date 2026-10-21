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

package videoplan

import (
	"encoding/json"
	"testing"
)

func TestLaoli20261024ExactModelsAndFrozenPlans(t *testing.T) {
	for _, id := range []string{"3.0", "3.5", "minimax-h3-1080p", "sd-native-full-2.0", "sd-native-full-2.5", "wan-3.0-video-ref", "wan-3.0-no-video-ref"} {
		m, ok := LaoliMediaModel(id, []string{"16:9"})
		if !ok {
			t.Fatalf("missing exact model %s", id)
		}
		p, err := PreviewWithModel(m, id, m.Resolutions[0], m.Ratios[0], m.Durations[0], 1, 0, 0)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if p.AdapterRevision != LaoliMediaRevision || p.ContractRevision != LaoliMediaContractRevision {
			t.Fatalf("revision: %+v", p)
		}
		var f map[string]any
		if json.Unmarshal(p.Body, &f) != nil || f["model"] != id || f["seconds"] == nil || f["duration"] != nil || f["reference_images"] == nil {
			t.Fatalf("wrong generic fields: %s", p.Body)
		}
		b, _, err := p.Materialize()
		if err != nil || string(b) != string(p.Body) {
			t.Fatalf("frozen: %v", err)
		}
	}

}

func TestLaoli20261024StrictWireValidation(t *testing.T) {
	m, _ := LaoliMediaModel("3.0", nil)
	for _, body := range []string{
		`{"model":"3.0","prompt":"x","seconds":4,"resolution":"720p","aspect_ratio":"16:9"}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"1080p","aspect_ratio":"16:9"}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"720p","aspect_ratio":"16:9","reference_videos":["https://a.example/v"]}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"720p","aspect_ratio":"16:9","reference_images":[""]}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"720p","aspect_ratio":"16:9","reference_images":["http://a.example/x"]}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"720p","aspect_ratio":"16:9","duration":5}`,
		`{"model":"3.0","prompt":"x","seconds":5,"seconds":6,"resolution":"720p","aspect_ratio":"16:9"}`,
		`{"model":"3.0","prompt":"x","seconds":5,"resolution":"720p","aspect_ratio":"16:9","reference_images":null}`,
	} {
		if _, err := CompilePlanForModel(m, m.Upstream, []byte(body)); err == nil {
			t.Fatalf("accepted invalid %s", body)
		}
	}
	if _, ok := LaoliMediaModel("sd-native-full-2.0", nil); ok {
		t.Fatal("invented undocumented aspect ratios")
	}
	if _, ok := LaoliMediaModel("3.0-unknown", []string{"16:9"}); ok {
		t.Fatal("accepted unknown exact ID")
	}
	multi, _ := LaoliMediaModel("sd-native-full-2.5", []string{"16:9"})
	if multi.Limits.Total != 30 {
		t.Fatalf("platform total expanded: %d", multi.Limits.Total)
	}
	if _, err := PreviewWithModel(multi, multi.Upstream, "720p", "16:9", 4, 30, 1, 0); err == nil {
		t.Fatal("accepted more than platform thirty")
	}
	p, err := PreviewWithModel(m, m.Upstream, "720p", "16:9", 5, 0, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	p.ContractRevision = "other"
	if _, _, err = p.Materialize(); err == nil {
		t.Fatal("accepted wrong frozen revision")
	}
}

func TestLaoli20261024TypedInlineReferences(t *testing.T) {
	m, _ := LaoliMediaModel("sd-native-full-2.0", []string{"16:9"})
	body := []byte(`{"model":"sd-native-full-2.0","prompt":"x","seconds":4,"resolution":"720p","aspect_ratio":"16:9","reference_images":["data:image/png;base64,AQID"],"reference_videos":["data:video/mp4;base64,BAUG"],"reference_audios":["https://assets.example/a.mp3"]}`)
	if _, err := CompilePlanForModel(m, m.Upstream, body); err != nil {
		t.Fatal(err)
	}
	r, ratio, d, i, v, a, err := InspectForModel(m, body)
	if err != nil || r != "720p" || ratio != "16:9" || d != 4 || i != 1 || v != 1 || a != 1 {
		t.Fatalf("incorrect inline inspection: %s %s %d %d %d %d %v", r, ratio, d, i, v, a, err)
	}
	b, mime, err := DecodeLaoliInlineReference("data:image/png;base64,AQID", "image")
	if err != nil || mime != "image/png" || len(b) != 3 || b[0] != 1 {
		t.Fatalf("decode: %x %s %v", b, mime, err)
	}
	for _, value := range []string{"data:video/mp4;base64,AQID", "data:image/png;base64,", "data:image/png;base64,%%%%", "data:image/png;base64,AQID\n", "data:application/octet-stream;base64,AQID"} {
		if _, _, err := DecodeLaoliInlineReference(value, "image"); err == nil {
			t.Fatalf("accepted bad typed reference %q", value)
		}
	}
}

package imageplan

import (
	"encoding/json"
	"testing"
)

func TestCompileUsesDispatchParameterLogic(t *testing.T) {
	body := []byte(`{"model":"gpt-image-site","prompt":"<dry-run-prompt>","n":2,"size":"1536x864","quality":"high","images":[{"image_url":"<image:1>"}]}`)
	p, err := CompileJSON(body, "gpt-image-2", Edits)
	if err != nil {
		t.Fatal(err)
	}
	f := JSONFields{Endpoint: Edits, N: 1}
	if err = ParseJSON(body, &f); err != nil {
		t.Fatal(err)
	}
	forwarded, err := RewriteJSON(body, "gpt-image-2")
	if err != nil {
		t.Fatal(err)
	}
	if string(p.MaterializeJSON()) != string(forwarded) {
		t.Fatal("materialization changed exact dispatch bytes")
	}
	preview, _ := json.Marshal(p.Fields)
	var want map[string]any
	if err = json.Unmarshal(forwarded, &want); err != nil {
		t.Fatal(err)
	}
	canonical, _ := json.Marshal(want)
	if string(preview) != string(canonical) || f.N != 2 || f.Size != "1536x864" || len(f.InputImageURLs) != 1 || p.AssetSlots[0].Count != 1 {
		t.Fatal("dispatch and plan diverged")
	}
	if _, err = CompileJSON([]byte(`{"images":[{"file_id":"unsupported"}]}`), "gpt-image-2", Edits); err == nil {
		t.Fatal("unsupported parser branch was skipped")
	}
	if _, err = CompileJSON([]byte(`{"n":0}`), "gpt-image-2", Generations); err == nil {
		t.Fatal("invalid n accepted")
	}
}

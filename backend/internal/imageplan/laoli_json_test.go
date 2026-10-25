package imageplan

import (
	"testing"

	"github.com/tidwall/gjson"
)

func TestLaoliSyncJSONDocumentedContract(t *testing.T) {
	for _, format := range []string{"url", "b64_json"} {
		body := []byte(`{"model":"gpt-image-2.5-sr-flare","prompt":"synthetic","n":1,"resolution":"2K","response_format":"` + format + `","images":["https://example.com/reference.png","data:image/png;base64,AQ=="]}`)
		plan, err := CompileLaoliJSON(body, "gpt-image-2.5-sr-flare", Edits)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Protocol != LaoliSyncProtocol || plan.Path != Edits || gjson.GetBytes(plan.MaterializeJSON(), "images.0").Type != gjson.String || len(plan.AssetSlots) != 1 || plan.AssetSlots[0].Representation != "string" {
			t.Fatalf("lost documented string-reference protocol: %+v", plan)
		}
		var parsed JSONFields
		parsed.Endpoint = Edits
		if err = ParseLaoliJSON(plan.MaterializeJSON(), &parsed); err != nil || len(parsed.InputImageURLs) != 2 || parsed.ResponseFormat != format {
			t.Fatalf("invalid dispatch parse: %+v, %v", parsed, err)
		}
	}
}

func TestLaoliSyncJSONRejectsUnconfirmedShape(t *testing.T) {
	for _, fragment := range []string{`"images":[{"image_url":"https://example.com/reference.png"}]`, `"images":["http://example.com/reference.png"]`, `"images":["https://user:secret@example.com/reference.png"]`, `"images":["data:image/png;base64,broken"]`, `"stream":true`, `"quality":"high"`, `"output_format":"webp"`, `"n":2`, `"n":1,"n":1`, `"response_format":"other"`} {
		body := []byte(`{"model":"gpt-image-2.5-sr-flare","prompt":"synthetic",` + fragment + `}`)
		if _, err := CompileLaoliJSON(body, "gpt-image-2.5-sr-flare", Generations); err == nil {
			t.Fatal("unconfirmed field/shape accepted", string(body))
		}
	}
	for _, model := range []string{"midjourney", "gpt-image-unconfirmed", "KS-Qwen-2.1new"} {
		if _, err := CompileLaoliJSON([]byte(`{"model":"`+model+`","prompt":"synthetic"}`), model, Generations); err == nil {
			t.Fatal("unconfirmed model/batch accepted", model)
		}
	}
	if _, err := CompileLaoliJSON([]byte(`{"model":"nano-banana-2","prompt":"synthetic"}`), "nano-banana-2", Edits); err == nil {
		t.Fatal("edits without references accepted")
	}
}

package imageplan

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestImage2ProSyncJSONDocumentedCountsAndFields(t *testing.T) {
	for _, n := range []int{1, 4} {
		body := []byte(fmt.Sprintf(`{"model":"public-image-20261019","prompt":"synthetic","n":%d,"resolution":"2K","aspect_ratio":"3:2"}`, n))
		plan, err := CompileImage2ProJSON(body, "public-image-20261019", Generations)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Protocol != Image2ProSyncProtocol || gjson.GetBytes(plan.MaterializeJSON(), "model").String() != "public-image-20261019" || gjson.GetBytes(plan.MaterializeJSON(), "n").Int() != int64(n) {
			t.Fatalf("wrong frozen synchronous plan: %+v", plan)
		}
		again, err := CompileImage2ProJSON(plan.MaterializeJSON(), "public-image-20261019", Generations)
		if err != nil || string(again.MaterializeJSON()) != string(plan.MaterializeJSON()) {
			t.Fatal("recompilation changed frozen bytes", err)
		}
	}
	for _, field := range []string{`"n":0`, `"n":5`, `"n":1.5`, `"n":"1"`, `"n":true`, `"n":null`, `"quality":"high"`, `"output_format":"webp"`, `"background":"transparent"`, `"user":"customer"`, `"stream":false`, `"response_format":"b64_json"`, `"unsupported":1`, `"n":1,"n":4`} {
		t.Run(field, func(t *testing.T) {
			body := []byte(`{"model":"public-image-20261019","prompt":"synthetic",` + field + `}`)
			if _, err := CompileImage2ProJSON(body, "public-image-20261019", Generations); err == nil {
				t.Fatal("undocumented or invalid synchronous field accepted")
			}
		})
	}
	for _, endpoint := range []string{"/v1/images/tasks", "/v1/images/generations/async"} {
		if _, err := CompileImage2ProJSON([]byte(`{"model":"public-image-20261019","prompt":"synthetic"}`), "public-image-20261019", endpoint); err == nil {
			t.Fatal("asynchronous endpoint accepted by synchronous compiler")
		}
	}
}

func TestImage2ProSyncJSONReferenceStringsAndLimit(t *testing.T) {
	for _, field := range []string{"input_image", "reference_image", "image", "images"} {
		for _, value := range []string{`"https://example.com/reference.png"`, `["https://example.com/reference.png","data:image/png;base64,AQ=="]`} {
			t.Run(field+value, func(t *testing.T) {
				body := []byte(`{"model":"public-image-20261019","prompt":"synthetic","` + field + `":` + value + `}`)
				plan, err := CompileImage2ProJSON(body, "public-image-20261019", Edits)
				if err != nil {
					t.Fatal(err)
				}
				parsed := JSONFields{Endpoint: Edits, Image2ProReferences: true}
				if err = ParseJSON(plan.MaterializeJSON(), &parsed); err != nil || len(parsed.InputImageURLs) < 1 || plan.AssetSlots[0].Representation != "string" {
					t.Fatal(parsed, plan.AssetSlots, err)
				}
			})
		}
	}
	for _, value := range []string{`[{"image_url":"https://example.com/reference.png"}]`, `[{"file_id":"file-1"}]`, `[null]`, `[4]`, `"http://example.com/reference.png"`, `"C:/reference.png"`, `"https://user:password@example.com/reference.png"`, `"data:image/png;base64,broken"`, `""`, `[]`} {
		if _, err := CompileImage2ProJSON([]byte(`{"model":"public-image-20261019","prompt":"synthetic","images":`+value+`}`), "public-image-20261019", Edits); err == nil {
			t.Fatalf("invalid reference accepted: %s", value)
		}
	}
	for _, count := range []int{16, 17} {
		images := make([]string, count)
		for i := range images {
			images[i] = fmt.Sprintf("https://example.com/%d.png", i)
		}
		body, _ := json.Marshal(map[string]any{"model": "public-image-20261019", "prompt": "synthetic", "images": images})
		_, err := CompileImage2ProJSON(body, "public-image-20261019", Edits)
		if (err == nil) != (count == 16) {
			t.Fatalf("incorrect reference limit for %d: %v", count, err)
		}
	}
	combined := `{"model":"public-image-20261019","prompt":"synthetic","input_image":[` + strings.Repeat(`"https://example.com/reference.png",`, 15) + `"https://example.com/last.png"],"image":"https://example.com/extra.png"}`
	if _, err := CompileImage2ProJSON([]byte(combined), "public-image-20261019", Edits); err == nil {
		t.Fatal("reference limit was applied per alias instead of per request")
	}
}

func TestImage2ProSyncJSONKeepsOrdinaryAndLegacyParsersSeparate(t *testing.T) {
	stringsBody := []byte(`{"model":"gpt-image-2","prompt":"synthetic","images":["https://example.com/reference.png"]}`)
	if _, err := CompileJSON(stringsBody, "gpt-image-2", Edits); err == nil {
		t.Fatal("ordinary JSON compiler acquired Image2Pro string-reference semantics")
	}
	objectsBody := []byte(`{"model":"gpt-image-2","prompt":"synthetic","quality":"high","output_format":"webp","images":[{"image_url":"https://example.com/reference.png"}]}`)
	ordinary, err := CompileJSON(objectsBody, "gpt-image-2", Edits)
	if err != nil || ordinary.Protocol != "" {
		t.Fatal("ordinary provider contract changed", err)
	}
	legacy := JSONFields{Endpoint: Edits, N: 1, LegacyStringReferences: true}
	if err = ParseJSON([]byte(`{"model":"canvas-image-01","images":["data:image/png;base64,AQ=="]}`), &legacy); err != nil || len(legacy.InputImageURLs) != 1 {
		t.Fatal("historical receipt parser changed", err)
	}
}

func TestImage2ProSyncReferenceBudgetIsCheckedBeforeDecode(t *testing.T) {
	reference := "data:image/png;base64," + strings.Repeat("A", image2ProSyncMaxBodyBytes)
	if validImage2ProReference(reference) {
		t.Fatal("an oversized reference reached Base64 decoding")
	}
	body := []byte(`{"model":"public-image-20261019","prompt":"synthetic","images":["` + reference + `"]}`)
	if _, err := CompileImage2ProJSON(body, "public-image-20261019", Edits); err == nil {
		t.Fatal("oversized synchronous body accepted")
	}
	fields := JSONFields{Endpoint: Edits, Image2ProReferences: true}
	if err := ParseJSON(body, &fields); err == nil {
		t.Fatal("direct internal parsing bypassed the reference budget")
	}
}

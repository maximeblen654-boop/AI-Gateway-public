package imageplan

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/tidwall/gjson"
)

// This private plan marker can be acquired only by the server-side compiler.
// It never changes parsing of ordinary OpenAI or Image2Pro client requests.
const LaoliSyncProtocol = "laoli_sync_json_v1"

const laoliSyncMaxBodyBytes = 24 << 20 // Local bounded request limit, not a supplier capability.

func CompileLaoliJSON(body []byte, upstream, endpoint string) (Plan, error) {
	p := Plan{Protocol: LaoliSyncProtocol, Method: "POST", Path: endpoint, Encoding: "application/json", Omitted: []string{}, AssetSlots: []AssetSlot{}}
	if !imagecontract.IsLaoliSyncImageModel(upstream) {
		return p, fmt.Errorf("laoli synchronous model/count contract is not confirmed")
	}
	forwarded, err := RewriteJSON(body, upstream)
	if err != nil {
		return p, err
	}
	// Validate the original too: model rewriting must not hide duplicate keys.
	fields := JSONFields{Endpoint: endpoint}
	if err = ParseLaoliJSON(body, &fields); err != nil {
		return p, err
	}
	if err = ParseLaoliJSON(forwarded, &JSONFields{Endpoint: endpoint}); err != nil {
		return p, err
	}
	if err = json.Unmarshal(forwarded, &p.Fields); err != nil {
		return p, err
	}
	p.body = forwarded
	if len(fields.InputImageURLs) > 0 {
		p.AssetSlots = append(p.AssetSlots, AssetSlot{Kind: "image", Count: len(fields.InputImageURLs), Representation: "string"})
	}
	return p, nil
}

func ParseLaoliJSON(body []byte, req *JSONFields) error {
	if len(body) > laoliSyncMaxBodyBytes || !gjson.ValidBytes(body) || req == nil || (req.Endpoint != Generations && req.Endpoint != Edits) {
		return fmt.Errorf("invalid Laoli synchronous JSON request")
	}
	root := gjson.ParseBytes(body)
	if !root.IsObject() {
		return fmt.Errorf("invalid Laoli synchronous object")
	}
	seen := map[string]bool{}
	var fieldErr error
	root.ForEach(func(key, _ gjson.Result) bool {
		name := key.String()
		if seen[name] {
			fieldErr = fmt.Errorf("duplicate Laoli field %s", name)
			return false
		}
		seen[name] = true
		switch name {
		case "model", "prompt", "n", "size", "resolution", "response_format", "stream", "image", "images", "input_image", "reference_image", "mask":
			return true
		default:
			fieldErr = fmt.Errorf("unconfirmed Laoli synchronous field %s", name)
			return false
		}
	})
	if fieldErr != nil {
		return fieldErr
	}
	for _, name := range []string{"model", "prompt"} {
		v := root.Get(name)
		if v.Type != gjson.String || strings.TrimSpace(v.String()) == "" {
			return fmt.Errorf("Laoli %s is required", name)
		}
	}
	req.Model = root.Get("model").String()
	if !imagecontract.IsLaoliSyncImageModel(req.Model) {
		return fmt.Errorf("laoli synchronous model/count contract is not confirmed")
	}
	req.ExplicitModel, req.Prompt, req.N = true, strings.TrimSpace(root.Get("prompt").String()), 1
	if n := root.Get("n"); n.Exists() && (n.Type != gjson.Number || n.Raw != "1") {
		return fmt.Errorf("laoli synchronous execution uses one image per request")
	}
	if stream := root.Get("stream"); stream.Exists() && stream.Type != gjson.False {
		return fmt.Errorf("Laoli does not support streaming")
	}
	for _, name := range []string{"size", "resolution", "response_format"} {
		if v := root.Get(name); v.Exists() && (v.Type != gjson.String || strings.TrimSpace(v.String()) == "") {
			return fmt.Errorf("invalid Laoli %s", name)
		}
	}
	req.Size = root.Get("size").String()
	req.ExplicitSize = req.Size != ""
	req.ResponseFormat = root.Get("response_format").String()
	if req.ResponseFormat != "" && req.ResponseFormat != "url" && req.ResponseFormat != "b64_json" {
		return fmt.Errorf("Laoli response_format must be url or b64_json")
	}
	for _, name := range []string{"image", "images", "input_image", "reference_image"} {
		v := root.Get(name)
		if !v.Exists() {
			continue
		}
		values := []gjson.Result{v}
		if v.IsArray() {
			values = v.Array()
			if len(values) == 0 {
				return fmt.Errorf("Laoli reference array must not be empty")
			}
		}
		for _, ref := range values {
			if ref.Type != gjson.String || !validImage2ProReference(ref.String()) {
				return fmt.Errorf("Laoli references must be HTTPS URLs or image Data URLs")
			}
			req.InputImageURLs = append(req.InputImageURLs, ref.String())
		}
	}
	if req.IsEdits() && len(req.InputImageURLs) == 0 {
		return fmt.Errorf("Laoli edits requires a reference image")
	}
	if mask := root.Get("mask"); mask.Exists() {
		if !req.IsEdits() || mask.Type != gjson.String || !validImage2ProReference(mask.String()) {
			return fmt.Errorf("Laoli edits mask must be an HTTPS URL or image Data URL")
		}
		req.HasMask, req.MaskImageURL = true, mask.String()
	}
	return nil
}

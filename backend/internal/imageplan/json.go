// Package imageplan contains the pure JSON parameter logic shared with Core's
// API-key Images dispatch. It cannot read credentials or perform network I/O.
package imageplan

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

const Generations = "/v1/images/generations"
const Edits = "/v1/images/edits"

// Image2ProSyncProtocol is set only by the server's dedicated compiler. It is
// not inferred from a browser field, model name or ordinary Images request.
const Image2ProSyncProtocol = "image2pro_sync_json_v1"

const image2ProSyncMaxBodyBytes = 24 << 20

func IsImageModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(model, "gpt-image-") || model == "grok-imagine" || model == "grok-imagine-edit" || strings.HasPrefix(model, "grok-imagine-image")
}

type JSONFields struct {
	LegacyStringReferences bool
	Image2ProReferences    bool
	Endpoint               string
	Model                  string
	ExplicitModel          bool
	Prompt                 string
	Stream                 bool
	N                      int
	Size                   string
	ExplicitSize           bool
	ResponseFormat         string
	Quality                string
	Background             string
	OutputFormat           string
	Moderation             string
	InputFidelity          string
	Style                  string
	HasMask                bool
	HasNativeOptions       bool
	OutputCompression      *int
	PartialImages          *int
	InputImageURLs         []string
	MaskImageURL           string
}

func (r *JSONFields) IsEdits() bool { return r.Endpoint == Edits }

func RewriteJSON(body []byte, model string) ([]byte, error) {
	return sjson.SetBytes(body, "model", model)
}

type AssetSlot struct {
	Kind           string `json:"kind"`
	Count          int    `json:"count"`
	Representation string `json:"representation"`
}
type Plan struct {
	Protocol   string         `json:"protocol,omitempty"`
	Method     string         `json:"method"`
	Path       string         `json:"path"`
	Encoding   string         `json:"encoding"`
	Fields     map[string]any `json:"fields"`
	Omitted    []string       `json:"omitted"`
	AssetSlots []AssetSlot    `json:"asset_slots"`
	body       []byte
}

// MaterializeJSON returns the exact rewritten dispatch bytes. Authentication,
// endpoint safety checks and network I/O remain with the existing Core executor.
func (p Plan) MaterializeJSON() []byte { return append([]byte(nil), p.body...) }

// CompileJSON exercises the dispatch parser and model rewrite with caller-owned
// bytes. Media validation supplies only synthetic fields and asset placeholders.
func CompileJSON(body []byte, upstream, endpoint string) (Plan, error) {
	return compileJSON(body, upstream, endpoint, "")
}

// CompileImage2ProJSON implements only the documented synchronous JSON contract.
// The public model ID remains the frozen Account catalog identity.
func CompileImage2ProJSON(body []byte, upstream, endpoint string) (Plan, error) {
	if len(body) > image2ProSyncMaxBodyBytes {
		return Plan{}, fmt.Errorf("Image2Pro synchronous JSON exceeds 24 MiB")
	}
	if upstream == "" || strings.TrimSpace(upstream) != upstream || len(upstream) > 256 {
		return Plan{}, fmt.Errorf("invalid Image2Pro public model ID")
	}
	return compileJSON(body, upstream, endpoint, Image2ProSyncProtocol)
}

func compileJSON(body []byte, upstream, endpoint, protocol string) (Plan, error) {
	p := Plan{Protocol: protocol, Method: "POST", Path: endpoint, Encoding: "application/json", Omitted: []string{}, AssetSlots: []AssetSlot{}}
	if endpoint != Generations && endpoint != Edits {
		return p, fmt.Errorf("unsupported endpoint")
	}
	if !gjson.ValidBytes(body) {
		return p, fmt.Errorf("invalid JSON")
	}
	fields := JSONFields{Endpoint: endpoint, N: 1, Image2ProReferences: protocol == Image2ProSyncProtocol}
	if err := ParseJSON(body, &fields); err != nil {
		return p, err
	}
	forwarded, err := RewriteJSON(body, upstream)
	if err != nil {
		return p, err
	}
	if err = json.Unmarshal(forwarded, &p.Fields); err != nil {
		return p, err
	}
	p.body = forwarded
	if len(fields.InputImageURLs) > 0 {
		representation := "image_url"
		if protocol == Image2ProSyncProtocol {
			representation = "string"
		}
		p.AssetSlots = append(p.AssetSlots, AssetSlot{Kind: "image", Count: len(fields.InputImageURLs), Representation: representation})
	}
	for _, field := range []string{"size", "quality", "style", "images", "mask", "stream"} {
		if _, ok := p.Fields[field]; !ok {
			p.Omitted = append(p.Omitted, field)
		}
	}
	return p, nil
}

func ParseJSON(body []byte, req *JSONFields) error {
	if req.Image2ProReferences {
		return parseImage2ProJSON(body, req)
	}
	if modelResult := gjson.GetBytes(body, "model"); modelResult.Exists() {
		req.Model = strings.TrimSpace(modelResult.String())
		req.ExplicitModel = req.Model != ""
	}
	req.Prompt = strings.TrimSpace(gjson.GetBytes(body, "prompt").String())

	if streamResult := gjson.GetBytes(body, "stream"); streamResult.Exists() {
		if streamResult.Type != gjson.True && streamResult.Type != gjson.False {
			return fmt.Errorf("invalid stream field type")
		}
		req.Stream = streamResult.Bool()
	}

	if nResult := gjson.GetBytes(body, "n"); nResult.Exists() {
		if nResult.Type != gjson.Number {
			return fmt.Errorf("invalid n field type")
		}
		req.N = int(nResult.Int())
		if req.N <= 0 {
			return fmt.Errorf("n must be greater than 0")
		}
	}

	if sizeResult := gjson.GetBytes(body, "size"); sizeResult.Exists() {
		req.Size = strings.TrimSpace(sizeResult.String())
		req.ExplicitSize = req.Size != ""
	}
	req.ResponseFormat = strings.ToLower(strings.TrimSpace(gjson.GetBytes(body, "response_format").String()))
	req.Quality = strings.TrimSpace(gjson.GetBytes(body, "quality").String())
	req.Background = strings.TrimSpace(gjson.GetBytes(body, "background").String())
	req.OutputFormat = strings.TrimSpace(gjson.GetBytes(body, "output_format").String())
	req.Moderation = strings.TrimSpace(gjson.GetBytes(body, "moderation").String())
	req.InputFidelity = strings.TrimSpace(gjson.GetBytes(body, "input_fidelity").String())
	req.Style = strings.TrimSpace(gjson.GetBytes(body, "style").String())
	req.HasMask = gjson.GetBytes(body, "mask").Exists()
	if outputCompression := gjson.GetBytes(body, "output_compression"); outputCompression.Exists() {
		if outputCompression.Type != gjson.Number {
			return fmt.Errorf("invalid output_compression field type")
		}
		v := int(outputCompression.Int())
		req.OutputCompression = &v
	}
	if partialImages := gjson.GetBytes(body, "partial_images"); partialImages.Exists() {
		if partialImages.Type != gjson.Number {
			return fmt.Errorf("invalid partial_images field type")
		}
		v := int(partialImages.Int())
		req.PartialImages = &v
	}
	if req.IsEdits() {
		images := gjson.GetBytes(body, "images")
		if images.Exists() {
			if !images.IsArray() {
				return fmt.Errorf("invalid images field type")
			}
			for _, item := range images.Array() {
				if req.LegacyStringReferences && item.Type == gjson.String {
					if !strings.HasPrefix(item.String(), "data:image/") {
						return fmt.Errorf("reference must be a data URL")
					}
					req.InputImageURLs = append(req.InputImageURLs, item.String())
					continue
				}
				if imageURL := strings.TrimSpace(item.Get("image_url").String()); imageURL != "" {
					req.InputImageURLs = append(req.InputImageURLs, imageURL)
					continue
				}
				if item.Get("file_id").Exists() {
					return fmt.Errorf("images[].file_id is not supported (use images[].image_url instead)")
				}
			}
		}
		if maskImageURL := strings.TrimSpace(gjson.GetBytes(body, "mask.image_url").String()); maskImageURL != "" {
			req.MaskImageURL = maskImageURL
			req.HasMask = true
		}
		if gjson.GetBytes(body, "mask.file_id").Exists() {
			return fmt.Errorf("mask.file_id is not supported (use mask.image_url instead)")
		}
		if len(req.InputImageURLs) == 0 {
			return fmt.Errorf("images[].image_url is required")
		}
	}
	req.HasNativeOptions = HasNativeOptions(func(path string) bool {
		return gjson.GetBytes(body, path).Exists()
	})
	return nil
}

func HasNativeOptions(exists func(path string) bool) bool {
	for _, path := range []string{
		"background",
		"quality",
		"style",
		"output_format",
		"output_compression",
		"moderation",
		"input_fidelity",
		"partial_images",
	} {
		if exists(path) {
			return true
		}
	}
	return false
}

// The allowlist follows the captured public synchronous image documentation,
// not the ordinary OpenAI image schema. Unconfirmed extension fields are refused.
func parseImage2ProJSON(body []byte, req *JSONFields) error {
	if len(body) > image2ProSyncMaxBodyBytes {
		return fmt.Errorf("Image2Pro synchronous JSON exceeds 24 MiB")
	}
	root := gjson.ParseBytes(body)
	if !gjson.ValidBytes(body) || !root.IsObject() || (req.Endpoint != Generations && req.Endpoint != Edits) {
		return fmt.Errorf("invalid Image2Pro synchronous request")
	}
	var fieldErr error
	seen := map[string]bool{}
	root.ForEach(func(key, _ gjson.Result) bool {
		name := key.String()
		if seen[name] {
			fieldErr = fmt.Errorf("duplicate Image2Pro field %s", name)
			return false
		}
		seen[name] = true
		switch name {
		case "model", "prompt", "n", "size", "aspect_ratio", "ratio", "resolution", "image_size",
			"input_image", "reference_image", "image", "images", "mask", "response_format", "client_request_id", "clientRequestId":
			return true
		default:
			fieldErr = fmt.Errorf("unsupported Image2Pro synchronous field %s", name)
			return false
		}
	})
	if fieldErr != nil {
		return fieldErr
	}
	for _, name := range []string{"model", "prompt"} {
		value := root.Get(name)
		if value.Type != gjson.String || strings.TrimSpace(value.String()) == "" {
			return fmt.Errorf("Image2Pro %s is required", name)
		}
	}
	req.Model = root.Get("model").String()
	if strings.TrimSpace(req.Model) != req.Model || len(req.Model) > 256 {
		return fmt.Errorf("invalid Image2Pro public model ID")
	}
	req.ExplicitModel, req.Prompt, req.N = true, strings.TrimSpace(root.Get("prompt").String()), 1
	if n := root.Get("n"); n.Exists() {
		value, err := strconv.ParseInt(n.Raw, 10, 32)
		if n.Type != gjson.Number || err != nil || value < 1 || value > 4 {
			return fmt.Errorf("Image2Pro n must be an integer from 1 to 4")
		}
		req.N = int(value)
	}
	for _, name := range []string{"size", "aspect_ratio", "ratio", "resolution", "image_size", "response_format", "client_request_id", "clientRequestId"} {
		if value := root.Get(name); value.Exists() && (value.Type != gjson.String || strings.TrimSpace(value.String()) == "") {
			return fmt.Errorf("invalid Image2Pro %s", name)
		}
	}
	req.Size = root.Get("size").String()
	req.ExplicitSize = req.Size != ""
	req.ResponseFormat = root.Get("response_format").String()
	// The workbench never sells a forced response encoding: data may contain
	// either URLs or Base64 independently of this request option.
	if req.ResponseFormat != "" && req.ResponseFormat != "url" {
		return fmt.Errorf("Image2Pro response_format must be url or omitted")
	}
	for _, name := range []string{"input_image", "reference_image", "image", "images"} {
		value := root.Get(name)
		if !value.Exists() {
			continue
		}
		values := []gjson.Result{value}
		if value.IsArray() {
			values = value.Array()
		}
		for _, item := range values {
			if item.Type != gjson.String || !validImage2ProReference(item.String()) {
				return fmt.Errorf("Image2Pro references must be HTTPS URLs or image Data URLs")
			}
			req.InputImageURLs = append(req.InputImageURLs, item.String())
		}
	}
	if len(req.InputImageURLs) > 16 {
		return fmt.Errorf("Image2Pro accepts at most 16 reference images")
	}
	if req.IsEdits() && len(req.InputImageURLs) == 0 {
		return fmt.Errorf("Image2Pro edits requires a reference image")
	}
	if mask := root.Get("mask"); mask.Exists() {
		if mask.Type != gjson.String || !validImage2ProReference(mask.String()) {
			return fmt.Errorf("Image2Pro mask must be an HTTPS URL or image Data URL")
		}
		req.HasMask, req.MaskImageURL = true, mask.String()
	}
	return nil
}

func validImage2ProReference(value string) bool {
	if len(value) > image2ProSyncMaxBodyBytes || strings.TrimSpace(value) != value || value == "" {
		return false
	}
	if strings.HasPrefix(value, "data:image/") {
		header, encoded, ok := strings.Cut(value, ";base64,")
		if !ok || len(header) <= len("data:image/") || encoded == "" {
			return false
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
		return err == nil && len(decoded) > 0
	}
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == ""
}

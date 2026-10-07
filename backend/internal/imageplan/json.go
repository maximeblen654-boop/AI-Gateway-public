// Package imageplan contains the pure JSON parameter logic shared with Core's
// API-key Images dispatch. It cannot read credentials or perform network I/O.
package imageplan

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

const Generations = "/v1/images/generations"
const Edits = "/v1/images/edits"

func IsImageModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(model, "gpt-image-") || model == "grok-imagine" || model == "grok-imagine-edit" || strings.HasPrefix(model, "grok-imagine-image")
}

type JSONFields struct {
	Endpoint          string
	Model             string
	ExplicitModel     bool
	Prompt            string
	Stream            bool
	N                 int
	Size              string
	ExplicitSize      bool
	ResponseFormat    string
	Quality           string
	Background        string
	OutputFormat      string
	Moderation        string
	InputFidelity     string
	Style             string
	HasMask           bool
	HasNativeOptions  bool
	OutputCompression *int
	PartialImages     *int
	InputImageURLs    []string
	MaskImageURL      string
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
	p := Plan{Method: "POST", Path: endpoint, Encoding: "application/json", Omitted: []string{}, AssetSlots: []AssetSlot{}}
	if endpoint != Generations && endpoint != Edits {
		return p, fmt.Errorf("unsupported endpoint")
	}
	if !gjson.ValidBytes(body) {
		return p, fmt.Errorf("invalid JSON")
	}
	fields := JSONFields{Endpoint: endpoint, N: 1}
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
		p.AssetSlots = append(p.AssetSlots, AssetSlot{Kind: "image", Count: len(fields.InputImageURLs), Representation: "image_url"})
	}
	for _, field := range []string{"size", "quality", "style", "images", "mask", "stream"} {
		if _, ok := p.Fields[field]; !ok {
			p.Omitted = append(p.Omitted, field)
		}
	}
	return p, nil
}

func ParseJSON(body []byte, req *JSONFields) error {
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

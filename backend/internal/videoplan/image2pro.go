package videoplan

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"slices"
	"strings"
)

const Image2ProRevision = "core_image2pro_video_r1"
const Image2ProContractRevision = "image2pro_public_video_20261019_r1"
const Image2ProInlineImageLimit = 15_000_000

// Image2ProCapabilities is the public /v1/models metadata allowlist. Protocol
// is an opaque supplier identity, never a model ID or a capability switch.
type Image2ProCapabilities struct {
	Protocol               string   `json:"protocol"`
	Modes                  []string `json:"modes"`
	MaxImages              int      `json:"max_images"`
	MaxAudioReferences     int      `json:"max_audio_references"`
	MaxVideoReferences     int      `json:"max_video_references"`
	SupportsAudioReference bool     `json:"supports_audio_reference"`
	DurationMin            int      `json:"duration_min"`
	DurationMax            int      `json:"duration_max"`
	AspectRatios           []string `json:"aspect_ratios"`
	Size                   string   `json:"size"`
	ReferenceAudioMaxBytes int64    `json:"reference_audio_max_bytes"`
	ReferenceVideoMaxBytes int64    `json:"reference_video_max_bytes"`
}

func (c Image2ProCapabilities) Valid() bool {
	if strings.TrimSpace(c.Protocol) == "" || len(c.Protocol) > 256 || len(c.Modes) == 0 || len(c.Modes) > 16 || c.MaxImages < 0 || c.MaxImages > 9 || c.MaxAudioReferences < 0 || c.MaxAudioReferences > 3 || c.MaxVideoReferences < 0 || c.MaxVideoReferences > 1 || c.DurationMin < 1 || c.DurationMax < c.DurationMin || c.DurationMax > 120 || len(c.AspectRatios) == 0 || len(c.AspectRatios) > 32 || strings.TrimSpace(c.Size) == "" || len(c.Size) > 32 || strings.TrimSpace(c.Size) != c.Size {
		return false
	}
	if c.SupportsAudioReference != (c.MaxAudioReferences > 0) || c.MaxAudioReferences > 0 && c.ReferenceAudioMaxBytes <= 0 || c.MaxVideoReferences > 0 && c.ReferenceVideoMaxBytes <= 0 {
		return false
	}
	if c.ReferenceAudioMaxBytes < 0 || c.ReferenceVideoMaxBytes < 0 {
		return false
	}
	for _, list := range [][]string{c.Modes, c.AspectRatios} {
		seen := map[string]bool{}
		for _, v := range list {
			if v == "" || len(v) > 64 || strings.TrimSpace(v) != v || seen[v] {
				return false
			}
			seen[v] = true
		}
	}
	return slices.Contains(c.Modes, "text") || slices.Contains(c.Modes, "reference")
}

func (c Image2ProCapabilities) Normalize() Image2ProCapabilities {
	c.Size = strings.ToUpper(c.Size)
	c.Modes = append([]string(nil), c.Modes...)
	slices.Sort(c.Modes)
	c.AspectRatios = append([]string(nil), c.AspectRatios...)
	slices.Sort(c.AspectRatios)
	return c
}

// DecodeImage2ProCapabilities requires the fields needed by this adapter. A
// missing capability cannot acquire a guessed default or a model-name fallback.
func DecodeImage2ProCapabilities(raw []byte) (*Image2ProCapabilities, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, ErrPlan
	}
	for _, k := range []string{"protocol", "modes", "max_images", "duration_min", "duration_max", "aspect_ratios", "size"} {
		if len(fields[k]) == 0 || bytes.Equal(fields[k], []byte("null")) {
			return nil, ErrPlan
		}
	}
	var c Image2ProCapabilities
	if json.Unmarshal(raw, &c) != nil || !c.Valid() {
		return nil, ErrPlan
	}
	c = c.Normalize()
	return &c, nil
}

type image2ProVideoRequest struct {
	Model    string                    `json:"model"`
	Prompt   string                    `json:"prompt"`
	Duration int                       `json:"duration"`
	Ratio    string                    `json:"ratio"`
	Images   []string                  `json:"images,omitempty"`
	Audios   []Image2ProMediaReference `json:"audios,omitempty"`
	Videos   []Image2ProMediaReference `json:"videos,omitempty"`
}
type Image2ProMediaReference struct {
	MediaID string `json:"mediaId"`
}

func decodeImage2ProRequest(body []byte) (image2ProVideoRequest, error) {
	var out image2ProVideoRequest
	// Duplicate keys at any depth cannot silently replace a reference identity.
	decoder := json.NewDecoder(bytes.NewReader(body))
	if uniqueImage2ProJSON(decoder, 0) != nil || decoder.Decode(new(any)) != io.EOF {
		return out, ErrPlan
	}
	decoder = json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&out) != nil || decoder.Decode(new(any)) != io.EOF {
		return out, ErrPlan
	}
	return out, nil
}

func uniqueImage2ProJSON(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return ErrPlan
	}
	token, e := decoder.Token()
	if e != nil {
		return ErrPlan
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	if delimiter == '{' {
		seen := map[string]bool{}
		for decoder.More() {
			key, e := decoder.Token()
			if e != nil {
				return ErrPlan
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return ErrPlan
			}
			seen[name] = true
			if uniqueImage2ProJSON(decoder, depth+1) != nil {
				return ErrPlan
			}
		}
		end, e := decoder.Token()
		if e != nil || end != json.Delim('}') {
			return ErrPlan
		}
		return nil
	}
	if delimiter == '[' {
		for decoder.More() {
			if uniqueImage2ProJSON(decoder, depth+1) != nil {
				return ErrPlan
			}
		}
		end, e := decoder.Token()
		if e != nil || end != json.Delim(']') {
			return ErrPlan
		}
		return nil
	}
	return ErrPlan
}

func Image2ProImageBytes(value string) ([]byte, string, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || len(encoded) > Image2ProInlineImageLimit*4/3+8 {
		return nil, "", ErrPlan
	}
	mime := ""
	for _, ct := range []string{"image/png", "image/jpeg", "image/webp"} {
		if header == "data:"+ct+";base64" {
			mime = ct
		}
	}
	if mime == "" {
		return nil, "", ErrPlan
	}
	b, e := base64.StdEncoding.Strict().DecodeString(encoded)
	if e != nil || len(b) == 0 || len(b) >= Image2ProInlineImageLimit {
		return nil, "", ErrPlan
	}
	return b, mime, nil
}

func validImage2ProMediaID(id string) bool {
	return id != "" && len(id) <= 256 && strings.TrimSpace(id) == id && !strings.ContainsAny(id, " \t\r\n:/?#@\\")
}

func validateImage2ProRequest(m Model, body []byte) (image2ProVideoRequest, error) {
	f, e := decodeImage2ProRequest(body)
	c := m.Image2Pro
	if e != nil || c == nil || !c.Valid() || m.Status != "enabled" || m.Mode != "image2pro" || f.Model != m.Upstream || strings.TrimSpace(f.Prompt) == "" || m.PromptMax > 0 && len([]rune(f.Prompt)) > m.PromptMax || !slices.Contains(m.Durations, f.Duration) || f.Duration < c.DurationMin || f.Duration > c.DurationMax || !slices.Contains(m.Resolutions, c.Normalize().Size) || !slices.Contains(m.Ratios, f.Ratio) || !slices.Contains(c.AspectRatios, f.Ratio) {
		return f, ErrPlan
	}
	ni, nv, na := len(f.Images), len(f.Videos), len(f.Audios)
	if ni > m.Limits.Image || ni > c.MaxImages || nv > m.Limits.Video || nv > c.MaxVideoReferences || na > m.Limits.Audio || na > c.MaxAudioReferences || na > 0 && !c.SupportsAudioReference || ni+nv+na > m.Limits.Total {
		return f, ErrPlan
	}
	mode := "text"
	if ni+nv+na > 0 {
		mode = "reference"
	}
	if !slices.Contains(c.Modes, mode) {
		return f, ErrPlan
	}
	seen := map[string]bool{}
	for _, im := range f.Images {
		if _, _, e := Image2ProImageBytes(im); e != nil || seen[im] {
			return f, ErrPlan
		}
		seen[im] = true
	}
	for _, refs := range [][]Image2ProMediaReference{f.Audios, f.Videos} {
		for _, ref := range refs {
			if !validImage2ProMediaID(ref.MediaID) || seen[ref.MediaID] {
				return f, ErrPlan
			}
			seen[ref.MediaID] = true
		}
	}
	return f, nil
}

func compileImage2ProPlan(m Model, upstream string, body []byte) (Plan, error) {
	if m.Upstream != upstream {
		return Plan{}, ErrPlan
	}
	if _, e := validateImage2ProRequest(m, body); e != nil {
		return Plan{}, e
	}
	return Plan{Version: "video_wire_plan_v1", AdapterRevision: Image2ProRevision, ContractRevision: Image2ProContractRevision, Method: "POST", Path: "/v1/videos", Body: append([]byte(nil), body...), RequestHash: digest(body)}, nil
}

func previewImage2Pro(m Model, resolution, ratio string, duration, images, videos, audio int) (Plan, error) {
	if m.Image2Pro == nil || !strings.EqualFold(resolution, m.Image2Pro.Size) {
		return Plan{}, ErrPlan
	}
	f := image2ProVideoRequest{Model: m.Upstream, Prompt: "<dry-run-prompt>", Duration: duration, Ratio: ratio}
	for i := 0; i < images; i++ {
		f.Images = append(f.Images, "data:image/png;base64,"+base64.StdEncoding.EncodeToString([]byte{137, 80, 78, 71, 13, 10, 26, 10, byte(i)}))
	}
	for i := 0; i < audio; i++ {
		f.Audios = append(f.Audios, Image2ProMediaReference{MediaID: "dry-run-audio-" + strings.Repeat("a", i+1)})
	}
	for i := 0; i < videos; i++ {
		f.Videos = append(f.Videos, Image2ProMediaReference{MediaID: "dry-run-video-" + strings.Repeat("v", i+1)})
	}
	body, e := json.Marshal(f)
	if e != nil {
		return Plan{}, e
	}
	return compileImage2ProPlan(m, m.Upstream, body)
}

func inspectImage2Pro(m Model, body []byte) (resolution, ratio string, duration, images, videos, audio int, err error) {
	f, e := validateImage2ProRequest(m, body)
	if e != nil {
		err = e
		return
	}
	return m.Image2Pro.Normalize().Size, f.Ratio, f.Duration, len(f.Images), len(f.Videos), len(f.Audios), nil
}

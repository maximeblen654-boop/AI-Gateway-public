// Package videoplan shares the existing BFF protocol's declarative wire fields.
// It has no network, credentials, Account selection or pricing dependencies.
package videoplan

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
)

const Revision = "laoli_video_json_v136_r1"

//go:embed contract.json
var contract []byte

type Model struct {
	ID          string                                   `json:"apiModelId"`
	Upstream    string                                   `json:"upstreamModelId"`
	Status      string                                   `json:"documentedStatus"`
	Durations   []int                                    `json:"durationSeconds"`
	Resolutions []string                                 `json:"resolutions"`
	Ratios      []string                                 `json:"ratios"`
	Mode        string                                   `json:"inputMode"`
	Required    []string                                 `json:"requiredAnyMedia"`
	Limits      struct{ Image, Video, Audio, Total int } `json:"mediaLimits"`
	PromptMax   int                                      `json:"promptMaxLength"`
}
type Wire struct {
	Duration   string         `json:"duration"`
	Ratio      string         `json:"aspectRatio"`
	Image      string         `json:"image"`
	Video      string         `json:"video"`
	Audio      string         `json:"audio"`
	References string         `json:"references"`
	Fixed      map[string]any `json:"fixed"`
}

var registry struct {
	Revision string          `json:"revision"`
	Models   []Model         `json:"models"`
	Profiles map[string]Wire `json:"wireProfiles"`
}

func init() {
	if err := json.Unmarshal(contract, &registry); err != nil {
		panic(err)
	}
}
func Lookup(id string) (Model, bool) {
	for _, m := range registry.Models {
		if m.ID == id && m.Status == "enabled" {
			return m, true
		}
	}
	return Model{}, false
}

// ValidWireProfile is the adapter-owned allowlist. Model IDs are deliberately
// absent: administrators may configure discovered models against this fixed
// protocol vocabulary without changing source or contract.json.
func ValidWireProfile(profile string) bool {
	_, ok := registry.Profiles[profile]
	return ok
}

// Plan freezes exact wire bytes. Materialize never re-reads the registry.
type Plan struct {
	Version          string `json:"version"`
	AdapterRevision  string `json:"adapter_revision"`
	ContractRevision string `json:"contract_revision"`
	Method           string `json:"method"`
	Path             string `json:"path"`
	Body             []byte `json:"body"`
	RequestHash      string `json:"request_hash"`
}

func digest(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }

var ErrPlan = errors.New("unsupported video plan or protocol fields")

// CompilePlan validates the existing builder's output. Wire names and fixed
// fields come from the same contract.json used by the JS builder, not a copied
// video field switch. Reference ownership remains the BFF asset boundary.
func CompilePlan(modelID, upstream string, body []byte) (Plan, error) {
	var p Plan
	m, ok := Lookup(modelID)
	if !ok || m.Upstream != upstream || len(body) > 128*1024*1024 {
		return p, ErrPlan
	}
	return CompilePlanForModel(m, upstream, body)
}

func CompilePlanForModel(m Model, upstream string, body []byte) (Plan, error) {
	var p Plan
	if m.Status != "enabled" || m.Upstream != upstream || len(body) > 128*1024*1024 {
		return p, ErrPlan
	}
	w, ok := registry.Profiles[m.Mode]
	if !ok {
		return p, ErrPlan
	}
	var f map[string]json.RawMessage
	if json.Unmarshal(body, &f) != nil {
		return p, ErrPlan
	}
	allowed := map[string]bool{"model": true, "prompt": true, "resolution": true, w.Duration: true, w.Ratio: true}
	for _, name := range []string{w.Image, w.Video, w.Audio, w.References} {
		if name != "" {
			allowed[name] = true
		}
	}
	for name := range w.Fixed {
		allowed[name] = true
	}
	for name := range f {
		if !allowed[name] {
			return p, ErrPlan
		}
	}
	str := func(key string) string { var v string; _ = json.Unmarshal(f[key], &v); return v }
	var seconds int
	if json.Unmarshal(f[w.Duration], &seconds) != nil || str("model") != upstream || strings.TrimSpace(str("prompt")) == "" ||
		(m.PromptMax > 0 && len([]rune(str("prompt"))) > m.PromptMax) || !slices.Contains(m.Durations, seconds) || !slices.Contains(m.Resolutions, str("resolution")) || !slices.Contains(m.Ratios, str(w.Ratio)) {
		return p, ErrPlan
	}
	for name, want := range w.Fixed {
		var got any
		if json.Unmarshal(f[name], &got) != nil || !reflect.DeepEqual(got, want) {
			return p, ErrPlan
		}
	}
	_, _, _, images, videos, audio, err := InspectForModel(m, body)
	counts := map[string]int{"image": images, "video": videos, "audio": audio}
	required := len(m.Required) == 0
	for _, kind := range m.Required {
		required = required || counts[kind] > 0
	}
	if err != nil || !required || images > m.Limits.Image || videos > m.Limits.Video || audio > m.Limits.Audio || images+videos+audio > m.Limits.Total {
		return p, ErrPlan
	}
	p = Plan{Version: "video_wire_plan_v1", AdapterRevision: Revision, ContractRevision: registry.Revision, Method: "POST", Path: "/v1/videos", Body: append([]byte(nil), body...), RequestHash: digest(body)}
	return p, nil
}
func (p Plan) Materialize() ([]byte, string, error) {
	if p.Version != "video_wire_plan_v1" || p.AdapterRevision != Revision || p.Method != "POST" || p.Path != "/v1/videos" || !json.Valid(p.Body) || digest(p.Body) != p.RequestHash {
		return nil, "", ErrPlan
	}
	return append([]byte(nil), p.Body...), p.RequestHash, nil
}

// Preview and executable validation consume the same declarative field map.
func Preview(modelID, upstream, resolution, ratio string, duration int) (Plan, error) {
	return PreviewWithMedia(modelID, upstream, resolution, ratio, duration, 0, 0, 0)
}
func PreviewWithMedia(modelID, upstream, resolution, ratio string, duration, images, videos, audio int) (Plan, error) {
	m, ok := Lookup(modelID)
	if !ok {
		return Plan{}, ErrPlan
	}
	return PreviewWithModel(m, upstream, resolution, ratio, duration, images, videos, audio)
}

func PreviewWithModel(m Model, upstream, resolution, ratio string, duration, images, videos, audio int) (Plan, error) {
	if m.Status != "enabled" || m.Upstream != upstream || !ValidWireProfile(m.Mode) {
		return Plan{}, ErrPlan
	}
	w := registry.Profiles[m.Mode]
	f := map[string]any{"model": upstream, "prompt": "<dry-run-prompt>", "resolution": resolution, w.Duration: duration, w.Ratio: ratio}
	for k, v := range w.Fixed {
		f[k] = v
	}
	for i, n := range []int{images, videos, audio} {
		if n < 0 || n > 16 {
			return Plan{}, ErrPlan
		}
		kind := []string{"image", "video", "audio"}[i]
		for j := 0; j < n; j++ {
			if w.References != "" {
				refs, _ := f[w.References].([]map[string]any)
				f[w.References] = append(refs, map[string]any{"type": kind, "source": "https://example.invalid/verified-reference"})
			} else {
				name := []string{w.Image, w.Video, w.Audio}[i]
				if name == "" {
					return Plan{}, ErrPlan
				}
				refs, _ := f[name].([]string)
				f[name] = append(refs, "data:application/octet-stream;base64,AA==")
			}
		}
	}
	body, e := json.Marshal(f)
	if e != nil {
		return Plan{}, e
	}
	return CompilePlanForModel(m, upstream, body)
}

func Inspect(modelID string, body []byte) (resolution, ratio string, duration, images, videos, audio int, err error) {
	m, ok := Lookup(modelID)
	if !ok {
		err = ErrPlan
		return
	}
	return InspectForModel(m, body)
}

func InspectForModel(m Model, body []byte) (resolution, ratio string, duration, images, videos, audio int, err error) {
	if m.Status != "enabled" || !ValidWireProfile(m.Mode) {
		err = ErrPlan
		return
	}
	w := registry.Profiles[m.Mode]
	var f map[string]json.RawMessage
	if json.Unmarshal(body, &f) != nil {
		err = ErrPlan
		return
	}
	_ = json.Unmarshal(f["resolution"], &resolution)
	_ = json.Unmarshal(f[w.Ratio], &ratio)
	_ = json.Unmarshal(f[w.Duration], &duration)
	for i, name := range []string{w.Image, w.Video, w.Audio} {
		if name == "" {
			continue
		}
		var values []string
		if raw, exists := f[name]; exists {
			if json.Unmarshal(raw, &values) != nil {
				err = ErrPlan
				return
			}
		}
		switch i {
		case 0:
			images = len(values)
		case 1:
			videos = len(values)
		case 2:
			audio = len(values)
		}
	}
	if w.References != "" {
		var refs []struct {
			Type string `json:"type"`
		}
		if raw, exists := f[w.References]; exists {
			if json.Unmarshal(raw, &refs) != nil {
				err = ErrPlan
				return
			}
		}
		for _, r := range refs {
			switch r.Type {
			case "image":
				images++
			case "video":
				videos++
			case "audio":
				audio++
			default:
				err = ErrPlan
				return
			}
		}
	}
	return
}

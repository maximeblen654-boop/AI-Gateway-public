package videoplan

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const LaoliMediaProfile = "laoli_openai_20261024"
const LaoliMediaRevision = "laoli_video_openai_20261024_r1"
const LaoliMediaContractRevision = "laoli-media-api-2026-10-24"

// Exact supplier contract captured from the current public media document.
//
//go:embed laoli-20261024.json
var laoliMediaContract []byte

var laoliMediaModels = func() []Model {
	var c struct {
		Models []Model `json:"models"`
	}
	if err := json.Unmarshal(laoliMediaContract, &c); err != nil {
		panic(err)
	}
	return c.Models
}()

var laoliRatio = regexp.MustCompile(`^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$`)

// LaoliMediaModel resolves an exact upstream ID. The public document omits
// ratios for some families; only the explicit product draft may supply those.
func LaoliMediaModel(upstream string, explicitRatios []string) (Model, bool) {
	for _, known := range laoliMediaModels {
		if known.Upstream != upstream {
			continue
		}
		m := known
		m.Durations = append([]int(nil), known.Durations...)
		m.Resolutions = append([]string(nil), known.Resolutions...)
		m.Ratios = append([]string(nil), known.Ratios...)
		if len(m.Ratios) == 0 {
			if len(explicitRatios) == 0 {
				return Model{}, false
			}
			for _, r := range explicitRatios {
				if !laoliRatio.MatchString(r) || slices.Contains(m.Ratios, r) {
					return Model{}, false
				}
				m.Ratios = append(m.Ratios, r)
			}
		}
		return m, true
	}
	return Model{}, false
}

func laoliWire() Wire {
	return Wire{Duration: "seconds", Ratio: "aspect_ratio", Image: "reference_images", Video: "reference_videos", Audio: "reference_audios"}
}

func validLaoliModel(m Model) bool {
	known, ok := LaoliMediaModel(m.Upstream, m.Ratios)
	if !ok || m.Mode != LaoliMediaProfile || m.Status != "enabled" || len(m.Durations) == 0 || len(m.Resolutions) == 0 || len(m.Ratios) == 0 ||
		m.Limits.Image < 0 || m.Limits.Video < 0 || m.Limits.Audio < 0 || m.Limits.Total < 0 ||
		m.Limits.Image > known.Limits.Image || m.Limits.Video > known.Limits.Video || m.Limits.Audio > known.Limits.Audio || m.Limits.Total > known.Limits.Total {
		return false
	}
	for _, v := range m.Durations {
		if !slices.Contains(known.Durations, v) {
			return false
		}
	}
	for _, v := range m.Resolutions {
		if !slices.Contains(known.Resolutions, v) {
			return false
		}
	}
	for _, v := range m.Ratios {
		if !slices.Contains(known.Ratios, v) {
			return false
		}
	}
	return true
}

// DecodeLaoliInlineReference decodes the frozen internal representation. The
// HTTP adapter sends these bytes as documented multipart file fields, never
// assumes that the supplier accepts data URIs in a JSON reference array.
func DecodeLaoliInlineReference(value, kind string) ([]byte, string, error) {
	prefix, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(prefix, "data:") || !strings.HasSuffix(prefix, ";base64") {
		return nil, "", ErrPlan
	}
	mime := strings.TrimSuffix(strings.TrimPrefix(prefix, "data:"), ";base64")
	allowed := map[string][]string{
		"image": {"image/png", "image/jpeg", "image/webp"},
		"video": {"video/mp4", "video/quicktime", "video/webm"},
		"audio": {"audio/mpeg", "audio/mp3", "audio/x-m4a", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg"},
	}
	if !slices.Contains(allowed[kind], mime) || encoded == "" || len(encoded) > 128*1024*1024 || strings.ContainsAny(encoded, "\r\n") {
		return nil, "", ErrPlan
	}
	b, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(b) == 0 {
		return nil, "", ErrPlan
	}
	return b, mime, nil
}

func validLaoliReference(value, kind string) bool {
	if strings.HasPrefix(value, "data:") {
		_, _, err := DecodeLaoliInlineReference(value, kind)
		return err == nil
	}
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && strings.TrimSpace(value) == value
}

func bytesEqualNull(raw []byte) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

// The documented JSON contract rejects duplicate field names. Do the same for
// the frozen internal plan before a multipart request can be dispatched.
func uniqueLaoliFields(body []byte) bool {
	d := json.NewDecoder(bytes.NewReader(body))
	tok, err := d.Token()
	if err != nil || tok != json.Delim('{') {
		return false
	}
	seen := map[string]bool{}
	for d.More() {
		tok, err = d.Token()
		key, ok := tok.(string)
		if err != nil || !ok || seen[key] {
			return false
		}
		seen[key] = true
		var v json.RawMessage
		if d.Decode(&v) != nil {
			return false
		}
	}
	tok, err = d.Token()
	if err != nil || tok != json.Delim('}') {
		return false
	}
	var extra any
	return d.Decode(&extra) == io.EOF
}

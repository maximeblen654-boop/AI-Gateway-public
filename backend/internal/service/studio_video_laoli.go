package service

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

var laoliIdempotencyKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)

// A lost submission is recovered with the original Account and durable child
// key. A 404, malformed receipt or transport failure never authorizes a POST,
// release, capture, or change of supplier.
func (r *StudioVideoRuntime) recoverLaoliSubmission(ctx context.Context, owner StudioImageOwner, id string, state StudioVideoState) (StudioVideoState, error) {
	t, err := r.Store.Task(id, owner)
	if err != nil {
		return state, err
	}
	if !imagecontract.IsLaoliMediaBase(t.Quote.Binding.BaseURL) || !laoliIdempotencyKey.MatchString(id) {
		return state, nil
	}
	if _, err := os.Stat(r.Store.path("dispatch", id)); err != nil {
		return state, err
	}
	a, release, err := r.account(ctx, t.Quote.Binding, false, false)
	if err != nil {
		return r.videoState(t, "", "recovery_blocked"), err
	}
	defer release()
	ctx = context.WithValue(ctx, videoAdapterContextKey{}, t.Quote.Binding.Offer.Adapter.Kind)
	ctx = context.WithValue(ctx, videoIdempotencyContextKey{}, id)
	body, _, err := r.request(ctx, a, http.MethodGet, "/video-submissions/current", nil)
	if err != nil {
		return state, err
	}
	upstream := videoTaskID(body)
	if !studioImageTaskID.MatchString(upstream) {
		return state, ErrStudioVideoUnknown
	}
	if err := r.Store.Accept(id, upstream); err != nil {
		return state, err
	}
	return r.videoState(t, upstream, "accepted"), nil
}

// The frozen private plan holds verified asset bytes as typed data URIs.
// Only the documented multipart wire carries files to Laoli; no undocumented
// upload endpoint or JSON data-URI support is assumed.
func laoliVideoMultipart(body []byte) ([]byte, string, error) {
	var fields map[string]json.RawMessage
	if len(body) > 24<<20 || json.Unmarshal(body, &fields) != nil {
		return nil, "", ErrStudioVideoConflict
	}
	var out bytes.Buffer
	w := multipart.NewWriter(&out)
	for _, name := range []string{"model", "prompt", "seconds", "resolution", "aspect_ratio"} {
		var value string
		if name == "seconds" {
			var seconds int
			if json.Unmarshal(fields[name], &seconds) != nil || seconds < 1 {
				return nil, "", ErrStudioVideoConflict
			}
			value = strconv.Itoa(seconds)
		} else if json.Unmarshal(fields[name], &value) != nil || strings.TrimSpace(value) == "" {
			return nil, "", ErrStudioVideoConflict
		}
		if err := w.WriteField(name, value); err != nil {
			return nil, "", err
		}
	}
	for _, ref := range []struct{ field, kind string }{{"reference_images", "image"}, {"reference_videos", "video"}, {"reference_audios", "audio"}} {
		if _, ok := fields[ref.field]; !ok {
			continue
		}
		var values []string
		if json.Unmarshal(fields[ref.field], &values) != nil {
			return nil, "", ErrStudioVideoConflict
		}
		for i, value := range values {
			if !strings.HasPrefix(value, "data:") {
				if !strings.HasPrefix(value, "https://") {
					return nil, "", ErrStudioVideoConflict
				}
				if err := w.WriteField(ref.field, value); err != nil {
					return nil, "", err
				}
				continue
			}
			content, ct, err := videoplan.DecodeLaoliInlineReference(value, ref.kind)
			if err != nil {
				return nil, "", ErrStudioVideoConflict
			}
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", `form-data; name="`+ref.field+`"; filename="reference-`+strconv.Itoa(i)+`"`)
			header.Set("Content-Type", ct)
			part, err := w.CreatePart(header)
			if err != nil {
				return nil, "", err
			}
			if _, err := part.Write(content); err != nil {
				return nil, "", err
			}
		}
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return out.Bytes(), w.FormDataContentType(), nil
}

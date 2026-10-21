package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/imagecontract"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
)

func image2ProInlineReceipt(in StudioVideoReferenceAsset) StudioVideoReferenceReceipt {
	return StudioVideoReferenceReceipt{AssetRef: in.AssetRef, Kind: in.Kind, MimeType: in.MimeType, Size: in.Size, SHA256: in.SHA256, DurationSeconds: in.DurationSeconds, SourceKind: "inline"}
}

func validateImage2ProReferenceReceipt(in StudioVideoReferenceAsset, out StudioVideoReferenceReceipt, now time.Time) error {
	if out.AssetRef != in.AssetRef || out.Kind != in.Kind || out.MimeType != in.MimeType || out.Size != in.Size || out.SHA256 != in.SHA256 || out.DurationSeconds != in.DurationSeconds || out.Source != "" || out.UploadID != "" {
		return ErrStudioVideoConflict
	}
	if in.Kind == "image" {
		if out.SourceKind != "inline" || out.MediaID != "" || !out.ExpiresAt.IsZero() {
			return ErrStudioVideoConflict
		}
		return nil
	}
	if (in.Kind != "audio" && in.Kind != "video") || out.SourceKind != "media_id" || !safeImage2ProMediaID(out.MediaID) || !now.Before(out.ExpiresAt) {
		return ErrStudioVideoConflict
	}
	return nil
}

func image2ProPreparationCurrent(prep StudioVideoReferencePreparation, now time.Time) bool {
	if !now.Before(prep.ExpiresAt) || len(prep.Assets) != len(prep.Receipts) {
		return false
	}
	for i, receipt := range prep.Receipts {
		a := prep.Assets[i]
		if validateImage2ProReferenceReceipt(StudioVideoReferenceAsset{AssetRef: a.AssetRef, Kind: a.Kind, MimeType: a.MimeType, Size: a.Size, SHA256: a.SHA256, DurationSeconds: a.DurationSeconds}, receipt, now) != nil {
			return false
		}
	}
	return true
}

func validateImage2ProReferenceAssets(offer mediaworkbench.Offer, spec mediaworkbench.Spec, assets []StudioVideoReferenceAsset) error {
	c := offer.ResolvedConfig.Image2Pro
	if c == nil || !c.Valid() || spec.Images > c.MaxImages || spec.Audio > c.MaxAudioReferences || spec.Videos > c.MaxVideoReferences {
		return ErrStudioVideoConflict
	}
	seen := map[string]bool{}
	for _, input := range assets {
		if seen[input.AssetRef] || seen[input.Kind+":"+input.SHA256] || input.AssetRef == "" {
			return ErrStudioVideoConflict
		}
		seen[input.AssetRef] = true
		seen[input.Kind+":"+input.SHA256] = true
		switch input.Kind {
		case "image":
			if input.Size >= videoplan.Image2ProInlineImageLimit || input.MimeType != "image/png" && input.MimeType != "image/jpeg" && input.MimeType != "image/webp" {
				return ErrStudioVideoConflict
			}
		case "audio":
			if !c.SupportsAudioReference || int64(input.Size) > c.ReferenceAudioMaxBytes || input.Size >= 15_000_000 {
				return ErrStudioVideoConflict
			}
			switch input.MimeType {
			case "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm", "audio/aac", "audio/flac":
			default:
				return ErrStudioVideoConflict
			}
		case "video":
			if c.MaxVideoReferences < 1 || int64(input.Size) > c.ReferenceVideoMaxBytes || input.Size >= 50_000_000 || input.MimeType != "video/mp4" {
				return ErrStudioVideoConflict
			}
		default:
			return ErrStudioVideoConflict
		}
	}
	return nil
}

func validateImage2ProPreparedBody(prep StudioVideoReferencePreparation, body []byte, now time.Time) error {
	if !image2ProPreparationCurrent(prep, now) {
		return ErrStudioVideoConflict
	}
	var f struct {
		Images []string                            `json:"images"`
		Audios []videoplan.Image2ProMediaReference `json:"audios"`
		Videos []videoplan.Image2ProMediaReference `json:"videos"`
	}
	if json.Unmarshal(body, &f) != nil || len(f.Images) != prep.Spec.Images || len(f.Audios) != prep.Spec.Audio || len(f.Videos) != prep.Spec.Videos || len(prep.Receipts) != len(f.Images)+len(f.Audios)+len(f.Videos) {
		return ErrStudioVideoConflict
	}
	im, au, vi := 0, 0, 0
	for _, receipt := range prep.Receipts {
		switch receipt.Kind {
		case "image":
			if im >= len(f.Images) {
				return ErrStudioVideoConflict
			}
			b, mime, e := videoplan.Image2ProImageBytes(f.Images[im])
			im++
			if e != nil || mime != receipt.MimeType || len(b) != receipt.Size || !strings.EqualFold(fmt.Sprintf("%x", sha256.Sum256(b)), receipt.SHA256) {
				return ErrStudioVideoConflict
			}
		case "audio":
			if au >= len(f.Audios) || f.Audios[au].MediaID != receipt.MediaID {
				return ErrStudioVideoConflict
			}
			au++
		case "video":
			if vi >= len(f.Videos) || f.Videos[vi].MediaID != receipt.MediaID {
				return ErrStudioVideoConflict
			}
			vi++
		default:
			return ErrStudioVideoConflict
		}
	}
	return nil
}

func safeImage2ProMediaID(id string) bool {
	return id != "" && len(id) <= 256 && strings.TrimSpace(id) == id && !strings.ContainsAny(id, " \t\r\n:/?#@\\")
}

type image2ProReferenceCache struct {
	Identity string                      `json:"identity"`
	Receipt  StudioVideoReferenceReceipt `json:"receipt"`
}

func (u *HTTPAccountBoundReferenceUploader) uploadImage2ProReference(ctx context.Context, a *Account, owner StudioImageOwner, offer mediaworkbench.Offer, input StudioVideoReferenceAsset, content []byte) (StudioVideoReferenceReceipt, error) {
	var empty StudioVideoReferenceReceipt
	if u == nil || u.Core == nil || u.Core.httpUpstream == nil || a == nil || owner.UserID <= 0 || owner.APIKeyID <= 0 || owner.GroupID <= 0 || a.ID != offer.AccountID || offer.UpstreamModel == "" || !imagecontract.IsImage2ProBase(a.GetOpenAIBaseURL()) || a.GetOpenAIProtocolAPIKey() == "" || input.Kind == "image" || input.Size != len(content) || fmt.Sprintf("%x", sha256.Sum256(content)) != strings.ToLower(input.SHA256) {
		return empty, ErrStudioVideoReferenceUploadUnavailable
	}
	if a.ProxyID != nil && (a.Proxy == nil || a.Proxy.ID != *a.ProxyID) {
		return empty, ErrStudioVideoConflict
	}
	spec := mediaworkbench.Spec{}
	switch input.Kind {
	case "audio":
		spec.Audio = 1
	case "video":
		spec.Videos = 1
	default:
		return empty, ErrStudioVideoConflict
	}
	if e := validateImage2ProReferenceAssets(offer, spec, []StudioVideoReferenceAsset{input}); e != nil {
		return empty, e
	}
	proxy := ""
	if a.Proxy != nil {
		proxy = a.Proxy.URL()
	}
	identity := studioHash(struct {
		Owner                                                      StudioImageOwner
		Account                                                    int64
		Base, Model, Adapter, Credential, Proxy, Asset, Hash, Mime string
		Size                                                       int
	}{owner, a.ID, a.GetOpenAIBaseURL(), offer.UpstreamModel, offer.Adapter.Revision, videoCredentialFingerprint(a), proxy, input.AssetRef, input.SHA256, input.MimeType, input.Size})
	if u.StateRoot == "" {
		return empty, ErrStudioVideoReferenceUploadUnavailable
	}
	state := filepath.Join(u.StateRoot, "image2pro-"+identity+".json")
	if e := os.MkdirAll(u.StateRoot, 0700); e != nil {
		return empty, e
	}
	unlock, e := studioFileLock(state + ".lock")
	if e != nil {
		return empty, e
	}
	defer unlock()
	var cached image2ProReferenceCache
	if e = studioRead(state, &cached); e == nil {
		if cached.Identity != identity {
			return empty, ErrStudioVideoConflict
		}
		if validateImage2ProReferenceReceipt(input, cached.Receipt, time.Now().UTC().Add(2*time.Minute)) == nil {
			return cached.Receipt, nil
		}
	} else if !os.IsNotExist(e) {
		return empty, e
	}
	parsed, e := url.Parse(a.GetOpenAIBaseURL())
	if e != nil {
		return empty, ErrStudioVideoConflict
	}
	ext := map[string]string{"audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/aac": "aac", "audio/flac": "flac", "video/mp4": "mp4"}[input.MimeType]
	if ext == "" {
		return empty, ErrStudioVideoConflict
	}
	query := url.Values{"kind": {input.Kind}, "model": {offer.UpstreamModel}, "name": {"reference-" + input.SHA256[:12] + "." + ext}}
	endpoint := parsed.Scheme + "://" + parsed.Host + "/api/v1/reference-media?" + query.Encode()
	req, e := http.NewRequestWithContext(WithHTTPUpstreamRedirectsDisabled(ctx), http.MethodPost, endpoint, bytes.NewReader(content))
	if e != nil {
		return empty, e
	}
	req.GetBody = nil
	req.ContentLength = int64(len(content))
	req.Header.Set("Content-Type", input.MimeType)
	req.Header.Set("Authorization", "Bearer "+a.GetOpenAIProtocolAPIKey())
	req.Header.Set("Accept", "application/json")
	resp, e := u.Core.httpUpstream.Do(req, proxy, a.ID, a.Concurrency)
	if e != nil {
		return empty, ErrStudioVideoReferenceUploadUnavailable
	}
	defer func() { _ = resp.Body.Close() }()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if e != nil || len(raw) > 1<<20 {
		return empty, ErrStudioVideoReferenceUploadUnavailable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return empty, newImage2ProHTTPError(resp.StatusCode, raw)
	}
	var result struct {
		OK        bool   `json:"ok"`
		MediaID   string `json:"mediaId"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if json.Unmarshal(raw, &result) != nil || !result.OK || !safeImage2ProMediaID(result.MediaID) || result.ExpiresAt <= 0 {
		return empty, ErrStudioVideoConflict
	}
	out := image2ProInlineReceipt(input)
	out.SourceKind = "media_id"
	out.MediaID = result.MediaID
	out.ExpiresAt = time.UnixMilli(result.ExpiresAt).UTC()
	if e = validateImage2ProReferenceReceipt(input, out, time.Now().UTC()); e != nil {
		return empty, e
	}
	raw, e = json.Marshal(image2ProReferenceCache{identity, out})
	if e != nil {
		return empty, e
	}
	if e = studioWrite(state, raw, false); e != nil {
		return empty, e
	}
	return out, nil
}

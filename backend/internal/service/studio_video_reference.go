package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
)

const StudioVideoReferencePreparationVersion = "account_video_reference_prepare_v1"

var ErrStudioVideoReferenceUploadUnavailable = errors.New("account-bound reference upload unavailable")

// StudioVideoReferenceAsset is sent over the authenticated BFF -> Core bridge.
// It contains bytes, never a browser-controlled path, URL, supplier credential,
// or receipt. Core validates the digest and binds the upload to the resolved
// Account before invoking its uploader.
type StudioVideoReferenceAsset struct {
	Kind            string  `json:"kind"`
	MimeType        string  `json:"mime_type"`
	AssetRef        string  `json:"asset_ref"`
	SHA256          string  `json:"sha256"`
	Size            int     `json:"size"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
	BytesBase64     string  `json:"bytes_base64"`
}

type StudioVideoReferenceReceipt struct {
	AssetRef        string  `json:"asset_ref"`
	Kind            string  `json:"kind"`
	MimeType        string  `json:"mime_type"`
	Size            int     `json:"size"`
	SHA256          string  `json:"sha256"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
	Source          string  `json:"source"`
	UploadID        string  `json:"upload_id"`
}
type StudioVideoReferencePreparationResult struct {
	PreparationID string                        `json:"preparation_id"`
	Receipts      []StudioVideoReferenceReceipt `json:"receipts"`
}

type AccountBoundReferenceUploader interface {
	Upload(context.Context, *Account, StudioImageOwner, mediaworkbench.Offer, StudioVideoReferenceAsset, []byte) (StudioVideoReferenceReceipt, error)
}

func validateStudioVideoReferenceInput(a StudioVideoReferenceAsset) ([]byte, error) {
	if a.Kind != "image" && a.Kind != "video" && a.Kind != "audio" {
		return nil, errors.New("invalid reference kind")
	}
	allowedMIME := map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "video/mp4": true, "video/quicktime": true, "video/webm": true, "audio/mpeg": true, "audio/mp3": true, "audio/x-m4a": true, "audio/mp4": true, "audio/wav": true, "audio/x-wav": true, "audio/ogg": true}
	if !allowedMIME[a.MimeType] || !strings.HasPrefix(a.MimeType, a.Kind+"/") || len(a.SHA256) != 64 || strings.Trim(strings.ToLower(a.SHA256), "0123456789abcdef") != "" || a.Size < 8 || a.Size > 100_000_000 {
		return nil, errors.New("invalid reference metadata")
	}
	b, err := base64.StdEncoding.DecodeString(a.BytesBase64)
	if err != nil || len(b) != a.Size {
		return nil, errors.New("reference bytes mismatch")
	}
	if fmt.Sprintf("%x", sha256.Sum256(b)) != strings.ToLower(a.SHA256) {
		return nil, errors.New("reference digest mismatch")
	}
	return b, nil
}

func validateStudioVideoReferenceReceipt(in StudioVideoReferenceAsset, out StudioVideoReferenceReceipt) error {
	if out.AssetRef != in.AssetRef || out.Kind != in.Kind || out.MimeType != in.MimeType || out.Size != in.Size ||
		out.SHA256 != in.SHA256 || out.DurationSeconds != in.DurationSeconds || strings.TrimSpace(out.Source) == "" || !strings.HasPrefix(out.Source, "https://") || strings.TrimSpace(out.UploadID) == "" {
		return errors.New("invalid reference upload receipt")
	}
	if in.DurationSeconds > 0 && out.DurationSeconds > 0 && in.DurationSeconds != out.DurationSeconds {
		return errors.New("reference duration mismatch")
	}
	return nil
}

func (r *StudioVideoRuntime) PrepareReferenceAssets(ctx context.Context, owner StudioImageOwner, key *APIKey, offerID string, spec mediaworkbench.Spec, assets []StudioVideoReferenceAsset) (StudioVideoReferencePreparationResult, error) {
	var empty StudioVideoReferencePreparationResult
	if r == nil || r.Core == nil || r.Media == nil || !videoOwnerKey(owner, key) || len(assets) == 0 || len(assets) > 16 {
		return empty, ErrStudioVideoInvalidOrder
	}
	// Validate the complete ordered input before the first external side effect.
	for _, input := range assets {
		if _, err := validateStudioVideoReferenceInput(input); err != nil {
			return empty, err
		}
	}
	counts := map[string]int{}
	for _, input := range assets {
		counts[input.Kind]++
	}
	if spec.Images != counts["image"] || spec.Videos != counts["video"] || spec.Audio != counts["audio"] {
		return empty, ErrStudioVideoInvalidOrder
	}
	resolved, err := mediaworkbench.NewService(r.Media).ResolvePublishedVideoOffer(ctx, offerID, spec, func(id int64) bool {
		a, e := r.Core.accountRepo.GetByID(ctx, id)
		return e == nil && a != nil && slicesContainsInt64(a.GroupIDs, owner.GroupID)
	})
	if err != nil || !key.Group.ModelAllowlist.Allows(resolved.Offer.SiteModel) {
		return empty, ErrStudioVideoReferenceUploadUnavailable
	}
	a, err := r.Core.accountRepo.GetByID(ctx, resolved.Offer.AccountID)
	if err != nil || a == nil || !a.IsActive() || !slicesContainsInt64(a.GroupIDs, owner.GroupID) {
		return empty, ErrStudioVideoInvalidOrder
	}
	if a.GetOpenAIProtocolAPIKey() == "" || a.GetOpenAIBaseURL() == "" || !a.IsSchedulable() {
		return empty, ErrStudioVideoInvalidOrder
	}
	uploader := r.ReferenceUploader
	if uploader == nil {
		if r.Core.httpUpstream == nil {
			return empty, ErrStudioVideoReferenceUploadUnavailable
		}
		uploader = NewHTTPAccountBoundReferenceUploader(r.Core)
	}
	intentHash := studioHash(struct {
		Owner  StudioImageOwner
		Offer  mediaworkbench.Offer
		Spec   mediaworkbench.Spec
		Assets []StudioVideoReferenceAsset
	}{owner, resolved.Offer, spec, assets})
	endpointFingerprint := studioHash(struct{ Base, Model string }{a.GetOpenAIBaseURL(), resolved.Offer.UpstreamModel})
	proxyFingerprint := studioHash(func() string {
		if a.Proxy == nil {
			return ""
		}
		return a.Proxy.URL()
	}())
	prepID := "prep_" + intentHash
	if err := r.Store.init(); err != nil {
		return empty, err
	}
	unlock, err := studioFileLock(r.Store.path("reference-lock", prepID))
	if err != nil {
		return empty, err
	}
	defer unlock()
	prep := StudioVideoReferencePreparation{Version: StudioVideoReferencePreparationVersion, ID: prepID, Owner: owner, OfferID: offerID,
		PublishedRevision: resolved.PublishedRevision, AdapterRevision: resolved.Offer.Adapter.Revision, AccountID: resolved.Offer.AccountID,
		EndpointFingerprint: endpointFingerprint, CredentialFingerprint: videoCredentialFingerprint(a), ProxyFingerprint: proxyFingerprint,
		SalePrice: resolved.Offer.SalePrice, Spec: spec, AssetIntentHash: intentHash, Status: "uploading", Receipts: nil, Assets: make([]StudioVideoReferenceIntentAsset, 0, len(assets)), ExpiresAt: time.Now().UTC().Add(2 * time.Minute)}
	for _, input := range assets {
		prep.Assets = append(prep.Assets, StudioVideoReferenceIntentAsset{AssetRef: input.AssetRef, Kind: input.Kind, MimeType: input.MimeType, SHA256: input.SHA256, Size: input.Size, DurationSeconds: input.DurationSeconds})
	}
	accounting, err := r.referenceAccounting(ctx, a, owner, resolved, time.Now().UTC())
	if err != nil {
		return empty, err
	}
	if accounting.SourceState != "resolved" {
		return empty, ErrStudioImageAccounting
	}
	prep.Accounting = accounting
	existing, readErr := r.Store.FindReferencePreparation(owner, offerID, intentHash, spec)
	if readErr == nil {
		if existing.AccountID != prep.AccountID || existing.PublishedRevision != prep.PublishedRevision || existing.AdapterRevision != prep.AdapterRevision || existing.EndpointFingerprint != prep.EndpointFingerprint || existing.CredentialFingerprint != prep.CredentialFingerprint || existing.ProxyFingerprint != prep.ProxyFingerprint || existing.SalePrice != prep.SalePrice {
			return empty, ErrStudioVideoConflict
		}
		currentCost, e := r.referenceAccounting(ctx, a, owner, resolved, existing.Accounting.PricingAt)
		if e != nil || currentCost != existing.Accounting {
			return empty, ErrStudioVideoConflict
		}
		prep = existing
		prepID = existing.ID
		if prep.Status == "ready" {
			return StudioVideoReferencePreparationResult{PreparationID: prep.ID, Receipts: prep.Receipts}, nil
		}
	} else if !os.IsNotExist(readErr) {
		return empty, readErr
	} else if err := r.Store.IssueReferencePreparation(prep); err != nil {
		return empty, err
	}
	if len(prep.Receipts) > len(assets) {
		return empty, ErrStudioVideoConflict
	}
	for i, input := range assets {
		content, err := validateStudioVideoReferenceInput(input)
		if err != nil {
			return empty, err
		}
		if i < len(prep.Receipts) {
			if err := validateStudioVideoReferenceReceipt(input, prep.Receipts[i]); err != nil {
				return empty, err
			}
			continue
		}
		receipt, err := uploader.Upload(ctx, a, owner, resolved.Offer, input, content)
		if err != nil {
			return empty, err
		}
		if err := validateStudioVideoReferenceReceipt(input, receipt); err != nil {
			return empty, err
		}
		prep.Receipts = append(prep.Receipts, receipt)
		if err := r.Store.UpdateReferencePreparation(prep); err != nil {
			return empty, err
		}
	}
	prep.Status = "ready"
	if err := r.Store.UpdateReferencePreparation(prep); err != nil {
		return empty, err
	}
	return StudioVideoReferencePreparationResult{PreparationID: prepID, Receipts: prep.Receipts}, nil
}

// SetReferenceUploader is retained for local simulators and protocol tests;
// normal runtime construction installs the Core-owned HTTP executor. The BFF
// never receives supplier credentials.
func (r *StudioVideoRuntime) SetReferenceUploader(u AccountBoundReferenceUploader) {
	if r != nil {
		r.ReferenceUploader = u
	}
}

func slicesContainsInt64(values []int64, want int64) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func (r *StudioVideoRuntime) referenceAccounting(ctx context.Context, a *Account, owner StudioImageOwner, resolved mediaworkbench.ResolvedVideoOffer, at time.Time) (AccountAccountingSnapshot, error) {
	var channel *Channel
	if r.Core.channelService != nil && r.Core.channelService.repo != nil {
		id, e := r.Core.channelService.repo.GetChannelIDByGroupID(ctx, owner.GroupID)
		if e != nil {
			return AccountAccountingSnapshot{}, e
		}
		if id > 0 {
			channel, e = r.Core.channelService.repo.GetByID(ctx, id)
			if e != nil {
				return AccountAccountingSnapshot{}, e
			}
		}
	}
	return resolveStudioAccountCost(a, mediaworkbench.ResolvedImageOffer{Offer: resolved.Offer, Spec: resolved.Spec, SpecHash: resolved.SpecHash}, channel, at, "CNY", false)
}

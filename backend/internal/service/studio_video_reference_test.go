package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
)

type localReferenceUploader struct {
	calls         int
	expectedModel string
	assetRefs     []string
}

func (u *localReferenceUploader) Upload(_ context.Context, account *Account, owner StudioImageOwner, offer mediaworkbench.Offer, input StudioVideoReferenceAsset, bytes []byte) (StudioVideoReferenceReceipt, error) {
	u.calls++
	model := u.expectedModel
	if model == "" {
		model = "3.0"
	}
	if account == nil || account.ID != 7 || owner.UserID != 1 || offer.SiteModel != model || len(bytes) != input.Size {
		return StudioVideoReferenceReceipt{}, ErrStudioVideoInvalidOrder
	}
	u.assetRefs = append(u.assetRefs, input.AssetRef)
	return StudioVideoReferenceReceipt{AssetRef: input.AssetRef, Kind: input.Kind, MimeType: input.MimeType, Size: input.Size,
		SHA256: input.SHA256, Source: "https://core.example/reference/" + input.AssetRef, UploadID: "upload-" + input.AssetRef}, nil
}

func TestPrepareReferenceAssetsVideoLimitsBeforeUpload(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		count, min, max, total int
		invalidOwner           bool
		invalidLastDigest      bool
		wantOK                 bool
	}{
		{name: "seventeen_ordered", count: 17, max: 30, total: 30, wantOK: true},
		{name: "thirty_ordered", count: 30, max: 30, total: 30, wantOK: true},
		{name: "above_video_ceiling", count: 31, max: 30, total: 30},
		{name: "above_published_kind_max", count: 17, max: 16, total: 30},
		{name: "above_published_total", count: 17, max: 30, total: 16},
		{name: "below_published_min", count: 1, min: 2, max: 30, total: 30},
		{name: "wrong_owner", count: 17, max: 30, total: 30, invalidOwner: true},
		{name: "invalid_last_asset", count: 30, max: 30, total: 30, invalidLastDigest: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, q, key, accounts, _ := videoRuntimeFixture(t)
			m, ok := videoplan.Lookup("3.5")
			require.True(t, ok)
			ma := studioCostMediaFixture(t, r.Media)
			ma.a.Config = nil
			ma.a.ModelMapping = map[string]string{m.ID: m.Upstream}
			ma.a.Catalog.Models = []string{m.Upstream}
			accounts.a.Credentials["model_mapping"] = map[string]any{m.ID: m.Upstream}
			product := mediaworkbench.Product{ProductID: "video-reference-limit", MediaType: "video", SiteModel: m.ID, UpstreamModel: m.Upstream, Enabled: true,
				Capabilities: mediaworkbench.Capabilities{Resolutions: []string{m.Resolutions[0]}, AspectRatios: []string{m.Ratios[0]}, DurationsSeconds: []int{m.Durations[0]}, Count: mediaworkbench.Range{Min: 1, Max: 1},
					References: mediaworkbench.References{Image: mediaworkbench.Range{Min: tc.min, Max: tc.max}, TotalMax: tc.total}},
				PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.80", Currency: "CNY", BillingMode: "per_request"}}}}
			svc := mediaworkbench.NewService(ma)
			d, err := svc.SaveDraft(t.Context(), 7, 0, mediaworkbench.DraftInput{Products: []mediaworkbench.Product{product}})
			require.NoError(t, err)
			require.True(t, d.Config.Validation.PublishReady, "%+v", d.Config.Validation.Diagnostics)
			d, err = svc.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
			require.NoError(t, err)
			_, err = svc.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
			require.NoError(t, err)
			offerID := ma.a.Config.Published.Offers[0].OfferID
			spec := mediaworkbench.Spec{Count: 1, Resolution: m.Resolutions[0], AspectRatio: m.Ratios[0], DurationSeconds: m.Durations[0], Images: tc.count}
			assets := make([]StudioVideoReferenceAsset, tc.count)
			refs := make([]string, tc.count)
			for i := range assets {
				content := []byte(fmt.Sprintf("synthetic-reference-content-%02d", i))
				refs[i] = fmt.Sprintf("asset-%02d", i)
				assets[i] = StudioVideoReferenceAsset{AssetRef: refs[i], Kind: "image", MimeType: "image/png", Size: len(content), SHA256: fmt.Sprintf("%x", sha256.Sum256(content)), BytesBase64: base64.StdEncoding.EncodeToString(content)}
			}
			owner := q.Binding.Owner
			if tc.invalidOwner {
				owner.UserID++
			}
			if tc.invalidLastDigest {
				assets[len(assets)-1].SHA256 = assets[0].SHA256
			}
			uploader := &localReferenceUploader{expectedModel: m.ID}
			r.SetReferenceUploader(uploader)
			prepared, err := r.PrepareReferenceAssets(t.Context(), owner, key, offerID, spec, assets)
			if !tc.wantOK {
				require.Error(t, err)
				require.Zero(t, uploader.calls, "reject the complete request before uploading any asset")
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.count, uploader.calls)
			require.Equal(t, refs, uploader.assetRefs)
			require.Len(t, prepared.Receipts, tc.count)
			stored, err := r.Store.ReferencePreparation(prepared.PreparationID, owner)
			require.NoError(t, err)
			require.Len(t, stored.Assets, tc.count)
			require.Equal(t, prepared.Receipts, stored.Receipts)
			for i, receipt := range prepared.Receipts {
				require.Equal(t, refs[i], receipt.AssetRef)
				require.Equal(t, assets[i].SHA256, receipt.SHA256)
				require.Equal(t, refs[i], stored.Assets[i].AssetRef)
			}
		})
	}
}

func TestPrepareReferenceAssetsResolvesPublishedAccountAndRejectsMissingUploader(t *testing.T) {
	r, _, q, key, _, _ := videoRuntimeFixture(t)
	q.Binding.Spec.Images = 1
	input := []byte("fixture-image-bytes")
	asset := StudioVideoReferenceAsset{AssetRef: "asset_fixture", Kind: "image", MimeType: "image/png", Size: len(input), SHA256: fmt.Sprintf("%x", sha256.Sum256(input)), BytesBase64: base64.StdEncoding.EncodeToString(input)}
	uploader := &localReferenceUploader{}
	r.SetReferenceUploader(uploader)
	prepared, err := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
	require.NoError(t, err)
	require.NotEmpty(t, prepared.PreparationID)
	require.Len(t, prepared.Receipts, 1)
	require.Equal(t, "https://core.example/reference/asset_fixture", prepared.Receipts[0].Source)
	require.Equal(t, 1, uploader.calls)
	_, err = r.PrepareReferenceAssets(context.Background(), StudioImageOwner{UserID: 2, APIKeyID: 2, GroupID: 3}, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
	require.Error(t, err)
}

func TestReferencePreparationConcurrentAndExpiredRecovery(t *testing.T) {
	r, _, q, key, _, _ := videoRuntimeFixture(t)
	q.Binding.Spec.Images = 1
	b := []byte("fixture-image-bytes")
	asset := StudioVideoReferenceAsset{AssetRef: "asset-concurrent", Kind: "image", MimeType: "image/png", Size: len(b), SHA256: fmt.Sprintf("%x", sha256.Sum256(b)), BytesBase64: base64.StdEncoding.EncodeToString(b)}
	u := &localReferenceUploader{}
	r.SetReferenceUploader(u)
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, e := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
			ids <- p.PreparationID
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	var id string
	for v := range ids {
		if id == "" {
			id = v
		}
		require.Equal(t, id, v)
	}
	require.Equal(t, 1, u.calls)
	p, e := r.Store.ReferencePreparation(id, q.Binding.Owner)
	require.NoError(t, e)
	p.ExpiresAt = time.Now().Add(-time.Hour)
	raw, _ := json.Marshal(p)
	require.NoError(t, os.WriteFile(r.Store.path("reference-preparation", id), raw, 0600))
	again, e := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
	require.NoError(t, e)
	require.Equal(t, id, again.PreparationID)
	require.Equal(t, 1, u.calls)
}

// Monetary-limit refusal is covered for total/daily/weekly limits by
// TestVideoRetailRejectsAllMonetaryAccountLimits, including upload=0.
func TestReferenceAllowsUnknownCostWithoutQuotaAndRejectsFalseCounts(t *testing.T) {
	for _, scenario := range []string{"unknown_cost_without_quota", "false_counts"} {
		t.Run(scenario, func(t *testing.T) {
			r, _, q, key, _, _ := videoRuntimeFixture(t)
			b := []byte("fixture-image-bytes")
			asset := StudioVideoReferenceAsset{AssetRef: "asset-invalid", Kind: "image", MimeType: "image/png", Size: len(b), SHA256: fmt.Sprintf("%x", sha256.Sum256(b)), BytesBase64: base64.StdEncoding.EncodeToString(b)}
			u := &localReferenceUploader{}
			r.SetReferenceUploader(u)
			if scenario == "unknown_cost_without_quota" {
				q.Binding.Spec.Images = 1
				studioCostMediaFixture(t, r.Media).a.Config.Published.Products[0].CostRules = nil
			}
			prepared, e := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
			if scenario == "unknown_cost_without_quota" {
				require.NoError(t, e)
				require.NotEmpty(t, prepared.PreparationID)
				require.Len(t, prepared.Receipts, 1)
				require.Equal(t, 1, u.calls)
			} else {
				require.Error(t, e)
				require.Zero(t, u.calls)
			}
		})
	}
}

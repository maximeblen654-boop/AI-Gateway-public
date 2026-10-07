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
	"github.com/stretchr/testify/require"
)

type localReferenceUploader struct{ calls int }

func (u *localReferenceUploader) Upload(_ context.Context, account *Account, owner StudioImageOwner, offer mediaworkbench.Offer, input StudioVideoReferenceAsset, bytes []byte) (StudioVideoReferenceReceipt, error) {
	u.calls++
	if account == nil || account.ID != 7 || owner.UserID != 1 || offer.SiteModel != "3.0" || len(bytes) != input.Size {
		return StudioVideoReferenceReceipt{}, ErrStudioVideoInvalidOrder
	}
	return StudioVideoReferenceReceipt{AssetRef: input.AssetRef, Kind: input.Kind, MimeType: input.MimeType, Size: input.Size,
		SHA256: input.SHA256, Source: "https://core.example/reference/" + input.AssetRef, UploadID: "upload-" + input.AssetRef}, nil
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

func TestReferenceRejectsUnknownCostAndFalseCountsBeforeUpload(t *testing.T) {
	for _, scenario := range []string{"cost", "counts"} {
		t.Run(scenario, func(t *testing.T) {
			r, _, q, key, _, _ := videoRuntimeFixture(t)
			b := []byte("fixture-image-bytes")
			asset := StudioVideoReferenceAsset{AssetRef: "asset-invalid", Kind: "image", MimeType: "image/png", Size: len(b), SHA256: fmt.Sprintf("%x", sha256.Sum256(b)), BytesBase64: base64.StdEncoding.EncodeToString(b)}
			u := &localReferenceUploader{}
			r.SetReferenceUploader(u)
			if scenario == "cost" {
				q.Binding.Spec.Images = 1
				r.Core.channelService = nil
			}
			_, e := r.PrepareReferenceAssets(context.Background(), q.Binding.Owner, key, q.Binding.Offer.OfferID, q.Binding.Spec, []StudioVideoReferenceAsset{asset})
			require.Error(t, e)
			require.Zero(t, u.calls)
		})
	}
}

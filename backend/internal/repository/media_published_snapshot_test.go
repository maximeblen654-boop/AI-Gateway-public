package repository

import (
	"context"
	"encoding/json"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
	"os"
	"regexp"
	"testing"
	"time"
)

// Optional credential-free offline evidence, never a production connection.
func TestAccount77SnapshotRecovery(t *testing.T) {
	path := os.Getenv("MEDIA_RECOVERY_SNAPSHOT")
	if path == "" {
		t.Skip("private offline snapshot not supplied")
	}
	b, e := os.ReadFile(path)
	require.NoError(t, e)
	var x map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(b, &x))
	var a mediaworkbench.Account
	require.NoError(t, json.Unmarshal(b, &a))
	require.EqualValues(t, 77, a.ID)
	require.NoError(t, json.Unmarshal(x["base_url"], &a.BaseURL))
	db, m, e := sqlmock.New()
	require.NoError(t, e)
	defer db.Close()
	m.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(a.ID).WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(a.ID, a.Name, a.Platform, a.Type, a.Status, a.Schedulable, a.BaseURL, []byte(x["model_catalog"]), []byte(x["media_workbench_v1"]), []byte(x["routing"])))
	account, e := NewMediaConfigRepository(db).Get(context.Background(), 77)
	require.NoError(t, e)
	require.NoError(t, m.ExpectationsWereMet())
	require.True(t, account.RuntimeReady)
	before, _ := json.Marshal(account.Config)
	old := account.Config.Published
	_, e = mediaworkbench.InspectPublishedOffers(context.Background(), account, "image")
	require.Error(t, e)
	started := time.Now()
	next, inspection, e := mediaworkbench.RevalidatePublishedCatalog(context.Background(), account, time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC))
	require.NoError(t, e)
	require.Equal(t, 1870, inspection.SpecCount)
	after, _ := json.Marshal(account.Config)
	require.Equal(t, string(before), string(after))
	require.Equal(t, old.Products, next.Products)
	require.Equal(t, old.Offers, next.Offers)
	account.Config.Published = next
	var quotes []any
	for _, n := range []int{1, 3, 10} {
		for _, refs := range []int{0, 1, 16} {
			r, e := mediaworkbench.ResolvePublishedImageOffer(account, next.Offers[0].OfferID, mediaworkbench.Spec{Resolution: "4K", AspectRatio: "16:9", Count: n, Images: refs})
			require.NoError(t, e)
			unit, total, e := mediaworkbench.PriceForQuantity(r.Offer.SalePrice, n)
			require.NoError(t, e)
			quotes = append(quotes, map[string]any{"count": n, "references": refs, "unit": unit, "total": total, "offer_id": r.Offer.OfferID})
		}
	}
	oldProducts, _ := json.Marshal(old.Products)
	oldOffers, _ := json.Marshal(old.Offers)
	newPublished, _ := json.Marshal(next)
	proof := map[string]any{"status": "PASS_OFFLINE_NATIVE_REVALIDATION", "production_written": false, "specs_checked": inspection.SpecCount, "elapsed_ms": time.Since(started).Milliseconds(), "draft_products": len(account.Config.Draft.Products), "draft_revision": account.Config.Draft.Revision, "draft_validation_status": account.Config.Validation.Status, "record_version": account.Config.RecordVersion, "original_config_sha256": recoverySHA(before), "published_products_sha256": recoverySHA(oldProducts), "offers_sha256": recoverySHA(oldOffers), "before_published_revision": old.Revision, "after_published_revision": next.Revision, "replacement_sha256": recoverySHA(newPublished), "before_dependencies": old.Dependencies, "after_dependencies": next.Dependencies, "products_offers_draft_validation_unchanged": true, "quotes": quotes}
	out, _ := json.MarshalIndent(proof, "", "  ")
	t.Log(string(out))
	if dest := os.Getenv("MEDIA_RECOVERY_REPORT"); dest != "" {
		require.NoError(t, os.WriteFile(dest, out, 0600))
	}
}

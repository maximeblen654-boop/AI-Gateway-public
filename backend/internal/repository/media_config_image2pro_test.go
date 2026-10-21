package repository

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/videoplan"
	"github.com/stretchr/testify/require"
)

func TestImage2ProMediaProjectionExposesOnlySafeCurrentCapabilities(t *testing.T) {
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, e)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	c, e := videoplan.DecodeImage2ProCapabilities(f.Metadata)
	require.NoError(t, e)
	db, mock, e := sqlmock.New()
	require.NoError(t, e)
	defer func() { _ = db.Close() }()
	proof := service.NewUpstreamImage2ProMetadataSource(&service.Account{ID: 7, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Credentials: map[string]any{"base_url": "https://api.image2pro.top/v1", "api_key": "fixture-key"}}, time.Now())
	snapshot := service.UpstreamModelMetadataSnapshot{Image2ProSource: proof, Models: map[string]service.UpstreamModelMetadata{
		f.Model:          {ID: f.Model, MediaType: "video", Image2ProVideo: c, Description: "private-do-not-project"},
		"not-in-catalog": {ID: "not-in-catalog", MediaType: "video", Image2ProVideo: c},
	}}
	routing, e := json.Marshal(map[string]any{"has_key": true, "media_metadata": snapshot, "image2pro_credential_sha256": proof.CredentialSHA256, "unexpected_secret": "never-project"})
	require.NoError(t, e)
	mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(int64(7)).WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(7, "supplier", "openai", "apikey", "active", true, "https://api.image2pro.top/v1", `{"models":["public-video-fixture"],"synced_at":"fixture"}`, nil, routing))
	a, e := NewMediaConfigRepository(db).Get(context.Background(), 7)
	require.NoError(t, e)
	require.Len(t, a.Image2ProVideoCapabilities, 1)
	require.Equal(t, "1080P", a.Image2ProVideoCapabilities[f.Model].Size)
	encoded, e := json.Marshal(a)
	require.NoError(t, e)
	require.NotContains(t, string(encoded), "private-do-not-project")
	require.NotContains(t, string(encoded), "never-project")
	require.NotContains(t, string(encoded), "not-in-catalog")
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestImage2ProMediaProjectionRequiresCurrentSourceProof(t *testing.T) {
	raw, e := os.ReadFile("../videoplan/testdata/image2pro_public_video.json")
	require.NoError(t, e)
	var f struct {
		Model    string
		Metadata json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &f))
	caps, e := videoplan.DecodeImage2ProCapabilities(f.Metadata)
	require.NoError(t, e)
	for _, scenario := range []string{"current", "base_changed", "key_changed", "account_changed", "foreign_source_same_model", "missing_source", "missing_current_fingerprint", "mismatched_model_id"} {
		t.Run(scenario, func(t *testing.T) {
			db, mock, e := sqlmock.New()
			require.NoError(t, e)
			defer func() { _ = db.Close() }()
			proof := service.NewUpstreamImage2ProMetadataSource(&service.Account{ID: 7, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Credentials: map[string]any{"base_url": "https://api.image2pro.top/v1", "api_key": "fixture-key"}}, time.Now())
			accountID, base, fingerprint, entryID := int64(7), "https://api.image2pro.top/v1", proof.CredentialSHA256, f.Model
			switch scenario {
			case "base_changed":
				base = "https://other.example/v1"
			case "key_changed":
				fingerprint = strings.Repeat("a", 64)
			case "account_changed":
				accountID = 8
			case "foreign_source_same_model":
				proof.Endpoint = "https://other.example/v1"
			case "missing_source":
				proof = nil
			case "missing_current_fingerprint":
				fingerprint = ""
			case "mismatched_model_id":
				entryID = "other-model"
			}
			snapshot := service.UpstreamModelMetadataSnapshot{Image2ProSource: proof, Models: map[string]service.UpstreamModelMetadata{f.Model: {ID: entryID, MediaType: "video", Image2ProVideo: caps}}}
			routing, e := json.Marshal(map[string]any{"has_key": true, "media_metadata": snapshot, "image2pro_credential_sha256": fingerprint})
			require.NoError(t, e)
			mock.ExpectQuery(regexp.QuoteMeta(mediaAccountProjection + `WHERE id=$1 AND deleted_at IS NULL`)).WithArgs(accountID).WillReturnRows(sqlmock.NewRows(mediaColumns).AddRow(accountID, "supplier", "openai", "apikey", "active", true, base, `{"models":["public-video-fixture"],"synced_at":"fixture"}`, nil, routing))
			a, e := NewMediaConfigRepository(db).Get(t.Context(), accountID)
			require.NoError(t, e)
			if scenario == "current" {
				require.Len(t, a.Image2ProVideoCapabilities, 1)
			} else {
				require.Empty(t, a.Image2ProVideoCapabilities, "same model ID cannot legitimize stale metadata provenance")
			}
			encoded, e := json.Marshal(a)
			require.NoError(t, e)
			require.NotContains(t, string(encoded), "credential_sha256")
			require.NotContains(t, string(encoded), "fixture-key")
			require.NoError(t, mock.ExpectationsWereMet())
		})
	}
}

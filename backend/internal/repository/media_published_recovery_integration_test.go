//go:build integration

package repository

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/mediaworkbench"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestAccount77PublishedRecoveryPostgres(t *testing.T) {
	ctx := context.Background()
	conn, e := integrationDB.Conn(ctx)
	require.NoError(t, e)
	defer func() { _ = conn.Close() }()
	// Session-local disposable table, independent of all other fixtures and IDs.
	_, e = conn.ExecContext(ctx, `CREATE TEMP TABLE accounts AS SELECT * FROM public.accounts WITH NO DATA`)
	require.NoError(t, e)
	defer func() { _, _ = conn.ExecContext(ctx, `DROP TABLE pg_temp.accounts`) }()
	cfg := &mediaworkbench.Config{SchemaVersion: 1, RecordVersion: 32, MediaTypes: []string{"image"}, AdapterBindings: map[string]mediaworkbench.AdapterBinding{}, Sales: mediaworkbench.Sales{Enabled: true}}
	desc, _ := mediaworkbench.Descriptor("openai_images")
	cfg.AdapterBindings["image"] = mediaworkbench.AdapterBinding{Kind: desc.Kind, Revision: desc.Revision, Auth: desc.Auth, TaskFlow: desc.TaskFlow}
	cat := &mediaworkbench.Catalog{Source: "upstream", SyncedAt: "2026-10-13T00:00:00Z", Models: []string{"gpt-image-2"}}
	body, _ := json.Marshal(map[string]any{mediaworkbench.ExtraKey: cfg, mediaworkbench.CatalogKey: cat})
	_, e = conn.ExecContext(ctx, `INSERT INTO accounts(id,name,platform,type,status,schedulable,credentials,extra) VALUES(77,'Synthetic recovery','openai','apikey','active',true,'{"base_url":"https://synthetic.example/v1","api_key":"synthetic-only"}',$1::jsonb)`, string(body))
	require.NoError(t, e)
	rows, e := conn.QueryContext(ctx, mediaAccountProjection+`WHERE id=77`)
	require.NoError(t, e)
	require.True(t, rows.Next())
	a, e := scanMediaAccount(rows)
	require.NoError(t, e)
	require.NoError(t, rows.Close())
	p := mediaworkbench.Product{ProductID: "gpt-original", MediaType: "image", SiteModel: "gpt-image-2", UpstreamModel: "gpt-image-2", Enabled: true, Capabilities: mediaworkbench.Capabilities{Resolutions: []string{"4K"}, AspectRatios: []string{"1:1", "16:9", "4:5", "5:4", "21:9", "3:4", "4:3", "2:3", "3:2", "9:16", "9:21"}, Count: mediaworkbench.Range{Min: 1, Max: 10}, References: mediaworkbench.References{Image: mediaworkbench.Range{Min: 0, Max: 16}, TotalMax: 16}}, PricingRules: []mediaworkbench.PricingRule{{SalePrice: &mediaworkbench.Price{Amount: "0.025", Currency: "CNY", BillingMode: "per_request"}}}}
	oldDraft := mediaworkbench.Draft{Revision: "original-draft", Products: []mediaworkbench.Product{p}}
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	v, offers := mediaworkbench.Validate(a, oldDraft, now)
	require.True(t, v.PublishReady, "%+v", v.Diagnostics)
	require.Equal(t, 1870, v.CaseCount)
	pub := &mediaworkbench.Published{SourceDraftRevision: oldDraft.Revision, Products: oldDraft.Products, Offers: offers, Dependencies: v.Dependencies, PublishedAt: now}
	legacy, _ := json.Marshal(struct {
		Source       string
		Products     []mediaworkbench.Product
		Offers       []mediaworkbench.Offer
		Dependencies mediaworkbench.Dependencies
	}{pub.SourceDraftRevision, pub.Products, pub.Offers, pub.Dependencies})
	pub.Revision = "mwp_" + recoverySHA(legacy)
	cfg.Published = pub
	banana := p
	banana.ProductID = "banana-draft"
	banana.SiteModel = "Nano-banana-2.1"
	banana.UpstreamModel = banana.SiteModel
	cfg.Draft = mediaworkbench.Draft{Revision: "current-two-drafts", Products: []mediaworkbench.Product{p, banana}, UpdatedAt: now}
	a.Catalog.Models = append(a.Catalog.Models, banana.UpstreamModel)
	a.Catalog.SyncedAt = now.Format(time.RFC3339)
	a.Config = cfg
	cfg.Validation, _ = mediaworkbench.Validate(a, cfg.Draft, now)
	require.True(t, cfg.Validation.PublishReady)
	body, _ = json.Marshal(map[string]any{mediaworkbench.ExtraKey: cfg, mediaworkbench.CatalogKey: a.Catalog, "unrelated": "preserve"})
	_, e = conn.ExecContext(ctx, `UPDATE accounts SET extra=$1::jsonb WHERE id=77`, string(body))
	require.NoError(t, e)
	read := func() string {
		var s string
		require.NoError(t, conn.QueryRowContext(ctx, `SELECT to_jsonb(a)::text FROM accounts a WHERE id=77`).Scan(&s))
		return s
	}
	before := read()
	plan, e := RecoverAccount77Published(ctx, conn, now, nil, nil)
	require.NoError(t, e)
	require.Equal(t, 1870, plan.Specs)
	require.Equal(t, before, read())
	_, e = RecoverAccount77Published(ctx, conn, now, plan, func([]byte) error { return errors.New("backup unavailable") })
	require.Error(t, e)
	require.Equal(t, before, read())
	stale := *plan
	stale.AccountSHA = "changed"
	_, e = RecoverAccount77Published(ctx, conn, now, &stale, func([]byte) error { t.Fatal("stale backup called"); return nil })
	require.ErrorIs(t, e, mediaworkbench.ErrStale)
	require.Equal(t, before, read())
	var backup []byte
	applied, e := RecoverAccount77Published(ctx, conn, now, plan, func(b []byte) error { backup = append([]byte(nil), b...); return nil })
	require.NoError(t, e)
	require.True(t, applied.Applied)
	require.NotEmpty(t, backup)
	var current mediaworkbench.Config
	var raw []byte
	require.NoError(t, conn.QueryRowContext(ctx, `SELECT extra->'media_workbench_v1' FROM accounts WHERE id=77`).Scan(&raw))
	require.NoError(t, json.Unmarshal(raw, &current))
	require.Equal(t, cfg.Draft, current.Draft)
	require.Equal(t, cfg.Validation, current.Validation)
	require.Equal(t, cfg.Sales, current.Sales)
	require.Equal(t, pub.Products, current.Published.Products)
	require.Equal(t, pub.Offers, current.Published.Offers)
	require.EqualValues(t, 33, current.RecordVersion)
	var oldRow, newRow map[string]any
	require.NoError(t, json.Unmarshal([]byte(before), &oldRow))
	require.NoError(t, json.Unmarshal([]byte(read()), &newRow))
	delete(oldRow["extra"].(map[string]any), mediaworkbench.ExtraKey)
	delete(newRow["extra"].(map[string]any), mediaworkbench.ExtraKey)
	require.Equal(t, oldRow, newRow)
	final := read()
	_, e = RecoverAccount77Published(ctx, conn, now, plan, func([]byte) error { t.Fatal("repeated apply backup"); return nil })
	require.ErrorIs(t, e, mediaworkbench.ErrStale)
	require.Equal(t, final, read())
	t.Log("Account77: dry run zero writes; backup failure rollback; stale apply rejected; original-only atomic recovery; draft/validation/sales/catalog/other fields unchanged; repeat apply rejected")
}

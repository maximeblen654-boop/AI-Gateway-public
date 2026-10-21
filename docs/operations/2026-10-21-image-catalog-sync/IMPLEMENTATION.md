# Image model catalog freshness and delivery closeout

Accepted base: `02a44ec62c335bb5787ea3c20db57adbadda039d`, branch `codex/media-paid-controls`.

## Confirmed failure

Account77 used its 2026-10-15 successful model snapshot, still listing `gpt-image-2`. The live free `/v1/models` observation on 2026-10-21 no longer listed that ID. The original user request received HTTP404 with a model-renamed message and finalized failed/not_charged. An empty supplier-console generation list does not establish that no HTTP request reached the provider.

## Implementation

- Refresh the current Image2Pro model-ID list every five minutes, including newly initialized media Accounts with no products. Reuse the native validated model-list HTTP client. No metered probes, new scheduler or capability database.
- Bind successful observations to Account identity; compare credentials, provider type/platform, proxy ID and prior catalog in the same SQL UPDATE. Manual sync uses the same write guard. Singleflight merges same-Account observation; failures retain the last success and back off one minute. No API routing/model mapping, Draft, Published, price or sales edits.
- Before new quotes and dispatch, require current evidence and reload the actual published model/spec. Status snapshots check evidence locally without sending HTTP; failed refreshes cannot grant approval. Historical recovery uses its original frozen identity and never resubmits.
- New IDs appear automatically as unconfigured/unpublished choices. Removed IDs cannot become new candidates, including archived/unlisted or historical-product create paths. Existing records remain for audit and recovery; no old-name alias or automatic replacement/republication is introduced.
- HTTP402/405/413/415 are documented request rejections, now finalized without customer charge. In a five-image execution, four successful images plus one rejected unit are delivered as partial and charged only for four, once. Transport ambiguity, HTTP409 and existing server-error handling are unchanged.

## Compatibility and deployment

No schema migration or dependencies changed. The added catalog observation field is optional JSON; it is not a price or generation contract. The existing modern per-product dependency scope ignores unrelated model additions and observation timestamp changes. Legacy snapshots retain their existing strict validation and are not silently rewritten.

The old sole published image model is currently removed upstream. Refreshing must therefore exclude it; new IDs do not inherit prices or managed admission. Read requested/effective separately and do not Apply new grants to manufacture true/true. Video remains closed. Account sales and customer prices are preserved. Users configure and publish current models through the existing admin workflow, without chatting model names to an agent.

Application rollback may restore only owned component configuration after verifying the current data contracts. Never restore an old database, erase receipts, rewrite frozen tasks, or restore the stale model list to regain availability. Deployment uses the existing protected checkpoint, isolated restoration, release lock, maintenance CAS and exact candidate identity chain.

## Validation and review

Raw evidence is maintained in the independent local D-drive review directory for this round. Includes eight before-fix failing rejection fixtures, after-fix once-only partial-delivery tests, freshness/CAS/stop/timeout/isolation tests, desktop/mobile browser captures and independent review. Production supplier generation is outside this acceptance scope.

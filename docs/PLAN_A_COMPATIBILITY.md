# Plan A: legacy and Published Studio compatibility

Status: **BLOCKED_FOR_RELEASE**. This is a local compatibility change, not a deployment record.

The candidate preserves one Core and keeps the legacy BFF/Bridge as the owners of legacy tasks. Published media uses its own BFF/Bridge, route namespace and private state roots. No migration, historical price rewrite or production configuration change is included.

## Contracts

| Public path | Owner / upstream path |
| --- | --- |
| `/api/v1/auth/studio-ticket` | Existing legacy Bridge, unchanged |
| `/studio/api/auth/session`, legacy logout | Existing legacy BFF, unchanged |
| `/studio/api/image/*`, `/studio/api/video/*` | Existing legacy BFF, unchanged |
| `/studio/*.html` and legacy static assets | Existing legacy BFF static whitelist; strip only `/studio` |
| `/api/v1/auth/studio-media-ticket` | New Bridge; rewrite only this endpoint to `/api/v1/auth/studio-ticket` |
| `/studio-v2/api/session*`, `/image/*`, `/video/*`, `/assets/*` | New BFF; keep the full `/studio-v2/api/` prefix |

The new cookie is `studio_media_session; Path=/studio-v2`. The old `studio_session; Path=/studio` is unchanged. Unknown new prefixes do not fall back to legacy handlers. Website logout and session revocation invalidate both generations through the existing shared identity and Redis epoch contract; each BFF's local logout clears only its own cookie.

Core selectively restores the authenticated legacy ticket consumer/verifier, image receipt query, exact legacy model aliases, admission price cap and frozen native billing inputs. `image_reference_price` remains an optional existing Group JSON field; null, zero and a positive value survive form/API round trips. Receipt GET can recover an owned result after new-request quota is exhausted, while user/key status and owner checks remain required.

Only a newly created durable async receipt claim may send the first generation POST. Recovery of an ambiguous record without an upstream ID returns unknown and never POSTs again, including old records with zero attempts. Known IDs use the original query path. Permanent synchronous dispatch markers, original account/credential/request identity, stored bytes and native billing idempotency remain in force. The receipt worker is opt-in and has explicit application startup/shutdown ownership.

Published media keeps its existing outbound parameter validation and relay policy: valid complete media is delivered unchanged and settled once; output geometry is not compared with requested geometry as a billing gate.

## Local evidence and reproduction

Local toolchain: Go 1.27.0, Node 24.16.0, pnpm 9.15.9. The declared CI/production Node target remains 24.21.0. No dependency versions changed. Existing identical package/lockfile dependencies were reused; no frozen-install result is claimed for this change.

| Check | Local result / boundary |
| --- | --- |
| Go handler/service focused regression | PASS: real JWT validation, legacy/new ticket purpose, one-use consumption, bearer and refresh-only logout, revoke-all, receipt claim/recovery/settlement |
| Go middleware/routes/imageplan/studiobridge affected tests | PASS: quota-read exemption, authentication boundaries, request parsing and existing Bridge contracts |
| Node HTTP/session/route/root tests | PASS: independent cookies, logout, revocation, CSRF, wrong prefixes, separate roots |
| Node image binding/asset/video/legacy recovery tests | PASS: authenticated original-byte download, owner rejection, persisted URL projection after restart, frozen requests and receipt versions |
| Frontend targeted Vitest | PASS: 28 tests across Group pricing, Studio panel/API and locale completeness |
| Frontend typecheck, build, ESLint | PASS; typecheck required a 3072 MiB heap after the smaller heap ran out of memory |
| Full new/old container browser E2E | NOT_RUN in this round; local HTTP tests use synthetic identity authorities, and do not substitute for that deployment gate |
| Core/BFF candidate images | NOT_BUILT: insufficient local disk headroom; existing containers/images were not replaced |

Representative Go commands (from `backend`, serial execution on constrained hosts):

```sh
go test -p 1 -tags unit ./internal/handler ./internal/service \
  -run 'Test(StudioLegacy|ImageReceipt|Image2Pro|LegacyGroupImageReference|StudioImage|VideoRuntime|AuthServiceBindEmailIdentity_RevokesExistingAccessAndRefreshTokens)' -count=1
go test -p 1 -tags unit ./internal/server/middleware ./internal/server/routes ./internal/imageplan ./internal/studiobridge \
  -run 'Test(Studio|Legacy|APIKeyAuth|SimpleMode|RequireGroup|Parse|Compile|.*Plan|.*Image|.*Video)' -count=1
```

Affected BFF tests (from the repository root):

```sh
node --test studio/bff/plan-a-isolation.test.mjs studio/bff/asset-intake.test.mjs studio/bff/image-binding.test.mjs studio/bff/legacy-runtime.test.mjs studio/api/video-plan.test.mjs studio/bff/video-account.test.mjs studio/bff/video-handler.test.mjs studio/bff/video-result-spec.test.mjs
```

Measured synthetic receipt scenarios are separate, not a pooled production total:

| Scenario | Generation POST | Billing |
| --- | --- | --- |
| Accepted async receipt, queried after service reconstruction | 1 | 1 native debit |
| Lost initial response followed by repeated recovery/reconstruction | 1 total; no recovery POST | 0 debits |
| Historical no-ID intent with zero recorded attempts | 0 recovery POST | No new charge |
| Crash after native money commit, then recover saved bytes | 1 total | 1 total debit |
| Frozen reference price, repeated result reads | No additional POST | Original price once |

These are local synthetic tests. Fresh-SHA CI and Security results must be read independently; the parent candidate's green checks do not prove this change.

## Runtime and rollback gates

Use [the runtime guide](../deploy/studio/README.md) and [review-only proxy fragment](../deploy/studio/Caddy.routes.example). The fragment is not an instruction to replace a live site configuration.

Before deployment approval, verify current component hashes, exact proxy ordering/Host behavior, JWT/Redis identity compatibility, mounted roots and UID permissions, receipt worker ownership and migration identities. Preserve the legacy Bridge: its startup can execute bundled SQL. Do not start two Core writers or let either BFF consume the other generation's journals.

New state roots must be independent and owned by the new runtime user. Legacy root ownership and contents remain unchanged. Filesystem separation checks supplement, and do not replace, verification of actual container mounts and permissions.

Rollback first closes new intents while retaining read/recovery paths and all data. Keep a specifically identified compatible Core/BFF recovery executor: an arbitrary historical Core may replay ambiguous old receipts or fail to understand new bindings. Do not route new task IDs to the legacy BFF, replay unknown work, or roll back the whole database over newer orders. Candidate and rollback artifact-level cross-version validation is still required.

Runtime deployment, sales Publish and real paid supplier activation require separate authorization. None occurred in this change.

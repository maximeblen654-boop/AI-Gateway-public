# Studio runtime artifacts and compatibility

These are optional components for the existing Core application. They do not
deploy automatically, initialize a database, create accounts, publish products,
or enable supplier actions. Keep the previous component artifacts and private
state until the approved release and rollback window has ended.

## Build and identify

Use the repository root as the Docker context and the exact reviewed commit.
The existing `.dockerignore` excludes local credentials, `.evidence`, database
directories and private configuration. Do not include another checkout's files.

```sh
docker build --target studio-bridge --build-arg COMMIT="$SOURCE_REVISION" -t studio-bridge:candidate .
docker build -f deploy/studio/Dockerfile --build-arg SOURCE_REVISION="$SOURCE_REVISION" -t studio-bff:candidate .
```

The Bridge target reuses the main Dockerfile's Go inputs and cache. The BFF uses
Node **24.21.0**, the pinned Node base digest, and Alpine's ffmpeg/ffprobe package;
it needs no npm installation. Bind the resulting immutable image IDs, runtime
versions, `/app/studio-bridge` hash and BFF input manifest in the private release
record. An old Core image is not an updated Bridge or BFF artifact.

## Configuration and connections

The BFF must receive its own environment file, never the complete Core env:

| Component | Required configuration |
| --- | --- |
| Core | Existing configuration and persistent `/app/data`; independent `STUDIO_IMAGE_PUBLISHED_SUBMISSION` defaults off |
| Bridge | Same native JWT configuration, test/production-specific PostgreSQL and Redis identity as its Core; `STUDIO_BRIDGE_SERVICE_TOKEN`, `STUDIO_IMAGE_GROUP_ID`, `STUDIO_IMAGE_CORE_URL` |
| Optional video Bridge | `STUDIO_VIDEO_GROUP_ID`; independent `STUDIO_VIDEO_ACCOUNT_SUBMISSION` and `STUDIO_LEGACY_VIDEO_RECOVERY` gates |
| BFF | `STUDIO_PUBLIC_ORIGIN`, `STUDIO_BRIDGE_URL`, `STUDIO_BRIDGE_SERVICE_TOKEN`; absolute private `STUDIO_ASSET_ROOT`, `STUDIO_IMAGE_DATA_ROOT`, `STUDIO_VIDEO_DATA_ROOT` |
| BFF listener | `STUDIO_IMAGE_BFF_HOST` defaults `127.0.0.1`, `STUDIO_IMAGE_BFF_PORT` defaults `8092` (packaged image uses `4173`) |
| BFF actions | `STUDIO_IMAGE_PUBLISHED_SUBMISSION`, `STUDIO_VIDEO_ACCOUNT_SUBMISSION`; each enabled only by literal `true` on the server |
| Plan A ownership | New BFF and Bridge: `STUDIO_LEGACY_VIDEO_RECOVERY=false`; do not mount legacy task/result roots |

Supply secrets privately through the existing runtime configuration mechanism.
Legacy credentials and slot recovery remain with the retained old BFF/Bridge.
New supplier credentials stay in Core. Neither browser data nor
an environment variable on a different component overrides a closed gate.
Readiness requires BFF, Bridge and Core permission. Quotes and image preparation
do not submit images. Unknown submission outcomes recover by GET only.

For the **new** Bridge/BFF, `STUDIO_IMAGE_CORE_URL` and `STUDIO_BRIDGE_URL` are
**root origins**, not an `/images/generations` endpoint. The old Bridge uses its
original full image endpoint; never copy the new value over that setting. The
old BFF's Core origin also serves administrator price APIs and stays pointed at
the single Core, not at either Bridge. Existing validation requires HTTPS or loopback
HTTP. In separate network namespaces use a privately managed HTTPS endpoint
and normal certificate trust. No insecure DNS-network exception is added.

`deploy/docker-compose.studio.yml` is an optional Linux Compose overlay for a
Core service named `sub2api`, with Core on port 8080. Bridge and BFF share that
service's loopback and receive separately scoped env files. Only host loopback
8094/4174 is added (container listeners remain 8091/4173); old listener bindings
remain reserved. This overlay defines only the new components. Set
`STUDIO_CORE_IMAGE`, `STUDIO_BRIDGE_IMAGE` and `STUDIO_BFF_IMAGE` to the verified
immutable image IDs or registry digests. The overlay refuses an omitted Core
identity rather than inheriting a mutable tag from the base Compose file.
It adds no proxy, database or second Core. Independent
HTTPS-connected containers or host services can use the same artifacts without
the overlay. Check the merged Compose configuration privately before use; do
not print its resolved secrets. A Core replacement in the shared topology also
requires an independently approved replacement of its dependent network-namespace users. A container restart
must run Core first, wait for health, then restart Bridge/BFF and any local
simulator sharing its namespace. Restarting those dependents before Core can
leave them attached to the old namespace even when container names match.

Startup order: existing PostgreSQL/Redis → Core health → Bridge health and real
native user lookup/ticket → BFF `/health` → authenticated ticket exchange,
session and catalog. `/health` reports process identity only; it does not certify
authentication, Published configuration, old recovery or supplier readiness.

## Private state and existing root-owned directories

The packaged BFF runs as UID/GID **1000:1000**, Bridge as **65532:65532**, with a
read-only root filesystem and no Linux capabilities. Media tools use a bounded
temporary directory; persisted data belongs only in the configured mounts.

The entrypoint refuses root execution, missing roots, symlink roots, overlapping
stores, a different root owner, or group/world-accessible state. It does not
change ownership or permissions and does not manufacture an empty legacy root.
Existing root:root/0700 data consequently fails closed under UID1000.

Inventory precise mounts, owners and modes before an approved runtime change.
Keep old root:root/0700 roots with their old executors. Provision distinct new
roots for UID1000, directories 0700 and private file modes, only under separately
approved production permission work. The new BFF rejects overlapping roots and
legacy recovery injection. Do not chmod777, change a common parent, or transfer
old roots to make the new BFF their writer. Preserve hidden receipt/claim sidecars.

The legacy operation root and `video-results` remain together under the old BFF.
New Account journals, image journals/results and private assets use distinct
roots. Old slot/USD records never become Account/CNY records. The optional
legacy reader module is retained for rollback compatibility tests, but the new
Plan A server does not activate it or expose its legacy route aliases.

The retained old Bridge continues its original new-order and recovery contracts.
Its historical startup may execute bundled SQL: do not replace or restart it as
part of the new BFF setup. The new Bridge's optional legacy facade remains off.
The existing `studio_video_orders` table is preserved; this change installs no
migration. Pending/not-found receipts never authorize another generation POST.
Existing terminal settlements are read before recovery and are not charged again.

Rollback retains both generations of data and their corresponding recovery
components. Disable new intents first; do not overwrite new orders, bindings,
preparations or balances with an old database. Runtime rollout, sales Publish,
and permission to perform real supplier actions remain separate decisions.

## Plan A routes, session and rollback conditions

The ordinary website and native authentication use **one writable Core**. Restore
legacy consumers at `/api/v1/internal/studio/tickets/consume` and
`/api/v1/internal/studio/sessions/verify` with the old Bridge service secret.
The retained old Bridge keeps that legacy secret; the new Core, Bridge and BFF
use their one matching private service token. No service token is exposed to a
browser or reused as a customer credential.
The two ticket purposes are not interchangeable. Website logout, revoke-all and
session-binding revocation update the shared native Studio epoch keys; both
generations verify those facts on every authenticated request. Local BFF logout
clears only that generation's cookie.

| Public route | Executor | Rewrite |
| --- | --- | --- |
| `/studio/*.html`, static files (GET/HEAD, old whitelist) | Retained old BFF | Remove `/studio` for static paths only |
| `/studio/api/auth/session`, old logout, `/studio/api/image/*`, `/studio/api/video/*`, old `/studio/api/operations/*` | Retained old BFF | None |
| `/api/v1/auth/studio-ticket` | Retained old Bridge | None |
| `/api/v1/auth/studio-media-ticket` | New Bridge | Exact path to `/api/v1/auth/studio-ticket` |
| `/studio-v2/api/session*`, `/studio-v2/api/image/*`, `/studio-v2/api/video/*`, `/studio-v2/api/assets/*` | New BFF | None |
| Website login/logout/current-user/admin price APIs | Single Core | Existing website routes |

Use exact path/prefix matching, never a catch-all `startsWith('/studio')`.
Old cookie: `studio_session; Path=/studio`. New cookie:
`studio_media_session; Path=/studio-v2`. Both remain HttpOnly, SameSite=Strict,
Secure on HTTPS. Mutations require the original Origin and X-Studio-Request
contract. Upload, preview and download stay under the corresponding cookie path.
See `Caddy.routes.example` for a review-only routing fragment, not a production
configuration or permission to replace the current proxy.

For an approved runtime change, bind the single immutable Core image, both
Bridge/BFF executors, exact mounts and the existing receipt roots. Retain native
request IDs, original bytes, claims and billing fingerprints; preserve the
frozen price and owner/Group checks. A missing upstream receipt remains an
unknown result and is never converted into a replacement POST.

Start or replace only the single Core writer, wait for health, then start the
dependent Bridge/BFF with submission gates closed. Verify authentication,
catalog, routes and downloads before switching the new proxy prefixes. Keep
existing containers and data available for rollback; if a route, owner, hash or
ledger check fails, stop new admission and revert that component. Runtime
changes do not authorize sales Publish or paid dispatch.

## Customer task confirmation and results

The ordinary customer `/video-studio` page directly renders the Published media panel.
It obtains the current website user's Studio session, loads server-owned task
history and displays the frozen quote amount/currency before an explicit Generate
click. Image confirmation sends the stored `task_id`; video sends `operation_id`.
Both paths resolve the original private binding on the server. The old image
customer form and Grok-specific controls are no longer a customer entry; retained
backend recovery routes continue to use server-owned identity and price data.

Unsubmitted quotations can be read after restart without querying a nonexistent
Core generation task. Quote expiry blocks a first submission, while claimed
tasks retain their original recovery identity. Refresh, relogin, polling and
unknown outcomes only query that identity. A lost response is shown as pending
confirmation, with no automatic quotation, generation retry or supplier switch.
Website identity changes invalidate pending Studio requests before another
business call is sent.

Successful images use the authenticated task `results/{index}` endpoint; videos
use the operation `original` endpoint. Preview and download share these private
URLs. Supplier credentials and result-source URLs are not exposed. An unavailable
catalog or closed submission gate does not by itself hide existing server task
records. See the local browser harness in `tools/phase5-media-e2e/README.md` for
separate browser, supplier-counter and native-ledger acceptance requirements.

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
| Legacy recovery only | `STUDIO_LEGACY_VIDEO_RECOVERY=true`, existing `STUDIO_OPERATION_ROOT`, original `STUDIO_VIDEO_BASE_URL`, `STUDIO_VIDEO_KEY_SLOT_ID`, `STUDIO_VIDEO_API_KEY` |

Supply secrets privately through the existing runtime configuration mechanism.
The legacy API key is the original slot credential; it is never used for new
Account tasks. New supplier credentials stay in Core. Neither browser data nor
an environment variable on a different component overrides a closed gate.
Readiness requires BFF, Bridge and Core permission. Quotes and image preparation
do not submit images. Unknown submission outcomes recover by GET only.

`STUDIO_IMAGE_CORE_URL` and `STUDIO_BRIDGE_URL` are **root origins**, not an
`/images/generations` endpoint. Existing validation requires HTTPS or loopback
HTTP. In separate network namespaces use a privately managed HTTPS endpoint
and normal certificate trust. No insecure DNS-network exception is added.

`deploy/docker-compose.studio.yml` is an optional Linux Compose overlay for a
Core service named `sub2api`, with Core on port 8080. Bridge and BFF share that
service's loopback and receive separately scoped env files. Only host loopback
8091/4173 is published. It adds no proxy, database or second Core. Independent
HTTPS-connected containers or host services can use the same artifacts without
the overlay. Check the merged Compose configuration privately before use; do
not print its resolved secrets. A Core replacement in the shared topology also
requires recreating its dependent network-namespace users. A container restart
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

Before a separately approved migration, inventory the precise mounted roots and
record owner/mode metadata. Preserve all files, including hidden receipt and
cancellation sidecars. A controlled owner transfer of only those approved roots
and their regular contents to UID1000 (directories 0700, files retaining private
modes) is required if they are root-owned. Reject symlinks, unexpected mounts and
concurrent writers first. Do not chmod777, recursively change a parent data
directory, or run the service as root to bypass this prerequisite. A production
owner transfer is a separate production change; local permission tests are not
authorization to execute it there. Keep the metadata needed for a scoped rollback.

The legacy operation root and `video-results` remain together. New Account
journals, image journals/results and private assets use distinct roots. The BFF
looks up old tasks by authenticated owner, rejects collisions between roots and
never converts slot/USD records to Account/CNY. Existing legacy original paths
under `/studio/api/operations/{id}/children/{index}/original` are retained.

Bridge legacy routes expose only original order GET, terminal evidence,
capture/release with the existing ledger semantics. The existing
`studio_video_orders` table is a prerequisite: startup checks its columns and
does not install a migration. No legacy quote, hold, upload or submission is
exposed. Original supplier recovery uses the original key slot and receipt key,
with only GET/HEAD requests. Pending/not-found receipts remain unresolved; they
never authorize another POST. Existing terminal settlements are read before
reconciliation and are not repeatedly posted.

Rollback retains both generations of data and their corresponding recovery
components. Disable new intents first; do not overwrite new orders, bindings,
preparations or balances with an old database. Runtime rollout, sales Publish,
and permission to perform real supplier actions remain separate decisions.

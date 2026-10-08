# Local media tests

This directory retains synthetic protocol fixtures and regression tests for the media BFF. Prior execution reports, images, private environment state and artifact identities are not part of the public source distribution.

## Self-contained contract tests

From the repository root, using the Node version pinned in CI:

```sh
node --test tools/phase5-media-e2e/default-contract.test.mjs
node --import ./tools/phase5-media-e2e/register-contract.mjs --test tools/phase5-media-e2e/restoration.test.mjs
```

`contract-fixture.mjs` and `register-contract.mjs` provide an explicit synthetic model for the restoration test. The production contract remains unchanged. These tests use temporary local storage and fake supplier receipts.

## Optional browser and package checks

The current Published frontend/BFF uses `/studio-v2/api/*` and the independent
`studio_media_session; Path=/studio-v2` cookie. Its public ticket endpoint is
`/api/v1/auth/studio-media-ticket`; `dev-proxy.mjs` rewrites only that exact path
to the new Bridge's `/api/v1/auth/studio-ticket`. Optional
`PHASE5_LEGACY_BFF_PORT` and `PHASE5_LEGACY_BRIDGE_PORT` route `/studio/*` and
the old ticket endpoint to independently provisioned legacy services. If absent,
those legacy routes fail closed; they never fall through to the new BFF/Core.
Keep old and new state directories separate. The starter disables legacy recovery
in the new BFF; retained old services remain the sole writers for their tasks.

The browser harnesses exercise a separately provisioned, isolated local Core/Bridge/BFF environment. They are not invoked by ordinary build or CI jobs. Provision new test identities and synthetic media for each environment; never obtain fixtures or credentials from another checkout. Local output directories must remain ignored. The harness setup must validate the intended local service identity before changing test state.

The optional full browser harness currently targets Windows, system Chrome, and the local Docker Desktop `desktop-linux` context. It requires the following independently provisioned test services, using this checkout's source:

| Service | Required local identity/address |
| --- | --- |
| Core, PostgreSQL, Redis | Compose project `phase5`; containers `sub2api-dev`, `sub2api-postgres-dev`, `sub2api-redis-dev`; Core at `127.0.0.1:18080` |
| Bridge | Build `backend/cmd/studio-bridge`; container `phase5-studio-bridge`, command `/app/studio-bridge`; use the test database/Redis and the same JWT/service authentication configuration as Core |
| Bridge host entry | `phase5-bridge-proxy`, published only at `127.0.0.1:18082`; the current loopback fixture shares Core's network namespace |
| Simulator | `simulator.mjs` in `phase5-sim-core`; local HTTPS port 19090 and loopback statistics port 19091; use locally generated test certificates with explicit trust, never disable TLS checks |
| BFF and browser entry | Starter owns `127.0.0.1:8093` and `127.0.0.1:3000`; development Vue uses port 3001, or `--embedded` uses the selected Core image's frontend |

This is an explicit local test topology, not a production deployment prescription or an automatic environment installer. Keep Core data under the checkout's private `deploy/data` mount and BFF state under ignored `.evidence`. The harness reads only the selected task's binding fields for its report. Do not share these paths with another environment.

Prepare the test database through normal application initialization and administration: create two distinct active customer users, a test Account pointing only at the simulator on port 19090, the corresponding group/API-key access and explicit test cost rules. Customer fixture passwords must match the isolated administrator test password used by this legacy browser harness; credentials stay only in the private local configuration. Sync the simulator's models, then configure and publish `phase5-native-image-v1` and `phase5-native-video-v1` through Media Workbench. The artifact harness expects the native image and video protocols plus the supported `3.0` inline test offer; it updates only this test Account's specifications and reference limits. Missing offers fail the test. Never enable a real supplier or paid submission gate to satisfy a test.

Record the IDs from that new environment and generate small synthetic video/audio inputs:

The existing video ledger fixture is
`backend/internal/repository/testdata/studio_video_orders_legacy.sql`, also used
by `TestVideoAccountPostgresAtomicCaptureAndReplay`. If the disposable synthetic
database lacks this table, verify its container, mounts, fixture users and
simulator-only Accounts before applying that exact fixture in a transaction.
Do not apply test SQL to production, a restored real database or a database with
unique data. This creates no new application migration. Verify the migration
ledger and existing balances, usage and billing-dedup records remain unchanged.
An old `reserve_pending` operation is preserved for recovery; fixture setup does
not authorize resubmitting it. Browser acceptance uses a new explicit intent.

```powershell
node tools/phase5-media-e2e/configure-fixture.cjs ACCOUNT_ID CUSTOMER_ID OTHER_CUSTOMER_ID
node tools/phase5-media-e2e/start-local.mjs --embedded
node tools/phase5-media-e2e/artifact-browser.cjs
```

Replace the three uppercase arguments with numeric test IDs. The setup records the running Core's immutable image ID in `.evidence/local-fixture.json`, generates synthetic media using ffmpeg, and refuses to overwrite an existing manifest. It does not write users, Published configuration, or credentials. `PHASE5_FIXTURE_MANIFEST` can select an explicit private manifest instead. Account, user, image, local supplier and submission-gate checks run before browser actions. Bridge binary identity is measured in the running container; no prior binary, seed, screenshot or report is required. Full artifact acceptance restarts only the declared test Core/BFF/Bridge/simulator services, so reserve those services for this run.

For the older optional development browser harnesses, omit `--embedded`. `reference-browser.cjs` additionally uses the explicit synthetic-contract import and requires the matching isolated test Core build. Use `start-local.mjs --synthetic-contract` for that BFF. This does not change the normal application's model contract. The artifact harness uses ordinary Published configuration instead of a contract overlay.

`node --test tools/phase5-media-e2e/fixture-config.test.cjs` checks fixture isolation without starting Docker or contacting any service. Its passing result is not browser E2E evidence. CI also retains the application tests and the synthetic usage-display regression; release artifacts can only be requested manually.

`package-boundaries.cjs` checks the public release file list and uses a synthetic Docker context. It requires existing frontend development dependencies and a local Docker builder. It does not build or publish the application image. `create-overlay.mjs` is an optional isolated test-build helper; it does not alter the production source contract.

Configuration, preparation/recovery checks, supplier dispatch, and real customer delivery are separate test scopes. A local fixture passing does not certify a production deployment or a paid provider operation.

## Controlled image submission (local simulator only)

`image-submission.cjs` exercises the real authentication, Bridge, packaged BFF,
Published quote, private asset and Core dispatch paths against `simulator.mjs`.
Provision the existing local fixture through normal administration; no fixture
loader or direct Published writes are used. See `deploy/studio/README.md` for
the generic runtime artifacts, private state and legacy recovery configuration.

This optional test requires the explicit `STUDIO_IMAGE_PUBLISHED_SUBMISSION=true`
server setting in all three test components. Keep all actual supplier accounts
outside this environment. This setting is not the legacy image/video gate and
is not enabled by the ordinary startup template. Bind BFF to host loopback
18083, Bridge to 18082, Core to 18080; the BFF public origin is
`http://127.0.0.1:18083`. Its internal Bridge address must match the actual
listener, which may differ from the generic overlay's default 8091.

Set `PHASE5_FIXTURE_MANIFEST` to the private fixture manifest and
`PHASE5_READINESS_EVIDENCE` to a new absolute private JSON filename. Then run:

```sh
node tools/phase5-media-e2e/image-submission.cjs
# Restart only the identified test Core and BFF, preserving their state.
node tools/phase5-media-e2e/image-submission.cjs --recover
```

The file preserves opaque quote state and must never be committed. Recovery
acceptance requires all five original scenarios to have finished: text image,
reference image, supplier rejection, lost supplier response, and a client
timeout while Core persists the result. Every scenario keeps one original
intent and supplier POST. Unknown supplier outcomes remain unknown and unbilled;
they do not authorize another submission. Re-login after BFF restart is expected.
The report is HTTP acceptance, not browser UI or real supplier evidence.

The packaged Linux permission test uses only temporary synthetic directories:

```sh
docker run --rm --network none --user 0 --entrypoint node \
  --mount type=bind,src="$PWD/deploy/studio/runtime-permissions.test.mjs",dst=/app/runtime-permissions.test.mjs,readonly \
  studio-bff:candidate --test /app/runtime-permissions.test.mjs
```

Only this fixture setup runs as root. Application children run as UID1000:
root-owned 0700 state is rejected, an explicit local owner handoff permits
durable access, and another process can read only its owner's journal. The
runtime entrypoint never changes production ownership or permissions.

## Published customer browser generation and recovery

`customer-browser.cjs` uses the ordinary `/login` and `/video-studio` Vue pages,
real ticket/session exchange, Published catalog, private uploads, quotation,
explicit generation confirmation, authenticated preview/download and server
history. It does not replace business APIs. The response-loss scenario forwards
the real POST before dropping only its response. The supplier fixture implements
the existing image JSON and `/v1/videos` task/status/content protocols; its output
is synthetic and does not establish any real supplier capability.

Use the existing isolated fixture and current embedded frontend/Core and packaged
BFF. All test Accounts must resolve only to the loopback protocol simulator;
never enable these fixture gates around real supplier Accounts. Set the private
fixture's `mock_submission: true`, both existing controlled submission settings
in Core/Bridge/BFF, and BFF's public origin to `http://127.0.0.1:3000`. Keep the
legacy real-submission settings closed. The optional local proxy supports
`PHASE5_FRONTEND_MODE=embedded PHASE5_BFF_PORT=18083`; it still binds loopback.

Set `PHASE5_FIXTURE_MANIFEST` and `PHASE5_CUSTOMER_EVIDENCE` to explicit private
files. `PHASE5_PLAYWRIGHT_MODULE` can point to an already installed Playwright
package; the harness uses system Chrome with an isolated headless context. It
does not read a personal browser profile, install a browser or create a database.

Run each scenario once against the same evidence file:

```sh
node tools/phase5-media-e2e/customer-browser.cjs --scenario=image-text
node tools/phase5-media-e2e/customer-browser.cjs --scenario=image-reference
node tools/phase5-media-e2e/customer-browser.cjs --scenario=image-response-loss
node tools/phase5-media-e2e/customer-browser.cjs --scenario=video-inline
node tools/phase5-media-e2e/customer-browser.cjs --scenario=video-references
node tools/phase5-media-e2e/customer-browser.cjs --scenario=video-failure
node tools/phase5-media-e2e/customer-browser.cjs --scenario=image-unknown
node tools/phase5-media-e2e/customer-browser.cjs --scenario=image-rejection
node tools/phase5-media-e2e/customer-browser.cjs --scenario=video-unknown
# After restarting only the bound test Core/BFF, preserving all state:
node tools/phase5-media-e2e/customer-browser.cjs --recover
```

The report retains task identities, safe HTTP summaries, request/preparation
association, per-scenario submit/upload counters and downloaded result hashes.
It is private, including its preparation IDs, and is not a public fixture.
Do not rerun a failed scenario to manufacture a new intent; inspect the saved
original first. Compare native order/usage/dedup records before and after restart
as a separate check. Unit tests, a runnable harness and successful image builds
alone do not establish browser acceptance or once-only billing.

The harness clicks the Studio entry button after navigation or reload and waits
for the authenticated catalog. Recovery changes media type only when needed and
waits for the corresponding server history, so it does not test against a stale
list. `--user-index=1` selects the second already provisioned fixture customer;
it does not create an identity or bypass login.

Published video dispatch requires the existing `studio_video_orders` ledger
table as well as the ordinary application migration ledger. A missing legacy
table is an environment/schema prerequisite failure, not successful generation
or a missing supplier price. The browser harness never creates or migrates it.
Preserve any `reserve_pending` task and investigate without resubmission.

When dispatch is independently blocked, a new reference preparation can be
checked with `--scenario=video-references --quote-only --user-index=1`. This
uploads only to the local simulator, checks quote binding and ownership, and
records generation as `NOT_RUN`. Do not use it to replace the full video scenario
or to retry an existing intent. Recovery reports successful delivery, preserved
unknown outcomes, quote-only cases and blocked generation separately; a recovery
PASS means the recorded state remained recoverable, not that every task generated
a result. Keep any diagnosed prerequisite blocker in the private evidence.

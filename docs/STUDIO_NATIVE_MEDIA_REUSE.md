# Studio native media execution

Studio owns product specifications, frozen sale prices, durable execution claims
and delivery. Sub2API owns Account credentials, model mapping, protocol forwarding,
admission and the existing monetary transactions. The five-step editor remains:
specifications → reference assets → price dimensions → unit prices → draft review.

## Call paths

| Account contract | Studio integration | Native implementation |
| --- | --- | --- |
| OpenAI-compatible API key images / edits | Compile the frozen product request, then parse it through the native image plan | `OpenAIGatewayService.ForwardImages` |
| OpenAI OAuth images / edits | Same service, preserving its direct-images versus Responses choice | `openai_images_direct.go`, `openai_images_responses.go` |
| Gemini ordinary images / reference edits | Convert the existing Studio spec and private reference bytes to `contents` / `generationConfig` | `GeminiMessagesCompatService.ForwardNative`; native inline-image accounting helpers |
| Grok images / edits | Pass the frozen model and spec to the existing media operation | `OpenAIGatewayService.ForwardGrokMedia` |
| Grok single video | Use native create, status and original-content operations, including native/standard Account API style | `ForwardGrokMedia`, `IsGrokVideoStatusBillable`, native content retrieval |
| Previously published generic single-video contracts | Preserve the existing frozen contract and recovery | Existing Studio video request path |

The native service is called directly, not its public HTTP handler: the latter
would introduce another scheduler and billing owner. Studio loads exactly the
quoted Account and reuses its admission checks. A private server context preserves
the already-mapped upstream model and prevents fallback generation, same-Account
POST retries, redirects and transport replay. It cannot be enabled by client headers.

`ImageResultUploader.Inline` uses the existing bounded URL/data-URL/Base64 decoder
and downloader. Studio retains its private durable receipt store, without requiring
S3. Raw unit responses are saved before materialization; recovery can download the
original result without another generation POST. Credentials are not forwarded to
result URLs. Private destinations and excessive result counts are rejected.

The Bridge continues selecting an existing customer Key for the configured Group,
with user, expiry, status and original-receipt ownership checks. Its former OpenAI-only
Group filter is removed: the Core authoritatively resolves the native media contract.
This change requires a new Bridge binary as well as Core and BFF updates.

## Configuration and compatibility

The backend derives `native_adapters` from the existing Account platform/type.
Saving a new draft inherits the installed native binding; published documents and
historical receipts are not rewritten. The ordinary editor has no protocol-family,
adapter or wire-profile selector. No domain list or model-name protocol guessing is
used. Existing internal fields remain readable.

An adapter descriptor describes local implementation limits, not tested supplier
capabilities. Admins still choose sale specifications and prices. OpenAI-compatible
business size labels still require their existing explicit size mappings when a
wire size cannot be inferred from the selected dimensions. Confirmed per-request
execution limits remain separate from the customer's 1–10 image quantity. Missing
multi-image evidence means one image per unit; Gemini ordinary generation is likewise
one image per unit. Reference-edit execution limits are independent.

Unsupported native Account contracts remain diagnosable rather than being assigned
`openai_json`. No Midjourney adapter, provider-async batch product, multi-video flow,
new account store, wallet, ledger or general task scheduler is introduced.

## Billing and failure ownership

Images keep `SettleQuotedImage → UsageBillingRepository.Apply`; only delivered
quantity is settled for a terminal partial result. Account Stats pricing is matched
against the actual Account platform. The native Group quota platform is frozen in
new quotes; historical quotes retain their former interpretation.

Videos keep the existing native hold/capture transaction. Calling Grok forwarding
services does not create the public handler's pending-billing owner. Capture remains
the sole customer charge, followed by native usage/Account quota effects. Unknown
generation outcomes are queried using the same durable identity, never resubmitted.

## Verification

`studio_native_media_test.go` compares native service requests with Studio requests
using the same synthetic Accounts, model mappings and upstream responses. Coverage
includes API-key images/editing across three platforms; OAuth direct and Responses
paths; Grok native/standard single-video lifecycle; URL/Base64/data-URL delivery;
partial results; repeated submission/recovery; exact Account cost; no retry after
unknown responses; and private/excess-result rejection.

The local `tools/native-media-e2e` harness uses real Core, Bridge, BFF, PostgreSQL,
Redis and a closed synthetic HTTPS supplier. It does not intercept browser API
responses. The browser creates and publishes products through the five-step editor
without entering technical bindings. All publish/sales actions belong to that
isolated fixture only.

Evidence from 2026-10-12 is under `D:/AI-Gateway-native-media-20261012/evidence`:

- `native-browser.json`, `native-video-browser.json`: draft, validation, reload and isolated publication.
- `native-customer-image.json`: 3 normal single-image requests, 3 downloads, 2.10 frozen/settled amount, one usage row.
- `native-customer-edit.json`: one reference image, 2 output requests/images, 1.40 frozen/settled amount, one usage row.
- `native-customer-video.json`: one native Grok submission and one original video; 2.00 native capture, one usage row; recovery without another submit.
- `native-dimensions-desktop.png`, `native-dimensions-mobile.png`, `native-prices-desktop.png`: inspected 1440px/390px layouts.
- `bff-tests.log`: 52 affected BFF/contract tests passed.

All amounts and identities above are synthetic. No supplier charges or production
actions are part of this evidence. Development binaries mounted into existing local
runtime images are integration evidence, not a final immutable release candidate.

The opt-in `Native media candidate (no deployment)` workflow builds all three
changed components on an ephemeral GitHub-hosted Linux runner using the existing
Docker recipes. It then runs the same real browser/business fixture against the
images themselves, checks their identities and shared network namespace, and
exports compressed Docker TARs plus `manifest.json`. It cannot run on a self-hosted
runner, push a registry image, or deploy. Build peak space is reserved on the runner;
local machines only need space for final artifacts. A workflow run is required to
establish PASS; the workflow's existence is not acceptance evidence.

Release-guard scope: production PUB-01–04/06 and production rollback are N/A to
this isolated candidate build; they remain requirements of a separately approved
deployment. Candidate health, identity, functional behavior (PUB-05) and actual
image business verification (ART-01 scope) are recorded by the hosted run. No
production baseline is refreshed or claimed by this development task.

## Reproducing the bounded local fixture

Use a separate local Compose project, new PostgreSQL/Redis and private state volumes,
the development Core/Bridge binaries, and the current BFF source. Both sidecars share
the Core network namespace. Bridge must retain the same read-only Core configuration
volume and its own executable entrypoint. Bind the same-origin proxy only to loopback.
The fixture scripts deliberately accept only the explicit dated private output path.

1. Start the synthetic TLS `simulator.mjs` with synthetic certificate/key and an original MP4 under its evidence root. It never forwards requests elsewhere.
2. Run `seed.mjs` to create native Groups, Accounts, model catalogs and synthetic Account Stats costs through normal admin APIs. Run `customer-keys.mjs` for fixture customer Keys.
3. Existing installations need the existing `studio_video_orders` schema. For a fresh isolated database only, use the repository's `testdata/studio_video_orders_legacy.sql`. This is not a new formal migration or a production instruction.
4. Run `browser.cjs <private-root>` and `browser.cjs <private-root> --video` to configure and publish the two test products through the real UI.
5. Run `customer.cjs <private-root> image`, `edit`, and `video`. If a run has already submitted a task, use `--recover`; do not submit it again to obtain a passing report.

Keep generated credentials, state, originals and detailed evidence outside Git.
The fixture's enabled generation switches must not be copied into a deployment.

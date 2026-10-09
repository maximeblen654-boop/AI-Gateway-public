# Media request correctness and original-result delivery

AI-Gateway is an API relay. Before dispatch, the configured supplier protocol,
Published specification and frozen request must agree. After dispatch, a complete,
valid, decodable supplier result is saved and delivered unchanged and settled at
the original quoted price once. Actual output pixels, aspect ratio and duration
are not quality promises or settlement gates.

This policy supersedes the output-equality checks introduced in `aa219b1`.
It does not change prices, result-count contracts, the native ledger, reservations,
capture/release rules, or the meaning of historical settled orders.

## Request and settlement boundaries

| Stage | Image | Account video |
| --- | --- | --- |
| Administrator | `mediaworkbench.Validate` checks explicit size mappings against the requested aspect ratio and numeric size. Fixed specifications cannot map to `auto`. | Published configuration supplies supported values; the controlled adapter selects `duration`/`ratio` or `seconds`/`aspect_ratio` and reference fields. |
| Frozen quote | Account, Published revision, adapter, price, specification, references and size mapping remain bound to the quote. | Account, connection, Published/adapter, price, specification and ordered references remain bound to preparation and the final request hash. |
| Outbound request | `CompilePublishedImagePlan` → `MaterializeJSON` → `buildOpenAIImagesRequest` preserves the validated request bytes. | Node `CompilePublishedPlan` → `Materialize` → Core `CompilePublishedVideoPlan`/`InspectForModel` → `Plan.Materialize` → `requestHTTP` preserves the selected fields and request hash. |
| Actual response | Decode every PNG/JPEG/WebP completely, check count, format, container integrity and bounded size. Supplier JSON dimension claims are not a substitute for valid image bytes. | Require a complete original, matching MIME/container, one video stream, valid bounded dimensions/duration and full `ffmpeg` decode. Persist original bytes and their hash before capture. |
| Money boundary | Valid persisted result → existing `SettleQuotedImage` once at the frozen price. | Valid persisted original → existing authenticated native capture once. |

An erroneous `16:9 → 1024x1024` mapping, a fixed request mapped to `auto`, a
missing required field or a request duration overridden by this site is still
rejected before the paid POST. Model, quality, count and reference rules remain
part of the controlled request compiler. Revoking output equality does not permit
changing the frozen request, choosing another Account or re-quoting an old task.

Legal configured supplier resolution names such as `720p`, `1080p` and `4k` are
sent as that protocol defines them. They do not require an invented output pixel
grid. An explicit `1280x720` value is likewise sent only when the existing
adapter/configuration supports it. No request value is rewritten to satisfy an
output checker.

## Result policy

- Requested `1024x1024` with a valid `512x512` or `1024x576` image is a successful
  relay result. Requested `1280x720`, eight seconds with a valid different-sized
  or shorter video is also a successful relay result.
- Preserve the exact original bytes for preview and authenticated download.
  Do not stretch, crop, rotate, re-encode, add frames or pad duration. Image EXIF
  orientation is preserved rather than used as an equality gate.
- Image response count still must equal the frozen quoted count. Video still
  uses the existing single-original protocol. This change does not introduce
  partial-count pricing or alter any quantity-billing contract.
- Positive dimensions and duration, format consistency, complete decoding,
  maximum media size, decoder resource limits, task/owner binding and original
  hashes remain mandatory. Missing claimed width/height is acceptable when the
  real file decodes; absent or corrupt file metadata that prevents valid decoding
  is not a successful result.
- The video probe is bounded to 128 KiB of structural metadata; probe and full
  decode each have a 60-second timeout. Existing input/store size limits remain.
  There is no output-equality tolerance policy or frame-timeline measurement.

## Recovery and financial behavior

| Outcome | Existing task / financial action |
| --- | --- |
| Complete valid image, including different pixels/aspect | Save the unchanged result; `completed/billed`, original-price settlement once. |
| Complete valid video, including different pixels/aspect/duration | Save the unchanged original before native capture once. |
| Wrong image count, missing result or corrupt/undecodable bytes | Keep the original task/receipt; no successful delivery or settlement. No automatic generation retry. |
| Image POST timeout, rejected/ambiguous response or lost response | Keep the permanent dispatch claim and existing `unknown/pending` recovery semantics; never issue a replacement POST. |
| Video status explicitly confirms failure | Follow the existing verified-failure release path once. |
| Video pending/unknown, missing result or result GET timeout | Query the original task/result only. No capture without a valid original, no new generation and no unconditional release. |
| Already settled task | Recover the same original and identity; no reprice, refund or second capture. |

Concurrent local recovery requests share one in-flight operation per owner/task.
That in-memory coalescing is not an accounting authority: restart and re-login
still use the durable original task and native idempotency records. Browser
state is not the source of truth and cannot authorize another user's result.

### Receipt and original metadata compatibility

Image receipt `published_image_binding_v1` and `published_image_receipt_v2`
remain readable. New receipts keep v2. Recovery validates the original quoted
count and saved result without reinterpreting a historical size mapping or
rewriting the frozen request, price or ledger identity.

Video metadata v1 and v2 remain readable. New Account originals keep v2 with
`media: null`; a prior v2 measurement is retained unchanged as historical
diagnostic data and is not a delivery/capture condition. Stored bytes were
fully decoded before atomic persistence; reads verify the same size, hash,
owner, Account, request and binding identities. Existing receipts and originals
are not migrated, downgraded or deleted.

Legacy slot journals retain their original receipt, recovery and ledger path.
They are not reinterpreted through current Published configuration.

### Rollback boundary

The strict `aa219b1` executor does not implement this business policy: it can
reject a valid different-spec result or a v2 record without an output
measurement. Earlier v1-only readers also cannot take over v2 records. A local
application rollback must retain a recovery executor that supports these file
versions and the relay policy; keep new submission off if that cannot be met.
Do not down-convert records, undo historical charges or restore a whole database
over newer tasks to force compatibility. No database schema or accounting
state-machine change is part of this fix.

## Focused synthetic verification

The regressions distinguish outbound correctness from delivered geometry:

- Normal Published `1K / 16:9` materializes `size=1536x864`; square/`auto` and
  numeric downgrade mappings are rejected. A local TLS supplier observes the
  actual image request fields, not a mocked compiler return.
- For a `size=1024x1024`, `n=1` request, valid `512x512` and `1024x576` responses
  preserve their exact bytes and hashes through recovery. Supplier POST and
  applied native billing are each one, at the unchanged fixture quote.
- An Account video request retains `resolution=1280x720`, `duration=8`,
  `ratio=16:9`. Valid `640x360`, square and two-second originals each survive
  duplicate clicks, fresh-session recovery and runtime/store reconstruction,
  with one task POST and one capture. Configured `720p`/`1080p` also remain
  unchanged in the request and are accepted without an output grid.
- Historical image receipt v1/v2 and video original metadata v1/v2 recover
  unchanged. Cross-owner/identity changes, malformed count/content, corruption,
  explicit failure, pending status, timeout and response loss remain covered.
- Node BFF → Go Bridge contract tests retain authentication, lost-POST recovery,
  exact original hashes, single generation and single capture. Separate Core
  tests exercise frozen request checks and native repository idempotency.

These are local synthetic supplier/ledger results, not production SQL counts,
real supplier charges or a new full browser acceptance. The earlier browser and
database-restore evidence retains its original scope and is not re-run here.

```sh
cd backend
go test -p 1 ./internal/mediaworkbench ./internal/imageplan ./internal/videoplan ./internal/studiobridge
go test -p 1 -tags=unit ./internal/handler ./internal/service -run 'TestStudioImage|TestVideoRuntime|TestVideoCatalog' -count=1
cd ..
node --test --test-concurrency=1 studio/bff/image-binding.test.mjs studio/bff/legacy-runtime.test.mjs studio/api/video-plan.test.mjs studio/bff/video-account.test.mjs studio/bff/video-handler.test.mjs studio/bff/video-result-spec.test.mjs
```

## Release status

`CONTRACT_READY_SEPARATE_RELEASE_GATES`. Output pixel grids and exact
output-duration equality are no longer release requirements under this relay
policy. Final candidate checks, affected Core/BFF artifacts, production routing,
recovery, sales/cost facts and deployment permissions remain separate gates.
This contract does not by itself claim production deployment, sales Publish,
paid enablement or a real supplier request.

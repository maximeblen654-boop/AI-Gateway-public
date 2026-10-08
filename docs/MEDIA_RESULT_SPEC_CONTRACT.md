# Frozen media specifications and delivery verification

This change targets the Published image/Account-video paths. It is a local,
synthetic verification result, not evidence of supplier capability or deployment.
The earlier browser acceptance established identity/recovery/billing wiring; its
small media fixtures did not establish delivered resolution or duration.

## Request and settlement boundaries

| Stage | Image | Account video |
| --- | --- | --- |
| Administrator | `mediaworkbench.Validate` checks explicit size mapping against aspect ratio and numeric pixel specification. A fixed specification cannot map to `auto`. | The controlled wire profile selects `duration`/`ratio` or `seconds`/`aspect_ratio`. Models and supported values come from Published configuration. |
| Frozen quote | `ResolvedImageOffer.Spec` and `Offer.ResolvedConfig` retain the size mapping, price, Account and adapter. | `CompilePublishedVideoPlan`/`InspectForModel` compare the final request's resolution, duration, ratio and reference counts with the frozen spec. Missing/overridden parameters are rejected. |
| Outbound request | `CompilePublishedImagePlan` → `MaterializeJSON` → `buildOpenAIImagesRequest` passes the resulting bytes unchanged. | Node `CompilePublishedPlan` → `Materialize` → Core plan validation → `Plan.Materialize` → `requestHTTP` retains the same fields/bytes. Fixed adapter fields do not contain resolution/duration/ratio overrides. |
| Actual response | `studio_image_result.go` checks actual decoded PNG/JPEG/WebP dimensions and count, full container integrity and fixed-geometry EXIF orientation. JSON width/height claims cannot replace decoding. | `video-result-store.mjs` probes decoded video frames and fully decodes the original. It verifies one video stream, uniform actual pixel dimensions, square sample pixels, rotation and a measurable frame timeline. |
| Money boundary | Receipt/request size must agree with the frozen mapping. Verification runs before `PersistResult` and again before existing `SettleQuotedImage`. | Frozen `binding.spec` is passed to original storage and checked before the existing authenticated capture call. Core's existing reserve/capture/release transaction model is unchanged. |

## Comparison policy and explicit limits

- Image `wire_size=WIDTHxHEIGHT` requires exactly those decoded pixels; integer
  ratios must match by cross multiplication. No undocumented rounding allowance
  is introduced. A label such as `1K` does not independently define a short side:
  its explicit size mapping is the frozen pixel promise. The label's marketing
  accuracy still requires supplier evidence. Explicit `auto`/unfixed specs do not
  promise fixed pixels, but still require correct count and valid full images.
- A fixed image cannot contain EXIF orientation that changes its display
  geometry. Originals are not silently rotated, resized or re-encoded.
- Video checks currently interpret **explicit `WIDTHxHEIGHT` only**. The existing
  supplier contract lists `720p`, `1080p`, `4k`, etc., but the available evidence
  does not define their pixel grids/rounding for every ratio. These labels return
  `video_result_resolution_unverifiable`; new BFF dispatch is blocked **before**
  a generation POST. Quoting itself still performs no generation.
- Do not change a real `720p` offer to a pixel-valued request merely to bypass
  this guard. Such a request must first be supported by that supplier. The local
  positive tests use an explicitly configured synthetic pixel-valued profile;
  they are not a capability claim for a real model.
- Video duration is the decoded frame timeline's end minus start, not a JSON
  supplier status nor an audio-inclusive container duration. The only allowance
  is two microseconds for serialized endpoint rounding. There is no arbitrary
  percentage or frame-length grace. Missing timestamps/frame duration, rotation,
  non-square pixels or changing dimensions remain unverifiable.
- Video probing is bounded to 2 MiB of frame metadata and 60 seconds per tool,
  in addition to existing original-size and private-store capacity limits.
  Exceeding bounds fails closed, not as a successful delivery.
- `quality` labels/visual quality cannot be proved by dimensions and duration.
  This change does not certify them.

## Recovery and financial behavior

| Outcome | Durable evidence | Existing task / financial action |
| --- | --- | --- |
| Matching image | Frozen request, upstream response, verified result hash | Existing settlement once; `completed/billed` |
| Wrong image pixels/ratio/count or undecodable metadata | Original request/receipt and upstream response retained | `unknown/pending`; no settlement, no automatic re-POST |
| Image timeout / lost response | Permanent original dispatch claim | `unknown/pending`; recovery only, no second POST |
| Matching video | Frozen quote/request and decoded original | Existing capture once |
| Wrong video pixels/ratio/duration / unverifiable metadata | Structurally valid original and decoded measurement retained privately, bound to owner/Account/request/binding | No capture or release; existing reservation remains held. Restart checks the same original without downloading or generating a replacement. |
| Video result GET timeout | Original task and quote remain | Retry original GET only; no generation or settlement |
| Prior capture with discrepant original | Old captured money fact is retained | Delivery verification rejects it; no refund, re-capture or historical repricing |

New image receipts use `published_image_receipt_v2`; new Account-video originals
use metadata version 2 with measurement version 1. Old executors reject these file
versions rather than accepting retained wrong-spec bytes after rollback. These
are private-file versions, not database schemas or new accounting states. Older
receipts remain readable without changing their quote/request/accounting binding.
Older stored originals without measurements are decoded
again against the **original frozen spec**, without rewriting the old receipt.
Already delivered historical results/charges are not automatically undone.

Rollback must retain a decoder/executor with these checks for unresolved media
work. Restoring an older application image does not preserve the new guarantee
for historical v1 records, and the old reader intentionally cannot take over new
v2 records. Keep paid submission off and route recovery to a compatible component;
do not delete records, down-convert metadata or restore a whole database to bypass
the version barrier.

Legacy slot journals do not have this Published specification binding. They keep
their original recovery/receipt/ledger path and are not reinterpreted using a
current catalog. Their format/integrity checks remain; this change does not claim
that absent historical specification evidence has been recovered.

Automatic refunds/releases for a completed-but-wrong supplier result are **not**
implemented. The current release path requires a verified supplier failure. Any
different compensation rule needs a separate financial decision; unknown or
discrepant outcomes stay recoverable rather than causing another paid request.

## Focused synthetic evidence

- Before the change, new regressions reproduced acceptance of `16:9 →
  1024x1024`, fixed size → `auto`, explicit `1024x1024 → 512x512`, and settlement
  of undersized/wrong-ratio images. Video wrong pixels/ratio/duration were also
  accepted by the old result store.
- Image request: `model=gpt-image-2`, `size=1024x1024`, `n=1`. A real local TLS
  supplier simulator receives these fields. Successful 1024×1024 output: one
  supplier POST, one applied native billing call. Wrong pixels (512×512), wrong
  ratio (1024×576), missing image metadata, wrong count, rejected response,
  timeout and response loss: one original POST each, zero billing calls; runtime
  and store reconstruction never resubmits.
- The normal Published `1K / 16:9` case materializes `size=1536x864`, with the
  same expected pixels at delivery; no square fallback or `auto` is introduced.
- Video request: `resolution=1280x720`, `duration=5`, `ratio=16:9`. A 1280×720,
  5-second synthetic clip succeeds. 640×360, 1280×1280 and 2-second clips each
  retain the original task: one BFF task POST, one result GET, zero capture and
  release calls through duplicate clicks and restart. These are transport/ledger
  fixture call counts, **not real supplier charges or production SQL rows**.
- The real Node BFF → Go Bridge HTTP contract probe preserves authentication,
  lost-POST recovery, exact original hash, one task POST and one capture. Its Core
  endpoint is a synthetic contract server. Separate Go runtime tests exercise
  frozen Core requests, native repository calls, hold identity and idempotency.
- Metadata absence, changing decoded dimensions, EXIF/display rotation, cached
  original revalidation, changed/missing video request fields, cross-owner
  recovery, legacy recovery and existing submission gates are covered.

Reproduce only the affected checks (use low Go process parallelism on constrained
machines):

```sh
cd backend
go test -p 1 ./internal/mediaworkbench ./internal/imageplan ./internal/videoplan ./internal/studiobridge
go test -p 1 -tags=unit ./internal/service -run 'TestStudioImage|TestVideoRuntime|TestVideoCatalog' -count=1
cd ..
node --test --test-concurrency=1 studio/bff/image-binding.test.mjs studio/bff/legacy-runtime.test.mjs studio/api/video-plan.test.mjs studio/bff/video-account.test.mjs studio/bff/video-handler.test.mjs studio/bff/video-result-spec.test.mjs
```

No migration, sale price, Published record, paid switch or real supplier request
is changed by these checks. Existing images are **not** rebuilt by this test run
and must not be presented as containing this fix.

## Remaining release gate

`BLOCKED_FOR_RELEASE`: named video resolution definitions and any supplier
duration/pixel rounding allowances still require explicit evidence. The minimum
follow-up is a controlled, versioned output-size policy frozen with the existing
offer/quote (using the current Account configuration storage), plus focused
acceptance against that policy. It must not be inferred from a similar model ID,
current sale label or an arbitrary tolerance. No new ledger/schema is proposed.

Old browser/restore PASS and old component digests retain their original scope;
they do not certify these new checks. Build and approve only affected Core/BFF
artifacts before considering a runtime deployment. No deployment is performed.

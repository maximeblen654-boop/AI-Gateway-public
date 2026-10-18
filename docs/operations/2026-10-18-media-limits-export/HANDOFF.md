# Media limits, duration selection and local image export

Development only; production unchanged. Baseline: 169334757caa94bf893c0ab6e56a23b9f545d0b6.

## Changes and capability boundary
- Platform reference domain expands to 30; only laoli_video descriptor expands to 30. OpenAI-compatible image adapter remains 16, Grok images 3, Grok video 1, seedance video 16. Specific video contract limits remain authoritative, including per-kind and total limits. Category maxima need not sum to the total.
- Existing enabled contract ID 3.5 permits 30 images, no video/audio; 3.0 retains 9 images. Paused documented candidates remain paused. Contract records are not new supplier verification or publication authorization. No production product is changed.
- Preview compiler now handles 30 within the model contract. Existing 32768 combination budget, 100 pricing rules and 32 duration values remain. Large domains must be reduced explicitly; no sampling or bypass.
- BFF validates reference counts before reading payloads, bounds accumulated binary material to 18 MiB before base64 (existing final wire limit 24 MiB remains); client uploads at most 3 concurrently. Large individual uploads can still be rejected at quote time by the aggregate budget.
- Duration range controls merge integers into the existing durations_seconds array; min/max/step, deduplication, individual removal, max32. No automatic model capability changes.
- Original download unchanged. PNG/JPG/WebP export reads the authorized original and converts locally; no generation, third-party upload or server copy. Original pixel dimensions retained, PNG/WebP alpha preserved, JPG uses white matte and quality .95. Conversion capped at 32 MiB/32M pixels/16384 per side, one at a time, timeout and visible failure. Local export does not extend retention. Canvas exports do not promise preservation of original metadata or color profiles; use original download for exact bytes.

## Native output_format assessment
Source accepts output_format in imageplan/json.go and multipart openai_images.go; the Codex direct-image path forwards it in openai_images_direct.go, and Responses tools use it in openai_codex_transform.go. Result parsing/storage recognizes PNG/JPEG/WebP. This demonstrates transport support, not supplier-specific format guarantees. Account #77 / upstream gpt-image-2 and Nano-banana-2.1 supplier format capability is not confirmed by these code paths. The additional user-authorized scope now adds optional capabilities.output_formats and frozen spec.output_format. Only openai_images (API-key OpenAI-compatible transport) can opt in to png/jpeg/webp after the administrator confirms that exact supplier/model route. Defaults remain empty/automatic and omit output_format. OAuth, Gemini, Grok and unconfirmed offers remain automatic; no production model is newly declared confirmed. Price rules remain unchanged; every configured format is locally compiled during validation/preflight within the existing combination budget. Offer and spec hashes bind explicit formats; changing a valid format after quote is rejected. Existing records omit the added fields and retain their serialized hash shape. Native format selection is independent of local export.

## Local evidence
- Go mediaworkbench + videoplan package tests PASS; explicit 0/1/16/20/30/31, publish -> bound offer -> compiled30 references, invalid31, category vs total and complexity-budget regressions.
- BFF video-assets 8 PASS and existing video-account/video-handler 29 PASS (mock upstream, settlement and recovery protections).
- Admin targeted component tests46 PASS; existing aspect tests13 PASS. Studio component63 PASS, including bounded upload concurrency.
- Chromium local export4 PASS: landscape/portrait/square across3 formats, alpha/white matte, errors and desktop/mobile downloads.
- Chromium admin limits2 PASS: actual Vue with fixture API, desktop1440x900/mobile390x844. No production writes.
- Screenshots in evidence/ are fixture browser evidence, not production or a real supplier success.

## Release boundary
Requires new fixed candidate PASS before deployment review. No database schema, money, receipt, retention, pricing, mapping or sales changes. Future deployment requires separate authorization. Old image/task records remain compatible; a configured video product above16 may be rejected by an older application if later rolled back, so rollback must account for any post-release product edits without overwriting them.
- Independent review found and fixed explicit wire-profile self-validation for known video models: matching known model identity now retains the documented limit/duration/protocol and paused status. Unknown discovered models keep their existing configured-profile path. Regression confirms 3.0 cannot widen from9 references/fixed durations to30/4 seconds by specifying images profile.
- Final local complete TypeScript check and targeted ESLint PASS.
- Final cross-adapter review also rejects video references for seedance profiles before preview compilation; its installed native descriptor declares video unsupported. New tests are wired into existing CI browser and BFF jobs.

## Integrated native format verification
- Mediaworkbench/videoplan PASS: published text/edit offers with 0/1/2 references, auto/png/jpeg/webp actual compiled request fields, unchanged per-mode prices, invalid and unconfigured formats rejected, valid-format tampering rejected, all80 configured variants inspected.
- Administrator explicitly confirms formats; no extra price matrix or automatic publication. Customer resets incompatible format on model/catalog change. Backend remains authoritative.
- Earlier A/B/C candidate eb38f4c86fa798defe1c6e7bb969421790494ba0 passed Run39112156378, completeArtifact12131576080/evidence12131511343; manifest independently read as PASS. It is superseded for the newly added native format scope and must not be deployed as the integrated version.
- After administrators publish nonempty native formats, older runtime rollback requires specific compatibility review: old decoders do not support the new frozen specification. Never overwrite published configuration or task receipts to downgrade.


## Current product decision: administrator ratios, published customer choices

The user superseded the slider direction. Customer slider, administrator bounds/mode settings, serialized slider fields and their exclusive tests are removed; no deployed configuration is changed. Prior candidate/evidence remain traceable at commit6a1c48d1; they are not the new release identity.

- Administrator uses the existing aspect_ratios array and custom-ratio editor. Presets are shortcuts, not a whitelist. New7:5 still requires adapter/model validation, exact geometry where required, pricing coverage and normal publication.
- Customer uses the original bounded-scroll ratio picker. Choices come from published Offers only. The opaque product_scope binds Account/product/revision; crossing price Offers also checks model, upstream, resolution, quality, count, references, format and excluded combinations. Missing or ambiguous grouping never invents a new route. Required reference upload can be unfinished while the current Offer's choices remain visible; submit validation stays authoritative.
- Selection does not request a quote or generation. The exact chosen Offer and ratio are quoted only on the explicit generation preparation action. No customer arbitrary ratio input remains.
- Ratio pricing remains optional and unchanged. Backend regression publishes1:1/16:9/7:5 with shared or distinct text/edit prices, checks0/1/2 references, retained price rules, unpublished rejection and frozen-ratio tamper rejection.7:5 has an explicit1120x800 mapping in that test; the cloud API-key JSON fixture separately tests native ratio pass-through.
- Video duration range, model-specific references up to30, GPT image16 boundary, native format binding, local export, separate text/edit prices and catalog-before-readiness race fix are retained.

## Current verification and candidate

Local Go mediaworkbench PASS; administrator aspect/native-format20 tests PASS; customer panel/helper88 tests PASS; complete TypeScript and targeted ESLint PASS; real Vue fixture Playwright4 PASS at1440x900,1366x650,390x844 and touch. These browser fixtures are not real backend integration. Final-image Core/Bridge/BFF acceptance, CI and Security all PASS for the fixed source below.

Production was not connected or modified. Future deployment needs separate authorization and actual baseline/rollback checks. No schema change; existing production records without slider metadata retain their serialized shape. An old un-deployed slider candidate is not a production rollback target. Post-release native-format or reference-capability product edits still require compatibility review before any rollback.

Release-guard applicability: PUB-01 through PUB-04 and production PUB-06 are N/A to this non-deploying task (no domain/proxy/cache/production changes); PUB-05 and ART-01 PASS for isolated final images: source/runtime metadata, archive identities and healthy container config digests agree; real UI and API acceptance passed. A future production release must obtain fresh public-route and rollback evidence; local PASS does not satisfy production gates.

## Final candidate — CANDIDATE_READY_NOT_DEPLOYED

- Runtime and acceptance source: `b9796b975c1ced95366d7e65c8976364664f658c`.
- [CI39121177224](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39121177224) PASS; [Security39121177215](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39121177215) PASS.
- [Candidate39121193014](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39121193014) PASS. [Complete Artifact12134492554](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39121193014/artifacts/12134492554), [small evidence12134214293](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39121193014/artifacts/12134214293).
- Manifest SHA256 `01ca381bb0bba31a02a2bd50520803fed6ce20e9973b7d7c4bfebe08252c5c7d`; [exact TAR/OCI/config identities](evidence/published-ratios-pass-manifest.json), [sanitized acceptance summary](evidence/published-ratios-acceptance-summary.json). All three healthy container image IDs match the archive config identities; source and runtime-file metadata match the fixed source. No full image package downloaded locally.
- Final built application + real isolated Core/Bridge/BFF + synthetic supplier: administrator custom7:5 save/re-read/publish, unpublished rejection, retained prices/sibling products, eight text/edit x auto/png/jpeg/webp executions, exact ratio/format request, original bytes/MIME, one native usage/dedup settlement and no extra POST or settlement on refresh PASS. Existing image3/edit2/video1 and20 scoped finality cases (4each502/OK/PARTIAL502/DISCONNECT/TIMEOUT), recovery, passive status and lifecycle acceptance PASS. No real supplier capability or production success is asserted.
- Vue fixture/browser screenshots: [1440x900](evidence/published-ratios-1440.png), [1366x650](evidence/published-ratios-1366.png), [390x844](evidence/published-ratios-390.png). Actual isolated backend admin screenshots: [desktop](evidence/published-ratios-native-aspect-options-desktop.png), [mobile](evidence/published-ratios-native-aspect-options-mobile.png). Runtime CI browser Artifact12134128380 retains the broader UI regression evidence.
- Deployment requires a separate authorization for this exact candidate, fresh production identity/protection fingerprints, compatible rollback assets and existing controlled Compose procedure. Do not copy isolated configuration, publish a product, alter pricing or enable sales as part of candidate delivery. No production action was performed.
- Only the21.5MB small evidence package was downloaded, directly extracted without retaining a ZIP. Current/previous candidate evidence and main dirty worktree remain protected. No disk cleanup was needed; final free space is recorded in the delivery report. Formal main Handoff and Constraints originals are unchanged; this is the factual stage increment for ChatGPT.

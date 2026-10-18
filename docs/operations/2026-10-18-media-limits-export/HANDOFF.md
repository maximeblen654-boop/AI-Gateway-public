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


## Published aspect-ratio slider (integrated development, not deployed)
- Optional image capability `aspect_ratio_slider={enabled,mode:"discrete",min,max}`; absent capability retains existing UI and legacy serialization. Save/validate/publish required. Administrator opt-in never changes pricing dimensions, price rows or existing Published data.
- Slider snaps to exact configured/published ratios, portrait to landscape, square centered when present; live outline, mouse/touch/arrows/Home/End. It does not quote or generate while dragging. Precision is the administrator's legal ratio list, not an invented continuous interval.
- Bounds must be members of aspect_ratios and cover the explicitly configured domain. Narrowing requires explicit specification/price review, not automatic deletion or repricing. Continuous mode is rejected: no supplier-specific continuous contract or safe arbitrary-price coverage has been established.
- A new opaque product_scope binds Account+Product+Published revision for client grouping. Ratio-priced Offers remain distinct; changing ratio selects only the matching exact Offer in that scope and preserves other selected specifications. No scope => no cross-offer grouping; ambiguous options are not exposed. Server exact Offer, exclusions, dimension mapping and frozen-spec checks remain authoritative.
- Mediaworkbench full package PASS; shared versus ratio-specific text/edit prices, 0/1/2 references, rejected unpublished/out-of-range/frozen tampering, disabled/legacy behavior and bounded domain tested. Service scope identity test PASS.
- Local Vue/component tests88 PASS; slider Chromium4 PASS (1440x900,1366x650,390x844, actual touch drag). TypeScript complete check and targeted ESLint PASS. These are Vue+fixture browser evidence; final Core/Bridge/BFF acceptance remains separate.
- Prior source60aa CI39114487336/Security39114487350 PASS. Candidate39114498348 built correctly and passed all8 native-format simulated deliveries, but later first-visit video acceptance timed out. Do not treat its manifest as PASS. Investigation found catalog Key preparation racing readiness; creation entry now waits for catalog to settle before reading readiness while history stays independent. No readiness provisioning or permission change; delayed/failing catalog regressions added. Next candidate must verify the actual flow.
- New optional Published slider metadata requires compatibility review before an older-runtime downgrade after publication. No database migration or historical task rewrite. Production remains unchanged.

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
Source accepts output_format in imageplan/json.go and multipart openai_images.go; the Codex direct-image path forwards it in openai_images_direct.go, and Responses tools use it in openai_codex_transform.go. Result parsing/storage recognizes PNG/JPEG/WebP. This demonstrates transport support, not supplier-specific format guarantees. Account #77 / upstream gpt-image-2 and Nano-banana-2.1 supplier format capability is not confirmed by these code paths. Published generation specs/quotes do not gain a format field in this change.

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

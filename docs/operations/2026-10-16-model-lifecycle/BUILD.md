# Frozen candidate build and acceptance provenance

Runtime source: `6f02fdc17a923aa17576f0803305b925b29e36dd`.

Core, Bridge and BFF were built once by [Run 38808850222](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38808850222), using the existing GitHub-hosted linux/amd64 recipes. Complete archive Artifact `12006959480`, name `native-media-candidate-6f02fdc17a923aa17576f0803305b925b29e36dd`, 238,968,281 bytes. The initial package manifest is **NOT_PASSED**, because acceptance stopped on a script error. It must be paired with the final PASS manifest; it is not itself an accepted release.

No later test-only commit changed runtime source or rebuilt/exported these images. `git diff 6f02fdc..<final acceptance SHA>` records the exact test/harness fixes.

| Attempt | Result | Confirmed cause |
| --- | --- | --- |
| 38805449296 | Canceled, superseded before acceptance | Earlier intermediate scope, before explicitly selected publication. Not a release candidate. |
| 38808850222 | Build/export complete, acceptance failed | Video browser harness iterated image-only report.products after publication UI changed. |
| 38810018240 | Acceptance failed | Playwright browser.newPage implicit context rejected a second page; corrected to explicit BrowserContext. Prior image/edit/video and focused 20-task regressions passed. |
| 38811234895 | Acceptance failed | Preceding 502 fixture retained provider hostname pinned to local simulator; lifecycle fixture expected localhost. Host pin/key/simulator safeguards are now checked before restoring the generic local URL. No real supplier access. |
| 38812333007 | Acceptance failed | Added fixture-key assertion read the redacted admin DTO. It now checks only a boolean in isolated PostgreSQL; no secret is exposed. |
| 38813409395 | Lifecycle delivery passed, native comparison stopped | The arbitrary Studio fixture model name was not supported by the independent native Images parser. The comparison now uses native-supported `gpt-image-1` advertised by the same local simulator, without changing runtime admission rules. |

Subsequent runs use existing workflow `mode=accept-existing`, load and verify the original TARs, and upload only small evidence. Final accepted run, test SHA, identities, exact manifest hash and artifact expiry are recorded in HANDOFF.md after actual PASS.

The runtime 6f02 CI found two unchecked type assertions in test fixtures. Test-only commit `872eb89f501cc0deec3b7070f32898f644e9fde4` fixed them; [CI 38809549567](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38809549567) passed. Runtime Security [38808814148](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38808814148) passed. Do not label the original failed CI run as PASS. The final verification SHA also has its own CI/Security results.

Local space at preparation: C approximately 4.77 GiB, D approximately 7.15 GiB. No local large build, full-image download, repeated archive extraction, shared-cache deletion or rollback-asset cleanup was performed in this stage. Small reports/screenshots are saved locally. The complete cloud archive expires **2026-10-29 21:25:27 UTC / 2026-10-30 05:25:27 Asia/Shanghai**; this is temporary retention, not permanent backup. Retrieve one copy when required for the authorized deployment; never rebuild just because acceptance scripts changed.

Final acceptance **38814836926 PASS**, scripts `7c5976dd5b67a203b262471f91a5400cdf2d8be9`; CI **38814835730 PASS**, Security **38814835717 PASS**. Final manifest SHA-256 `65d80ee5639b5133f93355a20610177bd50978e59820aa2b4aabbf9cdbce499a`; its images array is exactly equal to the original build manifest. Evidence Artifact **12009644321** expires **2026-10-29 22:14:38 UTC / 2026-10-30 06:14:38 Asia/Shanghai**.

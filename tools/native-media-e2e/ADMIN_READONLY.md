# One acceptance implementation, two environments

`admin-readonly.cjs` owns the read-only admin diagnostic scenario. Both the
candidate adapter and the production entry call it. It does not generate media,
save drafts, publish, open sales, or change paid state.

The candidate adapter alone prepares an absent-model diagnostic using the
existing **synthetic** Account drafts, then restores their products with CAS.
The collector runs against Core's embedded frontend and actual API, with the
existing Bridge/BFF and simulator. `artifact-assets.cjs` verifies browser JS/CSS
bytes against Core. Image and video each run at 1440 and 390 pixels. The existing
paid-controls generation, pricing, money, recovery and 1,870-spec tests remain.

## Automatic gates

- CI runs `node --test tools/native-media-e2e/admin-readonly.test.cjs`, the
  `acceptance-script.spec.ts` real UI/Axios regression, and the existing diagnostic
  browser tests.
- `candidate.mjs verify` invokes the same collector before writing overall PASS.
  Failure remains failure; sanitized reports and screenshots are retained.
- Candidate export binds the real pre-run reports, screenshots, image identities
  and four script hashes in `manifest.admin_readonly`. Editing a script invalidates
  the evidence. A local UI fixture or old candidate without this proof is rejected.

## Production preparation (existing release guard still applies)

Before maintenance/login, pass JSON on stdin to:

```text
node tools/native-media-e2e/admin-readonly.cjs --verify-candidate
```

Required non-secret fields are `candidate_dir`, independently verified
`manifest_sha256`, and `source_sha`. This mode makes no browser/production request.
Include the verified report, scripts and manifest in the existing release seal.
Preserve tested script bytes (including line endings); do not paste a private copy
or edit them after the pre-run. This gate is wired to this collector entry, not a
claim that every historical deployment script has been upgraded.

After the existing controller has verified actual running images/programs/routes,
the same entry without the flag additionally requires `runtime_proof`, its sealed
`runtime_sha256`, `origin`, `targets` (`account`, `product`), a fresh output directory
`out`, and the official in-memory `token`. Never put tokens on command lines, in
files, reports or saved browser state. The runtime proof uses the existing
`SSH_READBACK_OF_SEALED_RELEASE` schema. Both config digests and their verified OCI
manifest identities are handled; unrelated IDs fail closed.

This collector specifically checks an existing MODEL_NOT_DISCOVERED diagnostic.
If that condition is absent, report that the scenario is inapplicable; do not
create a broken product in production or replace it with an arbitrary click.
Other production acceptance scenarios keep their existing checks.

## What the evidence means

- Node doubles: matcher/order/error/identity gate regression only.
- `acceptance-script.spec.ts`: actual Vue UI and Axios GET interceptor, local HTTP
  responses. It proves timezone and navigation behavior, not server acceptance.
- `native-admin-readonly-proof.json`: only the candidate adapter against healthy,
  pinned real Core/Bridge/BFF can produce the normal candidate pre-run receipt.
- Production read-only PASS is separate from candidate PASS and does not prove a
  paid supplier call. User media generation is outside this collector.

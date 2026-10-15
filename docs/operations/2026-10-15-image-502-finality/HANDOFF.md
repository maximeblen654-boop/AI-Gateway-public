# Image2Pro HTTP 502 customer finality

Status: IMPLEMENTATION_IN_VALIDATION_NOT_DEPLOYED.
Production remains 2bdbe3e8; no production calls or writes in this task.

## Customer contract
The native synchronous OpenAI-compatible Image2Pro API-key path records actual HTTP error evidence before native error translation. Existing exact Image2Pro base recognition is reused (no model-name or Account-ID allowlist). Only an explicit 502 without possible image output gets the new no-charge final unit outcome. Other suppliers, OAuth/Responses, transport failures, timeouts and historical unknown outcomes retain their existing contract. A 502 is NOT evidence of supplier refund.

Existing permanent dispatch claims prevent replay. Private unit outcome/receipt retains status, request ID, sanitized bounded message and error response digest. Final units refuse replacement; final task recovery returns without settlement; result persistence and native billing reject not_charged. Mixed units use existing delivered-quantity settlement once. Customer API receives a fixed failure code, never supplier diagnostics or credentials.

## Historical tasks: proposal only
No historical mutation on deployment, refresh or query. The following receipts and their pre-deployment SHA-256 were verified by the prior read-only investigation and deployment; this task reuses that evidence, not a new production query:

| Task | Request | receipt SHA-256 |
|---|---|---|
| img_246553331bf3e4639ab4adbe94fcccc2 | bdfccad4-adb0-4c1c-a67d-f89c19fc9935 | 6ec8c567030fcc504978a734114a26504e55fe44b3840a62d6ef652e892e6d46 |
| img_66c5f21b1cc78570f98ae244b7ce67a1 | 55bb1465-791b-4783-ab6c-822e3f19a710 | bcfd21f11cc1794710c89c78194df24ba9524fe481ec7bbb316546a3ff110cce |
| img_f372e5916f913ebc4358129c65add930 | c49b9bed-0527-498e-ad5b-8819a2db4073 | c6928ef9f87521a15c5647d3a0df4d353a1f23e41b5b642c041a5075fc524206 |

Prior evidence: each has one native HTTP 502 attempt, no original image or delivery, and no native task settlement. Supplier records strongly correlate but have no shared supplier request identifier; no refund assertion is made from HTTP status. Historical raw response bodies were not preserved. See ../upstream-errors-studio-entry/DEPLOYMENT.md and its read-only investigation evidence.

Separate authorization is needed to finalize these specific historical customer tasks. Before any such remediation, recheck exact receipt/claim/owner/quote hashes, native HTTP status evidence, zero outputs and zero native usage/dedup/settlement, and exclude an active dispatcher/recovery. Preserve originals and claims. Under a bounded exclusive maintenance operation, write an auditable policy-finality outcome tied to the existing request identity; never invent a lost response-body digest or supplier refund. Set only the customer no-charge finality and refresh the derived BFF view. No POST, balance adjustment, deletion or replacement order. If new delivery or settlement evidence exists, skip that task and report. No remediation tool or production action is included here.

## Acceptance
Existing BFF contract suite: 21 PASS. Vue component suite: 51 PASS. Targeted Go HTTP tests (502, partial502, disconnect, timeout, repeated query/restart, owner isolation) PASS. Further CI/security/final-image acceptance pending. Large builds use the existing GitHub-hosted candidate workflow; no local Docker build.

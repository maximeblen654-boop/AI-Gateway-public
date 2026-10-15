# Model lifecycle and per-product isolation

Status: CANDIDATE_READY_NOT_DEPLOYED. Final container acceptance 38814836926 PASS. No production action.

- Admin CAS lifecycle: unlist, explicit validated relist, archive, restore-as-unlisted, hide unconfigured model. Existing Account/Draft/Published products are retained. Model bulk actions reject divergent Draft/Published model identities; explicit product actions show both identities. Archived products stay in save payloads and are excluded from a later explicit publication.
- New publications persist per-product dependency snapshots. Account routing/auth remains mandatory; canonical mapping and catalog membership are scoped to the sold product. A sibling product change does not change a healthy product's frozen quote. Lifecycle revision invalidates old quotes even after relisting.
- Managed paid control stores the shared dependency fingerprint and individually approved offer grants in its existing settings record. Partial failures exclude only affected grants; new/changed offers cannot borrow another grant. Shared permissions/funds/storage failures remain closed. New image/video dispatch checks the exact grant before Claim/Reserve/network. Historical recovery remains unchanged.
- Successful complete native catalog snapshots drive availability. Explicit pagination/partial response flags preserve the previous catalog. Existing failed/empty/malformed responses also preserve the last success. No supplier polling or paid probe was added.
- Customer refresh retains prompt/references/history and never switches models automatically. Missing selected offers clear the old confirmation and require explicit selection and a new quote.

## Compatibility

Legacy Published snapshots without per-product dependencies retain their strict historical dependency comparison. Reading does not silently approve changed dependencies. Their lifecycle changes are supported without reviving old quotes or invalidating archived siblings. Fine-grained catalog/mapping isolation requires explicit native revalidation/publication. Account77 uses the already scoped one-off recovery tool, now emitting per-product dependencies from its original GPT Published only. No current two-product Draft is published.

New lifecycle/Published JSON fields are not readable by old strict decoders. After a production lifecycle write or dependency recovery, do not blindly roll back to 4f/3b. A later authorized deployment must preserve post-write state and use a compatible fixed version; restoring a whole database/config is not a fallback.

## Local evidence

- mediaworkbench package: PASS (including image/video lifecycle and legacy regressions).
- affected service tests: PASS; admin HTTP and repository tests PASS. Partial catalog test fixture was corrected to avoid an unrelated metadata request, then PASS.
- frontend: 137 tests PASS, vue-tsc and changed-file ESLint PASS.
- independent review: four confirmed legacy/identity/hide-restore issues fixed, final code review found no remaining implementation blocker. Final container assertions include relist-before-expiry rejection and history reads after unlisting.
- Account77 existing private offline projection: 1,870 specs PASS; original GPT products/offers, both Draft products/revision/validation unchanged. See account77-offline-recovery.json. This is not a current production write or read.

## Candidate acceptance

Existing GitHub-hosted native-media-candidate workflow, paid-controls focused scope. New model-lifecycle harness uses final Core embedded frontend, real Core/Bridge/BFF/PostgreSQL/Redis, local simulated supplier. It covers same Account and same Group isolation, old quote refusal, admin CAS, unpublished Draft sentinel, original download and native one-time settlement. No Vite/API mocks, no repeat 104-task campaign. Final run 38814836926 PASS; manifest, sanitized reports and screenshots are in this directory.

## Selected publication and accurate status (latest scope)

- The administrator explicitly selects saved product IDs. Only those products are revalidated; unselected Published products, offers and dependency grants remain unchanged. A 53-model catalog does not require 53 configured products. Incomplete or UNKNOWN validation of another saved draft does not block selected validation; uncertain save outcomes and unsaved changes still require resolution.
- Full Draft validation is retained separately from `publish_validation`. A subset PASS is not a whole-Draft PASS. Unselected changed prices remain Draft and are not mislabeled Published.
- Read-only `product_states` explains the actual affected product and repair action. Saved Draft, validation, Published, Account sales and global paid conditions are distinct. Legacy snapshots clearly require controlled original-Published recovery, not implicit approval of changed dependencies.
- Existing standalone API Key/native scheduling is unchanged; protected Studio image restrictions remain. The final isolated harness verifies native requests against the local simulator while the same Studio product is unlisted/not ready, using a separate synthetic customer Key.
- The earlier intermediate run 38805449296 was canceled before acceptance when this scope was added. Its CI found an omitted lifecycle route test entry and test/static lint issues; these are corrected in the final source. It is not an accepted candidate.

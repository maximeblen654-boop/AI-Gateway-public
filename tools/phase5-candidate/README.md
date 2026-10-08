# Frozen Phase 5 cloud candidate, not a release

Application source is **e49b7e0a04682dcd89637c4825c7f9e514964587**. The workflow
commit is a separate identity. Two clean checkouts prevent orchestration changes,
local dependencies, ignored evidence or runtime data from entering the image.
The existing root Dockerfile and `deploy/studio/Dockerfile` are unchanged. The
runner generates a packaging copy that adds only a COPY of the project license,
GNU GPL text, upstream attribution and exact source links to the selected runtime
stage. It records the original inputs and generated recipe hashes separately.

This job accepts only the named public repository, the production-readiness
branch and a standard `ubuntu-24.04` GitHub-hosted runner. Repository contents stay
read-only. Only the candidate job has `packages:write`, using its short-lived
GITHUB_TOKEN in the final push step. No PAT, production secrets, Release, VERSION
write, deployment, external cache export or paid runner is used.

The repository owner explicitly authorized **PUBLIC candidate packages**, not a
production release. Targets are `ghcr.io/maximeblen654-boop/ai-gateway-plan-a-candidate-{core,bridge,bff}`.
Tags contain `candidate-`, the full application SHA, full workflow SHA, run ID and
attempt. There is no `latest` tag. Image labels bind both SHAs and retain attribution.

GitHub requires a dispatch workflow to exist on the default branch before it can
be manually invoked. Without changing `main`, the authorized opt-in fallback is a
push touching this directory or `.github/workflows/phase5-candidate.yml` on
`codex/phase5-production-readiness`, with **[plan-a-candidate:e49b7e0]** in the head
commit message. Ordinary pushes cannot start a candidate build. Do not merge or
dispatch `release.yml`. No automatic retries: diagnose a failed stage before a new
marked change. If this workflow is later reviewed into the default branch, manual
dispatch still requires the same branch and frozen application source.

## Resource and artifact boundary

Preflight requires 25 GiB free disk and 8 GiB available RAM, conservative planning
limits rather than a claimed measured peak. Actual free disk is sampled during
serial builds; below 2 GiB the client stops and the job fails. Insufficient initial
resources stop before building; no runner software/cache purge or larger paid
runner fallback. The runner and its job-only BuildKit cache expire normally.

Buildx exports each result to OCI and loads the identical image into the runner's
Docker engine. The report checks the OCI config digest against the actual Docker
image ID. It records build arguments, input file hashes, versions, local OCI
manifest digest, archive SHA256 and runtime identities. A local OCI manifest
digest is **not** a pushed registry manifest digest.

Before pushing, `audit.py` examines every immutable OCI layer (including files
removed in a later layer), image environment, history and labels. It rejects
runtime/private paths and high-confidence credential signatures, verifies copied
application files against the frozen public checkout, and checks the included
license notices and FFmpeg's redistribution-sensitive nonfree flag. This is a
bounded distribution check coupled with the already reviewed public source, not
a claim that pattern scanning can prove the absence of every possible secret.
Only an image ID that passed both this audit and the existing full smoke can be
pushed. Test container writable layers, env files and databases are never exported.

`registry.mjs push` verifies authenticated pulls by registry digest. A second,
fresh hosted job receives only image identities, uses an empty Docker credential
directory and no package token, and must pull all three images anonymously by
digest. It then runs only startup/health/version/UID/private-root checks on those
pulled images. This separates persistence verification from the first runner's
cache and avoids repeating the complete synthetic suite after publication.

Registry visibility is measured, not assumed. If GitHub initially creates a private
package, anonymous verification fails; retained authorized-upload identities are
still reported, and the owner must use Package settings to set these explicitly
authorized candidate packages Public. Do not create a PAT, bypass access checks,
rebuild, or rerun the candidate build to solve visibility. The separate verification
job can be retried after the actual visibility change, retaining its dependency's
recorded digests. A failed publish remains explicit; do not retry a build blindly.

GHCR container-image storage/bandwidth and standard public hosted runners are
currently free under GitHub's published policy. There is no Actions Artifact
upload and no local download. Do not infer free paid runners or unlimited Actions
Artifact allowances from that policy. Any new fee or permission requirement stops
the affected action. No image is considered publicly persisted until anonymous
digest pulls succeed. No registry mirror or alternate upload route is used.

## Actual image smoke scope

`smoke.mjs` starts the three actual images with fresh synthetic PostgreSQL/Redis
on an **internal** Docker network. Bridge/BFF share the candidate Core's namespace
for authenticated loopback transport. This is an ephemeral harness topology,
not a production deployment recommendation. Host-loopback TCP relays reach the
inspected internal container IP; no external Docker network is attached. This
also avoids relying on published-port NAT for internal-only Docker networks.
The Core may initialize/migrate this newly created disposable database; no restored
database, local volume, old service or production endpoint is used.

Before pushing, the full smoke checks real native login, the actual Bridge's ticket/consume/verify,
the packaged BFF's cookie/CSRF, precise proxy paths, website logout/revoke-all,
non-root private roots, synthetic asset persistence/ownership after BFF restart,
and paid gates OFF. The old issuer/HTTP adapter is a clearly labeled fixture using
the documented ticket record and shipped legacy session adapter against the actual
candidate Core. **It is not the old production BFF/Bridge executable.**

Focused mock-provider recovery/receipt tests also run against modules shipped in
the BFF image, including lost responses and valid original media with differing
geometry. Their PASS is not cross-service billing E2E, supplier generation,
customer browser E2E or a cross-version rollback result. Those gaps and current
production state stay explicitly NOT_RUN/UNKNOWN; prior valid evidence remains
separately attributed. A successful cloud build cannot close production routing,
writer ownership, directory permissions, migration identity or rollback gates.

Status remains **BLOCKED_FOR_RELEASE**. No deployment approval is requested.

References: [manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[standard runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[GHCR billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages),
[package access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility),
[OCI exporters](https://docs.docker.com/build/exporters/oci-docker/).

`COPYING.GPL-3.0` is the unmodified GPLv3 text from
https://www.gnu.org/licenses/gpl-3.0.txt (SHA256
`3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`).
It accompanies the existing LGPL text; this packaging does not change the license
of the application, base images or dependencies.

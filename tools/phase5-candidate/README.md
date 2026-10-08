# Frozen Phase 5 cloud candidate, not a release

Application source is **e49b7e0a04682dcd89637c4825c7f9e514964587**. The workflow
commit is a separate identity. Two clean checkouts prevent orchestration changes,
local dependencies, ignored evidence or runtime data from entering the image.
The existing root Dockerfile and `deploy/studio/Dockerfile` are unchanged.

This job accepts only the named public repository, the production-readiness
branch and a standard `ubuntu-24.04` GitHub-hosted runner. It has read-only repository
permissions, no secrets, registry login, image push, Release, VERSION write,
deployment, external cache export or paid runner selection.

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
digest is **not** a pushed registry manifest digest. No registry exists for these
candidates.

The repository currently has no artifacts, but account-wide shared artifact/
package storage cannot be verified with the available credentials. This workflow
therefore performs **no Artifact upload**. Files survive only until the hosted job
ends: **ARTIFACT_NOT_PERSISTED**, even if **BUILD_PASS**. Sanitized JSON in job logs
and the job summary is the retained evidence; it is not a deployable image.
Do not download archives to the disk-constrained workstation. Persistent OCI
handoff requires separately verifying existing shared usage and a free allowance;
do not assume public-runner minutes imply free unlimited artifact storage.

Public workflow artifacts, if later enabled after that check, would be readable
by signed-in GitHub users with repository read access. Only image archives built
from this clean public checkout plus an explicit metadata allowlist may be stored,
with one-day retention and a measured size cap. Never archive the runner workspace,
synthetic-state, env files, container writable layers or test databases.

## Actual image smoke scope

`smoke.mjs` starts the three actual images with fresh synthetic PostgreSQL/Redis
on an **internal** Docker network. Bridge/BFF share the candidate Core's namespace
for authenticated loopback transport. This is an ephemeral harness topology,
not a production deployment recommendation. Only host-loopback ports are exposed.
The Core may initialize/migrate this newly created disposable database; no restored
database, local volume, old service or production endpoint is used.

The smoke checks real native login, the actual Bridge's ticket/consume/verify,
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
[Actions storage](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts),
[OCI exporters](https://docs.docker.com/build/exporters/oci-docker/).

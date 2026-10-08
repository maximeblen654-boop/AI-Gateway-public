import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPLICATION_SHA, COMPONENTS, assertHosted, buildArguments, withNotices } from './build.mjs';
import { candidateTag, packageName, validateImages } from './registry.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  GITHUB_REPOSITORY: 'maximeblen654-boop/AI-Gateway-public', APPLICATION_SHA,
  RUNNER_TEMP: '/tmp/hosted', GITHUB_WORKSPACE: '/home/runner/work/public' };

test('reject local engines, self-hosted runners, other repositories and mutable application refs', () => {
  assert.doesNotThrow(() => assertHosted(hosted));
  for (const overrides of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Windows' }, { GITHUB_REPOSITORY: 'private/repo' }, { APPLICATION_SHA: 'main' }, { RUNNER_TEMP: '' }]) {
    assert.throws(() => assertHosted({ ...hosted, ...overrides }), /hosted_public_candidate_context_required/);
  }
});

test('builds use frozen public input and local exporters, never registry publication', () => {
  for (const component of COMPONENTS) {
    const args = buildArguments(component, '/frozen-public', '/runner-temp', '2026-10-09T00:00:00Z');
    assert.equal(args.at(-1), '/frozen-public');
    assert(args.includes('linux/amd64'));
    assert(args.includes(component === 'bff' ? `SOURCE_REVISION=${APPLICATION_SHA}` : `COMMIT=${APPLICATION_SHA}`));
    assert(args.includes(`type=oci,dest=${path.join('/runner-temp', `${component}.oci.tar`)}`));
    assert(args.includes('type=docker'));
    assert(!args.some(value => /--push|type=registry|type=gha|--secret|--ssh/.test(value)));
  }
  assert.throws(() => buildArguments('release', '/a', '/b', 'now'), /unknown_component/);
});

test('only the guarded candidate job can write packages, after full smoke and layer audit', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/phase5-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[codex\/phase5-production-readiness\]/);
  assert.match(workflow, /\[plan-a-candidate:e49b7e0\]/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, new RegExp('ref: ' + APPLICATION_SHA));
  assert(!/uses: .*release|contents: write|secrets\.|uses: actions\/upload-artifact|pull_request_target/.test(workflow));
  assert.equal((workflow.match(/packages: write/g) || []).length, 1);
  assert(workflow.indexOf('smoke.mjs') < workflow.indexOf('audit.py'));
  assert(workflow.indexOf('audit.py') < workflow.indexOf('registry.mjs push'));
  const verify = workflow.slice(workflow.indexOf('\n  verify-published:'));
  assert.match(verify, /needs: candidate/);
  assert.match(verify, /registry.mjs verify-public/);
  assert(!/packages:|github.token|REGISTRY_TOKEN:/.test(verify));
});

test('publication names and full source identities cannot target release/latest or another repository', () => {
  const workflow = 'b'.repeat(40);
  const tag = candidateTag(workflow, '123456789', '1');
  assert(tag.startsWith('candidate-' + APPLICATION_SHA));
  assert(tag.includes(workflow)); assert(tag.length <= 128);
  assert.throws(() => candidateTag('main', '1', '1'));
  assert.throws(() => candidateTag(workflow, '$(danger)', '1'));
  assert.throws(() => packageName('latest'));
  const images = COMPONENTS.map(component => ({ component, application_sha: APPLICATION_SHA, workflow_sha: workflow,
    repository: `ghcr.io/maximeblen654-boop/${packageName(component)}`, registry_manifest_digest: 'sha256:' + 'a'.repeat(64), docker_image_id: 'sha256:' + 'c'.repeat(64) }));
  assert.doesNotThrow(() => validateImages(images, workflow));
  assert.throws(() => validateImages(images.slice(1), workflow));
  assert.throws(() => validateImages(images.map((image, i) => i ? image : { ...image, repository: 'ghcr.io/another-owner/release' }), workflow));
  assert.throws(() => validateImages(images.map((image, i) => i ? image : { ...image, application_sha: workflow }), workflow));
});

test('packaging only adds required distribution notices to the selected runtime stage', () => {
  for (const component of COMPONENTS) {
    const original = fs.readFileSync(new URL(component === 'bff' ? '../../deploy/studio/Dockerfile' : '../../Dockerfile', import.meta.url), 'utf8');
    const line = 'COPY --from=candidate-notices / /usr/share/licenses/ai-gateway-candidate/\n';
    const packaged = withNotices(original, component);
    assert.equal(packaged.replace(line, ''), original);
    assert.equal(packaged.split(line).length, 2);
  }
  assert.throws(() => withNotices('FROM scratch\n', 'core'), /entrypoint_changed/);
});

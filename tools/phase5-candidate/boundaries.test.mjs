import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPLICATION_SHA, COMPONENTS, assertHosted, buildArguments } from './build.mjs';

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

test('workflow keeps release permissions, default branch and artifact uploads out of scope', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/phase5-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[codex\/phase5-production-readiness\]/);
  assert.match(workflow, /\[plan-a-candidate:e49b7e0\]/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, new RegExp('ref: ' + APPLICATION_SHA));
  assert(!/uses: .*release|packages: write|contents: write|secrets\.|uses: actions\/upload-artifact|pull_request_target/.test(workflow));
});

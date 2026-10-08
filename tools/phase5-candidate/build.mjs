import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const APPLICATION_SHA = 'e49b7e0a04682dcd89637c4825c7f9e514964587';
export const COMPONENTS = ['core', 'bridge', 'bff'];
const GiB = 1024 ** 3;
const capture = (command, args, options = {}) => execFileSync(command, args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
export function assertHosted(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.RUNNER_OS !== 'Linux' || env.GITHUB_REPOSITORY !== 'maximeblen654-boop/AI-Gateway-public' ||
      env.APPLICATION_SHA !== APPLICATION_SHA || !env.RUNNER_TEMP || !env.GITHUB_WORKSPACE) {
    throw Error('hosted_public_candidate_context_required');
  }
}
export function locations(env = process.env) {
  assertHosted(env);
  return { source: path.join(env.GITHUB_WORKSPACE, 'application'), out: path.join(env.RUNNER_TEMP, 'phase5-candidate') };
}
export function buildArguments(component, source, out, date) {
  if (!COMPONENTS.includes(component)) throw Error('unknown_component');
  const args = ['buildx', 'build', '--platform', 'linux/amd64', '--progress', 'plain',
    '--provenance=false', '--sbom=false', '--label', `org.opencontainers.image.revision=${APPLICATION_SHA}`,
    '--tag', `phase5-candidate-${component}:${APPLICATION_SHA}`,
    '--metadata-file', path.join(out, `${component}.build.json`),
    '--output', `type=oci,dest=${path.join(out, `${component}.oci.tar`)}`,
    '--output', 'type=docker'];
  if (component === 'bff') args.push('--file', path.join(source, 'deploy/studio/Dockerfile'), '--build-arg', `SOURCE_REVISION=${APPLICATION_SHA}`);
  else {
    args.push('--file', path.join(source, 'Dockerfile'), '--build-arg', `COMMIT=${APPLICATION_SHA}`,
      '--build-arg', `DATE=${date}`, '--build-arg', 'GO_BUILD_PARALLELISM=1');
    if (component === 'bridge') args.push('--target', 'studio-bridge');
  }
  return [...args, source];
}
const hashFile = filename => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filename);
  stream.on('data', b => hash.update(b)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
function resources(directory) {
  const stat = fs.statfsSync(directory);
  const memory = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
  return { free_bytes: stat.bavail * stat.bsize, available_memory_bytes: Number(memory?.[1] || 0) * 1024 };
}
async function main(mode) {
  const { source, out } = locations();
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const reportPath = path.join(out, 'report.json');
  if (mode === 'report') {
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath)) : { build: 'NOT_BUILT' };
    if (fs.existsSync(path.join(out, 'smoke.json'))) report.smoke = JSON.parse(fs.readFileSync(path.join(out, 'smoke.json')));
    report.persistence = 'ARTIFACT_NOT_PERSISTED';
    report.persistence_reason = 'ACCOUNT_WIDE_FREE_STORAGE_HEADROOM_UNVERIFIED';
    report.registry_manifest_digest = null;
    report.release_status = 'BLOCKED_FOR_RELEASE';
    report.workflow_sha = process.env.CANDIDATE_WORKFLOW_SHA;
    report.application_sha = APPLICATION_SHA;
    report.run_url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    report.resources_after = resources(out);
    const text = JSON.stringify(report, null, 2);
    console.log('CANDIDATE_REPORT_BEGIN\n' + text + '\nCANDIDATE_REPORT_END');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```json\n' + text + '\n```\n');
    return;
  }
  if (!['preflight', 'build'].includes(mode)) throw Error('unknown_mode');
  if (capture('git', ['rev-parse', 'HEAD'], { cwd: source }) !== APPLICATION_SHA ||
      capture('git', ['status', '--porcelain'], { cwd: source }) !== '') throw Error('frozen_source_identity_mismatch');
  // Runner checkout only. Neither a local working tree nor its ignored data is a build context.
  for (const name of ['.evidence', 'node_modules', 'frontend/node_modules', 'backend/data', 'deploy/data']) {
    if (fs.existsSync(path.join(source, name))) throw Error('unexpected_runtime_or_dependency_input');
  }
  const current = resources(out);
  if (current.free_bytes < 25 * GiB || current.available_memory_bytes < 8 * GiB) throw Error('runner_resource_headroom_insufficient');
  const inputPaths = ['Dockerfile', '.dockerignore', 'deploy/studio/Dockerfile', 'frontend/package.json', 'frontend/pnpm-lock.yaml', 'backend/go.mod', 'backend/go.sum'];
  const inputs = Object.fromEntries(await Promise.all(inputPaths.map(async name => [name, await hashFile(path.join(source, name))])));
  const report = { build: 'NOT_BUILT', platform: 'linux/amd64', inputs, resources_before: current,
    runtime_harness_node: process.version, images: [], build_date: new Date().toISOString() };
  if (mode === 'preflight') { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(current)); return; }
  report.engine = JSON.parse(capture('docker', ['version', '--format', '{{json .Server}}'])).Version;
  report.buildx = capture('docker', ['buildx', 'version']);
  report.minimum_observed_free_bytes = current.free_bytes;
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  save();
  for (const component of COMPONENTS) {
    const args = buildArguments(component, source, out, report.build_date);
    const child = spawn('docker', args, { stdio: 'inherit', detached: true });
    let resourceStop = false;
    const sample = () => {
      const free = resources(out).free_bytes;
      report.minimum_observed_free_bytes = Math.min(report.minimum_observed_free_bytes, free);
      if (free < 2 * GiB && !resourceStop) { resourceStop = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    };
    const interval = setInterval(sample, 5000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearInterval(interval));
    sample();
    if (code !== 0 || resourceStop) { report.build = resourceStop ? 'STOPPED_RESOURCE_FLOOR' : 'BUILD_FAILED'; report.failed_component = component; save(); throw Error(report.build); }
    const image = JSON.parse(capture('docker', ['image', 'inspect', `phase5-candidate-${component}:${APPLICATION_SHA}`]))[0];
    const tar = path.join(out, `${component}.oci.tar`);
    const index = JSON.parse(capture('tar', ['-xOf', tar, 'index.json']));
    const descriptor = index.manifests.find(m => m.mediaType.includes('manifest'));
    if (!descriptor || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw Error('oci_manifest_missing');
    const manifest = JSON.parse(capture('tar', ['-xOf', tar, 'blobs/sha256/' + descriptor.digest.slice(7)]));
    if (manifest.config.digest !== image.Id || image.Config.Labels['org.opencontainers.image.revision'] !== APPLICATION_SHA) throw Error('export_runtime_identity_mismatch');
    const metadata = JSON.parse(fs.readFileSync(path.join(out, `${component}.build.json`)));
    report.images.push({ component, application_sha: APPLICATION_SHA, docker_image_id: image.Id,
      oci_manifest_digest: descriptor.digest, oci_file_sha256: await hashFile(tar), oci_file_bytes: fs.statSync(tar).size,
      registry_manifest_digest: null, build_result_digest: metadata['containerimage.digest'],
      runtime_user: image.Config.User || 'entrypoint drops privileges', build_arguments: args.slice(1), build: 'BUILD_PASS' });
    save();
  }
  report.build = 'BUILD_PASS'; save();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error('candidate_build_error:', error.message); process.exitCode = 1; });
}

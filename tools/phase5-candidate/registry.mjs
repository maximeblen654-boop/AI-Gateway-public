import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APPLICATION_SHA, COMPONENTS, locations } from './build.mjs';

export const OWNER = 'maximeblen654-boop';
export const packageName = component => {
  if (!COMPONENTS.includes(component)) throw Error('unknown_component');
  return `ai-gateway-plan-a-candidate-${component}`;
};
export function candidateTag(workflow, run, attempt) {
  if (!/^[a-f0-9]{40}$/.test(workflow) || !/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw Error('invalid_candidate_identity');
  return `candidate-${APPLICATION_SHA}-${workflow}-${run}-${attempt}`;
}
export function validateImages(images, workflow) {
  if (!Array.isArray(images) || images.length !== 3 || new Set(images.map(i => i.component)).size !== 3) throw Error('incomplete_candidate_set');
  for (const image of images) {
    if (image.application_sha !== APPLICATION_SHA || image.workflow_sha !== workflow ||
        image.repository !== `ghcr.io/${OWNER}/${packageName(image.component)}` ||
        !/^sha256:[a-f0-9]{64}$/.test(image.registry_manifest_digest) ||
        !/^sha256:[a-f0-9]{64}$/.test(image.docker_image_id)) throw Error('untrusted_candidate_binding');
  }
}
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function registryManifest(component, reference, credential) {
  const repository = `${OWNER}/${packageName(component)}`;
  const auth = await fetch('https://ghcr.io/token?' + new URLSearchParams({ service: 'ghcr.io', scope: `repository:${repository}:pull` }), {
    headers: credential ? { Authorization: 'Basic ' + Buffer.from(`${OWNER}:${credential}`).toString('base64') } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!auth.ok) throw Error(`registry_${credential ? 'authorized' : 'anonymous'}_token_http_${auth.status}`);
  const token = (await auth.json()).token;
  if (typeof token !== 'string' || !token) throw Error('registry_token_missing');
  const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`registry_manifest_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = response.headers.get('docker-content-digest');
  if (bytes.length > 1024 * 1024 || digest !== sha(bytes)) throw Error('registry_manifest_integrity_failed');
  const manifest = JSON.parse(bytes);
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest || '') || !Array.isArray(manifest.layers)) throw Error('registry_image_manifest_required');
  return { digest, config: manifest.config.digest, layer_count: manifest.layers.length };
}
async function main(mode) {
  const { out } = locations();
  const workflow = process.env.CANDIDATE_WORKFLOW_SHA;
  if (process.env.GITHUB_REF !== 'refs/heads/codex/phase5-production-readiness' || !/^[a-f0-9]{40}$/.test(workflow)) throw Error('candidate_branch_required');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const configDir = path.join(out, mode === 'push' ? 'registry-auth' : 'registry-anonymous');
  fs.mkdirSync(configDir, { mode: 0o700 });
  const docker = (args, input) => {
    try { return execFileSync('docker', ['--config', configDir, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000 }).trim(); }
    catch { throw Error('registry_docker_operation_failed_' + args[0]); }
  };
  const report = { status: 'NOT_RUN', images: [], application_sha: APPLICATION_SHA, workflow_sha: workflow,
    release_status: 'BLOCKED_FOR_RELEASE', production_cross_version_rollback: 'NOT_RUN' };
  const save = () => fs.writeFileSync(path.join(out, 'registry.json'), JSON.stringify(report, null, 2));
  try {
    if (mode === 'push') {
      const built = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
      const smoke = JSON.parse(fs.readFileSync(path.join(out, 'smoke.json')));
      const audit = JSON.parse(fs.readFileSync(path.join(out, 'audit.json')));
      if (built.build !== 'BUILD_PASS' || built.images.length !== 3 || smoke.status !== 'PASS' || audit.status !== 'PASS') throw Error('prepublication_checks_required');
      const credential = process.env.CANDIDATE_REGISTRY_TOKEN;
      if (!credential) throw Error('workflow_package_token_required');
      const tag = candidateTag(workflow, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
      docker(['login', 'ghcr.io', '--username', OWNER, '--password-stdin'], credential);
      for (const image of built.images) {
        if (audit.images.find(i => i.component === image.component)?.image_id !== image.docker_image_id ||
            smoke.actual_images[image.component] !== image.docker_image_id) throw Error('audited_tested_image_mismatch');
        const repository = `ghcr.io/${OWNER}/${packageName(image.component)}`;
        docker(['tag', image.docker_image_id, `${repository}:${tag}`]);
        // Push only the already audited immutable image. Never docker commit/export.
        docker(['push', `${repository}:${tag}`]);
        const manifest = await registryManifest(image.component, tag, credential);
        if (manifest.config !== image.docker_image_id) throw Error('registry_config_identity_mismatch');
        const saved = { ...image, repository, tag, workflow_sha: workflow, registry_manifest_digest: manifest.digest,
          authorized_pull: 'NOT_RUN', anonymous_pull: 'NOT_RUN' };
        report.images.push(saved); save();
        docker(['pull', '--platform', 'linux/amd64', `${repository}@${manifest.digest}`]);
        const pulled = JSON.parse(docker(['image', 'inspect', `${repository}@${manifest.digest}`]))[0];
        if (pulled.Id !== image.docker_image_id) throw Error('authorized_pull_identity_mismatch');
        saved.authorized_pull = 'PASS'; save();
      }
      report.status = 'AUTHENTICATED_PULL_VERIFIED_PUBLIC_PENDING';
      validateImages(report.images, workflow);
      if (!process.env.GITHUB_OUTPUT) throw Error('job_output_required');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'images=' + JSON.stringify(report.images) + '\n');
    } else if (mode === 'verify-public') {
      if (process.env.CANDIDATE_REGISTRY_TOKEN) throw Error('anonymous_job_must_not_receive_package_token');
      const images = JSON.parse(process.env.CANDIDATE_IMAGES || 'null');
      validateImages(images, workflow);
      // A separate fresh hosted job has no image cache, login or package token.
      for (const image of images) {
        const manifest = await registryManifest(image.component, image.registry_manifest_digest);
        if (manifest.config !== image.docker_image_id || manifest.digest !== image.registry_manifest_digest) throw Error('public_manifest_identity_mismatch');
        docker(['pull', '--platform', 'linux/amd64', `${image.repository}@${manifest.digest}`]);
        const pulled = JSON.parse(docker(['image', 'inspect', `${image.repository}@${manifest.digest}`]))[0];
        if (pulled.Id !== image.docker_image_id || pulled.Config.Labels['org.opencontainers.image.revision'] !== APPLICATION_SHA ||
            pulled.Config.Labels['io.ai-gateway.candidate.workflow-sha'] !== workflow) throw Error('anonymous_pull_identity_mismatch');
        docker(['tag', `${image.repository}@${manifest.digest}`, `phase5-candidate-${image.component}:${APPLICATION_SHA}`]);
        report.images.push({ ...image, anonymous_pull: 'PASS', pulled_image_id: pulled.Id }); save();
      }
      report.status = 'PUBLIC_VERIFIED';
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ build: 'REUSED_SAME_RUN_PERSISTED_IMAGES', images: report.images }));
    } else throw Error('unknown_registry_mode');
  } catch (error) {
    report.status = 'FAIL'; report.error_category = error.message; throw error;
  } finally {
    save();
    // Only this job's short-lived registry credential, not images or runtime data.
    const credentialFile = path.join(configDir, 'config.json');
    if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error('candidate_registry_error:', error.message); process.exitCode = 1; });
}

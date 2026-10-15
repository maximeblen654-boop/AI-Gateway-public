// Bounded GitHub-hosted candidate build. No registry push or deployment credentials.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { withNotices } from '../phase5-candidate/build.mjs'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Linux')
assert.equal(process.env.GITHUB_REPOSITORY, 'maximeblen654-boop/AI-Gateway-public')
const paidControls = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'paid-controls'
const focusedEntry = paidControls && process.env.NATIVE_FOCUSED_ENTRY === 'true'
const acceptanceScope = focusedEntry ? 'studio-entry-and-image-502-finality' : 'paid-controls'
const adminReview = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'admin-ui-review'
assert.equal(process.env.GITHUB_REF, paidControls ? 'refs/heads/codex/media-paid-controls' : adminReview ? 'refs/heads/codex/admin-media-design-review' : 'refs/heads/codex/studio-native-media')
const adminCandidate = adminReview && process.env.NATIVE_EXPORT_CANDIDATE === 'true'
if (adminReview && !adminCandidate) assert(['build', 'verify'].includes(process.argv[2]), 'Implementation review cannot export a production candidate')
const scriptSha = process.env.GITHUB_SHA
assert.match(scriptSha, /^[a-f0-9]{40}$/)
const sha = process.env.NATIVE_CANDIDATE_SOURCE_SHA || scriptSha
assert.match(sha, /^[a-f0-9]{40}$/)
const source = path.resolve(process.env.NATIVE_CANDIDATE_SOURCE_DIR || process.cwd())
const mediaOptions = focusedEntry && fs.existsSync(path.join(source, 'backend/internal/service/studio_passive_status.go'))
const workspaceArtifact = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'studio-workspace'
if (workspaceArtifact) assert.equal(sha, '40310e2961a5e8150e0c9df4cc86bb8087406c06')
const reuseSha = 'b2fcdac93afa6ae194ee81801a9b37813f8f39eb'
const reuseDir = process.env.NATIVE_REUSE_ARTIFACT_DIR
const reused = {
  bridge: { id: 'sha256:dd01aa29e152f589679e5065037459240aeb8ddfe3ec853c16033006fe67acda', sha256: '30ba9310b18f1da057d9d7515d5d4eddea15c32077c234c848a2cbf36c9b4b35' },
  bff: { id: 'sha256:e498b97225bfc15e286af26bff30ec5c8d84526adfdbcd8231ebf7bad50e3f21', sha256: '29a1da9fa2ee0229cc352a0bbda2dbaa11735f80f291f65dc7f36a8dac6402f7' }
}
const reuseSidecars = workspaceArtifact || adminReview
if (adminReview && !adminCandidate) assert.equal(sha, scriptSha, 'Review must test its exact source')
const componentSource = c => reuseSidecars && c !== 'core' ? reuseSha : sha
const draftManagement = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'draft-management'
const out = path.join(process.env.RUNNER_TEMP, 'native-candidate-output')
const root = path.join(process.env.RUNNER_TEMP, 'native-media-20261012')
const recipes = path.join(root, 'recipes')
const evidence = path.join(root, 'evidence')
const components = ['core', 'bridge', 'bff']
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const tag = c => `native-candidate-${c}:${componentSource(c)}`
const dc = args => run('docker', ['compose', '-p', 'ai-gateway-native-20261012', '-f', path.join(root, 'compose.json'), ...args])
const space = min => {
  const stat = fs.statfsSync(process.env.RUNNER_TEMP)
  assert(stat.bavail * stat.bsize >= min * 1024 ** 3, `candidate needs ${min} GiB free`)
}
const hash = async file => {
  const h = createHash('sha256')
  for await (const b of fs.createReadStream(file)) h.update(b)
  return h.digest('hex')
}
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(recipes, { recursive: true })
fs.mkdirSync(evidence, { recursive: true })
const mode = process.argv[2]
if (mode === 'load-existing') {
  assert(paidControls && !reuseSidecars)
  space(10)
  const dir=path.resolve(process.argv[3]), manifestPath=path.join(dir,'manifest.json')
  const prior=JSON.parse(fs.readFileSync(manifestPath,'utf8'))
  assert.equal(prior.source_sha,sha);assert.equal(prior.production_action,false);assert.equal(prior.acceptance_scope,acceptanceScope)
  assert.deepEqual(prior.images.map(i=>i.component).sort(),[...components].sort())
  for(const i of prior.images){
    assert.equal(i.source_sha,sha);assert.equal(i.tag,tag(i.component));assert.equal(path.basename(i.tar),i.tar)
    const archive=path.join(dir,i.tar);assert.equal(await hash(archive),i.sha256)
    const identity=JSON.parse(capture('python3',['tools/native-media-e2e/archive-identity.py',archive,i.image_id]))
    assert.deepEqual(identity,i.archive_identity)
    run('docker',['load','--input',archive])
    const loaded=JSON.parse(capture('docker',['image','inspect',i.tag]))[0]
    assert.equal(loaded.Id,i.image_id);assert.equal(loaded.Id,i.config_digest)
    assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'],sha);assert.equal(`${loaded.Os}/${loaded.Architecture}`,'linux/amd64')
  }
  fs.writeFileSync(path.join(out,'manifest-tested-candidate.json'),JSON.stringify(prior,null,2))
  fs.writeFileSync(path.join(out,'reuse-existing.json'),JSON.stringify({source_sha:sha,original_manifest_sha256:await hash(manifestPath),original_build_run:prior.build_run_id,acceptance_script_sha:scriptSha,acceptance_run_id:process.env.GITHUB_RUN_ID,rebuild:false,reexport:false},null,2))
} else if (mode === 'build') {
  // Estimated peak includes Go cache, image layers, test dependencies and exports.
  space(30)
  assert.equal(capture('git', ['-C', source, 'rev-parse', 'HEAD']), sha)
  assert.equal(capture('git', ['-C', source, 'status', '--porcelain']), '', 'runtime source must be clean')
  if (reuseSidecars) {
    const reuseSource = process.env.NATIVE_REUSE_SOURCE_DIR
    assert.equal(capture('git', ['-C', reuseSource, 'rev-parse', 'HEAD']), reuseSha)
    const backendChanges = []
    if (adminCandidate) {
      const tree = dir => new Map(capture('git', ['-C', dir, 'ls-tree', '-r', 'HEAD', 'backend']).split('\n').map(line => { const [meta, file] = line.split('\t'); return [file, meta.split(' ')[2]] }))
      const current = tree(source), prior = tree(reuseSource)
      const allowed = new Set(['backend/internal/mediaworkbench/runtime.go', 'backend/internal/mediaworkbench/validator.go', 'backend/internal/mediaworkbench/video_runtime.go', 'backend/internal/mediaworkbench/validator_test.go', 'backend/internal/mediaworkbench/positive_price_test.go', 'backend/internal/service/studio_image_contract_test.go'])
      for (const file of new Set([...current.keys(), ...prior.keys()])) if (current.get(file) !== prior.get(file)) {
        assert(allowed.has(file), `unreviewed backend difference blocks b2 reuse: ${file}`)
        backendChanges.push({ path: file, current: current.get(file), prior: prior.get(file) || null })
      }
    }
    const inputs = [...(adminCandidate ? [] : ['backend']), 'studio', 'deploy/studio', 'Dockerfile', '.dockerignore', 'tools/phase5-candidate/build.mjs', 'LICENSE', 'tools/phase5-candidate/COPYING.GPL-3.0']
    const equalTrees = inputs.map(p => {
      const current = capture('git', ['-C', source, 'rev-parse', `HEAD:${p}`])
      const prior = capture('git', ['-C', reuseSource, 'rev-parse', `HEAD:${p}`])
      assert.equal(current, prior, `sidecar build/runtime input changed: ${p}`)
      return { path: p, git_object: current }
    })
    assert.equal(await hash(path.join(reuseDir, 'manifest.json')), '8dc340dd2acdfe7c5fb7861d5730ad394ef3ee5d4163187cd9ca7d1f65f2bc9b')
    const old = JSON.parse(fs.readFileSync(path.join(reuseDir, 'manifest.json'), 'utf8'))
    assert.equal(old.source_sha, reuseSha)
    for (const c of ['bridge', 'bff']) {
      const entry = old.images.find(i => i.component === c)
      assert.equal(entry.image_id, reused[c].id)
      assert.equal(entry.sha256, reused[c].sha256)
      assert.equal(entry.tar, `${c}-${reuseSha}.tar.gz`)
      assert.equal(await hash(path.join(reuseDir, entry.tar)), entry.sha256)
      run('docker', ['load', '-i', path.join(reuseDir, entry.tar)])
      const loaded = JSON.parse(capture('docker', ['image', 'inspect', tag(c)]))[0]
      assert.equal(loaded.Id, entry.image_id)
      assert.equal(`${loaded.Os}/${loaded.Architecture}`, 'linux/amd64')
      assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'], reuseSha)
    }
    fs.writeFileSync(path.join(out, 'reuse-proof.json'), JSON.stringify({ source_sha: sha, reused_source_sha: reuseSha, original_run: 38443205417, original_artifact: 11836997249, equal_inputs: equalTrees, core_only_price_changes: backendChanges, bridge_price_boundary: 'Bridge forwards catalog/quote/submit to Core; it uses ImageBindingVersion but does not call mediaworkbench Validate, Publish or ResolvePublished*Offer. cmd/studio-bridge, internal/studiobridge, service/repository implementation, locks and HTTP contracts remain byte-identical. Combination acceptance verifies the exact reused binaries.', bridge_frontend_boundary: 'The studio-bridge target compiles cmd/studio-bridge without the embed tag and copies only its binary. Frontend resources are only shipped in Core.', original_acceptance_run: 38446164266, strategy: 'Build Core only; preserve sidecar archive bytes, labels and original identities.' }, null, 2))
  }
  const notices = path.join(root, 'notices')
  fs.mkdirSync(notices, { recursive: true })
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(notices, 'COPYING.LESSER'))
  fs.copyFileSync(path.join(source, 'tools/phase5-candidate/COPYING.GPL-3.0'), path.join(notices, 'COPYING'))
  fs.writeFileSync(path.join(notices, 'NOTICE.txt'), `Non-production AI-Gateway candidate derived from Sub2API; LGPL-3.0-or-later.\nComplete corresponding source and dependency locks: https://github.com/maximeblen654-boop/AI-Gateway-public/tree/${sha}\nBuild recipes and native-media-e2e tools are included in that source. Alpine package versions/licenses are recorded in /lib/apk/db/installed; package sources: https://gitlab.alpinelinux.org/alpine/aports .\n`)
  for (const c of (reuseSidecars ? ['core'] : components)) {
    space(10)
    const recipe = path.join(recipes, `${c}.Dockerfile`)
    fs.writeFileSync(recipe, withNotices(fs.readFileSync(path.join(source, c === 'bff' ? 'deploy/studio/Dockerfile' : 'Dockerfile'), 'utf8'), c))
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--provenance=false',
      '--metadata-file', path.join(out, `${c}-build-metadata.json`), '--build-context', `candidate-notices=${notices}`, '--label', `org.opencontainers.image.revision=${sha}`,
      '--label', 'org.opencontainers.image.source=https://github.com/maximeblen654-boop/AI-Gateway-public',
      '--label', 'org.opencontainers.image.licenses=LGPL-3.0-or-later',
      '--build-arg', `COMMIT=${sha}`, '--build-arg', `SOURCE_REVISION=${sha}`,
      '--build-arg', 'GOPROXY=https://proxy.golang.org,direct', '--build-arg', 'GOSUMDB=sum.golang.org',
      '--build-arg', 'GO_BUILD_PARALLELISM=1', ...(c === 'bridge' ? ['--target', 'studio-bridge'] : []),
      '-f', recipe, '-t', tag(c), source])
  }
} else if (mode === 'verify') {
  space(10)
  const compose = JSON.parse(fs.readFileSync('tools/native-media-e2e/compose.synthetic.json', 'utf8'))
  for (const c of components) compose.services[c].image = tag(c)
  if (workspaceArtifact || adminReview || paidControls) {
    process.env.NATIVE_WORKSPACE_UI = 'true'
    process.env.NATIVE_WORKSPACE_ARTIFACT = 'true'
    process.env.NATIVE_WORKSPACE_DEV_SERVER = 'false'
  }
  if (paidControls) {
    for (const c of components) Object.assign(compose.services[c].environment, {STUDIO_PAID_CONTROL_MODE:'managed-v1',STUDIO_IMAGE_PUBLISHED_SUBMISSION:'false',STUDIO_VIDEO_ACCOUNT_SUBMISSION:'false',IMAGE_RECEIPT_WORKER_ENABLED:'false'})
    compose.services.core.environment.GATEWAY_RESPONSE_HEADER_TIMEOUT='20'
    compose.services.core.environment.GATEWAY_OPENAI_RESPONSE_HEADER_TIMEOUT='20'
    compose.services.core.environment.STUDIO_CONTROL_BFF_URL='http://127.0.0.1:4173'
  }
  if (draftManagement || workspaceArtifact || adminReview || paidControls) compose.services.simulator.environment.NATIVE_RESULT_ORIGIN = 'https://203.0.113.10:19090'
  if(focusedEntry){compose.services.core.extra_hosts={'api.image2pro.top':'127.0.0.1'};compose.services.simulator.environment.NATIVE_IMAGE_FINALITY='true'}
  fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify(compose))
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.copyFileSync('tools/native-media-e2e/simulator.mjs', path.join(root, 'runtime/simulator.mjs'))
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', (draftManagement || workspaceArtifact || adminReview || paidControls) ? 'subjectAltName=DNS:localhost,DNS:api.image2pro.top,IP:203.0.113.10' : 'subjectAltName=DNS:localhost', '-keyout', path.join(evidence, 'simulator-key.pem'), '-out', path.join(evidence, 'simulator-cert.pem')])
  fs.copyFileSync(path.join(evidence, 'simulator-cert.pem'), path.join(evidence, 'simulator-ca.crt'))
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(evidence, 'synthetic-original.mp4')])
  dc(['up', '-d', '--wait', '--wait-timeout', '180', 'core'])
  if (draftManagement || workspaceArtifact || adminReview || paidControls) {
    // Existing accept-existing harness: the documented result address is local
    // to this synthetic Core namespace, never a real supplier destination.
    const pid = capture('docker', ['inspect', '--format', '{{.State.Pid}}', 'ai-gateway-native-core-20261012'])
    assert.match(pid, /^[1-9][0-9]*$/)
    run('sudo', ['nsenter', '-t', pid, '-n', 'ip', 'addr', 'add', '203.0.113.10/32', 'dev', 'lo'])
    assert.match(capture('sudo', ['nsenter', '-t', pid, '-n', 'ip', 'route', 'get', '203.0.113.10']), /local 203\.0\.113\.10 dev lo/)
  }
  run('docker', ['exec', '-i', 'ai-gateway-native-postgres-20261012', 'psql', '-U', 'native', '-d', 'sub2api', '-v', 'ON_ERROR_STOP=1'],
    { input: fs.readFileSync('backend/internal/repository/testdata/studio_video_orders_legacy.sql'), stdio: ['pipe', 'inherit', 'inherit'] })
  dc(['run', '--rm', '--no-deps', '--user', '0', '--entrypoint', 'sh', 'bff', '-c', 'chown -R 1000:1000 /state && chmod 700 /state/assets /state/images /state/videos'])
  dc(['up', '-d', '--wait', '--wait-timeout', '180'])
  const proxy = spawn(process.execPath, ['tools/native-media-e2e/proxy.mjs'], { stdio: 'inherit' })
  try {
    // Wait for loopback proxy before starting any browser.
    for (let i = 0; i < 20; i++) {
      if (await fetch('http://127.0.0.1:28100/health').then(r => r.ok).catch(() => false)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (paidControls) {
      assert.equal(await fetch('http://127.0.0.1:4295/').then(()=>true).catch(()=>false),false)
      for (const script of (focusedEntry ? ['seed.mjs'] : ['seed.mjs','customer-keys.mjs'])) run(process.execPath,[`tools/native-media-e2e/${script}`,root])
      run(process.execPath,['tools/native-media-e2e/paid-controls.cjs',root,'seed'])
      run(process.execPath,['tools/native-media-e2e/browser.cjs',root,'--image-geometry'])
      run(process.execPath,['tools/native-media-e2e/browser.cjs',root,'--video-compatible'])
      const fixture=JSON.parse(fs.readFileSync(path.join(evidence,'fixture.json'),'utf8'))
      compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID=String(fixture.groups.openai)
      fs.writeFileSync(path.join(root,'compose.json'),JSON.stringify(compose))
      dc(['up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','90','bridge'])
      if (focusedEntry) run(process.execPath,['tools/native-media-e2e/studio-entry.cjs',root,'before'])
      if (mediaOptions) run(process.execPath,['tools/native-media-e2e/aspect-options.cjs',root,'configure'])
      run(process.execPath,['tools/native-media-e2e/paid-controls.cjs',root,'verify'])
      if (mediaOptions) run(process.execPath,['tools/native-media-e2e/aspect-options.cjs',root,'execute'])
      for (const scenario of ['image-geometry-1k','edit-geometry-2k','video-compatible']) run(process.execPath,['tools/native-media-e2e/customer.cjs',root,scenario])
      run(process.execPath,['tools/native-media-e2e/task-experience.cjs',root])
      if (focusedEntry) run(process.execPath,['tools/native-media-e2e/studio-entry.cjs',root,'verify'])
      else run(process.execPath,['tools/native-media-e2e/funds-batch.cjs',root])
      if(focusedEntry) run(process.execPath,['tools/native-media-e2e/image-finality.cjs',root])
      if (mediaOptions) run(process.execPath,['tools/native-media-e2e/passive-status.cjs',root])
      run(process.execPath,['tools/native-media-e2e/paid-controls.cjs',root,'close'])
      if (!focusedEntry) run(process.execPath,['tools/native-media-e2e/paid-controls.cjs',root,'scale'])
      // The old d893 baseline has no sample-evidence UI; require it for repaired sources.
      if(!focusedEntry && fs.readFileSync(path.join(source,'frontend/src/views/admin/ops/components/OpsDashboardHeader.vue'),'utf8').includes('ops-sla-samples')) run(process.execPath,['tools/native-media-e2e/ops-evidence.cjs',root])
    } else if (adminReview) {
      assert.equal(await fetch('http://127.0.0.1:4295/').then(() => true).catch(() => false), false)
      for (const script of ['seed.mjs', 'customer-keys.mjs']) run(process.execPath, [`tools/native-media-e2e/${script}`, root])
      run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--image-geometry'])
      run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--video-compatible'])
      const fixture = JSON.parse(fs.readFileSync(path.join(evidence, 'fixture.json'), 'utf8'))
      compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID = String(fixture.groups.openai)
      fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify(compose))
      dc(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '90', 'bridge'])
      const failures = []
      const check = (label, args, options) => {
        try { run(process.execPath, args, options); return true }
        catch (error) { failures.push({ scenario: label, error: error.message }); return false }
      }
      for (const scenario of ['image-geometry-1k', 'edit-geometry-2k', 'image-geometry-4k', 'video-compatible']) check(scenario, ['tools/native-media-e2e/customer.cjs', root, scenario])
      const adminPassed = check('admin-ui', ['tools/native-media-e2e/admin-ui-review.cjs', root])
      if (adminPassed) check('positive-retail-boundaries', ['tools/native-media-e2e/positive-retail.cjs', root])
      // Independent quote dependency cases continue even if another UI assertion fails.
      for (const change of ['draft', 'published', 'mapping', 'routing']) check('quote-'+change, ['tools/native-media-e2e/customer.cjs', root, 'image-geometry-2k'], {env:{...process.env,NATIVE_QUOTE_DRIFT:change}})
      fs.writeFileSync(path.join(out, 'admin-review-suite.json'), JSON.stringify({ failures, positive_retail: adminPassed ? 'run' : 'blocked by admin fixture setup' }, null, 2))
      assert.equal(failures.length, 0, JSON.stringify(failures))
    } else if (workspaceArtifact) {
      assert.equal(await fetch('http://127.0.0.1:4295/').then(() => true).catch(() => false), false, 'Vite must not be running')
      for (const script of ['seed.mjs', 'customer-keys.mjs']) run(process.execPath, [`tools/native-media-e2e/${script}`, root])
      run(process.execPath, ['tools/native-media-e2e/draft-management.cjs', root, 'seed'])
      for (const scenario of ['image', 'edit', 'video-compatible']) run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, scenario])
      run(process.execPath, ['tools/native-media-e2e/workspace-artifact.cjs', root])
      fs.writeFileSync(path.join(out, 'combination.json'), JSON.stringify({ scope: 'isolated-only; not a production compose', runtime_source_sha: sha, script_sha: scriptSha, frontend: 'Core embedded resources through loopback proxy', vite: false, browser_api_mocking: false, services: Object.fromEntries(Object.entries(compose.services).map(([name, c]) => [name, { image: c.image, network_mode: c.network_mode, ports: c.ports, volumes: c.volumes, depends_on: c.depends_on }])) }, null, 2))
    } else if (draftManagement) {
      for (const script of ['seed.mjs', 'customer-keys.mjs']) run(process.execPath, [`tools/native-media-e2e/${script}`, root])
      run(process.execPath, ['tools/native-media-e2e/draft-management.cjs', root, 'seed'])
      // Two existing non-paid customer paths provide real completed tasks,
      // originals and native billing rows to protect during draft operations.
      for (const scenario of ['image', 'video-compatible']) run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, scenario])
      run(process.execPath, ['tools/native-media-e2e/draft-management.cjs', root, 'verify'])
      run(process.execPath, ['tools/native-media-e2e/draft-management.cjs', root, 'check-preserved'])
    } else {
    for (const script of ['seed.mjs', 'customer-keys.mjs', 'browser.cjs']) run(process.execPath, [`tools/native-media-e2e/${script}`, root])
    run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--video'])
    for (const scenario of ['image', 'edit', 'video']) run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, scenario])
    // The existing Bridge has one configured customer Group. Use the real
    // OpenAI fixture Group/key for this scenario; do not bypass Group checks
    // or attach the Account to an unrelated platform merely for the test.
    const fixture = JSON.parse(fs.readFileSync(path.join(evidence, 'fixture.json'), 'utf8'))
    assert(Number.isSafeInteger(fixture.groups.openai) && fixture.groups.openai > 0)
    compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID = String(fixture.groups.openai)
    fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify(compose))
    dc(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '90', 'bridge'])
    run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--image-geometry'])
    for (const scenario of ['image-geometry-1k','image-geometry-2k','image-geometry-4k','edit-geometry-1k','edit-geometry-2k','edit-geometry-4k','image-geometry-independent']) run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, scenario])
    }
    fs.writeFileSync(path.join(out, 'combination.json'), JSON.stringify({ scope: 'isolated synthetic acceptance only; do not deploy this configuration', source_sha: sha, script_sha: scriptSha, frontend: 'Core embedded resources', vite: false, browser_api_mocking: false, services: Object.fromEntries(Object.entries(compose.services).map(([name,c])=>[name,{image:c.image,network_mode:c.network_mode,ports:c.ports,volumes:c.volumes,depends_on:c.depends_on}])) }, null, 2))
    const containers = JSON.parse(capture('docker', ['inspect', ...components.map(c => `ai-gateway-native-${c}-20261012`)]))
    for (const container of containers) {
      assert.equal(container.State.Health.Status, 'healthy')
      assert.equal(container.Image, JSON.parse(capture('docker', ['image', 'inspect', container.Config.Image]))[0].Id)
    }
    assert.equal(containers[1].HostConfig.NetworkMode, `container:${containers[0].Id}`)
    assert.equal(containers[2].HostConfig.NetworkMode, `container:${containers[0].Id}`)
    const runtimeFiles = components.map(c => {
      const file = c === 'core' ? '/app/sub2api' : c === 'bridge' ? '/app/studio-bridge' : '/app/studio/bff/image-server.mjs'
      const container = `ai-gateway-native-${c}-20261012`
      return { component: c, source_sha: componentSource(c), path: file, bytes: Number(capture('docker', ['exec', container, 'stat', '-c', '%s', file])), sha256: capture('docker', ['exec', container, 'sha256sum', file]).split(' ')[0] }
    })
    fs.writeFileSync(path.join(out, 'runtime-files.json'), JSON.stringify({ source_sha: sha, files: runtimeFiles }, null, 2))
    fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify({ source_sha: sha, script_sha: scriptSha, scope: paidControls ? acceptanceScope : adminCandidate ? 'admin-media-candidate' : adminReview ? 'admin-ui-implementation-review-not-candidate' : workspaceArtifact ? 'studio-workspace-artifact' : draftManagement ? 'draft-management' : 'standard', status: 'PASS', containers: containers.map(c => ({ name: c.Name, image: c.Image, health: c.State.Health.Status, network: c.HostConfig.NetworkMode, mounts: c.Mounts.map(m => ({ type: m.Type, destination: m.Destination, rw: m.RW })) })) }, null, 2))
    const priorManifest=path.join(out,'manifest-tested-candidate.json')
    if(paidControls && fs.existsSync(priorManifest)){
      const prior=JSON.parse(fs.readFileSync(priorManifest,'utf8'))
      fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({...prior,acceptance:'PASS',deployment_state:'CANDIDATE_READY_NOT_DEPLOYED',acceptance_run_id:process.env.GITHUB_RUN_ID,acceptance_script_sha:scriptSha},null,2))
    }
  } finally {
    proxy.kill()
    for (const name of fs.readdirSync(evidence).filter(n => /^native-.*\.(png|json|csv)$/.test(n))) fs.copyFileSync(path.join(evidence, name), path.join(out, name))
  }
} else if (mode === 'export') {
  if (adminCandidate && fs.existsSync(path.join(out, 'acceptance.json'))) run(process.execPath, ['tools/native-media-e2e/check-admin-review.mjs', out])
  const acceptance = fs.existsSync(path.join(out, 'acceptance.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'acceptance.json'))) : { source_sha: sha, status: 'NOT_PASSED' }
  assert.equal(acceptance.source_sha, sha)
  const images = []
  for (const c of components) {
    space(10)
    const image = JSON.parse(capture('docker', ['image', 'inspect', tag(c)]))[0]
    assert.equal(`${image.Os}/${image.Architecture}`, 'linux/amd64')
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], componentSource(c))
    const name = `${c}-${componentSource(c)}.tar`
    if (reuseSidecars && c !== 'core') {
      assert.equal(image.Id, reused[c].id)
      fs.copyFileSync(path.join(reuseDir, `${name}.gz`), path.join(out, `${name}.gz`))
      assert.equal(await hash(path.join(out, `${name}.gz`)), reused[c].sha256)
    } else {
      run('docker', ['save', '-o', path.join(out, name), tag(c)])
      run('gzip', ['-1', path.join(out, name)])
    }
    const file = `${name}.gz`
    const archiveIdentity = JSON.parse(capture('python3', ['tools/native-media-e2e/archive-identity.py', path.join(out, file), image.Id]))
    images.push({ archive_identity: archiveIdentity, component: c, source_sha: componentSource(c), disposition: reuseSidecars && c !== 'core' ? 'reused' : 'built', image_id: image.Id, config_digest: image.Id, run_id: reuseSidecars && c !== 'core' ? '38443205417' : process.env.GITHUB_RUN_ID, artifact: reuseSidecars && c !== 'core' ? { id: '11836997249', name: `native-media-candidate-${reuseSha}` } : { name: `native-media-candidate-${sha}` }, platform: 'linux/amd64', tag: tag(c), tar: file, sha256: await hash(path.join(out, file)), bytes: fs.statSync(path.join(out, file)).size })
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ source_sha: sha, build_run_id: process.env.GITHUB_RUN_ID, acceptance_run_id: process.env.GITHUB_RUN_ID, deployment_state: acceptance.status === 'PASS' ? 'CANDIDATE_READY_NOT_DEPLOYED' : 'CANDIDATE_NOT_ACCEPTED', required_production_flags: { STUDIO_IMAGE_PUBLISHED_SUBMISSION: false, STUDIO_VIDEO_ACCOUNT_SUBMISSION: false, IMAGE_RECEIPT_WORKER_ENABLED: false }, build_script_sha: scriptSha, acceptance_script_sha: scriptSha, acceptance_scope: paidControls ? acceptanceScope : adminCandidate ? 'admin-media-candidate' : adminReview ? 'admin-ui-implementation-review-not-candidate' : workspaceArtifact ? 'studio-workspace-artifact' : draftManagement ? 'draft-management' : 'standard', production_action: false, acceptance: acceptance.status, images }, null, 2))
} else throw Error('choose build, verify or export')

// Verify an already-exported non-production candidate. This path loads the
// exact image TARs from a prior candidate artifact and never rebuilds them.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Linux')
assert.equal(process.env.GITHUB_REPOSITORY, 'maximeblen654-boop/AI-Gateway-public')
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/studio-native-media')
const scriptSha = process.env.GITHUB_SHA
assert.match(scriptSha, /^[a-f0-9]{40}$/)
const candidateSha = process.env.NATIVE_CANDIDATE_SOURCE_SHA
assert.equal(candidateSha, '64d9b523520f087cea31a216e7db65e64605ff7b')
const artifactDir = path.resolve(process.argv[2] || '')
assert(artifactDir && fs.existsSync(path.join(artifactDir, 'manifest.json')), 'candidate artifact directory is required')
const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'))
assert.equal(manifest.source_sha, candidateSha)
assert.equal(manifest.production_action, false)
assert.equal(manifest.acceptance, 'PASS')
assert.equal(manifest.images.length, 3)
const root = path.join(process.env.RUNNER_TEMP, 'native-media-20261012')
const evidence = path.join(root, 'evidence')
const out = path.join(process.env.RUNNER_TEMP, 'native-existing-acceptance-output')
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const dc = args => run('docker', ['compose', '-p', 'ai-gateway-native-20261012', '-f', path.join(root, 'compose.json'), ...args])
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
fs.mkdirSync(evidence, { recursive: true })
fs.mkdirSync(out, { recursive: true })
for (const image of manifest.images) {
  const tar = path.join(artifactDir, image.tar)
  assert(fs.existsSync(tar), `missing ${image.tar}`)
  assert.equal(hash(tar), image.sha256, `${image.tar} checksum mismatch`)
  run('docker', ['load', '--input', tar])
  const loaded = JSON.parse(capture('docker', ['image', 'inspect', image.tag]))[0]
  assert.equal(loaded.Id, image.image_id, `${image.component} image identity mismatch`)
  assert.equal(`${loaded.Os}/${loaded.Architecture}`, 'linux/amd64')
}
const compose = JSON.parse(fs.readFileSync('tools/native-media-e2e/compose.synthetic.json', 'utf8'))
for (const image of manifest.images) compose.services[image.component].image = image.tag
fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify(compose))
fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
fs.copyFileSync('tools/native-media-e2e/simulator.mjs', path.join(root, 'runtime/simulator.mjs'))
run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(evidence, 'simulator-key.pem'), '-out', path.join(evidence, 'simulator-cert.pem')])
fs.copyFileSync(path.join(evidence, 'simulator-cert.pem'), path.join(evidence, 'simulator-ca.crt'))
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(evidence, 'synthetic-original.mp4')])
let proxy
try {
  dc(['up', '-d', '--wait', '--wait-timeout', '180', 'core'])
  run('docker', ['exec', '-i', 'ai-gateway-native-postgres-20261012', 'psql', '-U', 'native', '-d', 'sub2api', '-v', 'ON_ERROR_STOP=1'], { input: fs.readFileSync('backend/internal/repository/testdata/studio_video_orders_legacy.sql'), stdio: ['pipe', 'inherit', 'inherit'] })
  dc(['run', '--rm', '--no-deps', '--user', '0', '--entrypoint', 'sh', 'bff', '-c', 'chown -R 1000:1000 /state && chmod 700 /state/assets /state/images /state/videos'])
  dc(['up', '-d', '--wait', '--wait-timeout', '180'])
  proxy = spawn(process.execPath, ['tools/native-media-e2e/proxy.mjs'], { stdio: 'inherit' })
  for (let i = 0; i < 30; i++) {
    if (await fetch('http://127.0.0.1:28100/health').then(r => r.ok).catch(() => false)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert(await fetch('http://127.0.0.1:28100/health').then(r => r.ok), 'same-origin proxy did not become healthy')
  run(process.execPath, ['tools/native-media-e2e/seed.mjs', root])
  run(process.execPath, ['tools/native-media-e2e/customer-keys.mjs', root])
  run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--video-compatible'])
  run(process.execPath, ['tools/native-media-e2e/browser.cjs', root, '--video-seedance'])
  run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, 'video-compatible'])
  run(process.execPath, ['tools/native-media-e2e/customer.cjs', root, 'video-seedance'])
  const reports = ['video-compatible', 'video-seedance'].map(s => JSON.parse(fs.readFileSync(path.join(evidence, `native-customer-${s}.json`), 'utf8')))
  assert(reports.every(r => r.pass && r.downloads.length === 1), 'video acceptance did not deliver one original')
  const state = JSON.parse(fs.readFileSync(path.join(evidence, 'native-supplier-state.json'), 'utf8'))
  assert.equal(state.video_posts, 2)
  const containers = JSON.parse(capture('docker', ['inspect', 'ai-gateway-native-core-20261012', 'ai-gateway-native-bridge-20261012', 'ai-gateway-native-bff-20261012']))
  for (const container of containers) assert.equal(container.State.Health.Status, 'healthy')
  assert.equal(containers[1].HostConfig.NetworkMode, `container:${containers[0].Id}`)
  assert.equal(containers[2].HostConfig.NetworkMode, `container:${containers[0].Id}`)
  fs.writeFileSync(path.join(out, 'acceptance-existing.json'), JSON.stringify({ status: 'PASS', candidate_source_sha: candidateSha, script_sha: scriptSha, candidate_manifest_sha256: hash(path.join(artifactDir, 'manifest.json')), scenarios: reports.map(r => ({ scenario: r.scenario, task_id: r.id, quote: r.quote.sale_price, request_count: r.after.supplier.video_posts - r.before.supplier.video_posts, downloads: r.downloads, ledger_before: r.before.ledger, ledger_after: r.after.ledger, http: r.http, upstream: state.requests.filter(request => request.body?.model === (r.scenario === 'video-compatible' ? 'synthetic-compatible-upstream' : 'synthetic-seedance-upstream') || request.path.includes(r.scenario === 'video-compatible' ? '/v1/videos' : '/api/v3/contents/generations/tasks')) })), containers: containers.map(c => ({ name: c.Name, image: c.Config.Image, image_id: c.Image, health: c.State.Health.Status, network: c.HostConfig.NetworkMode })) }, null, 2))
} finally {
  if (proxy) proxy.kill()
  for (const name of fs.readdirSync(evidence).filter(n => /^native-(video-(compatible|seedance)-browser|customer-video-(compatible|seedance)|supplier-state|browser|customer-video-(compatible|seedance)).*\.(png|json)$/.test(n))) fs.copyFileSync(path.join(evidence, name), path.join(out, name))
  try { dc(['down', '-v', '--remove-orphans']) } catch {}
}
console.log(JSON.stringify({ status: 'PASS', candidate_source_sha: candidateSha, script_sha: scriptSha }))

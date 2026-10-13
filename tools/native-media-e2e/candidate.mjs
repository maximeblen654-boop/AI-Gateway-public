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
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/studio-native-media')
const scriptSha = process.env.GITHUB_SHA
assert.match(scriptSha, /^[a-f0-9]{40}$/)
const sha = process.env.NATIVE_CANDIDATE_SOURCE_SHA || scriptSha
assert.match(sha, /^[a-f0-9]{40}$/)
const source = path.resolve(process.env.NATIVE_CANDIDATE_SOURCE_DIR || process.cwd())
const draftManagement = process.env.NATIVE_ACCEPTANCE_SCENARIO === 'draft-management'
const out = path.join(process.env.RUNNER_TEMP, 'native-candidate-output')
const root = path.join(process.env.RUNNER_TEMP, 'native-media-20261012')
const recipes = path.join(root, 'recipes')
const evidence = path.join(root, 'evidence')
const components = ['core', 'bridge', 'bff']
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const tag = c => `native-candidate-${c}:${sha}`
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
if (mode === 'build') {
  // Estimated peak includes Go cache, image layers, test dependencies and exports.
  space(30)
  assert.equal(capture('git', ['-C', source, 'rev-parse', 'HEAD']), sha)
  assert.equal(capture('git', ['-C', source, 'status', '--porcelain']), '', 'runtime source must be clean')
  const notices = path.join(root, 'notices')
  fs.mkdirSync(notices, { recursive: true })
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(notices, 'COPYING.LESSER'))
  fs.copyFileSync(path.join(source, 'tools/phase5-candidate/COPYING.GPL-3.0'), path.join(notices, 'COPYING'))
  fs.writeFileSync(path.join(notices, 'NOTICE.txt'), `Non-production AI-Gateway candidate derived from Sub2API; LGPL-3.0-or-later.\nComplete corresponding source and dependency locks: https://github.com/maximeblen654-boop/AI-Gateway-public/tree/${sha}\nBuild recipes and native-media-e2e tools are included in that source. Alpine package versions/licenses are recorded in /lib/apk/db/installed; package sources: https://gitlab.alpinelinux.org/alpine/aports .\n`)
  for (const c of components) {
    space(10)
    const recipe = path.join(recipes, `${c}.Dockerfile`)
    fs.writeFileSync(recipe, withNotices(fs.readFileSync(path.join(source, c === 'bff' ? 'deploy/studio/Dockerfile' : 'Dockerfile'), 'utf8'), c))
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--provenance=false',
      '--build-context', `candidate-notices=${notices}`, '--label', `org.opencontainers.image.revision=${sha}`,
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
  if (draftManagement) compose.services.simulator.environment.NATIVE_RESULT_ORIGIN = 'https://203.0.113.10:19090'
  fs.writeFileSync(path.join(root, 'compose.json'), JSON.stringify(compose))
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.copyFileSync('tools/native-media-e2e/simulator.mjs', path.join(root, 'runtime/simulator.mjs'))
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', draftManagement ? 'subjectAltName=DNS:localhost,IP:203.0.113.10' : 'subjectAltName=DNS:localhost', '-keyout', path.join(evidence, 'simulator-key.pem'), '-out', path.join(evidence, 'simulator-cert.pem')])
  fs.copyFileSync(path.join(evidence, 'simulator-cert.pem'), path.join(evidence, 'simulator-ca.crt'))
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(evidence, 'synthetic-original.mp4')])
  dc(['up', '-d', '--wait', '--wait-timeout', '180', 'core'])
  if (draftManagement) {
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
    if (draftManagement) {
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
      return { component: c, path: file, bytes: Number(capture('docker', ['exec', container, 'stat', '-c', '%s', file])), sha256: capture('docker', ['exec', container, 'sha256sum', file]).split(' ')[0] }
    })
    fs.writeFileSync(path.join(out, 'runtime-files.json'), JSON.stringify({ source_sha: sha, files: runtimeFiles }, null, 2))
    fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify({ source_sha: sha, script_sha: scriptSha, scope: draftManagement ? 'draft-management' : 'standard', status: 'PASS', containers: containers.map(c => ({ name: c.Name, image: c.Image, health: c.State.Health.Status, network: c.HostConfig.NetworkMode, mounts: c.Mounts.map(m => ({ type: m.Type, destination: m.Destination, rw: m.RW })) })) }, null, 2))
  } finally {
    proxy.kill()
    for (const name of fs.readdirSync(evidence).filter(n => /^native-.*\.(png|json)$/.test(n))) fs.copyFileSync(path.join(evidence, name), path.join(out, name))
  }
} else if (mode === 'export') {
  const acceptance = fs.existsSync(path.join(out, 'acceptance.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'acceptance.json'))) : { source_sha: sha, status: 'NOT_PASSED' }
  assert.equal(acceptance.source_sha, sha)
  const images = []
  for (const c of components) {
    space(10)
    const image = JSON.parse(capture('docker', ['image', 'inspect', tag(c)]))[0]
    assert.equal(`${image.Os}/${image.Architecture}`, 'linux/amd64')
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], sha)
    const name = `${c}-${sha}.tar`
    run('docker', ['save', '-o', path.join(out, name), tag(c)])
    run('gzip', ['-1', path.join(out, name)])
    const file = `${name}.gz`
    images.push({ component: c, source_sha: sha, image_id: image.Id, platform: 'linux/amd64', tag: tag(c), tar: file, sha256: await hash(path.join(out, file)), bytes: fs.statSync(path.join(out, file)).size })
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ source_sha: sha, acceptance_script_sha: scriptSha, acceptance_scope: draftManagement ? 'draft-management' : 'standard', production_action: false, acceptance: acceptance.status, images }, null, 2))
} else throw Error('choose build, verify or export')

'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { VIEWPORTS, SCRIPT_FILES, sha256, scriptHashes, matchesPaidRead, armSupplierPaidReads, requestDecision, targetFor, reportPassed, verifyCandidateProof, verifiedImageIDs, verifyProductionRuntime } = require('./admin-readonly.cjs')
const origin = 'https://acceptance.invalid', source = '1'.repeat(40)
const request = (suffix = '', method = 'GET', media = 'image', base = origin) => ({ method: () => method, url: () => `${base}/api/v1/admin/media-workbench/paid-controls/${media}${suffix}` })
const resolve = () => { let done; const promise = new Promise(r => { done = r }); return { promise, done } }
test('exact paid read permits the real Axios timezone and rejects unrelated query/method/origin', () => {
  for (const query of ['', '?timezone=Asia%2FShanghai', '?timezone=UTC', '?timezone=America%2FNew_York']) assert.equal(matchesPaidRead(request(query), origin, 'image'), true)
  for (const query of ['?timezone=', '?timezone=invalid', '?timezone=UTC&timezone=UTC', '?other=UTC', '?timezone=UTC&token=x', '#fragment']) assert.equal(matchesPaidRead(request(query), origin, 'image'), false)
  assert.equal(matchesPaidRead(request('', 'POST'), origin, 'image'), false)
  assert.equal(matchesPaidRead(request('', 'GET', 'video'), origin, 'image'), false)
  assert.equal(matchesPaidRead(request('', 'GET', 'image', 'https://other.invalid'), origin, 'image'), false)
  // The old !u.search condition fails on an otherwise valid real request.
  assert.equal(!new URL(request('?timezone=UTC').url()).search, false)
})
test('listeners arm before a click and await BOTH bodies, not just response headers', async () => {
  const pending = [], image = resolve(), video = resolve()
  const page = { waitForRequest: predicate => new Promise(done => pending.push({ predicate, done })) }
  const finish = armSupplierPaidReads(page, origin, 1000)
  assert.equal(pending.length, 2)
  for (const [media, body] of [['image', image], ['video', video]]) {
    const q = request('?timezone=Asia%2FShanghai', 'GET', media)
    q.response = async () => ({ status: () => 200, finished: () => body.promise, json: async () => ({ code: 0, data: { media } }) })
    pending.find(x => x.predicate(q)).done(q)
  }
  let complete = false; const result = finish().then(v => { complete = true; return v })
  await new Promise(setImmediate); assert.equal(complete, false)
  image.done(null); await new Promise(setImmediate); assert.equal(complete, false)
  video.done(null); assert.deepEqual((await result).map(x => x.body_finished), [true, true])
})
for (const failure of ['http', 'body', 'envelope', 'timeout']) test('paid read fails closed on ' + failure, async () => {
  const page = { waitForRequest: async predicate => {
    for (const media of ['image', 'video']) {
      const q = request('', 'GET', media)
      if (!predicate(q)) continue
      q.response = async () => ({ status: () => failure === 'http' ? 403 : 200, finished: () => failure === 'timeout' ? new Promise(() => {}) : Promise.resolve(failure === 'body' ? Error('canceled') : null), json: async () => ({ code: failure === 'envelope' ? 1 : 0, data: { media } }) })
      return q
    }
  } }
  await assert.rejects(armSupplierPaidReads(page, origin, 30)(), /PAID_READ_/)
})
test('self-blocked external reads are distinct; all writes and unreviewed GETs remain forbidden', () => {
  assert.equal(requestDecision('GET', 'https://fonts.invalid/a.css', origin, [77]), 'external_read_blocked')
  assert.equal(requestDecision('POST', 'https://other.invalid/generate', origin, [77]), 'blocked')
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal(requestDecision(method, origin + '/api/v1/admin/media-workbench/accounts/77', origin, [77]), 'blocked')
  for (const route of ['/studio-v2/api/video/tasks', '/api/v1/admin/media-workbench/paid-controls/video/check', '/api/v1/admin/media-workbench/accounts/44', '/api/v1/unknown', '/v1/images/generations', '/unknown/recover']) assert.equal(requestDecision('GET', origin + route, origin, [77]), 'blocked')
  assert.equal(requestDecision('GET', origin + '/assets/MediaWorkbenchView.js', origin, [77]), 'read')
  assert.equal(requestDecision('GET', origin + '/api/v1/admin/media-workbench/accounts/77?timezone=UTC', origin, [77]), 'read')
})
test('diagnostic navigation is bound to the actual Product and exact missing-model code', () => {
  const dto = { media_workbench_v1: { validation: { diagnostics: [{ code: 'MODEL_NOT_DISCOVERED', scope: 'p1', path: 'upstream_model' }] }, draft: { products: [{ product_id: 'p1', media_type: 'image' }, { product_id: 'p2', media_type: 'image' }] } } }
  assert.equal(targetFor(dto, 'p1').product.product_id, 'p1')
  assert.throws(() => targetFor(dto, 'p2'), /IDENTITY_MISSING/)
})
const goodReport = media => ({ source_sha: source, status: 'PASS', context_closed: true, admin_before: true, admin_after: true, paid_unchanged: true, errors: [], blocked: [], api: [], targets: [{ account: 77, product_sha256: sha256(media), before: 'a'.repeat(64), after: 'a'.repeat(64) }], viewports: VIEWPORTS.map(size => ({ ...size, account: 77, media, product_sha256: sha256(media), identity: true, focus: true, visible: true, highlight: true, wizard_step_preserved: true, png_not_visible: true, no_overflow: true, paid_reads: ['image', 'video'].map(media => ({ media, status: 200, body_finished: true })) })), screenshots: VIEWPORTS.map(size => ({ file: `${media}-${size.width}.png`, sha256: sha256('synthetic screenshot') })), assets: { frontend_origin: 'final Core image', vite: false, browser_api_mocking: false } })
test('PASS requires every viewport, unchanged configuration, no writes, no errors and a closed context', () => {
  assert(reportPassed(goodReport('image')))
  for (const mutate of [r => r.viewports.pop(), r => { r.targets[0].after = 'b'.repeat(64) }, r => { r.viewports[0].focus = false }, r => r.errors.push({ code: 'BODY_CANCELED' }), r => r.blocked.push({ method: 'POST' }), r => { r.context_closed = false }, r => { r.paid_unchanged = false }, r => { r.viewports[0].paid_reads[0].body_finished = false }, r => r.screenshots.pop()]) { const r = goodReport('image'); mutate(r); assert(!reportPassed(r)) }
})
function proofFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-proof-'))
  const scripts = path.join(dir, 'scripts'); fs.mkdirSync(scripts)
  for (const name of SCRIPT_FILES) fs.writeFileSync(path.join(scripts, name), 'fixed ' + name)
  const proof = { scope: 'REAL_CORE_BRIDGE_BFF', status: 'PASS', source_sha: source, scripts: scriptHashes(scripts), reports: [], runtime: ['core', 'bridge', 'bff'].map((component, i) => ({ component, source_sha: source, healthy: true, image_id: 'sha256:' + String(i).repeat(64) })) }
  for (const media of ['image', 'video']) {
    const report = goodReport(media), file = media + '.json'
    for (const shot of report.screenshots) fs.writeFileSync(path.join(dir, shot.file), 'synthetic screenshot')
    const bytes = JSON.stringify(report); fs.writeFileSync(path.join(dir, file), bytes); proof.reports.push({ media, file, sha256: sha256(bytes) })
  }
  const proofName = 'native-admin-readonly-proof.json', proofBytes = JSON.stringify(proof); fs.writeFileSync(path.join(dir, proofName), proofBytes)
  const manifest = { source_sha: source, acceptance: 'PASS', production_action: false, admin_readonly: { file: proofName, sha256: sha256(proofBytes) }, images: proof.runtime.map(x => ({ component: x.component, source_sha: source, image_id: x.image_id, config_digest: x.image_id })) }
  const write = () => { const bytes = JSON.stringify(manifest); fs.writeFileSync(path.join(dir, 'manifest.json'), bytes); return sha256(bytes) }
  return { dir, scripts, manifest, write, hash: write() }
}
test('production gate accepts bound real candidate evidence; missing/changed/stale proof is rejected', t => {
  const f = proofFixture(); t.after(() => fs.rmSync(f.dir, { recursive: true }))
  assert.equal(verifyCandidateProof(f.dir, f.hash, source, f.scripts).source_sha, source)
  assert.throws(() => verifyCandidateProof(f.dir, 'f'.repeat(64), source, f.scripts), /MANIFEST_CHANGED/)
  assert.throws(() => verifyCandidateProof(f.dir, f.hash, '2'.repeat(40), f.scripts))
  fs.appendFileSync(path.join(f.scripts, 'admin-readonly.cjs'), ' changed')
  assert.throws(() => verifyCandidateProof(f.dir, f.hash, source, f.scripts), /SCRIPT_CHANGED/)
  delete f.manifest.admin_readonly; const hash = f.write()
  assert.throws(() => verifyCandidateProof(f.dir, hash, source, f.scripts), /PRE_RUN_MISSING/)
})
test('production gate rejects changed result bytes or screenshots', t => {
  const f = proofFixture(); t.after(() => fs.rmSync(f.dir, { recursive: true }))
  fs.appendFileSync(path.join(f.dir, 'image-1440.png'), ' changed')
  assert.throws(() => verifyCandidateProof(f.dir, f.hash, source, f.scripts))
})
test('sealed production identity must match the exact candidate images and all three healthy programs', t => {
  const f = proofFixture(); t.after(() => fs.rmSync(f.dir, { recursive: true }))
  const proof = { source_sha: source, proof_source: 'SSH_READBACK_OF_SEALED_RELEASE', public_routes_verified: true, run_id: 'a'.repeat(32), components: Object.fromEntries(f.manifest.images.map(i => [i.component, { source_sha: source, expected_image_id: i.image_id, running_image_id: i.image_id, healthy: true, program_sha256_matches: true }])) }
  const raw = Buffer.from(JSON.stringify(proof)); assert.equal(verifyProductionRuntime(raw, sha256(raw), source, f.manifest).source_sha, source)
  proof.components.bff.running_image_id = 'sha256:' + 'f'.repeat(64)
  const changed = Buffer.from(JSON.stringify(proof)); assert.throws(() => verifyProductionRuntime(changed, sha256(changed), source, f.manifest))
})
test('Docker OCI runtime ID is accepted only through the verified config/manifest mapping', t => {
  const f = proofFixture(); t.after(() => fs.rmSync(f.dir, { recursive: true }))
  const core = f.manifest.images.find(i => i.component === 'core'), oci = 'sha256:' + 'a'.repeat(64)
  core.archive_identity = { config_digest: core.config_digest, oci_manifests: [{ config_digest: core.config_digest, manifest_digest: oci }] }
  assert(verifiedImageIDs(core).has(oci))
  assert(!verifiedImageIDs(core).has('sha256:' + 'f'.repeat(64)))
  const proof = { source_sha: source, proof_source: 'SSH_READBACK_OF_SEALED_RELEASE', public_routes_verified: true, run_id: 'a'.repeat(32), components: Object.fromEntries(f.manifest.images.map(i => [i.component, { source_sha: source, expected_image_id: i.component === 'core' ? oci : i.image_id, running_image_id: i.component === 'core' ? oci : i.image_id, healthy: true, program_sha256_matches: true }])) }
  const bytes = Buffer.from(JSON.stringify(proof)); assert(verifyProductionRuntime(bytes, sha256(bytes), source, f.manifest))
  core.archive_identity.oci_manifests[0].config_digest = 'sha256:' + 'b'.repeat(64)
  assert.throws(() => verifiedImageIDs(core))
})
test('candidate invokes shared acceptance before overall PASS and binds it in the final manifest', () => {
  const runner = fs.readFileSync(path.join(__dirname, 'candidate.mjs'), 'utf8')
  assert(runner.indexOf("'tools/native-media-e2e/admin-readonly-candidate.cjs'") < runner.indexOf("path.join(out, 'acceptance.json'), JSON.stringify"))
  assert(runner.includes('admin_readonly:'))
  assert(!fs.readFileSync(path.join(__dirname, 'admin-readonly.cjs'), 'utf8').includes('data-testid='))
})


test('fixture layout accepts only the complete default or isolated prerun namespace', () => {
  const { fixtureLayout } = require('./admin-readonly-candidate.cjs')
  for (const prerun of [false, true]) {
    const project = prerun ? 'ai-gateway-native-prerun-20261022' : 'ai-gateway-native-20261012'
    const prefix = prerun ? 'ai-gateway-native-prerun-' : 'ai-gateway-native-'
    const suffix = prerun ? '-20261022' : '-20261012'
    const compose = { ...(prerun ? { name: project } : {}), services: Object.fromEntries(['core', 'bridge', 'bff', 'postgres', 'redis', 'simulator'].map(c => [c, { container_name: prefix + c + suffix, image: c + ':fixed' }])) }
    assert.equal(fixtureLayout(compose).project, project)
    compose.services.bridge.container_name = 'another-project-bridge'
    assert.throws(() => fixtureLayout(compose), /MIXED_FIXTURE_NAMES/)
  }
  assert.throws(() => fixtureLayout({ name: 'production' }), /UNREVIEWED_FIXTURE_PROJECT/)
})

test('real fixture runtime rejects mixed project, service, image, source and unhealthy containers', () => {
  const { fixtureLayout, verifyFixtureRuntime } = require('./admin-readonly-candidate.cjs')
  const compose = { name: 'ai-gateway-native-prerun-20261022', services: Object.fromEntries(['core', 'bridge', 'bff', 'postgres', 'redis', 'simulator'].map(c => [c, { container_name: 'ai-gateway-native-prerun-' + c + '-20261022', image: c + ':fixed' }])) }
  const layout = fixtureLayout(compose)
  const container = { Name: '/' + layout.names.core, Image: 'sha256:fixed-core', Config: { Image: 'core:fixed', Labels: { 'com.docker.compose.project': layout.project, 'com.docker.compose.service': 'core' } }, State: { Health: { Status: 'healthy' } } }
  const image = { Id: container.Image, Config: { Labels: { 'org.opencontainers.image.revision': source } } }
  assert.equal(verifyFixtureRuntime(container, image, 'core', layout, source).healthy, true)
  for (const change of [
    c => { c.Name = '/ai-gateway-native-core-20261012' },
    c => { c.Config.Labels['com.docker.compose.project'] = 'other' },
    c => { c.Config.Labels['com.docker.compose.service'] = 'bff' },
    c => { c.Config.Image = 'other:fixed' },
    c => { c.Image = 'sha256:another' },
    c => { c.State.Health.Status = 'unhealthy' }
  ]) {
    const changed = structuredClone(container); change(changed)
    assert.throws(() => verifyFixtureRuntime(changed, image, 'core', layout, source))
  }
  const wrongSource = structuredClone(image); wrongSource.Config.Labels['org.opencontainers.image.revision'] = '2'.repeat(40)
  assert.throws(() => verifyFixtureRuntime(container, wrongSource, 'core', layout, source))
})


test('embedded page logo and installed status are explicit reads; setup writes and other paths stay blocked', () => {
  for (const pathname of ['/logo.svg', '/setup/status']) {
    assert.equal(requestDecision('GET', origin + pathname, origin, [77]), 'read')
    assert.equal(requestDecision('POST', origin + pathname, origin, [77]), 'blocked')
  }
  for (const pathname of ['/setup/install', '/setup/test-db', '/setup/test-redis', '/setup/status/extra', '/logo.svg/extra']) {
    assert.equal(requestDecision('GET', origin + pathname, origin, [77]), 'blocked')
    assert.equal(requestDecision('POST', origin + pathname, origin, [77]), 'blocked')
  }
})

'use strict'
// Thin adapter only. All UI and read-only decisions live in admin-readonly.cjs.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { collect, scriptHashes, sha256 } = require('./admin-readonly.cjs')
function fixtureLayout(compose) {
  const project = compose.name || 'ai-gateway-native-20261012'
  const scopes = {
    'ai-gateway-native-20261012': ['ai-gateway-native-', '-20261012'],
    'ai-gateway-native-prerun-20261022': ['ai-gateway-native-prerun-', '-20261022']
  }
  assert(Object.prototype.hasOwnProperty.call(scopes, project), 'UNREVIEWED_FIXTURE_PROJECT')
  const [prefix, suffix] = scopes[project], names = {}, images = {}
  for (const component of ['core', 'bridge', 'bff', 'postgres', 'redis', 'simulator']) {
    names[component] = prefix + component + suffix
    assert.equal(compose.services[component].container_name, names[component], 'MIXED_FIXTURE_NAMES')
    images[component] = compose.services[component].image
  }
  return { project, names, images }
}
function verifyFixtureRuntime(container, image, component, layout, source) {
  assert.equal(container.Name, '/' + layout.names[component])
  assert.equal(container.Config.Labels['com.docker.compose.project'], layout.project)
  assert.equal(container.Config.Labels['com.docker.compose.service'], component)
  assert.equal(container.Config.Image, layout.images[component])
  assert.equal(image.Id, container.Image)
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], source)
  assert.equal(container.State.Health.Status, 'healthy')
  return { component, source_sha: source, image_id: container.Image, healthy: true }
}
async function main(root) {
  assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
  assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO, 'paid-controls')
  assert.equal(process.env.NATIVE_WORKSPACE_ARTIFACT, 'true')
  assert.notEqual(process.env.NATIVE_WORKSPACE_DEV_SERVER, 'true')
  const source = process.env.NATIVE_CANDIDATE_SOURCE_SHA || process.env.GITHUB_SHA
  assert.match(source, /^[a-f0-9]{40}$/)
  const compose = JSON.parse(fs.readFileSync(path.join(root, 'compose.json')))
  const layout = fixtureLayout(compose)
  assert.equal(compose.services.postgres.environment.POSTGRES_DB, 'sub2api')
  assert.equal(compose.services.core.environment.ADMIN_EMAIL, 'native-admin@example.invalid')
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'evidence/fixture.json')))
  const capture = args => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  const runtime = () => ['core', 'bridge', 'bff'].map(component => {
    const c = JSON.parse(capture(['inspect', layout.names[component]]))[0]
    const image = JSON.parse(capture(['image', 'inspect', c.Image]))[0]
    return verifyFixtureRuntime(c, image, component, layout, source)
  })
  const beforeRuntime = runtime(), scripts = scriptHashes()
  let token = ''
  const api = async (route, method = 'GET', body) => {
    const r = await fetch('http://127.0.0.1:28180/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal(r.status, 200, 'ISOLATED_SETUP_HTTP_FAILED'); const json = await r.json(); assert.equal(json.code, 0); return json.data
  }
  const env = compose.services.core.environment
  token = (await api('/auth/login', 'POST', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).access_token
  const { chromium } = require('../../frontend/node_modules/@playwright/test')
  const reports = [], evidence = path.join(root, 'evidence')
  for (const [media, key] of [['image', 'openai'], ['video', 'compatible']]) {
    const account = fixture.accounts[key]; assert(Number.isSafeInteger(account) && account > 0)
    assert((await api('/admin/accounts/' + account)).name.startsWith('Synthetic '))
    const route = '/admin/media-workbench/accounts/' + account
    const old = (await api(route)).media_workbench_v1, products = structuredClone(old.draft.products)
    const product = products.find(p => p.media_type === media); assert(product, 'ISOLATED_PRODUCT_MISSING')
    product.upstream_model = 'synthetic-acceptance-missing-' + media
    let changed = false
    const out = path.join(evidence, 'admin-readonly-' + media)
    try {
      await api(route + '/draft', 'PUT', { expected_record_version: old.record_version, draft: { products } }); changed = true
      const report = await collect({ origin: 'http://127.0.0.1:28100', token, sourceSha: source, targets: [{ account, product: product.product_id }], out, launch: () => chromium.launch({ channel: 'chrome', headless: true }), onPage: page => require('./artifact-assets.cjs')(page) })
      assert.equal(report.status, 'PASS', 'READ_ONLY_COLLECTOR_FAILED')
      assert(report.assets.resources.length >= 3)
      const file = 'native-admin-readonly-' + media + '.json'
      reports.push({ media, file, sha256: sha256(fs.readFileSync(path.join(out, 'result.json'))) })
    } finally {
      try {
        // Keep the failed run too; candidate upload only collects top-level files.
        if (fs.existsSync(path.join(out, 'result.json'))) {
          const report = JSON.parse(fs.readFileSync(path.join(out, 'result.json')))
          fs.copyFileSync(path.join(out, 'result.json'), path.join(evidence, 'native-admin-readonly-' + media + '.json'))
          for (const shot of [...report.screenshots, ...(report.failure_screenshot?.file ? [report.failure_screenshot] : [])]) fs.copyFileSync(path.join(out, shot.file), path.join(evidence, shot.file))
        }
      } finally {
        if (changed) {
          const current = (await api(route)).media_workbench_v1
          assert.deepEqual(current.published, old.published); assert.deepEqual(current.sales, old.sales)
          const restored = (await api(route + '/draft', 'PUT', { expected_record_version: current.record_version, draft: { products: old.draft.products } })).media_workbench_v1
          assert.deepEqual(restored.draft.products, old.draft.products)
          assert.deepEqual(restored.published, old.published); assert.deepEqual(restored.sales, old.sales)
        }
      }
    }
  }
  assert.deepEqual(runtime(), beforeRuntime); assert.deepEqual(scriptHashes(), scripts)
  const proof = { schema: 1, status: 'PASS', scope: 'REAL_CORE_BRIDGE_BFF', source_sha: source, scripts, runtime: beforeRuntime, reports }
  fs.writeFileSync(path.join(evidence, 'native-admin-readonly-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' })
  token = ''
}
if (require.main === module) main(process.argv[2]).catch(() => { console.error('ISOLATED_READ_ONLY_ACCEPTANCE_FAILED: inspect the sanitized result.json; no production access.'); process.exitCode = 1 })
module.exports = main

module.exports.fixtureLayout = fixtureLayout
module.exports.verifyFixtureRuntime = verifyFixtureRuntime

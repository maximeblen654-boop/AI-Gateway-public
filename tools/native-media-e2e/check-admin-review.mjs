// Deterministic assertions over actual Core/BFF/simulator evidence; never contacts a server.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = path.resolve(process.argv[2] || '')
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
const acceptance = read('acceptance.json')
assert.equal(acceptance.status, 'PASS')
assert.equal(acceptance.scope, 'admin-ui-implementation-review-not-candidate')
const admin = read('native-admin-ui-review.json')
assert.equal(admin.pass, true)
assert.equal(admin.preview_count, 64)
assert.equal(admin.assets.vite, false)
assert.equal(admin.assets.browser_api_mocking, false)
assert(admin.assets.resources.some(r => r.path.includes('MediaWorkbenchView') && r.direct_core_equal))
const geometry = read('native-geometry-browser.json')
assert.equal(geometry.validation.previews.length, 64)
assert(!geometry.validation.previews.some(p => p.spec.resolution === '4K'), '4K must really be outside the sampled preview')
assert(geometry.products.some(p => p.capabilities.resolutions.includes('4K')))
const owners = ['draft','published','mapping','routing'].map(kind => read('native-customer-image-geometry-2k-'+kind+'.json').customer.id)
assert.equal(new Set(owners).size, 4, 'Dependency counterexamples must use independent synthetic owners')
const results = [{ scenario: 'preview-sampling', samples: 64, unsampled_resolution_executed: '4K', full_capabilities_preserved: true }]
for (const name of ['image-geometry-1k', 'edit-geometry-2k', 'image-geometry-4k', 'video-compatible', 'image-geometry-free', 'image-geometry-2k-draft']) {
  const r = read(`native-customer-${name}.json`)
  assert.equal(r.pass, true, name)
  const q = r.quote, actual = r.submit.body
  for (const field of ['offer_id', 'spec', 'sale_price', 'unit_price', 'total_price', 'quantity']) assert.deepEqual(actual[field], q[field], `${name}: frozen ${field}`)
  if (q.execution) assert.deepEqual(actual.execution, q.execution, `${name}: frozen execution plan`)
  assert.deepEqual(r.after_refresh_download.ledger, r.after.ledger)
  assert.equal(r.after.ledger.usage - r.before.ledger.usage, 1)
  for (const d of r.downloads) assert.equal(d.sha256, r.original_sha256)
  if (name.endsWith('-draft')) {
    assert.equal(r.dependency_change.published_before, r.dependency_change.published_after)
    assert.equal(q.execution.mode, 'single')
    assert.equal(q.quantity, 3)
    assert.equal(q.execution.units.length, 3)
    assert.equal(r.after.supplier.image_posts - r.before.supplier.image_posts, 3)
    assert.equal(q.unit_price.amount, '0.90')
  }
  results.push({ scenario: name, frozen_fields_equal: true, native_usage_delta: 1, request_count: name === 'video-compatible' ? r.after.supplier.video_posts-r.before.supplier.video_posts : r.after.supplier.image_posts-r.before.supplier.image_posts, price: q.total_price, spec: q.spec, original_sha256: r.original_sha256, read_only_recovery: true })
}
for (const kind of ['published', 'mapping', 'routing']) {
  const r = read(`native-customer-image-geometry-2k-${kind}.json`)
  assert.equal(r.pass, true)
  assert.equal(r.rejected_before_generation, true)
  assert.equal(r.submit.status, 409)
  assert.equal(r.submit.body.error, 'image_binding_unavailable')
  assert.equal(r.submit.body.recovery, 'GET original task only')
  assert.deepEqual(r.quote, r.dependency_change.quote_before)
  assert.deepEqual(r.after.ledger, r.before.ledger)
  assert.equal(r.after.supplier.image_posts, r.before.supplier.image_posts)
  if (kind === 'published') assert.notEqual(r.dependency_change.published_before, r.dependency_change.published_after)
  results.push({ scenario: kind, upstream_requests: 0, billing_changes: 0, submit: r.submit })
}
const report = { pass: true, runtime_source_sha: acceptance.source_sha, integration_script_sha: acceptance.script_sha, status: 'IMPLEMENTATION_READY_FOR_REVIEW_NOT_DEPLOYED', results }
fs.writeFileSync(path.join(root, 'contract-cross-check.json'), JSON.stringify(report, null, 2)+'\n')
console.log(JSON.stringify(report, null, 2))

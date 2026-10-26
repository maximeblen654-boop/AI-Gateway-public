'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { assertPreflightSupplierStats } = require('./preflight-supplier-stats.cjs')
const catalog = () => ({ auth: 'bearer', body: {}, method: 'GET', path: '/v1/models' })
const baseline = () => ({ image_posts: 127, video_posts: 3, tasks: { 'native-video-1': { id: 'native-video-1', kind: 'compatible', state: 'done' } }, requests: [{ auth: 'gemini-key', body: { model: 'synthetic-prior-generation' }, method: 'POST', path: '/v1/images/generations' }] })
test('observed initial-candidate log sample: exact appended catalog GET passes while old equality fails', () => {
  // INITIAL_CANDIDATE_FAILURE.log:2923-2933: image_posts 127 unchanged,
  // with only the exact bearer GET /v1/models body {} added. The rest is a
  // deterministic representative baseline, not a fabricated full cloud dump.
  const before = baseline(), after = structuredClone(before); after.requests.push(catalog())
  assert.throws(() => assert.deepEqual(after, before))
  const proof = assertPreflightSupplierStats(after, before)
  assert.equal(proof.added_catalog_gets, 1); assert.match(proof.added_requests_sha256, /^[a-f0-9]{64}$/)
  assert.equal(after.image_posts, 127)
})
test('zero and multiple exact catalog observations are counted and reported without mutating input', () => {
  for (const count of [0, 2, 5]) {
    const before = baseline(), after = structuredClone(before); after.requests.push(...Array.from({ length: count }, catalog))
    const original = structuredClone({ before, after }), proof = assertPreflightSupplierStats(after, before)
    assert.equal(proof.added_catalog_gets, count); assert.deepEqual({ before, after }, original)
    assert.equal(proof.request_history_prefix_unchanged, true); assert.equal(proof.non_request_state_unchanged, true)
  }
})
for (const [name, mutate] of [
  ['generation POST', r => { r.method = 'POST'; r.path = '/v1/images/generations' }],
  ['POST with unchanged economic counters', r => { r.method = 'POST' }],
  ['video generation POST', r => { r.method = 'POST'; r.path = '/v1/videos' }],
  ['unknown GET', r => { r.path = '/v1/tasks/one' }],
  ['query-bearing path', r => { r.path = '/v1/models?refresh=1' }],
  ['different auth', r => { r.auth = 'gemini-key' }],
  ['nonempty body', r => { r.body = { model: 'x' } }],
  ['array body', r => { r.body = [] }],
  ['unknown field', r => { r.headers = {} }],
  ['missing field', r => { delete r.auth }],
  ['lowercase method', r => { r.method = 'get' }]
]) test('rejects appended ' + name, () => {
  const before = baseline(), after = structuredClone(before), request = catalog(); mutate(request); after.requests.push(request)
  assert.throws(() => assertPreflightSupplierStats(after, before), /UNEXPECTED_SUPPLIER_REQUEST/)
})
for (const [name, mutate] of [
  ['image counter', s => { s.image_posts++ }],
  ['video counter', s => { s.video_posts++ }],
  ['task state', s => { s.tasks['native-video-1'].state = 'changed' }],
  ['added task', s => { s.tasks.other = {} }],
  ['new state field', s => { s.unknown_count = 0 }],
  ['dropped state field', s => { delete s.video_posts }]
]) test('rejects changed ' + name + ' even with an otherwise allowed catalog GET', () => {
  const before = baseline(), after = structuredClone(before); after.requests.push(catalog()); mutate(after)
  assert.throws(() => assertPreflightSupplierStats(after, before), /SUPPLIER_NON_REQUEST_STATE_CHANGED/)
})
test('preserves every original request field and order as a complete prefix', () => {
  for (const mutate of [s => { s.requests[0].body.model = 'changed' }, s => { s.requests[0].unknown = true }, s => { s.requests.reverse() }, s => { s.requests.shift() }]) {
    const before = baseline(); before.requests.push({ ...catalog(), path: '/historical-read' })
    const after = structuredClone(before); mutate(after); after.requests.push(catalog())
    assert.throws(() => assertPreflightSupplierStats(after, before), /SUPPLIER_REQUEST_HISTORY_(CHANGED|SHORTENED)/)
  }
})
test('rejects missing history and invalid stats objects', () => {
  for (const invalid of [null, [], {}, { requests: {} }]) assert.throws(() => assertPreflightSupplierStats(invalid, baseline()))
})

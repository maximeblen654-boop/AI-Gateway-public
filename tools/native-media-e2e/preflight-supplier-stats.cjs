'use strict'
// Concurrent native catalog observation is permitted; every other supplier
// field and every pre-existing request must remain exactly unchanged.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function assertPreflightSupplierStats(after, before) {
  for (const value of [before, after]) {
    assert(value && Object.getPrototypeOf(value) === Object.prototype, 'SUPPLIER_STATS_OBJECT_REQUIRED')
    assert(Array.isArray(value.requests), 'SUPPLIER_REQUEST_HISTORY_REQUIRED')
  }
  const withoutRequests = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'requests'))
  const preserved = withoutRequests(before)
  assert.deepEqual(withoutRequests(after), preserved, 'SUPPLIER_NON_REQUEST_STATE_CHANGED')
  assert(after.requests.length >= before.requests.length, 'SUPPLIER_REQUEST_HISTORY_SHORTENED')
  assert.deepEqual(after.requests.slice(0, before.requests.length), before.requests, 'SUPPLIER_REQUEST_HISTORY_CHANGED')
  const added = after.requests.slice(before.requests.length)
  for (const request of added) assert.deepEqual(request, { auth: 'bearer', body: {}, method: 'GET', path: '/v1/models' }, 'UNEXPECTED_SUPPLIER_REQUEST')
  return {
    measurement: 'cumulative_from_supplied_baseline', non_request_state_unchanged: true, request_history_prefix_unchanged: true,
    added_catalog_gets: added.length, added_requests_sha256: sha(added),
    baseline_requests_sha256: sha(before.requests), non_request_state_sha256: sha(preserved)
  }
}
module.exports = { assertPreflightSupplierStats }

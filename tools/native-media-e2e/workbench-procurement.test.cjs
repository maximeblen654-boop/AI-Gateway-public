const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertPublic } = require('./workbench-procurement.cjs')

test('customer privacy audit permits sale price, model, offer and task identity', () => {
  assert.doesNotThrow(() => assertPublic({ offers: [{ offer_id: 'offer-1', product_id: 'product-1', model: 'public-model', sale_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' } }], task_id: 'task-1' }))
})

test('customer privacy audit rejects nested private cost snapshots and credentials', () => {
  for (const field of ['cost_rules', 'cost_version', 'cost', 'procurement', 'account_accounting', 'account_id', 'api_key', 'profit', 'effective_account_quota_cost']) {
    assert.throws(() => assertPublic({ tasks: [{ result: { [field]: { amount: '0.1' } } }] }), /Private business data leaked/, field)
  }
  assert.throws(() => assertPublic({ error: 'synthetic-native-only' }), /credential/)
  assert.throws(() => assertPublic({ detail: 'https://localhost:19090/v1/videos' }), /endpoint/)
})

test('runtime acceptance refuses a local or unqualified environment before accessing a database', async () => {
  const run = require('./workbench-procurement.cjs')
  const previous = process.env.RUNNER_ENVIRONMENT
  process.env.RUNNER_ENVIRONMENT = 'local'
  try { await assert.rejects(run('D:/not-a-candidate'), /github-hosted/) }
  finally { if (previous === undefined) delete process.env.RUNNER_ENVIRONMENT; else process.env.RUNNER_ENVIRONMENT = previous }
})

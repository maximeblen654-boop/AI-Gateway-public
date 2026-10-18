const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertPublic, assertZeroBalanceRejection, setAccountSchedulable, setAccountQuota, setKeyStatus } = require('./workbench-procurement.cjs')

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

test('native zero-balance gate is distinct from a low positive projected balance', () => {
  const zero = { balance: '0', frozen: '0', usage: 0, cost: '0', account_quota: '1.05' }
  assert.doesNotThrow(() => assertZeroBalanceRejection(zero, { ...zero }, 7, 7, { status: 403, body: { error: 'INSUFFICIENT_BALANCE' } }))
  assert.doesNotThrow(() => assertZeroBalanceRejection(zero, { ...zero }, 7, 7, { status: 200, body: { status: 'failed' } }))
  const positive = { ...zero, balance: '0.01' }
  assert.throws(() => assertZeroBalanceRejection(positive, { ...positive }, 7, 7, { status: 409, body: {} }), /low positive balance/)
})

test('zero-balance evidence fails on supplier execution, native billing or false delivery success', () => {
  const zero = { balance: '0', frozen: '0', usage: 0, cost: '0', account_quota: '1.05' }
  assert.throws(() => assertZeroBalanceRejection(zero, zero, 7, 8, { status: 200, body: { status: 'unknown' } }), /reached the supplier/)
  assert.throws(() => assertZeroBalanceRejection(zero, { ...zero, balance: '-1.1', usage: 1 }, 7, 7, { status: 200, body: { status: 'failed' } }), /changed native balance/)
  assert.throws(() => assertZeroBalanceRejection(zero, zero, 7, 7, { status: 200, body: { status: 'completed' } }), /successful delivery/)
})

test('Account schedulability uses its official POST endpoint and requires persisted GET state', async () => {
  for (const schedulable of [false, true]) {
    const calls = []
    const core = async (token, path, method = 'GET', body) => { calls.push({ token, path, method, body }); return { id: 44, schedulable } }
    await setAccountSchedulable(core, 'admin-token', 44, schedulable)
    assert.deepEqual(calls, [
      { token: 'admin-token', path: '/admin/accounts/44/schedulable', method: 'POST', body: { schedulable } },
      { token: 'admin-token', path: '/admin/accounts/44', method: 'GET', body: undefined }
    ])
    await assert.rejects(setAccountSchedulable(async () => ({ id: 44, schedulable: !schedulable }), 'admin-token', 44, schedulable), /not persisted/)
  }
})

test('Account quota updates preserve extra and native usage, with GET confirmation before testing the gate', async () => {
  const account = { id: 44, extra: { quota_limit: 100, quota_used: 1.05, fixture_extra: true } }
  for (const quotaLimit of [0.00000001, 100]) {
    const calls = []
    const core = async (token, path, method = 'GET', body) => {
      calls.push({ token, path, method, body })
      return { id: 44, extra: { ...account.extra, quota_limit: String(quotaLimit) } }
    }
    await setAccountQuota(core, 'admin-token', account, quotaLimit)
    assert.deepEqual(calls, [
      { token: 'admin-token', path: '/admin/accounts/44', method: 'PUT', body: { extra: { ...account.extra, quota_limit: quotaLimit } } },
      { token: 'admin-token', path: '/admin/accounts/44', method: 'GET', body: undefined }
    ])
  }
  await assert.rejects(setAccountQuota(async () => account, 'admin-token', account, 0.00000001), /not persisted/)
  await assert.rejects(setAccountQuota(async () => ({ id: 44, extra: { quota_limit: 0.00000001, quota_used: 0 } }), 'admin-token', account, 0.00000001), /rewrote native usage/)
})

test('native Key status updates and restoration require matching owned-Key GET state', async () => {
  for (const status of ['inactive', 'active']) {
    const calls = []
    const core = async (token, path, method = 'GET', body) => { calls.push({ token, path, method, body }); return { id: 7, status } }
    await setKeyStatus(core, 'customer-token', 7, status)
    assert.deepEqual(calls, [
      { token: 'customer-token', path: '/keys/7', method: 'PUT', body: { status } },
      { token: 'customer-token', path: '/keys/7', method: 'GET', body: undefined }
    ])
    await assert.rejects(setKeyStatus(async () => ({ id: 7, status: status === 'active' ? 'inactive' : 'active' }), 'customer-token', 7, status), /not persisted/)
  }
  await assert.rejects(setKeyStatus(async () => ({ id: 8, status: 'inactive' }), 'customer-token', 7, 'inactive'), /another Key/)
})

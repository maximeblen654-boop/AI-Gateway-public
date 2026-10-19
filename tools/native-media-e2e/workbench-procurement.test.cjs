const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertVideoFailureRelease, assertPublic, assertZeroBalanceRejection, setAccountSchedulable, setAccountQuota, clearAccountQuota, setKeyStatus, disableFixtureSales } = require('./workbench-procurement.cjs')

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
      { token: 'admin-token', path: '/admin/accounts/44', method: 'GET', body: undefined },
      { token: 'admin-token', path: '/admin/accounts/44', method: 'PUT', body: { extra: { ...account.extra, quota_limit: quotaLimit } } },
      { token: 'admin-token', path: '/admin/accounts/44', method: 'GET', body: undefined }
    ])
  }
  await assert.rejects(setAccountQuota(async () => account, 'admin-token', account, 0.00000001), /not persisted/)
  let reads = 0
  await assert.rejects(setAccountQuota(async () => ++reads === 1 ? account : ({ id: 44, extra: { quota_limit: 0.00000001, quota_used: 0 } }), 'admin-token', account, 0.00000001), /rewrote native usage/)
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

test('fixture sales cleanup uses the current Account CAS version and preserves Draft/Published', async () => {
  for (const enabled of [true, false]) {
    const before = { id: 6, media_workbench_v1: { record_version: 17, sales: { enabled }, draft: { revision: 'draft-1' }, published: { revision: 'published-1' } } }
    const readback = structuredClone(before); readback.media_workbench_v1.sales.enabled = false
    const calls = []; let reads = 0
    const core = async (token, path, method = 'GET', body) => {
      calls.push({ token, path, method, body })
      return method === 'GET' ? (++reads === 1 ? before : readback) : { acknowledged: true }
    }
    assert.equal(await disableFixtureSales(core, 'admin-token', 6), false)
    const path = '/admin/media-workbench/accounts/6'
    assert.deepEqual(calls, [
      { token: 'admin-token', path, method: 'GET', body: undefined },
      ...(enabled ? [{ token: 'admin-token', path: path + '/sales', method: 'PUT', body: { expected_record_version: 17, enabled: false } }] : []),
      { token: 'admin-token', path, method: 'GET', body: undefined }
    ])
  }
})

test('fixture sales cleanup rejects stale CAS, ignored writes or destructive readbacks', async () => {
  const before = { id: 6, media_workbench_v1: { record_version: 17, sales: { enabled: true }, draft: { revision: 'draft-1' }, published: { revision: 'published-1' } } }
  await assert.rejects(disableFixtureSales(async (_token, _path, method = 'GET') => {
    if (method === 'PUT') throw new Error('409 stale record version')
    return before
  }, 'admin-token', 6), /409 stale record version/)
  await assert.rejects(disableFixtureSales(async () => before, 'admin-token', 6), /not persisted/)
  const destructive = structuredClone(before); destructive.media_workbench_v1.sales.enabled = false; delete destructive.media_workbench_v1.published
  let reads = 0
  await assert.rejects(disableFixtureSales(async (_token, _path, method = 'GET') => method === 'GET' && ++reads === 1 ? before : destructive, 'admin-token', 6), /changed the fixture Published/)
})


test('video terminal failure requires authoritative release and no money, usage, dedup or quota effects', () => {
  const before = { balance: '20', frozen: '0', usage: 3, dedup: 3, account_quota: '0.3' }
  const order = { state: 'RELEASED', release_reason: 'supplier_failed', actual_amount: null }
  assert.doesNotThrow(() => assertVideoFailureRelease(before, { ...before }, order, 4, 5))
  for (const field of ['balance', 'frozen', 'usage', 'dedup', 'account_quota']) {
    assert.throws(() => assertVideoFailureRelease(before, { ...before, [field]: 99 }, order, 4, 5), /changed balance/)
  }
  assert.throws(() => assertVideoFailureRelease(before, before, { ...order, state: 'HELD' }, 4, 5), /released order/)
  assert.throws(() => assertVideoFailureRelease(before, before, { ...order, actual_amount: 2 }, 4, 5), /captured/)
  assert.throws(() => assertVideoFailureRelease(before, before, order, 4, 6), /original video/)
})


test('removing only the isolated monetary limit preserves native usage and other Account settings', async () => {
  const account = { id: 44, extra: { quota_limit: 100, quota_used: 0.3, fixture_extra: true } }
  const calls = []
  const readback = { id: 44, extra: { quota_used: 0.3, fixture_extra: true } }
  const core = async (_token, path, method = 'GET', body) => { calls.push({ path, method, body }); return readback }
  await clearAccountQuota(core, 'admin', account)
  assert.deepEqual(calls[1], { path: '/admin/accounts/44', method: 'PUT', body: { extra: readback.extra } })
  assert.equal(account.extra.quota_limit, 100, 'Input snapshot must not be mutated')
  await assert.rejects(clearAccountQuota(async () => account, 'admin', account), /monetary Account limit/)
  let reads = 0
  await assert.rejects(clearAccountQuota(async () => ++reads === 1 ? account : ({ id: 44, extra: { quota_used: 0 } }), 'admin', account), /rewrote native usage/)
})


test('shared fixture quota phases preserve image accounting and do not rewrite usage from stale snapshots', async () => {
  const stale = { id: 44, extra: {} }
  let current = structuredClone(stale)
  const core = async (_token, _path, method = 'GET', body) => {
    if (method === 'PUT') current.extra = structuredClone(body.extra)
    return structuredClone(current)
  }
  const videoAllowed = () => !Number(current.extra.quota_limit)
  assert.equal(videoAllowed(), true, 'Initial video preflight must see no amount limit')
  await setAccountQuota(core, 'admin', stale, 100)
  assert.equal(videoAllowed(), false, 'Video must not run during image quota phase')
  // Synthetic stand-in for the real image ledger: the cloud acceptance retains
  // its exact +0.3 assertion; this unit checks only fixture transition safety.
  current.extra.quota_used = 0.3
  await clearAccountQuota(core, 'admin', stale)
  assert.equal(videoAllowed(), true)
  assert.equal(current.extra.quota_used, 0.3)
  await setAccountQuota(core, 'admin', stale, 100)
  assert.equal(current.extra.quota_used, 0.3, 'Second image phase must retain prior consumption')
  await clearAccountQuota(core, 'admin', stale)
  assert.equal(videoAllowed(), true)
  await setAccountQuota(core, 'admin', stale, 0.00000001)
  assert.equal(videoAllowed(), false)
  await setAccountQuota(core, 'admin', stale, 100)
  assert.equal(videoAllowed(), false)
  await clearAccountQuota(core, 'admin', stale)
  assert.deepEqual(current.extra, { quota_used: 0.3 })
})


test('candidate image/video phases refresh grants for the active quota contract before execution', () => {
  const source = require('node:fs').readFileSync(require.resolve('./workbench-procurement.cjs'), 'utf8')
  const checkpoints = [
    "await refreshPaidGrants()",
    "await setAccountQuota(core, admin, account, 100)",
    "await refreshPaidGrants(['image'])",
    "const beforeAlias = await prepare",
    "await execute(user, 'image', beforeAlias, '1.8', '0.3'",
    "await clearAccountQuota(core, admin, account)",
    "await refreshPaidGrants()",
    "for (const refs of [0, 1])",
    "await failVideo(user, wanOffer)",
    "await refreshPaidGrants()",
    "await setAccountQuota(core, admin, account, 100)",
    "await refreshPaidGrants(['image'])",
    "const zeroOffer = await offer",
    "await clearAccountQuota(core, admin, account)",
    "await refreshPaidGrants()",
    "const beforeBlocked = stats().video_posts",
  ]
  let position = source.indexOf('const imgOffer')
  // Initial preflight precedes customer setup; remaining checks bind exact order.
  assert(source.indexOf(checkpoints.shift(), source.indexOf('module.exports =')) < position)
  for (const checkpoint of checkpoints) {
    const next = source.indexOf(checkpoint, position)
    assert(next >= position, 'Missing ordered fixture stage: ' + checkpoint)
    position = next + checkpoint.length
  }
})

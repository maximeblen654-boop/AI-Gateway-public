import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { mediaPaidAPI, paidFailureMessage, PAID_CHECK_TIMEOUT_MS } from '../mediaPaid'

vi.mock('@/api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }))
const client = vi.mocked(apiClient)
const state = { media: 'video' as const, mode: 'managed-v1', requested_enabled: false, effective_enabled: false, revision: 'r1', reason: 'closed' }
const report = { media: 'video' as const, pass: true, fingerprint: 'fp-1', checked_at: '2026-10-20T03:17:00Z', checks: [{ code: 'native_quote', pass: true }] }
beforeEach(() => { vi.resetAllMocks() })

describe('paid control request contract', () => {
  it('gives complete checks a bounded 120s wait without changing normal status requests', async () => {
    client.post.mockResolvedValue({ data: report })
    client.get.mockResolvedValue({ data: state })
    expect(await mediaPaidAPI.check('video')).toEqual(report)
    expect(client.post).toHaveBeenCalledWith('/admin/media-workbench/paid-controls/video/check', {}, { timeout: 120_000 })
    expect(PAID_CHECK_TIMEOUT_MS).toBe(120_000)
    expect(await mediaPaidAPI.status('video')).toEqual(state)
    expect(client.get).toHaveBeenCalledWith('/admin/media-workbench/paid-controls/video')
  })

  it('waits for the official enable recheck and preserves revision and fingerprint; closing keeps the shared default', async () => {
    client.put.mockResolvedValue({ data: { state, report: null } })
    await mediaPaidAPI.apply('video', true, state, report)
    expect(client.put).toHaveBeenLastCalledWith('/admin/media-workbench/paid-controls/video', { enabled: true, expected_revision: 'r1', fingerprint: 'fp-1' }, { timeout: 120_000 })
    await mediaPaidAPI.apply('video', false, state)
    expect(client.put).toHaveBeenLastCalledWith('/admin/media-workbench/paid-controls/video', { enabled: false, expected_revision: 'r1', fingerprint: '' }, undefined)
  })

  it('returns a business failure report without turning it into a request failure', async () => {
    const failed = { ...report, pass: false, fingerprint: '', checks: [{ code: 'published_offer', pass: false }] }
    client.post.mockResolvedValue({ data: failed })
    expect(await mediaPaidAPI.check('video')).toEqual(failed)
  })

  it.each([
    { ...report, media: 'image' },
    { ...report, pass: 'true' },
    { ...report, fingerprint: '' },
    { ...report, checks: null },
    { ...report, checks: [{ code: 'native_quote', pass: 'false' }] },
    { ...report, checks: [{ code: 'native_quote', pass: false, account_id: 'https://private.invalid' }] }
  ])('rejects a malformed check report without authorizing the switch', async value => {
    client.post.mockResolvedValue({ data: value })
    await expect(mediaPaidAPI.check('video')).rejects.toMatchObject({ code: 'PAID_CONTROL_INVALID_RESPONSE' })
  })

  it.each([
    { ...state, media: 'image' },
    { ...state, requested_enabled: 'false' },
    { ...state, effective_enabled: true },
    { ...state, revision: undefined },
    null
  ])('rejects an unconfirmed state instead of treating missing values as closed', async value => {
    client.get.mockResolvedValue({ data: value })
    await expect(mediaPaidAPI.status('video')).rejects.toMatchObject({ code: 'PAID_CONTROL_INVALID_RESPONSE' })
  })

  it('keeps POST failures and timeouts as request errors without inventing a business report or retrying', async () => {
    const timeout = { status: 0, code: 'ECONNABORTED', message: 'private response' }
    client.post.mockRejectedValue(timeout)
    await expect(mediaPaidAPI.check('video')).rejects.toBe(timeout)
    expect(client.post).toHaveBeenCalledTimes(1)
    expect(client.get).not.toHaveBeenCalled()
    expect(client.put).not.toHaveBeenCalled()
  })
})

describe('safe paid-control errors', () => {
  it.each([
    [{ status: 0, code: 'ERR_NETWORK' }, '网络连接失败'],
    [{ code: 'ECONNABORTED' }, '请求超时'],
    [{ code: 'ETIMEDOUT' }, '请求超时'],
    [{ code: 'ERR_CANCELED' }, '请求已取消'],
    [{ status: 401 }, '登录状态已失效'],
    [{ response: { status: 403 } }, '没有执行此操作的权限'],
    [{ status: 404 }, '部署路由与服务版本'],
    [{ status: 409 }, '开关版本已变化'],
    [{ status: 429 }, '请求过于频繁'],
    [{ status: 503 }, 'Core、Bridge 和 BFF'],
    [{ code: 'PAID_CONTROL_INVALID_RESPONSE' }, '数据不符合开关合同'],
    [{ status: 400 }, '请求未完成']
  ])('uses a predefined description for %o', (failure, description) => {
    const message = paidFailureMessage({ ...failure, message: 'DBerror https://private.invalid?token=SECRET', data: 'SECRET' })
    expect(message).toContain(description)
    expect(message).not.toMatch(/DBerror|private\.invalid|SECRET/)
  })

  it('never displays arbitrary errors, response bodies, or error codes', () => {
    const message = paidFailureMessage({ code: 'https://private.invalid', message: 'DBerror SECRET', response: { data: '<html>SECRET</html>' } })
    expect(message).toContain('请求未完成')
    expect(message).not.toMatch(/DBerror|private\.invalid|SECRET|html/)
  })
})

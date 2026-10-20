import { apiClient } from '../client'
export type PaidMedia = 'image' | 'video'
export interface PaidState { media: PaidMedia; mode: string; requested_enabled: boolean; effective_enabled: boolean; revision: string; reason: string; fingerprint?: string }
export interface PaidCheck { code: string; pass: boolean; account_id?: number; product_id?: string; path?: string }
export interface PaidReport { media: PaidMedia; group_id?: number; pass: boolean; fingerprint: string; checks: PaidCheck[]; checked_at: string }

// Full native quotation checks can exceed the shared client's 30s timeout.
// This bounds the browser wait; a timed-out request has no resumable report.
export const PAID_CHECK_TIMEOUT_MS = 120_000

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const invalidResponse = () => Object.assign(new Error('Invalid paid control response'), { code: 'PAID_CONTROL_INVALID_RESPONSE' })

// Only fixed, public descriptions may leave this boundary. Server messages can
// contain upstream URLs or database errors and must never become UI copy.
export function paidFailureMessage(error: unknown): string {
  const value = object(error)
  const response = object(value.response)
  const status = typeof value.status === 'number' ? value.status : response.status
  const code = typeof value.code === 'string' ? value.code : ''
  if (code === 'PAID_CONTROL_INVALID_RESPONSE') return '服务返回的数据不符合开关合同，请管理员核对服务版本。'
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '请求超时，服务端处理结果尚未确认，请重新检查。'
  if (code === 'ERR_CANCELED') return '请求已取消，请重新检查。'
  if (status === 401) return '登录状态已失效，请重新登录。'
  if (status === 403) return '当前账号没有执行此操作的权限。'
  if (status === 404) return '开关接口不可用，请管理员核对部署路由与服务版本。'
  if (status === 409) return '检查依赖或开关版本已变化，请重新执行开启前检查。'
  if (status === 429) return '请求过于频繁，请稍后重试。'
  if (typeof status === 'number' && status >= 500) return '服务暂时不可用，请管理员核对 Core、Bridge 和 BFF 的运行状态。'
  if (status === 0 || code === 'ERR_NETWORK') return '网络连接失败，请检查连接后重试。'
  return '请求未完成，请稍后重试或联系管理员核对服务端诊断。'
}

function readState(kind: PaidMedia, data: unknown): PaidState {
  const value = object(data)
  if (value.media !== kind || typeof value.mode !== 'string' || typeof value.reason !== 'string' ||
      typeof value.requested_enabled !== 'boolean' || typeof value.effective_enabled !== 'boolean' ||
      typeof value.revision !== 'string' || (value.effective_enabled && !value.requested_enabled)) throw invalidResponse()
  return value as unknown as PaidState
}

function readReport(kind: PaidMedia, data: unknown): PaidReport {
  const value = object(data)
  if (value.media !== kind || typeof value.pass !== 'boolean' || typeof value.fingerprint !== 'string' ||
      (value.pass && !value.fingerprint) || typeof value.checked_at !== 'string' || !Array.isArray(value.checks) ||
      !value.checks.every(item => {
        const check = object(item)
        return typeof check.code === 'string' && typeof check.pass === 'boolean' &&
          (check.account_id === undefined || (typeof check.account_id === 'number' && Number.isSafeInteger(check.account_id) && check.account_id > 0)) &&
          (check.product_id === undefined || typeof check.product_id === 'string') &&
          (check.path === undefined || typeof check.path === 'string')
      })) throw invalidResponse()
  return value as unknown as PaidReport
}

const path = (kind: PaidMedia) => `/admin/media-workbench/paid-controls/${kind}`
export const mediaPaidAPI = {
  async status(kind: PaidMedia) { return readState(kind, (await apiClient.get<unknown>(path(kind))).data) },
  async check(kind: PaidMedia) { return readReport(kind, (await apiClient.post<unknown>(`${path(kind)}/check`, {}, { timeout: PAID_CHECK_TIMEOUT_MS })).data) },
  async apply(kind: PaidMedia, enabled: boolean, state: PaidState, report?: PaidReport) {
    const body = { enabled, expected_revision: state.revision, fingerprint: report?.fingerprint ?? '' }
    const data = object((await apiClient.put<unknown>(path(kind), body, enabled ? { timeout: PAID_CHECK_TIMEOUT_MS } : undefined)).data)
    return { state: readState(kind, data.state), ...(data.report ? { report: readReport(kind, data.report) } : {}) }
  }
}

import { apiClient, buildGatewayUrl } from './client'
import { uploadStudioAsset } from './studioAssets'

export { uploadStudioAsset }
export type StudioKind = 'image' | 'video'
export interface StudioOffer {
  input_mode?: string; offer_id: string; model: string; display_name: string; upstream_model: string
  spec: { resolution?: string[]; duration_seconds?: number[]; aspect_ratio?: string[]; quality?: string[]; count: { min: number; max: number }; references: { image: {min: number; max: number}; video: {min: number; max: number}; audio: {min: number; max: number}; total_max: number } }
}
export interface StudioPrice { amount: string; currency: string; billing_mode: string }
export interface StudioTask {
  id: string; kind: StudioKind; status: string; createdAt: string; expiresAt: string
  offerId: string; model: string; spec: Record<string, unknown>; price: StudioPrice; resultCount: number
  unitPrice?: StudioPrice; quantity?: number; totalPrice?: StudioPrice
  expectedCount?: number; deliveredCount?: number; failedCount?: number; pendingCount?: number
  billingState?: string; settledPrice?: StudioPrice
  execution?: Record<string, unknown>
}
export class StudioError extends Error {
  constructor(public code: string, public status = 0) { super(code) }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('studio_contract')
  return value as Record<string, unknown>
}
export function studioPrice(value: unknown): StudioPrice {
  const p = record(value)
  if (typeof p.amount !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(p.amount) ||
    typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency) || p.billing_mode !== 'per_request') throw new StudioError('studio_contract')
  return { amount: p.amount, currency: p.currency, billing_mode: p.billing_mode }
}
export function studioTaskView(kind: StudioKind, value: unknown): StudioTask {
  const v = record(value), id = kind === 'image' ? v.task_id : v.operation_id
  const contract = kind === 'image' ? 'published_image_binding_v1' : 'account_video_v1'
  if (v.contract !== contract || typeof id !== 'string' || !(kind === 'image' ? /^img_[a-f0-9]{32}$/ : /^op_[a-f0-9]{64}$/).test(id) || typeof v.status !== 'string') throw new StudioError('studio_contract')
  const statuses: Record<string, string> = { intent: 'prepared', captured: 'completed', accepted: 'processing', dispatching: 'unknown', persisted: 'billing_pending' }
  const status = statuses[v.status] || v.status
  if (!['prepared','completed','partial','unknown','billing_pending','processing','queued','failed','released','reserve_pending','recovery_blocked'].includes(status)) throw new StudioError('studio_contract')
  const spec = record(v.spec)
  const totalPrice = studioPrice(v.total_price ?? v.sale_price)
  const unitPrice = v.unit_price === undefined ? (kind === 'video' ? totalPrice : undefined) : studioPrice(v.unit_price)
  const quantityValue = v.quantity === undefined ? spec.count : v.quantity
  if (typeof quantityValue !== 'number') throw new StudioError('studio_contract')
  const quantity = quantityValue
  if (!Number.isInteger(quantity) || quantity < 1 || quantity !== spec.count || (kind === 'video' ? quantity !== 1 : quantity > 10)) throw new StudioError('studio_contract')
  if (unitPrice) {
    const units = (amount: string) => { const [whole, fraction = ''] = amount.split('.'); return BigInt(`${whole}${fraction.padEnd(8, '0')}`) }
    if (unitPrice.currency !== totalPrice.currency || units(unitPrice.amount) * BigInt(quantity) !== units(totalPrice.amount)) throw new StudioError('studio_contract')
  }
  const count = (name: string, fallback: number) => typeof v[name] === 'number' && Number.isInteger(v[name]) && v[name] >= 0 ? v[name] as number : fallback
  const deliveredCount = count('delivered_count', 0)
  const expectedCount = count('expected_count', quantity)
  const failedCount = count('failed_count', 0)
  const pendingCount = count('pending_count', 0)
  const settledPrice = v.settled_price === undefined ? undefined : studioPrice(v.settled_price)
  return { id, kind, status, createdAt: typeof v.created_at === 'string' ? v.created_at : '', expiresAt: typeof v.expires_at === 'string' ? v.expires_at : '',
    offerId: typeof v.offer_id === 'string' ? v.offer_id : '', model: typeof v.model === 'string' ? v.model : '', spec, price: totalPrice, unitPrice, quantity, totalPrice,
    expectedCount, deliveredCount, failedCount, pendingCount, billingState: typeof v.billing_state === 'string' ? v.billing_state : undefined, settledPrice,
    execution: v.execution && typeof v.execution === 'object' ? v.execution as Record<string, unknown> : undefined,
    resultCount: !['completed','partial'].includes(status) ? 0 : kind === 'video' ? 1 : Array.isArray(v.results) ? v.results.length : deliveredCount }
}
async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(buildGatewayUrl(url), { signal: AbortSignal.timeout(60000), ...init, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.headers || {}) } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'studio_unavailable'
    throw new StudioError(code, response.status)
  }
  return body
}
let sessionRequest: { token: string | null; promise: Promise<{ owner_id: number }> } | undefined
function sameWebsiteSession(token: string | null) {
  if (localStorage.getItem('auth_token') !== token) throw new StudioError('studio_session_changed')
}
export function ensureStudioSession(): Promise<{ owner_id: number }> {
  const token = localStorage.getItem('auth_token'), previous = sessionRequest
  if (previous?.token === token) return previous.promise
  // Serialize cookie exchanges across identity changes. A late exchange for the
  // previous user must finish before the next user's cookie can be established.
  const promise = (async () => {
    if (previous) await previous.promise.catch(() => undefined)
    sameWebsiteSession(token)
    const { data: user } = await apiClient.get<{ id: number }>('/auth/me')
    sameWebsiteSession(token)
    const existing = await fetch(buildGatewayUrl('/studio-v2/api/session'), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
    sameWebsiteSession(token)
    if (existing.ok) { const session = record(await existing.json()); sameWebsiteSession(token); if (session.owner_id === user.id) return { owner_id: user.id } }
    const issued = await apiClient.post<{ ticket: string }>('/auth/studio-media-ticket')
    sameWebsiteSession(token)
    if (!issued.data.ticket) throw new StudioError('studio_ticket_unavailable')
    const result = record(await json('/studio-v2/api/session/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Request': 'session-exchange-v1' }, body: JSON.stringify({ ticket: issued.data.ticket }) }))
    sameWebsiteSession(token)
    if (result.owner_id !== user.id) throw new StudioError('studio_session_mismatch')
    return { owner_id: user.id }
  })().finally(() => { if (sessionRequest?.promise === promise) sessionRequest = undefined })
  sessionRequest = { token, promise }
  return promise
}
export async function studioRequest<T = unknown>(kind: StudioKind, operation: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem('auth_token')
  await ensureStudioSession()
  sameWebsiteSession(token)
  const result = await json(`/studio-v2/api/${kind}/${operation}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Request': `${kind}-binding-v1` }, body: JSON.stringify(body) })
  sameWebsiteSession(token)
  return result as T
}
export async function studioCatalog(kind: StudioKind): Promise<StudioOffer[]> {
  const value = await studioRequest<unknown>(kind, 'catalog')
  const offers = Array.isArray(value) ? value : record(value).offers
  if (!Array.isArray(offers) || offers.some(o => typeof o?.offer_id !== 'string' || typeof o.model !== 'string' || typeof o.upstream_model !== 'string' || !o.spec?.count || !o.spec?.references)) throw new StudioError('studio_contract')
  return offers
}
export async function studioHistory(kind: StudioKind): Promise<StudioTask[]> {
  const result = await studioRequest(kind, kind === 'image' ? 'tasks' : 'operations')
  const values = kind === 'image' ? record(result).tasks : result
  if (!Array.isArray(values)) throw new StudioError('studio_contract')
  return values.filter(v => kind !== 'video' || record(v).contract === 'account_video_v1').map(v => studioTaskView(kind, v)).sort((a,b) => b.createdAt.localeCompare(a.createdAt))
}
export async function studioTask(task: StudioTask): Promise<StudioTask> {
  return studioTaskView(task.kind, await studioRequest(task.kind, `${task.kind === 'image' ? 'tasks' : 'operations'}/${task.id}`))
}
export async function studioGenerate(task: StudioTask): Promise<StudioTask> {
  return studioTaskView(task.kind, await studioRequest(task.kind, 'tasks', task.kind === 'image' ? { task_id: task.id } : { operation_id: task.id }))
}
export function studioResultUrl(task: StudioTask, index = 0): string {
  if (!['completed','partial'].includes(task.status) || !Number.isInteger(index) || index < 0 || index >= task.resultCount) throw new StudioError('result_unavailable')
  return buildGatewayUrl(`/studio-v2/api/${task.kind}/${task.kind === 'image' ? `tasks/${task.id}/results/${index}` : `operations/${task.id}/original`}`)
}
export function studioErrorMessage(error: unknown): string {
  if (error instanceof Error && ['invalid_local_asset','file_changed','asset_upload_failed','invalid_asset_receipt'].includes(error.message)) return '素材上传或校验未通过，请检查类型、大小和数量。'
  if (error instanceof Error && error.message === 'login_required') return '登录已失效，请重新登录后查询原任务。'
  if (error instanceof StudioError) {
    if (error.status === 401 || error.code.includes('session') || error.code.includes('ticket')) return '登录或工作台会话已失效，请重新登录后查询原任务。'
    if (error.code.includes('paid_gate_off')) return '当前生成服务未开放；已保存的任务仍可查询。'
    if (error.code.endsWith('quote_expired')) return '报价已失效。未提交的任务需重新获取报价并确认。'
    if (error.code.includes('preparation')) return '素材准备记录缺失或不匹配，请核对原素材和规格；已提交任务只查询恢复。'
    if (error.code.includes('asset') || error.code.includes('media_request')) return '素材类型、大小、归属或内容校验未通过，请检查素材。'
    if (error.code === 'unsupported_model') return '模型未配置、已暂停或当前规格不可用，请刷新目录。'
    if (error.code === 'studio_contract') return '工作台响应不完整，已停止操作，请稍后查询。'
    if (error.status === 403 || error.status === 409 || error.status === 422) return '报价、素材、模型状态或访问权限校验未通过；已提交任务不会重新生成。'
  }
  return '连接暂时不可用。若已点击生成，结果待确认，请查询原任务，勿重复提交。'
}

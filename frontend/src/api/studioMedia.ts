import { apiClient, buildGatewayUrl } from './client'
import { uploadStudioAsset } from './studioAssets'

export { uploadStudioAsset }

export interface StudioOffer {
  input_mode?: string; offer_id: string; model: string; display_name: string; upstream_model: string
  spec: { resolution?: string[]; duration_seconds?: number[]; aspect_ratio?: string[]; quality?: string[]; count: { min: number; max: number }; references: { image: {min: number; max: number}; video: {min: number; max: number}; audio: {min: number; max: number}; total_max: number } }
}
export async function studioRequest<T>(kind: 'image' | 'video', operation: string, body?: unknown): Promise<T> {
  await ensureStudioSession()
  return json<T>(`/studio/api/${kind}/${operation}`, body === undefined ? undefined : {method:'POST', headers:{'Content-Type':'application/json','X-Studio-Request':`${kind}-binding-v1`},body:JSON.stringify(body)})
}
export async function studioCatalog(kind: 'image' | 'video'): Promise<StudioOffer[]> {
  const value = await studioRequest<unknown>(kind, 'catalog')
  const offers = Array.isArray(value) ? value : value && typeof value === 'object' && 'offers' in value ? value.offers : null
  if (!Array.isArray(offers) || offers.some(o => typeof o?.offer_id !== 'string' || typeof o.model !== 'string' || typeof o.upstream_model !== 'string' || !o.spec?.count || !o.spec?.references)) throw Error('studio_catalog_contract')
  return offers
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildGatewayUrl(url), { ...init, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.headers || {}) } })
  if (!response.ok) throw new Error(`studio_http_${response.status}`)
  return await response.json() as T
}

export async function ensureStudioSession(): Promise<{ owner_id: number }> {
  const existing = await fetch('/studio/api/session', { credentials: 'same-origin', cache: 'no-store' })
  if (existing.ok) return await existing.json() as { owner_id: number }
  const issued = await apiClient.post<{ ticket: string }>('/auth/studio-ticket')
  const ticket = issued.data.ticket
  if (!ticket) throw new Error('studio_ticket_unavailable')
  return await json('/studio/api/session/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Request': 'session-exchange-v1' }, body: JSON.stringify({ ticket }) })
}

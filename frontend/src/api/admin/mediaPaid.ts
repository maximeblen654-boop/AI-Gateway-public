import { apiClient } from '../client'
export type PaidMedia = 'image' | 'video'
export interface PaidState { media: PaidMedia; mode: string; requested_enabled: boolean; effective_enabled: boolean; revision: string; reason: string }
export interface PaidCheck { code: string; pass: boolean; account_id?: number; product_id?: string; path?: string }
export interface PaidReport { pass: boolean; fingerprint: string; checks: PaidCheck[]; checked_at: string }
const path = (kind: PaidMedia) => `/admin/media-workbench/paid-controls/${kind}`
export const mediaPaidAPI = {
  async status(kind: PaidMedia) { return (await apiClient.get<PaidState>(path(kind))).data },
  async check(kind: PaidMedia) { return (await apiClient.post<PaidReport>(`${path(kind)}/check`, {})).data },
  async apply(kind: PaidMedia, enabled: boolean, state: PaidState, report?: PaidReport) {
    return (await apiClient.put<{ state: PaidState; report?: PaidReport }>(path(kind), { enabled, expected_revision: state.revision, fingerprint: report?.fingerprint ?? '' })).data
  }
}

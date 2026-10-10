import { apiClient } from '../client'
import { syncUpstreamModels } from './accounts'

export interface Range { min: number; max: number }
export interface References { image: Range; video: Range; audio: Range; total_max: number }
export interface Match {
  resolution?: string[]; duration_seconds?: number[]; aspect_ratio?: string[]; quality?: string[]
  count?: Range; references?: References
}
export interface Price { amount: string; currency: string; billing_mode: string }
export interface PricingRule { match: Match; sale_price: Price | null }
export interface SizeMapping { resolution: string; aspect_ratio: string; wire_size: string }
export type ImageExecutionMode = 'single' | 'native_multi' | 'provider_async'
export interface ImageExecutionConfig { mode?: ImageExecutionMode; max_output_images?: number; provider?: string }
export interface AdapterConfig { size_mappings: SizeMapping[]; version?: number; wire_profile?: string; model_family?: string; execution?: ImageExecutionConfig; edit_execution?: ImageExecutionConfig }
export interface Product {
  product_id: string; media_type: string; site_model: string; display_name: string
  upstream_model: string; enabled: boolean
  capabilities: {
    resolutions: string[]; aspect_ratios: string[]; qualities: string[]; durations_seconds: number[]
    count: Range; references: References; combination_rules: { deny: Match }[]
  }
  pricing_rules: PricingRule[]
  adapter_config: AdapterConfig
}
export interface Diagnostic {
  class: string; severity: string; code: string; scope: string; path: string; message: string; action: string
}
export interface Validation {
  draft_revision: string; status: string; publish_ready: boolean; checked_at: string
  diagnostics: Diagnostic[]; previews?: unknown; adapter_registry_revision?: string
}
export interface MediaConfig {
  record_version: number; media_types: string[]
  sales: { enabled: boolean }
  draft: { revision: string; updated_at: string; products: Product[] }
  validation: Validation
  published: { revision: string; source_draft_revision: string; products?: Product[]; offers?: unknown[] } | null
  procurement?: { entries: { product_id: string; cost: Price; source: string }[] }
}
export interface SupplierDetail {
  id: number; name: string; host: string; platform: string; type: string; status: string; schedulable: boolean
  effective_sales: boolean; effective_state: string; sales_resume_ready?: boolean
  model_catalog: { source: string; synced_at: string; models: string[] } | null
  media_workbench_v1: MediaConfig | null
  models: { model_id: string; state: string }[]
  discovered_count: number; configured_count: number; pending_count: number; problem_count: number
}
export interface PublishAcknowledgement { record_version?: number; published_revision?: string }

const range = (value: Range): Range => ({ min: value.min, max: value.max })
const references = (value: References): References => ({
  image: range(value.image), video: range(value.video), audio: range(value.audio), total_max: value.total_max
})
function match(value: Match): Match {
  return {
    ...(value.resolution ? { resolution: [...value.resolution] } : {}),
    ...(value.duration_seconds ? { duration_seconds: [...value.duration_seconds] } : {}),
    ...(value.aspect_ratio ? { aspect_ratio: [...value.aspect_ratio] } : {}),
    ...(value.quality ? { quality: [...value.quality] } : {}),
    ...(value.count ? { count: range(value.count) } : {}),
    ...(value.references ? { references: references(value.references) } : {})
  }
}
// Responses may grow; only documented editable fields can cross the strict write boundary.
export function draftInput(products: Product[]): { products: Product[] } {
  return { products: products.map(p => ({
    product_id: p.product_id, media_type: p.media_type, site_model: p.site_model,
    display_name: p.display_name, upstream_model: p.upstream_model, enabled: p.enabled,
    adapter_config: { ...(p.adapter_config?.version ? { version: p.adapter_config.version } : {}), ...(p.adapter_config?.wire_profile ? { wire_profile: p.adapter_config.wire_profile } : {}), ...(p.adapter_config?.model_family ? { model_family: p.adapter_config.model_family } : {}), ...(p.adapter_config?.execution ? { execution: { ...(p.adapter_config.execution.mode ? { mode: p.adapter_config.execution.mode } : {}), ...(p.adapter_config.execution.max_output_images ? { max_output_images: p.adapter_config.execution.max_output_images } : {}), ...(p.adapter_config.execution.provider ? { provider: p.adapter_config.execution.provider } : {}) } } : {}), ...(p.adapter_config?.edit_execution ? { edit_execution: { ...(p.adapter_config.edit_execution.mode ? { mode: p.adapter_config.edit_execution.mode } : {}), ...(p.adapter_config.edit_execution.max_output_images ? { max_output_images: p.adapter_config.edit_execution.max_output_images } : {}), ...(p.adapter_config.edit_execution.provider ? { provider: p.adapter_config.edit_execution.provider } : {}) } } : {}), size_mappings: (p.adapter_config?.size_mappings ?? []).map(mapping => ({
      resolution: mapping.resolution, aspect_ratio: mapping.aspect_ratio, wire_size: mapping.wire_size
    })) },
    capabilities: {
      resolutions: [...(p.capabilities.resolutions ?? [])], aspect_ratios: [...(p.capabilities.aspect_ratios ?? [])],
      qualities: [...(p.capabilities.qualities ?? [])], durations_seconds: [...(p.capabilities.durations_seconds ?? [])],
      count: range(p.capabilities.count), references: references(p.capabilities.references),
      combination_rules: (p.capabilities.combination_rules ?? []).map(rule => ({ deny: match(rule.deny) }))
    },
    pricing_rules: (p.pricing_rules ?? []).map(rule => ({ match: match(rule.match), sale_price: rule.sale_price == null ? null : {
      amount: rule.sale_price.amount, currency: rule.sale_price.currency, billing_mode: rule.sale_price.billing_mode
    } }))
  })) }
}
const accountPath = (id: number) => `/admin/media-workbench/accounts/${id}`
export const mediaWorkbenchAPI = {
  async suppliers(): Promise<SupplierDetail[]> {
    return (await apiClient.get<SupplierDetail[]>('/admin/media-workbench/suppliers')).data
  },
  async detail(id: number): Promise<SupplierDetail> {
    return (await apiClient.get<SupplierDetail>(accountPath(id))).data
  },
  async initialize(id: number, mediaTypes: string[]): Promise<SupplierDetail> {
    return (await apiClient.post<SupplierDetail>(`${accountPath(id)}/initialize`, { media_types: [...mediaTypes] })).data
  },
  async saveDraft(id: number, version: number, products: Product[]): Promise<SupplierDetail> {
    return (await apiClient.put<SupplierDetail>(`${accountPath(id)}/draft`, {
      expected_record_version: version, draft: draftInput(products)
    })).data
  },
  async publish(id: number, version: number, revision: string): Promise<SupplierDetail | PublishAcknowledgement> {
    return (await apiClient.post<SupplierDetail | PublishAcknowledgement>(`${accountPath(id)}/publish`, {
      expected_record_version: version, expected_draft_revision: revision
    })).data
  },
  async sales(id: number, version: number, enabled: boolean): Promise<SupplierDetail> {
    return (await apiClient.put<SupplierDetail>(`${accountPath(id)}/sales`, {
      expected_record_version: version, enabled
    })).data
  },
  sync: syncUpstreamModels
}

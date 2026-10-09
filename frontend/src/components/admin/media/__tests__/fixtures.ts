import type { SupplierDetail, Product } from '@/api/admin/mediaWorkbench'
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const imageProduct: Product = {
  product_id: 'canvas-1', media_type: 'image', site_model: 'canvas-image-01', display_name: '画布图片', upstream_model: 'image-native-1', enabled: true,
  capabilities: { resolutions: ['1K', '4K'], aspect_ratios: ['1:1', '16:9'], qualities: [], durations_seconds: [], count: { min: 1, max: 1 },
    references: { image: { min: 0, max: 4 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 4 }, combination_rules: [] },
  pricing_rules: [{ match: {}, sale_price: { amount: '0.18', currency: 'CNY', billing_mode: 'per_request' } }],
  adapter_config: { size_mappings: [
    { resolution: '2K', aspect_ratio: '1:1', wire_size: '2048x2048' },
    { resolution: '2K', aspect_ratio: '16:9', wire_size: '2560x1440' }
  ] }
}
export function supplier(id = 77, status = 'PASS'): SupplierDetail {
  const result: SupplierDetail = {
    id, name: id === 77 ? '示例图片供应商' : '示例视频供应商', host: id === 77 ? 'images.example.invalid' : 'video.example.invalid', platform: id === 77 ? 'openai' : 'gemini', type: 'apikey', status: 'active', schedulable: true,
    effective_sales: true, effective_state: 'ACTIVE', sales_resume_ready: true,
    model_catalog: { source: 'native-sync', synced_at: '2026-10-05T01:10:00Z', models: ['image-native-1', 'new-model', 'flow-needs-development'] },
    discovered_count: 3, configured_count: 1, pending_count: 2, problem_count: status === 'PASS' ? 0 : 1,
    models: [{ model_id: 'image-native-1', state: 'PUBLISHED' }, { model_id: 'new-model', state: 'PENDING' }, { model_id: 'flow-needs-development', state: 'NEEDS_DEVELOPMENT' }],
    media_workbench_v1: {
      record_version: 3, media_types: ['image', 'video'], sales: { enabled: true },
      draft: { revision: 'mwd_a', updated_at: '2026-10-05T01:42:00Z', products: [copy(imageProduct)] },
      validation: { draft_revision: 'mwd_a', status, publish_ready: status === 'PASS', checked_at: '2026-10-05T01:42:01Z', diagnostics: [] },
      published: { revision: 'mwp_a', source_draft_revision: 'mwd_a', products: [copy(imageProduct)], offers: [{ offer_id: 'offer-1' }] }
    }
  }
  if (status === 'FAIL' || status === 'UNKNOWN') result.media_workbench_v1!.validation.diagnostics = [{
    class: status === 'UNKNOWN' ? 'UNKNOWN' : 'UI_FIXABLE', severity: 'error', code: status === 'UNKNOWN' ? 'VALIDATION_UNAVAILABLE' : 'MISSING_PRICE', scope: 'product',
    path: 'draft.products[0].pricing_rules[0].sale_price', message: status === 'UNKNOWN' ? '后台依赖暂不可用' : '4K 条件缺少售价', action: '处理后保存草稿'
  }]
  return result
}
export function saved(status = 'PASS'): SupplierDetail {
  const dto = supplier(77, status)
  dto.media_workbench_v1!.record_version = 4
  dto.media_workbench_v1!.draft.revision = 'mwd_b'
  dto.media_workbench_v1!.validation.draft_revision = 'mwd_b'
  return dto
}

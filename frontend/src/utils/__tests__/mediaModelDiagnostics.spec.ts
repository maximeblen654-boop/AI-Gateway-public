import { describe, expect, it } from 'vitest'
import type { Diagnostic, Product } from '@/api/admin/mediaWorkbench'
import { copy, imageProduct } from '@/components/admin/media/__tests__/fixtures'
import { mediaDiagnosticsForModel, mediaVisibleDiagnostics } from '../mediaAdminPresentation'
import { mediaModelDiagnosticReport, mediaModelDiagnosticText } from '../mediaModelDiagnostics'

const issue = (scope: string, code = 'PROGRAM_FEATURE_UNSUPPORTED', path = 'capabilities'): Diagnostic => ({ class: 'NEEDS_DEVELOPMENT', severity: 'error', code, scope, path, message: '尚未接通这项功能', action: '由维护者核查' })
function products(): Product[] {
  const first = copy(imageProduct), second = copy(imageProduct)
  second.product_id = 'video-other'; second.display_name = '其他型号商品'; second.upstream_model = 'another-model'; second.media_type = 'video'
  return [first, second]
}

describe('model-bound diagnostic reports', () => {
  it('uses stable scope IDs and full draft indexes without leaking another model', () => {
    const [first, other] = products() as [Product, Product]
    const own = issue(first.product_id, 'OWN', 'draft.products[1].capabilities')
    const foreign = issue(other.product_id, 'FOREIGN', 'draft.products[0].capabilities')
    const legacyOwn = issue('product', 'LEGACY', 'draft.products[0].capabilities')
    const legacyForeign = issue('product', 'LEGACY_FOREIGN', 'draft.products[1].capabilities')
    const account = issue('account', 'AUTH_FLOW_UNSUPPORTED', 'account')
    expect(mediaDiagnosticsForModel([foreign, own, legacyForeign, legacyOwn, account], first.upstream_model, [first, other])).toEqual([own, legacyOwn, account])
    expect(mediaDiagnosticsForModel([own, foreign], first.upstream_model)).toEqual([])
  })

  it('prioritizes missing models while preserving genuinely unsupported features elsewhere', () => {
    const [first, other] = products() as [Product, Product]
    const missing = { ...issue(first.product_id, 'MODEL_NOT_DISCOVERED', 'upstream_model'), class: 'UI_FIXABLE' }
    const unsupported = issue(other.product_id)
    expect(mediaVisibleDiagnostics([issue(first.product_id), unsupported, missing], [first, other])).toEqual([missing, unsupported])
  })

  it('copies source, intent, identities and allowed configuration, never another product or business data', () => {
    const [first, other] = products() as [Product, Product]
    first.adapter_config.execution = { mode: 'native_multi', max_output_images: 2 }
    Object.assign(first, { credential: 'secret-token-unique', customer: 'private-customer', extra: { api_key: 'secret-key' } })
    Object.assign(first.capabilities, { token: 'nested-secret-capability' })
    Object.assign(first.adapter_config, { password: 'nested-secret-adapter' })
    const validation = { draft_revision: 'checked-revision', checked_at: '2026-10-26T04:10:00Z', status: 'FAIL', publish_ready: false, diagnostics: [] }
    const report = mediaModelDiagnosticReport({ accountId: 77, modelId: first.upstream_model, draftRevision: 'local-revision', validation, current: false, diagnostics: [issue(first.product_id), issue(other.product_id)], productDetails: [first, other] })
    expect(report.source).toBe('媒体工作台 → 商品模型配置 → 需要技术适配 → 复制给 Codex')
    expect(report.intent_question).toContain('新增支持这项能力')
    expect(report.intent_question).toContain('恢复正常使用')
    expect(report).toMatchObject({ account_id: 77, model_id: first.upstream_model, draft_revision: 'local-revision', validation: { draft_revision: 'checked-revision', checked_at: validation.checked_at, current: false } })
    expect(report.products).toHaveLength(1)
    expect(report.products[0]).toMatchObject({ product_id: first.product_id, display_name: first.display_name, model_id: first.upstream_model, media_type: 'image', capabilities: { references: first.capabilities.references }, adapter_config: { execution: first.adapter_config.execution } })
    expect(JSON.stringify(report)).not.toMatch(/video-other|其他型号商品|another-model|sale_price|pricing_rules|cost_rules|0\.18|secret|private-customer|password|api_key/)
  })

  it('keeps account failures separate and represents missing evidence explicitly', () => {
    const report = mediaModelDiagnosticReport({ modelId: '', current: false, diagnostics: [issue('missing-product'), issue('account', 'AUTH_FLOW_UNSUPPORTED', 'account')] })
    expect(report.account_id).toBe('UNKNOWN')
    expect(report.draft_revision).toBe('UNKNOWN')
    expect(report.validation).toMatchObject({ checked_at: 'UNKNOWN', draft_revision: 'UNKNOWN' })
    expect(report.products[0]).toMatchObject({ product_id: 'missing-product', model_id: 'UNKNOWN', media_type: 'UNKNOWN', capabilities: 'UNKNOWN', adapter_config: 'UNKNOWN' })
    expect(report.account_diagnostics).toHaveLength(1)
    expect(report.products[0]!.diagnostics).toHaveLength(1)
    expect(mediaModelDiagnosticText({ modelId: '', current: false, diagnostics: [] })).toContain('UNKNOWN')
  })
})


describe('failed rebinding report context', () => {
  it('identifies the actual candidate, original binding and native adapter without unrelated data', () => {
    const [candidate, other] = products() as [Product, Product]
    candidate.upstream_model = 'checked-model'
    const report = mediaModelDiagnosticReport({ accountId: 44, accountHost: 'video.laoliimage2.win', nativeAdapters: { video: { kind: 'laoli_video', revision: 'installed-r1' } }, modelId: '', requestedModelId: 'requested-model', originalModelId: 'old-model', current: false, preview: true, diagnostics: [issue(candidate.product_id)], productDetails: [candidate, other] })
    expect(report.model_id).toBe('checked-model')
    expect(report.title).toContain('Account #44 · checked-model')
    expect(report.operation_state).toContain('不能视为换绑成功')
    expect(report.problem_summary).toEqual(['尚未接通这项功能'])
    expect(report.original_model_id).toBe('old-model')
    expect(report.requested_model_id).toBe('requested-model')
    expect(report.account_context).toEqual({ upstream_host: 'video.laoliimage2.win', native_adapters: { video: { kind: 'laoli_video', revision: 'installed-r1' } } })
    expect(report.report_scope).toContain('不是整个账号')
    expect(report.configuration_note).toContain('原发布')
    expect(report.validation.applies_to).toContain('本次候选')
    expect(report.products).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain(other.upstream_model)
  })

  it('uses a known requested ID when candidate data is unavailable and excludes credential-shaped host input', () => {
    const report = mediaModelDiagnosticReport({ modelId: '', requestedModelId: 'new-model', accountHost: 'user:password@host.invalid/path', current: false, preview: true, diagnostics: [] })
    expect(report.model_id).toBe('new-model')
    expect(report.account_context.upstream_host).toBe('UNKNOWN')
    expect(JSON.stringify(report)).not.toContain('password')
  })
})


it('copies only the selected product when two products share the same upstream model', () => {
  const [first, other] = products() as [Product, Product]
  other.upstream_model = first.upstream_model
  const report = mediaModelDiagnosticReport({ modelId: first.upstream_model, productId: first.product_id, current: true, diagnostics: [issue(first.product_id, 'OWN'), issue(other.product_id, 'SIBLING')], productDetails: [first, other] })
  expect(report.products.map(product => product.product_id)).toEqual([first.product_id])
  expect(JSON.stringify(report)).not.toMatch(/SIBLING|video-other/)
  expect(report.report_scope).toContain('当前选中的商品')
})

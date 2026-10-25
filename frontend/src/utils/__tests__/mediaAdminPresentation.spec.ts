import { describe, expect, it } from 'vitest'
import { copy, imageProduct } from '@/components/admin/media/__tests__/fixtures'
import { mediaDiagnosticGuidance, mediaPublicationLabel, mediaProductPublicationLabel } from '../mediaAdminPresentation'
import type { Diagnostic } from '@/api/admin/mediaWorkbench'

describe('administrator readable media feedback', () => {
  it('keeps the current product status independent of other unpublished products and unsaved input', () => {
    const current = copy(imageProduct), published = copy(current)
    const other = copy(current); other.product_id = 'other'; other.pricing_rules[0]!.sale_price!.amount = '9'
    expect(mediaPublicationLabel([current, other], [published])).toContain('仍有配置待发布')
    expect(mediaProductPublicationLabel(current, current, published)).toBe('当前商品与已发布配置一致')
    expect(mediaProductPublicationLabel(current, current, undefined)).toBe('当前商品尚未发布')
    const changed = copy(current); changed.pricing_rules[0]!.sale_price!.amount = '8'
    expect(mediaProductPublicationLabel(changed, current, published)).toContain('未保存修改')
    expect(mediaProductPublicationLabel(changed, changed, published)).toContain('草稿有待发布修改')
    const rebound = copy(current); rebound.upstream_model = 'another-model'
    expect(mediaProductPublicationLabel(rebound, rebound, published)).toContain('待发布修改')
  })
  it('shows an actionable explanation without protocol labels or raw failure codes', () => {
    const diagnostic: Diagnostic = { class: 'UI_FIXABLE', severity: 'error', code: 'IMAGE2PRO_VIDEO_METADATA_REQUIRED', scope: 'sample', path: 'adapter_config.image2pro', message: 'opaque_protocol_xyz_v123', action: 'call internal code path' }
    const guidance = mediaDiagnosticGuidance(diagnostic)
    expect(guidance.message).toContain('有效能力信息')
    expect(guidance.action).toContain('刷新模型列表')
    expect(JSON.stringify(guidance)).not.toMatch(/opaque|adapter|IMAGE2PRO/)
    diagnostic.code = 'FUTURE_TECHNICAL_CODE'
    expect(mediaDiagnosticGuidance(diagnostic).message).toBe('这项配置尚未通过检查。')
    diagnostic.message = '4K 采购成本尚未填写'; diagnostic.action = '前往第 4 步填写'
    expect(mediaDiagnosticGuidance(diagnostic)).toEqual({ message: diagnostic.message, action: diagnostic.action })
  })
  it('explains a missing upstream model without directing administrators to formats or prices', () => {
    const diagnostic: Diagnostic = { class: 'UI_FIXABLE', severity: 'error', code: 'MODEL_NOT_DISCOVERED', scope: 'sample', path: 'upstream_model', message: 'Upstream model is absent from the last successful snapshot', action: 'Edit the indicated Draft field and save again' }
    const guidance = mediaDiagnosticGuidance(diagnostic)
    expect(guidance.message).toContain('上游模型列表')
    expect(guidance.message).toContain('没有这个商品绑定的型号')
    expect(guidance.action).toContain('返回模型列表')
    expect(JSON.stringify(guidance)).not.toMatch(/PNG|JPEG|WEBP|规格或售价|MODEL_NOT_DISCOVERED/)
  })
  it('compares each published product instead of treating one Account revision as all published', () => {
    const first = copy(imageProduct), second = copy(imageProduct)
    second.product_id = 'another-product'; second.display_name = '另一商品'
    expect(mediaPublicationLabel([first], undefined)).toBe('尚未发布')
    expect(mediaPublicationLabel([first], [copy(first)])).toContain('与已发布配置一致')
    expect(mediaPublicationLabel([first, second], [copy(first)])).toBe('部分商品已保存，仍有配置待发布')
    const changed = copy(first); changed.pricing_rules[0]!.sale_price!.amount = '9'
    expect(mediaPublicationLabel([changed], [first])).toBe('草稿已保存，当前配置待发布')
    const foreign = copy(first); foreign.upstream_model = 'other-model'
    expect(mediaPublicationLabel([first], [foreign])).toContain('待发布')
  })
})

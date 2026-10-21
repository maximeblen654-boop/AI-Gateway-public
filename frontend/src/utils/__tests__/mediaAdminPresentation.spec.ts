import { describe, expect, it } from 'vitest'
import { copy, imageProduct } from '@/components/admin/media/__tests__/fixtures'
import { mediaDiagnosticGuidance, mediaPublicationLabel } from '../mediaAdminPresentation'
import type { Diagnostic } from '@/api/admin/mediaWorkbench'

describe('administrator readable media feedback', () => {
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

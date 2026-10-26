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
  it('keeps a genuine unsupported protocol explanation instead of blaming image leftovers', () => {
    const diagnostic: Diagnostic = { class: 'NEEDS_DEVELOPMENT', severity: 'error', code: 'VIDEO_PROFILE_UNSUPPORTED', scope: 'sample', path: 'adapter_config.wire_profile', message: '当前视频协议与 Account 地址或原生执行器不匹配，须核对该账号实际使用的协议。', action: 'Develop the owning adapter' }
    const guidance = mediaDiagnosticGuidance(diagnostic)
    expect(guidance.message).toBe(diagnostic.message)
    expect(guidance.action).toContain('技术维护者')
    expect(JSON.stringify(guidance)).not.toContain('图片专用设置')
    expect(diagnostic.class).toBe('NEEDS_DEVELOPMENT')
  })
  it('explains common legacy configuration and dependency codes with distinct concrete reasons', () => {
    const cases: [string, string][] = [
      ['MISSING_PRICE', '还没有填写客户售价'], ['INVALID_PRICE', '8 位小数'], ['INVALID_PRICE_MATCH', '未配置的规格条件'], ['PRICE_RULE_OVERLAP', '多条售价'], ['UNUSED_PRICE_RULE', '没有对应的可售规格'],
      ['REQUIRED_FIELD', '必填标识'], ['DUPLICATE_PRODUCT', '重复的商品标识'], ['CONFIG_TOO_LARGE', '条目过多'], ['INVALID_VALUE_MAPPING', '尺寸值格式不正确'], ['MISSING_VALUE_MAPPING', '没有对应的供应商尺寸值'], ['DUPLICATE_VALUE_MAPPING', '多条尺寸映射'], ['IMAGE_SPEC_MAPPING_MISMATCH', '尺寸映射不一致'], ['INVALID_COMBINATION_RULE', '没有有效条件'], ['REFERENCE_LIMIT_EXCEEDED', '接入方式的上限'], ['NO_SELLABLE_SPEC', '都被禁止组合规则排除了'], ['NO_ENABLED_PRODUCT', '没有已启用的商品'], ['MODEL_SYNC_REQUIRED', '上游模型目录检查结果'],
      ['LOCAL_COMPILER_FAILURE', '发生程序错误'], ['LOCAL_DEPENDENCY_UNAVAILABLE', '校验依赖暂不可用'], ['DEPENDENCY_UNAVAILABLE', '校验依赖暂不可用'], ['VALIDATION_CANCELLED', '还没有检查完全部规格']
    ]
    for (const [code, reason] of cases) {
      const guidance = mediaDiagnosticGuidance({ class: 'UI_FIXABLE', severity: 'error', code, scope: 'sample', path: 'capabilities', message: 'Legacy English validation message', action: 'Edit the indicated Draft field and save again' })
      expect(guidance.message, code).toContain(reason)
      expect(guidance.message, code).not.toBe('这项配置尚未通过检查。')
      expect(guidance.action, code).not.toContain('Legacy')
    }
  })
  it('preserves precise Chinese causes and offers technical adaptation for genuinely missing program support', () => {
    const precise: Diagnostic = { class: 'UI_FIXABLE', severity: 'error', code: 'CONFIG_TOO_LARGE', scope: 'sample', path: 'capabilities.combination_rules', message: '规格排除规则最多配置 100 项。', action: '核对第 101 条排除规则后重新保存。' }
    expect(mediaDiagnosticGuidance(precise)).toEqual({ message: precise.message, action: precise.action })
    const codes = ['ADAPTER_UNKNOWN', 'ADAPTER_REVISION_UNSUPPORTED', 'AUTH_FLOW_UNSUPPORTED', 'TASK_FLOW_UNSUPPORTED', 'BUILDER_REFACTOR_REQUIRED', 'IMAGE_PROVIDER_ASYNC_UNAVAILABLE']
    for (const code of codes) {
      const diagnostic: Diagnostic = { class: 'NEEDS_DEVELOPMENT', severity: 'error', code, scope: 'sample', path: 'adapter_bindings', message: 'Feature is not implemented in this program', action: 'Develop the owning adapter' }
      const guidance = mediaDiagnosticGuidance(diagnostic)
      expect(guidance.message, code).not.toBe('这项配置尚未通过检查。')
      expect(guidance.action, code).toContain('新增支持这项能力')
      expect(guidance.action, code).toContain('恢复正常使用')
      expect(guidance.action, code).not.toMatch(/删除|移除/)
      expect(diagnostic.class, code).toBe('NEEDS_DEVELOPMENT')
    }
    const split = { ...precise, class: 'NEEDS_DEVELOPMENT', code: 'ADAPTER_UNKNOWN', message: '当前视频协议与 Account 地址或原生执行器不匹配，不能跨供应商沿用合同。' }
    expect(mediaDiagnosticGuidance(split).message).toBe(split.message)
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

import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaValidationPanel from '../MediaValidationPanel.vue'
import { copy, imageProduct } from './fixtures'
import type { Diagnostic } from '@/api/admin/mediaWorkbench'

const issue = (scope: string, code: string): Diagnostic => ({ class: 'NEEDS_DEVELOPMENT', severity: 'error', code, scope, path: 'capabilities', message: '接口尚未支持该功能', action: '由维护者核查' })
afterEach(() => { vi.unstubAllGlobals() })

describe('current model diagnostic panel', () => {
  it('changes displayed and copied products together when selecting another model', async () => {
    const first = copy(imageProduct), second = copy(imageProduct)
    second.product_id = 'second-product'; second.display_name = '其他商品'; second.upstream_model = 'second-model'; second.media_type = 'video'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mount(MediaValidationPanel, { props: { current: true, unavailable: false, saveState: 'saved', modelId: first.upstream_model, draftRevision: 'draft-current', accountId: 77, productDetails: [first, second], products: [{ product_id: first.product_id, label: first.display_name }, { product_id: second.product_id, label: second.display_name }], diagnostics: [issue(first.product_id, 'FIRST_UNSUPPORTED'), issue(second.product_id, 'SECOND_UNSUPPORTED')] } })
    expect(wrapper.findAll('[data-test="diagnostic-product"]').map(item => item.text())).toEqual([`所属商品：${first.display_name}`])
    expect(wrapper.get('[data-test="diagnostic-technical-details"]').text()).not.toContain('SECOND_UNSUPPORTED')
    await wrapper.get('[data-test="copy-codex"]').trigger('click'); await flushPromises()
    expect(JSON.parse(writeText.mock.calls[0]![0]).products.map((item: { product_id: string }) => item.product_id)).toEqual([first.product_id])
    await wrapper.setProps({ modelId: second.upstream_model })
    expect(wrapper.findAll('[data-test="diagnostic-product"]').map(item => item.text())).toEqual(['所属商品：其他商品'])
    await wrapper.get('[data-test="copy-codex"]').trigger('click'); await flushPromises()
    const report = JSON.parse(writeText.mock.calls[1]![0])
    expect(report.model_id).toBe(second.upstream_model)
    expect(report.products.map((item: { product_id: string }) => item.product_id)).toEqual([second.product_id])
    expect(JSON.stringify(report)).not.toContain('FIRST_UNSUPPORTED')
    wrapper.unmount()
  })

  it('shows unavailable original model before derived development errors and hides copying them', () => {
    const product = copy(imageProduct)
    const missing = { ...issue(product.product_id, 'MODEL_NOT_DISCOVERED'), class: 'UI_FIXABLE', path: 'upstream_model' }
    const wrapper = mount(MediaValidationPanel, { props: { current: true, unavailable: false, saveState: '', modelId: product.upstream_model, productDetails: [product], diagnostics: [issue(product.product_id, 'VIDEO_PROFILE_UNSUPPORTED'), missing] } })
    expect(wrapper.findAll('.mw-diagnostic')).toHaveLength(1)
    expect(wrapper.get('.mw-diagnostic').text()).toContain('原型号当前不可用')
    expect(wrapper.find('[data-test="copy-codex"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not label another product failure as this model failure and offers a full manual copy fallback', async () => {
    const product = copy(imageProduct)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } })
    const validation = { draft_revision: 'r1', checked_at: '2026-10-26T04:10:00Z', status: 'FAIL', publish_ready: false, diagnostics: [] }
    const wrapper = mount(MediaValidationPanel, { props: { current: true, unavailable: false, saveState: '', modelId: product.upstream_model, productDetails: [product], validation, diagnostics: [issue('foreign', 'FOREIGN')] } })
    expect(wrapper.get('[data-test="no-current-model-diagnostics"]').text()).toContain('当前型号没有相关报错')
    expect(wrapper.find('.mw-diagnostic').exists()).toBe(false)
    await wrapper.setProps({ diagnostics: [issue(product.product_id, 'OWN')] })
    await wrapper.get('[data-test="copy-codex"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="diagnostic-manual-copy"] textarea').element).toHaveProperty('value', expect.stringContaining('需要技术适配'))
    await wrapper.setProps({ modelId: 'other-model' })
    expect(wrapper.find('[data-test="diagnostic-manual-copy"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

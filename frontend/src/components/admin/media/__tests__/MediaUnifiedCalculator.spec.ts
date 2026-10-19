import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Product } from '@/api/admin/mediaWorkbench'
import MediaProcurementEditor from '../MediaProcurementEditor.vue'
import MediaProductEditor from '../MediaProductEditor.vue'
import { costSpecRows } from '../costSpecRows'
import { copy, imageProduct } from './fixtures'
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
function productFixture() {
  const product = copy(imageProduct)
  product.media_type = 'video'
  product.capabilities = { resolutions: ['720p'], aspect_ratios: ['16:9'], qualities: [], durations_seconds: [4, 8, 12, 16], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] }
  product.cost_rules = [4, 8, 12, 16].map((duration, index) => ({ match: { duration_seconds: [duration] }, cost: index < 3 ? price(String(duration / 4)) : null, source: 'manual' }))
  product.pricing_rules = [16, 8, 4, 12].map(duration => ({ match: { duration_seconds: [duration] }, sale_price: duration === 16 ? null : price(String(duration / 2 + 1)) }))
  return product
}
function editor(product = productFixture()) {
  const wrapper = mount(MediaProcurementEditor, { props: { product, disabled: false, accountId: 44, adminId: 1, 'onUpdate:product': (value: Product) => { void wrapper.setProps({ product: value }) } } })
  return wrapper
}
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
describe('unified calculator', () => {
  it('renders actual spec associations despite cost/sale order differences, with immediate profit updates', async () => {
    const wrapper = editor()
    const first = wrapper.get('[data-test="spec-row-0"]')
    expect(first.text()).toContain('4 秒')
    expect(first.get('[data-test="price-2"]').element).toHaveProperty('value', '3')
    await first.get('[data-test="price-2"]').setValue('3.3')
    expect(wrapper.get('[data-test="spec-profit-0"]').text()).toContain('2.3 CNY')
    expect(wrapper.props('product').pricing_rules[1]!.sale_price!.amount).toBe('5')
    expect(wrapper.props('product').cost_rules![0]!.cost!.amount).toBe('1')
    wrapper.unmount()
  })
  it('calculates without duration multiplication or changing the draft; explicit adoption does not accumulate', async () => {
    const product = productFixture(); product.cost_rules![0]!.cost = null
    const wrapper = editor(product)
    await wrapper.get('[data-test="cost-purchase"]').setValue('1')
    await wrapper.get('[data-test="cost-credits"]').setValue('3')
    await wrapper.get('[data-test="cost-consumption-0"]').setValue('3')
    expect(wrapper.get('[data-test="converted-cost-0"]').text()).toContain('1 CNY')
    expect(wrapper.emitted('update:product')).toBeUndefined()
    await wrapper.get('[data-test="cost-apply-0"]').trigger('click')
    await wrapper.get('[data-test="cost-apply-0"]').trigger('click')
    expect(wrapper.props('product').cost_rules![0]).toMatchObject({ cost: price('1'), source: 'calculator' })
    expect(wrapper.props('product').pricing_rules).toEqual(product.pricing_rules)
    expect(wrapper.props('product').cost_rules![1]!.cost!.amount).toBe('2')
    wrapper.unmount()
  })
  it('prefers exact credit costs and does not manufacture a sale suggestion from them', async () => {
    const product = productFixture(); product.pricing_rules[1]!.sale_price = null
    const wrapper = editor(product)
    await wrapper.get('[data-test="cost-purchase"]').setValue('100')
    await wrapper.get('[data-test="cost-credits"]').setValue('1000')
    await wrapper.get('[data-test="cost-consumption-3"]').setValue('17')
    expect(wrapper.get('[data-test="cost-suggestion-3"]').text()).toContain('1.7 CNY')
    expect(wrapper.get('[data-test="cost-suggestion-3"]').text()).toContain('实际采购金额')
    expect(wrapper.find('[data-test="sale-suggestion-3"]').exists()).toBe(false)
    expect(wrapper.props('product').cost_rules![3]!.cost).toBeNull()
    wrapper.unmount()
  })
  it('adopts cost and sale independently and protects an already filled sale', async () => {
    const wrapper = editor()
    expect(wrapper.get('[data-test="cost-suggestion-3"]').text()).toContain('4 CNY')
    expect(wrapper.get('[data-test="sale-suggestion-3"]').text()).toContain('9 CNY')
    await wrapper.get('[data-test="sale-apply-3"]').trigger('click')
    expect(wrapper.props('product').pricing_rules[0]!.sale_price!.amount).toBe('9')
    expect(wrapper.props('product').cost_rules![3]!.cost).toBeNull()
    await wrapper.get('[data-test="price-0"]').setValue('20')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="sale-apply-3"]').trigger('click')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.props('product').pricing_rules[0]!.sale_price!.amount).toBe('20')
    await wrapper.get('[data-test="cost-apply-3"]').trigger('click')
    expect(wrapper.props('product').cost_rules![3]!.cost!.amount).toBe('4')
    expect(wrapper.props('product').pricing_rules[0]!.sale_price!.amount).toBe('20')
    wrapper.unmount()
  })
  it('explains shared scopes and blocks contradictory credit results from overwriting the common cost', async () => {
    const product = productFixture(); product.cost_rules = [{ match: {}, cost: null }]
    const wrapper = editor(product)
    expect(wrapper.get('[data-test="cost-shared-0"]').text()).toContain('4 个规格行')
    expect(wrapper.findAll('[data-test^="procurement-cost-"]')).toHaveLength(1)
    await wrapper.get('[data-test="cost-purchase"]').setValue('100')
    await wrapper.get('[data-test="cost-credits"]').setValue('1000')
    await wrapper.get('[data-test="cost-consumption-0"]').setValue('1')
    await wrapper.get('[data-test="cost-consumption-1"]').setValue('2')
    expect(wrapper.get('[data-test="cost-apply-0"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="cost-apply-1"]').attributes('disabled')).toBeDefined()
    expect(wrapper.props('product').cost_rules![0]!.cost).toBeNull()
    wrapper.unmount()
  })
  it('keeps zero margin undefined, invalid sale uncomputed, and blank distinct from zero', async () => {
    const wrapper = editor()
    await wrapper.get('[data-test="price-2"]').setValue('0')
    expect(wrapper.get('[data-test="spec-profit-0"]').text()).toContain('−1 CNY')
    expect(wrapper.get('[data-test="spec-profit-0"]').text()).toContain('待有效售价')
    await wrapper.get('[data-test="price-2"]').setValue('-1')
    expect(wrapper.get('[data-test="spec-profit-0"]').text()).toContain('待填写成本与售价')
    await wrapper.get('[data-test="price-2"]').setValue('')
    expect(wrapper.props('product').pricing_rules[2]!.sale_price).toBeNull()
    expect(wrapper.get('[data-test="spec-profit-0"]').text()).not.toContain('−1 CNY')
    wrapper.unmount()
  })
  it('restores per-spec calculator config after remount/reorder without changing prices', async () => {
    const product = productFixture(), wrapper = editor(product)
    await wrapper.get('[data-test="cost-consumption-2"]').setValue('17')
    wrapper.unmount()
    product.cost_rules!.reverse(); product.pricing_rules.reverse()
    const second = editor(product)
    expect(second.get('[data-test="cost-consumption-2"]').element).toHaveProperty('value', '17')
    expect(second.emitted('update:product')).toBeUndefined()
    expect(costSpecRows(product).rows[2]!.costIndex).toBe(1)
    second.unmount()
  })
  it('removes fixed duration presets while retaining selected history and custom range', () => {
    const product = productFixture(); product.capabilities.durations_seconds = [5, 10, 15]
    const wrapper = mount(MediaProductEditor, { props: { product, disabled: false, mediaTypes: ['video'] } })
    const group = wrapper.get('[data-test="duration-range"]').element.parentElement!
    expect(group.querySelector('[data-test="duration-add"]')).not.toBeNull()
    expect(group.querySelector('[aria-label="时长（秒）常用值"]')).toBeNull()
    for (const seconds of [5, 10, 15]) expect(group.querySelector(`[aria-label="移除时长 ${seconds} 秒"]`)).not.toBeNull()
    expect(wrapper.emitted('update:product')).toBeUndefined()
    wrapper.unmount()
  })
})

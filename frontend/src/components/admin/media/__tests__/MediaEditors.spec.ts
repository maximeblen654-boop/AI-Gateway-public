import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaMatchEditor from '../MediaMatchEditor.vue'
import MediaTokensField from '../MediaTokensField.vue'
import { copy, imageProduct } from './fixtures'
import type { Match, Product } from '@/api/admin/mediaWorkbench'

function freeze<T extends object>(value: T): T {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child) })
  return Object.freeze(value)
}
describe('media editors follow one-way props', () => {
  it('does not generate a price row for the denied 2K high combination', async () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['1K', '2K']
    product.capabilities.qualities = ['standard', 'high']
    product.capabilities.combination_rules = [{ deny: { resolution: ['2K'], quality: ['high'] } }]
    product.pricing_rules = []
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(true)
    await wrapper.setProps({ product: wrapper.emitted('update:product')!.at(-1)![0] as Product })
    await wrapper.get('[data-test="pricing-dimension-quality"]').setValue(true)
    const latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules.map(rule => rule.match)).toEqual([
      { resolution: ['1K'], quality: ['standard'] },
      { resolution: ['1K'], quality: ['high'] },
      { resolution: ['2K'], quality: ['standard'] }
    ])
    expect(latest.pricing_rules.every(rule => rule.sale_price === null)).toBe(true)
    wrapper.unmount()
  })
  it('rebuilds prices when a deny rule changes and confirms lost prices', async () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['1K', '4K']
    product.capabilities.combination_rules = [{ deny: {} }]
    product.pricing_rules = ['1K', '4K'].map((resolution, i) => ({ match: { resolution: [resolution] }, sale_price: { amount: String(i + 1), currency: 'CNY', billing_mode: 'per_request' } }))
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const matchEditor = wrapper.findComponent(MediaMatchEditor)
    matchEditor.vm.$emit('update:modelValue', { resolution: ['4K'] })
    await wrapper.vm.$nextTick()
    expect(confirm).toHaveBeenCalled()
    expect(wrapper.emitted('update:product')).toBeUndefined()
    confirm.mockReturnValue(true)
    matchEditor.vm.$emit('update:modelValue', { resolution: ['4K'] })
    await wrapper.vm.$nextTick()
    let latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules).toEqual([{ match: { resolution: ['1K'] }, sale_price: { amount: '1', currency: 'CNY', billing_mode: 'per_request' } }])
    await wrapper.setProps({ product: latest })
    const remove = wrapper.findAll('button').find(button => button.text().includes('移除此限制'))!
    await remove.trigger('click')
    latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules).toEqual([
      { match: { resolution: ['1K'] }, sale_price: { amount: '1', currency: 'CNY', billing_mode: 'per_request' } },
      { match: { resolution: ['4K'] }, sale_price: null }
    ])
    confirm.mockRestore(); wrapper.unmount()
  })
  it('does not preview a price for a denied specification', async () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['1K', '2K']
    product.capabilities.aspect_ratios = ['1:1', '16:9']
    product.capabilities.combination_rules = [{ deny: { resolution: ['2K'], aspect_ratio: ['16:9'] } }]
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    await wrapper.get('[data-test="preview-resolution"]').setValue('2K')
    await wrapper.get('[data-test="preview-aspect_ratio"]').setValue('16:9')
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('当前组合价格待填写')
    await wrapper.get('[data-test="preview-aspect_ratio"]').setValue('1:1')
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('总价：0.18 CNY')
    wrapper.unmount()
  })
  it('emits nested product changes without mutating any incoming product field', async () => {
    const original = freeze(copy(imageProduct))
    const wrapper = mount(MediaProductEditor, { props: { product: original, mediaTypes: ['image', 'video'], disabled: false } })
    const latest = () => wrapper.emitted('update:product')!.at(-1)![0] as Product
    await wrapper.get('[data-test="display-name"]').setValue('新名称')
    expect(latest().display_name).toBe('新名称'); expect(original).toEqual(imageProduct)
    await wrapper.setProps({ product: latest() })
    await wrapper.get('[data-test="mapping-size-0"]').setValue('1536x1536')
    expect(latest().adapter_config.size_mappings[0]!.wire_size).toBe('1536x1536')
    expect(original.adapter_config.size_mappings[0]!.wire_size).toBe('2048x2048')
    await wrapper.setProps({ product: latest() })
    await wrapper.get('[data-test="add-mapping"]').trigger('click')
    expect(latest().adapter_config.size_mappings).toHaveLength(3)
    await wrapper.setProps({ product: latest() })
    await wrapper.get('[data-test="remove-mapping-0"]').trigger('click')
    expect(latest().adapter_config.size_mappings).toHaveLength(2)
    await wrapper.setProps({ product: latest() })
    await wrapper.get('[data-test="price-0"]').setValue('0.12345678901234567890')
    expect(latest().pricing_rules[0]!.sale_price!.amount).toBe('0.12345678901234567890')
    expect(original).toEqual(imageProduct)
    wrapper.unmount()
  })
  it('creates only selected pricing dimensions and leaves quantity out of the matrix', async () => {
    const wrapper = mount(MediaProductEditor, { props: { product: copy(imageProduct), mediaTypes: ['image', 'video'], disabled: false } })
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(true)
    let latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules).toHaveLength(2)
    expect(latest.pricing_rules.every(rule => !rule.match.count && rule.sale_price?.amount === '0.18')).toBe(true)
    await wrapper.setProps({ product: latest })
    await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(true)
    latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules).toHaveLength(4)
    expect(latest.pricing_rules.every(rule => !rule.match.count && rule.match.resolution?.length === 1 && rule.match.aspect_ratio?.length === 1)).toBe(true)
    wrapper.unmount()
  })
  it('emits count and reference edits without mutating nested Match props', async () => {
    const original: Match = freeze({ count: { min: 1, max: 2 }, references: copy(imageProduct.capabilities.references) })
    const wrapper = mount(MediaMatchEditor, { props: { modelValue: original } })
    const numbers = wrapper.findAll('input[type="number"]')
    await numbers[0]!.setValue('2')
    const count = wrapper.emitted('update:modelValue')!.at(-1)![0] as Match
    expect(count.count!.min).toBe(2); expect(original.count!.min).toBe(1)
    await wrapper.setProps({ modelValue: count }); await numbers[3]!.setValue('3')
    const references = wrapper.emitted('update:modelValue')!.at(-1)![0] as Match
    expect(references.references!.image.max).toBe(3); expect(original.references!.image.max).toBe(4)
    wrapper.unmount()
  })
  it('starts with an unfilled uniform price and previews exact unit price times quantity', async () => {
    const product = copy(imageProduct); product.pricing_rules = []; product.capabilities.count.max = 4
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    expect(wrapper.get('[data-test="price-0"]').attributes('placeholder')).toBe('待填写')
    expect(wrapper.emitted('update:product')).toBeUndefined()
    await wrapper.get('[data-test="price-0"]').setValue('0.70')
    await wrapper.setProps({ product: wrapper.emitted('update:product')!.at(-1)![0] as Product })
    await wrapper.get('[data-test="preview-quantity"]').setValue(4)
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('总价：2.8 CNY')
    await wrapper.get('[data-test="preview-quantity"]').setValue(5)
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('数量不在已配置范围内')
    expect(wrapper.findAll('[data-test^="price-"]')).toHaveLength(1)
    wrapper.unmount()
  })
  it('stores duration conditions as numbers and adds unpriced rows when enabled specifications grow', async () => {
    const product = copy(imageProduct); product.media_type = 'video'; product.capabilities.durations_seconds = [5, 10]; product.pricing_rules = []
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['video'], disabled: false } })
    await wrapper.get('[data-test="pricing-dimension-duration_seconds"]').setValue(true)
    let latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules.map(rule => rule.match.duration_seconds)).toEqual([[5], [10]])
    latest.pricing_rules[0]!.sale_price = { amount: '1.20', currency: 'CNY', billing_mode: 'per_request' }
    await wrapper.setProps({ product: latest })
    wrapper.findAllComponents(MediaTokensField).find(field => field.props('numeric'))!.vm.$emit('update:modelValue', [5, 10, 15])
    latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules.map(rule => rule.match.duration_seconds)).toEqual([[5], [10], [15]])
    expect(latest.pricing_rules.map(rule => rule.sale_price?.amount ?? null)).toEqual(['1.20', null, null])
    await wrapper.setProps({ product: latest })
    expect(wrapper.get('[data-test="preview-quantity"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('总价：1.2 CNY')
    wrapper.unmount()
  })
  it('requires confirmation and clears conflicting prices when dimensions merge', async () => {
    const product = copy(imageProduct)
    product.pricing_rules = ['1K', '4K'].map((resolution, i) => ({ match: { resolution: [resolution] }, sale_price: { amount: String(i + 1), currency: 'CNY', billing_mode: 'per_request' } }))
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(false)
    expect(wrapper.emitted('update:product')).toBeUndefined()
    confirm.mockReturnValue(true)
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(false)
    expect((wrapper.emitted('update:product')!.at(-1)![0] as Product).pricing_rules).toEqual([{ match: {}, sale_price: null }])
    confirm.mockRestore(); wrapper.unmount()
  })
  it('keeps legacy rule values when a capability list is empty', async () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = []
    product.pricing_rules = [{ match: { resolution: ['1K'] }, sale_price: { amount: '0.20', currency: 'CNY', billing_mode: 'per_request' } }]
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false } })
    wrapper.findAllComponents(MediaTokensField)[0]!.vm.$emit('update:modelValue', [])
    const latest = wrapper.emitted('update:product')!.at(-1)![0] as Product
    expect(latest.pricing_rules).toEqual([{ match: { resolution: ['1K'] }, sale_price: { amount: '0.20', currency: 'CNY', billing_mode: 'per_request' } }])
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaMatchEditor from '../MediaMatchEditor.vue'
import { copy, imageProduct } from './fixtures'
import type { Match, Product } from '@/api/admin/mediaWorkbench'

function freeze<T extends object>(value: T): T {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child) })
  return Object.freeze(value)
}
describe('media editors follow one-way props', () => {
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
    expect(latest.pricing_rules.every(rule => !rule.match.count && rule.sale_price === null)).toBe(true)
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
})

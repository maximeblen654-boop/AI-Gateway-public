import { mount } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaReferenceEditor from '../MediaReferenceEditor.vue'
import MediaMatchEditor from '../MediaMatchEditor.vue'
import { copy, imageProduct } from './fixtures'
import type { Product } from '@/api/admin/mediaWorkbench'

function productFixture() {
  const product = copy(imageProduct)
  product.capabilities.resolutions = ['1K', '2K', '4K']
  product.capabilities.count = { min: 1, max: 10 }
  product.pricing_rules = []
  return product
}
function editor(product = productFixture()) {
  const wrapper = mount(MediaProductEditor, { attachTo: document.body, props: { product, mediaTypes: ['image', 'video'], disabled: false, 'onUpdate:product': (value: Product) => { void wrapper.setProps({ product: value }) } } })
  return wrapper
}
describe('five-step product wizard', () => {
  it('has one visible task per step and navigation alone does not change any contract', async () => {
    const wrapper = editor()
    for (let step = 1; step <= 5; step++) {
      await wrapper.get(`[data-test="wizard-step-${step}"]`).trigger('click')
      for (let page = 1; page <= 5; page++) expect(wrapper.get(`[data-test="wizard-page-${page}"]`).isVisible()).toBe(page === step)
      expect(wrapper.get(`[data-test="wizard-step-${step}"]`).attributes('aria-current')).toBe('step')
    }
    expect(wrapper.emitted('update:product')).toBeUndefined()
    expect(wrapper.find('[data-test="model-family"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="wire-profile"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="native-contract"]').text()).toContain('继承 Sub2API Account')
    expect(wrapper.get('[data-test="quality-options"] input').attributes('placeholder')).toContain('留空')
    expect(wrapper.find('[data-test="pricing-dimension-quality"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pricing-dimension-duration_seconds"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('computes 1, 3, 6 prices and preserves explicitly equal prices on collapse', async () => {
    const wrapper = editor()
    expect(wrapper.get('[data-test="expected-prices"]').text()).toContain('1 个价格')
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(true)
    expect(wrapper.get('[data-test="expected-prices"]').text()).toContain('3 个价格')
    await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(true)
    expect(wrapper.get('[data-test="expected-prices"]').text()).toContain('6 个价格')
    for (let i = 0; i < 6; i++) await wrapper.get(`[data-test="price-${i}"]`).setValue('0.70')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.props('product').pricing_rules).toHaveLength(3)
    expect(wrapper.props('product').pricing_rules.every(r => r.sale_price?.amount === '0.70')).toBe(true)
    await wrapper.get('[data-test="preview-quantity"]').setValue(10)
    expect(wrapper.get('[data-test="pricing-preview"]').text()).toContain('总价：7 CNY')
    confirm.mockRestore(); wrapper.unmount()
  })
  it('counts only allowed combinations, and distinguishes blank, free, and invalid money', async () => {
    const product = productFixture()
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], aspect_ratio: ['16:9'] } }]
    const wrapper = editor(product)
    await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(true)
    await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(true)
    expect(wrapper.get('[data-test="expected-prices"]').text()).toContain('5 个价格')
    expect(wrapper.props('product').pricing_rules.every(r => r.sale_price === null)).toBe(true)
    await wrapper.get('[data-test="price-0"]').setValue('0')
    expect(wrapper.get('.mw-price-state').text()).toContain('明确免费')
    await wrapper.get('[data-test="price-0"]').setValue('-1')
    expect(wrapper.get('[data-test="price-0"]').attributes('aria-invalid')).toBe('true')
    await wrapper.get('[data-test="price-0"]').setValue('')
    expect(wrapper.props('product').pricing_rules[0]!.sale_price).toBeNull()
    wrapper.unmount()
  })
  it('asks before losing even one previously priced combination and cancel keeps the draft', async () => {
    const product = productFixture()
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.70', currency: 'CNY', billing_mode: 'per_request' } }]
    const wrapper = editor(product)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="wizard-page-1"] .mw-token-chip-selected').trigger('click')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.props('product')).toEqual(product)
    confirm.mockReturnValue(true)
    await wrapper.get('[data-test="wizard-page-1"] .mw-token-chip-selected').trigger('click')
    expect(wrapper.props('product').capabilities.resolutions).toEqual(['2K', '4K'])
    expect(wrapper.props('product').pricing_rules[0]!.sale_price?.amount).toBe('0.70')
    confirm.mockRestore(); wrapper.unmount()
  })
  it('restores reference controls when a price-loss edit is cancelled', async () => {
    const product = copy(imageProduct)
    const wrapper = editor(product)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="reference-image-mode"]').setValue('none')
    expect(wrapper.get('[data-test="reference-image-mode"]').element).toHaveProperty('value', 'optional')
    expect(wrapper.props('product')).toEqual(product)
    await wrapper.get('[data-test="reference-image-max"]').setValue('2')
    expect(wrapper.get('[data-test="reference-image-max"]').element).toHaveProperty('value', '4')
    expect(wrapper.props('product')).toEqual(product)
    confirm.mockRestore(); wrapper.unmount()
  })
  it('confirms removal of a legacy priced rule outside the current capability domain', async () => {
    const product = productFixture()
    product.capabilities.resolutions = ['1K']
    product.pricing_rules = [{ match: { resolution: ['2K'] }, sale_price: { amount: '1.20', currency: 'CNY', billing_mode: 'per_request' } }]
    const wrapper = editor(product)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.props('product')).toEqual(product)
    expect(wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').element).toHaveProperty('checked', false)
    confirm.mockRestore(); wrapper.unmount()
  })
  it('restores technical media type and combination controls after cancelling price loss', async () => {
    const product = productFixture()
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.70', currency: 'CNY', billing_mode: 'per_request' } }]
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], count: { min: 1, max: 1 } } }]
    const wrapper = editor(product)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-field="media_type"]').setValue('video')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-field="media_type"]').element).toHaveProperty('value', 'image')
    const match = wrapper.getComponent(MediaMatchEditor)
    await match.findAll('input[type="checkbox"]')[0]!.setValue(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(match.findAll('input[type="checkbox"]')[0]!.element).toHaveProperty('checked', true)
    await match.findAll('input[type="number"]')[1]!.setValue('2')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(match.findAll('input[type="number"]')[1]!.element).toHaveProperty('value', '1')
    expect(wrapper.props('product')).toEqual(product)
    confirm.mockRestore(); wrapper.unmount()
  })
  it('restores the specification text input after cancelling loss of an existing price', async () => {
    const product = copy(imageProduct)
    const wrapper = editor(product)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await wrapper.get('[data-test="wizard-page-1"] input').setValue('1K')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-test="wizard-page-1"] input').element).toHaveProperty('value', '1K, 4K')
    expect(wrapper.props('product')).toEqual(product)
    confirm.mockRestore(); wrapper.unmount()
  })
  it.each(['grok', 'gemini', 'midjourney'])('does not infer %s support from a model name or openai_json', (name) => {
    const product = productFixture(); product.upstream_model = name; product.adapter_config.model_family = 'openai_json'
    const wrapper = editor(product)
    expect(wrapper.get('[data-test="adapter-status"]').text()).toContain('待确认')
    expect(wrapper.get('[data-test="adapter-status"]').text()).not.toContain('已接入')
    wrapper.unmount()
  })
  it('keeps input reference limits and execution/edit execution independently', async () => {
    const product = productFixture()
    product.adapter_config.execution = { mode: 'native_multi', max_output_images: 2 }
    product.adapter_config.edit_execution = { mode: 'single', max_output_images: 1 }
    const wrapper = editor(product)
    await wrapper.get('[data-test="reference-image-mode"]').setValue('required')
    await wrapper.get('[data-test="reference-image-max"]').setValue('3')
    expect(wrapper.props('product').capabilities.references.image).toEqual({ min: 1, max: 3 })
    expect(wrapper.props('product').capabilities.references.total_max).toBe(3)
    expect(wrapper.props('product').capabilities.count.max).toBe(10)
    expect(wrapper.props('product').adapter_config).toEqual(product.adapter_config)
    wrapper.unmount()
  })
})

describe('reference limits', () => {
  it('keeps every native combination control aligned when its parent rejects an edit', async () => {
    const match = { count: { min: 1, max: 2 }, references: copy(imageProduct.capabilities.references) }
    const wrapper = mount(MediaMatchEditor, { props: { modelValue: match } })
    for (const checkbox of wrapper.findAll('input[type="checkbox"]')) {
      await checkbox.setValue(false)
      expect(checkbox.element).toHaveProperty('checked', true)
    }
    for (const input of wrapper.findAll('input[type="number"]')) {
      const original = (input.element as HTMLInputElement).value
      await input.setValue('9')
      expect(input.element).toHaveProperty('value', original)
    }
    expect(wrapper.props('modelValue')).toEqual(match)
    wrapper.unmount()
  })
  it('preserves legacy total zero until an explicit bounded change and reports 100 immediately', async () => {
    const refs = copy(imageProduct.capabilities.references); refs.total_max = 0
    const wrapper = mount(MediaReferenceEditor, { props: { modelValue: refs, mediaType: 'image', 'onUpdate:modelValue': value => { void wrapper.setProps({ modelValue: value }) } } })
    expect(wrapper.get('[data-test="legacy-reference-zero"]').text()).toContain('0 不表示无限')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.get('[data-test="reference-image-max"]').setValue('')
    expect(wrapper.get('[data-test="reference-image-max"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="reference-error"]').text()).toContain('0～16')
    await wrapper.get('[data-test="reference-image-max"]').setValue(100)
    expect(wrapper.get('[data-test="reference-error"]').text()).toContain('0～16')
    await wrapper.get('[data-test="reference-image-max"]').setValue(16)
    expect(wrapper.find('[data-test="reference-error"]').exists()).toBe(false)
    expect(wrapper.props('modelValue').total_max).toBe(16)
    await wrapper.get('[data-test="reference-image-mode"]').setValue('none')
    expect(wrapper.props('modelValue').image).toEqual({ min: 0, max: 0 })
    expect(wrapper.props('modelValue').total_max).toBe(0)
    expect(wrapper.get('[data-test="text-only"]').text()).toContain('纯文生图')
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaTokensField from '../MediaTokensField.vue'
import type { Product } from '@/api/admin/mediaWorkbench'
import { copy, imageProduct } from './fixtures'

const oldPresets = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9']
const extremePresets = ['1:4', '4:1', '1:8', '8:1']
function field() {
  return mount(MediaTokensField, { props: { label: '比例', modelValue: ['1:1'], presets: ['1:1', '16:9'], aspectRatio: true } })
}

describe('administrator aspect ratio options', () => {
  afterEach(() => vi.restoreAllMocks())
  it('adds image-only shortcuts without changing the product on entry and toggles each on/off', async () => {
    const original = copy(imageProduct)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(MediaProductEditor, { props: { product: original, mediaTypes: ['image'], disabled: false } })
    const ratios = wrapper.findAllComponents(MediaTokensField).find(component => component.props('aspectRatio'))!
    expect(ratios.props('presets')).toEqual([...oldPresets, ...extremePresets])
    expect(wrapper.emitted('update:product')).toBeUndefined()
    for (const value of extremePresets) {
      const button = ratios.findAll('button').find(button => button.text() === value)!
      await button.trigger('click')
      let updated = wrapper.emitted('update:product')!.at(-1)![0] as Product
      expect(updated.capabilities.aspect_ratios).toContain(value)
      expect(updated.pricing_rules).toEqual(original.pricing_rules)
      expect(updated.product_id).toBe(original.product_id)
      await wrapper.setProps({ product: updated })
      expect(button.attributes('aria-pressed')).toBe('true')
      await button.trigger('click')
      updated = wrapper.emitted('update:product')!.at(-1)![0] as Product
      expect(updated.capabilities.aspect_ratios).toEqual(original.capabilities.aspect_ratios)
      await wrapper.setProps({ product: updated })
      expect(button.attributes('aria-pressed')).toBe('false')
    }
    expect(original).toEqual(imageProduct)
    wrapper.unmount()
  })
  it('retains previous video presets without adding image extreme shortcuts', () => {
    const product = copy(imageProduct); product.media_type = 'video'
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['video'], disabled: false } })
    const ratios = wrapper.findAllComponents(MediaTokensField).find(component => component.props('aspectRatio'))!
    expect(ratios.props('presets')).toEqual(oldPresets)
    expect(wrapper.emitted('update:product')).toBeUndefined()
    wrapper.unmount()
  })
  it('adds, trims, deduplicates and removes custom ratios through the same model value', async () => {
    const wrapper = field()
    await wrapper.get('[data-test="custom-ratio-toggle"]').trigger('click')
    await wrapper.get('[data-test="custom-ratio-input"]').setValue(' 3 : 5 ')
    await wrapper.get('[data-test="custom-ratio-add"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual(['1:1', '3:5'])
    await wrapper.setProps({ modelValue: ['1:1', '3:5'] })
    expect((wrapper.get('[data-test="tokens-input"]').element as HTMLInputElement).value).toBe('1:1, 3:5')
    await wrapper.get('[data-test="custom-ratio-input"]').setValue('3:5')
    await wrapper.get('[data-test="custom-ratio-add"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    expect(wrapper.get('[role="status"]').text()).toContain('无需重复添加')
    await wrapper.get('[aria-label="移除比例 3:5"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual(['1:1'])
    wrapper.unmount()
  })
  it.each(['0:1', '1:0', '-1:4', '3/5', '1.5:2', '3:5,5:7', 'free'])('rejects invalid custom format %s without changing capabilities', async value => {
    const wrapper = field()
    await wrapper.get('[data-test="custom-ratio-toggle"]').trigger('click')
    await wrapper.get('[data-test="custom-ratio-input"]').setValue(value)
    await wrapper.get('[data-test="custom-ratio-add"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('正整数比例')
    expect(wrapper.get('[data-test="custom-ratio-input"]').attributes('aria-invalid')).toBe('true')
    wrapper.unmount()
  })
  it('preserves comma-separated input with validation and automatic-spec compatibility', async () => {
    const wrapper = field()
    await wrapper.get('[data-test="tokens-input"]').setValue(' 1:1, 3:5，3:5, 5 : 7, auto ')
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual(['1:1', '3:5', '5:7', 'auto'])
    await wrapper.get('[data-test="tokens-input"]').setValue('1:1, invalid')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('正整数比例')
    wrapper.unmount()
  })
  it('round-trips custom ratios through Product JSON without changing identity, mappings or pricing', async () => {
    const original = copy(imageProduct)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(MediaProductEditor, { props: { product: original, mediaTypes: ['image'], disabled: false } })
    const ratios = wrapper.findAllComponents(MediaTokensField).find(component => component.props('aspectRatio'))!
    await ratios.get('[data-test="custom-ratio-toggle"]').trigger('click')
    await ratios.get('[data-test="custom-ratio-input"]').setValue('7:5')
    await ratios.get('[data-test="custom-ratio-input"]').trigger('keydown', { key: 'Enter' })
    const saved = copy(wrapper.emitted('update:product')!.at(-1)![0] as Product)
    expect(saved.capabilities.aspect_ratios).toEqual(['1:1', '16:9', '7:5'])
    expect(saved.product_id).toBe(original.product_id)
    expect(saved.pricing_rules).toEqual(original.pricing_rules)
    expect(saved.adapter_config).toEqual(original.adapter_config)
    expect(original).toEqual(imageProduct)
    wrapper.unmount()
    const reopened = mount(MediaProductEditor, { props: { product: saved, mediaTypes: ['image'], disabled: false } })
    expect(reopened.get('[aria-label="移除比例 7:5"]').text()).toContain('7:5')
    expect(reopened.emitted('update:product')).toBeUndefined()
    reopened.unmount()
  })
  it('preserves generic numeric token editing and disabled state', async () => {
    const numeric = mount(MediaTokensField, { props: { label: '时长', modelValue: [5], numeric: true } })
    await numeric.get('[data-test="tokens-input"]').setValue('5, 10')
    expect(numeric.emitted('update:modelValue')!.at(-1)![0]).toEqual([5, 10])
    expect(numeric.find('[data-test="custom-ratio-toggle"]').exists()).toBe(false)
    numeric.unmount()
    const disabled = field()
    await disabled.setProps({ disabled: true })
    expect(disabled.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    expect(disabled.get('[data-test="tokens-input"]').attributes('disabled')).toBeDefined()
    disabled.unmount()
  })
})

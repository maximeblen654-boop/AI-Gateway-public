import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaReferenceEditor from '../MediaReferenceEditor.vue'
import { copy, imageProduct } from './fixtures'
import type { Product, References } from '@/api/admin/mediaWorkbench'

const wrappers: { unmount: () => void }[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

function editor(max = 1, priced = true) {
  const product = copy(imageProduct)
  product.capabilities.references.image.max = max
  product.capabilities.references.total_max = max
  if (!priced) product.pricing_rules = []
  const wrapper = mount(MediaProductEditor, {
    attachTo: document.body,
    props: { product, mediaTypes: ['image', 'video'], disabled: false,
      'onUpdate:product': (product: Product) => { void wrapper.setProps({ product }) } }
  })
  wrappers.push(wrapper)
  return wrapper
}
async function type(wrapper: ReturnType<typeof editor>, text: string, field = 'reference-image-max') {
  const input = wrapper.get<HTMLInputElement>(`[data-test="${field}"]`)
  input.element.value = text
  await input.trigger('input')
  await flushPromises()
  return input
}

describe('reference count input completion', () => {
  it('buffers clear → 1 → 12 without mutating the product or asking about prices', async () => {
    const wrapper = editor()
    await wrapper.get('[data-test="wizard-step-2"]').trigger('click')
    const original = copy(wrapper.props('product'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    for (const value of ['', '1', '12']) {
      const input = await type(wrapper, value)
      expect(input.element.value).toBe(value)
      expect(wrapper.props('product')).toEqual(original)
      expect(wrapper.emitted('update:product')).toBeUndefined()
      expect(confirm).not.toHaveBeenCalled()
    }
    await wrapper.get('[data-test="reference-image-max"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.props('product').capabilities.references.image.max).toBe(12)
    expect(wrapper.props('product').capabilities.references.total_max).toBe(12)
    expect(wrapper.props('product').pricing_rules).toEqual(original.pricing_rules)
    expect(wrapper.emitted('update:product')).toHaveLength(1)
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each([true, false])('confirms real price loss once and respects acceptance=%s', async accepted => {
    const wrapper = editor(12)
    const original = copy(wrapper.props('product'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(accepted)
    const input = await type(wrapper, '1')
    expect(confirm).not.toHaveBeenCalled()
    // Enter, native change and blur can occur consecutively for one edit.
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('change')
    await input.trigger('blur')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(input.element.value).toBe(accepted ? '1' : '12')
    if (accepted) {
      expect(wrapper.props('product').capabilities.references.image.max).toBe(1)
      expect(wrapper.emitted('update:product')).toHaveLength(1)
    } else {
      expect(wrapper.props('product')).toEqual(original)
      expect(wrapper.emitted('update:product')).toBeUndefined()
    }
  })

  it('does not confirm or emit when the final number is unchanged', async () => {
    const wrapper = editor(12)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const input = await type(wrapper, '012')
    await input.trigger('blur'); await flushPromises()
    expect(input.element.value).toBe('12')
    expect(wrapper.emitted('update:product')).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not confirm a decrease without any configured price to lose', async () => {
    const wrapper = editor(12, false)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const input = await type(wrapper, '1')
    await input.trigger('change'); await flushPromises()
    expect(wrapper.props('product').capabilities.references.image.max).toBe(1)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('keeps in-progress input across an unrelated parent update and restores untouched fields', async () => {
    const wrapper = editor()
    const input = await type(wrapper, '12')
    const updated = copy(wrapper.props('product'))
    updated.display_name = 'An unrelated parent change'
    await wrapper.setProps({ product: updated })
    expect(input.element.value).toBe('12')
    expect(wrapper.props('product').capabilities.references.image.max).toBe(1)
    await input.trigger('blur'); await flushPromises()
    expect(wrapper.props('product').display_name).toBe(updated.display_name)
    expect(wrapper.props('product').capabilities.references.image.max).toBe(12)
  })

  it.each(['', '-1', '1.5', '17', 'invalid'])('rejects %j without emitting an invalid draft or leaving the step', async raw => {
    const wrapper = editor()
    await wrapper.get('[data-test="wizard-step-2"]').trigger('click')
    const original = copy(wrapper.props('product'))
    await type(wrapper, raw)
    await wrapper.get('[data-test="wizard-next"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="wizard-step-2"]').attributes('aria-current')).toBe('step')
    expect(wrapper.get('[data-test="reference-error"]').text()).toContain('0～16')
    expect(wrapper.props('product')).toEqual(original)
    expect(wrapper.emitted('update:product')).toBeUndefined()
  })

  it('flushes valid input on Next without a blur event, preserving price protection', async () => {
    const wrapper = editor()
    await wrapper.get('[data-test="wizard-step-2"]').trigger('click')
    await type(wrapper, '12')
    await wrapper.get('[data-test="wizard-next"]').trigger('click'); await flushPromises()
    expect(wrapper.props('product').capabilities.references.image.max).toBe(12)
    expect(wrapper.get('[data-test="wizard-step-3"]').attributes('aria-current')).toBe('step')
    await wrapper.get('[data-test="wizard-step-2"]').trigger('click')
    const original = copy(wrapper.props('product'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await type(wrapper, '1')
    await wrapper.get('[data-test="wizard-next"]').trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.props('product')).toEqual(original)
    expect(wrapper.get('[data-test="wizard-step-2"]').attributes('aria-current')).toBe('step')
  })

  it('buffers video category and combined limits independently, then applies both', async () => {
    const refs: References = { image: { min: 0, max: 1 }, video: { min: 0, max: 2 }, audio: { min: 0, max: 0 }, total_max: 2 }
    const wrapper = mount(MediaReferenceEditor, { props: { modelValue: refs, mediaType: 'video', maxReferences: 30,
      'onUpdate:modelValue': (value: References) => { void wrapper.setProps({ modelValue: value }) } } })
    wrappers.push(wrapper)
    for (const [field, value] of [['reference-video-max', '12'], ['reference-total', '13']]) {
      const input = wrapper.get<HTMLInputElement>(`[data-test="${field}"]`)
      input.element.value = value; await input.trigger('input')
    }
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.vm.commitPending()
    expect(wrapper.props('modelValue').video.max).toBe(12)
    expect(wrapper.props('modelValue').total_max).toBe(13)
    expect(wrapper.props('modelValue').image.max).toBe(1)
  })

  it('rejects a total below required material counts without emitting a draft', async () => {
    const refs: References = { image: { min: 2, max: 3 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 3 }
    const wrapper = mount(MediaReferenceEditor, { props: { modelValue: refs, mediaType: 'video', maxReferences: 30 } })
    wrappers.push(wrapper)
    const input = wrapper.get<HTMLInputElement>('[data-test="reference-total"]')
    input.element.value = '1'; await input.trigger('input'); await input.trigger('change'); await flushPromises()
    expect(wrapper.get('[data-test="reference-error"]').text()).toContain('必填素材数量超过合计上限')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.props('modelValue')).toEqual(refs)
  })
})

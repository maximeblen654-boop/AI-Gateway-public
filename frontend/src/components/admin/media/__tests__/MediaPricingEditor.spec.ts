import { mount, flushPromises } from '@vue/test-utils'
import { expect, it } from 'vitest'
import type { Product } from '@/api/admin/mediaWorkbench'
import MediaPricingEditor from '../MediaPricingEditor.vue'
import MediaProductEditor from '../MediaProductEditor.vue'
import { mediaSpecLabel } from '../mediaSpecLabel'
import { copy, imageProduct } from './fixtures'
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })

it('changes only the targeted customer price and preserves raw text, match and input props', async () => {
  const product = copy(imageProduct)
  product.capabilities.count = { min: 1, max: 10 }
  product.pricing_rules = [
    { match: { resolution: ['1K'], aspect_ratio: ['1:1'], count: { min: 1, max: 3 }, references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 } }, sale_price: price('0.70') },
    { match: { resolution: ['4K'], aspect_ratio: ['16:9'], count: { min: 4, max: 10 }, references: product.capabilities.references }, sale_price: price('2.50') }
  ]
  const original = JSON.stringify(product)
  const wrapper = mount(MediaPricingEditor, { props: { product, labels: [], disabled: false } })
  await wrapper.get('[data-test="price-1"]').setValue('12.')
  const changed = wrapper.emitted('update:product')!.at(-1)![0] as Product
  expect(changed.pricing_rules[1]!.sale_price).toEqual(price('12.'))
  expect(changed.pricing_rules.map(rule => rule.match)).toEqual(product.pricing_rules.map(rule => rule.match))
  expect(changed.pricing_rules[0]).toEqual(product.pricing_rules[0])
  expect(JSON.stringify(product)).toBe(original)
  await wrapper.setProps({ product: changed })
  expect(wrapper.get('[data-test="price-1"]').element).toHaveProperty('value', '12.')
  expect(wrapper.get('[data-test="price-1"]').attributes('aria-invalid')).toBe('true')
  await wrapper.setProps({ product: { ...changed, pricing_rules: [...changed.pricing_rules].reverse() } })
  expect(wrapper.get('[data-test="price-0"]').element).toHaveProperty('value', '12.')
  expect(wrapper.get('[data-test="price-1"]').element).toHaveProperty('value', '0.70')
  expect(wrapper.text()).toContain('数量 4～10')
  expect(wrapper.find('[data-test^="cost-apply"]').exists()).toBe(false)
  wrapper.unmount()
})

it('keeps blank and zero separate and ignores disabled input without inventing a price', async () => {
  const product = copy(imageProduct); product.pricing_rules = []
  const wrapper = mount(MediaPricingEditor, { props: { product, labels: [], disabled: false } })
  expect(wrapper.get('[data-test="price-0"]').element).toHaveProperty('value', '')
  expect(wrapper.emitted('update:product')).toBeUndefined()
  await wrapper.get('[data-test="price-0"]').setValue('0')
  const next = wrapper.emitted('update:product')!.at(-1)![0] as Product
  expect(next.pricing_rules[0]!.sale_price!.amount).toBe('0')
  await wrapper.setProps({ product: next })
  expect(wrapper.text()).toContain('不能发布或生成')
  await wrapper.get('[data-test="price-0"]').setValue('')
  expect((wrapper.emitted('update:product')!.at(-1)![0] as Product).pricing_rules[0]!.sale_price).toBeNull()
  const count = wrapper.emitted('update:product')!.length
  await wrapper.setProps({ disabled: true })
  await wrapper.get('[data-test="price-0"]').setValue('9')
  expect(wrapper.emitted('update:product')).toHaveLength(count)
  wrapper.unmount()
})

it('edits both image creation modes at their original ratio prices with no procurement UI', async () => {
  const product = copy(imageProduct)
  product.capabilities.count = { min: 1, max: 10 }
  const wrapper = mount(MediaProductEditor, { props: { product, disabled: false, mediaTypes: ['image'], 'onUpdate:product': (next: Product) => { void wrapper.setProps({ product: next }) } } })
  await wrapper.get('[data-test="creation-mode-pricing"] input').setValue(true)
  await wrapper.get('[data-test="pricing-dimension-aspect_ratio"]').setValue(true)
  await wrapper.get('[data-test="wizard-step-4"]').trigger('click')
  const matches = copy(wrapper.props('product').pricing_rules.map(rule => rule.match))
  expect(matches).toHaveLength(4)
  for (let index = 0; index < matches.length; index++) await wrapper.get(`[data-test="price-${index}"]`).setValue(`${index + 1}.20`)
  await flushPromises()
  expect(wrapper.props('product').pricing_rules.map(rule => rule.match)).toEqual(matches)
  expect(wrapper.get('[data-test="wizard-page-4"]').text()).toContain('文生图')
  expect(wrapper.get('[data-test="wizard-page-4"]').text()).toContain('图生图')
  expect(wrapper.get('[data-test="wizard-page-4"]').text()).not.toContain('采购')
  await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
  expect(wrapper.find('[data-test="procurement-review"]').exists()).toBe(false)
  expect(wrapper.props('product').pricing_rules.map(rule => rule.sale_price?.amount)).toEqual(matches.map((_, index) => `${index + 1}.20`))
  await wrapper.get('[data-test="wizard-step-3"]').trigger('click')
  await wrapper.get('[data-test="pricing-dimension-resolution"]').setValue(true)
  expect(wrapper.props('product').pricing_rules).toHaveLength(8)
  for (const rule of wrapper.props('product').pricing_rules) {
    const original = matches.findIndex(match => JSON.stringify(match.aspect_ratio) === JSON.stringify(rule.match.aspect_ratio) && JSON.stringify(match.references) === JSON.stringify(rule.match.references))
    expect(original).toBeGreaterThanOrEqual(0)
    expect(rule.sale_price?.amount).toBe(`${original + 1}.20`)
  }
  wrapper.unmount()
})

it('labels format and quantity conditions without hiding spec identity', () => {
  expect(mediaSpecLabel({ output_formats: ['png'], count: { min: 2, max: 4 } })).toContain('输出格式 png · 数量 2～4')
})

it('retains selected video durations and the custom range without fixed duration presets', () => {
  const product = copy(imageProduct); product.media_type = 'video'; product.capabilities.durations_seconds = [5, 10, 15]
  const wrapper = mount(MediaProductEditor, { props: { product, disabled: false, mediaTypes: ['video'] } })
  const group = wrapper.get('[data-test="duration-range"]').element.parentElement!
  expect(group.querySelector('[data-test="duration-add"]')).not.toBeNull()
  expect(group.querySelector('[aria-label="时长（秒）常用值"]')).toBeNull()
  for (const seconds of [5, 10, 15]) expect(group.querySelector(`[aria-label="移除时长 ${seconds} 秒"]`)).not.toBeNull()
  expect(wrapper.emitted('update:product')).toBeUndefined()
  wrapper.unmount()
})

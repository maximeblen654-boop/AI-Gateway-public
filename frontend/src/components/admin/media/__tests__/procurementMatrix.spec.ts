import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import MediaProcurementEditor from '../MediaProcurementEditor.vue'
import { costLabel, buildCostRules, costRows } from '../procurementMatrix'
import { imageProduct } from './fixtures'
import type { Product } from '@/api/admin/mediaWorkbench'

const fixture = (): Product => structuredClone(imageProduct)
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
function editor(product = fixture()) {
  const wrapper = mount(MediaProcurementEditor, { props: { product, disabled: false, accountId: 44, adminId: 1, 'onUpdate:product': value => { void wrapper.setProps({ product: value }) } } })
  return wrapper
}
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
it('legacy costs stay blank; neither sale nor remembered estimates become costs', async () => {
  const wrapper = editor()
  expect(costRows(wrapper.props('product'))[0]!.cost).toBeNull()
  expect((wrapper.get('[data-test="procurement-cost-0"]').element as HTMLInputElement).value).toBe('')
  await wrapper.get('[data-test="cost-purchase"]').setValue('100')
  await wrapper.get('[data-test="cost-credits"]').setValue('1000')
  await wrapper.get('[data-test="cost-consumption-0"]').setValue('1')
  expect(wrapper.emitted('update:product')).toBeUndefined()
  await wrapper.get('[data-test="cost-apply-0"]').trigger('click'); await flushPromises()
  expect(wrapper.props('product').cost_rules).toEqual([{ match: {}, cost: price('0.1'), source: 'calculator' }])
  expect(wrapper.props('product').pricing_rules).toEqual(imageProduct.pricing_rules)
  expect(wrapper.get('[data-test="cost-adopted"]').text()).toContain('服务器保存结果以上方确认状态为准')
})
it('allows explicit zero and preserves null for clearing independently of sale', async () => {
  const wrapper = editor()
  await wrapper.get('[data-test="procurement-cost-0"]').setValue('0')
  expect(wrapper.props('product').cost_rules![0]).toMatchObject({ cost: price('0'), source: 'manual' })
  await wrapper.get('[data-test="procurement-cost-0"]').setValue('')
  expect(wrapper.props('product').cost_rules![0]!.cost).toBeNull()
  expect(wrapper.props('product').pricing_rules).toEqual(imageProduct.pricing_rules)
})
it('partitions cost independently when all customer specs share one sale price', async () => {
  const wrapper = editor()
  await wrapper.get('[data-test="cost-dimension-resolution"]').setValue(true)
  expect(wrapper.findAll('[data-test^="procurement-cost-"]')).toHaveLength(2)
  await wrapper.get('[data-test="procurement-cost-0"]').setValue('0.1')
  await wrapper.get('[data-test="procurement-cost-1"]').setValue('0.8')
  expect(wrapper.props('product').pricing_rules).toEqual(imageProduct.pricing_rules)
  expect(wrapper.props('product').cost_rules!.map(row => row.cost!.amount)).toEqual(['0.1', '0.8'])
})
it('keeps cost conditions and values when sale tiers or capability coverage change', async () => {
  const product = fixture(); product.cost_rules = [{ match: { resolution: ['4K'] }, cost: price('0.5'), source: 'manual' }]
  const wrapper = editor(product)
  const changed = structuredClone(product); changed.capabilities.resolutions = ['1K']; changed.pricing_rules = []
  await wrapper.setProps({ product: changed })
  expect(wrapper.props('product').cost_rules).toEqual(product.cost_rules)
  expect((wrapper.get('[data-test="procurement-cost-0"]').element as HTMLInputElement).value).toBe('0.5')
})
it('does not manufacture zero when a calculator result is below field precision', async () => {
  const wrapper = editor()
  await wrapper.get('[data-test="cost-purchase"]').setValue('0.00000001')
  await wrapper.get('[data-test="cost-credits"]').setValue('100000000000')
  await wrapper.get('[data-test="cost-consumption-0"]').setValue('1')
  expect(wrapper.get('[data-test="cost-apply-0"]').attributes('disabled')).toBeDefined()
  expect(wrapper.emitted('update:product')).toBeUndefined()
})
it('cost matrix honors excluded combinations, bounded domain and conflicting costs', () => {
  const product = fixture()
  product.capabilities.combination_rules = [{ deny: { resolution: ['4K'] } }]
  expect(buildCostRules(product, ['resolution'], false)).toEqual([{ match: { resolution: ['1K'] }, cost: null }])
  product.capabilities.combination_rules = []
  product.cost_rules = [{ match: { resolution: ['1K'] }, cost: price('0.1') }, { match: { resolution: ['4K'] }, cost: price('0.2') }]
  expect(buildCostRules(product, [], false)![0]!.cost).toBeNull()
  product.capabilities.resolutions = Array.from({ length: 32 }, (_, i) => `r${i}`)
  product.capabilities.aspect_ratios = Array.from({ length: 4 }, (_, i) => `a${i}`)
  expect(buildCostRules(product, ['resolution', 'aspect_ratio'], false)).toBeUndefined()
  product.capabilities.resolutions = product.capabilities.resolutions.slice(0, 10)
  product.capabilities.aspect_ratios = Array.from({ length: 10 }, (_, i) => `a${i}`)
  expect(buildCostRules(product, ['resolution', 'aspect_ratio'], false)).toHaveLength(100)
})
it('video costs are whole-item prices with independent duration matching', () => {
  const product = fixture(); product.media_type = 'video'; product.capabilities.durations_seconds = [5, 10]
  product.cost_rules = [{ match: { duration_seconds: [5] }, cost: price('0.5') }, { match: { duration_seconds: [10] }, cost: price('1') }]
  expect(buildCostRules(product, ['duration_seconds'], false)!.map(row => row.cost!.amount)).toEqual(['0.5', '1'])
})

it('labels an explicit output-format cost condition without hiding its identity', () => {
 expect(costLabel({output_formats:['png']})).toContain('输出格式 png')
})

it('keeps format-specific costs editable without merging their applicability', async () => {
  const product = fixture()
  product.cost_rules = [{ match: { output_formats: ['png'] }, cost: price('0.1') }, { match: { output_formats: ['webp'] }, cost: price('0.2') }]
  const wrapper = editor(product)
  expect(wrapper.get('[data-test="cost-dimension-resolution"]').attributes('disabled')).toBeDefined()
  await wrapper.get('[data-test="procurement-cost-0"]').setValue('0.15')
  expect(wrapper.props('product').cost_rules![0]!.match.output_formats).toEqual(['png'])
  expect(wrapper.props('product').cost_rules![1]!.cost!.amount).toBe('0.2')
})

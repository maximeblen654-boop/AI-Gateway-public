import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MediaVideoSaleEditor from '../MediaVideoSaleEditor.vue'
import * as saleGroups from '../videoSaleGroups'
import * as matrix from '../pricingMatrix'
import { copy, imageProduct } from './fixtures'
import type { Product } from '@/api/admin/mediaWorkbench'

function product(): Product {
  const p = copy(imageProduct)
  p.media_type = 'video'
  p.capabilities.resolutions = ['720p', '1080p', '4K']
  p.capabilities.durations_seconds = Array.from({ length: 32 }, (_, i) => i + 1)
  p.capabilities.aspect_ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:1']
  p.capabilities.qualities = ['standard', 'high']
  p.pricing_rules = [{ match: {}, sale_price: null }]
  return p
}
function editor(p = product()) {
  const w = mount(MediaVideoSaleEditor, { props: { product: p, 'onUpdate:product': (value: Product) => { void w.setProps({ product: value }) } } })
  return w
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('buffers decimal typing, deletion and replacement with zero rule/domain recalculations between keys', async () => {
  const p = product()
  const w = editor(p)
  const groups = vi.spyOn(saleGroups, 'videoGroups'), specs = vi.spyOn(matrix, 'allowedSpecs')
  groups.mockClear(); specs.mockClear()
  const input = w.get('[data-test="video-sale-1"]')
  const start = performance.now()
  for (const value of ['1', '12', '12.', '12.5', '12.50', '12.5', '12.', '12', '7.25']) {
    await input.setValue(value)
    expect((input.element as HTMLInputElement).value).toBe(value)
  }
  const elapsed = performance.now() - start
  expect(groups).toHaveBeenCalledTimes(0)
  expect(specs).toHaveBeenCalledTimes(0)
  expect(w.emitted('update:product')).toBeUndefined()
  expect(w.emitted('pending-video-sales')?.length).toBe(9)
  console.info('[video-input-measurement]', JSON.stringify({ legal_specs: matrix.allowedSpecs(p.capabilities)!.length, keys: 9, group_recalculations_during_keys: 0, domain_enumerations_during_keys: 0, elapsed_ms: Number(elapsed.toFixed(2)) }))
  await input.trigger('blur'); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(1)
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows[0]!.price?.amount).toBe('7.25')
  w.unmount()
})

it('commits on Enter and switching resolution, retains invalid input and blocks a group change', async () => {
  const w = editor()
  const input = w.get('[data-test="video-sale-1"]')
  await input.setValue('12.50'); await input.trigger('keydown', { key: 'Enter' }); await flushPromises()
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows[0]!.price?.amount).toBe('12.50')
  await w.get('[data-test="video-sale-2"]').setValue('2.75')
  await w.get('[data-test="sale-resolution-4K"]').trigger('click'); await flushPromises()
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows[1]!.price?.amount).toBe('2.75')
  expect(w.get('[data-test="sale-resolution-4K"]').attributes('aria-pressed')).toBe('true')
  await w.get('[data-test="video-sale-1"]').setValue('0')
  await w.get('[data-test="sale-resolution-720p"]').trigger('click'); await flushPromises()
  expect(w.get('[data-test="sale-resolution-4K"]').attributes('aria-pressed')).toBe('true')
  expect((w.get('[data-test="video-sale-1"]').element as HTMLInputElement).value).toBe('0')
  expect(w.text()).toContain('尚未应用')
  w.unmount()
})

it('uses pending first prices for a top-of-list arithmetic preview and preserves later manual input on undo', async () => {
  const p = product(); p.capabilities.durations_seconds = [4, 6, 9, 12]
  const w = editor(p)
  const actions = w.get('[data-test="video-sale-tools"]').element
  expect(actions.compareDocumentPosition(w.get('.mw-video-price-list').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await w.get('[data-test="video-sale-4"]').setValue('2')
  await w.get('[data-test="video-sale-6"]').setValue('4')
  await w.get('[data-test="arithmetic-preview"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('9 秒 → 6')
  await w.get('[data-test="arithmetic-confirm"]').trigger('click'); await flushPromises()
  await w.get('[data-test="video-sale-9"]').setValue('17')
  await w.get('[data-test="arithmetic-undo"]').trigger('click'); await flushPromises()
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows.map(row => row.price?.amount)).toEqual(['2', '4', '17', undefined])
  w.unmount()
})

it('confirms clearing all sale prices while retaining every rule match and capability', async () => {
  const p = product(); p.capabilities.durations_seconds = [4, 6]
  p.pricing_rules = [
    { match: { resolution: ['720p'], duration_seconds: [4] }, sale_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { resolution: ['4K'], aspect_ratio: ['16:9'], duration_seconds: [6] }, sale_price: { amount: '8', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { resolution: ['1080p'] }, sale_price: null }
  ]
  const before = copy(p), w = editor(p)
  await w.get('[data-test="clear-video-sales"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('2 条已有售价')
  expect(w.emitted('update:product')).toBeUndefined()
  await w.get('[data-test="confirm-clear-video-sales"]').trigger('click'); await flushPromises()
  expect(w.props('product').pricing_rules.map(rule => rule.match)).toEqual(before.pricing_rules.map(rule => rule.match))
  expect(w.props('product').pricing_rules.every(rule => rule.sale_price === null)).toBe(true)
  expect(w.props('product').capabilities).toEqual(before.capabilities)
  expect(p).toEqual(before)
  expect(w.text()).toContain('待填写')
  expect(w.text()).toContain('已发布售价保持原样')
  w.unmount()
})

it('edits an unpriced product and resumes idle application after cancelling clear', async () => {
  const p = product(); p.pricing_rules = []
  const w = editor(p)
  await w.get('[data-test="video-sale-1"]').setValue('12.50')
  expect((w.get('[data-test="video-sale-1"]').element as HTMLInputElement).value).toBe('12.50')
  await w.get('[data-test="clear-video-sales"]').trigger('click')
  expect(w.text()).toContain('0 条已有售价')
  await w.findAll('dialog button').find(button => button.text() === '取消')!.trigger('click')
  await vi.advanceTimersByTimeAsync(800); await flushPromises()
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows[0]!.price?.amount).toBe('12.50')
  w.unmount()
})

it('commits multiple prices together before a subgroup change and applies an empty value as unpriced', async () => {
  const p = product(); p.capabilities.durations_seconds = [4, 6]
  p.pricing_rules = [
    { match: { aspect_ratio: ['1:1'] }, sale_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { aspect_ratio: ['16:9'] }, sale_price: { amount: '8', currency: 'CNY', billing_mode: 'per_request' } }
  ]
  const w = editor(p), specs = vi.spyOn(matrix, 'allowedSpecs')
  await w.get('[data-test="video-sale-4"]').setValue('3.25')
  await w.get('[data-test="video-sale-6"]').setValue('')
  const subgroup = w.get('[data-test="sale-subgroup"]')
  const secondKey = subgroup.findAll('option')[1]!.attributes('value')
  await subgroup.setValue(secondKey); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(1)
  const firstGroup = saleGroups.videoGroups(w.props('product'), '720p')!.find(group => group.match.aspect_ratio?.includes('1:1'))!
  expect(firstGroup.rows.map(row => row.price?.amount)).toEqual(['3.25', undefined])
  expect((subgroup.element as HTMLSelectElement).value).toBe(secondKey)
  // One batch enum plus the three committed-product progress/row refreshes.
  expect(specs.mock.calls.length).toBe(5)
  w.unmount()
})

it('preserves raw text when the source price or legal domain changes before application', async () => {
  const w = editor()
  await w.get('[data-test="video-sale-1"]').setValue('12.50')
  const changed = copy(w.props('product'))
  changed.pricing_rules[0]!.sale_price = { amount: '99', currency: 'CNY', billing_mode: 'per_request' }
  await w.setProps({ product: changed })
  await w.get('[data-test="video-sale-1"]').trigger('blur'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  expect((w.get('[data-test="video-sale-1"]').element as HTMLInputElement).value).toBe('12.50')
  expect(w.text()).toContain('商品规格或售价已变化')
  w.unmount()
})

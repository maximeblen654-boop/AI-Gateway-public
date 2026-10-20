import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MediaVideoSaleEditor from '../MediaVideoSaleEditor.vue'
import * as saleGroups from '../videoSaleGroups'
import * as matrix from '../pricingMatrix'
import { copy, imageProduct } from './fixtures'
import { draftInput, type Product } from '@/api/admin/mediaWorkbench'
import type { VideoSaleInput } from '../videoSaleGroups'

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
function editor(p = product(), pendingVideoSales: VideoSaleInput[] = []) {
  const w = mount(MediaVideoSaleEditor, { props: {
    product: p, pendingVideoSales, accountId: 77, adminId: 9,
    'onUpdate:product': (value: Product) => { void w.setProps({ product: value }) },
    'onPending-video-sales': (value: VideoSaleInput[]) => { void w.setProps({ pendingVideoSales: value }) }
  } })
  return w
}
function smallProduct(): Product {
  const p = product()
  p.capabilities.resolutions = ['720p', '1080p']
  p.capabilities.durations_seconds = [4, 6]
  p.capabilities.aspect_ratios = ['1:1', '16:9']
  p.pricing_rules = [{ match: {}, sale_price: price('1') }]
  return p
}
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
function raw(p: Product, amount = '2', duration = 4, resolution = '720p', group = {}): VideoSaleInput {
  const row = saleGroups.videoGroups(p, resolution)!.find(cell => saleGroups.videoGroupKey(cell.match) === saleGroups.videoGroupKey(group))!.rows.find(row => row.duration === duration)!
  return { resolution, group: copy(group), duration, amount, source_price: copy(row.price), domain: JSON.stringify(draftInput([p]).products[0]!.capabilities) }
}
function latestInputs(w: ReturnType<typeof editor>): VideoSaleInput[] {
  return w.emitted('pending-video-sales')?.at(-1)?.[0] as VideoSaleInput[] ?? w.props('pendingVideoSales')
}
function conflict(w: ReturnType<typeof editor>, resolution = '720p', duration = 4) {
  return w.get(`[data-test="video-sale-conflict"][data-resolution="${resolution}"][data-duration="${duration}"]`)
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

it('confirms adopting one source-price conflict while preserving another group raw input and every other saved price', async () => {
  const original = smallProduct()
  original.pricing_rules = [
    { match: { aspect_ratio: ['1:1'] }, sale_price: price('1') },
    { match: { aspect_ratio: ['16:9'] }, sale_price: price('8') }
  ]
  const selected = raw(original, '2.50', 4, '720p', { aspect_ratio: ['1:1'] })
  const other = raw(original, '9.', 6, '1080p', { aspect_ratio: ['16:9'] })
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }])
  const before = copy(changed), w = editor(changed, [selected, other])
  await w.get('[data-test="video-sale-4"]').trigger('blur'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.get('dialog').text()).toContain('720p')
  expect(w.get('dialog').text()).toContain('4 秒')
  expect(w.get('dialog').text()).toContain('比例 1:1')
  expect(w.get('[data-test="sale-original-price"]').text()).toContain('1 CNY')
  expect(w.get('[data-test="sale-current-price"]').text()).toContain('3 CNY')
  expect(w.get('[data-test="sale-adopted-price"]').text()).toContain('2.50 CNY')
  expect(w.emitted('update:product')).toBeUndefined()
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(1)
  expect(w.props('product')).toEqual(saleGroups.setVideoSales(before, [{ ...selected, amount: '2.50' }]))
  expect(latestInputs(w)).toEqual([other])
  expect(changed).toEqual(before)
  w.unmount()
})

it('cancels a conflict adoption without rebinding metadata or changing raw inputs and saved prices', async () => {
  const original = smallProduct(), selected = raw(original), other = raw(original, '4.', 6)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected, other])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  await w.findAll('dialog button').find(button => button.text() === '取消')!.trigger('click')
  await vi.advanceTimersByTimeAsync(800); await flushPromises()
  expect(w.find('dialog').exists()).toBe(false)
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)).toEqual([selected, other])
  expect(w.props('product')).toEqual(changed)
  w.unmount()
})

it('discards only the selected raw input and never clears its saved price or other inputs', async () => {
  const original = smallProduct(), selected = raw(original), other = raw(original, '4.', 6, '1080p')
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), before = copy(changed)
  const w = editor(changed, [selected, other])
  expect(conflict(w).get('[data-test="discard-sale-input"]').text()).toBe('放弃这条输入')
  await conflict(w).get('[data-test="discard-sale-input"]').trigger('click'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  expect(w.props('product')).toEqual(before)
  expect(latestInputs(w)).toEqual([other])
  expect((w.get('[data-test="video-sale-4"]').element as HTMLInputElement).value).toBe('3')
  w.unmount()
})

it('adopts only the selected raw entry even when the other entry is valid and ready to apply', async () => {
  const original = smallProduct(), selected = raw(original), other = raw(original, '7.50', 6, '1080p')
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected, other])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(1)
  expect(w.props('product')).toEqual(saleGroups.setVideoSales(changed, [selected]))
  expect(latestInputs(w)).toEqual([other])
  // Its existing idle application still runs later; the explicit adoption did not consume it.
  await vi.advanceTimersByTimeAsync(799); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1); await flushPromises()
  expect(w.emitted('update:product')).toHaveLength(2)
  expect(w.props('product')).toEqual(saleGroups.setVideoSales(changed, [selected, other]))
  w.unmount()
})

it('keeps conflict actions disabled and prevents an open confirmation from applying after readonly begins', async () => {
  const original = smallProduct(), selected = raw(original)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected])
  await w.setProps({ disabled: true })
  expect(conflict(w).get('[data-test="discard-sale-input"]').attributes('disabled')).toBeDefined()
  expect(conflict(w).get('[data-test="readopt-sale-input"]').attributes('disabled')).toBeDefined()
  await conflict(w).get('[data-test="discard-sale-input"]').trigger('click')
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.find('dialog').exists()).toBe(false)
  expect(latestInputs(w)).toEqual([selected])
  await w.setProps({ disabled: false })
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  await w.setProps({ disabled: true })
  expect(w.get('[data-test="confirm-readopt-sale-input"]').attributes('disabled')).toBeDefined()
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)).toEqual([selected])
  expect(w.props('product')).toEqual(changed)
  w.unmount()
})

it('discards only one duplicate raw entry while adoption stays disabled for ambiguous local ownership', async () => {
  const original = smallProduct(), first = raw(original), second = raw(original, '4')
  const changed = saleGroups.setVideoSales(original, [{ ...first, amount: '3' }]), w = editor(changed, [first, second])
  const rows = w.findAll('[data-test="video-sale-conflict"]')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.get('[data-test="readopt-sale-input"]').attributes('disabled')).toBeDefined()
  expect(rows[1]!.get('[data-test="readopt-sale-input"]').attributes('disabled')).toBeDefined()
  await rows[0]!.get('[data-test="discard-sale-input"]').trigger('click'); await flushPromises()
  expect(latestInputs(w)).toEqual([second])
  expect(w.emitted('update:product')).toBeUndefined()
  expect(w.props('product')).toEqual(changed)
  w.unmount()
})

it('shows the original and current legal specification before explicitly adopting a domain conflict', async () => {
  const original = smallProduct(), selected = raw(original, '2.75'), other = raw(original, '5.', 6, '1080p')
  const changed = copy(original); changed.capabilities.qualities = ['standard']; changed.capabilities.references.total_max = 3
  const w = editor(changed, [selected, other])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.get('[data-test="sale-original-spec"]').text()).toContain('standard / high')
  expect(w.get('[data-test="sale-original-spec"]').text()).toContain('参考素材总数上限 4')
  expect(w.get('[data-test="sale-current-spec"]').text()).toContain('standard')
  expect(w.get('[data-test="sale-current-spec"]').text()).toContain('参考素材总数上限 3')
  expect(w.get('[data-test="sale-current-spec"]').text()).not.toContain('high')
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.props('product')).toEqual(saleGroups.setVideoSales(changed, [selected]))
  expect(latestInputs(w)).toEqual([other])
  expect(conflict(w, '1080p', 6).text()).toContain('规格')
  w.unmount()
})

it.each(['missing-duration', 'missing-resolution', 'changed-subgroup', 'ambiguous-target'] as const)('keeps %s conflicts fail closed and allows discarding just their raw entry', async kind => {
  const original = smallProduct(), selected = raw(original), other = raw(original, '7.', 6, '1080p')
  const changed = copy(original)
  if (kind === 'missing-duration') changed.capabilities.durations_seconds = [6]
  if (kind === 'missing-resolution') changed.capabilities.resolutions = ['1080p']
  if (kind === 'changed-subgroup') changed.pricing_rules = [
    { match: { aspect_ratio: ['1:1'] }, sale_price: price('3') },
    { match: { aspect_ratio: ['16:9'] }, sale_price: price('4') }
  ]
  if (kind === 'ambiguous-target') changed.pricing_rules.push({ match: {}, sale_price: price('3') })
  const before = copy(changed), w = editor(changed, [selected, other])
  expect(conflict(w).get('[data-test="readopt-sale-input"]').attributes('disabled')).toBeDefined()
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.find('dialog').exists()).toBe(false)
  expect(w.emitted('update:product')).toBeUndefined()
  await conflict(w).get('[data-test="discard-sale-input"]').trigger('click'); await flushPromises()
  expect(latestInputs(w)).toEqual([other])
  expect(w.props('product')).toEqual(before)
  w.unmount()
})

it('keeps retyped conflict text protected until the user confirms a fresh adoption', async () => {
  const original = smallProduct(), selected = raw(original)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected])
  await w.get('[data-test="video-sale-4"]').setValue('4')
  await w.get('[data-test="video-sale-4"]').trigger('blur'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)[0]).toEqual({ ...selected, amount: '4' })
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  await w.get('[data-test="video-sale-4"]').setValue('5'); await flushPromises()
  expect(w.find('[data-test="confirm-readopt-sale-input"]').exists()).toBe(false)
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)[0]).toEqual({ ...selected, amount: '5' })
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.get('[data-test="sale-adopted-price"]').text()).toContain('5 CNY')
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(saleGroups.videoGroups(w.props('product'), '720p')![0]!.rows[0]!.price?.amount).toBe('5')
  expect(latestInputs(w)).toEqual([])
  w.unmount()
})

it('rejects a confirmation after newer raw input arrives from its owner', async () => {
  const original = smallProduct(), selected = raw(original)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  const newer = { ...selected, amount: '7.25' }
  await w.setProps({ pendingVideoSales: [newer] }); await flushPromises()
  expect(w.find('[data-test="confirm-readopt-sale-input"]').exists()).toBe(false)
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)).toEqual([newer])
  expect(w.props('product')).toEqual(changed)
  w.unmount()
})

it.each(['account', 'admin', 'product', 'model'] as const)('invalidates the confirmation when %s context changes, including a switch back', async kind => {
  const original = smallProduct(), selected = raw(original)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  if (kind === 'account') { await w.setProps({ accountId: 88 }); await w.setProps({ accountId: 77 }) }
  if (kind === 'admin') { await w.setProps({ adminId: 10 }); await w.setProps({ adminId: 9 }) }
  if (kind === 'product') { await w.setProps({ product: { ...changed, product_id: 'another-product' } }); await w.setProps({ product: changed }) }
  if (kind === 'model') { await w.setProps({ product: { ...changed, upstream_model: 'another-model' } }); await w.setProps({ product: changed }) }
  await flushPromises()
  expect(w.find('[data-test="confirm-readopt-sale-input"]').exists()).toBe(false)
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)).toEqual([selected])
  expect(w.props('product')).toEqual(changed)
  w.unmount()
})

it.each(['source-price', 'legal-domain', 'missing-target', 'ambiguous-target'] as const)('rejects adoption when the %s changes while confirmation is open', async kind => {
  const original = smallProduct(), selected = raw(original)
  const changed = saleGroups.setVideoSales(original, [{ ...selected, amount: '3' }]), w = editor(changed, [selected])
  await conflict(w).get('[data-test="readopt-sale-input"]').trigger('click'); await flushPromises()
  const newer = copy(changed)
  if (kind === 'source-price') newer.pricing_rules = [{ match: {}, sale_price: price('8') }]
  if (kind === 'legal-domain') newer.capabilities.qualities = ['standard']
  if (kind === 'missing-target') newer.capabilities.durations_seconds = [6]
  if (kind === 'ambiguous-target') newer.pricing_rules.push({ match: {}, sale_price: price('9') })
  await w.setProps({ product: newer }); await flushPromises()
  await w.get('[data-test="confirm-readopt-sale-input"]').trigger('click'); await flushPromises()
  expect(w.emitted('update:product')).toBeUndefined()
  expect(latestInputs(w)).toEqual([selected])
  expect(w.props('product')).toEqual(newer)
  expect(w.text()).toContain('重新核对')
  w.unmount()
})

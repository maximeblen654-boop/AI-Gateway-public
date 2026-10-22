import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { imageProduct } from './fixtures'
import MediaVideoSaleEditor from '../MediaVideoSaleEditor.vue'
import MediaIndependentCalculator from '../MediaIndependentCalculator.vue'
import { arithmeticFill, setVideoSale, videoGroups } from '../videoSaleGroups'
import type { Product } from '@/api/admin/mediaWorkbench'
import { allowedSpecs, matchesSpec } from '../pricingMatrix'
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn() })
function product(): Product { const p = structuredClone(imageProduct); p.media_type = 'video'; p.capabilities.resolutions = ['720p', '4K']; p.capabilities.durations_seconds = [4, 6, 9, 12]; p.capabilities.count = { min: 1, max: 1 }; p.pricing_rules = [{ match: {}, sale_price: null }]; return p }
describe('video sale groups', () => {
  it('partitions different duration-specific ratio groups and preserves the unedited shared price', () => {
    const p = product(); p.capabilities.durations_seconds = [4, 5]
    p.pricing_rules = [
      { match: { duration_seconds: [4], aspect_ratio: ['1:1', '16:9'] }, sale_price: price('2') },
      { match: { duration_seconds: [5], aspect_ratio: ['1:1'] }, sale_price: price('3') },
      { match: { duration_seconds: [5], aspect_ratio: ['16:9'] }, sale_price: price('4') }
    ]
    const groups = videoGroups(p, '720p')!
    expect(groups).toHaveLength(2)
    const square = groups.find(group => group.match.aspect_ratio?.includes('1:1'))!
    expect(square.rows.map(row => row.price?.amount)).toEqual(['2', '3'])
    const next = setVideoSale(p, '720p', square.match, 4, '9')
    for (const spec of allowedSpecs(p.capabilities)!) {
      const matching = next.pricing_rules.filter(rule => matchesSpec(rule.match, spec))
      expect(matching).toHaveLength(1)
      expect(matching[0]!.sale_price?.amount).toBe(spec.duration_seconds === 5 ? spec.aspect_ratio === '1:1' ? '3' : '4' : spec.resolution === '720p' && spec.aspect_ratio === '1:1' ? '9' : '2')
    }
  })
  it('shows every duration and minimally partitions shared resolution and duration prices', () => {
    const p = product(); p.pricing_rules[0]!.sale_price = price('2')
    const next = setVideoSale(p, '720p', {}, 6, '4')
    expect(next.pricing_rules).toHaveLength(3)
    expect(videoGroups(next, '720p')![0]!.rows.map(r => r.price?.amount)).toEqual(['2', '4', '2', '2'])
    expect(videoGroups(next, '4K')![0]!.rows.map(r => r.price?.amount)).toEqual(['2', '2', '2', '2'])
    expect(p.pricing_rules).toHaveLength(1)
  })
  it('keeps one shared row when duration is not a pricing dimension', () => {
    const p = product(); p.pricing_rules[0]!.sale_price = price('2')
    const groups = videoGroups(p, '720p', { splitDuration: false })!
    expect(groups).toHaveLength(1)
    expect(groups[0]!.rows).toEqual([{ duration: 0, duration_values: [4, 6, 9, 12], price: price('2'), ambiguous: false }])
    const next = setVideoSale(p, '', {}, 0, '3')
    expect(next.pricing_rules).toEqual([{ match: {}, sale_price: price('3') }])
    expect(videoGroups(next, '720p', { splitDuration: false })![0]!.rows[0]!.price?.amount).toBe('3')
  })
  it('fills by position rather than seconds and never replaces a later explicit value', () => {
    const result = arithmeticFill([{ duration: 4, price: price('2') }, { duration: 6, price: price('4') }, { duration: 9, price: price('99') }, { duration: 12, price: null }])
    expect(result).toEqual({ delta: '2', retained: 3, changes: [{ duration: 12, amount: '8' }] })
    expect(() => arithmeticFill([{ duration: 4, price: price('2') }, { duration: 6, price: price('1') }, { duration: 9, price: null }])).toThrow('正售价')
    expect(arithmeticFill([{ duration: 4, price: price('0.00000001') }, { duration: 6, price: price('0.00000002') }, { duration: 9, price: null }]).changes[0]!.amount).toBe('0.00000003')
    expect(() => arithmeticFill([{ duration: 4, price: null }])).toThrow('前两档')
  })
  it('retains a bounded legal large matrix beyond the old 256 cost grouping limit', () => {
    const p = product(); p.capabilities.durations_seconds = Array.from({ length: 27 }, (_, i) => i + 4); p.capabilities.aspect_ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:1'];
    expect(videoGroups(p, '720p')![0]!.rows).toHaveLength(27)
  })
  it('bounds price rows and rejects a nonexistent editable cell', () => {
    const p = product(); p.capabilities.durations_seconds = Array.from({ length: 32 }, (_, i) => i + 1)
    p.capabilities.aspect_ratios = Array.from({ length: 32 }, (_, i) => `${i + 1}:1`)
    p.capabilities.references.image = { min: 0, max: 0 }; p.capabilities.references.total_max = 0
    p.pricing_rules = p.capabilities.aspect_ratios.map(ratio => ({ match: { aspect_ratio: [ratio] }, sale_price: null }))
    expect(videoGroups(p, '720p')!.flatMap(group => group.rows)).toHaveLength(1024)
    expect(() => setVideoSale(p, '720p', {}, 999, '1')).toThrow('合法售价范围')
    expect(p.pricing_rules).toHaveLength(32)
  })
  it('keeps all blank resolution and ratio groups visible after the first price', () => {
    const p = product(); p.pricing_rules = [{ match: { resolution: ['720p'], duration_seconds: [4], aspect_ratio: ['1:1'] }, sale_price: price('2') }]
    const groups = videoGroups(p, '4K')!
    expect(groups).toHaveLength(1)
    expect(groups.every(group => group.rows.length === 4 && group.rows.every(row => row.price === null))).toBe(true)
  })
  it('completes material gaps without a wildcard overlap or importing other resolution subgroups', () => {
    const p = product(); p.capabilities.references.image = { min: 0, max: 1 }; p.capabilities.references.total_max = 1
    const refs = { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }
    p.pricing_rules = [{ match: { resolution: ['720p'], references: refs }, sale_price: price('2') }, { match: { resolution: ['4K'], aspect_ratio: ['16:9'] }, sale_price: price('7') }]
    const groups = videoGroups(p, '720p')!
    expect(groups).toHaveLength(2)
    expect(groups.every(group => !group.match.aspect_ratio)).toBe(true)
    const missing = groups.find(group => group.match.references?.image.min === 1)!
    expect(missing.match.references?.image).toEqual({ min: 1, max: 1 })
    const next = setVideoSale(p, '720p', missing.match, 4, '3')
    expect(next.pricing_rules[0]!.sale_price?.amount).toBe('2')
    expect(next.pricing_rules[1]!.sale_price?.amount).toBe('7')
    expect(next.pricing_rules.filter(rule => !rule.match.references && rule.match.resolution?.includes('720p'))).toHaveLength(0)
  })
  it('preserves subgroup matches and excludes denied duration combinations', () => {
    const p = product(); p.pricing_rules = [{ match: { aspect_ratio: ['1:1'] }, sale_price: null }]; p.capabilities.combination_rules = [{ deny: { resolution: ['720p'], duration_seconds: [9] } }]
    expect(videoGroups(p, '720p')![0]!.rows.map(r => r.duration)).toEqual([4, 6, 12])
    const rules = setVideoSale(p, '720p', { aspect_ratio: ['1:1'] }, 4, '2').pricing_rules
    expect(rules[rules.length - 1]!.match.aspect_ratio).toEqual(['1:1'])
  })
  it('previews without updates, applies one event, protects subsequent edits from undo', async () => {
    const p = setVideoSale(setVideoSale(product(), '720p', {}, 4, '2'), '720p', {}, 6, '4')
    const w = mount(MediaVideoSaleEditor, { props: { product: p, 'onUpdate:product': value => { void w.setProps({ product: value }) } } })
    await w.get('[data-test="arithmetic-preview"]').trigger('click'); await flushPromises()
    expect(w.emitted('update:product')).toBeUndefined()
    await w.get('[data-test="arithmetic-confirm"]').trigger('click'); await flushPromises()
    expect(w.emitted('update:product')).toHaveLength(1)
    expect(videoGroups(w.props('product'), '720p')![0]!.rows.map(r => r.price?.amount)).toEqual(['2', '4', '6', '8'])
    await w.get('[data-test="video-sale-9"]').setValue('17')
    await w.get('[data-test="arithmetic-undo"]').trigger('click'); await flushPromises()
    expect(videoGroups(w.props('product'), '720p')![0]!.rows.map(r => r.price?.amount)).toEqual(['2', '4', '17', undefined])
    expect(videoGroups(w.props('product'), '4K')![0]!.rows.every(r => r.price === null)).toBe(true)
  })
  it('clears undo after explicit server reload or recovery without changing draft', async () => {
    const p = setVideoSale(setVideoSale(product(), '720p', {}, 4, '2'), '720p', {}, 6, '4')
    const w = mount(MediaVideoSaleEditor, { props: { product: p, 'onUpdate:product': value => { void w.setProps({ product: value }) } } })
    await w.get('[data-test="arithmetic-preview"]').trigger('click'); await flushPromises()
    await w.get('[data-test="arithmetic-confirm"]').trigger('click'); await flushPromises()
    w.vm.invalidateUndo(); await flushPromises()
    expect(w.find('[data-test="arithmetic-undo"]').exists()).toBe(false)
    expect(w.emitted('update:product')).toHaveLength(1)
  })
  it('independent calculator has no product update events and remembers inputs across close', async () => {
    localStorage.clear()
    const w = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
    await w.get('[data-test="independent-purchase"]').setValue('100')
    await w.get('[data-test="independent-credits"]').setValue('1000')
    await w.get('[data-test="independent-consumption"]').setValue('15')
    expect(w.get('[data-test="independent-result"]').text()).toBe('1.5 元')
    expect(w.emitted('update:product')).toBeUndefined()
    w.unmount()
    const again = mount(MediaIndependentCalculator, { props: { adminId: 7 } })
    expect(again.get('[data-test="independent-result"]').text()).toBe('1.5 元')
    await again.get('[data-test="independent-purchase"]').setValue('0')
    expect(again.get('[data-test="independent-result"]').text()).toBe('0 元')
    await again.get('[data-test="independent-credits"]').setValue('0')
    expect(again.get('[data-test="independent-result"]').text()).toBe('—')
  })
})

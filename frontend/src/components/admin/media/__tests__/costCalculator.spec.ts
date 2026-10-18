import { beforeEach, expect, it, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { imageProduct } from './fixtures'
import MediaCostCalculator from '../MediaCostCalculator.vue'
import { consumptionKey, decimalUnits, emptyCostMemory, estimateCost, readCostMemory, storageKey } from '../costCalculator'
const price = (amount: string, currency = 'CNY') => ({ amount, currency, billing_mode: 'per_request' })
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
it('distinguishes empty, explicit zero and invalid decimals', () => {
  for (const v of ['', '-1', '1e3', 'Infinity', 'NaN', '1.123456789', '1000000000000']) expect(decimalUnits(v)).toBeUndefined()
  expect(decimalUnits('0')).toBe(0n); expect(decimalUnits('0', true)).toBeUndefined()
  expect(estimateCost('100', '1000', '', price('1')).cost).toBeUndefined()
  expect(estimateCost('100', '1000', '0', price('0'))).toMatchObject({ cost: '0', difference: '0', belowCost: false })
})
it('does not round before multiplication or hide a tiny loss; no FX', () => {
  expect(estimateCost('1', '3', '3', price('1'))).toMatchObject({ cost: '1', difference: '0' })
  expect(estimateCost('0.00000001', '100000000000', '1', price('0'))).toMatchObject({ belowCost: true, difference: '−<0.00000001' })
  expect(estimateCost('100', '1000', '8', price('0.70'))).toMatchObject({ perCredit: '0.1', cost: '0.8', difference: '−0.1' })
  expect(estimateCost('100', '1000', '8', price('2', 'USD')).difference).toBeUndefined()
  expect(estimateCost('100', '0', '8', price('2'))).toEqual({})
})
it('uses stable spec and identity keys, never row index or price', () => {
  const p = structuredClone(imageProduct), rule = p.pricing_rules[0]!, key = consumptionKey(p, rule)
  expect(storageKey(1,77)).not.toBe(storageKey(2,77)); expect(storageKey(1,77)).not.toBe(storageKey(1,78)); expect(storageKey()).toBeUndefined()
  const same = structuredClone(p); same.display_name = 'renamed'; same.pricing_rules[0]!.sale_price = price('99'); same.capabilities.resolutions.reverse()
  expect(consumptionKey(same, same.pricing_rules[0]!)).toBe(key)
  same.product_id = 'other'; expect(consumptionKey(same, rule)).not.toBe(key)
  same.product_id = p.product_id; same.capabilities.aspect_ratios.push('4:3'); expect(consumptionKey(same, rule)).not.toBe(key)
})
it('rejects damaged storage safely', () => {
  for (const raw of ['bad', '{}', 'null', JSON.stringify({ ...emptyCostMemory(), consumption: { a: 'Infinity' } }), ' '.repeat(256001)]) expect(() => readCostMemory(raw)).toThrow()
  expect(readCostMemory(null)).toEqual(emptyCostMemory())
})
it('remembers local values without changing product; switches account and video scope', async () => {
  const product = structuredClone(imageProduct), before = JSON.stringify(product)
  const wrapper = mount(MediaCostCalculator, { props: { product, accountId: 77, adminId: 1, labels: ['统一售价'] } })
  await wrapper.get('[data-test="cost-purchase"]').setValue('100')
  await wrapper.get('[data-test="cost-credits"]').setValue('1000')
  await wrapper.get('[data-test="cost-consumption-0"]').setValue('8')
  expect(wrapper.text()).toContain('当前售价低于估算上游成本')
  expect(JSON.stringify(product)).toBe(before); expect(wrapper.emitted()).not.toHaveProperty('update:product')
  const second = mount(MediaCostCalculator, { props: { product, accountId: 77, adminId: 1, labels: [] } })
  expect((second.get('[data-test="cost-consumption-0"]').element as HTMLInputElement).value).toBe('8')
  await second.setProps({ accountId: 78 }); expect((second.get('[data-test="cost-purchase"]').element as HTMLInputElement).value).toBe('')
  await wrapper.setProps({ product: { ...product, media_type: 'video' } }); expect(wrapper.text()).toContain('视频按整条计算，不再乘秒数'); expect(wrapper.text()).toContain('待估算')
})

it('survives blocked or corrupt local storage and remains optional', async () => {
  localStorage.setItem(storageKey(1,77)!, 'corrupt')
  const wrapper = mount(MediaCostCalculator, { props: { product: structuredClone(imageProduct), accountId: 77, adminId: 1, labels: [] } })
  expect(wrapper.text()).toContain('已忽略旧值')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  await wrapper.get('[data-test="cost-purchase"]').setValue('100')
  await wrapper.get('[data-test="cost-credits"]').setValue('1000')
  await wrapper.get('[data-test="cost-consumption-0"]').setValue('1')
  expect(wrapper.text()).toContain('未能记住'); expect(wrapper.text()).toContain('0.1 CNY')
  expect(wrapper.emitted()).not.toHaveProperty('update:product')
})
it('follows reordered tiers without carrying costs into changed spec coverage', async () => {
  const product = structuredClone(imageProduct)
  product.pricing_rules = ['1K','4K'].map(resolution => ({ match: { resolution: [resolution] }, sale_price: price('2') }))
  const wrapper = mount(MediaCostCalculator, { props: { product, accountId: 77, adminId: 1, labels: [] } })
  await wrapper.get('[data-test="cost-consumption-0"]').setValue('3')
  await wrapper.get('[data-test="cost-consumption-1"]').setValue('9')
  await wrapper.setProps({ product: { ...product, pricing_rules: [...product.pricing_rules].reverse() } })
  expect((wrapper.get('[data-test="cost-consumption-0"]').element as HTMLInputElement).value).toBe('9')
  const changed = structuredClone(product); changed.capabilities.combination_rules = [{ deny: { aspect_ratio: ['16:9'] } }]
  await wrapper.setProps({ product: changed })
  expect((wrapper.get('[data-test="cost-consumption-0"]').element as HTMLInputElement).value).toBe('')
})
it('video estimate is per complete item and current unsaved sale is authoritative', async () => {
  const product = structuredClone(imageProduct); product.media_type = 'video'; product.capabilities.durations_seconds = [5,10]
  product.pricing_rules = [{ match: {}, sale_price: price('2') }]
  const wrapper = mount(MediaCostCalculator, { props: { product, accountId: 77, adminId: 1, labels: [] } })
  await wrapper.get('[data-test="cost-purchase"]').setValue('100'); await wrapper.get('[data-test="cost-credits"]').setValue('1000'); await wrapper.get('[data-test="cost-consumption-0"]').setValue('8')
  expect(wrapper.text()).toContain('0.8 CNY'); expect(wrapper.text()).toContain('1.2 CNY')
  await wrapper.setProps({ product: { ...product, pricing_rules: [{ match: {}, sale_price: price('1') }] } })
  expect(wrapper.text()).toContain('0.2 CNY'); expect((wrapper.get('[data-test="cost-consumption-0"]').element as HTMLInputElement).value).toBe('8')
})
it('keeps a single selected calculator row while overlapping draft conditions are being edited', async () => {
  const wrapper = mount(MediaCostCalculator, { props: { product: structuredClone(imageProduct), labels: ['条件一', '条件二'], costRules: [{ match: {}, cost: null }, { match: {}, cost: null }] } })
  await wrapper.get('[data-test="cost-tab-1"]').trigger('click')
  expect(wrapper.get('[data-test="cost-row-0"]').attributes('style')).toContain('display: none')
  expect(wrapper.get('[data-test="cost-row-1"]').attributes('style') ?? '').not.toContain('display: none')
  expect(wrapper.findAll('[role="tab"][aria-selected="true"]')).toHaveLength(1)
})

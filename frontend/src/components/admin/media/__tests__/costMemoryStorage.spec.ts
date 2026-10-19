import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MediaCostCalculator from '../MediaCostCalculator.vue'
import { consumptionKey, emptyCostMemory, estimateCost, storageKey } from '../costCalculator'
import { costFieldKey, loadCostMemory, writeCostMemoryField } from '../costMemoryStorage'
import { copy, imageProduct } from './fixtures'
const identity = storageKey(1, 44)!
function calculator(product = copy(imageProduct)) {
  return mount(MediaCostCalculator, { props: { product, adminId: 1, accountId: 44, labels: [] } })
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('restores unfinished decimals and non-numeric consumption without blocking another valid field', async () => {
  const first = calculator()
  await first.get('[data-test="cost-purchase"]').setValue('0.')
  await first.get('[data-test="cost-credits"]').setValue('1000')
  await first.get('[data-test="cost-consumption-0"]').setValue('abc')
  expect(first.emitted('update:product')).toBeUndefined()
  first.unmount()
  const restored = calculator()
  expect(restored.get('[data-test="cost-purchase"]').element).toHaveProperty('value', '0.')
  expect(restored.get('[data-test="cost-credits"]').element).toHaveProperty('value', '1000')
  expect(restored.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', 'abc')
  expect(restored.get('[data-test="cost-purchase"]').attributes('aria-invalid')).toBe('true')
  expect(restored.get('[data-test="cost-consumption-0"]').attributes('aria-invalid')).toBe('true')
  expect(restored.text()).toContain('待估算')
  expect(estimateCost('0.', '1000', 'abc', null)).toEqual({})
  restored.unmount()
})
it('overlays independent v2 values and explicit empty strings over legacy v1 without deleting it', async () => {
  const key = consumptionKey(imageProduct, imageProduct.pricing_rules[0]!)
  const legacy = { ...emptyCostMemory(), purchase: '100', credits: '1000', consumption: { [key]: '8' } }
  const raw = JSON.stringify(legacy)
  localStorage.setItem(identity, raw)
  const first = calculator()
  expect(first.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', '8')
  await first.get('[data-test="cost-purchase"]').setValue('0.')
  await first.get('[data-test="cost-consumption-0"]').setValue('')
  first.unmount()
  const restored = calculator()
  expect(restored.get('[data-test="cost-purchase"]').element).toHaveProperty('value', '0.')
  expect(restored.get('[data-test="cost-credits"]').element).toHaveProperty('value', '1000')
  expect(restored.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', '')
  expect(localStorage.getItem(identity)).toBe(raw)
  restored.unmount()
})
it('keeps different product edits from two real mounts sharing one Storage', async () => {
  const other = copy(imageProduct); other.product_id = 'other-product'; other.upstream_model = 'other-model'
  const pageA = calculator(), pageB = calculator(other)
  await pageA.get('[data-test="cost-consumption-0"]').setValue('3')
  await pageB.get('[data-test="cost-consumption-0"]').setValue('9')
  await pageA.get('[data-test="cost-purchase"]').setValue('25')
  await pageB.get('[data-test="cost-credits"]').setValue('100')
  pageA.unmount(); pageB.unmount()
  const restoredA = calculator(), restoredB = calculator(other)
  expect(restoredA.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', '3')
  expect(restoredB.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', '9')
  for (const page of [restoredA, restoredB]) {
    expect(page.get('[data-test="cost-purchase"]').element).toHaveProperty('value', '25')
    expect(page.get('[data-test="cost-credits"]').element).toHaveProperty('value', '100')
    expect(page.emitted('update:product')).toBeUndefined()
    page.unmount()
  }
})
it('uses the last explicit edit of the same field; stale edits to other fields cannot restore an old value', async () => {
  const pageA = calculator(), pageB = calculator()
  await pageA.get('[data-test="cost-purchase"]').setValue('7')
  await pageB.get('[data-test="cost-purchase"]').setValue('9')
  await pageA.get('[data-test="cost-credits"]').setValue('100')
  await pageA.get('[data-test="cost-consumption-0"]').setValue('4')
  expect(loadCostMemory(localStorage, identity).memory).toMatchObject({ purchase: '9', credits: '100' })
  pageA.unmount(); pageB.unmount()
})
it('warns on overlong input without truncation or loss of other successful field writes', async () => {
  const page = calculator()
  await page.get('[data-test="cost-purchase"]').setValue('100')
  await page.get('[data-test="cost-purchase"]').setValue('x'.repeat(129))
  await page.get('[data-test="cost-credits"]').setValue('1000')
  expect(page.get('[data-test="cost-purchase"]').element).toHaveProperty('value', 'x'.repeat(129))
  expect(page.text()).toContain('超过 128 字符，未能记住')
  expect(loadCostMemory(localStorage, identity).memory).toMatchObject({ purchase: '100', credits: '1000' })
  await page.get('[data-test="cost-purchase"]').setValue('1'.repeat(128))
  expect(page.text()).not.toContain('未能记住')
  expect(loadCostMemory(localStorage, identity).memory.purchase).toBe('1'.repeat(128))
  page.unmount()
})
it('rejects new consumption at the cap without deleting old entries and still allows an existing field edit', async () => {
  const key = consumptionKey(imageProduct, imageProduct.pricing_rules[0]!)
  localStorage.setItem(costFieldKey(identity, 'consumption', key), '1')
  for (let index = 1; index < 256; index++) localStorage.setItem(costFieldKey(identity, 'consumption', `old-spec-${index}`), '1')
  const pageA = calculator(), other = copy(imageProduct); other.product_id = 'new-product'
  const pageB = calculator(other)
  await pageB.get('[data-test="cost-consumption-0"]').setValue('8')
  expect(pageB.text()).toContain('已记忆 256 个规格，未能记住新增规格')
  expect(pageB.get('[data-test="cost-consumption-0"]').element).toHaveProperty('value', '8')
  await pageA.get('[data-test="cost-consumption-0"]').setValue('2')
  expect(localStorage.length).toBe(256)
  expect(loadCostMemory(localStorage, identity).memory.consumption[key]).toBe('2')
  expect(localStorage.getItem(costFieldKey(identity, 'consumption', 'old-spec-255'))).toBe('1')
  pageA.unmount(); pageB.unmount()
})
it('keeps a failed field warning after a different field succeeds and does not mutate server data', async () => {
  const page = calculator(), original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string, value: string) {
    if (key === costFieldKey(identity, 'purchase')) throw new Error('quota')
    original.call(this, key, value)
  })
  await page.get('[data-test="cost-purchase"]').setValue('42')
  await page.get('[data-test="cost-credits"]').setValue('1000')
  expect(page.text()).toContain('未能记住本字段')
  expect(loadCostMemory(localStorage, identity).memory.credits).toBe('1000')
  expect(page.emitted('update:product')).toBeUndefined()
  page.unmount()
})
it('bounds storage enumeration and keeps explicit zero as a valid raw input with unchanged amount rules', () => {
  writeCostMemoryField(localStorage, identity, 'purchase', '0')
  writeCostMemoryField(localStorage, identity, 'credits', '1000')
  writeCostMemoryField(localStorage, identity, 'consumption', '0', 'zero-spec')
  expect(loadCostMemory(localStorage, identity).memory).toMatchObject({ purchase: '0', consumption: { 'zero-spec': '0' } })
  expect(estimateCost('0', '1000', '0', null)).toEqual({})
  expect(estimateCost('100', '1000', '0', null).cost).toBe('0')
  expect(() => writeCostMemoryField(localStorage, identity, 'consumption', '1', 'x'.repeat(16000))).toThrow('invalid_spec')
  for (let index = localStorage.length; index <= 4096; index++) localStorage.setItem(`other-key-${index}`, '')
  expect(() => loadCostMemory(localStorage, identity)).toThrow('storage_enumeration_limit')
  expect(localStorage.getItem(costFieldKey(identity, 'purchase'))).toBe('0')
})

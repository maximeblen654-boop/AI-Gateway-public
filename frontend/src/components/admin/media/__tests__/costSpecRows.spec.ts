import { describe, expect, it } from 'vitest'
import { costSpecRows, durationSuggestion } from '../costSpecRows'
import { grossProfit } from '../costCalculator'
import { matchesSpec } from '../pricingMatrix'
import { copy, imageProduct } from './fixtures'
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
export function videoProduct() {
  const product = copy(imageProduct)
  product.media_type = 'video'
  product.capabilities = { resolutions: ['720p'], aspect_ratios: ['16:9'], qualities: [], durations_seconds: [4, 8, 12, 16], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] }
  product.cost_rules = [4, 8, 12, 16].map((duration, index) => ({ match: { duration_seconds: [duration] }, cost: index < 3 ? price(String(duration / 4)) : null, source: 'manual' }))
  product.pricing_rules = [4, 8, 12, 16].map((duration, index) => ({ match: { duration_seconds: [duration] }, sale_price: index < 3 ? price(String(duration / 2 + 1)) : null }))
  return product
}
describe('real spec association', () => {
  it('matches reordered and differently partitioned costs/sales without changing either', () => {
    const product = videoProduct()
    product.cost_rules = [{ match: {}, cost: price('2') }]
    product.pricing_rules.reverse()
    const before = JSON.stringify(product)
    const rows = costSpecRows(product).rows
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.priceIndex)).toEqual([3, 2, 1, 0])
    expect(rows.every(row => row.costIndex === 0 && row.costCount === 4 && row.priceCount === 1)).toBe(true)
    const key = rows[0]!.key
    product.pricing_rules.reverse()
    expect(costSpecRows(product).rows[0]!.key).toBe(key)
    product.pricing_rules.reverse()
    expect(JSON.stringify(product)).toBe(before)
  })
  it('keeps reference modes/count ranges distinct and obeys excluded combinations', () => {
    const product = copy(imageProduct)
    product.capabilities.count = { min: 1, max: 2 }
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], aspect_ratio: ['16:9'] } }]
    product.cost_rules = [{ match: { count: { min: 1, max: 1 } }, cost: price('1') }, { match: { count: { min: 2, max: 2 } }, cost: price('2') }]
    const rows = costSpecRows(product).rows
    expect(rows).toHaveLength(6)
    expect(rows.every(row => !(row.spec.resolution === '4K' && row.spec.aspect_ratio === '16:9'))).toBe(true)
    expect(rows.filter(row => row.spec.count === 2).every(row => row.costIndex === 1 && row.priceIndex === 0)).toBe(true)
  })
  it('marks overlap and keeps unmatched historic rules intact', () => {
    const product = videoProduct()
    product.cost_rules = [{ match: {}, cost: price('1') }, { match: { duration_seconds: [4] }, cost: price('2') }, { match: { resolution: ['legacy'] }, cost: price('99') }]
    const rows = costSpecRows(product).rows
    expect(rows[0]).toMatchObject({ costConflict: true, costIndex: undefined })
    expect(product.cost_rules[2]!.cost!.amount).toBe('99')
    expect(rows[1]).toMatchObject({ costConflict: false, costIndex: 0 })
  })
  it('never synthesizes a missing rule over another displayed spec', () => {
    const product = copy(imageProduct)
    product.capabilities.count = { min: 1, max: 2 }
    product.cost_rules = [{ match: { resolution: ['4K'] }, cost: price('2') }]
    const rows = costSpecRows(product).rows
    for (const row of rows.filter(value => value.costIndex === undefined)) {
      const covered = rows.flatMap(other => other.specs).filter(spec => matchesSpec(row.match, spec))
      expect(covered).toEqual(row.specs)
    }
  })
  it('retains complex format rules and oversized domains through an explicit fallback', () => {
    const product = videoProduct()
    product.cost_rules![0]!.match.output_formats = ['webp']
    expect(costSpecRows(product)).toMatchObject({ rows: [], reason: expect.stringContaining('输出格式') })
    delete product.cost_rules![0]!.match.output_formats
    product.capabilities.resolutions = Array.from({ length: 32 }, (_, i) => `r${i}`)
    product.capabilities.aspect_ratios = Array.from({ length: 3 }, (_, i) => `a${i}`)
    expect(costSpecRows(product)).toMatchObject({ rows: [], reason: expect.stringContaining('显示范围') })
  })
})
describe('independent conservative suggestions', () => {
  it('derives independent cost and sale progressions, not a markup from cost', () => {
    const product = videoProduct(), row = costSpecRows(product).rows[3]!
    expect(durationSuggestion(product, row, 'cost')).toMatchObject({ amount: '4', basis: expect.stringContaining('3 个已填写成本') })
    expect(durationSuggestion(product, row, 'sale')).toMatchObject({ amount: '9', basis: expect.stringContaining('3 个已填写售价') })
    product.cost_rules![1]!.cost = price('2.7')
    expect(durationSuggestion(product, row, 'cost')).toBeUndefined()
    expect(durationSuggestion(product, row, 'sale')!.amount).toBe('9')
  })
  it('requires three consistent duration samples and rejects conflicting duplicates', () => {
    const product = videoProduct(), row = costSpecRows(product).rows[3]!
    product.pricing_rules[2]!.sale_price = null
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
    product.pricing_rules[2]!.sale_price = price('7')
    product.pricing_rules.push({ match: { duration_seconds: [8] }, sale_price: price('20') })
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
  })
  it('does not borrow across resolutions, references, shared duration destinations, images or calculated costs', () => {
    const product = videoProduct(), row = costSpecRows(product).rows[3]!
    product.pricing_rules[0]!.match.resolution = ['1080p']
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
    product.cost_rules![0]!.source = 'calculator'
    expect(durationSuggestion(product, row, 'cost')).toBeUndefined()
    product.cost_rules![0]!.source = 'manual'
    product.cost_rules![3]!.match = {}
    expect(durationSuggestion(product, costSpecRows(product).rows[3]!, 'cost')).toBeUndefined()
    product.media_type = 'image'
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
  })
  it('does not infer from inactive durations, excluded combinations or overlapping sample contracts', () => {
    const product = videoProduct(), row = costSpecRows(product).rows[3]!
    product.capabilities.durations_seconds = [4, 8, 16]
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
    product.capabilities.durations_seconds = [4, 8, 12, 16]
    product.capabilities.combination_rules = [{ deny: { duration_seconds: [4] } }]
    expect(durationSuggestion(product, row, 'sale')).toBeUndefined()
    product.capabilities.combination_rules = []
    product.pricing_rules.push({ match: {}, sale_price: price('99') })
    expect(durationSuggestion(product, costSpecRows(product).rows[3]!, 'sale')).toBeUndefined()
  })
  it('uses exact fixed point for tiny profit, negatives, empty/invalid and zero sale', () => {
    expect(grossProfit(price('0.1'), price('0.3'))).toEqual({ profit: '0.2', margin: '66.66666667', belowCost: false })
    expect(grossProfit(price('1.00000001'), price('1'))).toEqual({ profit: '−0.00000001', margin: '−0.000001', belowCost: true })
    expect(grossProfit(price('1'), price('0'))).toEqual({ profit: '−1', margin: undefined, belowCost: true })
    for (const amount of ['', '-1', 'NaN', '1e2']) expect(grossProfit(price('1'), price(amount))).toEqual({})
    expect(grossProfit(null, price('1'))).toEqual({})
    expect(grossProfit(price('1'), { ...price('2'), currency: 'USD' })).toEqual({})
  })
})

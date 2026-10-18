import { describe, expect, it } from 'vitest'
import { allowedSpecs, buildPricingRules, creationModeForRule, mergeCreationModePricing, splitCreationModePricing } from '../pricingMatrix'
import { copy, imageProduct } from './fixtures'

describe('pricing matrix follows sellable combinations', () => {
  it('returns only the three sellable rows for a partially denied domain', () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['1K', '2K']
    product.capabilities.qualities = ['standard', 'high']
    product.capabilities.combination_rules = [{ deny: { resolution: ['2K'], quality: ['high'] } }]
    const specs = allowedSpecs(product.capabilities)!
    const rows = buildPricingRules(product, ['resolution', 'quality'], specs)
    expect(rows.map(row => row.match)).toEqual([
      { resolution: ['1K'], quality: ['standard'] },
      { resolution: ['1K'], quality: ['high'] },
      { resolution: ['2K'], quality: ['standard'] }
    ])
  })

  it('returns no price rows when every selected combination is denied', () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['1K', '2K']
    product.capabilities.qualities = ['standard', 'high']
    product.capabilities.combination_rules = [
      { deny: { resolution: ['1K'] } },
      { deny: { resolution: ['2K'] } }
    ]
    expect(buildPricingRules(product, ['resolution', 'quality'], allowedSpecs(product.capabilities)!)).toEqual([])
  })

  it('keeps a uniform price for unpriced fields and leaves missing prices empty', () => {
    const product = copy(imageProduct)
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.18', currency: 'CNY', billing_mode: 'per_request' } }]
    const rows = buildPricingRules(product, ['resolution'], allowedSpecs(product.capabilities)!)
    expect(rows.map(row => row.sale_price?.amount)).toEqual(['0.18', '0.18'])
    product.pricing_rules = [{ match: { resolution: ['1K'] }, sale_price: { amount: '0.20', currency: 'CNY', billing_mode: 'per_request' } }]
    expect(buildPricingRules(product, ['resolution'], allowedSpecs(product.capabilities)!).map(row => row.sale_price?.amount ?? null)).toEqual(['0.20', null])
  })

  it('keeps legal rows when a nonpriced field has a partial deny', () => {
    const product = copy(imageProduct)
    product.capabilities.qualities = ['standard', 'high']
    product.capabilities.combination_rules = [{ deny: { quality: ['high'] } }]
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.18', currency: 'CNY', billing_mode: 'per_request' } }]
    const rows = buildPricingRules(product, ['resolution'], allowedSpecs(product.capabilities)!)
    expect(rows.map(row => row.match)).toEqual([{ resolution: ['1K'] }, { resolution: ['4K'] }])
    expect(rows.every(row => row.sale_price?.amount === '0.18')).toBe(true)
  })

  it('splits one image product into text and edit prices without multiplying by reference count', () => {
    const product = copy(imageProduct)
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.05', currency: 'CNY', billing_mode: 'per_request' } }]
    const specs = allowedSpecs(product.capabilities)!
    const split = splitCreationModePricing(product, ['resolution'], specs)
    expect(split).toHaveLength(4)
    expect(split.filter(rule => rule.match.references?.total_max === 0).map(rule => rule.sale_price?.amount)).toEqual(['0.05', '0.05'])
    expect(split.filter(rule => (rule.match.references?.image.min ?? 0) > 0).map(rule => rule.sale_price?.amount)).toEqual(['0.05', '0.05'])
    expect(split.every(rule => !rule.match.references || rule.match.references.total_max <= product.capabilities.references.total_max)).toBe(true)
    expect(mergeCreationModePricing({ ...product, pricing_rules: split })).toEqual(buildPricingRules(product, ['resolution'], specs))
  })

  it('keeps separate mode rows addressable for labels and expected counts', () => {
    const product = copy(imageProduct)
    product.capabilities.resolutions = ['2K', '4K']
    product.pricing_rules = [{ match: {}, sale_price: { amount: '0.05', currency: 'CNY', billing_mode: 'per_request' } }]
    const specs = allowedSpecs(product.capabilities)!
    const split = splitCreationModePricing(product, ['resolution'], specs)
    expect(split).toHaveLength(4)
    expect(split.map(rule => creationModeForRule(rule, product))).toEqual(['text', 'edit', 'text', 'edit'])
    const textPrices = split.filter(rule => creationModeForRule(rule, product) === 'text')
    const editPrices = split.filter(rule => creationModeForRule(rule, product) === 'edit')
    textPrices.forEach(rule => { rule.sale_price = { amount: '0.03', currency: 'CNY', billing_mode: 'per_request' } })
    editPrices.forEach(rule => { rule.sale_price = { amount: '0.08', currency: 'CNY', billing_mode: 'per_request' } })
    expect(textPrices.every(rule => rule.sale_price?.amount === '0.03')).toBe(true)
    expect(editPrices.every(rule => rule.sale_price?.amount === '0.08')).toBe(true)
  })
})

it('supports bounded thirty references without dropping matrix protections', () => {
  const c = copy(imageProduct).capabilities
  c.references = { image: { min: 0, max: 30 }, video: { min: 0, max: 10 }, audio: { min: 0, max: 10 }, total_max: 30 }
  c.count = {min: 1, max: 1}; c.resolutions = ['1K']; c.aspect_ratios = ['1:1']; c.qualities = []; c.durations_seconds = []
  const specs = allowedSpecs(c)!
  expect(specs.some(s => s.images === 20 && s.videos === 5 && s.audio === 5)).toBe(true)
  expect(specs.every(s => s.images + s.videos + s.audio <= 30)).toBe(true)
  c.durations_seconds = Array.from({length: 27}, (_, i) => i+4)
  expect(allowedSpecs(c)).toBeUndefined()
  c.durations_seconds = []; c.references.image.max = 31
  expect(allowedSpecs(c)).toBeUndefined()
})

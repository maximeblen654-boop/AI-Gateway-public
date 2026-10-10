import { describe, expect, it } from 'vitest'
import { allowedSpecs, buildPricingRules } from '../pricingMatrix'
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
})

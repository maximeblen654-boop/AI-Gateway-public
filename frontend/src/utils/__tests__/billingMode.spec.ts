import { describe, expect, it } from 'vitest'
import {
  accountBilledCost,
  BILLING_MODE_STUDIO_VIDEO_RETAIL,
  BILLING_MODE_IMAGE,
  BILLING_MODE_TOKEN,
  BILLING_MODE_VIDEO,
  getDisplayBillingMode,
  isImageUsage
} from '../billingMode'

describe('billingMode helpers', () => {
  it('does not turn unknown video procurement into the retail charge', () => {
    expect(accountBilledCost({ billing_mode: BILLING_MODE_STUDIO_VIDEO_RETAIL, total_cost: 12, account_stats_cost: null, account_rate_multiplier: 2 })).toBeUndefined()
    expect(accountBilledCost({ billing_mode: 'per_request', total_cost: 12, account_stats_cost: 3, account_rate_multiplier: 2 })).toBe(6)
    expect(accountBilledCost({ billing_mode: 'token', total_cost: 12, account_stats_cost: null, account_rate_multiplier: 2 })).toBe(24)
    expect(accountBilledCost({ billing_mode: 'image', total_cost: 12, account_stats_cost: 0, account_rate_multiplier: 2 })).toBe(0)
  })
  it('prefers explicit video mode over image_count', () => {
    expect(
      getDisplayBillingMode({ image_count: 1, billing_mode: BILLING_MODE_VIDEO })
    ).toBe(BILLING_MODE_VIDEO)
    expect(isImageUsage({ image_count: 1, billing_mode: BILLING_MODE_VIDEO })).toBe(false)
  })

  it('infers image when image_count set and mode missing', () => {
    expect(getDisplayBillingMode({ image_count: 2, billing_mode: null })).toBe(BILLING_MODE_IMAGE)
  })

  it('keeps token mode even with image_count', () => {
    expect(
      getDisplayBillingMode({ image_count: 1, billing_mode: BILLING_MODE_TOKEN })
    ).toBe(BILLING_MODE_TOKEN)
  })
})

import { expect, it } from 'vitest'
import { decimalUnits, estimateCost } from '../costCalculator'
const price = (amount: string, currency = 'CNY') => ({ amount, currency, billing_mode: 'per_request' })
it('distinguishes unknown trial inputs, explicit zero and invalid decimals', () => {
  for (const value of ['', '-1', '1e3', 'Infinity', 'NaN', '1.123456789', '1000000000000']) expect(decimalUnits(value)).toBeUndefined()
  expect(decimalUnits('0')).toBe(0n)
  expect(decimalUnits('0', true)).toBeUndefined()
  expect(estimateCost('', '1000', '8', price('1'))).toEqual({})
  expect(estimateCost('100', '1000', '', price('1')).cost).toBeUndefined()
  expect(estimateCost('100', '1000', '8', null).difference).toBeUndefined()
  expect(estimateCost('0', '1000', '8', price('1'))).toMatchObject({ cost: '0', difference: '1', margin: '100' })
  expect(estimateCost('100', '1000', '0', price('0'))).toMatchObject({ cost: '0', difference: '0', belowCost: false, margin: undefined })
})
it('keeps full trial precision through cost, profit and margin; never converts currencies', () => {
  expect(estimateCost('1', '3', '3', price('1'))).toMatchObject({ cost: '1', difference: '0', margin: '0' })
  expect(estimateCost('0.00000001', '100000000000', '1', price('0'))).toMatchObject({ belowCost: true, difference: '−<0.00000001' })
  expect(estimateCost('100', '1000', '8', price('0.70'))).toMatchObject({ perCredit: '0.1', cost: '0.8', difference: '−0.1', margin: '−14.28571429' })
  expect(estimateCost('100', '1000', '8', price('2', 'USD')).difference).toBeUndefined()
  expect(estimateCost('100', '0', '8', price('2'))).toEqual({})
})

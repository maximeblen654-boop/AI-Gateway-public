import type { PricingRule } from '@/api/admin/mediaWorkbench'
import { multiplyDecimalText } from './decimalText'

const scale = 100000000n
/** Fixed-point parsing. Empty and explicit zero are deliberately different. */
export function decimalUnits(value: string, positive = false): bigint | undefined {
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(value)) return undefined
  const [whole, fraction = ''] = value.split('.')
  const units = BigInt(whole!) * scale + BigInt(fraction.padEnd(8, '0'))
  return positive && units === 0n ? undefined : units
}
export function decimalError(value: string, positive = false): string {
  if (!value) return ''
  return decimalUnits(value, positive) === undefined ? `请填写${positive ? '大于 0' : '不小于 0'}的数字，最多 12 位整数、8 位小数。` : ''
}
export function ratioText(numerator: bigint, denominator: bigint): string {
  const sign = numerator < 0n ? '−' : ''
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = (magnitude * scale + denominator / 2n) / denominator
  if (magnitude && !rounded) return `${sign}<0.00000001`
  return sign + multiplyDecimalText(`${rounded / scale}.${(rounded % scale).toString().padStart(8, '0')}`, 1)
}
/** Independent trial amounts stay in fixed point until final display rounding. */
export function estimateCost(purchase: string, credits: string, consumption: string, price: PricingRule['sale_price']) {
  const p = decimalUnits(purchase), c = decimalUnits(credits, true), n = decimalUnits(consumption)
  if (p === undefined || c === undefined) return {}
  const perCredit = ratioText(p, c)
  if (n === undefined) return { perCredit }
  const cost = ratioText(p * n, c * scale)
  const sale = price?.currency === 'CNY' && price.billing_mode === 'per_request' ? decimalUnits(price.amount) : undefined
  if (sale === undefined) return { perCredit, cost }
  const difference = sale * c - p * n
  return { perCredit, cost, difference: ratioText(difference, c * scale), margin: sale > 0n ? ratioText(difference * 100n, sale * c) : undefined, belowCost: difference < 0n }
}

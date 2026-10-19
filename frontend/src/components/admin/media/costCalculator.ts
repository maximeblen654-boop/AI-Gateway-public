import type { PricingRule, Product } from '@/api/admin/mediaWorkbench'
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
/** Amounts stay in fixed point until the final display rounding. */
export function grossProfit(cost: PricingRule['sale_price'], price: PricingRule['sale_price']) {
  const amount = (value: PricingRule['sale_price']) => value?.currency === 'CNY' && value.billing_mode === 'per_request' ? decimalUnits(value.amount) : undefined
  const procurement = amount(cost), sale = price && /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(price.amount) ? amount(price) : undefined
  if (procurement === undefined || sale === undefined) return {}
  const difference = sale - procurement
  return { profit: ratioText(difference, scale), margin: sale > 0n ? ratioText(difference * 100n, sale) : undefined, belowCost: difference < 0n }
}
export function estimateCost(purchase: string, credits: string, consumption: string, price: PricingRule['sale_price']) {
  const p = decimalUnits(purchase, true), c = decimalUnits(credits, true), n = decimalUnits(consumption)
  if (p === undefined || c === undefined) return {}
  const perCredit = ratioText(p, c)
  if (n === undefined) return { perCredit }
  const cost = ratioText(p * n, c * scale)
  const sale = price?.currency === 'CNY' && price.billing_mode === 'per_request' ? decimalUnits(price.amount) : undefined
  if (sale === undefined) return { perCredit, cost }
  const difference = sale * c - p * n
  return { perCredit, cost, difference: ratioText(difference, c * scale), belowCost: difference < 0n }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
/** Never keyed by price, label or row index. A changed domain requires a fresh estimate. */
export function consumptionKey(product: Product, rule: PricingRule): string {
  const { count: _count, ...domain } = product.capabilities
  return JSON.stringify(canonical({ product: product.product_id, media: product.media_type, model: product.upstream_model, domain, match: rule.match }))
}
export interface CostMemory { version: 1; purchase: string; credits: string; consumption: Record<string, string> }
export const emptyCostMemory = (): CostMemory => ({ version: 1, purchase: '', credits: '', consumption: {} })
export function storageKey(adminId?: number, accountId?: number): string | undefined {
  return Number.isSafeInteger(adminId) && adminId! > 0 && Number.isSafeInteger(accountId) && accountId! > 0 ? `ai-gateway:cost:v1:${adminId}:${accountId}` : undefined
}
export function readCostMemory(raw: string | null): CostMemory {
  if (raw === null) return emptyCostMemory()
  if (raw.length > 256000) throw new Error('oversize')
  const value = JSON.parse(raw) as CostMemory
  const validText = (text: unknown) => typeof text === 'string' && (text === '' || decimalUnits(text) !== undefined)
  if (!value || value.version !== 1 || !validText(value.purchase) || !validText(value.credits) || !value.consumption || typeof value.consumption !== 'object' || Array.isArray(value.consumption) || Object.keys(value.consumption).length > 256 || !Object.entries(value.consumption).every(([key, text]) => key.length < 16000 && validText(text))) throw new Error('invalid')
  return { version: 1, purchase: value.purchase, credits: value.credits, consumption: Object.fromEntries(Object.entries(value.consumption)) }
}

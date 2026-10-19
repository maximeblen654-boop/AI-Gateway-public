import type { CostRule, Match, Product } from '@/api/admin/mediaWorkbench'
import { consumptionKey, decimalUnits, ratioText } from './costCalculator'
import { allowedSpecs, matchesSpec, pricingDimensions, type MatrixSpec } from './pricingMatrix'
import { costRows } from './procurementMatrix'

export const saleRows = (product: Product): Product['pricing_rules'] => product.pricing_rules.length ? product.pricing_rules : [{ match: {}, sale_price: null }]
export const matchKey = (match: Match): string => JSON.stringify(Object.fromEntries(Object.entries(match).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])))
export interface CostSpecRow {
  key: string; consumptionKey: string; match: Match; spec: MatrixSpec; specs: MatrixSpec[]
  costIndex?: number; priceIndex?: number; costCount: number; priceCount: number
  costConflict: boolean; priceConflict: boolean; label: string
}
function fullMatch(specs: MatrixSpec[]): Match {
  const first = specs[0]!
  const match = Object.fromEntries(pricingDimensions.filter(key => first[key] !== '' && first[key] !== 0).map(key => [key, [first[key]]])) as Match
  const range = (key: 'count' | 'images' | 'videos' | 'audio') => ({ min: Math.min(...specs.map(spec => spec[key])), max: Math.max(...specs.map(spec => spec[key])) })
  match.count = range('count')
  match.references = { image: range('images'), video: range('videos'), audio: range('audio'), total_max: Math.max(...specs.map(spec => spec.images + spec.videos + spec.audio)) }
  return match
}
function specLabel(specs: MatrixSpec[]): string {
  const spec = specs[0]!
  const parts = [spec.resolution, spec.aspect_ratio, spec.quality, spec.duration_seconds ? `${spec.duration_seconds} 秒` : ''].filter(Boolean)
  const values = (key: keyof MatrixSpec) => [...new Set(specs.map(value => value[key]))].join(' / ')
  parts.push(`数量 ${values('count')}`)
  if (specs.some(value => value.images || value.videos || value.audio)) parts.push(`参考图 ${values('images')} · 视频 ${values('videos')} · 音频 ${values('audio')}`)
  else parts.push('无参考素材')
  return parts.join(' · ')
}
/** Join through the legal domain; the two rule arrays remain independent and untouched. */
export function costSpecRows(product: Product): { rows: CostSpecRow[]; reason?: string } {
  const specs = allowedSpecs(product.capabilities)
  if (!specs?.length) return { rows: [], reason: '当前规格或组合限制尚不能安全展开，已保留原规则供高级编辑。' }
  if ([...costRows(product), ...saleRows(product)].some(rule => rule.match.output_formats?.length)) return { rows: [], reason: '历史规则含输出格式条件，简表无法完整表达，已保留高级规则。' }
  const costs = costRows(product), prices = saleRows(product)
  const groups = new Map<string, { specs: MatrixSpec[]; costs: number[]; prices: number[] }>()
  for (const spec of specs) {
    const costIndices = costs.flatMap((rule, index) => matchesSpec(rule.match, spec) ? [index] : [])
    const priceIndices = prices.flatMap((rule, index) => matchesSpec(rule.match, spec) ? [index] : [])
    // Missing rules may only be added for the exact shown domain, never a bounding
    // range that could also cover another row's reference/count conditions.
    const exact = !costIndices.length || !priceIndices.length ? [spec.count, spec.images, spec.videos, spec.audio] : []
    const key = JSON.stringify([pricingDimensions.map(key => spec[key]), exact, costIndices.map(index => matchKey(costs[index]!.match)).sort(), priceIndices.map(index => matchKey(prices[index]!.match)).sort()])
    const group = groups.get(key)
    if (group) group.specs.push(spec)
    else groups.set(key, { specs: [spec], costs: costIndices, prices: priceIndices })
    if (groups.size > 256) return { rows: [], reason: '合法规格超过简表显示范围，已保留全部高级规则，未截断或合并数据。' }
  }
  const rows = [...groups.values()].map(({ specs, costs, prices }) => {
    const match = fullMatch(specs)
    const key = consumptionKey(product, { match, sale_price: null })
    return { key, consumptionKey: key, match, spec: specs[0]!, specs, costIndex: costs.length === 1 ? costs[0] : undefined, priceIndex: prices.length === 1 ? prices[0] : undefined,
      costCount: 0, priceCount: 0, costConflict: costs.length > 1, priceConflict: prices.length > 1, label: specLabel(specs) }
  })
  for (const row of rows) {
    row.costCount = row.costIndex === undefined ? 0 : rows.filter(value => value.costIndex === row.costIndex).length
    row.priceCount = row.priceIndex === undefined ? 0 : rows.filter(value => value.priceIndex === row.priceIndex).length
  }
  return { rows }
}
export interface AmountSuggestion { amount: string; basis: string }
/** Infer only a single exact linear progression from at least three distinct, explicit duration samples. */
export function durationSuggestion(product: Product, row: CostSpecRow, kind: 'cost' | 'sale'): AmountSuggestion | undefined {
  if (product.media_type !== 'video' || !row.spec.duration_seconds) return undefined
  if (kind === 'cost' ? row.costConflict : row.priceConflict) return undefined
  const targetIndex = kind === 'cost' ? row.costIndex : row.priceIndex
  const rules = kind === 'cost' ? costRows(product) : saleRows(product)
  const target = targetIndex === undefined ? undefined : rules[targetIndex]
  // A shared destination may cover several durations; never infer one value for it.
  if (target && (target.match.duration_seconds?.length !== 1 || target.match.duration_seconds[0] !== row.spec.duration_seconds)) return undefined
  const simple = (match: Match) => !match.count && !match.references && !match.output_formats?.length && pricingDimensions.every(key => !match[key]?.length || match[key]!.length === 1)
  if (target && !simple(target.match)) return undefined
  const points = new Map<number, bigint>()
  for (const rule of rules) {
    const match = rule.match
    if (!simple(match) || match.duration_seconds?.length !== 1 || match.duration_seconds[0] === row.spec.duration_seconds) continue
    if (!pricingDimensions.filter(key => key !== 'duration_seconds').every(key => {
      const value = match[key]
      // An omitted dimension is safe only when it is also shared by the target.
      return target ? JSON.stringify(value ?? []) === JSON.stringify(target.match[key] ?? []) : !value?.length || value[0] === row.spec[key]
    })) continue
    if (kind === 'cost' && (rule as CostRule).source === 'calculator') continue
    const value = kind === 'cost' ? (rule as CostRule).cost : (rule as Product['pricing_rules'][number]).sale_price
    if (value?.currency !== 'CNY' || value.billing_mode !== 'per_request') continue
    if (kind === 'sale' && !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value.amount)) continue
    const units = decimalUnits(value.amount, kind === 'sale')
    if (units === undefined) continue
    const duration = match.duration_seconds[0]!
    const sampleSpec = { ...row.spec, duration_seconds: duration }
    if (!product.capabilities.durations_seconds.includes(duration) || !matchesSpec(match, sampleSpec) || product.capabilities.combination_rules.some(({ deny }) => matchesSpec(deny, sampleSpec))) continue
    // Even equal amounts cannot establish a unique pricing contract when rules overlap.
    if (rules.filter(other => matchesSpec(other.match, sampleSpec)).length !== 1) return undefined
    if (points.has(duration) && points.get(duration) !== units) return undefined
    points.set(duration, units)
  }
  if (points.size < 3) return undefined
  const samples = [...points].sort(([a], [b]) => a - b)
  const [x0, y0] = samples[0]!, [x1, y1] = samples[1]!
  const dx = BigInt(x1 - x0), dy = y1 - y0
  if (samples.some(([x, y]) => (y - y0) * dx !== dy * BigInt(x - x0))) return undefined
  const numerator = y0 * dx + dy * BigInt(row.spec.duration_seconds - x0)
  if (numerator < 0n || kind === 'sale' && numerator === 0n || numerator % dx !== 0n) return undefined
  const amount = ratioText(numerator, dx * 100000000n)
  if (decimalUnits(amount, kind === 'sale') === undefined) return undefined
  return { amount, basis: `同商品、其他规格条件相同的 ${points.size} 个已填写${kind === 'cost' ? '成本' : '售价'}，按时长呈一致线性变化（${samples.map(([seconds]) => `${seconds} 秒`).join('、')}）。` }
}

import type { CostRule, Match, Product } from '@/api/admin/mediaWorkbench'
import { allowedSpecs, matchesSpec, pricingDimensions, type PricingDimension } from './pricingMatrix'

export const maxCostRules = 100
export const costRows = (product: Product): CostRule[] => product.cost_rules?.length ? product.cost_rules : [{ match: {}, cost: null }]
export const costDimensions = (product: Product) => pricingDimensions.filter(key => costRows(product).some(rule => rule.match[key]?.length))
export const costLabel = (match: Match): string => {
  const labels: Record<PricingDimension, string> = { resolution: '分辨率', aspect_ratio: '比例', quality: '画质', duration_seconds: '时长' }
  const parts = pricingDimensions.flatMap(key => match[key]?.length ? [`${labels[key]} ${match[key]!.join(' / ')}${key === 'duration_seconds' ? ' 秒' : ''}`] : [])
  if (match.references) parts.push(`参考图 ${match.references.image.min}～${match.references.image.max} · 视频 ${match.references.video.min}～${match.references.video.max} · 音频 ${match.references.audio.min}～${match.references.audio.max}`)
  if (match.count) parts.push(`数量 ${match.count.min}～${match.count.max}`)
  return parts.join(' · ') || '统一采购成本（所有合法规格）'
}
/** Cost partitions deliberately depend on capabilities and cost rules, never sale tiers. */
export function buildCostRules(product: Product, dimensions: PricingDimension[], separateMode: boolean): CostRule[] | undefined {
  const specs = allowedSpecs(product.capabilities)
  if (!specs?.length) return undefined
  const groups = new Map<string, { match: Match; costs: (CostRule | undefined)[] }>()
  for (const spec of specs) {
    const match = Object.fromEntries(dimensions.filter(key => spec[key] !== '' && spec[key] !== 0).map(key => [key, [spec[key]]])) as Match
    if (separateMode) match.references = spec.images === 0
      ? { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }
      : { ...JSON.parse(JSON.stringify(product.capabilities.references)), image: { min: 1, max: product.capabilities.references.image.max } }
    const key = JSON.stringify(match)
    const old = costRows(product).filter(rule => matchesSpec(rule.match, spec))
    const group = groups.get(key) ?? { match, costs: [] }
    group.costs.push(old.length === 1 ? old[0] : undefined)
    groups.set(key, group)
    if (groups.size > maxCostRules) return undefined
  }
  return [...groups.values()].map(({ match, costs }) => {
    const first = costs[0]
    const consistent = costs.every(rule => JSON.stringify(rule?.cost ?? null) === JSON.stringify(first?.cost ?? null))
    return { match, cost: consistent ? first?.cost ?? null : null, ...(consistent && first?.source ? { source: first.source } : {}) }
  })
}

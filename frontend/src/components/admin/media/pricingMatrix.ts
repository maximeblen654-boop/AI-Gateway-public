import type { Match, Product, Range } from '@/api/admin/mediaWorkbench'

export const pricingDimensions = ['resolution', 'aspect_ratio', 'quality', 'duration_seconds'] as const
export type PricingDimension = typeof pricingDimensions[number]
export interface MatrixSpec {
  resolution: string; aspect_ratio: string; quality: string; duration_seconds: number
  count: number; images: number; videos: number; audio: number
}

const inside = (range: Range, value: number) => value >= range.min && value <= range.max
const validStrings = (values: string[]) => values.length <= 32 && new Set(values).size === values.length && values.every(value => value.length > 0 && value.trim() === value && value.length <= 128)
const validDurations = (values: number[]) => new Set(values).size === values.length && values.every(value => Number.isInteger(value) && value >= 1 && value <= 3600)
const subset = <T>(part: T[], all: T[]) => new Set(part).size === part.length && part.every(value => all.includes(value))
const insideRange = (range: Range, domain: Range) => Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= domain.min && range.max <= domain.max && range.max >= range.min
function validMatch(match: Match, capabilities: Product['capabilities']): boolean {
  if (!subset(match.resolution ?? [], capabilities.resolutions) || !subset(match.aspect_ratio ?? [], capabilities.aspect_ratios) || !subset(match.quality ?? [], capabilities.qualities) || !subset(match.duration_seconds ?? [], capabilities.durations_seconds)) return false
  if (match.count && !insideRange(match.count, capabilities.count)) return false
  const references = match.references
  return !references || insideRange(references.image, capabilities.references.image) && insideRange(references.video, capabilities.references.video) && insideRange(references.audio, capabilities.references.audio) && references.total_max >= references.image.min + references.video.min + references.audio.min && references.total_max <= capabilities.references.total_max
}
export function matchesSpec(match: Match, spec: MatrixSpec): boolean {
  if (!pricingDimensions.every(key => !match[key]?.length || (match[key] as (string | number)[]).includes(spec[key]))) return false
  if (match.count && !inside(match.count, spec.count)) return false
  const refs = match.references
  return !refs || inside(refs.image, spec.images) && inside(refs.video, spec.videos) && inside(refs.audio, spec.audio) && spec.images + spec.videos + spec.audio <= refs.total_max
}

// Mirror validator.go's bounded spec domain only; prices and publication remain server-authoritative.
export function allowedSpecs(c: Product['capabilities']): MatrixSpec[] | undefined {
  const ranges = [c.count, c.references.image, c.references.video, c.references.audio]
  if (ranges.some((r, i) => !Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < (i ? 0 : 1) || r.max < r.min || r.max > (i ? 16 : 10))) return undefined
  if (!Number.isInteger(c.references.total_max) || c.references.total_max > 16 || c.references.total_max < ranges.slice(1).reduce((sum, r) => sum + r.min, 0)) return undefined
  if (!validStrings(c.resolutions) || !validStrings(c.aspect_ratios) || !validStrings(c.qualities) || !validDurations(c.durations_seconds)) return undefined
  if (c.durations_seconds.length > 32 || c.combination_rules.length > 100 || c.combination_rules.some(({ deny }) => !validMatch(deny, c))) return undefined
  // An empty deny is an unfinished editor row, rejected by the server too.
  if (c.combination_rules.some(({ deny }) => !pricingDimensions.some(key => deny[key]?.length) && !deny.count && !deny.references)) return undefined
  const choices = <T>(values: T[], empty: T) => values.length ? values : [empty]
  const numbers = (r: Range) => Array.from({ length: r.max - r.min + 1 }, (_, i) => r.min + i)
  const domains = {
    resolution: choices(c.resolutions, ''), aspect_ratio: choices(c.aspect_ratios, ''),
    quality: choices(c.qualities, ''), duration_seconds: choices(c.durations_seconds, 0),
    count: numbers(c.count), images: numbers(c.references.image), videos: numbers(c.references.video), audio: numbers(c.references.audio)
  }
  if (Object.values(domains).reduce((size, values) => size * values.length, 1) > 32768) return undefined
  let rows: Partial<MatrixSpec>[] = [{}]
  for (const [key, values] of Object.entries(domains)) rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })))
  return (rows as MatrixSpec[]).filter(spec => spec.images + spec.videos + spec.audio <= c.references.total_max && !c.combination_rules.some(rule => matchesSpec(rule.deny, spec)))
}

export function dimensionsFor(product: Product): PricingDimension[] {
  return pricingDimensions.filter(key => product.pricing_rules.some(rule => rule.match[key]?.length))
}
function samePrice(left: Product['pricing_rules'][number]['sale_price'], right: Product['pricing_rules'][number]['sale_price']) {
  return left === right || !!left && !!right && left.amount === right.amount && left.currency === right.currency && left.billing_mode === right.billing_mode
}
export function buildPricingRules(product: Product, dimensions: PricingDimension[], specs: MatrixSpec[]): Product['pricing_rules'] {
  const rows = new Map<string, { match: Match; specs: MatrixSpec[] }>()
  for (const spec of specs) {
    const match = Object.fromEntries(dimensions.filter(key => spec[key] !== '' && spec[key] !== 0).map(key => [key, [spec[key]]])) as Match
    const key = JSON.stringify(match)
    const row = rows.get(key)
    if (row) row.specs.push(spec)
    else rows.set(key, { match, specs: [spec] })
  }
  return [...rows.values()].map(({ match, specs }) => {
    const prices = specs.map(spec => {
      const old = product.pricing_rules.filter(rule => matchesSpec(rule.match, spec))
      return old.length === 1 ? old[0]!.sale_price : null
    })
    return { match, sale_price: prices.every(price => samePrice(price, prices[0]!)) ? prices[0]! : null }
  })
}


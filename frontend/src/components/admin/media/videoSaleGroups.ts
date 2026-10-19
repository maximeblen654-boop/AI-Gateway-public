import type { Match, Product, PricingRule } from '@/api/admin/mediaWorkbench'
import { allowedSpecs, matchesSpec, type MatrixSpec } from './pricingMatrix'
import { decimalUnits, ratioText } from './costCalculator'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function videoGroupKey(match: Match): string {
  const { resolution: _r, duration_seconds: _d, ...rest } = match
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))))
}
// Partition only dimensions whose rule membership differs. This keeps shared
// conditions compact, but aligns different duration-specific partitions safely.
export function videoGroups(product: Product, resolution: string) {
  const specs = allowedSpecs(product.capabilities)?.filter(s => s.resolution === resolution)
  if (!specs) return undefined
  const rules = product.pricing_rules.filter(rule => !rule.match.resolution?.length || rule.match.resolution.includes(resolution))
  const cells = new Map<string, Match>()
  const membersByCell = new Map<string, Map<number, MatrixSpec[]>>()
  let visibleRows = 0
  function values<T extends string | number>(domain: T[], selected: T, read: (match: Match) => T[] | undefined): T[] {
    const signature = (value: T) => rules.map(rule => !read(rule.match)?.length || read(rule.match)!.includes(value)).join(',')
    return domain.filter(value => signature(value) === signature(selected))
  }
  for (const spec of specs) {
    const match: Match = {}
    for (const key of ['aspect_ratio', 'quality'] as const) if (rules.some(rule => rule.match[key]?.length)) match[key] = values(product.capabilities[key === 'quality' ? 'qualities' : 'aspect_ratios'], spec[key], m => m[key])
    if (rules.some(rule => rule.match.count)) match.count = { min: spec.count, max: spec.count }
    if (rules.some(rule => rule.match.references)) {
      const refs = product.capabilities.references
      const exact = rules.some(rule => rule.match.references && rule.match.references.total_max < refs.total_max)
      const range = (key: 'image' | 'video' | 'audio', selected: number) => {
        if (exact) return { min: selected, max: selected }
        const domain = Array.from({ length: refs[key].max - refs[key].min + 1 }, (_, i) => refs[key].min + i)
        const signature = (n: number) => rules.map(rule => !rule.match.references || n >= rule.match.references[key].min && n <= rule.match.references[key].max).join(',')
        const matching = domain.filter(n => signature(n) === signature(selected))
        // Separate disjoint intervals even if their rule membership is equal.
        let min = selected, max = selected
        while (matching.includes(min - 1)) min--
        while (matching.includes(max + 1)) max++
        return { min, max }
      }
      match.references = { image: range('image', spec.images), video: range('video', spec.videos), audio: range('audio', spec.audio), total_max: refs.total_max }
    }
    const key = videoGroupKey(match)
    cells.set(key, match)
    if (!membersByCell.has(key)) membersByCell.set(key, new Map())
    const durations = membersByCell.get(key)!
    if (!durations.has(spec.duration_seconds)) {
      if (++visibleRows > 1024) return undefined
      durations.set(spec.duration_seconds, [])
    }
    durations.get(spec.duration_seconds)!.push(spec)
  }
  return [...cells].map(([key, match]) => ({ key, match, rows: [...product.capabilities.durations_seconds].sort((a, b) => a - b).flatMap(duration => {
    const members = membersByCell.get(key)?.get(duration) ?? []
    if (!members.length) return []
    const matched = members.map(spec => rules.filter(rule => matchesSpec(rule.match, spec)))
    const prices = matched.map(rows => rows.length === 1 ? rows[0]!.sale_price : null)
    const ambiguous = matched.some(rows => rows.length > 1) || prices.some(price => JSON.stringify(price) !== JSON.stringify(prices[0]))
    return [{ duration, price: ambiguous ? null : prices[0]!, ambiguous }]
  }) })).filter(group => group.rows.length)
}

/** Subtract the exact edited cell; retain each untouched part of a shared rule. */
export function setVideoSale(product: Product, resolution: string, group: Match, duration: number, amount: string): Product {
  const next = clone(product)
  const target: Match = { ...clone(group), resolution: [resolution], duration_seconds: [duration] }
  const specs = allowedSpecs(product.capabilities)
  if (!specs) throw new Error('请先修正规格范围。')
  const targetSpecs = specs.filter(spec => matchesSpec(target, spec))
  if (!targetSpecs.length) throw new Error('此规格不在合法售价范围内，未修改草稿。')
  const rules: PricingRule[] = []
  const appendRemainder = (rule: PricingRule) => { if (specs.some(spec => matchesSpec(rule.match, spec))) rules.push(rule) }
  for (const rule of next.pricing_rules) {
    if (!targetSpecs.some(spec => matchesSpec(rule.match, spec))) { rules.push(rule); continue }
    let rest = clone(rule.match)
    for (const key of ['resolution', 'duration_seconds', 'aspect_ratio', 'quality'] as const) {
      const domain = key === 'resolution' ? product.capabilities.resolutions : key === 'duration_seconds' ? product.capabilities.durations_seconds : key === 'aspect_ratio' ? product.capabilities.aspect_ratios : product.capabilities.qualities
      const original = (rest[key]?.length ? rest[key] : domain) as (string | number)[]
      const selection = (target[key]?.length ? target[key] : domain) as (string | number)[]
      const outside = original.filter(value => !selection.includes(value))
      if (outside.length) appendRemainder({ ...clone(rule), match: { ...clone(rest), [key]: outside } })
      rest = { ...rest, [key]: original.filter(value => selection.includes(value)) }
    }
    if (target.count) {
      const old = rest.count ?? product.capabilities.count, chosen = target.count
      if (old.min < chosen.min) appendRemainder({ ...clone(rule), match: { ...clone(rest), count: { min: old.min, max: chosen.min - 1 } } })
      if (old.max > chosen.max) appendRemainder({ ...clone(rule), match: { ...clone(rest), count: { min: chosen.max + 1, max: old.max } } })
      rest.count = { min: Math.max(old.min, chosen.min), max: Math.min(old.max, chosen.max) }
    }
    if (target.references) {
      rest.references = clone(rest.references ?? product.capabilities.references)
      for (const key of ['image', 'video', 'audio'] as const) {
        const old = rest.references[key], chosen = target.references[key]
        if (old.min < chosen.min) { const outside = clone(rest); outside.references![key] = { min: old.min, max: chosen.min - 1 }; appendRemainder({ ...clone(rule), match: outside }) }
        if (old.max > chosen.max) { const outside = clone(rest); outside.references![key] = { min: chosen.max + 1, max: old.max }; appendRemainder({ ...clone(rule), match: outside }) }
        rest.references[key] = { min: Math.max(old.min, chosen.min), max: Math.min(old.max, chosen.max) }
      }
    }
  }
  rules.push({ match: target, sale_price: amount ? { amount, currency: 'CNY', billing_mode: 'per_request' } : null })
  if (rules.length > 1024) throw new Error('视频售价规则最多 1024 条；本次修改未应用，请减少独立售价分组。')
  next.pricing_rules = rules
  return next
}

export function arithmeticFill(rows: { duration: number; price: PricingRule['sale_price'] }[]) {
  const first = decimalUnits(rows[0]?.price?.amount ?? '', true), second = decimalUnits(rows[1]?.price?.amount ?? '', true)
  if (first === undefined || second === undefined) throw new Error('请先填写当前组前两档的有效售价。')
  const delta = second - first
  const changes = rows.flatMap((row, index) => {
    if (index < 2 || row.price?.amount) return []
    const units = first + BigInt(index) * delta
    const amount = ratioText(units, 100000000n)
    if (units <= 0n || decimalUnits(amount, true) === undefined) throw new Error(`${row.duration} 秒的建议售价不符合正售价与精度要求，本批次未应用。`)
    return [{ duration: row.duration, amount }]
  })
  return { delta: ratioText(delta, 100000000n), changes, retained: rows.filter(row => !!row.price?.amount).length }
}

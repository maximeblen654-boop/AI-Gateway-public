import type { StudioOffer, StudioSpecMatch } from '@/api/studioMedia'

export interface RatioSelection { resolution: string; quality: string; count: number; images: number; videos: number; audio: number; output_format?: string }
export function ratioValue(value: string): number {
  const match = /^(\d+):(\d+)$/.exec(value)
  if (!match) return NaN
  const width = Number(match[1]), height = Number(match[2])
  return width > 0 && height > 0 && width <= 32768 && height <= 32768 ? width / height : NaN
}
function matches(match: StudioSpecMatch, selected: RatioSelection, ratio: string): boolean {
  const values: Record<string, string | number> = { resolution: selected.resolution, quality: selected.quality, duration_seconds: 0, aspect_ratio: ratio }
  for (const key of ['resolution', 'quality', 'duration_seconds', 'aspect_ratio'] as const) {
    const allowed = match[key] as (string | number)[] | undefined
    if (allowed?.length && !allowed.includes(values[key]!)) return false
  }
  if (match.count && (selected.count < match.count.min || selected.count > match.count.max)) return false
  const refs = match.references
  if (refs && (selected.images < refs.image.min || selected.images > refs.image.max || selected.videos < refs.video.min || selected.videos > refs.video.max || selected.audio < refs.audio.min || selected.audio > refs.audio.max || selected.images + selected.videos + selected.audio > refs.total_max)) return false
  return true
}

// A UI convenience only: the selected exact offer and spec still go through Core quotation.
export function ratioOfferOptions(current: StudioOffer | undefined, offers: StudioOffer[], selected: RatioSelection): Map<string, StudioOffer> {
  const result = new Map<string, StudioOffer>()
  if (!current) return result
  const candidates = offers.filter(item => item.offer_id === current.offer_id || Boolean(current.product_scope && item.product_scope === current.product_scope && item.model === current.model && item.upstream_model === current.upstream_model))
  const grouped = new Map<string, StudioOffer[]>()
  for (const item of candidates) {
    if (selected.output_format && !item.spec.output_formats?.includes(selected.output_format as 'png' | 'jpeg' | 'webp')) continue
    for (const ratio of item.spec.aspect_ratio || []) {
      // Keep this offer's published choices visible while required references are still being added.
      // Crossing to another price offer requires a fully matching selection; quotation remains authoritative.
      if (!ratio || (item.offer_id !== current.offer_id && !matches(item.spec, selected, ratio)) || item.excluded?.some(rule => matches(rule, selected, ratio))) continue
      const group = grouped.get(ratio) || []
      if (!group.some(other => other.offer_id === item.offer_id)) group.push(item)
      grouped.set(ratio, group)
    }
  }
  for (const [ratio, group] of [...grouped].sort((a, b) => ratioValue(a[0]) - ratioValue(b[0]))) {
    const original = group.find(item => item.offer_id === current.offer_id)
    if (original || group.length === 1) result.set(ratio, original || group[0]!)
  }
  return result
}

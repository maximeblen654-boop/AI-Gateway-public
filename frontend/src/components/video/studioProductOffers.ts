import type { StudioOffer, StudioSpecMatch } from '@/api/studioMedia'

/** A catalog scope binds Account, Product, publication and media type on Core. */
export function productOfferKey(offer: StudioOffer): string {
  return JSON.stringify(offer.product_scope
    ? [offer.product_scope, offer.model, offer.upstream_model, offer.input_mode || '']
    : ['offer', offer.offer_id])
}
export function relatedProductOffers(current: StudioOffer, offers: StudioOffer[]): StudioOffer[] {
  const key = productOfferKey(current)
  return offers.filter(offer => productOfferKey(offer) === key)
}
export interface ProductOfferGroup { key: string; selected: StudioOffer; offers: StudioOffer[] }
export function groupProductOffers(offers: StudioOffer[], selectedId: string): ProductOfferGroup[] {
  const groups = new Map<string, ProductOfferGroup>()
  for (const offer of offers) {
    const key = productOfferKey(offer), group = groups.get(key)
    if (!group) groups.set(key, { key, selected: offer, offers: [offer] })
    else { group.offers.push(offer); if (offer.offer_id === selectedId) group.selected = offer }
  }
  return [...groups.values()]
}

export interface OfferSelection {
  resolution: string; aspect_ratio: string; quality: string; duration_seconds: number
  count: number; images: number; videos: number; audio: number; output_format?: string
}
export type OfferDimension = 'resolution' | 'aspect_ratio' | 'quality' | 'duration_seconds' | 'count'
export function productDimensionValues(current: StudioOffer | undefined, offers: StudioOffer[], dimension: OfferDimension): (string | number)[] {
  if (!current) return []
  const values = relatedProductOffers(current, offers).flatMap<string | number>(offer => {
    const range = offer.spec.count
    return dimension === 'count'
      ? Number.isInteger(range.min) && Number.isInteger(range.max) && range.min > 0 && range.max <= 10 && range.max >= range.min
        ? Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i) : []
      : offer.spec[dimension] || []
  })
  return [...new Set(values)]
}
function matchesRule(rule: StudioSpecMatch, selected: OfferSelection): boolean {
    for (const key of ['resolution', 'aspect_ratio', 'quality', 'duration_seconds'] as const) {
      const allowed = rule[key] as (string | number)[] | undefined
      if (allowed?.length && !allowed.includes(selected[key])) return false
    }
    if (rule.output_formats?.length && (!selected.output_format || !rule.output_formats.includes(selected.output_format as 'png' | 'jpeg' | 'webp'))) return false
    if (rule.count && (selected.count < rule.count.min || selected.count > rule.count.max)) return false
    const refs = rule.references
    return !refs || (selected.images >= refs.image.min && selected.images <= refs.image.max && selected.videos >= refs.video.min && selected.videos <= refs.video.max && selected.audio >= refs.audio.min && selected.audio <= refs.audio.max && selected.images + selected.videos + selected.audio <= refs.total_max)
}
function matches(offer: StudioOffer, selected: OfferSelection, allowIncompleteReferences = false): boolean {
  // Automatic output deliberately omits output_format from the generation contract.
  const spec = { ...offer.spec, output_formats: undefined }
  if (allowIncompleteReferences) spec.references = { ...spec.references, image: { ...spec.references.image, min: 0 }, video: { ...spec.references.video, min: 0 }, audio: { ...spec.references.audio, min: 0 } }
  // Legacy catalogs have no product identity and cannot select a sibling price rule.
  if (allowIncompleteReferences && !offer.product_scope) return matchesRule({ references: spec.references }, selected)
  if (selected.output_format && !offer.spec.output_formats?.includes(selected.output_format as 'png' | 'jpeg' | 'webp')) return false
  return matchesRule(spec, selected) && !offer.excluded?.some(rule => matchesRule(rule, selected))
}
/** Input types follow compatible published siblings; reference exclusions are checked at admission. */
export function productReferenceOffers(current: StudioOffer, offers: StudioOffer[], selected: OfferSelection): StudioOffer[] {
  return relatedProductOffers(current, offers).filter(offer => {
    if (!current.product_scope) return true
    if (selected.output_format && !offer.spec.output_formats?.includes(selected.output_format as 'png' | 'jpeg' | 'webp')) return false
    return matchesRule({ ...offer.spec, references: undefined, output_formats: undefined }, selected) && !offer.excluded?.some(rule => !rule.references && matchesRule(rule, selected))
  })
}
/** Pending inputs may be below a minimum, but their complete batch must fit one Offer. */
export function supportsProductReferences(current: StudioOffer, offers: StudioOffer[], selected: OfferSelection): boolean {
  return relatedProductOffers(current, offers).some(offer => matches(offer, selected, true))
}
export function resolveProductOffer(current: StudioOffer, offers: StudioOffer[], selected: OfferSelection): StudioOffer | undefined {
  const candidates = relatedProductOffers(current, offers).filter(offer => matches(offer, selected))
  return candidates.find(offer => offer.offer_id === current.offer_id) || (candidates.length === 1 ? candidates[0] : undefined)
}

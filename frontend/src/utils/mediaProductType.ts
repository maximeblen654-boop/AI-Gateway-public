import type { Product } from '@/api/admin/mediaWorkbench'

/** Called only for an explicit type change. Price reconciliation belongs to the product editor. */
export function mediaProductForType(product: Product, mediaType: string): Product {
  const next: Product = JSON.parse(JSON.stringify(product))
  if (mediaType === product.media_type || mediaType !== 'image' && mediaType !== 'video') return next
  next.media_type = mediaType
  next.capabilities.count = { min: 1, max: mediaType === 'video' ? 1 : 10 }
  if (mediaType === 'video') {
    next.capabilities.qualities = []
    delete next.capabilities.output_formats
    next.adapter_config.size_mappings = []
    delete next.adapter_config.execution
    delete next.adapter_config.edit_execution
    delete next.adapter_config.model_family
    if (!next.adapter_config.wire_profile) delete next.adapter_config.version
    next.capabilities.combination_rules = next.capabilities.combination_rules
      .filter(({ deny }) => !deny.quality?.length && !deny.output_formats?.length && (!deny.count || deny.count.min <= 1 && deny.count.max >= 1))
      .map(rule => ({ ...rule, deny: { ...rule.deny, ...(rule.deny.count ? { count: { min: 1, max: 1 } } : {}) } }))
  } else {
    next.capabilities.durations_seconds = []
    next.capabilities.references.video = { min: 0, max: 0 }
    next.capabilities.references.audio = { min: 0, max: 0 }
    next.capabilities.references.total_max = Math.min(next.capabilities.references.total_max, next.capabilities.references.image.max)
    delete next.adapter_config.wire_profile
    delete (next.adapter_config as Product['adapter_config'] & { image2pro?: unknown }).image2pro
    if (!next.adapter_config.model_family) delete next.adapter_config.version
    next.capabilities.combination_rules = next.capabilities.combination_rules
      .filter(({ deny }) => !deny.duration_seconds?.length && !deny.references?.video.min && !deny.references?.audio.min)
      .map(rule => {
        if (!rule.deny.references) return rule
        // Zero video/audio inputs still match optional ranges from the old
        // video rule. Intersect with the image domain to preserve that rule's
        // meaning instead of broadening it or leaving an invalid hidden range.
        return { ...rule, deny: { ...rule.deny, references: { ...rule.deny.references, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: Math.min(rule.deny.references.total_max, next.capabilities.references.total_max) } } }
      })
  }
  return next
}

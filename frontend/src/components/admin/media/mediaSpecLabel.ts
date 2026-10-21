import type { Match } from '@/api/admin/mediaWorkbench'
import { pricingDimensions, type PricingDimension } from './pricingMatrix'

export const mediaSpecLabel = (match: Match): string => {
  const labels: Record<PricingDimension, string> = { resolution: '分辨率', aspect_ratio: '比例', quality: '画质', duration_seconds: '时长' }
  const parts = pricingDimensions.flatMap(key => match[key]?.length ? [`${labels[key]} ${match[key]!.join(' / ')}${key === 'duration_seconds' ? ' 秒' : ''}`] : [])
  if (match.output_formats?.length) parts.push(`输出格式 ${match.output_formats.join(' / ')}`)
  if (match.references) parts.push(`参考图 ${match.references.image.min}～${match.references.image.max} · 视频 ${match.references.video.min}～${match.references.video.max} · 音频 ${match.references.audio.min}～${match.references.audio.max}`)
  if (match.count) parts.push(`数量 ${match.count.min}～${match.count.max}`)
  return parts.join(' · ') || '统一售价（所有合法规格）'
}

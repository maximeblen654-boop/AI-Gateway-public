export const BILLING_MODE_TOKEN = 'token'
export const BILLING_MODE_PER_REQUEST = 'per_request'
export const BILLING_MODE_IMAGE = 'image'
export const BILLING_MODE_VIDEO = 'video'
export const BILLING_MODE_STUDIO_VIDEO_RETAIL = 'studio_video_retail'

export function getBillingModeLabel(mode: string | null | undefined, t: (key: string) => string): string {
  switch (mode) {
    case BILLING_MODE_STUDIO_VIDEO_RETAIL:
    case BILLING_MODE_PER_REQUEST: return t('admin.usage.billingModePerRequest')
    case BILLING_MODE_IMAGE: return t('admin.usage.billingModeImage')
    case BILLING_MODE_VIDEO: return t('admin.usage.billingModeVideo')
    default: return t('admin.usage.billingModeToken')
  }
}

export function getBillingModeBadgeClass(mode: string | null | undefined): string {
  switch (mode) {
    case BILLING_MODE_STUDIO_VIDEO_RETAIL:
    case BILLING_MODE_PER_REQUEST: return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
    case BILLING_MODE_IMAGE: return 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300'
    case BILLING_MODE_VIDEO: return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    default: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  }
}

interface ImageBillingRow {
  image_count: number
  billing_mode?: string | null
  total_cost: number
}

export function isImageUsage(row: Pick<ImageBillingRow, 'image_count' | 'billing_mode'> | null | undefined): boolean {
  return (row?.image_count ?? 0) > 0 && row?.billing_mode !== BILLING_MODE_TOKEN && row?.billing_mode !== BILLING_MODE_VIDEO
}

export function getDisplayBillingMode(row: Pick<ImageBillingRow, 'billing_mode' | 'image_count'> | null | undefined): string | null | undefined {
  // Explicit video/token modes always win over image_count heuristics.
  if (row?.billing_mode === BILLING_MODE_VIDEO || row?.billing_mode === BILLING_MODE_TOKEN) {
    return row.billing_mode
  }
  if ((row?.image_count ?? 0) > 0 && !row?.billing_mode) {
    return BILLING_MODE_IMAGE
  }
  return row?.billing_mode
}

export function imageUnitPrice(row: Pick<ImageBillingRow, 'image_count' | 'total_cost'> | null): number {
  if (!row || row.image_count <= 0) return 0
  const total = row.total_cost ?? 0
  const price = total / row.image_count
  return Number.isFinite(price) ? price : 0
}

/** Unknown procurement must not fall back to the customer's retail charge. */
export function accountBilledCost(row: { billing_mode?: string | null; total_cost?: number | null; account_stats_cost?: number | null; account_rate_multiplier?: number | null }): number | undefined {
  if (row.billing_mode === BILLING_MODE_STUDIO_VIDEO_RETAIL && row.account_stats_cost == null) return undefined
  const result = (row.account_stats_cost ?? row.total_cost ?? 0) * (row.account_rate_multiplier ?? 1)
  return Number.isNaN(result) ? 0 : result
}

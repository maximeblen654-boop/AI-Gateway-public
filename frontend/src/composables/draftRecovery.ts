import { draftInput, type Product, type SupplierDetail } from '@/api/admin/mediaWorkbench'

// Follow costCalculator's small, bounded JSON/localStorage pattern. This stores
// only one product's documented editable fields and optional removal intent,
// never an Account DTO.
const MAX_BYTES = 256000
export const MAX_ACCOUNT_RECOVERIES = 32
const validUUID = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)
export interface RecoveryIdentity { admin_id: number; account_id: number; product_id: string; site_model: string; upstream_model: string }
export interface DraftRecovery {
  version: 1; identity: RecoveryIdentity; base_record_version: number; base_draft_revision: string
  updated_at: number; copy_id: string; product: Product
  editor_id?: string
  new_product?: boolean
  removed_product?: boolean
  pending_submission?: { submission_id: string; base_record_version: number; product: Product }
}
export interface RecoveryEntry { key: string; raw: string; value: DraftRecovery }
export function recoveryKey(identity: RecoveryIdentity): string | undefined {
  if (![identity.admin_id, identity.account_id].every(n => Number.isSafeInteger(n) && n > 0) ||
      ![identity.product_id, identity.site_model, identity.upstream_model].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256)) return
  return `ai-gateway:media-draft:v1:${JSON.stringify([identity.admin_id, identity.account_id, identity.product_id, identity.site_model, identity.upstream_model])}`
}
export function recoveryCopyKey(identity: RecoveryIdentity, editorId: string): string | undefined {
  const base = recoveryKey(identity)
  return base && validUUID(editorId) ? `${base}:editor:${editorId}` : undefined
}
/** Bounded discovery also includes the previous single-copy format. It never
 * removes or rewrites another editor's data while enumerating. */
export function listDraftRecoveries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, adminId: number, accountId: number): { entries: RecoveryEntry[]; invalid: boolean } {
  const entries: RecoveryEntry[] = []
  let invalid = false
  if (storage.length > 2048) throw new Error('storage inventory too large')
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith('ai-gateway:media-draft:v1:')) continue
    try {
      const raw = storage.getItem(key)
      if (!raw || raw.length > MAX_BYTES) throw new Error('oversize')
      const identity = (JSON.parse(raw) as DraftRecovery).identity
      if (identity?.admin_id !== adminId || identity.account_id !== accountId) continue
      const value = readDraftRecovery(raw, identity)!
      if (key !== (value.editor_id ? recoveryCopyKey(identity, value.editor_id) : recoveryKey(identity))) throw new Error('key mismatch')
      if (entries.length >= 128) { invalid = true; continue }
      entries.push({ key, raw, value })
    } catch { invalid = true }
  }
  return { entries: entries.slice(0, 128).sort((a, b) => b.value.updated_at - a.value.updated_at || a.key.localeCompare(b.key)), invalid }
}
function bounded(value: unknown, depth = 0): boolean {
  if (depth > 14) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 16000
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 512 && value.every(v => bounded(v, depth + 1))
  return !!value && typeof value === 'object' && Object.keys(value).length <= 256 && Object.entries(value).every(([k, v]) => k.length <= 256 && bounded(v, depth + 1))
}
function validProduct(p: Product): boolean {
  const range = (r: { min: number; max: number }) => !!r && Number.isSafeInteger(r.min) && Number.isSafeInteger(r.max)
  const strings = (v: string[]) => Array.isArray(v) && v.every(x => typeof x === 'string')
  const refs = (v: Product['capabilities']['references']) => !!v && range(v.image) && range(v.video) && range(v.audio) && Number.isSafeInteger(v.total_max)
  const match = (v: Product['pricing_rules'][number]['match']) => !!v && typeof v === 'object' && !Array.isArray(v) &&
    [v.output_formats, v.resolution, v.aspect_ratio, v.quality].every(x => x === undefined || strings(x)) &&
    (v.duration_seconds === undefined || Array.isArray(v.duration_seconds) && v.duration_seconds.every(Number.isSafeInteger)) &&
    (v.count === undefined || range(v.count)) && (v.references === undefined || refs(v.references))
  const price = (v: Product['pricing_rules'][number]['sale_price']) => v === null || !!v && ['amount', 'currency', 'billing_mode'].every(k => typeof v[k as keyof typeof v] === 'string')
  const c = p?.capabilities
  return !!p && ['product_id', 'media_type', 'site_model', 'upstream_model', 'display_name'].every(k => typeof p[k as keyof Product] === 'string') && typeof p.enabled === 'boolean' &&
    !!c && [c.resolutions, c.aspect_ratios, c.qualities].every(strings) && (c.output_formats === undefined || strings(c.output_formats)) &&
    Array.isArray(c.durations_seconds) && c.durations_seconds.every(Number.isSafeInteger) && range(c.count) && refs(c.references) &&
    Array.isArray(c.combination_rules) && c.combination_rules.every(r => match(r.deny)) &&
    Array.isArray(p.pricing_rules) && p.pricing_rules.every(r => match(r.match) && price(r.sale_price)) &&
    (p.cost_rules === undefined || Array.isArray(p.cost_rules) && p.cost_rules.every(r => match(r.match) && price(r.cost) && (r.source === undefined || r.source === 'manual' || r.source === 'calculator'))) &&
    !!p.adapter_config && Array.isArray(p.adapter_config.size_mappings) && p.adapter_config.size_mappings.every(m => [m.resolution, m.aspect_ratio, m.wire_size].every(s => typeof s === 'string')) &&
    [p.adapter_config.execution, p.adapter_config.edit_execution].every(e => e === undefined || !!e && (e.mode === undefined || ['single', 'native_multi', 'provider_async'].includes(e.mode)) && (e.max_output_images === undefined || Number.isSafeInteger(e.max_output_images)) && (e.provider === undefined || typeof e.provider === 'string')) &&
    (p.adapter_config.version === undefined || Number.isSafeInteger(p.adapter_config.version)) && [p.adapter_config.wire_profile, p.adapter_config.model_family].every(s => s === undefined || typeof s === 'string')
}
export function readDraftRecovery(raw: string | null, identity: RecoveryIdentity): DraftRecovery | null {
  if (raw === null) return null
  if (raw.length > MAX_BYTES) throw new Error('oversize')
  const value = JSON.parse(raw) as DraftRecovery
  if (!bounded(value) || value.version !== 1 || recoveryKey(value.identity) !== recoveryKey(identity) || !recoveryKey(identity) ||
      !Number.isSafeInteger(value.base_record_version) || value.base_record_version < 0 || typeof value.base_draft_revision !== 'string' ||
      !Number.isSafeInteger(value.updated_at) || !validUUID(value.copy_id) || (value.editor_id !== undefined && !validUUID(value.editor_id)) || (value.new_product !== undefined && typeof value.new_product !== 'boolean') || (value.removed_product !== undefined && typeof value.removed_product !== 'boolean') || (value.removed_product === true && value.new_product === true) || !validProduct(value.product) || value.product.product_id !== identity.product_id ||
      (value.pending_submission !== undefined && (!/^[a-f0-9-]{36}$/i.test(value.pending_submission.submission_id) || !Number.isSafeInteger(value.pending_submission.base_record_version) || value.pending_submission.base_record_version < 0 || !validProduct(value.pending_submission.product) || value.pending_submission.product.product_id !== identity.product_id))) throw new Error('invalid')
  return { version: 1, identity, base_record_version: value.base_record_version, base_draft_revision: value.base_draft_revision,
    updated_at: value.updated_at, copy_id: value.copy_id, ...(value.editor_id ? { editor_id: value.editor_id } : {}), ...(value.new_product !== undefined ? { new_product: value.new_product } : {}), ...(value.removed_product !== undefined ? { removed_product: value.removed_product } : {}), product: draftInput([value.product]).products[0]!, ...(value.pending_submission ? { pending_submission: { submission_id: value.pending_submission.submission_id, base_record_version: value.pending_submission.base_record_version, product: draftInput([value.pending_submission.product]).products[0]! } } : {}) }
}
export function encodeDraftRecovery(value: DraftRecovery): string {
  const { admin_id, account_id, product_id, site_model, upstream_model } = value.identity
  const raw = JSON.stringify({ version: 1, identity: { admin_id, account_id, product_id, site_model, upstream_model }, base_record_version: value.base_record_version, base_draft_revision: value.base_draft_revision, updated_at: value.updated_at, copy_id: value.copy_id, ...(value.editor_id ? { editor_id: value.editor_id } : {}), ...(value.new_product !== undefined ? { new_product: value.new_product } : {}), ...(value.removed_product !== undefined ? { removed_product: value.removed_product } : {}), product: draftInput([value.product]).products[0], ...(value.pending_submission ? { pending_submission: { submission_id: value.pending_submission.submission_id, base_record_version: value.pending_submission.base_record_version, product: draftInput([value.pending_submission.product]).products[0] } } : {}) })
  readDraftRecovery(raw, value.identity)
  return raw
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
/** Explicit write whitelist plus Go's documented empty-list omission. Never
 * remove prices, costs, model identity or user-selected adapter settings. */
export function draftFingerprint(products: Product[]): string {
  const input = draftInput(products).products
  for (const p of input) {
    if (!p.cost_rules?.length) delete p.cost_rules
    for (const rule of [...p.pricing_rules, ...(p.cost_rules ?? []), ...p.capabilities.combination_rules.map(r => ({ match: r.deny }))]) {
      for (const key of ['output_formats', 'resolution', 'duration_seconds', 'aspect_ratio', 'quality'] as const) if (!rule.match[key]?.length) delete rule.match[key]
    }
  }
  return JSON.stringify(canonical(input))
}
/** Only defaults implemented by inheritNativeProduct may be added to an empty
 * adapter. Explicit model aliases and adapter selections remain significant. */
export function persistedFingerprint(products: Product[], dto: SupplierDetail): string {
  const input = draftInput(products).products
  for (const p of input) {
    if (p.upstream_model && p.site_model.startsWith('media-') && p.site_model === p.product_id) p.site_model = p.upstream_model
    const kind = dto.native_adapters?.[p.media_type]?.kind
    if (p.media_type === 'video' && !p.adapter_config.wire_profile && (kind === 'grok_video' || kind === 'seedance_video')) {
      p.adapter_config.version = 1; p.adapter_config.wire_profile = kind === 'grok_video' ? 'grok' : 'seedance'
    }
    if (p.media_type === 'video' && !p.adapter_config.wire_profile && kind === 'laoli_video') {
      const expected = p.capabilities.references.video.max > 0 || p.capabilities.references.audio.max > 0 ? 'inline_multimedia' : 'images'
      const persisted = dto.media_workbench_v1?.draft.products.find(item => item.product_id === p.product_id)?.adapter_config
      // The backend deliberately leaves legacy catalog products untouched. Add
      // this default only when its returned value is exactly the derived one.
      if (persisted?.version === 1 && persisted.wire_profile === expected) { p.adapter_config.version = 1; p.adapter_config.wire_profile = expected }
    }
    if (p.media_type === 'image' && !p.adapter_config.model_family && !p.adapter_config.wire_profile && ['grok_images', 'gemini_images', 'openai_images_oauth'].includes(kind ?? '')) {
      p.adapter_config.version = 1; p.adapter_config.model_family = kind
    }
  }
  return draftFingerprint(input)
}
export function recoveryDifferences(local: Product, server?: Product): { field: string; local: string; server: string }[] {
  const a = draftInput([local]).products[0]!, b = server ? draftInput([server]).products[0]! : undefined
  const differences: { field: string; local: string; server: string }[] = []
  const walk = (x: unknown, y: unknown, field: string) => {
    if (JSON.stringify(canonical(x)) === JSON.stringify(canonical(y))) return
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], field ? `${field}.${k}` : k)
    } else differences.push({ field, local: JSON.stringify(x) ?? '未配置', server: JSON.stringify(y) ?? '未配置' })
  }
  walk(a, b, '')
  return differences
}

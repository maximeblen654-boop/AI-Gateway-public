import { draftInput, type Product, type SupplierDetail } from '@/api/admin/mediaWorkbench'
import type { VideoSaleInput } from '@/components/admin/media/videoSaleGroups'

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
  video_sale_inputs?: VideoSaleInput[]
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
function validVideoInputs(inputs: DraftRecovery['video_sale_inputs'], product: Product): boolean {
  return inputs === undefined || product.media_type === 'video' && Array.isArray(inputs) && inputs.length <= 128 &&
    inputs.every(input => !!input && typeof input.resolution === 'string' && input.resolution.length > 0 && input.resolution.length <= 128 &&
      Number.isSafeInteger(input.duration) && input.duration > 0 && input.duration <= 3600 && typeof input.amount === 'string' && input.amount.length <= 128 &&
      typeof input.domain === 'string' && input.domain.length <= 16000) &&
    validProduct({ ...product, pricing_rules: inputs.map(input => ({ match: input.group, sale_price: input.source_price })) })
}
function inputPayload(inputs: VideoSaleInput[]): VideoSaleInput[] {
  const range = (value: { min: number; max: number }) => ({ min: value.min, max: value.max })
  return inputs.map(({ resolution, group, duration, amount, source_price, domain }) => ({ resolution, duration, amount, domain,
    group: {
      ...Object.fromEntries((['output_formats', 'resolution', 'duration_seconds', 'aspect_ratio', 'quality'] as const).filter(key => group[key] !== undefined).map(key => [key, [...group[key]!]])),
      ...(group.count ? { count: range(group.count) } : {}),
      ...(group.references ? { references: { image: range(group.references.image), video: range(group.references.video), audio: range(group.references.audio), total_max: group.references.total_max } } : {})
    },
    source_price: source_price === null ? null : { amount: source_price.amount, currency: source_price.currency, billing_mode: source_price.billing_mode }
  }))
}
export function readDraftRecovery(raw: string | null, identity: RecoveryIdentity): DraftRecovery | null {
  if (raw === null) return null
  if (raw.length > MAX_BYTES) throw new Error('oversize')
  const value = JSON.parse(raw) as DraftRecovery
  if (!bounded(value) || value.version !== 1 || recoveryKey(value.identity) !== recoveryKey(identity) || !recoveryKey(identity) ||
      !Number.isSafeInteger(value.base_record_version) || value.base_record_version < 0 || typeof value.base_draft_revision !== 'string' ||
      !Number.isSafeInteger(value.updated_at) || !validUUID(value.copy_id) || (value.editor_id !== undefined && !validUUID(value.editor_id)) || (value.new_product !== undefined && typeof value.new_product !== 'boolean') || (value.removed_product !== undefined && typeof value.removed_product !== 'boolean') || (value.removed_product === true && value.new_product === true) || !validProduct(value.product) || value.product.product_id !== identity.product_id ||
      !validVideoInputs(value.video_sale_inputs, value.product) ||
      (value.pending_submission !== undefined && (!/^[a-f0-9-]{36}$/i.test(value.pending_submission.submission_id) || !Number.isSafeInteger(value.pending_submission.base_record_version) || value.pending_submission.base_record_version < 0 || !validProduct(value.pending_submission.product) || value.pending_submission.product.product_id !== identity.product_id))) throw new Error('invalid')
  return { version: 1, identity, base_record_version: value.base_record_version, base_draft_revision: value.base_draft_revision,
    updated_at: value.updated_at, copy_id: value.copy_id, ...(value.editor_id ? { editor_id: value.editor_id } : {}), ...(value.new_product !== undefined ? { new_product: value.new_product } : {}), ...(value.removed_product !== undefined ? { removed_product: value.removed_product } : {}), ...(value.video_sale_inputs?.length ? { video_sale_inputs: inputPayload(value.video_sale_inputs) } : {}), product: draftInput([value.product]).products[0]!, ...(value.pending_submission ? { pending_submission: { submission_id: value.pending_submission.submission_id, base_record_version: value.pending_submission.base_record_version, product: draftInput([value.pending_submission.product]).products[0]! } } : {}) }
}
export function encodeDraftRecovery(value: DraftRecovery): string {
  const { admin_id, account_id, product_id, site_model, upstream_model } = value.identity
  const raw = JSON.stringify({ version: 1, identity: { admin_id, account_id, product_id, site_model, upstream_model }, base_record_version: value.base_record_version, base_draft_revision: value.base_draft_revision, updated_at: value.updated_at, copy_id: value.copy_id, ...(value.editor_id ? { editor_id: value.editor_id } : {}), ...(value.new_product !== undefined ? { new_product: value.new_product } : {}), ...(value.removed_product !== undefined ? { removed_product: value.removed_product } : {}), ...(value.video_sale_inputs?.length ? { video_sale_inputs: inputPayload(value.video_sale_inputs) } : {}), product: draftInput([value.product]).products[0], ...(value.pending_submission ? { pending_submission: { submission_id: value.pending_submission.submission_id, base_record_version: value.pending_submission.base_record_version, product: draftInput([value.pending_submission.product]).products[0] } } : {}) })
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
/** A receipt proves only its exact submitted payload, never newer local text. */
export function confirmedRecoveryProduct(value: DraftRecovery, dto: SupplierDetail): boolean {
  const c = dto.media_workbench_v1, receipt = c?.draft.save_receipt, pending = value.pending_submission
  const server = c?.draft.products.find(p => p.product_id === value.identity.product_id)
  return !value.removed_product && !value.video_sale_inputs?.length && !!receipt && !!pending && !!server &&
    dto.id === value.identity.account_id && server.site_model === value.identity.site_model && server.upstream_model === value.identity.upstream_model &&
    server.media_type === value.product.media_type && receipt.submission_id === pending.submission_id && receipt.base_record_version === pending.base_record_version &&
    c!.record_version > pending.base_record_version && receipt.draft_revision === c!.draft.revision &&
    persistedFingerprint([pending.product], dto) === draftFingerprint([server]) && persistedFingerprint([value.product], dto) === draftFingerprint([server])
}
const recoveryLabels: Record<string, string> = {
  display_name: '商品名称', enabled: '商品启用状态', site_model: '站点模型', upstream_model: '上游模型', media_type: '媒体类型', product_id: '商品标识',
  pricing_rules: '售价', cost_rules: '采购成本', 'capabilities.resolutions': '分辨率', 'capabilities.aspect_ratios': '画面比例',
  'capabilities.qualities': '画质', 'capabilities.durations_seconds': '视频时长', 'capabilities.output_formats': '图片输出格式',
  'capabilities.count.min': '最少生成数量', 'capabilities.count.max': '最多生成数量', 'capabilities.references.total_max': '参考素材合计上限',
  'capabilities.combination_rules': '不可用的规格组合', 'adapter_config.size_mappings': '画幅尺寸映射',
  'adapter_config.wire_profile': '适配器请求协议', 'adapter_config.model_family': '适配器模型类型', 'adapter_config.version': '适配器配置版本'
}
function differenceLabel(field: string): string {
  const reference = /^capabilities\.references\.(image|video|audio)\.(min|max)$/.exec(field)
  if (reference) return `${({ image: '参考图片', video: '参考视频', audio: '参考音频' } as Record<string,string>)[reference[1]!]}${reference[2] === 'min' ? '下限' : '上限'}`
  return recoveryLabels[field] ?? (field.startsWith('adapter_config.') ? '适配器设置' : '其他商品设置')
}
function differenceValue(value: unknown, field: string): string {
  if (value === undefined || value === null) return '未配置'
  if (typeof value === 'boolean') return value ? '已启用' : '未启用'
  if (Array.isArray(value)) {
    if (!value.length) return '未配置'
    if (field === 'pricing_rules' || field === 'cost_rules') {
      const previews = value.slice(0, 3).map(rule => {
        const match = rule.match ?? {}, price = rule.sale_price ?? rule.cost
        const specs = [match.resolution?.join('/'), match.aspect_ratio?.join('/'), match.quality?.join('/'), match.duration_seconds?.map((v: number) => `${v}秒`).join('/')].filter(Boolean).join(' · ') || '共享规格'
        return `${specs}：${price ? `${price.amount} ${price.currency}` : '尚未填写'}`
      })
      return `共${value.length}条；${previews.join('；')}${value.length > 3 ? '…' : ''}`.slice(0, 180)
    }
    if (value.every(item => ['string', 'number'].includes(typeof item))) return value.map(item => field === 'capabilities.durations_seconds' ? `${item}秒` : String(item)).join('、').slice(0, 180)
    return `共${value.length}项配置`
  }
  if (typeof value === 'object') return field === '' ? `商品：${String((value as Product).display_name || '未命名').slice(0, 100)}` : `已配置${Object.keys(value).length}项设置`
  const text = String(value)
  return text.length > 180 ? `${text.slice(0, 179)}…` : text
}
function differencePair(a: unknown, b: unknown, field: string): { local: string; server: string } {
  let local = differenceValue(a, field), server = differenceValue(b, field)
  if (local === server && typeof a === 'string' && typeof b === 'string' && a !== b) {
    let at = 0
    while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++
    local = `…${a.slice(Math.max(0, at - 20), at + 60)}`
    server = `…${b.slice(Math.max(0, at - 20), at + 60)}`
  }
  return { local, server }
}
/** Show the changed leaves, not the first (possibly unchanged) rows. */
function objectArrayDifference(local: unknown, server: unknown): { local: string; server: string } {
  const changes: { name: string; local: string; server: string }[] = []
  const names: Record<string,string> = { amount: '金额', currency: '币种', billing_mode: '计费方式', resolution: '分辨率', aspect_ratio: '画面比例', duration_seconds: '时长', quality: '画质', output_formats: '图片格式', wire_size: '请求尺寸', source: '成本来源', min: '下限', max: '上限', total_max: '素材合计上限' }
  const scan = (a: unknown, b: unknown, parts: string[]) => {
    if (changes.length >= 4 || JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) return
    if (a && typeof a === 'object' || b && typeof b === 'object') {
      const x = (a ?? {}) as Record<string, unknown>, y = (b ?? {}) as Record<string, unknown>
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) scan(x[k], y[k], [...parts, k])
      return
    }
    const row = /^\d+$/.test(parts[0] ?? '') ? `第${Number(parts[0]) + 1}条` : '设置'
    const key = [...parts].reverse().find(part => names[part])
    changes.push({ name: `${row}·${key ? names[key] : '内容'}`, ...differencePair(a, b, '') })
  }
  scan(local, server, [])
  const summary = (side: 'local' | 'server') => changes.slice(0,3).map(change => `${change.name}：${change[side]}`).join('；').slice(0,175) + (changes.length > 3 ? '…' : '')
  return {local:summary('local'),server:summary('server')}
}
export function recoveryDifferences(local: Product, server?: Product): { field: string; label: string; local: string; server: string }[] {
  // Use the same documented omission rules as save confirmation. An empty
  // optional match array alone is not an unsaved business change.
  const a = JSON.parse(draftFingerprint([local]))[0], b = server ? JSON.parse(draftFingerprint([server]))[0] : undefined
  const differences: { field: string; label: string; local: string; server: string }[] = []
  const fieldOrder = Object.keys(draftInput([local]).products[0]!)
  const walk = (x: unknown, y: unknown, field: string) => {
    if (JSON.stringify(canonical(x)) === JSON.stringify(canonical(y))) return
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])]
      if (!field) keys.sort((a,b) => fieldOrder.indexOf(a) - fieldOrder.indexOf(b))
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], field ? `${field}.${k}` : k)
    } else if ([x,y].some(value => Array.isArray(value) && value.some(item => item && typeof item === 'object'))) {
      differences.push({field,label:differenceLabel(field),...objectArrayDifference(x,y)})
    } else differences.push({ field, label: differenceLabel(field), ...differencePair(x, y, field) })
  }
  walk(a, b, '')
  return differences
}

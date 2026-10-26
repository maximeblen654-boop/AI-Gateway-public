import type { AdapterConfig, Diagnostic, Match, Product, Validation, NativeAdapter, CurrentTechnicalDiagnostics } from '@/api/admin/mediaWorkbench'
import { mediaDiagnosticGuidance, mediaDiagnosticIsAccount, mediaDiagnosticProductId, mediaDiagnosticsForModel, mediaVisibleDiagnostics, type MediaDiagnosticProductLabel } from './mediaAdminPresentation'

const UNKNOWN = 'UNKNOWN'
const range = (value: { min: number; max: number }) => ({ min: value.min, max: value.max })
const references = (value: Product['capabilities']['references']) => ({ image: range(value.image), video: range(value.video), audio: range(value.audio), total_max: value.total_max })
function match(value: Match) {
  return {
    ...(value.resolution ? { resolution: [...value.resolution] } : {}),
    ...(value.aspect_ratio ? { aspect_ratio: [...value.aspect_ratio] } : {}),
    ...(value.quality ? { quality: [...value.quality] } : {}),
    ...(value.duration_seconds ? { duration_seconds: [...value.duration_seconds] } : {}),
    ...(value.output_formats ? { output_formats: [...value.output_formats] } : {}),
    ...(value.count ? { count: range(value.count) } : {}),
    ...(value.references ? { references: references(value.references) } : {})
  }
}
function adapter(value: AdapterConfig) {
  const execution = (config: NonNullable<AdapterConfig['execution']>) => ({ mode: config.mode ?? UNKNOWN, max_output_images: config.max_output_images ?? UNKNOWN, ...(config.provider ? { provider: config.provider } : {}) })
  return {
    ...(value.version !== undefined ? { version: value.version } : {}),
    ...(value.wire_profile ? { wire_profile: value.wire_profile } : {}),
    ...(value.model_family ? { model_family: value.model_family } : {}),
    size_mappings: value.size_mappings.map(item => ({ resolution: item.resolution, aspect_ratio: item.aspect_ratio, wire_size: item.wire_size })),
    ...(value.execution ? { execution: execution(value.execution) } : {}),
    ...(value.edit_execution ? { edit_execution: execution(value.edit_execution) } : {})
  }
}
function diagnosticDetails(diagnostic: Diagnostic) {
  return { class: diagnostic.class, severity: diagnostic.severity, code: diagnostic.code, path: diagnostic.path, ...mediaDiagnosticGuidance(diagnostic), ...(diagnostic.match ? { match: match(diagnostic.match) } : {}) }
}

export interface MediaModelDiagnosticInput {
  accountId?: number
  accountHost?: string
  nativeAdapters?: Partial<Record<'image' | 'video', Pick<NativeAdapter, 'kind' | 'revision'>>>
  originalModelId?: string
  modelId: string
  productId?: string
  technicalCheck?: Pick<CurrentTechnicalDiagnostics, 'checked_at' | 'source' | 'target_product_ids'>
  requestedModelId?: string
  draftRevision?: string
  validation?: Validation
  current: boolean
  diagnostics: Diagnostic[]
  products?: MediaDiagnosticProductLabel[]
  productDetails?: Product[]
  preview?: boolean
}

/** Explicit host/adapter identifiers only; prices, credentials and customer data never enter the copy. */
export function mediaModelDiagnosticReport(input: MediaModelDiagnosticInput) {
  const products = input.productDetails ?? []
  const diagnostics = mediaVisibleDiagnostics(mediaDiagnosticsForModel(input.diagnostics, input.modelId, products, input.productId), products).filter(diagnostic => diagnostic.class === 'NEEDS_DEVELOPMENT')
  const productIds = [...new Set(diagnostics.filter(diagnostic => !mediaDiagnosticIsAccount(diagnostic)).map(diagnostic => mediaDiagnosticProductId(diagnostic, products)).filter((value): value is string => !!value))]
  const checkedModels = [...new Set(products.filter(product => productIds.includes(product.product_id)).map(product => product.upstream_model).filter(Boolean))]
  const modelId = input.modelId || (checkedModels.length === 1 ? checkedModels[0] : input.requestedModelId) || UNKNOWN
  const upstreamHost = input.accountHost && input.accountHost.length <= 253 && /^[a-z0-9.:-]+$/i.test(input.accountHost) ? input.accountHost : UNKNOWN
  const nativeAdapters = Object.fromEntries((['image', 'video'] as const).flatMap(type => {
    const native = input.nativeAdapters?.[type]
    return native ? [[type, { kind: native.kind, revision: native.revision }]] : []
  }))
  return {
    title: `${input.preview ? '商品换绑检查未通过' : '商品模型技术诊断'} · Account #${input.accountId ?? UNKNOWN} · ${modelId}`,
    problem_summary: [...new Set(diagnostics.map(diagnostic => mediaDiagnosticGuidance(diagnostic).message))],
    operation_state: input.preview ? '这是未保存的更换绑定候选，不能视为换绑成功；原绑定保持不变。' : '这是当前范围的技术诊断说明，不执行保存、商品发布或启售。',
    source: '媒体工作台 → 商品模型配置 → 需要技术适配 → 复制给 Codex',
    purpose: '核查当前商品配置是否需要新增技术支持，或修复误报及配置联动问题',
    intent_question: '你是希望新增支持这项能力，还是不需要这项能力，只想恢复正常使用？',
    handling_note: '先确认上述意图；已明确选择时沿用选择。诊断不证明上游支持或不支持，也不代表允许修改经营配置、付费生成或部署。',
    report_scope: input.preview ? '仅包含本次选择的换绑商品，不是整个账号的错误汇总。' : input.productId ? '仅包含当前选中的商品，不是整个账号的错误汇总。' : '仅包含当前型号或页面列出的技术诊断，不是整个账号所有检查结果。',
    ...(input.technicalCheck ? { technical_check: { checked_at: input.technicalCheck.checked_at, source: input.technicalCheck.source, target_product_ids: [...input.technicalCheck.target_product_ids].filter(id => productIds.includes(id)) } } : {}),
    account_id: input.accountId ?? UNKNOWN,
    account_context: { upstream_host: upstreamHost, native_adapters: nativeAdapters },
    configuration_state: input.preview ? '尚未保存的更换绑定候选' : '商品草稿配置',
    ...(input.requestedModelId ? { requested_model_id: input.requestedModelId } : {}),
    ...(input.preview ? { original_model_id: input.originalModelId || UNKNOWN, configuration_note: '以下为服务端本次实际检查的候选配置，可能取自原发布版本；不代表当前草稿已保存或换绑成功。' } : {}),
    model_id: modelId,
    draft_revision: input.draftRevision || (input.current ? input.validation?.draft_revision : undefined) || UNKNOWN,
    validation: { draft_revision: input.validation?.draft_revision || UNKNOWN, checked_at: input.validation?.checked_at || UNKNOWN, current: input.current, applies_to: input.preview ? '本次候选配置，尚未保存' : '商品草稿配置', status: input.validation?.status || UNKNOWN },
    products: productIds.map(productId => {
      const product = products.find(item => item.product_id === productId)
      const capabilities = product?.capabilities
      return {
        product_id: productId,
        display_name: product?.display_name || input.products?.find(item => item.product_id === productId)?.label || UNKNOWN,
        model_id: product?.upstream_model || UNKNOWN,
        media_type: product?.media_type || UNKNOWN,
        capabilities: capabilities ? { resolutions: [...capabilities.resolutions], aspect_ratios: [...capabilities.aspect_ratios], qualities: [...capabilities.qualities], durations_seconds: [...capabilities.durations_seconds], ...(capabilities.output_formats ? { output_formats: [...capabilities.output_formats] } : {}), count: range(capabilities.count), references: references(capabilities.references), combination_rules: capabilities.combination_rules.map(rule => ({ deny: match(rule.deny) })) } : UNKNOWN,
        adapter_config: product ? adapter(product.adapter_config) : UNKNOWN,
        diagnostics: diagnostics.filter(diagnostic => mediaDiagnosticProductId(diagnostic, products) === productId).map(diagnosticDetails)
      }
    }),
    account_diagnostics: diagnostics.filter(mediaDiagnosticIsAccount).map(diagnosticDetails),
    unresolved_product_diagnostics: diagnostics.filter(diagnostic => !mediaDiagnosticIsAccount(diagnostic) && !mediaDiagnosticProductId(diagnostic, products)).map(diagnosticDetails)
  }
}

export function mediaModelDiagnosticText(input: MediaModelDiagnosticInput): string {
  return JSON.stringify(mediaModelDiagnosticReport(input), null, 2)
}

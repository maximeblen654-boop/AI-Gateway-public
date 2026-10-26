import type { Diagnostic, Product } from '@/api/admin/mediaWorkbench'
import { draftFingerprint } from '@/composables/draftRecovery'

export interface MediaDiagnosticProductLabel { product_id: string; label: string }

/** A stable product scope wins over an obsolete path index. */
export function mediaDiagnosticProductId(diagnostic: Diagnostic, products: Pick<Product, 'product_id'>[] = []): string | undefined {
  if (diagnostic.scope && diagnostic.scope !== 'account' && diagnostic.scope !== 'product') return diagnostic.scope
  if (diagnostic.scope === 'account') return undefined
  const index = /(?:^|\.)products(?:\[|\.)(\d+)(?:\]|\.|$)/.exec(diagnostic.path)?.[1]
  return index === undefined ? undefined : products[Number(index)]?.product_id
}

export function mediaDiagnosticIsAccount(diagnostic: Diagnostic): boolean {
  return diagnostic.scope === 'account' || !diagnostic.scope && /^(?:account(?:\.|$)|model_catalog(?:\.|$)|schema_version$|validation(?:\.|$)|products$)/.test(diagnostic.path)
}

export function mediaDiagnosticsForModel(diagnostics: Diagnostic[], modelId: string, products: Product[] = [], productId?: string): Diagnostic[] {
  if (!modelId && !productId) return diagnostics
  const selected = new Set(products.filter(product => product.upstream_model === modelId).map(product => product.product_id))
  return diagnostics.filter(diagnostic => {
    if (mediaDiagnosticIsAccount(diagnostic)) return true
    const id = mediaDiagnosticProductId(diagnostic, products) ?? ''
    return (!modelId || selected.has(id)) && (!productId || id === productId)
  })
}

/** A missing model is the actionable cause; derivative adapter errors are premature. */
export function mediaVisibleDiagnostics(diagnostics: Diagnostic[], products: Pick<Product, 'product_id'>[] = []): Diagnostic[] {
  const missing = new Set(diagnostics.filter(diagnostic => diagnostic.code === 'MODEL_NOT_DISCOVERED').map(diagnostic => mediaDiagnosticProductId(diagnostic, products)).filter(Boolean))
  return diagnostics.filter(diagnostic => diagnostic.class !== 'NEEDS_DEVELOPMENT' || !missing.has(mediaDiagnosticProductId(diagnostic, products)))
    .sort((left, right) => Number(right.code === 'MODEL_NOT_DISCOVERED') - Number(left.code === 'MODEL_NOT_DISCOVERED'))
}

/** Display only: never substitutes for server validation, CAS or publishing. */
export function mediaProductMatches(product: Product, previous: Product | undefined): boolean {
  return !!previous && draftFingerprint([product]) === draftFingerprint([previous])
}

export function mediaProductPublicationLabel(product: Product, saved: Product | undefined, published: Product | undefined): string {
  if (!mediaProductMatches(product, saved)) return '当前商品有未保存修改，尚未发布'
  if (!published) return '当前商品尚未发布'
  return mediaProductMatches(product, published) ? '当前商品与已发布配置一致' : '当前商品草稿有待发布修改'
}

export function mediaDiagnosticGuidance(diagnostic: Diagnostic): { message: string; action: string } {
  const technicalReview = '请先说明是新增支持这项能力，还是恢复正常使用；技术维护者会核对配置和接口合同，需要时补齐适配。'
  const retryValidation = '保留当前配置后重新检查；仍出现时，将技术详情交给维护者排查，暂不把本次检查视为通过。'
  const known: Record<string, [string, string]> = {
    MISSING_PRICE: ['部分可售规格还没有填写客户售价。', '在客户售价步骤补齐提示中这些规格的售价，再保存检查。'],
    INVALID_PRICE: ['客户售价格式不正确：须大于 0 CNY，最多保留 8 位小数，并按每次请求计费。', '核对对应的售价金额、币种和计费方式，再保存检查。'],
    INVALID_PRICE_MATCH: ['某条售价规则使用了当前商品未配置的规格条件。', '核对这条价格规则与可售规格、计费维度的对应关系，再保存检查。'],
    PRICE_RULE_OVERLAP: ['同一组可售规格同时匹配了多条售价，系统无法确定应该收取哪一个价格。', '核对提示中的价格条件，让每组可售规格只匹配一个明确售价，再保存检查。'],
    UNUSED_PRICE_RULE: ['这条售价规则没有对应的可售规格，当前不会被使用。', '核对可售规格、组合限制与价格条件，确认这条规则原本适用于什么情况后再修正。'],
    REQUIRED_FIELD: ['商品必填标识缺失或格式不正确。', '核对提示对应的字段，补齐内容并去掉首尾空白；系统生成的商品标识异常时，请维护者核对。'],
    DUPLICATE_PRODUCT: ['草稿中存在重复的商品标识，系统无法区分这些商品。', '请技术维护者核对重复商品记录及原有绑定，再重新保存检查。'],
    CONFIG_TOO_LARGE: ['商品、规则或尺寸映射的条目过多，超过了系统允许的上限。', '按这条提示指向的字段，核对并减少重复或不需要的条目，再保存检查。'],
    VALIDATION_MATRIX_TOO_LARGE: ['当前规格、数量和参考素材展开后的组合过多，无法在一次检查中完成。', '缩小本次准备出售的规格范围，或添加已确认的组合限制，再保存检查。'],
    ADAPTER_UNKNOWN: ['本站当前没有与这个账号平台匹配的媒体处理方式。', technicalReview],
    ADAPTER_REVISION_UNSUPPORTED: ['这个商品需要的接口适配版本尚未在本站提供。', technicalReview],
    AUTH_FLOW_UNSUPPORTED: ['本站媒体调用尚未接通这个 Account 使用的认证方式。', technicalReview],
    TASK_FLOW_UNSUPPORTED: ['本站尚未接通这个同步或异步任务的处理流程。', technicalReview],
    BUILDER_REFACTOR_REQUIRED: ['这个媒体流程还没有接入本站统一的请求处理程序。', technicalReview],
    VIDEO_LEGACY_PROFILE_UPGRADE_REQUIRED: ['商品还保留旧的视频连接配置，本站已经支持当前接口。', '保存商品草稿或明确更换型号后，系统会自动更新连接配置；不需要新增技术适配。'],
    VIDEO_PROFILE_UNSUPPORTED: ['本站还没有提供这项视频协议、精确型号或配置版本对应的执行方式。', technicalReview],
    IMAGE_PROVIDER_ASYNC_UNAVAILABLE: ['本站还没有接通这项供应商原生异步批量出图流程。', technicalReview],
    VALUE_HARDCODED: ['商品内部技术配置与当前 Account 的媒体接口不一致。', '请技术维护者核对当前账号、型号和原有技术配置；需要新的调用方式时再确认技术适配。'],
    INVALID_VALUE_MAPPING: ['某条图片尺寸映射的供应商尺寸值格式不正确。', '在供应商尺寸映射中填写 auto，或正整数宽x高（例如 1024x1024），再保存检查。'],
    MISSING_VALUE_MAPPING: ['部分已开放的分辨率与比例组合还没有对应的供应商尺寸值。', '在供应商尺寸映射中补齐这些组合已确认的尺寸值，再保存检查。'],
    DUPLICATE_VALUE_MAPPING: ['同一个分辨率与比例组合填写了多条尺寸映射。', '核对该组合实际使用的供应商尺寸值，让每个组合只保留一条明确映射，再保存检查。'],
    IMAGE_SPEC_MAPPING_MISMATCH: ['商品选择的图片分辨率或比例，与供应商尺寸映射不一致。', '核对提示中的分辨率、比例和实际宽高，修正不一致的映射后保存检查。'],
    INVALID_COMBINATION_RULE: ['某条禁止组合没有有效条件，或条件超出了当前已配置的规格。', '在高级技术配置的组合限制中核对这条规则，选择有效条件后保存检查。'],
    REFERENCE_LIMIT_EXCEEDED: ['参考素材数量超过本站当前接入方式的上限。', '核对各类素材及合计上限；恢复使用时调整数量，需要更高上限时请维护者确认技术适配。'],
    NO_SELLABLE_SPEC: ['所有已配置的规格组合都被禁止组合规则排除了，当前没有可售规格。', '核对准备出售的规格与组合限制，保留至少一组实际可用的组合后再检查。'],
    NO_ENABLED_PRODUCT: ['本次检查没有已启用的商品。', '准备发布时，请选中并启用需要发布的商品；只整理草稿时可以保留未启用状态。'],
    MODEL_SYNC_REQUIRED: ['这个 Account 还没有可用的上游模型目录检查结果。', '在账号管理刷新模型列表，取得成功目录后再检查商品；不要把读取失败当成型号已下线。'],
    LOCAL_COMPILER_FAILURE: ['本站在准备检查用的请求时发生程序错误，校验结果尚未确认。', retryValidation],
    LOCAL_DEPENDENCY_UNAVAILABLE: ['草稿已保存，但本站的校验依赖暂不可用，检查结果尚未确认。', retryValidation],
    DEPENDENCY_UNAVAILABLE: ['本站的校验依赖暂不可用，检查结果尚未确认。', retryValidation],
    VALIDATION_UNAVAILABLE: ['目前无法取得完整的草稿检查结果。', retryValidation],
    VALIDATION_CANCELLED: ['本次检查提前结束，还没有检查完全部规格。', retryValidation],
    INVALID_SCHEMA: ['当前媒体配置的数据版本尚未被本站支持。', '请技术维护者核对配置版本；保留现有草稿后再处理兼容问题。'],
    ACCOUNT_ENDPOINT_INVALID: ['这个 Account 的上游接口地址格式不正确，或不是有效的 HTTPS 地址。', '在账号管理核对已确认的接口地址，再重新检查商品。'],
    MODEL_NOT_DISCOVERED: ['原型号当前不可用：最近成功获取的上游模型列表中，没有这个商品绑定的型号。', '请返回模型列表核对当前可用型号；需要更换时，进入这个商品选择已确认的型号。'],
    MODEL_MAPPING_MISMATCH: ['商品绑定的型号与当前账号的模型映射不一致。', '请核对这个商品的型号绑定，再重新保存检查；不需要改售价。'],
    INVALID_MEDIA_TYPE: ['这个商品的图片或视频用途尚未配置正确。', '在“产品标识与用途”选择实际用途，再检查对应规格。'],
    PARAMETER_TYPE_UNSUPPORTED: ['图片商品里还留有视频时长或视频、音频参考素材设置。', '先核对实际用途；图片商品请移除这些视频专用设置，视频商品请选择视频用途。'],
    VIDEO_DURATION_UNSUPPORTED: ['所选时长不在当前已接通的视频范围内。', '按已确认的接口能力调整时长，再保存检查。'],
    VIDEO_RESOLUTION_UNSUPPORTED: ['所选分辨率不在这个视频模型已确认的范围内。', '核对上游资料后调整分辨率，再保存检查。'],
    VIDEO_RATIO_UNSUPPORTED: ['所选比例不在当前已接通的视频范围内。', '按已确认的接口能力调整比例，再保存检查。'],
    VIDEO_REFERENCES_UNSUPPORTED: ['参考图片、视频或音频数量超出了当前接入范围。', '在参考素材步骤核对每类数量及合计上限，再保存检查。'],
    OUTPUT_FORMAT_UNSUPPORTED: ['当前用途或连接方式不支持所选的原生图片格式。', '保留“由模型决定”，或只选择已确认支持的图片格式。'],
    NATIVE_IMAGE_PARAMETER_UNSUPPORTED: ['当前本站的图片执行方式还不能处理这项画质或多图请求设置。', '先核对单请求出图能力和独立画质设置；需要新增这项能力时再交给技术维护者确认。'],
    IMAGE2PRO_VIDEO_METADATA_REQUIRED: ['尚未取得这个视频模型的有效能力信息。', '在账号管理刷新模型列表，再保存商品草稿并重新发布。'],
    IMAGE2PRO_VIDEO_MODE_UNSUPPORTED: ['当前记录的模型能力无法使用这组参考素材。', '按已确认的接口能力调整参考素材，再保存并检查。'],
    IMAGE2PRO_SYNC_ACCOUNT_UNSUPPORTED: ['当前账号的图片连接设置尚未确认。', '核对账号连接后，重新保存商品并执行发布检查。'],
    IMAGE2PRO_SYNC_PROFILE_REQUIRED: ['此商品仍使用旧的图片连接方式。', '重新保存商品草稿并发布后，才能使用新的连接方式。'],
    IMAGE2PRO_QUALITY_UNCONFIRMED: ['这个模型尚未确认支持单独选择画质。', '只需恢复使用时，可移除独立画质选项；需要这项能力时，请维护者核对上游资料和技术适配。'],
    IMAGE2PRO_OUTPUT_FORMAT_UNCONFIRMED: ['这个模型尚未确认支持生成时指定文件格式。', '将输出格式保留为“由模型决定”；生成后仍可本地转换下载。'],
    IMAGE2PRO_ASYNC_UNAVAILABLE: ['这个图片商品的生成方式尚未接通。', '请技术维护者核对连接；不要直接发布或开启销售。'],
    IMAGE2PRO_N_EXCEEDED: ['该供应商单次最多返回 4 张图片。', '把单次出图上限设为 4 或更少；客户购买多张仍由系统分批处理。']
  }
  const translated = known[diagnostic.code]
  const readable = (value: string) => /[㐀-鿿]/.test(value)
  return {
    message: readable(diagnostic.message) ? diagnostic.message : translated?.[0] ?? '这项配置尚未通过检查。',
    action: readable(diagnostic.action) ? diagnostic.action : translated?.[1] ?? (diagnostic.class === 'NEEDS_DEVELOPMENT' ? `请联系技术维护者处理。${technicalReview}` : '点击这条提示，核对对应字段后重新保存并检查。')
  }
}

export function mediaPublicationLabel(products: Product[], published: Product[] | undefined): string {
  if (!published?.length) return '尚未发布'
  if (!products.length) return '已有发布配置，当前草稿没有商品'
  const matches = products.map(product => {
    const previous = published.find(item => item.product_id === product.product_id && item.media_type === product.media_type && item.upstream_model === product.upstream_model && item.site_model === product.site_model)
    return !!previous && draftFingerprint([product]) === draftFingerprint([previous])
  })
  if (matches.every(Boolean)) return '当前草稿的规格和价格与已发布配置一致'
  return matches.some(Boolean) ? '部分商品已保存，仍有配置待发布' : '草稿已保存，当前配置待发布'
}

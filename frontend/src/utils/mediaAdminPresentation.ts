import type { Diagnostic, Product } from '@/api/admin/mediaWorkbench'
import { draftFingerprint } from '@/composables/draftRecovery'

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
  const known: Record<string, [string, string]> = {
    MODEL_NOT_DISCOVERED: ['最近成功获取的上游模型列表中，没有这个商品绑定的型号。', '请返回模型列表核对当前可用型号，再按实际型号配置商品。'],
    IMAGE2PRO_VIDEO_METADATA_REQUIRED: ['尚未取得这个视频模型的有效能力信息。', '在账号管理刷新模型列表，再保存商品草稿并重新发布。'],
    IMAGE2PRO_VIDEO_MODE_UNSUPPORTED: ['这个模型不支持当前设置的参考素材用法。', '按供应商已确认的能力调整参考素材，再保存并检查。'],
    IMAGE2PRO_SYNC_ACCOUNT_UNSUPPORTED: ['当前账号的图片连接设置尚未确认。', '核对账号连接后，重新保存商品并执行发布检查。'],
    IMAGE2PRO_SYNC_PROFILE_REQUIRED: ['此商品仍使用旧的图片连接方式。', '重新保存商品草稿并发布后，才能使用新的连接方式。'],
    IMAGE2PRO_QUALITY_UNCONFIRMED: ['这个模型尚未确认支持单独选择画质。', '移除独立画质选项，保留分辨率等已确认的规格。'],
    IMAGE2PRO_OUTPUT_FORMAT_UNCONFIRMED: ['这个模型尚未确认支持生成时指定文件格式。', '将输出格式保留为“由模型决定”；生成后仍可本地转换下载。'],
    IMAGE2PRO_ASYNC_UNAVAILABLE: ['这个图片商品的生成方式尚未接通。', '请技术维护者核对连接；不要直接发布或开启销售。'],
    IMAGE2PRO_N_EXCEEDED: ['该供应商单次最多返回 4 张图片。', '把单次出图上限设为 4 或更少；客户购买多张仍由系统分批处理。']
  }
  const translated = known[diagnostic.code]
  if (translated) return { message: translated[0], action: translated[1] }
  const readable = (value: string) => /[㐀-鿿]/.test(value)
  return {
    message: readable(diagnostic.message) ? diagnostic.message : '这项配置尚未通过检查。',
    action: readable(diagnostic.action) ? diagnostic.action : diagnostic.class === 'NEEDS_DEVELOPMENT' ? '请联系技术维护者处理；当前不能发布或开启销售。' : '点击这条提示，核对对应规格或售价后重新保存并检查。'
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

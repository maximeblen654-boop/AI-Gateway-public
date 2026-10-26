<template>
  <section class="mw-validation" :data-status="state" aria-live="polite">
    <h3>{{ label }}</h3>
    <p v-if="preview">本次更换尚未保存。以下检查针对拟使用的新型号配置，当前商品绑定保持原状。</p>
    <p v-else-if="saveState === 'saved'">草稿已保存，但尚未因此发布。客户当前使用的配置和历史订单保持不变。</p>
    <p v-if="state === 'PASS'">后台检查通过；未发送真实生成请求。</p>
    <p v-else-if="state === 'UNKNOWN'">整份草稿检查暂不可用。已确认保存后，可明确选择商品，在发布时单独检查。</p>
    <p v-else-if="state === 'STALE'">整份草稿检查结果不属于当前版本。先保存未保存修改，再明确选择商品进行发布检查。</p>
    <p v-if="modelId && state === 'FAIL' && !visibleDiagnostics.length" data-test="no-current-model-diagnostics">当前型号没有相关报错；账号草稿中的其他商品仍有事项需要处理。</p>
    <ul v-if="visibleDiagnostics.length">
      <li v-for="(diagnostic, index) in visibleDiagnostics" :key="`${diagnostic.code}-${index}`">
        <button type="button" class="mw-diagnostic" @click="emit('locate', diagnostic)">
          <strong data-test="diagnostic-product">{{ productLabel(diagnostic) }}</strong>
          <small>{{ fieldLabel(diagnostic.path) }}</small>
          <span>{{ diagnostic.code === 'MODEL_NOT_DISCOVERED' ? '原型号当前不可用' : diagnostic.class === 'NEEDS_DEVELOPMENT' ? '需要技术适配' : diagnostic.class === 'UI_FIXABLE' ? '可在此修改' : '检查信息' }}</span>
          <strong>{{ mediaDiagnosticGuidance(diagnostic).message }}</strong><small>{{ mediaDiagnosticGuidance(diagnostic).action }}</small>
          <small v-if="diagnostic.match">适用条件：{{ matchLabel(diagnostic.match) }}</small>
          <small v-for="(spec, specIndex) in diagnostic.specs ?? []" :key="specIndex" data-test="diagnostic-spec">待修正规格：{{ specLabel(spec) }}</small>
          <small v-if="(diagnostic.spec_count ?? 0) > (diagnostic.specs?.length ?? 0)">共 {{ diagnostic.spec_count }} 个请求组合待修正，上方仅展示前 {{ diagnostic.specs?.length }} 个；请在所属商品的第 4 步补齐覆盖。</small>
        </button>
      </li>
    </ul>
    <details v-if="visibleDiagnostics.length" data-test="diagnostic-technical-details"><summary>技术详情（供维护者排查）</summary><pre>{{ JSON.stringify(visibleDiagnostics.map(({ code, path, message, action }) => ({ code, path, message, action })), null, 2) }}</pre></details>
    <button v-if="development.length" type="button" class="btn btn-secondary" data-test="copy-codex" @click="copy">复制给 Codex</button>
    <label v-if="manualCopy" data-test="diagnostic-manual-copy">请选中下方诊断文本，复制给 Codex：<textarea readonly rows="10" :value="copyText" aria-label="商品模型配置诊断" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
    <details v-if="!modelId && validation?.previews"><summary>请求编译示例（最多 64 条）</summary><p class="mw-muted">这是有界抽样，不是完整可售规格。选择范围和价格覆盖以商品规格、组合限制及服务端发布结果为准。</p><pre>{{ JSON.stringify(validation.previews, null, 2) }}</pre></details>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { mediaDiagnosticGuidance, mediaDiagnosticIsAccount, mediaDiagnosticProductId, mediaDiagnosticsForModel, mediaVisibleDiagnostics, type MediaDiagnosticProductLabel } from '@/utils/mediaAdminPresentation'
import { mediaModelDiagnosticText } from '@/utils/mediaModelDiagnostics'
import type { Diagnostic, Match, Product, Validation } from '@/api/admin/mediaWorkbench'
const props = defineProps<{ validation?: Validation; current: boolean; unavailable: boolean; saveState: string; diagnostics: Diagnostic[]; accountId?: number; modelId: string; requestedModelId?: string; draftRevision?: string; products?: MediaDiagnosticProductLabel[]; productDetails?: Product[]; preview?: boolean }>()
const emit = defineEmits<{ locate: [diagnostic: Diagnostic]; message: [value: string] }>()
const state = computed(() => props.preview ? props.validation?.status ?? 'UNKNOWN' : props.saveState === 'saving' ? 'SAVING' : props.saveState === 'unconfirmed' ? 'UNCONFIRMED' : props.saveState === 'conflict' ? 'CONFLICT' : props.saveState === 'failed' ? 'SAVE_FAILED' : props.unavailable ? 'UNKNOWN' : !props.current ? 'STALE' : props.validation?.status ?? 'UNKNOWN')
const label = computed(() => ({ SAVING: '保存中', UNCONFIRMED: '保存结果待核对', CONFLICT: '服务器版本冲突', SAVE_FAILED: '保存失败', PENDING: '草稿已确认保存，检查中', VALIDATING: '草稿已确认保存，检查中', RUNNING: '草稿已确认保存，检查中', PASS: '检查通过', FAIL: props.modelId && !visibleDiagnostics.value.length ? '整份草稿检查未通过' : '检查失败，请处理以下事项', UNKNOWN: '检查暂不可用', STALE: '检查结果待更新' } as Record<string, string>)[state.value] ?? `后台状态：${state.value}`)
const visibleDiagnostics = computed(() => mediaVisibleDiagnostics(mediaDiagnosticsForModel(props.diagnostics, props.modelId, props.productDetails), props.productDetails))
const development = computed(() => visibleDiagnostics.value.filter(d => d.class === 'NEEDS_DEVELOPMENT'))
const copyText = computed(() => mediaModelDiagnosticText(props))
const manualCopy = ref(false)
watch(copyText, () => { manualCopy.value = false })
function productLabel(diagnostic: Diagnostic) {
  const id = mediaDiagnosticProductId(diagnostic, props.productDetails)
  const product = props.products?.find(item => item.product_id === id)
  const detail = props.productDetails?.find(item => item.product_id === id)
  return product || detail ? `所属商品：${product?.label || detail?.display_name || '名称未知'}` : mediaDiagnosticIsAccount(diagnostic) ? `Account #${props.accountId ?? '未知'} · 账号级检查` : '所属商品暂不可定位，请重新读取草稿核对'
}
function fieldLabel(path: string) {
  if (path === 'upstream_model' || path.endsWith('.upstream_model')) return '模型选择 · 当前上游模型'
  if (path.includes('edit_execution')) return '参考图编辑 · 单请求能力'
  if (path.includes('execution')) return '文生图 · 单请求能力'
  if (path.includes('cost_rules') || path.includes('cost_coverage')) return '历史成本信息 · 技术核对'
  if (path.includes('pricing_rules')) return '第 4 步 · 客户售价 · 前往填写'
  if (path.includes('references')) return '第 2 步 · 参考素材'
  if (path.includes('size_mappings')) return '尺寸传参 · 技术维护'
  if (path.includes('capabilities')) return '第 1 步 · 可售规格'
  return '点击定位对应配置'
}
function matchLabel(match: Match) {
  const fields = [match.resolution?.join('/'), match.aspect_ratio?.join('/'), match.quality?.join('/'), match.duration_seconds?.map(value => `${value} 秒`).join('/')]
  if (match.count) fields.push(`数量 ${match.count.min}～${match.count.max}`)
  if (match.references) fields.push(`参考图 ${match.references.image.min}～${match.references.image.max}，视频 ${match.references.video.min}～${match.references.video.max}，音频 ${match.references.audio.min}～${match.references.audio.max}，合计 ≤${match.references.total_max}`)
  return fields.filter(Boolean).join(' · ') || '所有可售规格（统一售价）'
}
function specLabel(spec: NonNullable<Diagnostic['specs']>[number]) {
  return [spec.resolution, spec.aspect_ratio, spec.quality, spec.duration_seconds ? `${spec.duration_seconds} 秒` : '', `数量 ${spec.count}`, `参考图 ${spec.images} / 视频 ${spec.videos} / 音频 ${spec.audio}`].filter(Boolean).join(' · ')
}
async function copy() {
  const content = copyText.value
  try {
    await navigator.clipboard.writeText(content)
    if (content !== copyText.value) return
    manualCopy.value = false
    emit('message', '商品配置诊断已复制；请先说明是新增能力，还是恢复正常使用。')
  } catch {
    if (content !== copyText.value) return
    manualCopy.value = true
    emit('message', '剪贴板暂不可用，可在下方手动复制完整诊断。')
  }
}
</script>

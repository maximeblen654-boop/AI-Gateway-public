<template>
  <section class="mw-validation" :data-status="state" aria-live="polite">
    <h3>{{ label }}</h3>
    <p v-if="saveState === 'saved'">草稿已保存。当前 Published 和历史订单保持原版本。</p>
    <p v-if="state === 'PASS'">后台检查通过；未发送真实生成请求。</p>
    <p v-else-if="state === 'UNKNOWN'">整份草稿检查暂不可用。已确认保存后，可明确选择商品，在发布时单独检查。</p>
    <p v-else-if="state === 'STALE'">整份草稿检查结果不属于当前版本。先保存未保存修改，再明确选择商品进行发布检查。</p>
    <ul v-if="diagnostics.length">
      <li v-for="(diagnostic, index) in diagnostics" :key="`${diagnostic.code}-${index}`">
        <button type="button" class="mw-diagnostic" @click="emit('locate', diagnostic)">
          <strong data-test="diagnostic-product">{{ productLabel(diagnostic) }}</strong>
          <small>{{ fieldLabel(diagnostic.path) }}</small>
          <span>{{ diagnostic.class === 'NEEDS_DEVELOPMENT' ? '需要开发' : diagnostic.class === 'UI_FIXABLE' ? '可在此修改' : '检查信息' }} · {{ diagnostic.code }}</span>
          <strong>{{ diagnostic.message }}</strong><small>{{ diagnostic.action }}</small>
          <small v-if="diagnostic.match">缺价条件：{{ matchLabel(diagnostic.match) }}</small>
          <small v-for="(spec, specIndex) in diagnostic.specs ?? []" :key="specIndex" data-test="diagnostic-spec">缺价规格：{{ specLabel(spec) }}</small>
          <small v-if="(diagnostic.spec_count ?? 0) > (diagnostic.specs?.length ?? 0)">共 {{ diagnostic.spec_count }} 个请求组合缺价，上方仅展示前 {{ diagnostic.specs?.length }} 个；请在所属商品的单价步骤补齐覆盖。</small>
        </button>
      </li>
    </ul>
    <button v-if="development.length" type="button" class="btn btn-secondary" data-test="copy-codex" @click="copy">复制给 Codex</button>
    <details v-if="validation?.previews"><summary>请求编译示例（最多 64 条）</summary><p class="mw-muted">这是有界抽样，不是完整可售规格。选择范围和价格覆盖以商品规格、组合限制及服务端发布结果为准。</p><pre>{{ JSON.stringify(validation.previews, null, 2) }}</pre></details>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { Diagnostic, Match, Validation } from '@/api/admin/mediaWorkbench'
const props = defineProps<{ validation?: Validation; current: boolean; unavailable: boolean; saveState: string; diagnostics: Diagnostic[]; accountId?: number; modelId: string; products?: { product_id: string; label: string }[] }>()
const emit = defineEmits<{ locate: [diagnostic: Diagnostic]; message: [value: string] }>()
const state = computed(() => props.saveState === 'saving' ? 'SAVING' : props.unavailable ? 'UNKNOWN' : !props.current ? 'STALE' : props.validation?.status ?? 'UNKNOWN')
const label = computed(() => ({ SAVING: '保存中', PENDING: '草稿已保存，检查中', VALIDATING: '草稿已保存，检查中', RUNNING: '草稿已保存，检查中', PASS: '检查通过', FAIL: '检查失败，请处理以下事项', UNKNOWN: '检查暂不可用', STALE: '检查结果待更新' } as Record<string, string>)[state.value] ?? `后台状态：${state.value}`)
const development = computed(() => props.diagnostics.filter(d => d.class === 'NEEDS_DEVELOPMENT'))
function productLabel(diagnostic: Diagnostic) {
  const index = /products(?:\[|\.)(\d+)/.exec(diagnostic.path)?.[1]
  const product = props.products?.find(item => item.product_id === diagnostic.scope) ?? (index === undefined ? undefined : props.products?.[Number(index)])
  return product ? `所属商品：${product.label}` : diagnostic.scope && diagnostic.scope !== 'account' ? '所属商品暂不可定位，请重新读取草稿核对' : `Account #${props.accountId ?? ''} · 账号级检查`
}
function fieldLabel(path: string) {
  if (path.includes('edit_execution')) return '参考图编辑 · 单请求能力'
  if (path.includes('execution')) return '文生图 · 单请求能力'
  if (path.includes('pricing_rules')) return '第 4 步 · 填写单价'
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
  try {
    await navigator.clipboard.writeText(JSON.stringify({ account_id: props.accountId, model_id: props.modelId, draft_revision: props.validation?.draft_revision, diagnostics: development.value }, null, 2))
    emit('message', '开发诊断已复制。')
  } catch { emit('message', '剪贴板暂不可用，请在技术详情查看诊断。') }
}
</script>

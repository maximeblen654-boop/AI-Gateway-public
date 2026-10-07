<template>
  <section class="mw-validation" :data-status="state" aria-live="polite">
    <h3>{{ label }}</h3>
    <p v-if="saveState === 'saved'">草稿已保存。当前 Published 和历史订单保持原版本。</p>
    <p v-if="state === 'PASS'">后台检查通过；未发送真实生成请求。</p>
    <p v-else-if="state === 'UNKNOWN'">后台检查暂不可用，当前不能发布。</p>
    <p v-else-if="state === 'STALE'">检查结果不属于当前草稿，请保存草稿获取最新检查。</p>
    <ul v-if="diagnostics.length">
      <li v-for="(diagnostic, index) in diagnostics" :key="`${diagnostic.code}-${index}`">
        <button type="button" class="mw-diagnostic" @click="emit('locate', diagnostic)">
          <span>{{ diagnostic.class === 'NEEDS_DEVELOPMENT' ? '需要开发' : diagnostic.class === 'UI_FIXABLE' ? '可在此修改' : '检查信息' }} · {{ diagnostic.code }}</span>
          <strong>{{ diagnostic.message }}</strong><small>{{ diagnostic.action }}</small>
        </button>
      </li>
    </ul>
    <button v-if="development.length" type="button" class="btn btn-secondary" data-test="copy-codex" @click="copy">复制给 Codex</button>
    <details v-if="validation?.previews"><summary>请求预览（后台本地构造）</summary><pre>{{ JSON.stringify(validation.previews, null, 2) }}</pre></details>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { Diagnostic, Validation } from '@/api/admin/mediaWorkbench'
const props = defineProps<{ validation?: Validation; current: boolean; unavailable: boolean; saveState: string; diagnostics: Diagnostic[]; accountId?: number; modelId: string }>()
const emit = defineEmits<{ locate: [diagnostic: Diagnostic]; message: [value: string] }>()
const state = computed(() => props.saveState === 'saving' ? 'SAVING' : props.unavailable ? 'UNKNOWN' : !props.current ? 'STALE' : props.validation?.status ?? 'UNKNOWN')
const label = computed(() => ({ SAVING: '保存中', PENDING: '草稿已保存，检查中', VALIDATING: '草稿已保存，检查中', RUNNING: '草稿已保存，检查中', PASS: '检查通过', FAIL: '检查失败，请处理以下事项', UNKNOWN: '检查暂不可用', STALE: '检查结果待更新' } as Record<string, string>)[state.value] ?? `后台状态：${state.value}`)
const development = computed(() => props.diagnostics.filter(d => d.class === 'NEEDS_DEVELOPMENT'))
async function copy() {
  try {
    await navigator.clipboard.writeText(JSON.stringify({ account_id: props.accountId, model_id: props.modelId, draft_revision: props.validation?.draft_revision, diagnostics: development.value }, null, 2))
    emit('message', '开发诊断已复制。')
  } catch { emit('message', '剪贴板暂不可用，请在技术详情查看诊断。') }
}
</script>

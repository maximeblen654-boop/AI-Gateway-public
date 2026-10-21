<template>
  <section class="catalog-notice" aria-label="上游目录自动检查" data-test="catalog-notice">
    <strong>上游目录自动检查</strong>
    <p v-if="observation.stale" role="status" data-test="catalog-delayed">当前页面里的目录信息尚未确认。请刷新页面查看最新检查；不能据此判断上游已更名或下线。</p>
    <p v-else-if="observation.change" data-test="catalog-change-summary">最近一次变化：新增 {{ observation.change.added_count }} 个型号，本次目录未返回 {{ observation.change.missing_count }} 个型号。检测时间：{{ detectedAt }}。</p>
    <p v-else data-test="catalog-baseline">已自动检查目录。新账号或连接信息变更后先建立基线，再检测后续变化。</p>
    <p v-if="observation.affected.length" data-test="catalog-affected">有 {{ observation.affected.length }} 份已发布商品的型号未在上次成功目录中找到，需要结合上游文档核对。</p>
    <p v-else-if="!observation.stale" data-test="catalog-no-affected">报告未显示已发布商品受影响，无需确认商品处理；草稿和历史记录保留。</p>
    <p class="mw-muted" data-test="catalog-auto-list">每5分钟自动检查，不会发起生成。成功同步的新型号会自动进入本账号模型列表；不会自动上架、改售价或开启销售。</p>
    <p class="mw-muted" data-test="catalog-old-model">旧型号本次未返回只需调查，不代表永久下架；草稿、历史任务和账务会保留。需要选择替代型号时，把报告交给助手核查后再确认具体方案，不必每次目录同步都确认。</p>
    <button type="button" class="btn btn-secondary" data-test="catalog-copy" @click="copyReport">复制检查与修复提示词</button>
    <p v-if="feedback" role="status" data-test="catalog-copy-status">{{ feedback }}</p>
    <label v-if="manualCopy" class="catalog-manual">请选中下面的文字复制，交给新的对话继续处理：<textarea readonly rows="10" :value="prompt" data-test="catalog-copy-text" aria-label="检查与修复提示词" @focus="selectText" /></label>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SupplierDetail } from '@/api/admin/mediaWorkbench'
import { useClipboard } from '@/composables/useClipboard'
import { catalogObservation, catalogResponsePrompt } from './catalogChangeReport'

const props = defineProps<{ detail: SupplierDetail }>()
const now = ref(Date.now())
const observation = computed(() => catalogObservation(props.detail, now.value))
const prompt = computed(() => catalogResponsePrompt(props.detail, window.location.origin, now.value))
const detectedAt = computed(() => {
  const at = Date.parse(observation.value.change?.detected_at ?? '')
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未确认'
})
const { copyToClipboard } = useClipboard()
const manualCopy = ref(false)
const feedback = ref('')
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 60_000) })
onBeforeUnmount(() => { clearInterval(timer) })
watch(() => props.detail.id, () => { manualCopy.value = false; feedback.value = ''; now.value = Date.now() })
const selectText = (event: FocusEvent) => (event.target as HTMLTextAreaElement).select()
async function copyReport() {
  const accountID = props.detail.id
  now.value = Date.now()
  const copied = await copyToClipboard(prompt.value, '已复制检查与修复提示词')
  if (props.detail.id !== accountID) return
  manualCopy.value = !copied
  feedback.value = copied ? '已复制。粘贴给新的对话即可；复制本身不会修改网站。' : '自动复制失败，报告仍在下方，可手动复制。'
}
</script>

<style scoped>
.catalog-notice { min-width: 0; margin: .75rem 0; padding: .9rem 1rem; border: 1px solid var(--mw-border, #d8d4df); border-radius: .75rem; background: var(--mw-surface, transparent); overflow-wrap: anywhere; }
.catalog-notice p { margin: .45rem 0; line-height: 1.6; }
.catalog-notice .btn { min-height: 40px; max-width: 100%; white-space: normal; }
.catalog-manual { display: grid; gap: .5rem; margin-top: .75rem; }
.catalog-manual textarea { width: 100%; min-width: 0; border: 1px solid var(--mw-border, #d8d4df); padding: .6rem; border-radius: .5rem; background: transparent; color: inherit; font: inherit; font-size: .85rem; }
</style>

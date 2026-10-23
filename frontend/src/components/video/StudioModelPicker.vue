<template>
  <div id="studio-offer" ref="root" tabindex="-1" data-testid="studio-offer-select" class="studio-offer-picker" aria-label="选择当前可用模型" @keydown="navigate">
    <p class="picker-heading">选择模型<span>近期记录</span></p>
    <ul class="picker-list">
      <li v-for="group in groups" :key="group.key" :class="{ selected: group.offers.some(item => item.offer_id === modelValue) }">
        <button type="button" class="picker-choice" :data-offer-id="group.selected.offer_id" :aria-pressed="modelValue === group.selected.offer_id" :disabled="disabled" @click="emit('select', group.selected.offer_id)">
          <span class="picker-name" :title="group.selected.display_name || group.selected.upstream_model">{{ group.selected.display_name || group.selected.upstream_model }}</span>
        </button>
        <button type="button" class="picker-status" :class="status(group.selected).tone" :aria-label="`${group.selected.display_name || group.selected.upstream_model}：${status(group.selected).label}，查看统计详情`" :aria-expanded="detailId === group.selected.offer_id" aria-controls="studio-model-observation" @mouseenter="detailId = group.selected.offer_id" @focus="detailId = group.selected.offer_id" @click="detailId = group.selected.offer_id">
          <span class="status-mark" aria-hidden="true">{{ status(group.selected).tone === 'neutral' ? '—' : '·' }}</span>{{ status(group.selected).label === '暂无状态数据' ? '暂无数据' : status(group.selected).label }}
        </button>
      </li>
    </ul>
    <p v-if="!offers.length" class="picker-empty">暂无可用模型</p>
    <div v-if="detail" id="studio-model-observation" class="picker-detail" role="status">
      <div><strong>{{ status(detail).label }}</strong><button type="button" aria-label="收起统计详情" @click="detailId = ''">×</button></div>
      <p>{{ status(detail).message }}</p>
      <p v-if="detail.passive_status?.scope === 'platform_group_requested_model'">范围：当前访问分组内，同平台、同模型的汇总；不代表某个具体渠道。</p>
      <p v-if="detail.passive_status?.window_seconds">统计窗口：最近 {{ Math.round(detail.passive_status.window_seconds / 60) }} 分钟</p>
      <p v-if="validTime(detail.passive_status?.data_through)">数据截至：{{ time(detail.passive_status?.data_through) }}</p>
      <p v-if="validTime(detail.passive_status?.computed_at)">更新于：{{ time(detail.passive_status?.computed_at) }}</p>
      <small>被动调用记录，不是实时探测，也不保证本次生成成功。</small>
    </div>
    <p v-else class="picker-footnote">点按状态查看范围与更新时间</p>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { StudioOffer } from '@/api/studioMedia'
import { groupProductOffers } from './studioProductOffers'
const props = defineProps<{ offers: StudioOffer[]; modelValue: string; disabled?: boolean }>()
const emit = defineEmits<{ select: [id: string] }>()
const root = ref<HTMLElement>(), detailId = ref(''), now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 30000) })
onUnmounted(() => clearInterval(timer))
const groups = computed(() => groupProductOffers(props.offers, props.modelValue))
const detail = computed(() => props.offers.find(o => o.offer_id === detailId.value))
const validTime = (value?: string) => !!value && Number.isFinite(Date.parse(value))
const time = (value?: string) => validTime(value) ? new Date(value!).toLocaleString('zh-CN', { hour12: false }) : ''
function status(offer: StudioOffer) {
  const s = offer.passive_status
  const neutral = (label: string, message: string) => ({ label, message, tone: 'neutral' })
  if (!s || s.scope !== 'platform_group_requested_model' || ['unavailable','no_data'].includes(s.state)) return neutral('暂无状态数据', '当前没有可用于判断的统计数据。模型选择和报价不受影响。')
  if (s.state === 'stale' || !validTime(s.data_through) || !validTime(s.computed_at) || now.value - Date.parse(s.data_through!) > 600000 || now.value - Date.parse(s.computed_at!) > 600000 || Date.parse(s.data_through!) > now.value + 300000 || Date.parse(s.computed_at!) > now.value + 60000) return neutral('数据已过期', '旧统计不用于判断当前状态，等待后台更新。')
  if (s.state === 'insufficient') return neutral('样本不足', '样本或时间覆盖不足，暂不展示错误率。')
  if (s.state !== 'observed' || typeof s.error_rate !== 'number' || !Number.isFinite(s.error_rate) || s.error_rate < 0 || s.error_rate > 1) return neutral('暂无状态数据', '当前没有可用于判断的统计数据。')
  const percentage = (s.error_rate * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  return { label: `错误 ${percentage}%`, message: `已记录请求错误率 ${percentage}%。沿用原生监控的错误分类与排除规则；不等同于作品交付失败率。`, tone: s.error_rate > 0 ? 'observed-errors' : 'observed' }
}
function navigate(event: KeyboardEvent) {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
  const choices = [...(root.value?.querySelectorAll<HTMLButtonElement>('.picker-choice:not(:disabled)') || [])]
  if (!choices.length) return
  event.preventDefault()
  const current = choices.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current < 0 ? (event.key === 'ArrowUp' ? choices.length - 1 : 0) : (current + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length)
  choices[index]?.focus()
}
</script>
<style scoped>
.studio-offer-picker { color:var(--sw-ink); font-size:13px; outline-offset:2px }
.picker-heading { display:flex; justify-content:space-between; gap:12px; margin:0 4px 6px; font-weight:600 }
.picker-heading span { color:var(--sw-muted); font-weight:400 }
.picker-list { list-style:none; padding:0 4px 0 0; margin:0; max-height:min(200px,32dvh); overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--sw-accent) var(--sw-soft); scrollbar-gutter:stable; -webkit-overflow-scrolling:touch }
.picker-list::-webkit-scrollbar { width:6px }
.picker-list::-webkit-scrollbar-thumb { background:var(--sw-accent); border:1px solid var(--sw-soft); border-radius:999px }
.picker-list::-webkit-scrollbar-track { background:var(--sw-soft); border-radius:999px }
.picker-list li { display:flex; align-items:center; gap:6px; border:1px solid transparent; border-radius:7px; padding:1px 3px; margin:2px 0 }
.picker-list li.selected { background:var(--sw-soft); border-color:var(--sw-line) }
.picker-choice { background:transparent; border:0; padding:5px; min-width:0; flex:1; text-align:left; color:inherit; min-height:36px }
.picker-name { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; font-weight:550; font-size:13px; overflow-wrap:anywhere; line-height:1.5 }
.picker-status { display:flex; align-items:center; gap:5px; flex-shrink:0; border:0; background:transparent; color:var(--sw-muted); border-radius:6px; padding:4px; font-size:12px; min-height:32px; white-space:nowrap }
.status-mark { font-size:13px; line-height:1; font-weight:500 }
.observed { color:var(--sw-ink) }.observed-errors { color:#9b4b2f; background:#fff1e8 }
:global(html.dark .studio-offer-picker .observed-errors) { color:#ffbd9a; background:#3d3029 }
.picker-detail { background:var(--sw-soft); border-radius:10px; padding:12px; margin-top:10px; line-height:1.6; max-height:160px; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--sw-accent) var(--sw-soft) }
.picker-detail>div { display:flex; justify-content:space-between; align-items:center; gap:10px }
.picker-detail button { background:none; border:0; color:inherit; font-size:20px; width:30px; height:30px }
.picker-detail p { margin:5px 0; font-size:12px; overflow-wrap:anywhere }
.picker-detail small,.picker-footnote,.picker-empty { color:var(--sw-muted); font-size:11px }
.picker-footnote { margin:7px 4px 0 }
@media(max-width:700px) { .picker-list { max-height:min(168px,30dvh) }.picker-list li { gap:2px }.picker-status { padding:6px; font-size:12px }.picker-detail { max-height:180px; overflow-y:auto } }
@media(prefers-reduced-motion:reduce) { button { transition:none!important } }
</style>

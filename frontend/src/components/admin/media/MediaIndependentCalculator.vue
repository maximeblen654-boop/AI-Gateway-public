<template>
  <button ref="trigger" type="button" class="mw-independent-calculator-tab" data-test="independent-calculator-open" @click="open = true">成本与利润计算器</button>
  <dialog ref="dialog" class="mw-independent-calculator" aria-labelledby="independent-calculator-title" tabindex="-1" @keydown="containDialogFocus($event, dialog)" @cancel.prevent="open = false">
    <header><h2 id="independent-calculator-title">成本与利润计算器</h2><button type="button" class="btn btn-secondary" aria-label="关闭成本与利润计算器" @click="open = false">关闭</button></header>
    <p class="mw-muted">独立试算，仅供参考。不会修改商品、保存草稿或影响报价。</p>
    <label class="mw-field">实际采购金额（人民币）<input v-model="memory.purchase" class="input" inputmode="decimal" data-test="independent-purchase" /></label>
    <label class="mw-field">实际到账积分<input v-model="memory.credits" class="input" inputmode="decimal" data-test="independent-credits" /></label>
    <label class="mw-field">本次整条任务消耗积分<input v-model="memory.consumption" class="input" inputmode="decimal" data-test="independent-consumption" /></label>
    <label class="mw-field">试算售价（人民币，可选）<input v-model="memory.sale" class="input" inputmode="decimal" data-test="independent-sale" /></label>
    <p v-if="memory.credits && decimalUnits(memory.credits, true) === undefined" role="status">到账积分须为大于零的有效数字。</p>
    <p v-if="inputError" role="status">{{ inputError }}</p>
    <dl class="mw-review-specs"><dt>单积分价格</dt><dd data-test="independent-unit">{{ result.perCredit ? `${result.perCredit} 元` : '—' }}</dd><dt>本次参考成本</dt><dd data-test="independent-result">{{ result.cost ? `${result.cost} 元` : '—' }}</dd><dt>试算利润</dt><dd data-test="independent-profit">{{ result.difference ? `${result.difference} 元` : '—' }}</dd><dt>试算毛利率</dt><dd data-test="independent-margin">{{ result.margin ? `${result.margin}%` : '—' }}</dd></dl>
    <p class="mw-muted">按本次整条任务消耗积分计算，不再乘时长或数量。未填写有效成本或试算售价时，不计算利润；结果不是商品的真实利润。</p>
    <p v-if="storageError" role="status">本机输入记忆不可用，当前页面内的输入仍保留。</p>
  </dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { decimalError, decimalUnits, estimateCost } from './costCalculator'
import { containDialogFocus } from './mediaDialogFocus'
const props = defineProps<{ adminId?: number }>()
const open = ref(false), dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>(), storageError = ref(false)
const memory = reactive({ purchase: '', credits: '', consumption: '', sale: '' })
const key = computed(() => props.adminId ? `ai-gateway:independent-calculator:v1:${props.adminId}` : '')
watch(key, value => { Object.assign(memory, { purchase: '', credits: '', consumption: '', sale: '' }); if (!value) return; try { const raw = localStorage.getItem(value); if (!raw) return; const parsed = JSON.parse(raw); if (parsed && ['purchase', 'credits', 'consumption'].every(k => typeof parsed[k] === 'string' && parsed[k].length < 64) && (parsed.sale === undefined || typeof parsed.sale === 'string' && parsed.sale.length < 64)) Object.assign(memory, { purchase: parsed.purchase, credits: parsed.credits, consumption: parsed.consumption, sale: parsed.sale ?? '' }) } catch { storageError.value = true } }, { immediate: true })
watch(memory, value => { if (!key.value) return; try { localStorage.setItem(key.value, JSON.stringify(value)); storageError.value = false } catch { storageError.value = true } })
const inputError = computed(() => [memory.purchase, memory.consumption, memory.sale].map(value => decimalError(value)).find(Boolean))
const result = computed(() => estimateCost(memory.purchase, memory.credits, memory.consumption, memory.sale === '' ? null : { amount: memory.sale, currency: 'CNY', billing_mode: 'per_request' }))
watch(open, async value => { await nextTick(); if (value) dialog.value?.showModal(); else { dialog.value?.close(); trigger.value?.focus() } })
onBeforeUnmount(() => dialog.value?.close())
</script>
<style scoped>
.mw-independent-calculator-tab { position:fixed; right:0; top:45%; z-index:35; writing-mode:vertical-rl; padding:1rem .6rem; border:1px solid rgb(var(--site-primary-300)); border-right:0; border-radius:.8rem 0 0 .8rem; background:var(--site-canvas-light,#fff); color:rgb(var(--site-primary-800)); box-shadow:0 3px 20px rgb(0 0 0 / .1); }
.mw-independent-calculator { position:fixed; inset:0 0 0 auto; margin:0; width:min(25rem,calc(100vw - 1rem)); height:100dvh; max-height:100dvh; max-width:none; padding:1.5rem; border:0; border-left:1px solid rgb(var(--site-primary-300)); border-radius:1rem 0 0 1rem; overflow-y:auto; background:var(--site-canvas-light,#fff); color:#1f2937; box-shadow:-10px 0 50px rgb(0 0 0 / .16); }
.mw-independent-calculator::backdrop { background:rgb(15 23 42 / .3); }
.mw-independent-calculator header { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:1rem; }
.mw-independent-calculator h2 { font-weight:700; font-size:1.2rem; }
.mw-independent-calculator .mw-field { margin:1.25rem 0; }
.dark .mw-independent-calculator,.dark .mw-independent-calculator-tab { background:#1f2937; color:#f3f4f6; }
</style>

<template>
  <div class="ratio-slider" :class="{ 'is-disabled': disabled || !options.length }">
    <label :for="id"><span>画面比例</span><span class="ratio-outline" :style="shape" aria-hidden="true"></span><strong>{{ modelValue || '待选择' }}</strong></label>
    <input :id="id" type="range" min="0" max="1000" step="1" :value="position" :disabled="disabled || !options.length" :aria-valuetext="modelValue" aria-label="画面比例，吸附已发布比例" @input="drag" @keydown="navigate" />
    <div class="ratio-labels" aria-hidden="true"><span>竖图</span><span>{{ options.includes('1:1') ? '1:1' : '' }}</span><span>横图</span></div>
    <small v-if="!options.length" role="status">当前规格或素材没有可选比例</small>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { ratioValue } from './studioRatioOptions'
const props = withDefaults(defineProps<{ id?: string; modelValue: string; options: string[]; disabled?: boolean }>(), {id:'studio-ratio-slider'})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const stops = computed(() => {
  const values=props.options.map(ratio=>({ratio,value:Math.log(ratioValue(ratio))})).filter(item=>Number.isFinite(item.value)).sort((a,b)=>a.value-b.value)
  const low=Math.min(-0.001,...values.map(item=>item.value)),high=Math.max(0.001,...values.map(item=>item.value))
  return values.map(item=>({...item,position:Math.round(item.value<0 ? 500*(1-item.value/low) : 500+500*item.value/high)}))
})
const position=computed(()=>stops.value.find(item=>item.ratio===props.modelValue)?.position??500)
const shape=computed(()=>{const ratio=ratioValue(props.modelValue);const value=Number.isFinite(ratio)?ratio:1;return{width:`${Math.max(3,24*Math.min(1,value))}px`,height:`${Math.max(3,24/Math.max(1,value))}px`}})
function choose(value:string){if(!props.disabled&&props.options.includes(value))emit('update:modelValue',value)}
function drag(event:Event){const input=event.target as HTMLInputElement;const target=Number(input.value);const nearest=stops.value.reduce<(typeof stops.value)[number]|undefined>((best,item)=>!best||Math.abs(item.position-target)<Math.abs(best.position-target)?item:best,undefined);if(nearest){input.value=String(nearest.position);choose(nearest.ratio)}}
function navigate(event:KeyboardEvent){if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const current=stops.value.findIndex(item=>item.ratio===props.modelValue);const next=event.key==='Home'?0:event.key==='End'?stops.value.length-1:Math.max(0,Math.min(stops.value.length-1,current+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1)));const item=stops.value[next];if(item)choose(item.ratio)}
</script>
<style scoped>
.ratio-slider{width:210px;max-width:100%;display:flex;flex-direction:column;gap:3px;color:inherit}
.ratio-slider label{display:flex;align-items:center;gap:9px;font-size:12px;min-height:26px}.ratio-slider label strong{margin-left:auto}
.ratio-outline{display:inline-block;border:1px solid currentColor;border-radius:3px;transition:width .12s,height .12s}
.ratio-slider input{width:100%;margin:0;accent-color:#795b4b;min-height:22px;cursor:ew-resize;touch-action:pan-y}
.ratio-labels{display:flex;justify-content:space-between;font-size:10px;opacity:.7}.ratio-slider small{font-size:11px}.is-disabled{opacity:.6}
@media(prefers-reduced-motion:reduce){.ratio-outline{transition:none}}
@media(max-width:600px){.ratio-slider{width:100%;flex-basis:100%}.ratio-slider input{min-height:32px}}
</style>

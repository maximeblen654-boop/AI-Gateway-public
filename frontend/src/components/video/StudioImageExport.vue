<template>
  <div class="image-export">
    <div class="image-export-controls">
      <label>另存为 <select v-model="format" :disabled="busy" aria-label="图片导出格式"><option value="png">PNG</option><option value="jpeg">JPG</option><option value="webp">WebP</option></select></label>
      <button type="button" :disabled="busy" @click="exportImage">{{ busy ? '正在本地转换…' : '导出图片' }}</button>
    </div>
    <small v-if="format === 'jpeg'">JPG 不支持透明，透明区域将使用白色背景。</small>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { exportOriginal, saveExport, type ImageExportFormat } from './imageExport'
const props = defineProps<{ url: string; filename: string }>()
const format = ref<ImageExportFormat>('png'), busy = ref(false), message = ref(''), failed = ref(false)
let controller: AbortController | undefined
async function exportImage() {
  if (busy.value) return
  busy.value = true; message.value = ''; failed.value = false
  controller = new AbortController()
  const selected = format.value, filename = props.filename, url = props.url
  const timeout = setTimeout(() => controller?.abort(), 30000)
  try {
    const result = await exportOriginal(url, selected, controller.signal)
    saveExport(result, filename, selected)
    message.value = '已准备下载，原片和保留期限不变。'
  } catch (error) {
    failed.value = true
    message.value = controller.signal.aborted ? '读取超时或导出已取消，请重试或下载原片。' : error instanceof Error ? error.message : '转换失败，请下载原片。'
  } finally { clearTimeout(timeout); busy.value = false }
}
onBeforeUnmount(() => controller?.abort())
</script>
<style scoped>
.image-export{display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;max-width:100%;font-size:.85rem}
.image-export-controls{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.image-export select,.image-export button{font:inherit;color:inherit;border:1px solid currentColor;border-radius:.7rem;background:transparent;padding:.5rem .7rem;min-height:40px}
.image-export button{cursor:pointer}.image-export button:disabled{opacity:.55;cursor:wait}
.image-export small,.image-export p{max-width:32rem;margin:0;overflow-wrap:anywhere;line-height:1.5}
@media(max-width:600px){.image-export{align-items:flex-start;width:100%}.image-export-controls{width:100%}}
</style>

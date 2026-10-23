<template>
  <span ref="root" class="studio-video-cover">
    <img v-if="visible && !failed" :key="attempt" v-show="loaded" :src="src" :alt="alt" decoding="async" data-testid="studio-video-cover-image" @load="loaded = true" @error="unavailable" />
    <span v-if="!loaded" class="studio-work-placeholder" data-testid="studio-video-cover-fallback">
      <Icon :name="failed ? 'play' : 'refresh'" aria-hidden="true" />
      <span>{{ failed ? '打开查看视频' : '封面加载中' }}</span>
    </span>
    <span v-if="loaded" class="studio-video-cover-play" aria-hidden="true"><Icon name="play" /></span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/icons/Icon.vue'
import { recoverStudioMediaRead } from '@/api/studioMedia'

const props = defineProps<{ src: string; alt: string }>()
const root = ref<HTMLElement | null>(null)
const visible = ref(false), loaded = ref(false), failed = ref(false), attempt = ref(0)
let observer: IntersectionObserver | undefined
let generation = 0, recovered = false, recovering = false

async function unavailable() {
  if (recovering) return
  loaded.value = false
  if (recovered) { failed.value = true; return }
  recovered = true
  recovering = true
  const current = generation
  try {
    await recoverStudioMediaRead(props.src)
    if (current === generation) attempt.value++
  } catch {
    if (current === generation) failed.value = true
  } finally {
    if (current === generation) recovering = false
  }
}

watch(() => props.src, () => { generation++; recovered = false; recovering = false; loaded.value = false; failed.value = false; attempt.value++ })
onMounted(() => {
  if (typeof window.IntersectionObserver !== 'function') { visible.value = true; return }
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visible.value = true
    observer?.disconnect()
  }, { rootMargin: '150px' })
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => { generation++; observer?.disconnect() })
</script>

<style scoped>
.studio-video-cover{display:block;position:absolute;inset:0;background:var(--sw-soft)}
.studio-video-cover>img{display:block;width:100%;height:100%;object-fit:contain}
.studio-video-cover-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#211e19a6;color:#fff;pointer-events:none}
.studio-video-cover-play svg{width:20px;height:20px;margin-left:2px}
</style>

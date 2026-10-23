<template>
  <span ref="root" class="studio-video-cover">
    <img v-if="poster" :src="poster" :alt="alt" data-testid="studio-video-cover-image" />
    <span v-else class="studio-work-placeholder" data-testid="studio-video-cover-fallback">
      <Icon :name="failed ? 'play' : 'refresh'" aria-hidden="true" />
      <span>{{ failed ? '打开查看视频' : '封面加载中' }}</span>
    </span>
    <span v-if="poster" class="studio-video-cover-play" aria-hidden="true"><Icon name="play" /></span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/icons/Icon.vue'

const props = defineProps<{ src: string; alt: string }>()
const root = ref<HTMLElement | null>(null)
const poster = ref('')
const failed = ref(false)
let visible = false
let observer: IntersectionObserver | undefined
let dispose: (() => void) | undefined

function extractFrame() {
  dispose?.()
  poster.value = ''
  failed.value = false
  if (!visible || !props.src) return

  // Read the existing authenticated original. No generation or persistent cache.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  let disposed = false
  let positioned = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timeout)
    video.removeEventListener('loadedmetadata', position)
    video.removeEventListener('loadeddata', capture)
    video.removeEventListener('seeked', capture)
    video.removeEventListener('error', unavailable)
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  const unavailable = () => { failed.value = true; cleanup() }
  const capture = () => {
    if (disposed || !positioned || video.seeking || video.readyState < 2) return
    try {
      if (!video.videoWidth || !video.videoHeight) return unavailable()
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) return unavailable()
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      poster.value = canvas.toDataURL('image/jpeg', 0.85)
      cleanup()
    } catch { unavailable() }
  }
  const position = () => {
    if (disposed) return
    if (!Number.isFinite(video.duration) || video.duration <= 0) return unavailable()
    positioned = true
    // Skip a potentially black opening frame, including very short clips.
    try { video.currentTime = Math.min(1, video.duration / 2) } catch { unavailable() }
  }
  const timeout = setTimeout(unavailable, 15000)
  dispose = cleanup
  video.addEventListener('loadedmetadata', position)
  video.addEventListener('loadeddata', capture)
  video.addEventListener('seeked', capture)
  video.addEventListener('error', unavailable)
  video.src = props.src
}

onMounted(() => {
  if (typeof window.IntersectionObserver !== 'function') { visible = true; extractFrame(); return }
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visible = true
    observer?.disconnect()
    extractFrame()
  })
  if (root.value) observer.observe(root.value)
})
watch(() => props.src, extractFrame)
onBeforeUnmount(() => { observer?.disconnect(); dispose?.() })
</script>

<style scoped>
.studio-video-cover{display:block;position:absolute;inset:0;background:var(--sw-soft)}
.studio-video-cover>img{display:block;width:100%;height:100%;object-fit:contain}
.studio-video-cover-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#211e19a6;color:#fff;pointer-events:none}
.studio-video-cover-play svg{width:20px;height:20px;margin-left:2px}
</style>

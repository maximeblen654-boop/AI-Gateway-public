<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 sm:p-6" role="dialog" aria-modal="true" :aria-label="t('videoStudio.face.title')">
    <section class="flex max-h-[92vh] w-full max-w-7xl min-w-0 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-dark-600 dark:bg-dark-800">
      <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-dark-600 sm:px-7">
        <div>
          <h2 class="text-xl font-semibold text-slate-900 dark:text-white">{{ t('videoStudio.face.title') }}</h2>
          <p class="mt-1 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.face.localOnly') }}</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-testid="face-tool-close" :aria-label="t('videoStudio.face.close')" @click="emit('close')">×</button>
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[clamp(14rem,30vw,19rem)_minmax(0,1fr)] md:overflow-hidden">
        <aside class="border-b border-slate-200 p-5 dark:border-dark-600 sm:p-6 md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-r">
          <input ref="fileInput" class="sr-only" type="file" accept="image/*" data-testid="face-file-input" @change="onFileChange" />
          <button
            type="button"
            class="flex min-h-28 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-teal-300 bg-teal-50/60 px-4 text-center text-sm font-medium text-teal-800 transition hover:border-teal-500 dark:border-teal-700 dark:bg-teal-950/20 dark:text-teal-200"
            data-testid="face-drop-zone"
            @click="openFilePicker"
            @dragover.prevent
            @drop.prevent="onDrop"
          >
            <span class="text-2xl" aria-hidden="true">＋</span>
            <span>{{ t('videoStudio.face.choosePhoto') }}</span>
            <span class="mt-1 text-xs font-normal text-slate-500 dark:text-dark-300">{{ t('videoStudio.face.dropHint') }}</span>
          </button>

          <p v-if="fileName" class="mt-3 truncate text-xs text-slate-500 dark:text-dark-300" :title="fileName">{{ fileName }}</p>
          <p v-if="fileError" class="mt-3 text-sm text-red-600 dark:text-red-300" role="alert">{{ fileError }}</p>

          <div class="mt-5 space-y-4">
            <button type="button" class="btn btn-secondary w-full" data-testid="face-auto-detect" :disabled="!image || detecting" @click="detectFaces">
              {{ detecting ? t('videoStudio.face.detecting') : t('videoStudio.face.autoDetect') }}
            </button>
            <p v-if="detectionMessage" class="text-xs text-amber-700 dark:text-amber-300" role="status">{{ detectionMessage }}</p>

            <div class="grid grid-cols-2 gap-2">
              <button type="button" class="btn btn-secondary btn-sm" data-testid="face-clear-selections" :disabled="selections.length === 0" @click="clearSelections">
                {{ t('videoStudio.face.clearSelections') }}
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-testid="face-delete-selection" :disabled="selectedIndex < 0" @click="deleteSelection">
                {{ t('videoStudio.face.deleteSelection') }}
              </button>
            </div>

            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.effect') }}
              <select v-model="effect" class="input mt-1.5 w-full" data-testid="face-effect">
                <option v-for="option in effectOptions" :key="option.value" :value="option.value">
                  {{ t(`videoStudio.face.${option.label}`) }}
                </option>
              </select>
            </label>
            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.shape') }}
              <select v-model="shape" class="input mt-1.5 w-full" data-testid="face-shape">
                <option value="ellipse">{{ t('videoStudio.face.ellipse') }}</option>
                <option value="rectangle">{{ t('videoStudio.face.rectangle') }}</option>
              </select>
            </label>
            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.strength') }}
              <input v-model.number="strength" class="mt-2 w-full accent-teal-600" type="range" min="1" max="100" step="1" data-testid="face-strength" />
            </label>
            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.textureDensity') }}
              <input v-model.number="textureDensity" class="mt-2 w-full accent-teal-600" type="range" min="1" max="100" step="1" data-testid="face-texture-density" />
            </label>
            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.lineWidth') }}
              <input v-model.number="lineWidth" class="mt-2 w-full accent-teal-600" type="range" min="1" max="30" step="1" data-testid="face-line-width" />
            </label>
            <label class="block text-sm font-medium text-slate-700 dark:text-gray-200">
              {{ t('videoStudio.face.effectColor') }}
              <input v-model="effectColor" class="mt-1.5 h-10 w-full cursor-pointer rounded-lg border border-slate-200 bg-white p-1 dark:border-dark-600 dark:bg-dark-700" type="color" data-testid="face-effect-color" />
            </label>
            <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-gray-200">
              <input v-model="showOriginal" type="checkbox" data-testid="face-show-original" />
              {{ t('videoStudio.face.showOriginal') }}
            </label>
            <button type="button" class="btn btn-primary w-full" data-testid="face-download" :disabled="!image || selections.length === 0" @click="downloadResult">
              {{ t('videoStudio.face.download') }}
            </button>
            <p class="text-xs leading-5 text-slate-500 dark:text-dark-300">{{ t('videoStudio.face.manualHint') }}</p>
          </div>
        </aside>

        <div class="flex min-h-[22rem] min-w-0 flex-col overflow-hidden bg-slate-50 p-4 dark:bg-dark-900 sm:p-6">
          <p class="mb-3 flex-none text-sm font-medium text-slate-600 dark:text-dark-300">
            {{ t('videoStudio.face.previewHint') }}
          </p>
          <div
            class="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-inner dark:border-dark-600 dark:bg-dark-800"
            data-testid="face-canvas-stage"
          >
            <canvas
              ref="canvas"
              class="max-h-[calc(92vh-12rem)] max-w-full touch-none cursor-crosshair object-contain"
              data-testid="face-canvas"
              @pointerdown="startSelection"
              @pointermove="moveSelection"
              @pointerup="finishSelection"
              @pointercancel="cancelSelection"
            />
            <div v-if="!image" class="pointer-events-none absolute text-center text-slate-400 dark:text-dark-400">
              <p class="text-lg font-medium">{{ t('videoStudio.face.emptyTitle') }}</p>
              <p class="mt-1 text-sm">{{ t('videoStudio.face.emptyHint') }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BlazeFaceModel } from '@tensorflow-models/blazeface'

type Point = { x: number; y: number }
type Selection = { start: Point; end: Point }
type Effect = 'fishnet' | 'scribble' | 'blur' | 'crosslines' | 'landscape' | 'label' | 'separate' | 'puzzle' | 'lightdots' | 'metalgrid' | 'horn'
type FaceBox = { boundingBox?: { x?: number; y?: number; width?: number; height?: number } }
type DetectedFaceBox = { x: number; y: number; width: number; height: number }
type NativeFaceDetector = new (options?: { maxDetectedFaces?: number }) => {
  detect(source: HTMLImageElement): Promise<FaceBox[]>
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const sourceUrl = ref('')
const fileName = ref('')
const fileError = ref('')
const detectionMessage = ref('')
const detecting = ref(false)
const selections = ref<Selection[]>([])
const selectedIndex = ref(-1)
const activeSelection = ref<Selection | null>(null)
const effectOptions: Array<{ value: Effect; label: string }> = [
  { value: 'fishnet', label: 'fishnet' },
  { value: 'scribble', label: 'scribble' },
  { value: 'blur', label: 'blur' },
  { value: 'crosslines', label: 'crosslines' },
  { value: 'landscape', label: 'landscape' },
  { value: 'label', label: 'label' },
  { value: 'separate', label: 'separate' },
  { value: 'puzzle', label: 'puzzle' },
  { value: 'lightdots', label: 'lightdots' },
  { value: 'metalgrid', label: 'metalgrid' },
  { value: 'horn', label: 'horn' },
]
const effect = ref<Effect>('blur')
const shape = ref('ellipse')
const strength = ref(48)
const textureDensity = ref(52)
const lineWidth = ref(10)
const effectColor = ref('#ef4444')
const showOriginal = ref(false)
let imageGeneration = 0
let detectionRequestId = 0
let localDetector: BlazeFaceModel | null = null
let localDetectorPromise: Promise<BlazeFaceModel> | null = null

function openFilePicker() {
  fileInput.value?.click()
}

function revokeSource() {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  sourceUrl.value = ''
}

function resetImage() {
  imageGeneration += 1
  detectionRequestId += 1
  detecting.value = false
  revokeSource()
  image.value = null
  fileName.value = ''
  selections.value = []
  selectedIndex.value = -1
  activeSelection.value = null
  detectionMessage.value = ''
  const context = canvas.value?.getContext('2d')
  if (context && canvas.value) context.clearRect(0, 0, canvas.value.width, canvas.value.height)
}

function loadFile(file: File | undefined) {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    fileError.value = t('videoStudio.face.invalidFile')
    return
  }
  fileError.value = ''
  resetImage()
  const generation = imageGeneration
  fileName.value = file.name
  const nextUrl = URL.createObjectURL(file)
  sourceUrl.value = nextUrl
  const nextImage = new Image()
  nextImage.onload = () => {
    if (generation !== imageGeneration) return
    image.value = nextImage
    void nextTick(drawCanvas)
  }
  nextImage.onerror = () => {
    if (generation !== imageGeneration) return
    fileError.value = t('videoStudio.face.loadFailed')
    resetImage()
  }
  nextImage.src = nextUrl
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  loadFile(input.files?.[0])
  input.value = ''
}

function onDrop(event: DragEvent) {
  loadFile(event.dataTransfer?.files?.[0])
}

function normalizedSelection(selection: Selection) {
  const x = Math.min(selection.start.x, selection.end.x)
  const y = Math.min(selection.start.y, selection.end.y)
  const width = Math.abs(selection.end.x - selection.start.x)
  const height = Math.abs(selection.end.y - selection.start.y)
  return { x, y, width, height }
}

function canvasPoint(event: MouseEvent): Point | null {
  const target = canvas.value
  if (!target || !target.width || !target.height) return null
  const rect = target.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return {
    x: Math.max(0, Math.min(target.width, (event.clientX - rect.left) * target.width / rect.width)),
    y: Math.max(0, Math.min(target.height, (event.clientY - rect.top) * target.height / rect.height)),
  }
}

function drawSelectionPath(context: CanvasRenderingContext2D, selection: Selection) {
  const box = normalizedSelection(selection)
  context.beginPath()
  if (shape.value === 'ellipse') {
    context.ellipse(box.x + box.width / 2, box.y + box.height / 2, Math.max(1, box.width / 2), Math.max(1, box.height / 2), 0, 0, Math.PI * 2)
  } else {
    context.rect(box.x, box.y, box.width, box.height)
  }
}

function withSelectionClip(context: CanvasRenderingContext2D, selection: Selection, draw: () => void) {
  context.save()
  drawSelectionPath(context, selection)
  context.clip()
  draw()
  context.restore()
}

function seededRandom(seed: string) {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619)
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function colorWithAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return `rgba(239, 68, 68, ${alpha})`
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function applyBlur(context: CanvasRenderingContext2D, source: HTMLCanvasElement, selection: Selection) {
  const box = normalizedSelection(selection)
  if (box.width < 2 || box.height < 2) return
  const tile = Math.max(2, Math.round(Math.min(box.width, box.height) * strength.value / 1200))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.ceil(box.width / tile))
  small.height = Math.max(1, Math.ceil(box.height / tile))
  const smallContext = small.getContext('2d')
  if (!smallContext) return
  smallContext.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, small.width, small.height)
  withSelectionClip(context, selection, () => {
    context.imageSmoothingEnabled = false
    context.drawImage(small, 0, 0, small.width, small.height, box.x, box.y, box.width, box.height)
    context.fillStyle = colorWithAlpha(effectColor.value, Math.min(0.3, strength.value / 350))
    context.fill()
  })
}

function applyFishnet(context: CanvasRenderingContext2D, selection: Selection, metallic = false) {
  const box = normalizedSelection(selection)
  const gap = Math.max(7, Math.min(box.width, box.height) * (0.2 - textureDensity.value / 900))
  const width = Math.max(1.5, Math.min(box.width, box.height) * lineWidth.value / (metallic ? 650 : 750))
  withSelectionClip(context, selection, () => {
    context.fillStyle = metallic ? 'rgba(7, 12, 18, .34)' : 'rgba(0, 0, 0, .18)'
    context.fillRect(box.x, box.y, box.width, box.height)
    context.lineWidth = width
    for (let offset = -box.height; offset < box.width + box.height; offset += gap) {
      const gradient = metallic ? context.createLinearGradient(box.x, box.y, box.x + box.width, box.y + box.height) : null
      if (gradient) {
        gradient.addColorStop(0, '#313b46')
        gradient.addColorStop(0.5, '#f1f5f9')
        gradient.addColorStop(1, '#4b5563')
      }
      context.strokeStyle = gradient || 'rgba(0, 0, 0, .94)'
      context.beginPath()
      context.moveTo(box.x + offset, box.y)
      context.lineTo(box.x + offset - box.height, box.y + box.height)
      context.moveTo(box.x + offset, box.y)
      context.lineTo(box.x + offset + box.height, box.y + box.height)
      context.stroke()
    }
  })
}

function applyScribble(context: CanvasRenderingContext2D, selection: Selection, index: number) {
  const box = normalizedSelection(selection)
  const random = seededRandom(`${index}:${box.x}:${box.y}:${textureDensity.value}:${lineWidth.value}`)
  const strokes = Math.max(5, Math.round(5 + textureDensity.value / 5))
  withSelectionClip(context, selection, () => {
    context.strokeStyle = effectColor.value
    context.lineWidth = Math.max(2, Math.min(box.width, box.height) * lineWidth.value / 420)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (let stroke = 0; stroke < strokes; stroke += 1) {
      context.beginPath()
      context.moveTo(box.x + random() * box.width, box.y + random() * box.height)
      for (let turn = 0; turn < 3; turn += 1) {
        context.quadraticCurveTo(box.x + random() * box.width, box.y + random() * box.height, box.x + random() * box.width, box.y + random() * box.height)
      }
      context.stroke()
    }
  })
}

function applyCrosslines(context: CanvasRenderingContext2D, selection: Selection) {
  const box = normalizedSelection(selection)
  const inset = Math.min(box.width, box.height) * 0.12
  withSelectionClip(context, selection, () => {
    context.strokeStyle = effectColor.value
    context.lineWidth = Math.max(3, Math.min(box.width, box.height) * lineWidth.value / 260)
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(box.x + inset, box.y + inset)
    context.lineTo(box.x + box.width - inset, box.y + box.height - inset)
    context.moveTo(box.x + box.width - inset, box.y + inset)
    context.lineTo(box.x + inset, box.y + box.height - inset)
    context.stroke()
  })
}

function applyLandscape(context: CanvasRenderingContext2D, selection: Selection) {
  const box = normalizedSelection(selection)
  withSelectionClip(context, selection, () => {
    const sky = context.createLinearGradient(0, box.y, 0, box.y + box.height)
    sky.addColorStop(0, 'rgba(45, 168, 224, .92)')
    sky.addColorStop(0.52, 'rgba(255, 205, 126, .86)')
    sky.addColorStop(1, 'rgba(25, 76, 55, .94)')
    context.fillStyle = sky
    context.fillRect(box.x, box.y, box.width, box.height)
    context.fillStyle = 'rgba(29, 75, 78, .88)'
    context.beginPath()
    context.moveTo(box.x, box.y + box.height * 0.72)
    context.lineTo(box.x + box.width * 0.28, box.y + box.height * 0.34)
    context.lineTo(box.x + box.width * 0.5, box.y + box.height * 0.66)
    context.lineTo(box.x + box.width * 0.72, box.y + box.height * 0.42)
    context.lineTo(box.x + box.width, box.y + box.height * 0.74)
    context.lineTo(box.x + box.width, box.y + box.height)
    context.lineTo(box.x, box.y + box.height)
    context.closePath()
    context.fill()
  })
}

function applyLabel(context: CanvasRenderingContext2D, selection: Selection, index: number) {
  const box = normalizedSelection(selection)
  const size = Math.max(12, Math.min(box.width, box.height) * 0.12)
  const label = `${t('videoStudio.face.role')} ${index + 1}`
  context.save()
  context.strokeStyle = effectColor.value
  context.lineWidth = Math.max(2, Math.min(box.width, box.height) * 0.018)
  context.setLineDash([6, 4])
  drawSelectionPath(context, selection)
  context.stroke()
  context.setLineDash([])
  context.font = `600 ${size}px sans-serif`
  context.fillStyle = effectColor.value
  context.fillRect(box.x, Math.max(0, box.y - size * 1.45), Math.max(size * 4.5, box.width * 0.55), size * 1.4)
  context.fillStyle = '#ffffff'
  context.textBaseline = 'middle'
  context.fillText(label, box.x + size * 0.4, Math.max(size * 0.7, box.y - size * 0.75))
  context.restore()
}

function applyPuzzle(context: CanvasRenderingContext2D, source: HTMLCanvasElement, selection: Selection, index: number) {
  const box = normalizedSelection(selection)
  const random = seededRandom(`${index}:puzzle:${textureDensity.value}`)
  const columns = Math.max(3, Math.round(3 + textureDensity.value / 24))
  const rows = Math.max(3, Math.round(columns * box.height / Math.max(1, box.width)))
  const cellWidth = box.width / columns
  const cellHeight = box.height / rows
  withSelectionClip(context, selection, () => {
    context.clearRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4)
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (random() < strength.value / 580) continue
        const x = box.x + column * cellWidth
        const y = box.y + row * cellHeight
        const drift = Math.min(cellWidth, cellHeight) * (0.04 + strength.value / 620)
        context.drawImage(source, x, y, cellWidth, cellHeight, x + (random() - 0.5) * drift * 2, y + (random() - 0.5) * drift * 2, cellWidth * 0.94, cellHeight * 0.94)
      }
    }
  })
}

function applyLightdots(context: CanvasRenderingContext2D, selection: Selection, index: number) {
  const box = normalizedSelection(selection)
  const random = seededRandom(`${index}:lights:${textureDensity.value}`)
  const count = Math.max(10, Math.round(8 + textureDensity.value * 0.65))
  withSelectionClip(context, selection, () => {
    for (let point = 0; point < count; point += 1) {
      const x = box.x + random() * box.width
      const y = box.y + random() * box.height
      const radius = Math.max(2, Math.min(box.width, box.height) * (0.015 + random() * strength.value / 1200))
      const glow = context.createRadialGradient(x, y, 0, x, y, radius)
      glow.addColorStop(0, 'rgba(255,255,255,.98)')
      glow.addColorStop(0.28, effectColor.value)
      glow.addColorStop(1, 'rgba(255,255,255,0)')
      context.fillStyle = glow
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fill()
    }
  })
}

function applyHorn(context: CanvasRenderingContext2D, selection: Selection) {
  const box = normalizedSelection(selection)
  const hornHeight = box.height * (0.28 + strength.value / 500)
  const hornWidth = box.width * 0.24
  const top = Math.max(0, box.y - hornHeight * 0.85)
  for (const [origin, direction] of [[box.x + box.width * 0.28, -1], [box.x + box.width * 0.72, 1]] as const) {
    const gradient = context.createLinearGradient(origin, box.y, origin + hornWidth * direction, top)
    gradient.addColorStop(0, '#20252a')
    gradient.addColorStop(0.52, '#cbd5e1')
    gradient.addColorStop(1, '#ffffff')
    context.save()
    context.fillStyle = gradient
    context.strokeStyle = 'rgba(17,24,39,.9)'
    context.lineWidth = Math.max(1.5, box.width * 0.012)
    context.beginPath()
    context.moveTo(origin - hornWidth * 0.28 * direction, box.y + box.height * 0.08)
    context.bezierCurveTo(origin + hornWidth * 0.1 * direction, box.y - hornHeight * 0.12, origin + hornWidth * 0.88 * direction, top + hornHeight * 0.38, origin + hornWidth * direction, top)
    context.bezierCurveTo(origin + hornWidth * 0.48 * direction, top + hornHeight * 0.1, origin - hornWidth * 0.12 * direction, box.y - hornHeight * 0.06, origin - hornWidth * 0.28 * direction, box.y + box.height * 0.08)
    context.closePath()
    context.fill()
    context.stroke()
    context.restore()
  }
}

function applyEffect(context: CanvasRenderingContext2D, source: HTMLCanvasElement, selection: Selection, index: number) {
  switch (effect.value) {
    case 'fishnet': applyFishnet(context, selection); break
    case 'scribble': applyScribble(context, selection, index); break
    case 'blur': applyBlur(context, source, selection); break
    case 'crosslines': applyCrosslines(context, selection); break
    case 'landscape': applyLandscape(context, selection); break
    case 'label': applyLabel(context, selection, index); break
    case 'puzzle': applyPuzzle(context, source, selection, index); break
    case 'lightdots': applyLightdots(context, selection, index); break
    case 'metalgrid': applyFishnet(context, selection, true); break
    case 'horn': applyHorn(context, selection); break
  }
}

function makeSourceCanvas(source: HTMLImageElement | HTMLCanvasElement, width: number, height: number) {
  const result = document.createElement('canvas')
  result.width = width
  result.height = height
  result.getContext('2d')?.drawImage(source, 0, 0, width, height)
  return result
}

function renderSeparated(source: HTMLCanvasElement, regions: Selection[], keepFaces: boolean) {
  const result = document.createElement('canvas')
  result.width = source.width
  result.height = source.height
  const context = result.getContext('2d')
  if (!context) return result
  if (!keepFaces) {
    context.drawImage(source, 0, 0)
    context.globalCompositeOperation = 'destination-out'
    for (const region of regions) {
      drawSelectionPath(context, region)
      context.fill()
    }
    context.globalCompositeOperation = 'source-over'
    return result
  }
  for (const region of regions) withSelectionClip(context, region, () => context.drawImage(source, 0, 0))
  return result
}

function drawCanvas() {
  const target = canvas.value
  const source = image.value
  if (!target || !source) return
  const maxSize = 1400
  const scale = Math.min(1, maxSize / Math.max(source.naturalWidth, source.naturalHeight))
  target.width = Math.max(1, Math.round(source.naturalWidth * scale))
  target.height = Math.max(1, Math.round(source.naturalHeight * scale))
  const context = target.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, target.width, target.height)
  context.imageSmoothingEnabled = true
  const sourceCanvas = makeSourceCanvas(source, target.width, target.height)
  context.drawImage(sourceCanvas, 0, 0)
  if (showOriginal.value) return
  if (effect.value === 'separate') {
    context.clearRect(0, 0, target.width, target.height)
    context.drawImage(renderSeparated(sourceCanvas, selections.value, true), 0, 0)
  } else {
    selections.value.forEach((selection, index) => applyEffect(context, sourceCanvas, selection, index))
  }
  if (activeSelection.value) {
    context.save()
    context.strokeStyle = effectColor.value
    context.lineWidth = lineWidth.value
    context.setLineDash([6, 4])
    drawSelectionPath(context, activeSelection.value)
    context.stroke()
    context.restore()
  }
  for (const selection of selections.value) {
    context.save()
    context.strokeStyle = effectColor.value
    context.lineWidth = lineWidth.value
    drawSelectionPath(context, selection)
    context.stroke()
    context.restore()
  }
}

function startSelection(event: PointerEvent) {
  if (!image.value || showOriginal.value) return
  const point = canvasPoint(event)
  if (!point) return
  canvas.value?.setPointerCapture?.(event.pointerId)
  activeSelection.value = { start: point, end: point }
}

function moveSelection(event: PointerEvent) {
  if (!activeSelection.value) return
  const point = canvasPoint(event)
  if (!point) return
  activeSelection.value.end = point
  drawCanvas()
}

function finishSelection(event?: PointerEvent) {
  if (!activeSelection.value) return
  if (event) {
    const point = canvasPoint(event)
    if (point) activeSelection.value.end = point
  }
  const next = normalizedSelection(activeSelection.value)
  if (next.width >= 4 && next.height >= 4) {
    selections.value.push(activeSelection.value)
    selectedIndex.value = selections.value.length - 1
  }
  activeSelection.value = null
  if (event && canvas.value?.hasPointerCapture?.(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  drawCanvas()
}

function cancelSelection(event: PointerEvent) {
  activeSelection.value = null
  if (canvas.value?.hasPointerCapture?.(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  drawCanvas()
}

function clearSelections() {
  selections.value = []
  selectedIndex.value = -1
  drawCanvas()
}

function deleteSelection() {
  if (selectedIndex.value < 0) return
  selections.value.splice(selectedIndex.value, 1)
  selectedIndex.value = Math.min(selectedIndex.value, selections.value.length - 1)
  drawCanvas()
}

async function getLocalDetector(): Promise<BlazeFaceModel> {
  if (localDetector) return localDetector
  if (!localDetectorPromise) {
    localDetectorPromise = (async () => {
      await import('@tensorflow/tfjs-backend-webgl')
      const tf = await import('@tensorflow/tfjs-core')
      if (!await tf.setBackend('webgl')) throw new Error('WebGL backend unavailable')
      await tf.ready()
      const { load } = await import('@tensorflow-models/blazeface')
      localDetector = await load({ maxFaces: 20 })
      return localDetector
    })().catch((error) => {
      localDetectorPromise = null
      throw error
    })
  }
  return localDetectorPromise
}

async function detectFaceBoxes(source: HTMLImageElement): Promise<DetectedFaceBox[]> {
  const detectorConstructor = (window as Window & { FaceDetector?: NativeFaceDetector }).FaceDetector
  if (detectorConstructor) {
    const faces = await new detectorConstructor({ maxDetectedFaces: 20 }).detect(source)
    return faces
      .map((face) => face.boundingBox)
      .filter((box): box is DetectedFaceBox => Boolean(box && [box.x, box.y, box.width, box.height].every((value) => typeof value === 'number')))
  }

  const detector = await getLocalDetector()
  const faces = await detector.estimateFaces(source, false, false, false)
  return faces.flatMap((face) => {
    if (!Array.isArray(face.topLeft) || !Array.isArray(face.bottomRight)) return []
    const [x, y] = face.topLeft
    const [right, bottom] = face.bottomRight
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(right) && Number.isFinite(bottom) && right > x && bottom > y
      ? [{ x, y, width: right - x, height: bottom - y }]
      : []
  })
}

async function detectFaces() {
  if (!image.value || detecting.value) return
  detecting.value = true
  detectionMessage.value = ''
  const source = image.value
  const generation = imageGeneration
  const requestId = ++detectionRequestId
  try {
    const faces = await detectFaceBoxes(source)
    if (requestId !== detectionRequestId || generation !== imageGeneration || image.value !== source) return
    const target = canvas.value
    if (!target || !faces.length) {
      detectionMessage.value = t('videoStudio.face.noFaces')
      return
    }
    const scaleX = target.width / source.naturalWidth
    const scaleY = target.height / source.naturalHeight
    const detected = faces
      .map((box) => ({ start: { x: box.x * scaleX, y: box.y * scaleY }, end: { x: (box.x + box.width) * scaleX, y: (box.y + box.height) * scaleY } }))
    selections.value = detected
    selectedIndex.value = detected.length ? detected.length - 1 : -1
    drawCanvas()
    detectionMessage.value = detected.length ? t('videoStudio.face.detected', { count: detected.length }) : t('videoStudio.face.noFaces')
  } catch {
    if (requestId === detectionRequestId && generation === imageGeneration) {
      detectionMessage.value = t('videoStudio.face.autoDetectFailed')
    }
  } finally {
    if (requestId === detectionRequestId) detecting.value = false
  }
}

function scaleSelections(scaleX: number, scaleY: number) {
  return selections.value.map((selection) => ({
    start: { x: selection.start.x * scaleX, y: selection.start.y * scaleY },
    end: { x: selection.end.x * scaleX, y: selection.end.y * scaleY },
  }))
}

function downloadCanvas(output: HTMLCanvasElement, filename: string) {
  return new Promise<void>((resolve) => output.toBlob((blob) => {
    if (!blob) {
      resolve()
      return
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    resolve()
  }, 'image/png'))
}

async function downloadResult() {
  const target = canvas.value
  const source = image.value
  if (!target || !source || selections.value.length === 0) return
  const scale = Math.min(1, 4096 / Math.max(source.naturalWidth, source.naturalHeight))
  const sourceCanvas = makeSourceCanvas(source, Math.max(1, Math.round(source.naturalWidth * scale)), Math.max(1, Math.round(source.naturalHeight * scale)))
  const output = makeSourceCanvas(sourceCanvas, sourceCanvas.width, sourceCanvas.height)
  const context = output.getContext('2d')
  if (!context) return
  const regions = scaleSelections(output.width / target.width, output.height / target.height)
  if (effect.value === 'separate') {
    await downloadCanvas(renderSeparated(sourceCanvas, regions, true), `face-${Date.now()}.png`)
    await downloadCanvas(renderSeparated(sourceCanvas, regions, false), `body-${Date.now()}.png`)
    return
  }
  regions.forEach((selection, index) => applyEffect(context, sourceCanvas, selection, index))
  await downloadCanvas(output, `face-processed-${Date.now()}.png`)
}

watch([showOriginal, selections, effect, shape, strength, textureDensity, lineWidth, effectColor], drawCanvas)

onBeforeUnmount(() => {
  revokeSource()
  localDetector?.dispose()
  localDetector = null
  localDetectorPromise = null
})

watch(() => props.open, (isOpen) => {
  if (!isOpen) resetImage()
})
</script>

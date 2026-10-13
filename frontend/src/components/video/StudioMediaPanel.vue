<template>
  <section class="studio-workspace" :class="{ 'is-history': historyMode }" data-testid="studio-media-panel">
    <aside class="studio-rail" aria-label="创作工作台导航">
      <a href="/dashboard" class="studio-brand-mark" aria-label="AI Gateway，返回控制台"><StudioMark /></a>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'text' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'text'" :disabled="busy" data-testid="studio-mode-text" @click="changeMode('text')"><Icon name="grid" /><span>文生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'edit' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'edit'" :disabled="busy" data-testid="studio-mode-edit" @click="changeMode('edit')"><Icon name="edit" /><span>图生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'video' }" :aria-pressed="!historyMode && kind === 'video'" :disabled="busy" data-testid="studio-mode-video" @click="changeMode('video')"><Icon name="play" /><span>视频</span></button>
      <button class="studio-history-nav" :class="{ selected: historyMode }" :aria-pressed="historyMode" :disabled="busy" data-testid="studio-mode-history" @click="historyMode = true; openControl = null"><Icon name="clock" /><span>任务历史</span></button>
      <a href="/dashboard" class="studio-dashboard"><Icon name="arrowLeft" /><span>控制台</span></a>
    </aside>
    <div class="studio-main">
      <header class="studio-header">
        <div><h1><a href="/dashboard" aria-label="AI Gateway，返回控制台">AI Gateway</a> <span>{{ historyMode ? '任务历史' : modeLabel }}</span></h1><p class="studio-mobile-tagline">让想法有画面。</p></div>
        <button v-if="!active" class="studio-button studio-header-new" :disabled="busy" @click="focusPrompt"><Icon name="plus" />开始创作</button>
        <button v-else-if="canStartNew" class="studio-button studio-header-new" :disabled="busy" @click="newTask"><Icon name="plus" />新建任务</button>
      </header>
      <div class="studio-section-heading">
        <h2>{{ historyMode ? '我的任务' : '最近的创作' }}<span v-if="history.length">{{ history.length }}</span></h2>
        <div class="studio-history-tools"><button v-if="!historyMode && history.length > 2" class="studio-text-button" @click="historyMode = true">全部任务<Icon name="arrowRight" /></button><label v-if="historyMode" class="studio-kind-filter">类型<select :disabled="busy" v-model="kind" data-testid="studio-kind" @change="imageMode = 'text'; load()"><option value="image">图片</option><option value="video">视频</option></select></label><button class="studio-text-button" :disabled="busy || querying || historyLoading" @click="reloadHistory"><Icon name="refresh" :class="{ spinning: historyLoading }" />刷新记录</button></div>
      </div>
      <p v-if="historyMode" class="studio-retention-note">{{ kind === 'image' ? '图片原片有保留期限，请及时下载；历史记录仍在不代表原片仍可用。' : '这里显示服务端返回的最近任务，请及时下载需要保留的原片。' }}</p>
      <div v-if="history.length" class="studio-gallery" data-testid="studio-history">
        <button v-for="task in visibleHistory" :key="task.id" class="studio-work" :class="{ 'is-selected': active?.id === task.id }" :disabled="busy" :data-task-id="task.id" @click="selectTask(task)">
          <span class="studio-work-preview">
            <img v-if="task.kind === 'image' && hasResults(task)" :src="studioResultUrl(task)" :alt="taskModel(task) + ' 的生成结果'" loading="lazy" @error="imageUnavailable" />
            <span v-else class="studio-work-placeholder"><Icon :name="task.kind === 'video' ? 'play' : 'grid'" /><span>{{ hasResults(task) ? '单条视频' : statusText(task.status) }}</span></span>
            <span class="studio-work-badge">{{ hasResults(task) ? `${task.resultCount} ${task.kind === 'image' ? '张原图' : '条视频'}` : statusText(task.status) }}</span>
          </span>
          <span class="studio-work-title"><strong>{{ taskModel(task) }}</strong><time>{{ taskDate(task) }}</time></span>
          <span class="studio-work-meta">{{ specText(task) }}</span>
          <span class="studio-work-state">{{ statusText(task.status) }}</span>
        </button>
      </div>
      <div v-else class="studio-empty" data-testid="studio-empty"><StudioMark /><h2>{{ historyLoading || busy ? '正在读取工作台…' : historyMode ? '还没有历史任务' : '让想法有画面。' }}</h2><p>{{ historyMode ? '完成创作后，你可以在这里查看状态和下载作品。' : '写下描述，开始创作。' }}</p></div>
      <p v-if="notice" role="status" class="studio-notice">{{ notice }}</p>
      <p v-if="error" role="alert" class="studio-error" data-testid="studio-error">{{ error }}</p>
      <p v-if="!enabled" class="studio-gate" data-testid="studio-gate"><Icon name="infoCircle" />当前生成服务未开放，仍可查看报价和已有结果。</p>
      <section v-if="active" ref="taskDetail" class="studio-task-detail" data-testid="studio-task" aria-label="当前任务">
        <div class="studio-task-heading"><div><h2>{{ taskModel(active) }}</h2><p>已冻结：{{ specText(active) }}</p></div><span class="studio-status" :class="`status-${active.status}`" data-testid="studio-status" aria-live="polite">{{ statusText(active.status) }}</span></div>
        <div class="studio-price-line"><p data-testid="studio-price">冻结报价 <strong>{{ active.price.amount }} {{ active.price.currency }}</strong><span v-if="active.unitPrice && active.quantity">（{{ active.unitPrice.amount }} × {{ active.quantity }} {{ active.kind === 'image' ? '张' : '条' }}）</span></p><p v-if="active.kind === 'image'" data-testid="studio-settlement">实际结算：<span v-if="active.billingState === 'billed' && active.settledPrice">{{ active.settledPrice.amount }} {{ active.settledPrice.currency }}（服务端原生结算）</span><span v-else-if="active.billingState === 'billed'">已结算，金额待服务端回执</span><span v-else-if="active.billingState === 'not_charged'">未收费</span><span v-else>待结算</span></p></div>
        <p v-if="active.status === 'prepared'" class="studio-quote-expiry">{{ expired ? '报价已失效，请重新获取报价并确认。' : `报价有效至 ${new Date(active.expiresAt).toLocaleString()}` }}</p>
        <p v-if="active.status === 'partial'" class="studio-partial" data-testid="studio-partial-counts">部分完成：请求 {{ active.expectedCount ?? active.quantity }} 张，已交付 {{ active.deliveredCount ?? active.resultCount }} 张，未完成 {{ (active.failedCount ?? 0) + (active.pendingCount ?? 0) }} 张。</p>
        <p v-if="['unknown','reserve_pending','recovery_blocked'].includes(active.status)" class="studio-notice">结果待确认。系统只查询原任务，不会自动再次生成或更换供应商。</p>
        <div v-if="hasResults(active)" class="studio-results" data-testid="studio-results">
          <figure v-for="i in active.resultCount" :key="`${active.id}-${i}`">
            <img :key="`image-${resultRead}-${i}`" v-if="active.kind === 'image'" :src="studioResultUrl(active,i-1)" :alt="`生成图片 ${i}`" data-testid="studio-result-image" @load="unavailableResults[`${active.id}-${i}`] = false" @error="unavailableResults[`${active.id}-${i}`] = true" />
            <video :key="`video-${resultRead}-${i}`" v-else :src="studioResultUrl(active,i-1)" controls preload="metadata" data-testid="studio-result-video" @loadedmetadata="unavailableResults[`${active.id}-${i}`] = false" @error="unavailableResults[`${active.id}-${i}`] = true" />
            <figcaption><span>原始结果 {{ i }}</span><span v-if="unavailableResults[`${active.id}-${i}`]" role="status" class="studio-result-unavailable">原片暂不可用，可能已过期</span><a v-else :href="studioResultUrl(active,i-1)" :download="`${active.id}-${i}`" data-testid="studio-download"><Icon name="download" />下载原片</a></figcaption>
          </figure>
        </div>
        <div class="studio-task-actions"><button v-if="active.status === 'prepared'" class="studio-button studio-primary" data-testid="studio-generate" :disabled="busy || !enabled || expired" @click="generate">确认报价并生成<Icon name="arrowUp" /></button><button class="studio-button" data-testid="studio-refresh" :disabled="querying || busy" @click="refresh"><Icon name="refresh" />查询原任务</button><button v-if="canStartNew" class="studio-button" data-testid="studio-new" :disabled="busy" @click="newTask">{{ active.status === 'prepared' ? '调整输入并重新报价' : '新建任务' }}</button></div>
        <details class="studio-task-id"><summary>任务详情</summary><p data-testid="studio-task-id">任务：{{ active.id }}</p></details>
      </section>
      <section v-show="!active" class="studio-composer-wrap" :class="{ 'has-task': !!active }" aria-label="创作输入">
        <p v-if="history.length || active" class="studio-composer-caption"><StudioMark /><span>{{ active ? '本次输入已冻结，调整输入请新建任务。' : '让想法有画面。' }}</span></p>
        <div class="studio-composer" ref="composerRoot" @keydown.esc="closeControl" @dragover.prevent @drop.prevent="drop">
          <fieldset :disabled="!!active">
            <legend class="studio-sr-only">{{ modeLabel }}创作设置</legend>
            <div class="studio-floating-model">
              <span v-if="!active" class="studio-lift" aria-hidden="true"><i></i><i></i></span>
              <button ref="modelTrigger" class="studio-model-trigger" :disabled="busy" data-testid="studio-model-toggle" :aria-expanded="openControl === 'model'" aria-controls="studio-model-menu" @click="toggleControl('model')"><span class="studio-model-dot"></span><span>{{ offer?.display_name || offer?.upstream_model || '选择模型' }}</span><Icon name="chevronDown" /></button>
              <Transition name="studio-pop"><div v-show="openControl === 'model'" class="studio-popover studio-model-menu" id="studio-model-menu"><label for="studio-offer">选择当前可用模型</label><select :disabled="busy" id="studio-offer" v-model="offerId" data-testid="studio-offer-select" :size="Math.max(2,Math.min(visibleOffers.length,5))" @change="selectOffer(); closeControl()"><option v-for="o in visibleOffers" :key="o.offer_id" :value="o.offer_id">{{ o.display_name || o.upstream_model }}{{ offerSpecs(o) }}</option></select><p v-if="!visibleOffers.length">暂无可用模型</p><button class="studio-text-button" @click="closeControl">收起<Icon name="chevronUp" /></button></div></Transition>
            </div>
            <div class="studio-writing"><label for="studio-prompt" class="studio-sr-only">提示词</label><textarea :disabled="busy" id="studio-prompt" ref="promptInput" v-model="prompt" :placeholder="imageMode === 'edit' && kind === 'image' ? '想怎样改变这张图？描述你的想法…' : '写下你想看到的画面…'" rows="2" data-testid="studio-prompt" /></div>
            <div v-if="showUploader" class="studio-asset-uploader" data-testid="studio-asset-uploader" @paste.stop="paste">
              <input ref="fileInput" type="file" :accept="accept" :disabled="!offer || !accept || busy || !!active" multiple class="studio-sr-only" data-testid="studio-asset-input" @change="upload" />
              <div v-if="uploads.length" class="studio-assets" data-testid="studio-assets"><div v-for="(item,i) in uploads" :key="item.id" class="studio-asset" :data-testid="`studio-asset-${item.status}`"><img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.file.name || `参考素材 ${i+1}`" data-testid="studio-asset-thumbnail" /><span v-else class="studio-asset-kind">{{ item.kind }}</span><span><strong>{{ item.file.name || `参考素材 ${i+1}` }}</strong><small v-if="item.status === 'pending'">上传中…</small><small v-else-if="item.status === 'success'">上传成功</small><small v-else>上传失败{{ item.error ? `：${item.error}` : '' }}</small></span><button type="button" :disabled="!!active" :data-testid="`studio-asset-remove-${item.id}`" aria-label="移除素材" @click="removeAsset(item)"><Icon name="x" /></button></div><button type="button" class="studio-text-button" :disabled="!!active" data-testid="studio-assets-clear" @click="clearAssets">清空全部</button></div>
            </div>
            <div class="studio-composer-bottom"><div class="studio-specs">
              <button v-if="showUploader" type="button" class="studio-attachment" data-testid="studio-attachment" :disabled="!offer || !accept || busy || !!active" :aria-label="kind === 'image' ? '添加参考图片' : '添加参考素材'" :title="accept ? '添加素材，也可拖入或粘贴图片' : '当前模型不支持参考素材'" @click="fileInput?.click()"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 13 6.5-6.5a2.8 2.8 0 0 1 4 4L10 19a4.3 4.3 0 0 1-6-6l9-9a1.4 1.4 0 0 1 2 2L6 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <div v-if="offer?.spec.aspect_ratio?.length" class="studio-ratio-control"><button ref="ratioTrigger" class="studio-chip" :disabled="busy" data-testid="studio-ratio-toggle" :aria-expanded="openControl === 'ratio'" aria-controls="studio-ratio-menu" @click="toggleControl('ratio')"><span class="studio-ratio-icon" :style="ratioShape(ratio)"></span>{{ ratio }}<Icon name="chevronDown" /></button><Transition name="studio-pop"><div v-if="openControl === 'ratio'" id="studio-ratio-menu" class="studio-popover studio-ratio-menu" role="group" aria-label="选择画面比例"><button v-for="r in offer.spec.aspect_ratio" :key="r" :aria-pressed="ratio === r" :class="{ chosen: ratio === r }" :data-ratio="r" @click="ratio = r; closeControl()"><span class="studio-ratio-icon" :style="ratioShape(r)"></span>{{ r }}</button></div></Transition></div>
              <label v-if="offer?.spec.resolution?.length" class="studio-chip">分辨率<select :disabled="busy" v-model="resolution" data-testid="studio-resolution"><option v-for="v in offer.spec.resolution" :key="v">{{ v }}</option></select></label>
              <label v-if="kind === 'image' && offer?.spec.quality?.length" class="studio-chip">画质<select :disabled="busy" v-model="quality"><option v-for="v in offer.spec.quality" :key="v">{{ v }}</option></select></label>
              <label v-if="kind === 'image'" class="studio-chip">数量<select :disabled="busy" v-model.number="count" data-testid="studio-count" :aria-invalid="invalidCount" :aria-describedby="invalidCount ? 'studio-count-error' : undefined"><option v-for="n in countOptions" :key="n" :value="n">{{ n }} 张</option></select></label>
              <label v-else class="studio-chip">时长<select :disabled="busy" v-model.number="duration" data-testid="studio-duration"><option v-for="v in offer?.spec.duration_seconds" :key="v" :value="v">{{ v }} 秒</option></select></label>
              <span class="studio-range">{{ kind === 'video' ? '每次 1 条视频' : countOptions.length ? `可选 ${countOptions[0]}–${countOptions[countOptions.length-1]} 张` : '' }}</span>
            </div><button v-if="!active" class="studio-button studio-primary studio-quote" :disabled="busy || !offer || incompatible || invalidCount || !prompt.trim()" data-testid="studio-quote" @click="quote">{{ busy ? '处理中…' : '开始生成' }}<Icon name="arrowUp" /></button></div>
          </fieldset>
        </div>
        <div class="studio-input-feedback"><p v-if="!visibleOffers.length">暂无可用模型：模型可能尚未配置、已暂停或没有访问权限{{ kind === 'image' && imageMode === 'edit' ? '，或不支持参考图' : '' }}。</p><p v-if="kind === 'image' && offer && invalidCount && !active" id="studio-count-error" role="alert" data-testid="studio-count-error">{{ countOptions.length ? `请选择商品允许的生成数量（${countOptions[0]}～${countOptions[countOptions.length-1]} 张）。` : '当前商品没有有效的数量范围，请选择其他商品或刷新目录。' }}</p><p v-if="offer && incompatible && !active" :role="kind === 'image' && imageMode === 'edit' && !assets.length ? undefined : 'alert'">{{ kind === 'image' && imageMode === 'edit' && !assets.length ? '点击回形针添加参考图，也可直接拖入或粘贴。' : '当前模型不支持这些素材类型或数量，请调整素材。' }}</p><p v-if="offer?.input_mode === 'references' && assets.length && !active">获取报价时会将引用素材上传到所选供应商，确认生成前不会创建生成任务。</p></div>
        <p class="studio-composer-hint">确认本次价格后生成 · {{ kind === 'video' ? '视频每次生成一条' : '结果自动保存到任务历史' }}</p>
      </section>
    </div>
  </section>
  <BaseDialog :show="quoteConfirm && active?.status === 'prepared'" title="确认本次生成" width="narrow" @close="quoteConfirm = false">
    <div v-if="active" class="studio-confirm">
      <p>{{ taskModel(active) }}</p><p class="studio-confirm-spec">{{ specText(active) }}</p>
      <p class="studio-confirm-total">{{ active.price.amount }} <span>{{ active.price.currency }}</span></p>
      <p v-if="active.unitPrice && active.quantity">单{{ active.kind === 'image' ? '张' : '条' }} {{ active.unitPrice.amount }} × {{ active.quantity }}</p>
      <p class="studio-confirm-note">价格由服务端锁定。{{ expired ? '报价已失效，请返回重新获取。' : '确认后开始生成。' }}</p>
      <p v-if="!enabled" class="studio-confirm-note">当前生成服务尚未开放。</p>
    </div>
    <template #footer><button class="studio-confirm-back" @click="newTask">返回修改</button><button class="studio-confirm-submit" data-testid="studio-confirm-generate" :disabled="busy || !enabled || expired" @click="generate">确认并生成</button></template>
  </BaseDialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ensureStudioSession, studioCatalog, studioRequest, studioTaskView, studioHistory, studioTask, studioGenerate, studioResultUrl, studioErrorMessage, StudioError, uploadStudioAsset, type StudioOffer, type StudioKind, type StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'
import Icon from '@/components/icons/Icon.vue'
import StudioMark from './StudioMark.vue'
import BaseDialog from '@/components/common/BaseDialog.vue'
import '@/styles/studio-workspace.css'
const kind=ref<StudioKind>('image'), offers=ref<StudioOffer[]>([]), offerId=ref('')
type UploadState = 'pending' | 'success' | 'failure'
type StudioAssetUpload = { id:string; file:File; kind:StudioAssetReceipt['kind']; status:UploadState; receipt?:StudioAssetReceipt; error?:string; previewUrl?:string; controller?:AbortController }
const uploads=ref<StudioAssetUpload[]>([])
const resolution=ref(''), ratio=ref(''), quality=ref(''), count=ref(1), duration=ref(5), prompt=ref('')
const busy=ref(false), querying=ref(false), historyLoading=ref(false), enabled=ref(false), error=ref(''), notice=ref(''), history=ref<StudioTask[]>([]), active=ref<StudioTask|null>(null), clock=ref(Date.now())
const imageMode=ref<'text'|'edit'>('text'), historyMode=ref(false), openControl=ref<'model'|'ratio'|null>(null)
const resultRead=ref(0)
const unavailableResults=ref<Record<string,boolean>>({})
const quoteConfirm=ref(false), fileInput=ref<HTMLInputElement|null>(null)
const taskDetail=ref<HTMLElement|null>(null)
function revealTask(){void nextTick(()=>taskDetail.value?.scrollIntoView?.({block:'nearest',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}))}
const composerRoot=ref<HTMLElement|null>(null), promptInput=ref<HTMLTextAreaElement|null>(null), modelTrigger=ref<HTMLButtonElement|null>(null), ratioTrigger=ref<HTMLButtonElement|null>(null)
const modeLabel=computed(()=>kind.value==='video' ? '视频创作' : imageMode.value==='edit' ? '图生图' : '文生图')
const visibleOffers=computed(()=>offers.value.filter(o=>kind.value==='video' || (imageMode.value==='edit' ? o.spec.references.image.max>0 && o.spec.references.total_max>0 : o.spec.references.image.min===0)))
const offer=computed(()=>visibleOffers.value.find(o=>o.offer_id===offerId.value))
const showUploader=computed(()=>kind.value==='video' || imageMode.value==='edit' || uploads.value.length>0)
const visibleHistory=computed(()=>historyMode.value?history.value:history.value.slice(0,3))
const canStartNew=computed(()=>!!active.value && ['prepared','completed','partial','failed','released'].includes(active.value.status))
const hasResults=(task:StudioTask)=>['completed','partial'].includes(task.status) && task.resultCount>0
const taskDate=(task:StudioTask)=>Number.isFinite(Date.parse(task.createdAt)) ? new Date(task.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}) : '时间待确认'
const offerSpecs=(o:StudioOffer)=>{const values=[...(o.spec.resolution||[]),...(o.spec.aspect_ratio||[])];return values.length ? ' · '+values.join(' / ') : ''}
const ratioShape=(r:string)=>{const match=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r);const n=match ? Number(match[1])/Number(match[2]) : 1;return {width:`${Math.round(17*Math.min(1,Number.isFinite(n)&&n>0?n:1))}px`,height:`${Math.round(17/Math.max(1,Number.isFinite(n)&&n>0?n:1))}px`}}
function imageUnavailable(event:Event){const image=event.target as HTMLImageElement;image.classList.add('unavailable');image.alt='预览暂不可用，请打开任务查看原片'}
async function toggleControl(which:'model'|'ratio'){if(busy.value||active.value)return;openControl.value=openControl.value===which?null:which;await nextTick();if(openControl.value)composerRoot.value?.querySelector<HTMLElement>(which==='model'?'#studio-offer':'#studio-ratio-menu button')?.focus()}
function closeControl(){const previous=openControl.value;openControl.value=null;void nextTick(()=>{(previous==='model'?modelTrigger:ratioTrigger).value?.focus()})}
function clickOutside(event:PointerEvent){if(openControl.value&&!composerRoot.value?.contains(event.target as Node))openControl.value=null}
function focusPrompt(){historyMode.value=false;void nextTick(()=>promptInput.value?.focus())}
async function changeMode(mode:'text'|'edit'|'video'){
 if(busy.value)return
 historyMode.value=false;openControl.value=null
 const nextKind=mode==='video'?'video':'image', sameKind=nextKind===kind.value
 if(sameKind&&active.value&&!canStartNew.value){notice.value='当前任务尚未完成，请查询原任务；不会重新生成。';return}
 if(sameKind&&active.value)newTask()
 imageMode.value=mode==='edit'?'edit':'text'
 if(!sameKind){kind.value=nextKind;await load();return}
 if(!visibleOffers.value.some(o=>o.offer_id===offerId.value)){offerId.value=visibleOffers.value[0]?.offer_id||'';selectOffer()}
 remember();focusPrompt()
}
const countOptions=computed(()=>{
 const range=offer.value?.spec.count
 if(!range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min<1 || range.max>10 || range.min>range.max)return []
 return Array.from({length:range.max-range.min+1},(_,i)=>range.min+i)
})
const invalidCount=computed(()=>kind.value==='image' && !countOptions.value.includes(count.value))
const accept=computed(()=>['image','video','audio'].filter(k=>offer.value?.spec.references[k as StudioAssetReceipt['kind']].max).map(k=>`${k}/*`).join(','))
const assets=computed(()=>uploads.value.flatMap(item=>item.receipt ? [item.receipt] : []))
const incompatible=computed(()=>!offer.value || kind.value==='image' && (imageMode.value==='edit' ? !assets.value.some(a=>a.kind==='image') : assets.value.length>0) || ['image','video','audio'].some(k=>{const n=assets.value.filter(a=>a.kind===k).length;const r=offer.value!.spec.references[k as StudioAssetReceipt['kind']];return n<r.min || n>r.max}) || assets.value.length>offer.value.spec.references.total_max)
const expired=computed(()=>!active.value || !Number.isFinite(Date.parse(active.value.expiresAt)) || clock.value>=Date.parse(active.value.expiresAt))
let storage='', attempted=new Set<string>(), intent:{fingerprint:string;clientKey:string;preparationId?:string;quoteToken?:string}|undefined
let generation=0, timer:ReturnType<typeof setInterval>|undefined, polling=false, mounted=true
const statuses:Record<string,string>={prepared:'报价已冻结，等待确认生成',processing:'生成中',queued:'排队中',completed:'生成完成，原始结果已保存',partial:'部分完成',unknown:'结果待确认',billing_pending:'结果已保存，结算待确认',failed:'生成失败',released:'生成失败，费用已释放',reserve_pending:'结果待确认：费用预占处理中，请查询原任务',recovery_blocked:'结果待确认：原任务身份暂不可用，恢复受阻'}
const statusText=(status:string)=>statuses[status]||'结果待确认'
const taskModel=(task:StudioTask)=>offers.value.find(o=>o.offer_id===task.offerId)?.display_name||(!/^media[-_]/.test(task.model)?task.model:'')||'已保存的创作'
const specText=(task:StudioTask)=>[task.spec.resolution,task.spec.aspect_ratio,task.spec.duration_seconds?`${task.spec.duration_seconds}秒`:'',`${task.spec.count??1}${task.kind==='image'?'张':'条'}`].filter(Boolean).join(' / ')
function remember(){if(storage)sessionStorage.setItem(storage,JSON.stringify({kind:kind.value,imageMode:imageMode.value,id:active.value?.id,attempted:[...attempted]}))}
function accepted(task:StudioTask){if(task.status==='prepared'&&attempted.has(task.id))task={...task,status:'unknown'};active.value=task;resultRead.value++;history.value=[task,...history.value.filter(t=>t.id!==task.id)];remember()}
function selectOffer(){const s=offer.value?.spec;resolution.value=s?.resolution?.[0]||'';ratio.value=s?.aspect_ratio?.[0]||'';quality.value=s?.quality?.[0]||'';duration.value=s?.duration_seconds?.[0]||0;count.value=kind.value==='image' ? countOptions.value[0]??1 : 1;intent=undefined}
function newTask(){if(busy.value || !active.value || !['prepared','completed','partial','failed','released'].includes(active.value.status))return;quoteConfirm.value=false;active.value=null;intent=undefined;error.value='';notice.value='';historyMode.value=false;remember();focusPrompt()}
async function load(selectedId?:unknown){const epoch=++generation;busy.value=true;error.value='';active.value=null;enabled.value=false;offers.value=[];history.value=[];try{
 const [catalog,tasks,readiness]=await Promise.allSettled([studioCatalog(kind.value),studioHistory(kind.value),studioRequest<{paid_enabled:boolean}>(kind.value,'readiness')]);
 if(epoch!==generation)return;
 if(catalog.status==='fulfilled')offers.value=catalog.value;
 if(readiness.status==='fulfilled')enabled.value=readiness.value.paid_enabled===true;
 if(tasks.status==='rejected')throw tasks.reason;
 history.value=tasks.value;
 if(catalog.status==='rejected'||readiness.status==='rejected')notice.value='目录或生成服务暂不可用，仍可查询原任务和已保存结果。';
 if(!visibleOffers.value.some(o=>o.offer_id===offerId.value)){offerId.value=visibleOffers.value[0]?.offer_id||'';selectOffer()}
 const restored=history.value.find(t=>t.id===selectedId)||history.value.find(t=>!['completed','partial','failed','released'].includes(t.status))||(catalog.status==='rejected'?history.value[0]:undefined);if(restored)accepted(restored);remember()
 }catch(e){error.value=studioErrorMessage(e)}finally{if(epoch===generation)busy.value=false}
 if(active.value)await refresh()
}
async function reloadHistory(){if(busy.value||historyLoading.value)return;const epoch=generation,originalKind=kind.value;historyLoading.value=true;try{const tasks=await studioHistory(originalKind);if(epoch===generation&&originalKind===kind.value)history.value=tasks}catch(e){if(epoch===generation)error.value=studioErrorMessage(e)}finally{historyLoading.value=false}}
async function selectTask(task:StudioTask){if(busy.value)return;error.value='';accepted(task);revealTask();await refresh()}
async function refresh(){if(!active.value||querying.value)return;const original=active.value;querying.value=true;try{const task=await studioTask(original);if(active.value?.id===original.id&&kind.value===original.kind){accepted(task);error.value=''}}catch(e){if(active.value?.id===original.id)error.value=studioErrorMessage(e)}finally{querying.value=false;if(mounted&&active.value&&active.value.id!==original.id)void refresh()}}
function assetKind(file:File):StudioAssetReceipt['kind']|undefined{const value=file.type.split('/')[0];return ['image','video','audio'].includes(value) ? value as StudioAssetReceipt['kind'] : undefined}
function assetError(error:unknown){
 if(error instanceof Error){
  if(error.message==='invalid_local_asset')return '素材类型或大小不符合限制。'
  if(error.message==='file_changed')return '文件发生变化，未上传。'
 }
 return error instanceof StudioError && error.code==='asset_type_mismatch' ? '素材类型不受支持。' : studioErrorMessage(error)
}
function assetPreview(file:File){return file.type.startsWith('image/') && typeof URL.createObjectURL==='function' ? URL.createObjectURL(file) : undefined}
function activeUploadCount(kind:StudioAssetReceipt['kind']){return uploads.value.filter(item=>item.kind===kind && item.status!=='failure').length}
function revokePreview(item:StudioAssetUpload){if(item.previewUrl&&typeof URL.revokeObjectURL==='function')URL.revokeObjectURL(item.previewUrl)}
function removeAsset(item:StudioAssetUpload){if(active.value)return;item.controller?.abort();revokePreview(item);uploads.value=uploads.value.filter(candidate=>candidate.id!==item.id)}
function clearAssets(){if(active.value)return;uploads.value.forEach(item=>{item.controller?.abort();revokePreview(item)});uploads.value=[];notice.value='';error.value='';intent=undefined}
function addUpload(file:File):StudioAssetUpload{
 const kind=assetKind(file), item:StudioAssetUpload={id:crypto.randomUUID(),file,kind:kind||'image',status:'failure',previewUrl:assetPreview(file)}
 if(!offer.value){item.error='请先选择模型。';uploads.value.push(item);return item}
 if(!kind){item.error='素材类型不受支持。';uploads.value.push(item);return item}
 const rule=offer.value.spec.references[kind]
 if(!rule.max || activeUploadCount(kind)>=rule.max || uploads.value.filter(candidate=>candidate.status!=='failure').length>=offer.value.spec.references.total_max){item.error='已达到该模型的素材数量上限。';uploads.value.push(item);return item}
 item.status='pending';uploads.value.push(item);return item
}
function currentUpload(item:StudioAssetUpload){return uploads.value.find(candidate=>candidate.id===item.id)}
async function uploadOne(item:StudioAssetUpload){const current=currentUpload(item);if(!mounted||!current||current.status!=='pending')return;const controller=new AbortController();current.controller=controller;try{
 await ensureStudioSession();if(!mounted||currentUpload(item)!==current||controller.signal.aborted)return;const receipt=await uploadStudioAsset(current.file,current.kind,controller.signal);if(!mounted||currentUpload(item)!==current||controller.signal.aborted)return;current.receipt=receipt;current.status='success';notice.value='素材已私有保存，顺序如上。'
 }catch(e){if(!mounted||currentUpload(item)!==current||controller.signal.aborted||e instanceof DOMException&&e.name==='AbortError')return;current.status='failure';current.error=assetError(e);error.value=current.error;notice.value=''}}
async function enqueueFiles(files:File[]){if(!files.length||busy.value||active.value)return;if(kind.value==='image'&&offer.value?.spec.references.image.max){imageMode.value='edit'}busy.value=true;error.value='';notice.value='素材上传中…';const pending=files.map(addUpload).filter(item=>item.status==='pending');try{await Promise.all(pending.map(uploadOne))}finally{if(mounted){busy.value=false;if(!uploads.value.some(item=>item.status==='pending'))notice.value=uploads.value.some(item=>item.status==='success')?'素材已私有保存，顺序如上。':'';}}}
function upload(e:Event){const input=e.target as HTMLInputElement;void enqueueFiles(Array.from(input.files||[]));input.value=''}
function drop(e:DragEvent){void enqueueFiles(Array.from(e.dataTransfer?.files||[]))}
function paste(event:Event){const e=event as ClipboardEvent;const files=Array.from(e.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);const fallback=files.length?files:Array.from(e.clipboardData?.files||[]).filter(file=>file.type.startsWith('image/'));if(fallback.length)void enqueueFiles(fallback)}
async function quote(){if(busy.value||active.value||!offer.value||incompatible.value||invalidCount.value||!prompt.value.trim())return;busy.value=true;openControl.value=null;error.value='';notice.value='';try{
 const o=offer.value,refs=assets.value.map(a=>({kind:a.kind,asset_ref:a.asset_ref})),spec={resolution:resolution.value,aspect_ratio:ratio.value,duration_seconds:kind.value==='video'?duration.value:0,quality:kind.value==='image'?quality.value:'',count:kind.value==='image'?count.value:1,images:refs.filter(a=>a.kind==='image').length,videos:refs.filter(a=>a.kind==='video').length,audio:refs.filter(a=>a.kind==='audio').length}
 const fingerprint=JSON.stringify({kind:kind.value,offer:o.offer_id,spec,refs,prompt:prompt.value});if(intent?.fingerprint!==fingerprint)intent={fingerprint,clientKey:crypto.randomUUID()}
 if(kind.value==='video'){
   if(o.input_mode==='references'&&assets.value.length&&!intent.preparationId){const p=await studioRequest<{preparation_id:string}>('video','prepare',{offer_id:o.offer_id,model:o.model,spec,assets:refs});if(typeof p.preparation_id!=='string')throw new StudioError('studio_contract');intent.preparationId=p.preparation_id}
   accepted(studioTaskView('video',await studioRequest('video','quotes',{client_key:intent.clientKey,offer_id:o.offer_id,model:o.model,prompt:prompt.value,duration:spec.duration_seconds,resolution:spec.resolution,ratio:spec.aspect_ratio,assets:refs,...(intent.preparationId?{preparation_id:intent.preparationId}:{})})))
 }else{
   if(!intent.quoteToken){const q=await studioRequest<{quote_token:string}>('image','quotes',{offer_id:o.offer_id,spec});if(typeof q.quote_token!=='string')throw new StudioError('studio_contract');intent.quoteToken=q.quote_token}
   accepted(studioTaskView('image',await studioRequest('image','prepare',{quote_token:intent.quoteToken,client_key:intent.clientKey,prompt:prompt.value,asset_refs:refs.map(a=>a.asset_ref)})))
 }
 if(active.value){quoteConfirm.value=true;revealTask()}
 }catch(e){error.value=studioErrorMessage(e);history.value=await studioHistory(kind.value).catch(()=>history.value)}finally{busy.value=false}}
async function generate(){if(busy.value||!active.value||active.value.status!=='prepared'||!enabled.value||expired.value)return;
 const task=active.value;quoteConfirm.value=false;busy.value=true;error.value='';attempted.add(task.id);accepted({...task,status:'unknown'});
 try{accepted(await studioGenerate(task))}catch(e){if(e instanceof StudioError&&(e.code.includes('paid_gate_off')||e.code.endsWith('quote_expired'))){attempted.delete(task.id);accepted(task)}error.value=studioErrorMessage(e)}finally{busy.value=false}
}
onMounted(async()=>{window.addEventListener('paste',paste);window.addEventListener('pointerdown',clickOutside);try{const session=await ensureStudioSession();storage=`studio-media-view-${session.owner_id}`;let selected:unknown;try{const raw=JSON.parse(sessionStorage.getItem(storage)||'{}');if(raw.kind==='image'||raw.kind==='video')kind.value=raw.kind;if(raw.imageMode==='edit')imageMode.value='edit';selected=raw.id;if(Array.isArray(raw.attempted))attempted=new Set(raw.attempted.filter((id:unknown)=>typeof id==='string'))}catch{/* Server history remains authoritative. */}await load(selected)}catch(e){error.value=studioErrorMessage(e)}
 if(mounted)timer=setInterval(()=>{clock.value=Date.now();if(!polling&&!busy.value&&active.value&&['unknown','processing','queued','billing_pending'].includes(active.value.status)){polling=true;void refresh().finally(()=>{polling=false})}},3000)
})
onUnmounted(()=>{mounted=false;generation++;if(timer)clearInterval(timer);window.removeEventListener('paste',paste);window.removeEventListener('pointerdown',clickOutside);uploads.value.forEach(item=>{item.controller?.abort();revokePreview(item)})})
</script>

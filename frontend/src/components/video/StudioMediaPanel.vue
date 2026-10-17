<template>
  <section class="studio-workspace" :class="{ 'is-history': historyMode }" data-testid="studio-media-panel">
    <aside class="studio-rail" aria-label="创作工作台导航">
      <a href="/dashboard" class="studio-brand-mark" aria-label="AI Gateway，返回控制台"><StudioMark /></a>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'text' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'text'" :disabled="busy" data-testid="studio-mode-text" @click="changeMode('text')"><Icon name="grid" /><span>文生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'edit' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'edit'" :disabled="busy" data-testid="studio-mode-edit" @click="changeMode('edit')"><Icon name="edit" /><span>图生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'video' }" :aria-pressed="!historyMode && kind === 'video'" :disabled="busy" data-testid="studio-mode-video" @click="changeMode('video')"><Icon name="play" /><span>视频</span></button>
      <button class="studio-history-nav" :class="{ selected: historyMode }" :aria-pressed="historyMode" :disabled="busy" data-testid="studio-mode-history" @click="openHistory"><Icon name="clock" /><span>任务历史</span></button>
      <a href="/dashboard" class="studio-dashboard"><Icon name="arrowLeft" /><span>控制台</span></a>
    </aside>
    <div class="studio-main">
      <header class="studio-header">
        <div><h1><a href="/dashboard" aria-label="AI Gateway，返回控制台">AI Gateway</a> <span>{{ historyMode ? '任务历史' : modeLabel }}</span></h1><p class="studio-mobile-tagline">让想法有画面。</p></div>
        <div v-if="!active && historyMode" class="studio-new-menu-wrap"><button class="studio-button studio-header-new" :disabled="busy" :aria-expanded="createMenuOpen" data-testid="studio-header-new" @click="createMenuOpen = !createMenuOpen"><Icon name="plus" />新建创作</button><div v-if="createMenuOpen" class="studio-new-menu" role="menu"><button role="menuitem" @click="startNew('text')"><Icon name="grid" />文生图</button><button role="menuitem" @click="startNew('edit')"><Icon name="edit" />图生图</button><button role="menuitem" @click="startNew('video')"><Icon name="play" />视频</button></div></div>
        <button v-else-if="!active" class="studio-button studio-header-new" :disabled="busy" data-testid="studio-header-new" @click="focusPrompt"><Icon name="plus" />开始创作</button>
        <button v-else-if="canStartNew" class="studio-button studio-header-new" :disabled="busy" @click="newTask"><Icon name="plus" />继续创作</button>
      </header>
      <div class="studio-section-heading">
        <h2>{{ historyMode ? '我的任务' : '最近的创作' }}<span v-if="displayHistory.length">{{ displayHistory.length }}</span></h2>
        <div class="studio-history-tools"><button class="studio-text-button" data-testid="studio-refresh-models" :disabled="busy || catalogLoading" @click="refreshCatalog"><Icon name="refresh" :class="{ spinning: catalogLoading }" />刷新模型</button><button v-if="failedHistoryCount" class="studio-failed-toggle" :aria-pressed="showFailed" data-testid="studio-failed-toggle" @click="showFailed = !showFailed">{{ showFailed ? '隐藏失败任务' : '显示失败任务' }}（{{ failedHistoryCount }}）</button><button v-if="!historyMode && history.length > 2" class="studio-text-button" @click="openHistory">全部任务<Icon name="arrowRight" /></button><label v-if="historyMode" class="studio-kind-filter"><span>历史类型</span><select :disabled="busy || historyLoading" v-model="historyFilter" data-testid="studio-kind" @change="loadHistory"><option value="all">全部（图片 + 视频）</option><option value="image">仅图片</option><option value="video">仅视频</option></select></label><button class="studio-text-button" :disabled="busy || querying || historyLoading" @click="reloadHistory"><Icon name="refresh" :class="{ spinning: historyLoading }" />刷新记录</button></div>
      </div>
      <p v-if="historyMode ? historyFilter !== 'video' : kind === 'image'" class="studio-retention-note">图片及普通历史通常保留72小时，请及时下载；未决任务与既有保留承诺按实际状态处理。</p>
      <div v-if="displayHistory.length" class="studio-gallery" data-testid="studio-history">
        <button v-for="task in displayHistory" :key="task.id" class="studio-work" :class="{ 'is-selected': active?.id === task.id }" :disabled="busy" :data-task-id="task.id" @click="selectTask(task)">
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
      <div v-else class="studio-empty" data-testid="studio-empty"><StudioMark /><h2>{{ historyLoading || busy ? '正在读取工作台…' : historyMode && history.length ? '当前没有可显示的任务' : historyMode ? '还没有历史任务' : '让想法有画面。' }}</h2><p>{{ historyMode && history.length ? (failedHistoryCount ? '失败任务已隐藏，点击上方按钮查看。' : '任务仍在生成、恢复或结算中。') : historyMode ? '完成创作后，你可以在这里查看状态和下载作品。' : '写下描述，开始创作。' }}</p></div>
      <p v-if="selectionUnavailable || activeQuoteUnavailable" role="status" class="studio-notice" data-testid="studio-model-unavailable">此模型暂不可用，请选择其他模型</p>
      <p v-if="notice" role="status" class="studio-notice">{{ notice }}</p>
      <p v-if="error" role="alert" class="studio-error" data-testid="studio-error">{{ error }}</p>
      <p v-if="readinessState === 'disabled'" class="studio-gate" data-testid="studio-gate"><Icon name="infoCircle" />当前生成服务未开放，仍可查看报价和已有结果。</p>
      <section v-if="active" ref="taskDetail" class="studio-task-detail" data-testid="studio-task" aria-label="当前任务">
        <div class="studio-task-heading"><div><h2>{{ taskModel(active) }}</h2><p>已冻结：{{ specText(active) }}</p></div><span class="studio-status" :class="`status-${active.status}`" data-testid="studio-status" aria-live="polite">{{ submitting[active.id] ? '提交处理中' : statusText(active.status) }}</span></div>
        <div class="studio-price-line"><p data-testid="studio-price">冻结报价 <strong>{{ active.price.amount }} {{ active.price.currency }}</strong><span v-if="active.unitPrice && active.quantity">（{{ active.unitPrice.amount }} × {{ active.quantity }} {{ active.kind === 'image' ? '张' : '条' }}）</span></p><p v-if="active.kind === 'image'" data-testid="studio-settlement">实际结算：<span v-if="active.billingState === 'billed' && active.settledPrice">{{ active.settledPrice.amount }} {{ active.settledPrice.currency }}（服务端原生结算）</span><span v-else-if="active.billingState === 'billed'">已结算，金额待服务端回执</span><span v-else-if="active.billingState === 'not_charged'">未收费</span><span v-else>待结算</span></p></div>
        <p v-if="active.status === 'prepared'" class="studio-quote-expiry">{{ expired ? '报价已失效，请重新获取报价并确认。' : `报价有效至 ${new Date(active.expiresAt).toLocaleString()}` }}</p>
        <p v-if="active.status === 'partial'" class="studio-partial" data-testid="studio-partial-counts">部分完成：请求 {{ active.expectedCount ?? active.quantity }} 张，已交付 {{ active.deliveredCount ?? active.resultCount }} 张，未完成 {{ (active.failedCount ?? 0) + (active.pendingCount ?? 0) }} 张。</p>
        <div v-if="waiting" class="studio-waiting" data-testid="studio-waiting" :class="{ 'is-uncertain': uncertain && !submitting[active.id] }">
          <Icon :name="submitting[active.id] || !uncertain ? 'refresh' : 'infoCircle'" :class="{ spinning: submitting[active.id] || !uncertain }" />
          <div><strong>{{ submitting[active.id] ? '提交处理中' : statusText(active.status) }}</strong><p>{{ waitingMessage }}</p><small data-testid="studio-elapsed">{{ submitting[active.id] ? '本次提交已等待' : '距任务创建' }} {{ elapsedText }}。可以继续创作，原任务保留在历史记录中。</small></div>
        </div>
        <p v-if="['failed','released'].includes(active.status)" role="alert" class="studio-error">{{ active.billingState === 'not_charged' ? '生成失败，未收费。' : active.status === 'released' ? '本次生成未成功，服务端报告费用已释放。' : '本次生成未成功；费用状态以实际结算回执为准。' }}原任务已保留，不会自动再次生成。</p>
        <p v-if="active.failureCode === 'upstream_http_502_no_delivery'" class="studio-error" data-testid="studio-http-failure">图片服务返回 HTTP 502，未取得图片的执行单元已终结，不会补扣这些单元的费用。已交付作品仍按实际结算回执计费。</p>
        <p v-if="taskFeedback?.message" role="status" class="studio-query-feedback" data-testid="studio-query-feedback"><time :datetime="new Date(taskFeedback.at).toISOString()">{{ new Date(taskFeedback.at).toLocaleTimeString() }}</time> · {{ taskFeedback.message }}</p>
        <p v-if="taskFeedback?.error" role="alert" class="studio-error" data-testid="studio-query-error">{{ taskFeedback.error }}</p>
        <div v-if="hasResults(active)" class="studio-results" data-testid="studio-results">
          <figure v-for="i in active.resultCount" :key="`${active.id}-${i}`">
            <div class="studio-result-stage" :class="{ 'is-image': active.kind === 'image' }">
              <span v-if="loadingResults[`${active.id}-${i}`]" class="studio-result-loading" role="status">正在加载已保存原片…</span>
              <img :key="`image-${resultRead}-${i}`" v-if="active.kind === 'image'" :src="studioResultUrl(active,i-1)" :alt="`生成图片 ${i}`" data-testid="studio-result-image" @load="resultLoaded(active,i)" @error="resultUnavailable(active,i)" />
              <video :key="`video-${resultRead}-${i}`" v-else :src="studioResultUrl(active,i-1)" controls preload="metadata" data-testid="studio-result-video" @loadedmetadata="unavailableResults[`${active.id}-${i}`] = false" @error="unavailableResults[`${active.id}-${i}`] = true" />
            </div>
            <figcaption><span class="studio-result-label">原始结果 {{ i }}</span><span v-if="unavailableResults[`${active.id}-${i}`]" role="status" class="studio-result-unavailable">原片暂不可用，可能已过期</span><a v-else class="studio-download" :href="studioResultUrl(active,i-1)" :download="`${active.id}-${i}`" data-testid="studio-download"><Icon name="download" /><span>下载原片</span></a></figcaption>
          </figure>
        </div>
        <div class="studio-task-actions"><button v-if="active.status === 'prepared'" class="studio-button studio-primary" data-testid="studio-generate" :disabled="busy || catalogLoading || !enabled || expired || activeQuoteUnavailable" @click="generate">确认报价并生成<Icon name="arrowUp" /></button><button class="studio-button" data-testid="studio-refresh" :disabled="querying || busy || !!submitting[active.id]" :aria-busy="querying" @click="refresh()"><Icon name="refresh" :class="{ spinning: querying }" />{{ querying ? '查询中…' : '查询原任务' }}</button><button v-if="canStartNew" class="studio-button" data-testid="studio-new" :disabled="busy" @click="newTask">{{ active.status === 'prepared' ? '调整输入并重新报价' : '继续创作' }}</button></div>
        <details class="studio-task-id"><summary>任务详情</summary><p data-testid="studio-task-id">任务：{{ active.id }}</p></details>
      </section>
      <section v-show="!active" class="studio-composer-wrap" :class="{ 'has-task': !!active }" aria-label="创作输入">
        <p v-if="history.length || active" class="studio-composer-caption"><StudioMark /><span>{{ active ? '本次输入已冻结，调整输入请新建任务。' : '让想法有画面。' }}</span></p>
        <div class="studio-composer" ref="composerRoot" @keydown.esc="closeControl" @dragover.prevent @drop.prevent="drop">
          <fieldset :disabled="!!active">
            <legend class="studio-sr-only">{{ modeLabel }}创作设置</legend>
            <div class="studio-floating-model" :class="{ 'model-open': openControl === 'model' }">
              <span v-if="!active" class="studio-lift" aria-hidden="true"><i></i><i></i></span>
              <button ref="modelTrigger" class="studio-model-trigger" :disabled="busy" data-testid="studio-model-toggle" :aria-expanded="openControl === 'model'" aria-controls="studio-model-menu" @click="toggleControl('model')"><span class="studio-model-dot"></span><span>{{ offer?.display_name || offer?.upstream_model || '选择模型' }}</span><Icon name="chevronDown" /></button>
              <Transition name="studio-pop"><div v-show="openControl === 'model'" class="studio-popover studio-model-menu" id="studio-model-menu"><StudioModelPicker v-if="openControl === 'model'" :offers="visibleOffers" :model-value="offerId" :disabled="busy" @select="offerId = $event; selectOffer(); closeControl()" /><button class="studio-text-button" @click="closeControl">收起<Icon name="chevronUp" /></button></div></Transition>
            </div>
            <div class="studio-writing"><label for="studio-prompt" class="studio-sr-only">提示词</label><textarea :disabled="busy" id="studio-prompt" ref="promptInput" v-model="prompt" :placeholder="imageMode === 'edit' && kind === 'image' ? '想怎样改变这张图？描述你的想法…' : '写下你想看到的画面…'" rows="2" data-testid="studio-prompt" /></div>
            <div v-if="showUploader" class="studio-asset-uploader" data-testid="studio-asset-uploader" @paste.stop="paste">
              <input ref="fileInput" type="file" :accept="accept" :disabled="!offer || !accept || busy || !!active" multiple class="studio-sr-only" data-testid="studio-asset-input" @change="upload" />
              <div v-if="uploads.length" class="studio-assets" data-testid="studio-assets"><div v-for="(item,i) in uploads" :key="item.id" class="studio-asset" :data-testid="`studio-asset-${item.status}`"><img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.file.name || `参考素材 ${i+1}`" data-testid="studio-asset-thumbnail" /><span v-else class="studio-asset-kind">{{ item.kind }}</span><span><strong>{{ item.file.name || `参考素材 ${i+1}` }}</strong><small v-if="item.status === 'pending'">上传中…</small><small v-else-if="item.status === 'success'">上传成功</small><small v-else>上传失败{{ item.error ? `：${item.error}` : '' }}</small></span><button type="button" :disabled="!!active" :data-testid="`studio-asset-remove-${item.id}`" aria-label="移除素材" @click="removeAsset(item)"><Icon name="x" /></button></div><button type="button" class="studio-text-button" :disabled="!!active" data-testid="studio-assets-clear" @click="clearAssets">清空全部</button></div>
            </div>
            <div class="studio-composer-bottom"><div class="studio-specs">
              <button v-if="showUploader" type="button" class="studio-attachment" data-testid="studio-attachment" :disabled="!offer || !accept || busy || !!active" :aria-label="kind === 'image' ? '添加参考图片' : '添加参考素材'" :title="accept ? '添加素材，也可拖入或粘贴图片' : '当前模型不支持参考素材'" @click="fileInput?.click()"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 13 6.5-6.5a2.8 2.8 0 0 1 4 4L10 19a4.3 4.3 0 0 1-6-6l9-9a1.4 1.4 0 0 1 2 2L6 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <div v-if="offer?.spec.aspect_ratio?.length" class="studio-ratio-control"><button ref="ratioTrigger" class="studio-chip" :disabled="busy" data-testid="studio-ratio-toggle" :aria-expanded="openControl === 'ratio'" aria-controls="studio-ratio-menu" @click="toggleControl('ratio')"><span class="studio-ratio-icon" :style="ratioShape(ratio)"></span>{{ ratio }}<Icon name="chevronDown" /></button><Transition name="studio-pop"><div v-if="openControl === 'ratio'" id="studio-ratio-menu" class="studio-popover studio-ratio-menu" role="group" aria-label="选择画面比例"><button v-for="r in offer.spec.aspect_ratio" :key="r" :aria-pressed="ratio === r" :class="{ chosen: ratio === r }" :data-ratio="r" @click="ratio = r; closeControl()"><span class="studio-ratio-icon" :style="ratioShape(r)"></span>{{ r }}</button></div></Transition></div>
              <StudioSpecPicker v-if="offer?.spec.resolution?.length" id="studio-resolution" label="分辨率" :model-value="resolution" :options="offer.spec.resolution" :disabled="busy" :open="openControl === 'resolution'" @update:model-value="resolution = String($event)" @update:open="openControl = $event ? 'resolution' : null" />
              <StudioSpecPicker v-if="kind === 'image' && offer?.spec.quality?.length" id="studio-quality" label="画质" :model-value="quality" :options="offer.spec.quality" :disabled="busy" :open="openControl === 'quality'" @update:model-value="quality = String($event)" @update:open="openControl = $event ? 'quality' : null" />
              <StudioSpecPicker v-if="kind === 'image'" id="studio-count" label="数量" unit="张" :columns="5" :model-value="count" :options="countOptions" :disabled="busy" :invalid="invalidCount" :describedby="invalidCount ? 'studio-count-error' : undefined" :open="openControl === 'count'" @update:model-value="count = Number($event)" @update:open="openControl = $event ? 'count' : null" />
              <StudioSpecPicker v-else id="studio-duration" label="时长" unit="秒" :model-value="duration" :options="offer?.spec.duration_seconds || []" :disabled="busy" :open="openControl === 'duration'" @update:model-value="duration = Number($event)" @update:open="openControl = $event ? 'duration' : null" />
              <span class="studio-range">{{ kind === 'video' ? '每次 1 条视频' : countOptions.length ? `可选 ${countOptions[0]}–${countOptions[countOptions.length-1]} 张` : '' }}</span>
            </div><button v-if="!active" class="studio-button studio-primary studio-quote" :disabled="busy || catalogLoading || selectionUnavailable || !offer || incompatible || invalidCount || !prompt.trim()" data-testid="studio-quote" @click="quote">{{ busy ? '处理中…' : '开始生成' }}<Icon name="arrowUp" /></button></div>
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
    <template #footer><button class="studio-confirm-back" @click="newTask">返回修改</button><button class="studio-confirm-submit" data-testid="studio-confirm-generate" :disabled="busy || catalogLoading || !enabled || expired || activeQuoteUnavailable" @click="generate">确认并生成</button></template>
  </BaseDialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ensureStudioSession, studioCatalog, studioRequest, studioTaskView, studioHistory, studioTask, studioGenerate, studioResultUrl, studioErrorMessage, StudioError, uploadStudioAsset, type StudioOffer, type StudioKind, type StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'
import Icon from '@/components/icons/Icon.vue'
import StudioMark from './StudioMark.vue'
import StudioSpecPicker from './StudioSpecPicker.vue'
import StudioModelPicker from './StudioModelPicker.vue'
import BaseDialog from '@/components/common/BaseDialog.vue'
import '@/styles/studio-workspace.css'
const kind=ref<StudioKind>('image'), offers=ref<StudioOffer[]>([]), offerId=ref('')
type UploadState = 'pending' | 'success' | 'failure'
type StudioAssetUpload = { id:string; file:File; kind:StudioAssetReceipt['kind']; status:UploadState; receipt?:StudioAssetReceipt; error?:string; previewUrl?:string; controller?:AbortController }
const uploads=ref<StudioAssetUpload[]>([])
const resolution=ref(''), ratio=ref(''), quality=ref(''), count=ref(1), duration=ref(5), prompt=ref('')
const busy=ref(false), querying=ref(false), historyLoading=ref(false), enabled=ref(false), readinessState=ref<'unknown'|'enabled'|'disabled'>('unknown'), error=ref(''), notice=ref(''), history=ref<StudioTask[]>([]), active=ref<StudioTask|null>(null), clock=ref(Date.now())
type HistoryFilter = 'all'|'image'|'video'
const imageMode=ref<'text'|'edit'>('text'), historyMode=ref(false), historyFilter=ref<HistoryFilter>('all'), createMenuOpen=ref(false), showFailed=ref(false), openControl=ref<'model'|'ratio'|'resolution'|'quality'|'count'|'duration'|null>(null)
const resultRead=ref(0)
const catalogLoading=ref(false), unavailableOffers=ref(new Set<string>()), invalidatedQuotes=ref(new Set<string>())
const selectionUnavailable=computed(()=>unavailableOffers.value.has(`${kind.value}:${offerId.value}`))
const activeQuoteUnavailable=computed(()=>!!active.value && active.value.status==='prepared' && (invalidatedQuotes.value.has(active.value.id)||unavailableOffers.value.has(`${active.value.kind}:${active.value.offerId}`)))
const unavailableResults=ref<Record<string,boolean>>({})
const loadingResults=ref<Record<string,boolean>>({})
const quoteConfirm=ref(false), fileInput=ref<HTMLInputElement|null>(null)
const taskDetail=ref<HTMLElement|null>(null)
function revealTask(){void nextTick(()=>taskDetail.value?.scrollIntoView?.({block:'nearest',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}))}
const composerRoot=ref<HTMLElement|null>(null), promptInput=ref<HTMLTextAreaElement|null>(null), modelTrigger=ref<HTMLButtonElement|null>(null), ratioTrigger=ref<HTMLButtonElement|null>(null)
const modeLabel=computed(()=>kind.value==='video' ? '视频创作' : imageMode.value==='edit' ? '图生图' : '文生图')
const visibleOffers=computed(()=>offers.value.filter(o=>kind.value==='video' || (imageMode.value==='edit' ? o.spec.references.image.max>0 && o.spec.references.total_max>0 : o.spec.references.image.min===0)))
const offer=computed(()=>visibleOffers.value.find(o=>o.offer_id===offerId.value))
const showUploader=computed(()=>kind.value==='video' || imageMode.value==='edit' || uploads.value.length>0)
const isFailedTask=(task:StudioTask)=>['failed','released'].includes(task.status) && typeof task.billingState === 'string' && ['billed','not_charged'].includes(task.billingState)
const historyScope=computed(()=>historyMode.value&&historyFilter.value!=='all'?history.value.filter(task=>task.kind===historyFilter.value):history.value)
const failedHistoryCount=computed(()=>historyScope.value.filter(isFailedTask).length)
const filteredHistory=computed(()=>showFailed.value ? historyScope.value : historyScope.value.filter(task=>!isFailedTask(task)))
const displayHistory=computed(()=>historyMode.value?filteredHistory.value:filteredHistory.value.slice(0,3))
const canStartNew=computed(()=>!!active.value)
const hasResults=(task:StudioTask)=>['completed','partial'].includes(task.status) && task.resultCount>0
const needsRecovery=(task:StudioTask)=>['unknown','queued','processing','billing_pending','reserve_pending','recovery_blocked'].includes(task.status)
const taskDate=(task:StudioTask)=>Number.isFinite(Date.parse(task.createdAt)) ? new Date(task.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}) : '时间待确认'
const ratioShape=(r:string)=>{const match=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r);const n=match ? Number(match[1])/Number(match[2]) : 1;return {width:`${Math.round(17*Math.min(1,Number.isFinite(n)&&n>0?n:1))}px`,height:`${Math.round(17/Math.max(1,Number.isFinite(n)&&n>0?n:1))}px`}}
function imageUnavailable(event:Event){const image=event.target as HTMLImageElement;image.classList.add('unavailable');image.alt='预览暂不可用，请打开任务查看原片'}
async function toggleControl(which:'model'|'ratio'){if(busy.value||active.value)return;openControl.value=openControl.value===which?null:which;await nextTick();if(openControl.value)composerRoot.value?.querySelector<HTMLElement>(which==='model'?'#studio-offer':'#studio-ratio-menu button')?.focus()}
function closeControl(){const previous=openControl.value;openControl.value=null;void nextTick(()=>{(previous==='model'?modelTrigger:previous==='ratio'?ratioTrigger:null)?.value?.focus()})}
function clickOutside(event:PointerEvent){if(openControl.value&&!composerRoot.value?.contains(event.target as Node))openControl.value=null}
function focusPrompt(){historyMode.value=false;createMenuOpen.value=false;void nextTick(()=>promptInput.value?.focus())}
async function openHistory(){if(busy.value)return;historyMode.value=true;historyFilter.value='all';createMenuOpen.value=false;openControl.value=null;await loadHistory()}
async function startNew(mode:'text'|'edit'|'video'){createMenuOpen.value=false;await changeMode(mode)}
async function changeMode(mode:'text'|'edit'|'video'){
 if(busy.value)return
 historyMode.value=false;openControl.value=null
 const nextKind=mode==='video'?'video':'image', sameKind=nextKind===kind.value
 if(sameKind&&active.value)newTask()
 if(mode==='text'&&uploads.value.length){clearAssets();notice.value='已切换为文生图，当前输入不再使用参考素材。'}
 imageMode.value=mode==='edit'?'edit':'text'
 if(!sameKind){quoteConfirm.value=false;active.value=null;intent=undefined;kind.value=nextKind;await load(undefined,false);focusPrompt();return}
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
// Only local HTTP submission activity; it never asserts supplier acceptance.
const submitting=ref<Record<string,number>>({})
const feedback=ref<Record<string,{at:number;message:string;error?:string}>>({})
const autoChecks=new Map<string,number>()
const taskFeedback=computed(()=>active.value ? feedback.value[active.value.id] : undefined)
const uncertain=computed(()=>!!active.value && ['unknown','reserve_pending','recovery_blocked'].includes(active.value.status))
const waiting=computed(()=>!!active.value && (!!submitting.value[active.value.id] || uncertain.value || ['queued','processing','billing_pending'].includes(active.value.status)))
const elapsedSeconds=computed(()=>{if(!active.value)return 0;const start=submitting.value[active.value.id] || Date.parse(active.value.createdAt);return Number.isFinite(start)?Math.max(0,Math.floor((clock.value-start)/1000)):0})
const elapsedText=computed(()=>{const n=elapsedSeconds.value;return n<60?`${n} 秒`:n<3600?`${Math.floor(n/60)} 分 ${n%60} 秒`:`${Math.floor(n/3600)} 小时 ${Math.floor(n%3600/60)} 分`})
const waitingMessage=computed(()=>{
 if(active.value && submitting.value[active.value.id])return elapsedSeconds.value>=60?'本次提交仍未返回最终结果。请勿重复提交这笔任务。':'正在等待本次提交返回，供应商最终状态尚未确认。'
 if(uncertain.value)return '最终结果暂时无法确认，这不等于仍在正常生成。查询仅恢复原任务，不会重新发起生成。'
 if(active.value?.status==='billing_pending')return '结果已保存，正在确认原生结算；不会再次生成。'
 return elapsedSeconds.value>=60?'服务端尚未返回最终结果，请稍后查询原任务。':'等待服务端更新任务状态。'
})
const statuses:Record<string,string>={prepared:'报价已冻结，等待确认生成',processing:'生成中',queued:'排队中',completed:'生成完成，原始结果已保存',partial:'部分完成',unknown:'结果待确认',billing_pending:'结果已保存，结算待确认',failed:'生成失败',released:'生成失败，费用已释放',reserve_pending:'结果待确认：费用预占处理中，请查询原任务',recovery_blocked:'结果待确认：原任务身份暂不可用，恢复受阻'}
const statusText=(status:string)=>statuses[status]||'结果待确认'
const taskModel=(task:StudioTask)=>offers.value.find(o=>o.offer_id===task.offerId)?.display_name||(!/^media[-_]/.test(task.model)?task.model:'')||'已保存的创作'
const specText=(task:StudioTask)=>[task.spec.resolution,task.spec.aspect_ratio,task.spec.duration_seconds?`${task.spec.duration_seconds}秒`:'',`${task.spec.count??1}${task.kind==='image'?'张':'条'}`].filter(Boolean).join(' / ')
function remember(){try{if(storage)sessionStorage.setItem(storage,JSON.stringify({kind:kind.value,imageMode:imageMode.value,id:active.value?.id,view:active.value?'task':'compose',attempted:[...attempted]}))}catch{/* Durable server history remains available when browser storage is unavailable. */}}
function resultLoaded(task:StudioTask,index:number){const key=`${task.id}-${index}`;loadingResults.value[key]=false;unavailableResults.value[key]=false}
function resultUnavailable(task:StudioTask,index:number){const key=`${task.id}-${index}`;loadingResults.value[key]=false;unavailableResults.value[key]=true}
function accepted(task:StudioTask,select=true){
 if(!mounted)return
 if(task.status==='prepared'&&attempted.has(task.id))task={...task,status:'unknown'}
 if(select || active.value?.id===task.id && active.value.kind===task.kind){active.value=task;resultRead.value++;if(hasResults(task))for(let i=1;i<=task.resultCount;i++)loadingResults.value[`${task.id}-${i}`]=true}
 if(select || task.kind===kind.value)history.value=[task,...history.value.filter(t=>t.id!==task.id)]
 remember()
}
function selectOffer(){if(offer.value)unavailableOffers.value.delete(`${kind.value}:${offerId.value}`);const s=offer.value?.spec;resolution.value=s?.resolution?.[0]||'';ratio.value=s?.aspect_ratio?.[0]||'';quality.value=s?.quality?.[0]||'';duration.value=s?.duration_seconds?.[0]||0;count.value=kind.value==='image' ? countOptions.value[0]??1 : 1;intent=undefined}
function newTask(){if(busy.value || !active.value)return;const nextKind=active.value.kind;kind.value=nextKind;if(nextKind==='image')imageMode.value='text';quoteConfirm.value=false;active.value=null;intent=undefined;error.value='';notice.value='';historyMode.value=false;createMenuOpen.value=false;remember();focusPrompt()}
async function loadHistory(){if(busy.value||historyLoading.value)return;const epoch=generation;historyLoading.value=true;try{
 const kinds:StudioKind[]=historyFilter.value==='all'?['image','video']:[historyFilter.value]
 const settled=await Promise.allSettled(kinds.map(value=>studioHistory(value)))
 if(epoch!==generation)return
 const tasks=settled.flatMap(result=>result.status==='fulfilled'?result.value:[])
 if(settled.some(result=>result.status==='rejected')&&tasks.length===0)throw settled.find(result=>result.status==='rejected')?.reason
 const seen=new Set<string>();history.value=tasks.filter(task=>!seen.has(task.id)&&seen.add(task.id)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
 }catch(e){error.value=studioErrorMessage(e)}finally{historyLoading.value=false}}
async function load(selectedId?:unknown,restorePending=true){const epoch=++generation;busy.value=true;error.value='';active.value=null;enabled.value=false;readinessState.value='unknown';offers.value=[];history.value=[];try{
 const [catalog,tasks,readiness]=await Promise.allSettled([studioCatalog(kind.value),studioHistory(kind.value),studioRequest<{paid_enabled:boolean}>(kind.value,'readiness')]);
 if(epoch!==generation)return;
 if(catalog.status==='fulfilled')offers.value=catalog.value;
 if(readiness.status==='fulfilled'){enabled.value=readiness.value.paid_enabled===true;readinessState.value=enabled.value?'enabled':'disabled'}
 if(tasks.status==='rejected')throw tasks.reason;
 history.value=tasks.value;
 if(catalog.status==='rejected'||readiness.status==='rejected')notice.value='目录或生成服务暂不可用，仍可查询原任务和已保存结果。';
 if(!visibleOffers.value.some(o=>o.offer_id===offerId.value)){offerId.value=visibleOffers.value[0]?.offer_id||'';selectOffer()}
 const restored=history.value.find(t=>t.id===selectedId)||(restorePending?history.value.find(t=>!['completed','partial','failed','released'].includes(t.status))||(catalog.status==='rejected'?history.value[0]:undefined):undefined);if(restored){
  accepted(restored)
  if(restored.status==='prepared'&&!attempted.has(restored.id)&&catalog.status==='fulfilled'&&(catalog.value.length>0||readiness.status==='fulfilled'&&readiness.value.paid_enabled)&&!catalog.value.some(item=>item.offer_id===restored.offerId)){
   invalidatedQuotes.value.add(restored.id);offerId.value=restored.offerId;unavailableOffers.value.add(`${kind.value}:${restored.offerId}`);quoteConfirm.value=false;active.value=null;intent=undefined
  }
 }remember()
 }catch(e){error.value=studioErrorMessage(e)}finally{if(epoch===generation)busy.value=false}
 if(active.value&&needsRecovery(active.value))await refresh()
}
// Refresh only catalog/readiness. Never rebuild the composer or replace history.
async function refreshCatalog(){
 if(catalogLoading.value)return
 const epoch=generation,originalKind=kind.value
 catalogLoading.value=true
 try{
  const [catalog,readiness]=await Promise.allSettled([studioCatalog(originalKind),studioRequest<{paid_enabled:boolean}>(originalKind,'readiness')])
  if(!mounted||epoch!==generation||originalKind!==kind.value)return
   if(readiness.status==='fulfilled'){enabled.value=readiness.value.paid_enabled===true;readinessState.value=enabled.value?'enabled':'disabled'}
   else {enabled.value=false;readinessState.value='unknown'}
  if(catalog.status==='rejected'){notice.value='模型目录暂时无法刷新，保留当前输入与已有结果。';return}
  // A closed shared gate may intentionally return an empty catalog. It is not
  // evidence that this particular model was removed; retain the last catalog.
  if(!catalog.value.length&&(readiness.status!=='fulfilled'||!readiness.value.paid_enabled))return
  offers.value=catalog.value
  const available=new Set(catalog.value.map(item=>item.offer_id))
  const selectedMissing=!!offerId.value&&!available.has(offerId.value)
  for(const task of history.value){if(task.kind===originalKind&&task.status==='prepared'&&!attempted.has(task.id)&&!available.has(task.offerId))invalidatedQuotes.value.add(task.id)}
  if(active.value?.kind===originalKind&&active.value.status==='prepared'&&!available.has(active.value.offerId))invalidatedQuotes.value.add(active.value.id)
  if(selectedMissing){unavailableOffers.value.add(`${originalKind}:${offerId.value}`);intent=undefined;quoteConfirm.value=false}
  if(activeQuoteUnavailable.value){if(active.value){offerId.value=active.value.offerId;unavailableOffers.value.add(`${originalKind}:${active.value.offerId}`)}quoteConfirm.value=false;active.value=null;intent=undefined;remember()}
 }finally{catalogLoading.value=false}
}
async function reloadHistory(){
 if(!historyMode.value){if(busy.value||historyLoading.value)return;const epoch=generation,originalKind=kind.value;historyLoading.value=true;try{const tasks=await studioHistory(originalKind);if(epoch===generation&&originalKind===kind.value)history.value=tasks}catch(e){if(epoch===generation)error.value=studioErrorMessage(e)}finally{historyLoading.value=false};return}
 await loadHistory()
}
async function selectTask(task:StudioTask){if(busy.value)return;error.value='';accepted(task);revealTask();if(needsRecovery(task))await refresh()}
async function refresh(automatic=false){
 if(!active.value||querying.value||submitting.value[active.value.id])return
 const original=active.value;querying.value=true
 if(!automatic)autoChecks.set(original.id,0)
 try{
  const task=await studioTask(original)
  if(task.id!==original.id||task.kind!==original.kind)throw new StudioError('studio_contract')
  if(!mounted)return
  accepted(task,false)
  const unchanged=task.status===original.status && task.resultCount===original.resultCount && task.billingState===original.billingState
  feedback.value[original.id]={at:Date.now(),message:unchanged?`已查询原任务，暂无新结果。当前状态：${statusText(task.status)}。`:`原任务已更新：${statusText(task.status)}。`}
 }catch(e){if(mounted)feedback.value[original.id]={at:Date.now(),message:'本次查询未取得最新状态，保留上次记录。',error:`查询未完成：${studioErrorMessage(e)} 原任务未重新提交。`}}
 finally{querying.value=false;if(mounted&&active.value&&active.value.id!==original.id)void refresh()}
}
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
async function quote(){if(busy.value||catalogLoading.value||selectionUnavailable.value||active.value||!offer.value||incompatible.value||invalidCount.value||!prompt.value.trim())return;busy.value=true;openControl.value=null;error.value='';notice.value='';try{
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
 }catch(e){error.value=studioErrorMessage(e);if(e instanceof StudioError&&e.status===409&&!e.code.includes('paid_gate_off')){intent=undefined;quoteConfirm.value=false;await refreshCatalog()}history.value=await studioHistory(kind.value).catch(()=>history.value)}finally{busy.value=false}}
async function generate(){
 if(busy.value||catalogLoading.value||activeQuoteUnavailable.value||!active.value||active.value.status!=='prepared'||!enabled.value||expired.value||attempted.has(active.value.id))return
 const task=active.value;quoteConfirm.value=false;error.value='';attempted.add(task.id);submitting.value[task.id]=Date.now();clock.value=Date.now();accepted({...task,status:'unknown'})
 try{accepted(await studioGenerate(task),false)}catch(e){
  if(!mounted)return
  if(e instanceof StudioError&&(e.code.includes('paid_gate_off')||e.code.endsWith('quote_expired'))){attempted.delete(task.id);accepted(task,false)}
  feedback.value[task.id]={at:Date.now(),message:'本次提交未取得最终结果。',error:e instanceof StudioError && e.code==='image_binding_unavailable'?'本次请求未取得可确认的结果。请查询原任务；不会重新发送生成请求。':studioErrorMessage(e)}
 }finally{delete submitting.value[task.id]}
}
onMounted(async()=>{window.addEventListener('paste',paste);window.addEventListener('pointerdown',clickOutside);try{const session=await ensureStudioSession();storage=`studio-media-view-${session.owner_id}`;let selected:unknown,restorePending=true;try{const raw=JSON.parse(sessionStorage.getItem(storage)||'{}');if(raw.kind==='image'||raw.kind==='video')kind.value=raw.kind;if(raw.imageMode==='edit')imageMode.value='edit';selected=raw.id;restorePending=raw.view!=='compose';if(Array.isArray(raw.attempted))attempted=new Set(raw.attempted.filter((id:unknown)=>typeof id==='string'))}catch{/* Server history remains authoritative. */}await load(selected,restorePending)}catch(e){error.value=studioErrorMessage(e)}
 if(mounted)timer=setInterval(()=>{
  clock.value=Date.now()
  const task=active.value
  // Unknown outcomes require explicit recovery. Bound known-state refreshes and
  // stop after an error; never let polling erase the only visible failure.
  if(!polling&&!busy.value&&task&&!submitting.value[task.id]&&['processing','queued','billing_pending'].includes(task.status)&&!feedback.value[task.id]?.error&&(autoChecks.get(task.id)||0)<12&&clock.value-(feedback.value[task.id]?.at||0)>=10000){
   autoChecks.set(task.id,(autoChecks.get(task.id)||0)+1);polling=true;void refresh(true).finally(()=>{polling=false})
  }
 },1000)
})
onUnmounted(()=>{mounted=false;generation++;if(timer)clearInterval(timer);window.removeEventListener('paste',paste);window.removeEventListener('pointerdown',clickOutside);uploads.value.forEach(item=>{item.controller?.abort();revokePreview(item)})})
</script>

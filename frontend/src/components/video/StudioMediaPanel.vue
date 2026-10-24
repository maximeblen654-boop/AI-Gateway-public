<template>
  <section ref="panelRoot" class="studio-workspace" :class="{ 'is-history': historyMode, 'has-active': !!active }" data-testid="studio-media-panel">
    <aside class="studio-rail" aria-label="创作工作台导航">
      <a href="/dashboard" @click.prevent="dashboardConfirm = true" class="studio-brand-mark" aria-label="AI Gateway，返回控制台"><StudioMark /><span>AI Gateway</span></a>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'text' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'text'" :disabled="busy" data-testid="studio-mode-text" @click="changeMode('text')"><Icon name="grid" /><span>文生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'image' && imageMode === 'edit' }" :aria-pressed="!historyMode && kind === 'image' && imageMode === 'edit'" :disabled="busy" data-testid="studio-mode-edit" @click="changeMode('edit')"><Icon name="edit" /><span>图生图</span></button>
      <button :class="{ selected: !historyMode && kind === 'video' }" :aria-pressed="!historyMode && kind === 'video'" :disabled="busy" data-testid="studio-mode-video" @click="changeMode('video')"><Icon name="play" /><span>视频</span></button>
      <button class="studio-history-nav" :class="{ selected: historyMode }" :aria-pressed="historyMode" :disabled="busy" data-testid="studio-mode-history" @click="openHistory"><Icon name="clock" /><span>任务历史</span></button>
      <a href="/dashboard" @click.prevent="dashboardConfirm = true" class="studio-dashboard"><Icon name="arrowLeft" /><span>控制台</span></a>
    </aside>
    <div class="studio-main">
      <header class="studio-header">
        <div><h1><a href="/dashboard" @click.prevent="dashboardConfirm = true" aria-label="AI Gateway，返回控制台">AI Gateway</a> <span>{{ historyMode ? '任务历史' : modeLabel }}</span></h1><p class="studio-mobile-tagline">让想法有画面。</p></div>
        <div v-if="!active && historyMode" class="studio-new-menu-wrap"><button class="studio-button studio-header-new" :disabled="busy" :aria-expanded="createMenuOpen" data-testid="studio-header-new" @click="createMenuOpen = !createMenuOpen"><Icon name="plus" />新建创作</button><div v-if="createMenuOpen" class="studio-new-menu" role="menu"><button role="menuitem" @click="startNew('text')"><Icon name="grid" />文生图</button><button role="menuitem" @click="startNew('edit')"><Icon name="edit" />图生图</button><button role="menuitem" @click="startNew('video')"><Icon name="play" />视频</button></div></div>
        <button v-else-if="canStartNew" class="studio-button studio-header-new" :disabled="busy" @click="newTask"><Icon name="plus" />继续创作</button>
      </header>
      <p v-if="selectionUnavailable || activeQuoteUnavailable" role="status" class="studio-notice" data-testid="studio-model-unavailable">此模型暂不可用，请选择其他模型</p>
      <p v-if="notice" role="status" class="studio-notice">{{ notice }}</p>
      <p v-if="error" role="alert" class="studio-error" data-testid="studio-error">{{ error }}</p>
      <p v-if="readinessState === 'disabled'" class="studio-gate" data-testid="studio-gate"><Icon name="infoCircle" />当前生成服务未开放，仍可查看报价和已有结果。</p>
      <p v-if="assetMessage && !showUploader" class="studio-error" role="alert" data-testid="studio-asset-feedback">{{ assetMessage }}</p>
      <div v-show="!active" class="studio-body">
      <section v-if="!historyMode" v-show="!active" class="studio-composer-wrap" :class="{ 'has-task': !!active }" aria-label="创作输入">
        <h2 class="studio-composer-caption">{{ modeLabel }}<span>让想法有画面</span></h2>
        <div class="studio-composer" ref="composerRoot" @keydown.esc="closeControl" @dragover.prevent @drop.prevent="drop">
          <fieldset :disabled="!!active">
            <legend class="studio-sr-only">{{ modeLabel }}创作设置</legend>
            <div v-if="kind === 'video'" class="studio-floating-model studio-video-model" :class="{ 'model-open': openControl === 'model' }">
              <p class="studio-field-label">生成模型</p><button ref="modelTrigger" class="studio-model-trigger" :disabled="busy" data-testid="studio-model-toggle" :aria-expanded="openControl === 'model'" aria-controls="studio-model-menu" @click="toggleControl('model')"><span class="studio-model-dot"></span><span>{{ offer?.display_name || offer?.upstream_model || '选择模型' }}</span><Icon v-if="openControl === 'model'" :name="modelMenuSide === 'above' ? 'chevronUp' : 'chevronDown'" :data-direction="modelMenuSide" data-testid="studio-model-direction" aria-hidden="true" /><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" data-testid="studio-model-selector-icon"><path d="m8 9 4-4 4 4m-8 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
              <Transition name="studio-pop"><div v-show="openControl === 'model'" ref="modelMenu" class="studio-popover studio-model-menu" id="studio-model-menu" :style="modelMenuStyle"><StudioModelPicker v-if="openControl === 'model'" :offers="visibleOffers" :model-value="offerId" :disabled="busy" @select="offerId = $event; selectOffer(); closeControl()" /><button class="studio-text-button" @click="closeControl">关闭<Icon name="x" /></button></div></Transition>
            </div>
            <div v-if="showUploader" class="studio-asset-uploader" data-testid="studio-asset-uploader" @paste.stop="paste">
              <div class="studio-assets-heading"><p class="studio-field-label">{{ kind === 'image' ? '参考图片' : '参考素材' }}</p><button v-if="uploads.length" type="button" class="studio-text-button" :aria-expanded="!assetsCollapsed" aria-controls="studio-asset-list" data-testid="studio-assets-toggle" @click="toggleAssets">{{ assetsCollapsed ? '展开素材' : '收起素材' }}<Icon :name="assetsCollapsed ? 'chevronDown' : 'chevronUp'" /></button></div>
              <p class="studio-asset-limits" data-testid="studio-asset-limits">{{ referenceHint }}</p>
              <button type="button" class="studio-upload-trigger" :class="{ 'has-assets': uploads.length }" data-testid="studio-attachment" :disabled="!offer || !accept || busy || !!active" :aria-label="kind === 'image' ? '添加参考图片' : '添加参考素材'" aria-describedby="studio-asset-feedback" @click="fileInput?.click()"><Icon name="plus" /><span>{{ uploads.length ? '继续添加素材' : kind === 'image' ? '添加参考图片' : '添加参考素材' }}</span><small>{{ accept ? '点击选择或拖入文件' : '当前模型不支持参考素材' }}</small></button>
              <input ref="fileInput" type="file" :accept="accept" :disabled="!offer || !accept || busy || !!active" multiple class="studio-sr-only" aria-describedby="studio-asset-feedback" data-testid="studio-asset-input" @change="upload" />
              <p v-if="assetMessage" id="studio-asset-feedback" class="studio-asset-feedback" role="alert" data-testid="studio-asset-feedback">{{ assetMessage }}</p>
              <p v-if="uploads.length" class="studio-asset-summary" role="status" data-testid="studio-asset-summary">{{ assetSummary }}<span v-if="failedAssets"> · {{ failedAssets }} 项上传失败，请{{ assetsCollapsed ? '展开后' : '' }}移除并重新添加</span><span v-if="pendingAssets"> · {{ pendingAssets }} 项上传中</span></p>
              <div v-if="uploads.length" v-show="!assetsCollapsed" ref="assetList" id="studio-asset-list" class="studio-assets" data-testid="studio-assets">
                <div v-for="(item,i) in uploads" :key="item.id" class="studio-asset" :class="{ 'is-media': item.kind !== 'image' }" :data-testid="`studio-asset-${item.status}`">
                  <img v-if="item.previewUrl && item.kind === 'image'" :src="item.previewUrl" :alt="item.file.name || `参考图片 ${i+1}`" data-testid="studio-asset-thumbnail" />
                  <div class="studio-asset-info"><span class="studio-asset-kind">{{ assetTypeNames[item.kind] }}</span><strong>{{ item.file.name || `参考素材 ${i+1}` }}</strong><small v-if="item.status === 'pending'">上传中…</small><small v-else-if="item.status === 'success'">上传成功</small><small v-else>上传失败{{ item.error ? `：${item.error}` : '' }}</small></div>
                  <button type="button" :disabled="!!active" :data-testid="`studio-asset-remove-${item.id}`" :aria-label="`移除素材 ${item.file.name}`" @click="removeAsset(item)"><Icon name="x" /></button>
                  <video v-if="item.previewUrl && item.kind === 'video'" :src="item.previewUrl" controls preload="metadata" :aria-label="`预览 ${item.file.name}`" data-testid="studio-asset-video" />
                  <audio v-if="item.previewUrl && item.kind === 'audio'" :src="item.previewUrl" controls preload="metadata" :aria-label="`试听 ${item.file.name}`" data-testid="studio-asset-audio" />
                </div>
                <button type="button" class="studio-text-button" :disabled="!!active" data-testid="studio-assets-clear" @click="clearAssets">清空全部</button>
              </div>
            </div>
            <div class="studio-writing"><label for="studio-prompt" class="studio-field-label">{{ kind === 'video' ? '视频描述' : '画面描述' }}</label><textarea :disabled="busy" id="studio-prompt" ref="promptInput" v-model="prompt" :placeholder="kind === 'video' ? '描述画面、动作与镜头，以及参考素材的使用方式…' : '描述你想生成的画面、风格与细节…'" rows="5" data-testid="studio-prompt" /></div>
            <div v-if="kind === 'image'" class="studio-floating-model" :class="{ 'model-open': openControl === 'model' }">
              <p class="studio-field-label">生成模型</p><button ref="modelTrigger" class="studio-model-trigger" :disabled="busy" data-testid="studio-model-toggle" :aria-expanded="openControl === 'model'" aria-controls="studio-model-menu" @click="toggleControl('model')"><span class="studio-model-dot"></span><span>{{ offer?.display_name || offer?.upstream_model || '选择模型' }}</span><Icon v-if="openControl === 'model'" :name="modelMenuSide === 'above' ? 'chevronUp' : 'chevronDown'" :data-direction="modelMenuSide" data-testid="studio-model-direction" aria-hidden="true" /><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" data-testid="studio-model-selector-icon"><path d="m8 9 4-4 4 4m-8 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
              <Transition name="studio-pop"><div v-show="openControl === 'model'" ref="modelMenu" class="studio-popover studio-model-menu" id="studio-model-menu" :style="modelMenuStyle"><StudioModelPicker v-if="openControl === 'model'" :offers="visibleOffers" :model-value="offerId" :disabled="busy" @select="offerId = $event; selectOffer(); closeControl()" /><button class="studio-text-button" @click="closeControl">关闭<Icon name="x" /></button></div></Transition>
            </div>
            <div class="studio-composer-bottom"><div class="studio-specs">

              <div v-if="ratioOptions.length" class="studio-ratio-control"><button ref="ratioTrigger" class="studio-chip" :disabled="busy" data-testid="studio-ratio-toggle" :aria-expanded="openControl === 'ratio'" aria-controls="studio-ratio-menu" @click="toggleControl('ratio')"><span class="studio-ratio-icon" :style="ratioShape(ratio)"></span>{{ ratio }}<Icon name="chevronDown" /></button><Transition name="studio-pop"><div v-if="openControl === 'ratio'" id="studio-ratio-menu" class="studio-popover studio-ratio-menu" role="group" aria-label="选择画面比例"><button v-for="r in ratioOptions" :key="r" :aria-pressed="ratio === r" :class="{ chosen: ratio === r }" :data-ratio="r" @click="choosePublishedRatio(r); closeControl()"><span class="studio-ratio-icon" :style="ratioShape(r)"></span>{{ r }}</button></div></Transition></div>
              <StudioSpecPicker v-if="offer?.spec.resolution?.length" id="studio-resolution" label="分辨率" :model-value="resolution" :options="resolutionOptions" :disabled="busy" :open="openControl === 'resolution'" @update:model-value="choosePublishedSpec('resolution', String($event))" @update:open="openControl = $event ? 'resolution' : null" />
              <StudioSpecPicker v-if="kind === 'image' && offer?.spec.quality?.length" id="studio-quality" label="画质" :model-value="quality" :options="qualityOptions" :disabled="busy" :open="openControl === 'quality'" @update:model-value="choosePublishedSpec('quality', String($event))" @update:open="openControl = $event ? 'quality' : null" />
              <StudioSpecPicker v-if="kind === 'image' && outputFormats.length" id="studio-output-format" label="输出格式" :model-value="outputFormat" :options="['auto', ...outputFormats]" :option-labels="outputFormatLabels" :disabled="busy" :open="openControl === 'format'" @update:model-value="outputFormat = $event as StudioOutputFormat|'auto'" @update:open="openControl = $event ? 'format' : null" />
              <StudioSpecPicker v-if="kind === 'image'" id="studio-count" label="数量" unit="张" :columns="5" :model-value="count" :options="countOptions" :disabled="busy" :invalid="invalidCount" :describedby="invalidCount ? 'studio-count-error' : undefined" :open="openControl === 'count'" @update:model-value="choosePublishedSpec('count', Number($event))" @update:open="openControl = $event ? 'count' : null" />
              <StudioSpecPicker v-else id="studio-duration" label="时长" unit="秒" :model-value="duration" :options="durationOptions" :disabled="busy" :open="openControl === 'duration'" @update:model-value="choosePublishedSpec('duration_seconds', Number($event))" @update:open="openControl = $event ? 'duration' : null" />
              <span class="studio-range">{{ kind === 'video' ? '每次 1 条视频' : countOptions.length ? `可选 ${countOptions[0]}–${countOptions[countOptions.length-1]} 张` : '' }}</span>
            </div><button v-if="!active" class="studio-button studio-primary studio-quote" :disabled="busy || catalogLoading || selectionUnavailable || !offer || incompatible || hasUnreadyAssets || invalidCount || !prompt.trim()" data-testid="studio-quote" @click="quote">{{ busy ? '处理中…' : '获取报价' }}<Icon name="arrowUp" /></button></div>
          </fieldset>
        </div>
        <div class="studio-input-feedback"><p v-if="!visibleOffers.length">暂无可用模型：模型可能尚未配置、已暂停或没有访问权限{{ kind === 'image' && imageMode === 'edit' ? '，或不支持参考图' : '' }}。</p><p v-if="kind === 'image' && offer && invalidCount && !active" id="studio-count-error" role="alert" data-testid="studio-count-error">{{ countOptions.length ? `请选择商品允许的生成数量（${countOptions[0]}～${countOptions[countOptions.length-1]} 张）。` : '当前商品没有有效的数量范围，请选择其他商品或刷新目录。' }}</p><p v-if="offer && incompatible && !active" :role="kind === 'image' && imageMode === 'edit' && !assets.length ? undefined : 'alert'">{{ kind === 'image' && imageMode === 'edit' && !assets.length ? '请先添加参考图片，再描述想生成的画面。' : unmatchedSpec ? '当前规格组合不可售，请调整参数或参考素材。' : '当前模型不支持这些素材类型或数量，请调整素材。' }}</p><p v-if="(offer?.input_mode === 'references' || offer?.input_mode === 'image2pro' && assets.some(a => a.kind !== 'image')) && assets.length && !active">获取报价时会将引用素材上传到所选供应商，确认生成前不会创建生成任务。</p></div>
        <p class="studio-composer-hint">确认本次价格后生成 · {{ kind === 'video' ? '视频每次生成一条' : '结果自动保存到任务历史' }}</p>
      </section>
      <section class="studio-browse" aria-label="作品与任务">
      <div class="studio-section-heading">
        <h2>{{ historyMode ? '我的任务' : '最近的创作' }}<span v-if="displayHistory.length">{{ displayHistory.length }}</span></h2>
        <div class="studio-history-tools"><button class="studio-text-button" data-testid="studio-refresh-models" :disabled="busy || catalogLoading" @click="refreshCatalog"><Icon name="refresh" :class="{ spinning: catalogLoading }" />刷新模型</button><button v-if="failedHistoryCount" class="studio-failed-toggle" :aria-pressed="showFailed" data-testid="studio-failed-toggle" @click="showFailed = !showFailed">{{ showFailed ? '隐藏失败任务' : '显示失败任务' }}（{{ failedHistoryCount }}）</button><button v-if="!historyMode && history.length > 2" class="studio-text-button" @click="openHistory">全部任务<Icon name="arrowRight" /></button><label v-if="historyMode" class="studio-kind-filter"><span>历史类型</span><select :disabled="busy || historyLoading" v-model="historyFilter" data-testid="studio-kind" @change="loadHistory"><option value="all">全部（图片 + 视频）</option><option value="image">仅图片</option><option value="video">仅视频</option></select></label><button class="studio-text-button" :disabled="busy || querying || historyLoading" @click="reloadHistory"><Icon name="refresh" :class="{ spinning: historyLoading }" />刷新记录</button></div>
      </div>
      <div v-if="historyMode" class="studio-history-filters">
        <label class="studio-history-search"><span class="studio-sr-only">搜索模型或规格</span><input v-model="historySearch" placeholder="搜索模型或规格" data-testid="studio-history-search" type="search" /></label>
        <label class="studio-kind-filter"><span>状态</span><select v-model="historyStatus" data-testid="studio-history-status"><option value="all">全部状态</option><option value="completed">已完成</option><option value="pending">进行中 / 待确认</option><option value="prepared">待生成</option><option value="failed">生成失败</option></select></label>
      </div>
      <p class="studio-retention-note">新图片原片保留72小时，新视频原片保留48小时，请及时下载；历史作品以服务端提供的到期时间为准。</p>
      <div v-if="displayHistory.length" class="studio-gallery" data-testid="studio-history">
        <button v-for="task in displayHistory" :key="task.id" class="studio-work" :class="{ 'is-selected': active?.id === task.id }" :disabled="busy" :data-task-id="task.id" @click="selectTask(task)">
          <span class="studio-work-preview" :class="{ 'is-state-cover': task.status === 'processing' || taskFailed(task) || task.status === 'prepared' }">
            <img v-if="task.kind === 'image' && readableResults(task)" class="studio-work-preview-image" :src="resultUrl(task)" :alt="taskModel(task) + ' 的生成结果'" loading="lazy" @error="imageUnavailable" />
            <StudioVideoCover v-else-if="task.kind === 'video' && readableResults(task)" :src="studioCoverUrl(task, clock)" :alt="taskModel(task) + ' 的视频封面'" />
            <img v-else-if="task.status === 'processing'" class="studio-state-cover studio-generating-cover" :src="generatingCover" alt="在努力啦..." loading="lazy" decoding="async" data-testid="studio-generating-cover" />
            <img v-else-if="taskFailed(task)" class="studio-state-cover" :src="failureCover" alt="生成失败" loading="lazy" decoding="async" :data-testid="task.kind === 'image' ? 'studio-image-failed-cover' : 'studio-failed-cover'" />
            <img v-else-if="quotePending(task)" class="studio-state-cover" :src="quoteReadyCover" alt="报价已锁定，等待确认生成" loading="lazy" decoding="async" data-testid="studio-quote-ready-cover" />
            <img v-else-if="task.status === 'prepared' && quoteExpired(task)" class="studio-state-cover" :src="quoteExpiredCover" alt="报价已失效，请重新报价" loading="lazy" decoding="async" data-testid="studio-quote-expired-cover" />
            <span v-else class="studio-work-placeholder"><Icon :name="placeholderIcon(task)" aria-hidden="true" /><span>{{ placeholderText(task) }}</span></span>
          </span>
          <span class="studio-work-title"><strong>{{ taskModel(task) }}</strong><time>{{ taskDate(task) }}</time></span>
          <span class="studio-work-meta">{{ specText(task) }}</span>
          <span class="studio-work-state" :class="{ 'is-failed': taskFailed(task) }">{{ taskFailed(task) ? failureSummary(task) : taskStatusText(task) }}<template v-if="task.status === 'completed' && hasResults(task)"> · 已保存 {{ task.resultCount }} {{ task.kind === 'image' ? '张原图' : '条视频' }}</template><template v-else-if="task.status === 'partial'"> · 已交付 {{ task.deliveredCount ?? task.resultCount }}/{{ task.expectedCount ?? task.quantity }} {{ task.kind === 'image' ? '张' : '条' }}</template><template v-if="hasResults(task)"><br /><span data-testid="studio-history-retention">{{ retentionText(task) }}</span></template></span>
        </button>
      </div>
      <div v-else class="studio-empty" data-testid="studio-empty"><StudioMark /><h2>{{ historyLoading || busy ? '正在读取工作台…' : historyMode && history.length ? '当前没有可显示的任务' : historyMode ? '还没有历史任务' : '让想法有画面。' }}</h2><p>{{ historyMode && history.length ? (historySearch || historyStatus !== 'all' ? '试试调整搜索内容或筛选条件。' : failedHistoryCount ? '失败任务已隐藏，点击上方按钮查看。' : '试试调整筛选条件。') : historyMode ? '完成创作后，你可以在这里查看状态和下载作品。' : '写下描述，开始创作。' }}</p></div>
      </section>
      </div>
      <section v-if="active" ref="taskDetail" class="studio-task-detail" data-testid="studio-task" aria-label="当前任务">
        <button class="studio-text-button studio-back" :disabled="busy" @click="backToList"><Icon name="arrowLeft" />{{ historyMode ? '返回任务历史' : '返回创作' }}</button>
        <div class="studio-task-heading"><div><h2>{{ taskModel(active) }}</h2><p>{{ active.status === 'prepared' ? '报价规格' : '生成规格' }}：{{ specText(active) }}</p></div><span class="studio-status" :class="`status-${active.status}`" data-testid="studio-status" aria-live="polite">{{ submitting[active.id] ? '提交处理中' : taskStatusText(active) }}</span></div>
        <div class="studio-price-line"><p data-testid="studio-price">{{ active.status === 'prepared' ? '本次报价' : '冻结报价' }} <strong>{{ active.price.amount }} {{ active.price.currency }}</strong><span v-if="active.unitPrice && active.quantity">（{{ active.unitPrice.amount }} × {{ active.quantity }} {{ active.kind === 'image' ? '张' : '条' }}）</span></p><p v-if="active.kind === 'image'" data-testid="studio-settlement">实际结算：<span v-if="active.status === 'prepared'">尚未生成</span><span v-else-if="active.billingState === 'billed' && active.settledPrice">{{ active.settledPrice.amount }} {{ active.settledPrice.currency }}</span><span v-else-if="active.billingState === 'billed'">已结算，金额待确认</span><span v-else-if="active.billingState === 'not_charged'">未收费</span><span v-else>待结算</span></p></div>
        <p v-if="active.status === 'prepared'" class="studio-quote-expiry">{{ expired ? '报价已失效，请重新获取报价并确认。' : `报价有效至 ${new Date(active.expiresAt).toLocaleString()}` }}</p>
        <p v-else-if="!taskFailed(active)" class="studio-retention-note" data-testid="studio-result-retention" role="status">{{ retentionText(active) }}<template v-if="resultExpired(active)">任务与结算记录保留。</template></p>
        <p v-if="active.status === 'partial'" class="studio-partial" data-testid="studio-partial-counts">部分完成：请求 {{ active.expectedCount ?? active.quantity }} 张，已交付 {{ active.deliveredCount ?? active.resultCount }} 张，未完成 {{ (active.failedCount ?? 0) + (active.pendingCount ?? 0) }} 张。</p>
        <img v-if="!hasResults(active) && (active.status === 'processing' || taskFailed(active) || active.status === 'prepared')" class="studio-detail-state-cover" :src="taskFailed(active) ? failureCover : active.status === 'processing' ? generatingCover : quoteExpired(active) ? quoteExpiredCover : quoteReadyCover" :alt="taskStatusText(active)" />
        <div v-if="waiting" class="studio-waiting" data-testid="studio-waiting" :class="{ 'is-uncertain': uncertain && !submitting[active.id] }">
          <Icon :name="submitting[active.id] || !uncertain ? 'refresh' : 'infoCircle'" :class="{ spinning: submitting[active.id] || !uncertain }" />
          <div><strong>{{ submitting[active.id] ? '提交处理中' : taskStatusText(active) }}</strong><p>{{ waitingMessage }}</p><small data-testid="studio-elapsed">{{ submitting[active.id] ? '本次提交已等待' : '距任务创建' }} {{ elapsedText }}。可以继续创作，原任务保留在历史记录中。</small></div>
        </div>
        <div v-if="taskFailed(active)" role="alert" class="studio-task-failure" data-testid="studio-task-failure"><Icon name="exclamationCircle" aria-hidden="true" /><div><strong>这次没能生成成功</strong><p>{{ failureSummary(active) }}。原任务已保留，不会自动再次生成。</p></div></div>
        <p v-if="active.failureCode === 'upstream_http_502_no_delivery'" class="studio-error" data-testid="studio-http-failure">图片服务暂时异常，未完成的图片不会收费，已交付图片按实际结果结算。</p>
        <p v-if="taskFeedback?.message" role="status" class="studio-query-feedback" data-testid="studio-query-feedback"><time :datetime="new Date(taskFeedback.at).toISOString()">{{ new Date(taskFeedback.at).toLocaleTimeString() }}</time> · {{ taskFeedback.message }}</p>
        <p v-if="taskFeedback?.error" role="alert" class="studio-error" data-testid="studio-query-error">{{ taskFeedback.error }}</p>
        <div v-if="hasResults(active)" class="studio-results" data-testid="studio-results">
          <figure v-for="i in active.resultCount" :key="`${active.id}-${i}`">
            <div class="studio-result-stage" :class="{ 'is-image': active.kind === 'image' }">
              <span v-if="resultExpired(active) || expiredResults[`${active.id}-${i}`]" class="studio-result-unavailable" role="status">原片已到期</span>
              <template v-else>
                <span v-if="loadingResults[`${active.id}-${i}`]" class="studio-result-loading" role="status">正在加载已保存原片…</span>
                <img :key="`image-${resultRead}-${i}`" v-if="active.kind === 'image'" :src="resultUrl(active,i-1)" :alt="`生成图片 ${i}`" data-testid="studio-result-image" @load="resultLoaded(active,i)" @error="resultUnavailable(active,i)" />
                <video :key="`video-${resultRead}-${i}`" v-else :src="resultUrl(active,i-1)" controls preload="metadata" data-testid="studio-result-video" @loadedmetadata="resultLoaded(active,i)" @error="resultUnavailable(active,i)" />
              </template>
            </div>
            <figcaption>
              <span class="studio-result-label">原始结果 {{ i }}</span>
              <span v-if="resultExpired(active) || expiredResults[`${active.id}-${i}`]" role="status" class="studio-result-unavailable">原片已到期</span>
              <template v-else>
                <span v-if="unavailableResults[`${active.id}-${i}`]" role="status" class="studio-result-unavailable">{{ resultMessages[`${active.id}-${i}`] || '原片加载失败，请重试' }} <button type="button" class="studio-text-button" :data-testid="`studio-result-retry-${i}`" @click="retryResultRead(active,i)">重新加载</button></span>
                <a class="studio-download" :href="resultUrl(active,i-1)" :download="`${active.id}-${i}`" data-testid="studio-download" @click="guardDownload($event,active)"><Icon name="download" /><span>下载原片</span></a>
              </template>
            </figcaption><StudioImageExport v-if="active.kind === 'image' && readableResults(active) && !expiredResults[`${active.id}-${i}`] && !unavailableResults[`${active.id}-${i}`]" :key="`${active.id}-${i}-export`" :url="resultUrl(active,i-1)" :filename="`${active.id}-${i}`" @click.capture="guardDownload($event,active)" />
          </figure>
        </div>
        <div class="studio-task-actions"><button v-if="active.status === 'prepared'" class="studio-button studio-primary" data-testid="studio-generate" :disabled="busy || catalogLoading || !enabled || expired || activeQuoteUnavailable" @click="generate">{{ expired ? '报价已失效' : '确认报价并生成' }}<Icon name="arrowUp" /></button><button class="studio-button" data-testid="studio-refresh" :disabled="querying || busy || !!submitting[active.id]" :aria-busy="querying" @click="refresh()"><Icon name="refresh" :class="{ spinning: querying }" />{{ querying ? '查询中…' : '查询原任务' }}</button><button v-if="canStartNew" class="studio-button" :class="{ 'studio-primary': active.status === 'prepared' && expired }" data-testid="studio-new" :disabled="busy" @click="newTask">{{ active.status === 'prepared' ? (expired ? '重新报价' : '调整输入并重新报价') : '继续创作' }}</button></div>
        <span hidden data-testid="studio-task-id">{{ active.id }}</span>
      </section>

    </div>
  </section>

  <BaseDialog :show="quoteConfirm && active?.status === 'prepared'" :title="expired ? '报价已失效' : '确认本次生成'" width="narrow" @close="quoteConfirm = false">
    <div v-if="active" class="studio-confirm">
      <p>{{ taskModel(active) }}</p><p class="studio-confirm-spec">{{ specText(active) }}</p>
      <p class="studio-confirm-total">{{ active.price.amount }} <span>{{ active.price.currency }}</span></p>
      <p v-if="active.unitPrice && active.quantity">单{{ active.kind === 'image' ? '张' : '条' }} {{ active.unitPrice.amount }} × {{ active.quantity }}</p>
      <p class="studio-confirm-note">{{ expired ? '报价已失效，尚未生成。请重新获取报价后确认。' : '价格已锁定，尚未冻结余额。确认后将冻结对应余额并开始生成。' }}</p>
      <p v-if="!enabled" class="studio-confirm-note">当前生成服务尚未开放。</p>
    </div>
    <template #footer><button class="studio-confirm-back" @click="newTask">返回修改</button><button class="studio-confirm-submit" data-testid="studio-confirm-generate" :disabled="busy || catalogLoading || !enabled || expired || activeQuoteUnavailable" @click="generate">确认并生成</button></template>
  </BaseDialog>
  <BaseDialog :show="dashboardConfirm" title="确认返回控制台吗？" width="narrow" :show-close-button="false" @close="dashboardConfirm = false">
      <p class="studio-leave-note">已提交的任务仍可在任务历史中查看。</p>
      <template #footer><button class="studio-confirm-back" data-testid="studio-stay" @click="dashboardConfirm = false">留在工作台</button><a href="/dashboard" class="studio-confirm-submit" data-testid="studio-confirm-dashboard">返回控制台</a></template>
  </BaseDialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { ensureStudioSession, studioCatalog, studioRequest, studioTaskView, studioHistory, studioTask, studioGenerate, studioResultUrl, studioCoverUrl, recoverStudioMediaRead, studioResultExpired, studioErrorMessage, StudioError, uploadStudioAsset, type StudioOffer, type StudioKind, type StudioTask, type StudioOutputFormat } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'
import Icon from '@/components/icons/Icon.vue'
import StudioMark from './StudioMark.vue'
import StudioVideoCover from './StudioVideoCover.vue'
import failureCover from '@/assets/studio-image-failed-whale.png'
import quoteReadyCover from '@/assets/studio-quote-ready-whale.png'
import quoteExpiredCover from '@/assets/studio-quote-expired-whale.png'
import generatingCover from '@/assets/studio-generating-effort.png'
import StudioImageExport from './StudioImageExport.vue'
import StudioSpecPicker from './StudioSpecPicker.vue'
import { ratioOfferOptions } from './studioRatioOptions'
import StudioModelPicker from './StudioModelPicker.vue'
import { productDimensionValues, productReferenceOffers, resolveProductOffer, supportsProductReferences, type OfferDimension } from './studioProductOffers'
import BaseDialog from '@/components/common/BaseDialog.vue'
import '@/styles/studio-workspace.css'
const kind=ref<StudioKind>('image'), offers=ref<StudioOffer[]>([]), offerId=ref('')
const panelRoot=ref<HTMLElement|null>(null)
function releaseLeavingPreviews(){panelRoot.value?.querySelectorAll<HTMLImageElement>('.studio-work-preview img').forEach(image=>image.removeAttribute('src'))}
onBeforeUnmount(releaseLeavingPreviews)
type UploadState = 'pending' | 'success' | 'failure'
type StudioAssetUpload = { id:string; file:File; kind:StudioAssetReceipt['kind']; status:UploadState; receipt?:StudioAssetReceipt; error?:string; previewUrl?:string; controller?:AbortController }
const uploads=ref<StudioAssetUpload[]>([])
const assetsCollapsed=ref(false), assetMessage=ref(''), assetList=ref<HTMLElement|null>(null)
const assetTypeNames={image:'图片',video:'视频',audio:'音频'}
const failedAssets=computed(()=>uploads.value.filter(item=>item.status==='failure').length)
const pendingAssets=computed(()=>uploads.value.filter(item=>item.status==='pending').length)
const hasUnreadyAssets=computed(()=>uploads.value.some(item=>item.status!=='success'))
const assetSummary=computed(()=>(['image','video','audio'] as const).map(type=>{const n=uploads.value.filter(item=>item.kind===type).length;return n?`${assetTypeNames[type]} ${n} ${type==='image'?'张':'段'}`:''}).filter(Boolean).join(' · '))
function toggleAssets(){
 assetsCollapsed.value=!assetsCollapsed.value
 if(assetsCollapsed.value)pauseAssetPreviews()
}
function pauseAssetPreviews(){assetList.value?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause())}

const resolution=ref(''), ratio=ref(''), quality=ref(''), outputFormat=ref<StudioOutputFormat|'auto'>('auto'), count=ref(1), duration=ref(5), prompt=ref('')
const busy=ref(true), querying=ref(false), historyLoading=ref(false), enabled=ref(false), readinessState=ref<'unknown'|'enabled'|'disabled'>('unknown'), error=ref(''), notice=ref(''), history=ref<StudioTask[]>([]), active=ref<StudioTask|null>(null), clock=ref(Date.now())
type HistoryFilter = 'all'|'image'|'video'
const historySearch=ref(''), historyStatus=ref<'all'|'completed'|'pending'|'prepared'|'failed'>('all')
const imageMode=ref<'text'|'edit'>('text'), historyMode=ref(false), historyFilter=ref<HistoryFilter>('all'), createMenuOpen=ref(false), showFailed=ref(false), openControl=ref<'model'|'ratio'|'resolution'|'quality'|'count'|'duration'|'format'|null>(null)
watch([active,historyMode],([task,inHistory])=>{if(task||inHistory)pauseAssetPreviews()},{flush:'sync'})
const resultRead=ref(0)
const catalogLoading=ref(false), unavailableOffers=ref(new Set<string>()), invalidatedQuotes=ref(new Set<string>())
const selectionUnavailable=computed(()=>unavailableOffers.value.has(`${kind.value}:${offerId.value}`))
const activeQuoteUnavailable=computed(()=>!!active.value && active.value.status==='prepared' && (invalidatedQuotes.value.has(active.value.id)||unavailableOffers.value.has(`${active.value.kind}:${active.value.offerId}`)))
const unavailableResults=ref<Record<string,boolean>>({})
const loadingResults=ref<Record<string,boolean>>({})
const expiredResults=ref<Record<string,boolean>>({}), resultMessages=ref<Record<string,string>>({})
const retriedResults=new Set<string>(), retryingResults=new Map<string,number>()
const dashboardConfirm=ref(false)
const quoteConfirm=ref(false), fileInput=ref<HTMLInputElement|null>(null)
const taskDetail=ref<HTMLElement|null>(null)
function revealTask(){void nextTick(()=>taskDetail.value?.scrollIntoView?.({block:'nearest',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}))}
const composerRoot=ref<HTMLElement|null>(null), promptInput=ref<HTMLTextAreaElement|null>(null), modelTrigger=ref<HTMLButtonElement|null>(null), ratioTrigger=ref<HTMLButtonElement|null>(null)
const modelMenuSide=ref<'above'|'below'>('below')
const modelMenu=ref<HTMLElement|null>(null), modelMenuStyle=ref<Record<string,string>>({})
function positionModelMenu(event?:Event){
 if(openControl.value!=='model'||!modelMenu.value||!modelTrigger.value)return
 if(event?.type==='scroll'&&event.target instanceof Node&&modelMenu.value.contains(event.target))return
 const anchor=modelTrigger.value.getBoundingClientRect(),height=window.innerHeight,width=window.innerWidth,gap=8,margin=12
 if(anchor.bottom<margin||anchor.top>height-margin){openControl.value=null;return}
 const above=Math.max(0,anchor.top-gap-margin),below=Math.max(0,height-anchor.bottom-gap-margin)
 const desired=Math.min(420,modelMenu.value.scrollHeight+2),up=below<desired&&above>below
 modelMenuSide.value=up?'above':'below'
 const menuWidth=Math.min(280,width-margin*2)
 modelMenuStyle.value={position:'fixed',boxSizing:'border-box',width:menuWidth+'px',maxWidth:menuWidth+'px',left:Math.max(margin,Math.min(anchor.right-menuWidth,width-menuWidth-margin))+'px',right:'auto',top:up?'auto':Math.max(margin,anchor.bottom+gap)+'px',bottom:up?Math.max(margin,height-anchor.top+gap)+'px':'auto',maxHeight:Math.min(420,height-margin*2,up?above:below)+'px'}
}
const modeLabel=computed(()=>kind.value==='video' ? '视频创作' : imageMode.value==='edit' ? '图生图' : '文生图')
const visibleOffers=computed(()=>offers.value.filter(o=>kind.value==='video' || (imageMode.value==='edit' ? o.spec.references.image.max>0 && o.spec.references.total_max>0 : o.spec.references.image.min===0)))
const referenceOffers=computed(()=>kind.value==='image'?offers.value.filter(o=>o.spec.references.image.max>0&&o.spec.references.total_max>0):visibleOffers.value)
const offer=computed(()=>visibleOffers.value.find(o=>o.offer_id===offerId.value))
const outputFormatLabels:Record<string,string>={auto:'由模型决定',png:'PNG',jpeg:'JPEG',webp:'WebP'}
const outputFormats=computed(()=>kind.value==='image' ? (offer.value?.spec.output_formats||[]).filter(value=>['png','jpeg','webp'].includes(value)) : [])
watch(outputFormats,formats=>{if(offer.value&&outputFormat.value!=='auto'&&!formats.includes(outputFormat.value)){outputFormat.value='auto';intent=undefined}},{flush:'sync'})
const showUploader=computed(()=>kind.value==='video' || imageMode.value==='edit' || uploads.value.length>0)
const quoteExpired=(task:StudioTask)=>!Number.isFinite(Date.parse(task.expiresAt)) || clock.value>=Date.parse(task.expiresAt)
const quotePending=(task:StudioTask)=>task.status==='prepared' && !quoteExpired(task)
const taskFailed=(task:StudioTask)=>['failed','released'].includes(task.status)
const failureSummary=(task:StudioTask)=>task.billingState==='not_charged'?'生成失败，未收费':task.status==='released'?'生成失败，费用已释放':task.billingState==='billed'?'生成失败，费用已结算':'生成失败，费用状态待确认'
const placeholderIcon=(task:StudioTask)=>taskFailed(task)?'exclamationCircle':resultExpired(task)?'clock':task.kind==='video'?(needsRecovery(task)?'clock':'play'):'grid'
const placeholderText=(task:StudioTask)=>task.status==='prepared' && quoteExpired(task)?'报价已失效':resultExpired(task)?'原片已到期':taskFailed(task)?'生成失败':task.kind==='video'&&needsRecovery(task)?(['processing','queued'].includes(task.status)?'等待视频生成':'结果待确认'):statusText(task.status)
const isFailedTask=(task:StudioTask)=>['failed','released'].includes(task.status) && typeof task.billingState === 'string' && ['billed','not_charged'].includes(task.billingState)
const historyScope=computed(()=>historyMode.value&&historyFilter.value!=='all'?history.value.filter(task=>task.kind===historyFilter.value):history.value)
const failedHistoryCount=computed(()=>historyScope.value.filter(isFailedTask).length)
const filteredHistory=computed(()=>historyScope.value.filter(task=>{
 const status=historyMode.value?historyStatus.value:'all'
 if(status==='all'&&!showFailed.value&&isFailedTask(task))return false
 if(status==='completed'&&!['completed','partial'].includes(task.status))return false
 if(status==='pending'&&!needsRecovery(task))return false
 if(status==='prepared'&&task.status!=='prepared')return false
 if(status==='failed'&&!taskFailed(task))return false
 const query=historyMode.value?historySearch.value.trim().toLocaleLowerCase():''
 return !query||`${taskModel(task)} ${specText(task)} ${taskDate(task)}`.toLocaleLowerCase().includes(query)
}))
const displayHistory=computed(()=>historyMode.value?filteredHistory.value:filteredHistory.value.slice(0,3))
const canStartNew=computed(()=>!!active.value)
const hasResults=(task:StudioTask)=>['completed','partial'].includes(task.status) && task.resultCount>0
const resultExpired=(task:StudioTask)=>studioResultExpired(task,clock.value)
const readableResults=(task:StudioTask)=>hasResults(task) && !resultExpired(task)
const resultUrl=(task:StudioTask,index=0)=>studioResultUrl(task,index,clock.value)
function retentionText(task:StudioTask){
 const retention=task.resultRetention, deadline=retention?.expiresAt
 const promise=retention?.policy==='image_legacy_7d'?'（历史7天保留）':''
 if(deadline)return `原片${resultExpired(task)?'已到期':'到期时间'}${promise}：${new Date(deadline).toLocaleString('zh-CN',{hour12:false})}。`
 return resultExpired(task)?'原片已到期；服务端未提供具体到期时间。':'原片保留期限：服务端未提供具体到期时间。'
}
function guardDownload(event:MouseEvent,task:StudioTask){if(studioResultExpired(task)){event.preventDefault();event.stopImmediatePropagation();clock.value=Date.now()}}
const needsRecovery=(task:StudioTask)=>['unknown','queued','processing','billing_pending','reserve_pending','recovery_blocked'].includes(task.status)
const taskDate=(task:StudioTask)=>Number.isFinite(Date.parse(task.createdAt)) ? new Date(task.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '时间待确认'
const ratioShape=(r:string)=>{const match=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r);const n=match ? Number(match[1])/Number(match[2]) : 1;return {width:`${Math.round(17*Math.min(1,Number.isFinite(n)&&n>0?n:1))}px`,height:`${Math.round(17/Math.max(1,Number.isFinite(n)&&n>0?n:1))}px`}}
function imageUnavailable(event:Event){const image=event.target as HTMLImageElement;image.classList.add('unavailable');image.alt='预览暂不可用，请打开任务查看原片'}
async function toggleControl(which:'model'|'ratio'){if(busy.value||active.value)return;openControl.value=openControl.value===which?null:which;await nextTick();if(openControl.value==='model')positionModelMenu();if(openControl.value)composerRoot.value?.querySelector<HTMLElement>(which==='model'?'#studio-offer':'#studio-ratio-menu button')?.focus({preventScroll:true})}
function closeControl(){const previous=openControl.value;openControl.value=null;void nextTick(()=>{(previous==='model'?modelTrigger:previous==='ratio'?ratioTrigger:null)?.value?.focus()})}
function clickOutside(event:PointerEvent){if(openControl.value&&!composerRoot.value?.contains(event.target as Node))openControl.value=null}
function focusPrompt(){historyMode.value=false;createMenuOpen.value=false;void nextTick(()=>promptInput.value?.focus())}
function backToList(){if(busy.value)return;active.value=null;quoteConfirm.value=false;resultRead.value++;remember()}
async function openHistory(){if(busy.value)return;backToList();historyMode.value=true;createMenuOpen.value=false;openControl.value=null;await loadHistory()}
async function startNew(mode:'text'|'edit'|'video'){createMenuOpen.value=false;await changeMode(mode)}
async function changeMode(mode:'text'|'edit'|'video'){
 if(busy.value)return
 historyMode.value=false;openControl.value=null
 const nextKind=mode==='video'?'video':'image', sameKind=nextKind===kind.value
 if(sameKind&&active.value)newTask()
 if(mode==='text'&&uploads.value.length){clearAssets();notice.value='已切换为文生图，当前输入不再使用参考素材。'}
 imageMode.value=mode==='edit'?'edit':'text'
 if(!sameKind){releaseLeavingPreviews();quoteConfirm.value=false;active.value=null;intent=undefined;kind.value=nextKind;await load(undefined,false);focusPrompt();return}
 if(!visibleOffers.value.some(o=>o.offer_id===offerId.value)){offerId.value=visibleOffers.value[0]?.offer_id||'';selectOffer()}
 remember();focusPrompt()
}
const countOptions=computed(()=>specOptions('count').map(Number))
const invalidCount=computed(()=>kind.value==='image' && !countOptions.value.includes(count.value))
const referenceHint=computed(()=>{
 if(!offer.value)return '请先选择生成模型。'
 const compatible=productReferenceOffers(offer.value,referenceOffers.value,selectedSpec.value)
 const allowed=(['image','video','audio'] as const).flatMap(type=>{
  const max=Math.max(0,...compatible.map(o=>o.spec.references[type].max))
  return max?[`${assetTypeNames[type]}最多 ${max} ${type==='image'?'张':'段'}`]:[]
 })
 if(!allowed.length)return '此模型当前规格仅支持文字描述。'
 const total=Math.max(0,...compatible.map(o=>o.spec.references.total_max))
 const required=kind.value==='image'&&imageMode.value==='edit'||compatible.length>0&&compatible.every(o=>Object.values({image:o.spec.references.image,video:o.spec.references.video,audio:o.spec.references.audio}).some(r=>r.min>0))
 return `${allowed.join(' · ')}${allowed.length>1?` · 合计最多 ${total} 项`:''}。${required?'需添加符合模型要求的素材。':'不添加素材也可以创作。'}`
})
const accept=computed(()=>{const compatible=offer.value?productReferenceOffers(offer.value,referenceOffers.value,selectedSpec.value):[];return (['image','video','audio'] as const).filter(type=>compatible.some(o=>o.spec.references[type].max>0)).map(type=>`${type}/*`).join(',')})
const assets=computed(()=>uploads.value.flatMap(item=>item.receipt ? [item.receipt] : []))
const publishedRatioOffers=computed(()=>ratioOfferOptions(offer.value,visibleOffers.value,{resolution:resolution.value,quality:quality.value,count:count.value,images:assets.value.filter(item=>item.kind==='image').length,videos:assets.value.filter(item=>item.kind==='video').length,audio:assets.value.filter(item=>item.kind==='audio').length,...(outputFormat.value!=='auto'?{output_format:outputFormat.value}:{})}))
const selectedSpec=computed(()=>({resolution:resolution.value,aspect_ratio:ratio.value,quality:quality.value,duration_seconds:kind.value==='video'?duration.value:0,count:kind.value==='image'?count.value:1,images:assets.value.filter(item=>item.kind==='image').length,videos:assets.value.filter(item=>item.kind==='video').length,audio:assets.value.filter(item=>item.kind==='audio').length,...(outputFormat.value!=='auto'?{output_format:outputFormat.value}:{})}))
function specOptions(dimension:OfferDimension){return productDimensionValues(offer.value,visibleOffers.value,dimension)}
const resolutionOptions=computed(()=>specOptions('resolution').map(String))
const qualityOptions=computed(()=>specOptions('quality').map(String))
const durationOptions=computed(()=>specOptions('duration_seconds').map(Number).sort((a,b)=>a-b))
const ratioOptions=computed(()=>kind.value==='image'?[...publishedRatioOffers.value.keys()]:specOptions('aspect_ratio').map(String))
function choosePublishedSpec(dimension:OfferDimension,value:string|number){
 if(busy.value||catalogLoading.value||active.value)return
 if(!specOptions(dimension).includes(value)){if(dimension==='count'){count.value=Number(value);intent=undefined}return}
 if(dimension==='resolution')resolution.value=String(value)
 else if(dimension==='quality')quality.value=String(value)
 else if(dimension==='duration_seconds')duration.value=Number(value)
 else if(dimension==='count')count.value=Number(value)
 else ratio.value=String(value)
 const target=offer.value&&resolveProductOffer(offer.value,visibleOffers.value,selectedSpec.value)
 if(target)offerId.value=target.offer_id
 intent=undefined
}
function choosePublishedRatio(value:string){if(busy.value||catalogLoading.value||active.value)return;if(kind.value==='video'){choosePublishedSpec('aspect_ratio',value);return;}const target=publishedRatioOffers.value.get(value);if(!target)return;offerId.value=target.offer_id;ratio.value=value;intent=undefined}
// Reference/count changes can select another price rule, but never change user specifications.
function syncSelectedOffer(){if(!offer.value||active.value||busy.value||catalogLoading.value)return;const target=resolveProductOffer(offer.value,visibleOffers.value,selectedSpec.value);if(target&&target.offer_id!==offerId.value){offerId.value=target.offer_id;intent=undefined}}
watch(selectedSpec,syncSelectedOffer)

const unmatchedSpec=computed(()=>!!offer.value?.product_scope&&!resolveProductOffer(offer.value,visibleOffers.value,selectedSpec.value))
const incompatible=computed(()=>!offer.value || unmatchedSpec.value || kind.value==='image' && (imageMode.value==='edit' ? !assets.value.some(a=>a.kind==='image') : assets.value.length>0) || ['image','video','audio'].some(k=>{const n=assets.value.filter(a=>a.kind===k).length;const r=offer.value!.spec.references[k as StudioAssetReceipt['kind']];return n<r.min || n>r.max}) || assets.value.length>offer.value.spec.references.total_max)
const expired=computed(()=>!active.value || quoteExpired(active.value))
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
const statuses:Record<string,string>={prepared:'报价已锁定，等待确认生成',processing:'生成中',queued:'排队中',completed:'生成完成，原始结果已保存',partial:'部分完成',unknown:'结果待确认',billing_pending:'结果已保存，结算待确认',failed:'生成失败',released:'生成失败，费用已释放',reserve_pending:'结果待确认：费用预占处理中，请查询原任务',recovery_blocked:'结果待确认：原任务身份暂不可用，恢复受阻'}
const statusText=(status:string)=>statuses[status]||'结果待确认'
const taskStatusText=(task:StudioTask)=>task.status==='prepared' && quoteExpired(task)?'报价已失效':statusText(task.status)
const taskModel=(task:StudioTask)=>offers.value.find(o=>o.offer_id===task.offerId)?.display_name||(!/^media[-_]/.test(task.model)?task.model:'')||'已保存的创作'
const specText=(task:StudioTask)=>[task.spec.resolution,task.spec.aspect_ratio,task.kind==='image'&&typeof task.spec.output_format==='string'?outputFormatLabels[task.spec.output_format]||task.spec.output_format:'',task.spec.duration_seconds?`${task.spec.duration_seconds}秒`:'',`${task.spec.count??1}${task.kind==='image'?'张':'条'}`].filter(Boolean).join(' / ')
function remember(){try{if(storage)sessionStorage.setItem(storage,JSON.stringify({kind:kind.value,imageMode:imageMode.value,id:active.value?.id,view:active.value?'task':'compose',attempted:[...attempted]}))}catch{/* Durable server history remains available when browser storage is unavailable. */}}
function resultLoaded(task:StudioTask,index:number){const key=`${task.id}-${index}`;loadingResults.value[key]=false;unavailableResults.value[key]=false}
function resultUnavailable(task:StudioTask,index:number){
 const key=`${task.id}-${index}`
 if(retryingResults.get(key)===resultRead.value)return
 if(task.kind==='video'&&!retriedResults.has(key)&&!resultExpired(task)){void retryResultRead(task,index);return}
 loadingResults.value[key]=false;unavailableResults.value[key]=true
}
async function retryResultRead(task:StudioTask,index:number){
 const key=`${task.id}-${index}`
 if(retryingResults.get(key)===resultRead.value||resultExpired(task)||expiredResults.value[key])return
 const selection=resultRead.value
 retriedResults.add(key);retryingResults.set(key,selection)
 loadingResults.value[key]=true;unavailableResults.value[key]=false;delete resultMessages.value[key]
 const current=()=>mounted&&active.value?.id===task.id&&active.value.kind===task.kind&&selection===resultRead.value
 try{
  if(task.kind==='video')await recoverStudioMediaRead(resultUrl(task,index-1))
  else await ensureStudioSession()
  if(!current())return
  if(resultExpired(task)){loadingResults.value[key]=false;return}
  resultRead.value++
 }catch(e){
  if(!current())return
  loadingResults.value[key]=false
  if(e instanceof StudioError&&e.code==='result_expired')expiredResults.value[key]=true
  else {unavailableResults.value[key]=true;resultMessages.value[key]=e instanceof StudioError&&e.code==='login_required'?'登录状态已失效，请重新登录后重试':'原片加载失败，请重试'}
 }finally{if(retryingResults.get(key)===selection)retryingResults.delete(key)}
}
function accepted(task:StudioTask,select=true){
 if(!mounted)return
 if(task.status==='prepared'&&attempted.has(task.id))task={...task,status:'unknown'}
 if(select || active.value?.id===task.id && active.value.kind===task.kind){active.value=task;resultRead.value++;if(hasResults(task))for(let i=1;i<=task.resultCount;i++)loadingResults.value[`${task.id}-${i}`]=true}
 if(select || task.kind===kind.value)history.value=[task,...history.value.filter(t=>t.id!==task.id)]
 remember()
}
function selectOffer(){if(offer.value)unavailableOffers.value.delete(`${kind.value}:${offerId.value}`);const s=offer.value?.spec;resolution.value=s?.resolution?.[0]||'';ratio.value=s?.aspect_ratio?.[0]||'';quality.value=s?.quality?.[0]||'';duration.value=s?.duration_seconds?.[0]||0;count.value=kind.value==='image' ? countOptions.value[0]??1 : 1;intent=undefined}
async function newTask(){
 if(busy.value || !active.value)return
 const nextKind=active.value.kind
 if(nextKind!==kind.value){await changeMode(nextKind==='video'?'video':uploads.value.length?'edit':'text');return}
 if(nextKind==='image')imageMode.value=uploads.value.length?'edit':'text'
 quoteConfirm.value=false;active.value=null;intent=undefined;error.value='';notice.value='';historyMode.value=false;createMenuOpen.value=false;remember();focusPrompt()
}
async function loadHistory(){if(busy.value||historyLoading.value)return;const epoch=generation;historyLoading.value=true;try{
 const kinds:StudioKind[]=historyFilter.value==='all'?['image','video']:[historyFilter.value]
 const settled=await Promise.allSettled(kinds.map(value=>studioHistory(value)))
 if(epoch!==generation)return
 const tasks=settled.flatMap(result=>result.status==='fulfilled'?result.value:[])
 if(settled.some(result=>result.status==='rejected')&&tasks.length===0)throw settled.find(result=>result.status==='rejected')?.reason
 const seen=new Set<string>();history.value=tasks.filter(task=>!seen.has(task.id)&&seen.add(task.id)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
 }catch(e){error.value=studioErrorMessage(e)}finally{historyLoading.value=false}}
async function load(selectedId?:unknown,restorePending=true){const epoch=++generation;busy.value=true;error.value='';active.value=null;enabled.value=false;readinessState.value='unknown';offers.value=[];history.value=[];try{
 const originalKind=kind.value,catalogRequest=studioCatalog(originalKind)
 // Creation entry provisions the owner's native Key. Read its gate only after
 // that operation settles; history reads remain independent and never provision.
 const readinessRequest=catalogRequest.catch(()=>undefined).then(()=>studioRequest<{paid_enabled:boolean}>(originalKind,'readiness'))
 const [catalog,tasks,readiness]=await Promise.allSettled([catalogRequest,studioHistory(originalKind),readinessRequest]);
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
  const catalogRequest=studioCatalog(originalKind)
  const [catalog,readiness]=await Promise.allSettled([catalogRequest,catalogRequest.catch(()=>undefined).then(()=>studioRequest<{paid_enabled:boolean}>(originalKind,'readiness'))])
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
 if(!historyMode.value){if(busy.value||historyLoading.value)return;const epoch=generation,originalKind=kind.value;historyLoading.value=true;try{const tasks=await studioHistory(originalKind);if(epoch===generation&&originalKind===kind.value)history.value=tasks}catch(e){if(epoch===generation)error.value=studioErrorMessage(e)}finally{historyLoading.value=false}return}
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
  feedback.value[original.id]={at:Date.now(),message:unchanged?`已查询原任务，暂无新结果。当前状态：${taskStatusText(task)}。`:`原任务已更新：${taskStatusText(task)}。`}
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
function assetPreview(file:File){return !!assetKind(file) && typeof URL.createObjectURL==='function' ? URL.createObjectURL(file) : undefined}
function revokePreview(item:StudioAssetUpload){if(item.previewUrl&&typeof URL.revokeObjectURL==='function')URL.revokeObjectURL(item.previewUrl)}
function removeAsset(item:StudioAssetUpload){if(active.value)return;item.controller?.abort();revokePreview(item);uploads.value=uploads.value.filter(candidate=>candidate.id!==item.id);assetMessage.value='';intent=undefined;if(!uploads.value.length)assetsCollapsed.value=false}
function clearAssets(){if(active.value)return;uploads.value.forEach(item=>{item.controller?.abort();revokePreview(item)});uploads.value=[];assetsCollapsed.value=false;assetMessage.value='';notice.value='';error.value='';intent=undefined}
function addUpload(file:File):StudioAssetUpload{
 const kind=assetKind(file), item:StudioAssetUpload={id:crypto.randomUUID(),file,kind:kind||'image',status:'failure',previewUrl:assetPreview(file)}
 if(!offer.value){item.error='请先选择模型。';uploads.value.push(item);return item}
 if(!kind){item.error='素材类型不受支持。';uploads.value.push(item);return item}
 item.status='pending';uploads.value.push(item);return item
}
function currentUpload(item:StudioAssetUpload){return uploads.value.find(candidate=>candidate.id===item.id)}
async function uploadOne(item:StudioAssetUpload){const current=currentUpload(item);if(!mounted||!current||current.status!=='pending')return;const controller=new AbortController();current.controller=controller;try{
 await ensureStudioSession();if(!mounted||currentUpload(item)!==current||controller.signal.aborted)return;const receipt=await uploadStudioAsset(current.file,current.kind,controller.signal);if(!mounted||currentUpload(item)!==current||controller.signal.aborted)return;current.receipt=receipt;current.status='success';notice.value='素材已私有保存，顺序如上。'
 }catch(e){if(!mounted||currentUpload(item)!==current||controller.signal.aborted||e instanceof DOMException&&e.name==='AbortError')return;current.status='failure';current.error=assetError(e);assetMessage.value=current.error;notice.value=''}}
async function enqueueFiles(files:File[]){
 if(!files.length||busy.value||active.value)return
 const current=offer.value
 if(!current){assetMessage.value='请先选择模型。';return}
 if(files.some(file=>!assetKind(file))){assetMessage.value='请选择图片、视频或音频文件。';return}
 const existing=uploads.value.filter(item=>item.status!=='failure')
 const projectedCount=(type:StudioAssetReceipt['kind'])=>existing.filter(item=>item.kind===type).length+files.filter(file=>assetKind(file)===type).length
 const selection={...selectedSpec.value,images:projectedCount('image'),videos:projectedCount('video'),audio:projectedCount('audio')}
 const editing=kind.value==='image'&&files.some(file=>assetKind(file)==='image'),pool=editing?referenceOffers.value:visibleOffers.value
 const compatible=productReferenceOffers(current,pool,selection).filter(candidate=>supportsProductReferences(candidate,[candidate],selection))
 const target=resolveProductOffer(current,pool,selection)||compatible.find(candidate=>candidate.offer_id===current.offer_id)||(compatible.length===1?compatible[0]:undefined)
 if(!target){assetMessage.value='已达到该模型的素材数量上限或当前规格不支持这些素材，请调整本次选择。';return}
 busy.value=true;error.value='';assetMessage.value='';notice.value='素材上传中…'
 if(editing){offerId.value=target.offer_id;imageMode.value='edit';intent=undefined}
 const pending=files.map(addUpload).filter(item=>item.status==='pending')
 let cursor=0
 try{await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{while(cursor<pending.length && mounted){const item=pending[cursor++]!;await uploadOne(item)}}))}
 finally{if(mounted){busy.value=false;syncSelectedOffer();if(!uploads.value.some(item=>item.status==='pending'))notice.value=uploads.value.some(item=>item.status==='success')?'素材已私有保存，顺序如上。':'';}}
}
function upload(e:Event){const input=e.target as HTMLInputElement;void enqueueFiles(Array.from(input.files||[]));input.value=''}
function drop(e:DragEvent){void enqueueFiles(Array.from(e.dataTransfer?.files||[]))}
function paste(event:Event){const e=event as ClipboardEvent;const files=Array.from(e.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);const fallback=files.length?files:Array.from(e.clipboardData?.files||[]).filter(file=>file.type.startsWith('image/'));if(fallback.length)void enqueueFiles(fallback)}
async function quote(){if(busy.value||catalogLoading.value||selectionUnavailable.value||active.value||!offer.value)return;syncSelectedOffer();if(offer.value.product_scope&&!resolveProductOffer(offer.value,visibleOffers.value,selectedSpec.value)||incompatible.value||hasUnreadyAssets.value||invalidCount.value||!prompt.value.trim())return;busy.value=true;openControl.value=null;error.value='';notice.value='';try{
 const o=offer.value,refs=assets.value.map(a=>({kind:a.kind,asset_ref:a.asset_ref})),spec={...(kind.value==='image'&&outputFormat.value!=='auto'&&outputFormats.value.includes(outputFormat.value)?{output_format:outputFormat.value}:{}),resolution:resolution.value,aspect_ratio:ratio.value,duration_seconds:kind.value==='video'?duration.value:0,quality:kind.value==='image'?quality.value:'',count:kind.value==='image'?count.value:1,images:refs.filter(a=>a.kind==='image').length,videos:refs.filter(a=>a.kind==='video').length,audio:refs.filter(a=>a.kind==='audio').length}
 const fingerprint=JSON.stringify({kind:kind.value,offer:o.offer_id,spec,refs,prompt:prompt.value});if(intent?.fingerprint!==fingerprint)intent={fingerprint,clientKey:crypto.randomUUID()}
 if(kind.value==='video'){
   if((o.input_mode==='references'||o.input_mode==='image2pro')&&assets.value.length&&!intent.preparationId){const p=await studioRequest<{preparation_id:string}>('video','prepare',{offer_id:o.offer_id,model:o.model,spec,assets:refs});if(typeof p.preparation_id!=='string')throw new StudioError('studio_contract');intent.preparationId=p.preparation_id}
   accepted(studioTaskView('video',await studioRequest('video','quotes',{client_key:intent.clientKey,offer_id:o.offer_id,model:o.model,prompt:prompt.value,duration:spec.duration_seconds,resolution:spec.resolution,ratio:spec.aspect_ratio,assets:refs,...(intent.preparationId?{preparation_id:intent.preparationId}:{})})))
 }else{
   if(!intent.quoteToken){const q=await studioRequest<{quote_token:string}>('image','quotes',{offer_id:o.offer_id,spec});if(typeof q.quote_token!=='string')throw new StudioError('studio_contract');intent.quoteToken=q.quote_token}
   accepted(studioTaskView('image',await studioRequest('image','prepare',{quote_token:intent.quoteToken,client_key:intent.clientKey,prompt:prompt.value,asset_refs:refs.map(a=>a.asset_ref)})))
 }
 if(active.value){quoteConfirm.value=true;revealTask()}
 }catch(e){error.value=studioErrorMessage(e);if(e instanceof StudioError&&e.status===409&&!e.code.includes('paid_gate_off')){intent=undefined;quoteConfirm.value=false;await refreshCatalog()}history.value=await studioHistory(kind.value).catch(()=>history.value)}finally{busy.value=false}}
async function generate(){
 clock.value=Date.now()
 if(busy.value||catalogLoading.value||activeQuoteUnavailable.value||!active.value||active.value.status!=='prepared'||!enabled.value||expired.value||attempted.has(active.value.id))return
 const task=active.value;quoteConfirm.value=false;error.value='';attempted.add(task.id);submitting.value[task.id]=clock.value;accepted({...task,status:'unknown'})
 try{accepted(await studioGenerate(task),false)}catch(e){
  if(!mounted)return
  if(e instanceof StudioError&&(e.code.includes('paid_gate_off')||e.code.endsWith('quote_expired'))){attempted.delete(task.id);accepted(task,false)}
  feedback.value[task.id]={at:Date.now(),message:'本次提交未取得最终结果。',error:e instanceof StudioError && e.code==='image_binding_unavailable'?'本次请求未取得可确认的结果。请查询原任务；不会重新发送生成请求。':studioErrorMessage(e)}
 }finally{delete submitting.value[task.id]}
}
onMounted(async()=>{window.addEventListener('resize',positionModelMenu);window.addEventListener('scroll',positionModelMenu,true);window.addEventListener('paste',paste);window.addEventListener('pointerdown',clickOutside);try{const session=await ensureStudioSession();if(!mounted)return;storage=`studio-media-view-${session.owner_id}`;let selected:unknown,restorePending=true;try{const raw=JSON.parse(sessionStorage.getItem(storage)||'{}');if(raw.kind==='image'||raw.kind==='video')kind.value=raw.kind;if(raw.imageMode==='edit')imageMode.value='edit';selected=raw.id;restorePending=raw.view!=='compose';if(Array.isArray(raw.attempted))attempted=new Set(raw.attempted.filter((id:unknown)=>typeof id==='string'))}catch{/* Server history remains authoritative. */}await load(selected,restorePending)}catch(e){if(!mounted)return;error.value=studioErrorMessage(e);busy.value=false}
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
onUnmounted(()=>{window.removeEventListener('resize',positionModelMenu);window.removeEventListener('scroll',positionModelMenu,true);mounted=false;generation++;if(timer)clearInterval(timer);window.removeEventListener('paste',paste);window.removeEventListener('pointerdown',clickOutside);uploads.value.forEach(item=>{item.controller?.abort();revokePreview(item)})})
</script>

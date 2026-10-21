<template>
  <AppLayout>
    <div class="media-workbench" :class="[`mw-step-${step}`, { 'mw-cost-open': costOpen }]" :aria-busy="!!pending || loading">
      <header class="mw-heading">
        <div>
          <h1>媒体工作台</h1>
          <p v-if="step !== 'editor'" class="mw-muted">选择现有账号，为模型配置可售规格和价格。</p>
        </div>
        <nav class="mw-steps" aria-label="工作台导航">
          <span :class="{ 'mw-step-current': step === 'suppliers' }">来源与账号</span>
          <span :class="{ 'mw-step-current': step === 'models' }">选择模型</span>
          <span :class="{ 'mw-step-current': step === 'editor' }">配置商品</span>
        </nav>
      </header>

      <MediaPaidControls v-if="step === 'suppliers'" :suppliers="suppliers" :suppliers-loading="loading" />
      <div v-if="step === 'suppliers'" class="mw-statistics">
        <div><span>来源分组</span><strong data-test="source-count">{{ sourceGroups.length }}</strong></div>
        <div><span>Account 账号</span><strong data-test="account-count">{{ suppliers.length }}</strong></div>
        <div><span>待配置模型</span><strong>{{ suppliers.reduce((n, s) => n + s.pending_count, 0) }}</strong></div>
        <div><span>已发布模型</span><strong>{{ publishedCount }}</strong></div>
      </div>

      <div v-if="message" class="mw-banner" role="status" data-test="banner">
        <span>{{ message }}</span>
        <button v-if="detail && !deleted" class="btn btn-secondary" data-test="reload" :disabled="busy" @click="checkServer">核对服务器状态</button>
        <button v-if="detail && !deleted" class="btn btn-secondary" data-test="discard-reload" :disabled="busy" @click="reloadDialog = true">放弃修改并重新加载</button>
        <button v-else-if="deleted" class="btn btn-secondary" :disabled="busy" @click="navigate(returnToSuppliers)">返回账号列表</button>
        <button v-else-if="!detail" class="btn btn-secondary" :disabled="busy" @click="loadSuppliers">重试读取</button>
      </div>
      <p v-if="loadingAccountId !== null" role="status" data-test="account-loading">正在读取 Account #{{ loadingAccountId }} 的配置…</p>
      <p v-else-if="loading" role="status">正在读取账号列表…</p>

      <main class="mw-flow">
        <section v-if="step === 'suppliers'" class="mw-page mw-panel" aria-label="来源与账号导航" data-test="account-page">
          <div class="mw-page-heading">
            <div><p class="mw-eyebrow">选择 Account</p><h2>先选择来源与 Account</h2><p class="mw-muted">来源域名默认折叠。搜索支持数字 Account ID、名称、域名和平台。</p></div>
            <span class="mw-badge">{{ visibleAccountCount }} / {{ suppliers.length }} 个账号</span>
          </div>
          <div class="mw-toolbar">
            <label class="mw-field mw-account-search">查找账号<input v-model="accountSearch" class="input" placeholder="ID、名称、域名或平台" type="search" data-test="account-search" /></label>
            <label class="mw-field">媒体状态<select v-model="accountFilter" class="input" data-test="account-filter"><option value="">全部状态</option><option v-for="(label, state) in accountStates" :key="state" :value="state">{{ label }}</option></select></label>
            <label class="mw-field">平台<select v-model="platformFilter" class="input" data-test="platform-filter"><option value="">全部平台</option><option v-for="platform in platforms" :key="platform" :value="platform">{{ platform }}</option></select></label>
            <button v-if="accountSearch || accountFilter || platformFilter" type="button" class="mw-link mw-clear-filter" data-test="clear-account-search" @click="clearAccountFilters">清空搜索与筛选</button>
          </div>
          <p v-if="!suppliers.length && !loading" class="mw-muted">暂无可用账号，请先在账户管理添加 API-Key 账户。</p>
          <p v-else-if="!filteredGroups.length" class="mw-muted">没有匹配的账号。</p>
          <div ref="sourceListRef" class="mw-source-list mw-source-list-page">
            <details v-for="group in filteredGroups" :key="group.host" class="mw-source-group" :open="sourceOpen(group.host)" :data-test="`source-${group.host || 'unknown'}`">
              <summary @click.prevent="toggleSource(group.host)"><strong>{{ group.host || '未识别来源' }}</strong><span>{{ group.accounts.length }} 个账号</span></summary>
              <div class="mw-source-accounts">
                <button v-for="supplier in group.accounts" :key="supplier.id" type="button" class="mw-supplier" :class="{ 'mw-selected': detail?.id === supplier.id }" :aria-pressed="detail?.id === supplier.id" :disabled="busy" :data-test="`supplier-${supplier.id}`" @click="navigate(() => openSupplier(supplier.id))">
                  <span class="mw-account-title"><b>#{{ supplier.id }}</b><strong>{{ supplier.name }}</strong></span>
                  <span class="mw-account-meta"><span class="mw-platform">{{ supplier.platform || '未知平台' }}</span><span :title="effectiveLabel(supplier.effective_state)">{{ accountStates[accountState(supplier)] || effectiveLabel(supplier.effective_state) }}</span></span>
                  <small>{{ supplier.configured_count }} 已配置 · {{ supplier.pending_count }} 待配置<span v-if="supplier.problem_count"> · {{ supplier.problem_count }} 需处理</span></small>
                </button>
              </div>
            </details>
          </div>
          <p class="mw-source-note">域名只用于分组；每个 Account 的模型和销售状态独立管理。</p>
        </section>

        <section v-else-if="step === 'models'" ref="modelPage" class="mw-page mw-panel" aria-label="模型列表" data-test="model-page">
          <button type="button" class="mw-back btn btn-secondary" :disabled="busy" @click="navigate(() => { step = 'suppliers' })">← 返回来源与账号</button>
          <div v-if="detail" class="mw-page-heading mw-account-context">
            <div><p class="mw-eyebrow">模型管理 · Account #{{ detail.id }}</p><h2>{{ detail.name }}</h2><p class="mw-muted mw-account-host">{{ sourceHost(detail) || '未识别来源' }} · {{ detail.platform || '未知平台' }}</p><p class="mw-muted">媒体类型：{{ mediaTypeLabel }}</p><p class="mw-muted">{{ effectiveLabel(detail.effective_state) }}</p></div>
            <div class="mw-selection-feedback" data-test="selected-account-summary"><strong>已选择账号</strong><span>#{{ detail.id }} · {{ detail.name }}</span></div>
          </div>
          <section class="mw-account-publication" aria-label="Account 发布与销售操作" data-test="account-publication">
            <div class="mw-publication-description">
              <h3>Account #{{ detail?.id }} · 工作台操作</h3>
              <p class="mw-muted">发布仅影响勾选商品；销售开关影响此 Account 的全部已发布工作台商品。</p>
              <p class="mw-publication-note">发布配置不会自动开启销售</p>
              <p class="mw-muted" data-test="draft-save-time">草稿最近保存：{{ draftLastSavedLabel }}</p>
              <p class="mw-muted" data-test="published-time">本账号最近发布：{{ lastPublishedLabel }}</p>
            </div>
            <div class="mw-account-actions">
              <button type="button" class="btn btn-primary mw-publish-action" data-test="publish" :disabled="!canPublish" @click="openPublish">{{ pending === 'publish' ? '发布中…' : '发布配置' }}</button>
              <div class="mw-account-sales" data-test="sales-state"><strong>{{ salesLabel }}</strong><button v-if="config" class="btn" :class="config.sales.enabled ? 'mw-danger' : 'btn-secondary'" data-test="sales" :disabled="managementDisabled || (!config.sales.enabled && !canResume)" @click="salesDialog = true">{{ config.sales.enabled ? '暂停销售' : '开启销售' }}</button><span v-else class="mw-badge">首次保存后可开启</span></div>
            </div>
          </section>
          <p v-if="config && !config.sales.enabled && !canResume" class="mw-muted">{{ resumeReason }}</p>
          <p v-if="salesFeedback" class="mw-banner" role="status" data-test="account-sales-feedback">{{ salesFeedback }}</p>
          <p v-if="publicationFeedback" class="mw-banner" role="status" data-test="publication-feedback">{{ publicationFeedback }}</p>
          <section class="mw-product-management" aria-label="配置与销售状态" data-test="publication-layers">
            <strong>分别核对配置与销售状态</strong>
            <p>草稿：{{ config ? saveStateLabel : '尚未建立' }} · 草稿校验：{{ draftValidationLabel }}</p>
            <p data-test="publication-status">发布状态：{{ publicationLabel }} · Account 销售：{{ config?.sales.enabled ? '已开启' : '已关闭' }}</p>
            <p data-test="global-paid-status">图片生成服务：{{ paidStatusLabel('image') }} · 视频生成服务：{{ paidStatusLabel('video') }}</p>
            <p v-if="config?.sales.enabled && paidStates.video?.mode === 'managed-v1' && !paidStates.video.effective_enabled" class="mw-muted" data-test="video-service-closed">销售已开启，但视频生成服务尚未开放。</p>
            <p class="mw-muted">草稿校验通过只说明保存的草稿通过检查。商品的已发布配置、Account 销售、全局付费开关和客户原生权限仍分别生效；全局开关请返回来源与账号查看。</p>
            <p class="mw-muted" data-test="native-api-boundary">商品保存、发布、上下架与归档只管理 Studio 配置和销售状态，不修改独立 API Key 的原生权限或路由；受保护的图片任务接口仍保留原有访问限制。</p>
          </section>
          <section class="mw-product-management" aria-label="逐商品销售条件" data-test="product-readiness-list">
            <h3>逐商品销售条件</h3>
            <p class="mw-muted">以下结论来自已保存的服务端状态，按商品分别核对；就绪不代表全局付费开关或每个客户的原生权限已经通过。</p>
            <p v-if="!detail?.product_states?.length" class="mw-muted">后台尚未返回逐商品状态，请重新读取后核对；不能由草稿校验通过推断当前可售。</p>
            <div v-for="item in detail?.product_states ?? []" :key="item.product_id" :data-test="`readiness-${item.product_id}`">
              <p><strong>Account #{{ detail?.id }} · {{ availabilityName(item) }}</strong> · {{ availabilityLabel(item) }}</p>
              <p>{{ item.reason }}</p><p class="mw-muted">{{ item.action }}</p>
              <div class="mw-product-type-actions">
                <button v-if="products.some(p => p.product_id === item.product_id)" class="btn btn-secondary" :disabled="busy" @click="navigate(() => editAvailability(item))">编辑此商品</button>
                <button v-if="item.state === 'UPSTREAM_REMOVED'" class="btn btn-secondary" :disabled="busy || deleted || conflict" @click="sync">同步上游目录</button>
                <router-link v-if="item.state === 'ACCOUNT_UNAVAILABLE' && detail" :to="accountLink(detail.id)" class="mw-link">打开账户详情 ↗</router-link>
              </div>
            </div>
          </section>
          <div v-if="detail" class="mw-model-toolbar">
            <button class="btn btn-secondary" data-test="sync" :disabled="busy || deleted || conflict" @click="sync">{{ pending === 'sync' ? '同步中…' : '同步模型目录' }}</button>
            <router-link :to="accountLink(detail.id)" class="mw-link">打开账户详情 ↗</router-link>
          </div>
          <div class="mw-model-filters"><label class="mw-field">搜索模型<input v-model="search" class="input" placeholder="模型名称或精确 ID" type="search" data-test="model-search" /></label>
          <label class="mw-field">模型状态<select v-model="filter" class="input" data-test="model-filter"><option value="">全部状态</option><option v-for="state in modelStates" :key="state" :value="state">{{ modelLabel(state) }}</option></select></label></div>
          <label class="mw-product-toggle"><input v-model="showArchived" type="checkbox" data-test="show-archived-models" /><span>显示已归档模型</span></label>
          <p v-if="!filteredModels.length" class="mw-muted">没有匹配模型。可同步上游模型目录。</p>
          <div class="mw-model-list">
            <button v-for="row in filteredModels" :key="row.model_id" class="mw-model-row" :class="{ 'mw-selected': selectedModel === row.model_id }" :aria-pressed="selectedModel === row.model_id" :disabled="busy" :data-test="`model-${row.model_id}`" @click="navigate(() => openEditor(row.model_id))">
              <span class="mw-model-row-main"><strong>{{ row.model_id }}</strong><span class="mw-badge" :data-state="row.state">● {{ modelLabel(row.state) }}</span></span>
              <span v-if="rowProduct(row.model_id)">{{ productDisplayTitle(rowProduct(row.model_id)!) }} · {{ rowProduct(row.model_id)?.media_type === 'video' ? '视频' : '图片' }}</span>
              <small v-if="rowProduct(row.model_id)">{{ (rowProduct(row.model_id)?.capabilities.resolutions ?? []).join(' / ') }} · {{ priceLabel(rowProduct(row.model_id)) }}</small>
              <span class="mw-model-action">{{ rowProduct(row.model_id) ? '编辑配置 →' : '配置 →' }}</span>
            </button>
          </div>


            <MediaValidationPanel v-if="config" :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :products="diagnosticProducts" :account-id="detail?.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
        </section>

        <section v-else ref="editorElement" class="mw-page mw-panel mw-editor-page" aria-label="模型配置编辑器" data-test="editor-page" @focusout="flushOnFocusOut" @click.capture="flushStep">
          <button type="button" class="mw-back btn btn-secondary" :disabled="busy" @click="navigate(backToModels)">← 返回模型列表</button>
          <div v-if="detail" class="mw-page-heading mw-account-context mw-product-context">
            <div><p class="mw-eyebrow">配置商品 · {{ product?.media_type === 'video' ? '视频' : '图片' }}</p><h2>{{ product?.display_name || selectedModel || '选择商品类型' }}</h2><p class="mw-muted">Account #{{ detail.id }} · {{ detail.name }}</p></div>
            <div class="mw-selection-feedback" data-test="selected-model-summary"><strong>当前上游模型</strong><span data-test="upstream-model-name">{{ selectedModel }}</span></div>
          </div>
          <template v-if="detail && selectedModel">
            <section class="mw-product-management" aria-label="模型生命周期" data-test="model-lifecycle">
              <div class="mw-section-heading"><strong>模型管理</strong><span class="mw-badge">{{ modelLabel(selectedRow?.state ?? '') }}</span></div>
              <p class="mw-muted">模型操作覆盖 {{ selectedModel }} 下的全部 {{ lifecycleModelProducts.length }} 份商品（包含已归档商品）。</p>
              <div class="mw-product-type-actions">
                <template v-if="lifecycleModelProducts.length">
                  <button v-if="lifecycleModelProducts.some(p => lifecycleState(p) === 'active')" class="btn btn-secondary" data-test="model-unlist" :disabled="lifecycleDisabled" @click="requestLifecycle('unlist', { model_id: selectedModel })">下架模型全部商品</button>
                  <button v-if="lifecycleModelProducts.some(p => lifecycleState(p) === 'unlisted')" class="btn btn-secondary" data-test="model-relist" :disabled="lifecycleDisabled" @click="requestLifecycle('relist', { model_id: selectedModel })">重新上架模型商品</button>
                  <button v-if="lifecycleModelProducts.some(p => lifecycleState(p) !== 'archived')" class="btn btn-secondary" data-test="model-archive" :disabled="lifecycleDisabled || modelArchiveBlocked" @click="requestLifecycle('archive', { model_id: selectedModel })">归档模型全部商品</button>
                  <button v-if="lifecycleModelProducts.some(p => lifecycleState(p) === 'archived')" class="btn btn-secondary" data-test="model-restore" :disabled="lifecycleDisabled" @click="requestLifecycle('restore', { model_id: selectedModel })">恢复模型已归档商品</button>
                </template>
                <button v-else class="btn btn-secondary" data-test="model-hide-restore" :disabled="lifecycleDisabled" @click="requestLifecycle(isModelHidden ? 'restore' : 'hide', { model_id: selectedModel })">{{ isModelHidden ? '恢复显示模型' : '隐藏未配置模型' }}</button>
              </div>
              <p v-if="modelArchiveBlocked" class="mw-muted">已发布商品需先下架，再归档。</p>
              <p v-if="dirty" class="mw-muted" data-test="lifecycle-dirty">请先保存或放弃未保存修改，再管理上下架与归档。</p>
              <label class="mw-product-toggle"><input v-model="showArchived" type="checkbox" data-test="show-archived-products" :disabled="busy || dirty" /><span>显示已归档商品</span></label>
            </section>
            <p v-if="selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING'" class="mw-muted">{{ selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING' ? '上游最新成功目录中未发现此模型，配置会保留且新报价由后台阻止。' : '请填写已确认的供应商规格；示例值不会自动写入能力或报价。' }}</p>
            <section v-if="unsubmittedRecoveries.length" class="mw-banner" data-test="unsubmitted-recoveries" aria-label="尚未提交的新商品恢复副本">
              <h3>发现尚未提交服务器的新商品</h3>
              <p>以下商品仅有浏览器恢复副本。查看后可明确恢复原商品身份、规格和价格；不会自动发布。</p>
              <ul><li v-for="entry in unsubmittedRecoveries" :key="entry.key"><span>{{ entry.value.product.display_name }} · {{ entry.value.product.media_type === 'video' ? '视频' : '图片' }} · {{ new Date(entry.value.updated_at).toLocaleString() }}</span><button type="button" class="btn btn-secondary" data-test="recover-unsubmitted" :data-product-id="entry.value.product.product_id" :disabled="busy" @click="chooseProductRecovery(entry.key)">查看并恢复此副本</button></li></ul>
            </section>
            <p v-if="!product && lifecycleModelProducts.length" class="mw-muted">当前没有可编辑的商品。已归档商品可勾选“显示已归档商品”后查看；仅有已发布版本的商品可在下方管理。</p>
            <div v-if="!product && !lifecycleModelProducts.length" class="mw-start-product mw-banner">
              <h3>先选择产品类型</h3><p>第一次保存时，后台会根据这里提交的产品类型自动初始化此 Account 的媒体配置。</p>
              <div class="mw-product-type-actions"><button class="btn btn-primary" data-test="add-product-image" :disabled="busy || deleted || conflict" @click="addProduct('image')">开始配置图片</button><button class="btn btn-secondary" data-test="add-product-video" :disabled="busy || deleted || conflict" @click="addProduct('video')">开始配置视频</button></div>
            </div>
            <section v-if="publishedOnlyProducts.length" class="mw-product-management" aria-label="仅有已发布版本的商品" data-test="published-only-products">
              <h3>仅有已发布版本的商品</h3>
              <div v-for="(p, index) in publishedOnlyProducts" :key="p.product_id">
                <p>{{ productOptionLabel(p, index) }} · {{ lifecycleLabel(p) }}</p>
                <div class="mw-product-type-actions">
                  <button v-if="lifecycleState(p) === 'active'" class="btn btn-secondary" :data-test="`published-unlist-${p.product_id}`" :disabled="lifecycleDisabled" @click="requestLifecycle('unlist', { product_id: p.product_id })">下架此商品</button>
                  <button v-if="lifecycleState(p) === 'unlisted'" class="btn btn-secondary" :data-test="`published-relist-${p.product_id}`" :disabled="lifecycleDisabled" @click="requestLifecycle('relist', { product_id: p.product_id })">重新上架此商品</button>
                  <button v-if="lifecycleState(p) === 'unlisted'" class="btn btn-secondary" :data-test="`published-archive-${p.product_id}`" :disabled="lifecycleDisabled" @click="requestLifecycle('archive', { product_id: p.product_id })">归档此商品</button>
                  <button v-if="lifecycleState(p) === 'archived'" class="btn btn-secondary" :data-test="`published-restore-${p.product_id}`" :disabled="lifecycleDisabled" @click="requestLifecycle('restore', { product_id: p.product_id })">恢复为已下架</button>
                </div>
              </div>
            </section>
            <section v-if="product" class="mw-product-management" aria-label="当前商品管理" data-test="product-management">
              <div class="mw-section-heading"><strong>正在编辑的商品</strong><span class="mw-badge" data-test="product-status">{{ lifecycleLabel(product) }} · {{ product.enabled ? '草稿：已启用' : '草稿：已停用' }}</span></div>
              <div v-if="productStateById.get(product.product_id)" data-test="selected-product-readiness">
                <p><strong>Account #{{ detail.id }} · {{ availabilityName(productStateById.get(product.product_id)!) }}</strong> · {{ availabilityLabel(productStateById.get(product.product_id)!) }}</p>
                <p>{{ productStateById.get(product.product_id)?.reason }}</p><p class="mw-muted">{{ productStateById.get(product.product_id)?.action }}</p>
                <p class="mw-muted">这是已保存的商品状态；当前草稿编辑不会自动发布。全局付费开关与客户原生权限独立核验。</p>
              </div>
              <label v-if="modelProducts.length > 1" class="mw-field">切换商品（此模型共 {{ modelProducts.length }} 份）<select :value="selectedProduct" class="input" data-test="product-select" @change="changeProduct" :disabled="busy"><option v-for="(p, index) in modelProducts" :key="p.product_id" :value="p.product_id">{{ productOptionLabel(p, index) }}</option></select></label>
              <p v-else class="mw-muted">{{ productDisplayTitle(product) }} · {{ product.media_type === 'video' ? '视频' : '图片' }}</p>
              <p v-if="modelProducts.length > 1" class="mw-product-description mw-muted" data-test="selected-product-description">当前：{{ productOptionLabel(product, modelProducts.indexOf(product)) }}</p>
              <div class="mw-product-type-actions" data-test="product-lifecycle">
                <button v-if="lifecycleState(product) === 'active'" class="btn btn-secondary" data-test="product-unlist" :disabled="lifecycleDisabled" @click="requestLifecycle('unlist', { product_id: product.product_id })">下架此商品</button>
                <button v-if="lifecycleState(product) === 'unlisted'" class="btn btn-secondary" data-test="product-relist" :disabled="lifecycleDisabled" @click="requestLifecycle('relist', { product_id: product.product_id })">重新上架此商品</button>
                <button v-if="lifecycleState(product) !== 'archived'" class="btn btn-secondary" data-test="product-archive" :disabled="lifecycleDisabled || archiveBlocked(product)" @click="requestLifecycle('archive', { product_id: product.product_id })">归档此商品</button>
                <button v-else class="btn btn-secondary" data-test="product-restore" :disabled="lifecycleDisabled" @click="requestLifecycle('restore', { product_id: product.product_id })">恢复此商品为已下架</button>
              </div>
              <p v-if="archiveBlocked(product)" class="mw-muted">此商品已经发布，请先下架再归档。</p>
              <p v-if="lifecycleState(product) === 'archived'" class="mw-muted">已归档配置保留；恢复后仍为已下架，需要单独重新上架。</p>
              <label class="mw-product-toggle"><input type="checkbox" data-test="product-enabled" :checked="product.enabled" :disabled="managementDisabled || lifecycleState(product) === 'archived'" @change="updateProduct({ ...product, enabled: ($event.target as HTMLInputElement).checked })" /><span>启用此商品<span class="mw-muted">保存并发布后生效；不会改变 Account 销售开关。</span></span></label>
              <div v-if="addedProductIds.includes(product.product_id)" class="mw-product-local" role="status"><span>本次新增，尚未保存</span><button type="button" class="btn btn-secondary" data-test="undo-add-product" :disabled="managementDisabled" @click="removeProduct(product.product_id)">撤销新增</button></div>
              <details class="mw-product-options" data-test="product-options"><summary>更多商品操作</summary>
                <p class="mw-muted">同一模型通常只需一份商品：图片的文生图、参考图编辑及多种规格可在这里一起配置。仅在需要独立售价或销售方案时另建商品。</p>
                <div class="mw-product-type-actions"><button type="button" class="btn btn-secondary" data-test="new-independent-product" :disabled="managementDisabled" @click="newProductType = product.media_type">另建独立销售商品</button><button v-if="!addedProductIds.includes(product.product_id) && !removalReason(product)" type="button" class="btn mw-danger" data-test="remove-blank-product" :disabled="managementDisabled" @click="removeProductId = product.product_id">移除空白草稿</button></div>
                <p v-if="!addedProductIds.includes(product.product_id) && removalReason(product)" class="mw-muted" data-test="removal-protection">{{ removalReason(product) }}</p>
              </details>
            </section>
            <section v-if="removedProducts.length" class="mw-removal-notice" aria-label="待保存的草稿移除" data-test="pending-removals">
              <strong>待移除 {{ removedProducts.length }} 份空白草稿，保存后生效</strong>
              <ul><li v-for="removed in removedProducts" :key="removed.product_id"><span>{{ productDisplayTitle(removed) }} · {{ removed.media_type === 'video' ? '视频' : '图片' }}</span><button type="button" class="btn btn-secondary" :disabled="managementDisabled" :data-test="`undo-removal-${removed.product_id}`" @click="undoProductRemoval(removed.product_id)">撤销移除</button></li></ul>
              <p class="mw-muted">保留原草稿副本；已发布配置、历史任务、原片和结算不变。本次其他未保存修改也会一起保存。</p>
              <button type="button" class="btn btn-primary" data-test="save-removals" :disabled="managementDisabled" @click="saveEditorDraft">保存草稿与移除操作</button>
            </section>
            <section v-if="product || recovery" aria-live="polite" class="mw-save-draft" data-test="autosave-status">
              <p>{{ recovery && !dirty && saveState === 'saved' ? '服务器草稿已确认；仍有本地内容待处理' : saveStateLabel }}<span v-if="!online"> · 当前离线，联网后核对版本再同步</span></p>
              <p class="mw-muted" data-test="draft-save-time">草稿最近保存：{{ draftLastSavedLabel }}</p>
              <p class="mw-muted" data-test="published-time">本账号最近发布：{{ lastPublishedLabel }}。保存草稿不等于发布。</p>
              <p data-test="publication-status">{{ publicationLabel }}</p>
              <p v-if="recoveryWarning" role="alert" class="mw-field-error" data-test="recovery-warning">{{ recoveryWarning }}</p>
              <div v-if="recovery" class="mw-banner" data-test="draft-recovery">
                <label v-if="productRecoveries.length > 1">此商品有 {{ productRecoveries.length }} 份独立恢复副本<select class="input" data-test="recovery-copy-select" :value="selectedRecoveryKey" :disabled="busy" @change="chooseProductRecovery(($event.target as HTMLSelectElement).value)"><option v-for="entry in productRecoveries" :key="entry.key" :value="entry.key">{{ new Date(entry.value.updated_at).toLocaleString() }} · {{ entry.value.product.display_name }} · 页面 {{ entry.value.editor_id?.slice(-8) || '旧副本' }}</option></select></label>
                <strong>发现尚未与服务器完全一致的本地修改</strong>
                <p>这份本地恢复副本暂时保留，以免修改丢失。{{ recoveryConflict ? '服务器内容已发生变化，需要核对差异。' : recovery.pending_submission ? '上一次保存结果仍待核对，确认前不会自动重发。' : recoveryDiff.length ? '本地修改尚未同步。' : '内容目前一致，但尚无足够的保存确认，请核对后处理。' }}</p>
                <p class="mw-muted">恢复只影响草稿；未应用的售价输入仍需确认，不会正式发布。</p>
                <details v-if="recoveryDiff.length" data-test="recovery-differences"><summary>查看哪些内容不同（{{ recoveryDiff.length }}）</summary><ul><li v-for="diff in recoveryDiff" :key="diff.field"><strong>{{ diff.label }}</strong><p style="overflow-wrap:anywhere;max-width:100%">本地：{{ diff.local }}</p><p style="overflow-wrap:anywhere;max-width:100%">服务器：{{ diff.server }}</p></li></ul></details>
                <label v-if="recoveryConflict"><input v-model="acceptRecoveryConflict" type="checkbox" data-test="confirm-recovery-conflict" />我已核对差异，恢复本地此商品并以服务器最新版本为基准</label>
                <button type="button" class="btn btn-secondary" data-test="restore-recovery" :disabled="busy || recoveryConflict && !acceptRecoveryConflict" @click="restoreWithUndoProtection()">{{ recovery?.removed_product ? '恢复待移除操作' : '恢复本地内容' }}</button>
                <button type="button" class="btn btn-secondary" data-test="discard-recovery" :disabled="busy" @click="discardRecoveryDialog = true">丢弃恢复副本</button>
              </div>
              <button type="button" class="btn btn-secondary" data-test="check-server" :disabled="busy" @click="checkServer">核对服务器状态</button>
              <button v-if="canRetryUnconfirmedSave" type="button" class="btn btn-secondary" data-test="retry-unconfirmed-save" @click="retryUnconfirmedSave">重新核对并保存当前草稿</button>
              <button type="button" class="btn btn-secondary" data-test="editor-discard-reload" :disabled="busy" @click="reloadDialog = true">放弃修改并重新加载</button>
            </section>
            <MediaProductEditor @cost-toggle="costOpen = $event" v-if="product" ref="productEditor" :key="`${detail.id}:${selectedProduct}`" :dirty="dirty" :account-id="detail.id" :admin-id="auth.user?.id" :binding="config?.adapter_bindings?.[product.media_type]" :native-adapter="detail.native_adapters?.[product.media_type]" :diagnostics="diagnostics" :product="product" :media-types="config?.media_types ?? [product.media_type]" :pending-video-sales="videoSaleInputs" :disabled="busy && pending !== 'save' || deleted || conflict || lifecycleState(product) === 'archived'" @pending-video-sales="updateVideoSaleInputs" @update:product="updateProduct" :account-label="`Account #${detail.id} · ${detail.name}`">
              <template #review>
            <MediaValidationPanel v-if="config" :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :products="diagnosticProducts" :account-id="detail?.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
              </template>
              <template #save>
                <div class="mw-save-draft">
                  <p class="mw-muted">停止输入约 1.5 秒后自动保存本 Account 草稿（共 {{ products.length }} 个商品）。本地恢复副本即时更新；服务器确认对应版本后才显示已确认保存。不会发布、启售或发起生成。</p>
                  <p v-if="dirty" data-test="unsaved" class="mw-muted">有未保存修改</p>
                  <button class="btn btn-primary" data-test="save" :disabled="managementDisabled || !products.length" @click="saveEditorDraft">{{ pending === 'save' ? '保存中…' : '保存草稿' }}</button>
                  <button v-if="!dirty && config" type="button" class="btn btn-secondary mw-return-models" data-test="return-models" @click="navigate(backToModels)">← 返回模型列表</button>
                  <p v-if="saveFeedback || saveState === 'saved'" class="mw-banner" role="status" data-test="save-feedback">{{ saveFeedback || '草稿已确认保存' }}</p>
                  <p v-if="saveState === 'unconfirmed'" role="status" class="mw-field-error">保存结果待核对，后续编辑仍保留本地副本；核对确认前暂停自动写入。</p>
                </div>
              </template>
            </MediaProductEditor>


          </template>
          <p v-else class="mw-muted">请先从模型列表选择一个模型。</p>
        </section>
      </main>
    </div>

    <MediaDialog :show="!!lifecycleRequest" :title="`${lifecycleActionLabel(lifecycleRequest?.action)}确认`" :busy="pending === 'lifecycle'" @close="lifecycleRequest = null">
      <template v-if="lifecycleRequest">
        <p>Account #{{ detail?.id }} · {{ detail?.name }}</p>
        <p v-if="lifecycleRequest.target.model_id">目标模型：{{ lifecycleRequest.target.model_id }}。以下是此模型的全部商品，操作不受列表筛选影响。</p>
        <p v-else>仅操作下面这份商品，同模型的其他商品独立管理。</p>
        <ul class="mw-dialog-list" data-test="lifecycle-products"><li v-for="(p, index) in lifecycleAffectedProducts" :key="`${p.product_id}:${p.upstream_model}`">商品 {{ index + 1 }} · {{ productOptionLabel(p, index) }} · 模型 {{ p.upstream_model }} · {{ lifecycleLabel(p) }}</li></ul>
        <p v-if="!lifecycleAffectedProducts.length">仅改变此模型在媒体工作台中的显示状态；保留上游模型目录。</p>
        <p v-else-if="lifecycleRequest.action === 'restore'">仅恢复已归档商品为已下架，其他商品保持原状态；不会自动重新上架。</p>
        <p v-else-if="lifecycleRequest.action === 'relist'">后台重新检查所有未归档商品的原已发布版本；任一不满足条件则整笔不生效。已归档商品保持归档，仅有草稿的商品仍未发布；Account 销售开关独立生效。</p>
        <p v-else>下架或归档后停止对应商品的新报价和新提交；已归档商品不会因下架恢复。配置、历史订单与恢复关联会保留。</p>
        <p v-if="lifecycleModelAmbiguous" role="alert">此模型的草稿与已发布商品使用不同模型，请在具体商品中操作并核对两份配置。</p>
        <p class="mw-muted">此操作立即保存 Studio 生命周期状态，不发布其他草稿，也不修改独立 API Key 的原生权限、路由或受保护图片任务接口的访问限制。</p>
      </template>
      <template #actions><button class="btn btn-primary" data-test="confirm-lifecycle" :disabled="lifecycleDisabled || lifecycleModelAmbiguous" @click="confirmLifecycle">确认{{ lifecycleActionLabel(lifecycleRequest?.action) }}</button></template>
    </MediaDialog>
    <MediaDialog :show="!!newProductType" title="另建独立销售商品？" :busy="busy" @close="newProductType = ''">
      <p>当前模型已有 {{ modelProducts.length }} 份商品。已有商品的规格和售价会保留；新商品有独立名称、规格、售价和启用状态。</p>
      <p>文生图与参考图编辑、不同分辨率和比例通常可以放在同一份图片商品中，无需分别新增。</p>
      <label class="mw-field">新商品类型<select v-model="newProductType" class="input" data-test="new-product-type"><option v-for="type in config?.media_types ?? ['image', 'video']" :key="type" :value="type">{{ type === 'video' ? '视频' : '图片' }}</option></select></label>
      <p class="mw-muted">确认后仅在本页新增，仍需保存草稿；不会发布或启售。</p>
      <template #actions><button type="button" class="btn btn-primary" data-test="confirm-add-product" :disabled="managementDisabled" @click="confirmAddProduct">确认另建一份</button></template>
    </MediaDialog>
    <MediaDialog :show="!!removeProductId" title="移除这份空白草稿？" :busy="busy" @close="removeProductId = ''">
      <p>{{ removalTarget ? productOptionLabel(removalTarget, modelProducts.indexOf(removalTarget)) : '' }}</p>
      <p>仅将选中的未发布空白商品移出草稿列表，保存后生效。其他商品的规格和价格保持不变；原草稿副本、已发布数据及历史关联会保留。</p>
      <template #actions><button type="button" class="btn mw-danger" data-test="confirm-remove-product" :disabled="managementDisabled" @click="confirmRemoveProduct">确认移除这份草稿</button></template>
    </MediaDialog>
    <MediaDialog :show="!!nextNavigation" title="有未保存修改" :busy="!!pending" @close="nextNavigation = null">
      <p>保存草稿后切换，或放弃当前未保存修改。</p>
      <template #actions><button class="btn btn-primary" data-test="save-navigate" :disabled="!!pending || conflict || deleted" @click="saveAndNavigate">保存草稿后切换</button><button class="btn btn-secondary" data-test="discard-navigate" :disabled="!!pending" @click="discardAndNavigate">放弃修改</button></template>
    </MediaDialog>
    <MediaDialog :show="publishDialog" title="发布选中的商品？" :busy="pending === 'publish'" @close="publishDialog = false">
      <p data-test="publish-scope">Account #{{ detail?.id }} · {{ detail?.name }}。仅发布本次勾选的 {{ publishProductIds.length }} 份商品，后台只校验这些商品；未勾选商品的已发布配置和草稿保持原状。</p>
      <div class="mw-dialog-list" data-test="publish-products"><label v-for="p in config?.draft.products ?? []" :key="p.product_id" class="mw-product-toggle"><input v-model="publishProductIds" type="checkbox" :value="p.product_id" :data-test="`publish-product-${p.product_id}`" :disabled="busy" /><span>{{ productDisplayTitle(p) }} · {{ p.upstream_model }} · {{ p.media_type === 'video' ? '视频固定 1 条' : `图片 ${p.capabilities.count.min}～${p.capabilities.count.max} 张` }}</span></label></div>
      <p>发布配置不会自动开启销售或全局付费开关，已有订单不会改变，也不会发送真实生成请求。独立 API Key 的原生权限和路由保持原状。</p>
      <p v-if="message" role="alert">{{ message }}</p>
      <section v-if="publishValidation" data-test="publish-validation"><h3>本次选中商品的发布检查</h3><MediaValidationPanel :validation="publishValidation" :current="true" :unavailable="false" save-state="" :diagnostics="publishValidation.diagnostics" :products="diagnosticProducts" :account-id="detail?.id" :model-id="selectedModel" @locate="publishDialog = false; locate($event)" @message="message = $event" /></section>
      <template #actions><button class="btn btn-primary" data-test="confirm-publish" :disabled="!canPublish || !publishProductIds.length" @click="confirmPublish">确认发布选中商品</button></template>
    </MediaDialog>
    <MediaDialog :show="salesDialog" :title="config?.sales.enabled ? '暂停媒体销售？' : '开启媒体销售？'" :busy="pending === 'sales'" @close="salesDialog = false">
      <p>下列已发布产品将一起受到 Account 级销售开关影响：</p>
      <ul class="mw-dialog-list" data-test="sales-products"><li v-for="p in config?.published?.products ?? []" :key="p.product_id">{{ productDisplayTitle(p) }} · {{ p.media_type === 'video' ? '视频' : '图片' }}</li></ul>
      <p v-if="!config?.published?.products?.length">暂无已发布产品。</p>
      <p>Account #{{ detail?.id }} · {{ detail?.name }}。此操作只影响工作台销售；图片/视频全局付费生成服务分别控制。</p>
      <p v-if="message || salesFeedback" role="alert" data-test="sales-dialog-feedback">{{ message }} {{ salesFeedback }}</p>
      <button v-if="saveState === 'unconfirmed' || conflict" type="button" class="btn btn-secondary" data-test="sales-reload" :disabled="busy" @click="salesDialog = false; reloadDialog = true">重新读取实际状态</button>
      <p>{{ config?.sales.enabled ? '暂停后停止新的媒体报价和新提交；已经提交的任务和历史订单不会被修改。' : '后台会核验已发布产品的销售条件；未发布草稿不会随销售开关生效。' }}</p>
      <template #actions><button class="btn" :class="config?.sales.enabled ? 'mw-danger' : 'btn-primary'" data-test="confirm-sales" :disabled="managementDisabled" @click="confirmSales">确认{{ config?.sales.enabled ? '暂停' : '开启' }}</button></template>
    </MediaDialog>
    <MediaDialog :show="reloadDialog" title="重新读取服务器配置？" :busy="busy" @close="reloadDialog = false">
      <p>当前未保存修改将被放弃。读取服务器最新草稿后再编辑，不会自动重试旧写入。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-reload" :disabled="busy" @click="reload">确认放弃修改并重新加载</button></template>
    </MediaDialog>
    <MediaDialog :show="discardRecoveryDialog" title="丢弃此商品的恢复副本？" :busy="busy" @close="discardRecoveryDialog = false">
      <p>只删除当前选中的这一份本地副本；其他副本、当前表单和服务器草稿保持不变。</p>
      <template #actions><button class="btn btn-secondary" data-test="confirm-discard-recovery" :disabled="busy" @click="discardRecovery(); discardRecoveryDialog = false">确认丢弃恢复副本</button></template>
    </MediaDialog>
    <MediaIndependentCalculator :admin-id="auth.user?.id" />
  </AppLayout>
</template>

<script setup lang="ts">
import { mediaPaidAPI, type PaidState, type PaidMedia } from '@/api/admin/mediaPaid'
import MediaPaidControls from '@/components/admin/media/MediaPaidControls.vue'
import { useAuthStore } from '@/stores/auth'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import MediaIndependentCalculator from '@/components/admin/media/MediaIndependentCalculator.vue'
import MediaDialog from '@/components/admin/media/MediaDialog.vue'
import MediaProductEditor from '@/components/admin/media/MediaProductEditor.vue'
import MediaValidationPanel from '@/components/admin/media/MediaValidationPanel.vue'
import { useMediaWorkbench } from '@/composables/useMediaWorkbench'
import type { Product, ProductState, Diagnostic, SupplierDetail, LifecycleAction, LifecycleTarget } from '@/api/admin/mediaWorkbench'
import { formatDateTimeLocalInput } from '@/utils/format'
import { mediaPublicationLabel } from '@/utils/mediaAdminPresentation'
import '@/styles/media-workbench.css'

const costOpen = ref(false)
const paidStates = ref<Partial<Record<PaidMedia, PaidState>>>({})
const paidStatusLabel = (kind: PaidMedia) => paidStates.value[kind]?.mode === 'managed-v1' ? paidStates.value[kind]?.effective_enabled ? '已开放' : '尚未开放' : '状态未确认'
async function readPaidStatus() {
  const results = await Promise.allSettled((['image', 'video'] as const).map(kind => mediaPaidAPI.status(kind)))
  for (const [index, result] of results.entries()) { const kind = index === 0 ? 'image' : 'video'; if (result.status === 'fulfilled') paidStates.value[kind] = result.value; else delete paidStates.value[kind] }
}
const auth = useAuthStore()
const workbench = useMediaWorkbench(() => auth.user?.id)
const { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, loading, loadingAccountId, message,
  diagnostics, publishValidation, saveFeedback, publicationFeedback, salesFeedback, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
  addedProductIds, removedProducts, removalReason, removeProduct, undoRemoval, videoSaleInputs, updateVideoSaleInputs,
  recovery, recoveryWarning, recoveryConflict, recoveryDiff, productRecoveries, unsubmittedRecoveries, selectedRecoveryKey, chooseRecovery, online, checkServer, canRetryUnconfirmedSave, retryUnconfirmedSave, reloadFromServer, restoreRecovery, discardRecovery, flushAutoSave,
  loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, lifecycle, sync, discard } = workbench
const step = ref('suppliers')
const search = ref('')
const filter = ref('')
const showArchived = ref(false)
const lifecycleRequest = ref<{ action: LifecycleAction; target: LifecycleTarget } | null>(null)
const editorElement = ref<HTMLElement>()
const modelPage = ref<HTMLElement>()
const productEditor = ref<InstanceType<typeof MediaProductEditor>>()
const sourceListRef = ref<HTMLElement>()
const modelsScrollPosition = ref({ top: 0, left: 0 })
const publishDialog = ref(false)
const publishProductIds = ref<string[]>([])
const salesDialog = ref(false)
const reloadDialog = ref(false)
const discardRecoveryDialog = ref(false)
const acceptRecoveryConflict = ref(false)
watch(recovery, () => { acceptRecoveryConflict.value = false })
const saveStateLabel = computed(() => ({ unsaved: '未保存，等待自动同步', saving: '保存中，后续输入继续保留', saved: '已确认保存', failed: '保存失败，请修正后重试', unconfirmed: '保存结果待核对，自动写入已暂停', conflict: '存在服务器版本冲突，当前输入保留' })[saveState.value])
const draftLastSavedLabel = computed(() => {
  const savedAt = Date.parse(config.value?.draft.updated_at ?? '')
  return Number.isFinite(savedAt) && savedAt > 0 ? formatDateTimeLocalInput(savedAt / 1000).replace('T', ' ') : '尚未保存'
})
const lastPublishedLabel = computed(() => {
  if (!config.value?.published) return '尚未发布'
  const publishedAt = Date.parse(config.value.published.published_at ?? '')
  return Number.isFinite(publishedAt) && publishedAt > 0 ? formatDateTimeLocalInput(publishedAt / 1000).replace('T', ' ') : '已有发布配置，发布时间未记录'
})
const publicationLabel = computed(() => dirty.value ? '有未保存修改，当前输入尚未发布' : saveState.value !== 'saved' && config.value ? '当前保存结果尚未确认，不能据此判断已发布' : mediaPublicationLabel(config.value?.draft.products ?? [], config.value?.published?.products))
const newProductType = ref('')
const removeProductId = ref('')
const removalTarget = computed(() => products.value.find(p => p.product_id === removeProductId.value))
const accountSearch = ref('')
const accountFilter = ref('')
const platformFilter = ref('')
const collapsedSources = ref(new Set<string>())
const knownSourceHosts = ref(new Set<string>())
const nextNavigation = ref<(() => void | Promise<void>) | null>(null)
const busy = computed(() => !!pending.value || loading.value)
const managementDisabled = computed(() => busy.value || deleted.value || conflict.value || saveState.value === 'unconfirmed')
const publishedCount = computed(() => suppliers.value.reduce((n, s) => n + s.models.filter(m => m.state === 'PUBLISHED').length, 0))
const accountStates: Record<string, string> = {
  SELLING: '媒体销售中', SALES_PAUSED: '媒体销售已暂停', PUBLISHED_NOT_READY: '已发布配置当前不可售',
  NOT_YET_ENABLED: '未开启销售', SALES_OFF_UNKNOWN: '销售已关闭（历史启售状态未知）',
  NOT_INITIALIZED: '未开启销售', ACCOUNT_INACTIVE: '账户已停用', ACCOUNT_UNSCHEDULABLE: '不可调度',
  ACCOUNT_RUNTIME_BLOCKED: '运行受限', UNSUPPORTED_ACCOUNT_TYPE: '类型不支持', ACTIVE: '媒体销售中',
  SALES_ENABLED: '媒体销售中', PUBLISHED_VALIDATOR_NOT_WIRED: '后台检查尚未接入'
}
const sourceGroups = computed(() => {
  const groups = new Map<string, SupplierDetail[]>()
  for (const supplier of suppliers.value) { const host = sourceHost(supplier); const accounts = groups.get(host) ?? []; accounts.push(supplier); groups.set(host, accounts) }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, accounts]) => ({ host, accounts: accounts.sort((a, b) => a.id - b.id) }))
})
const filteredGroups = computed(() => sourceGroups.value.map(group => ({ ...group, accounts: group.accounts.filter(supplier => matchesAccount(supplier, accountSearch.value) && (!accountFilter.value || accountState(supplier) === accountFilter.value) && (!platformFilter.value || supplier.platform === platformFilter.value)) })).filter(group => group.accounts.length))
const visibleAccountCount = computed(() => filteredGroups.value.reduce((count, group) => count + group.accounts.length, 0))
const platforms = computed(() => [...new Set(suppliers.value.map(supplier => supplier.platform).filter(Boolean))].sort())
const modelStates = computed(() => [...new Set(detail.value?.models.map(m => m.state) ?? [])])
const filteredModels = computed(() => detail.value?.models.filter(m => (showArchived.value || (m.state !== 'ARCHIVED' && !config.value?.hidden_models?.includes(m.model_id))) && (!filter.value || m.state === filter.value) && `${m.model_id} ${rowProduct(m.model_id)?.display_name ?? ''}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const selectedRow = computed(() => detail.value?.models.find(m => m.model_id === selectedModel.value))
const modelProducts = computed(() => products.value.filter(p => p.upstream_model === selectedModel.value && (showArchived.value || lifecycleState(p) !== 'archived')))
const lifecycleProducts = computed(() => {
  const byId = new Map((config.value?.published?.products ?? []).map(p => [`${p.product_id}:${p.upstream_model}`, p]))
  for (const p of config.value?.draft.products ?? []) byId.set(`${p.product_id}:${p.upstream_model}`, p)
  return [...byId.values()]
})
const lifecycleModelProducts = computed(() => lifecycleProducts.value.filter(p => p.upstream_model === selectedModel.value))
const publishedOnlyProducts = computed(() => lifecycleModelProducts.value.filter(p => !products.value.some(draft => draft.product_id === p.product_id) && (showArchived.value || lifecycleState(p) !== 'archived')))
const lifecycleAffectedProducts = computed(() => lifecycleProducts.value.filter(p => lifecycleRequest.value?.target.product_id ? p.product_id === lifecycleRequest.value.target.product_id : p.upstream_model === lifecycleRequest.value?.target.model_id))
const lifecycleModelAmbiguous = computed(() => !!lifecycleRequest.value?.target.model_id && lifecycleAffectedProducts.value.some(p => {
  const draft = config.value?.draft.products.find(d => d.product_id === p.product_id)
  const published = config.value?.published?.products?.find(d => d.product_id === p.product_id)
  return draft && published && draft.upstream_model !== published.upstream_model
}))
const lifecycleDisabled = computed(() => managementDisabled.value || dirty.value)
const isModelHidden = computed(() => config.value?.hidden_models?.includes(selectedModel.value) ?? false)
const modelArchiveBlocked = computed(() => lifecycleModelProducts.value.some(archiveBlocked))
function lifecycleState(p: Product) { return config.value?.product_lifecycle?.[p.product_id]?.state ?? 'active' }
function lifecycleLabel(p: Product) { return ({ active: '未下架', unlisted: '已下架', archived: '已归档' })[lifecycleState(p)] }
function archiveBlocked(p: Product) { return lifecycleState(p) === 'active' && !!config.value?.published?.products?.some(item => item.product_id === p.product_id) }
function lifecycleActionLabel(action?: LifecycleAction) { return action ? ({ unlist: '下架', relist: '重新上架', archive: '归档', restore: '恢复', hide: '隐藏模型' })[action] : '' }
function requestLifecycle(action: LifecycleAction, target: LifecycleTarget) { if (!lifecycleDisabled.value) lifecycleRequest.value = { action, target } }
async function confirmLifecycle() {
  if (!lifecycleRequest.value || lifecycleDisabled.value || lifecycleModelAmbiguous.value) return
  const request = lifecycleRequest.value
  if (await lifecycle(request.action, request.target)) {
    lifecycleRequest.value = null
    if (request.action === 'archive' || request.action === 'hide') showArchived.value = true
  }
}
watch([showArchived, selectedModel], () => {
  if (!dirty.value && !modelProducts.value.some(p => p.product_id === selectedProduct.value)) selectedProduct.value = modelProducts.value[0]?.product_id ?? ''
})
const productStateById = computed(() => new Map((detail.value?.product_states ?? []).map(item => [item.product_id, item])))
const draftValidationLabel = computed(() => !config.value ? '尚未检查' : !validationCurrent.value || validationUnavailable.value ? '结果待确认' : ({ PASS: '通过（仅草稿）', FAIL: '草稿有待修复项，可选择商品单独校验发布', UNKNOWN: '检查暂不可用', PENDING: '检查中', VALIDATING: '检查中', RUNNING: '检查中' } as Record<string, string>)[config.value.validation.status] ?? '结果待确认')
function availabilityName(item: ProductState) {
  const p = config.value?.published?.products?.find(p => p.product_id === item.product_id) ?? products.value.find(p => p.product_id === item.product_id)
  if (p) return productDisplayTitle({ ...p, display_name: item.display_name || p.display_name })
  const name = item.display_name?.trim()
  return name && !/^media[-_]/.test(name) ? name : item.upstream_model || '商品名称待读取'
}
function availabilityLabel(item: ProductState) {
  if (item.state === 'READY' && (!item.published || !item.published_ready)) return '已发布配置条件待确认'
  return ({ READY: '已发布配置与 Account 销售已就绪', NOT_PUBLISHED: '尚未发布', UNLISTED: '已下架', ARCHIVED: '已归档', ACCOUNT_SALES_OFF: 'Account 销售已关闭', ACCOUNT_UNAVAILABLE: 'Account 当前不可用', UPSTREAM_REMOVED: '上游目录已移除此模型', DEPENDENCIES_CHANGED: '发布依赖已变化', PUBLISHED_INVALID: '已发布配置当前不可售' } as Record<string, string>)[item.state] ?? '状态待确认'
}
async function editAvailability(item: ProductState) {
  const draft = products.value.find(p => p.product_id === item.product_id)
  if (!draft) return
  if (lifecycleState(draft) === 'archived') showArchived.value = true
  await openEditor(draft.upstream_model); selectedProduct.value = draft.product_id
}
const diagnosticProducts = computed(() => (config.value?.draft.products ?? []).map((p, index) => ({
  product_id: p.product_id,
  label: `${productDisplayTitle(p)} · ${p.media_type === 'video' ? '视频' : '图片'} · 商品 ${index + 1}`
})))
const productOptionSignatures = computed(() => {
  const counts = new Map<string, number>()
  for (const item of modelProducts.value) {
    const signature = productOptionSignature(item)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
})
const canResume = computed(() => {
  if (detail.value?.sales_resume_ready !== undefined) return detail.value.sales_resume_ready
  const blocked = ['ACCOUNT_INACTIVE', 'ACCOUNT_UNSCHEDULABLE', 'ACCOUNT_RUNTIME_BLOCKED', 'UNSUPPORTED_ACCOUNT_TYPE'].includes(detail.value?.effective_state ?? '')
  return !blocked && detail.value?.status === 'active' && detail.value.schedulable && (config.value?.published?.offers?.length ?? 0) > 0
})
const resumeReason = computed(() => !detail.value?.schedulable ? '账户不可调度，请打开账户详情处理。' : detail.value?.status !== 'active' ? '账户已停用，请打开账户详情处理。' : '后台尚未提供可恢复销售的已发布产品。')
const salesLabel = computed(() => {
  if (!config.value) return '未开启销售'
  if (config.value.sales.enabled) return '销售中'
  const state = detail.value?.effective_state
  if (state === 'NOT_YET_ENABLED' || state === 'NOT_INITIALIZED') return '未开启销售'
  if (state === 'SALES_PAUSED') return '已暂停销售'
  return '销售已关闭（历史启售状态未知）'
})
const mediaTypeLabel = computed(() => {
  const types = config.value?.media_types ?? [...new Set(products.value.map(product => product.media_type))]
  if (types.includes('image') && types.includes('video')) return '图片 + 视频'
  if (types.includes('video')) return '视频'
  if (types.includes('image')) return '图片'
  return '尚未初始化'
})
const accountLink = (id: number) => ({ path: '/admin/accounts', query: { account_id: String(id) } })
function sourceHost(supplier: Pick<SupplierDetail, 'host'>) { return supplier.host?.trim().toLowerCase() ?? '' }
function accountState(supplier: SupplierDetail) { return supplier.effective_state || 'NOT_INITIALIZED' }
function normalizedSearch(value: string) { return value.trim().toLowerCase() }
function exactAccountId(value: string) { const match = normalizedSearch(value).match(/^(?:account\s*)?#?(\d+)$/); return match ? Number(match[1]) : undefined }
function matchesAccount(supplier: SupplierDetail, query: string) { const normalized = normalizedSearch(query); if (!normalized) return true; const exactId = exactAccountId(normalized); if (exactId !== undefined) return supplier.id === exactId; return [supplier.name, supplier.platform, sourceHost(supplier)].join(' ').toLowerCase().includes(normalized) }
function clearAccountFilters() { accountSearch.value = ''; accountFilter.value = ''; platformFilter.value = '' }
function toggleSource(host: string) { if (accountSearch.value || accountFilter.value || platformFilter.value) return; const next = new Set(collapsedSources.value); if (next.has(host)) next.delete(host); else next.add(host); collapsedSources.value = next }
function sourceOpen(host: string) { return !!accountSearch.value || !!accountFilter.value || !!platformFilter.value || !collapsedSources.value.has(host) }
function modelLabel(state: string) { return ({ ARCHIVED: '已归档', UNLISTED: '已下架', PENDING: '待配置', PUBLISHED: '已发布', DRAFT: '草稿修改', UI_FIXABLE: '需要修改', NEEDS_DEVELOPMENT: '需要适配', UNKNOWN: '检查暂不可用', UPSTREAM_NOT_DISCOVERED: '上游目录未发现', UPSTREAM_MISSING: '上游目录未发现', MODEL_SYNC_REQUIRED: '需要同步模型', DISABLED: '本站停用', INACTIVE: '本站停用' } as Record<string, string>)[state] ?? state }
function effectiveLabel(state: string) { return ({ SALES_PAUSED: '媒体销售已暂停', NOT_YET_ENABLED: '未开启销售', SALES_OFF_UNKNOWN: '销售已关闭（历史启售状态未知）', ACCOUNT_INACTIVE: 'Sub2 账户已停用', ACCOUNT_UNSCHEDULABLE: 'Sub2 账户不可调度', ACCOUNT_RUNTIME_BLOCKED: '账户暂时无法提供服务，请打开账户详情处理', PUBLISHED_NOT_READY: '已发布配置当前不可售', NOT_INITIALIZED: '未开启销售', PUBLISHED_VALIDATOR_NOT_WIRED: '后台检查尚未接入', UNSUPPORTED_ACCOUNT_TYPE: '此账户类型不支持媒体供应商', ACTIVE: '媒体销售中', SALES_ENABLED: '媒体销售中', SELLING: '媒体销售中' } as Record<string, string>)[state] ?? state }
function rowProduct(id: string) { return config.value?.draft.products.find(p => p.upstream_model === id) }
function priceLabel(p?: Product) { if (!p?.pricing_rules?.length) return '未配置售价'; return p.pricing_rules.map(rule => rule.sale_price == null ? '未配置售价' : `${rule.sale_price.currency} ${rule.sale_price.amount}`).join(' / ') }
function productDisplayTitle(p: Product) {
  const fallback = `${p.media_type === 'video' ? '视频' : '图片'}商品`
  const raw = p.display_name?.trim() ?? ''
  if (!raw) return p.upstream_model?.trim() || fallback
  const withoutInternalSuffix = raw.replace(/\s*[·|•]\s*media-[a-z0-9-]{4,}$/i, '').trim()
  if (!withoutInternalSuffix || /^media-[a-z0-9-]{4,}$/i.test(withoutInternalSuffix)) return p.upstream_model?.trim() || fallback
  return withoutInternalSuffix
}
function productOptionSignature(p: Product) {
  return JSON.stringify({
    display_name: productDisplayTitle(p),
    media_type: p.media_type,
    resolutions: p.capabilities.resolutions,
    aspect_ratios: p.capabilities.aspect_ratios,
    durations_seconds: p.capabilities.durations_seconds,
    count: p.capabilities.count,
    references: p.capabilities.references,
    pricing_rules: p.pricing_rules.map(rule => ({ match: rule.match, sale_price: rule.sale_price })),
    enabled: p.enabled
  })
}
function productOptionLabel(p: Product, index: number) {
  const title = productDisplayTitle(p)
  const specs = p.media_type === 'video'
    ? [p.capabilities.resolutions?.join('/'), p.capabilities.aspect_ratios?.join('/'), p.capabilities.durations_seconds?.map(value => `${value}s`).join('/')]
    : [p.capabilities.resolutions?.join('/'), p.capabilities.aspect_ratios?.join('/')]
  const specText = specs.filter(Boolean).join(' · ') || '未配置'
  const quantityText = p.media_type === 'video' ? '固定 1 条' : `${p.capabilities.count.min}～${p.capabilities.count.max} 张`
  const status = p.enabled ? '已启用' : '已停用'
  const parts = [title, `规格 ${specText}`, `数量 ${quantityText}`, priceLabel(p), status]
  if ((productOptionSignatures.value.get(productOptionSignature(p)) ?? 0) > 1) parts.push(`商品 ${index + 1}`)
  return parts.join(' · ')
}
function confirmAddProduct() {
  const type = newProductType.value
  if (!type || managementDisabled.value) return
  newProductType.value = '' // Consume this confirmation before handling repeated events.
  commitBeforeProductSwitch(() => addProduct(type, true))
}
function chooseProductRecovery(key: string) {
  const entry = [...productRecoveries.value, ...unsubmittedRecoveries.value].find(item => item.key === key)
  if (!entry) return
  if (entry.value.product.product_id === selectedProduct.value) chooseRecovery(key)
  else commitBeforeProductSwitch(() => chooseRecovery(key))
}
function undoProductRemoval(id: string) { commitBeforeProductSwitch(() => undoRemoval(id)) }
function confirmRemoveProduct() {
  const id = removeProductId.value
  if (!id || managementDisabled.value) return
  removeProductId.value = ''
  removeProduct(id)
}
function changeProduct(event: Event) {
  const target = event.target as HTMLSelectElement
  const id = target.value
  target.value = selectedProduct.value
  if (conflict.value) selectedProduct.value = id
  else navigate(() => { selectedProduct.value = id })
}
function updateProduct(value: Product) { const index = products.value.findIndex(p => p.product_id === value.product_id); if (index >= 0) products.value[index] = value }
async function commitEditor() { return await productEditor.value?.commitPending() ?? true }
let committingProductSwitch = false
function commitBeforeProductSwitch(action: () => void) {
  if (committingProductSwitch) return
  if (!videoSaleInputs.value.length) { action(); return }
  committingProductSwitch = true
  void commitEditor().then(committed => { if (committed) action() }).finally(() => { committingProductSwitch = false })
}
async function saveEditorDraft() { return await commitEditor() ? saveDraft() : false }
async function flushOnFocusOut(event: FocusEvent) {
  if ((!event.relatedTarget || !editorElement.value?.contains(event.relatedTarget as Node)) && await commitEditor()) await flushAutoSave()
}
async function flushStep(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest('button')
  if (/^wizard-(?:step-|next$|back$)/.test(button?.dataset.test ?? '') && await commitEditor()) await flushAutoSave()
}
function navigate(action: () => void | Promise<void>) {
  if (busy.value) return
  const proceed = () => { if (dirty.value) nextNavigation.value = action; else void action() }
  if (videoSaleInputs.value.length) void commitEditor().then(committed => { if (committed) proceed() })
  else proceed()
}
async function openSupplier(id: number) { const selected = await selectSupplier(id); if (selected && !loading.value && detail.value?.id === id) { step.value = 'models'; void readPaidStatus(); await nextTick(); modelPage.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' }) } }
async function openEditor(modelId: string) {
  // AppLayout and .mw-page scroll with the document, not inside the model panel.
  modelsScrollPosition.value = { top: window.scrollY, left: window.scrollX }
  selectModel(modelId); selectedProduct.value = modelProducts.value[0]?.product_id ?? ''; step.value = 'editor'
  await nextTick()
  editorElement.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
}
async function backToModels() {
  step.value = 'models'
  await nextTick()
  window.scrollTo({ ...modelsScrollPosition.value, behavior: 'instant' })
}
async function saveAndNavigate() {
  if (!await saveEditorDraft()) return
  if (dirty.value) return
  const action = nextNavigation.value
  const resolveRoute = routeResolve
  routeResolve = undefined
  nextNavigation.value = null
  resolveRoute?.(true)
  await action?.()
}
async function discardAndNavigate() {
  discard()
  const action = nextNavigation.value
  const resolveRoute = routeResolve
  routeResolve = undefined
  nextNavigation.value = null
  resolveRoute?.(true)
  await action?.()
}
async function openPublish() { if (!await commitEditor()) return; publishProductIds.value = config.value?.draft.products.some(p => p.product_id === selectedProduct.value) ? [selectedProduct.value] : []; publishDialog.value = true }
async function confirmPublish() { if (await commitEditor() && await publish(publishProductIds.value)) publishDialog.value = false }
async function confirmSales() { if (config.value && await sales(!config.value.sales.enabled)) salesDialog.value = false }
async function restoreWithUndoProtection() { productEditor.value?.invalidateSaleUndo(); await restoreRecovery(acceptRecoveryConflict.value) }
watch(conflict, value => { if (value) productEditor.value?.invalidateSaleUndo() })
async function reload() {
  productEditor.value?.invalidateSaleUndo()
  const accountId = detail.value?.id
  if (!accountId) return
  const previousStep = step.value
  const modelId = selectedModel.value
  const productId = selectedProduct.value
  if (!await reloadFromServer()) return
  reloadDialog.value = false
  if (detail.value?.id !== accountId || message.value) return
  const modelExists = detail.value.models.some(model => model.model_id === modelId) ||
    products.value.some(item => item.upstream_model === modelId)
  if (modelId && modelExists) {
    selectModel(modelId)
    if (products.value.some(item => item.product_id === productId && item.upstream_model === modelId)) selectedProduct.value = productId
  }
  void readPaidStatus()
  step.value = previousStep === 'editor' && !selectedModel.value ? 'models' : previousStep
}
async function returnToSuppliers() { step.value = 'suppliers'; await loadSuppliers() }
async function locate(diagnostic: Diagnostic) {
  const { path, scope } = diagnostic
  const productIndex = /products(?:\[|\.)(\d+)/.exec(path)?.[1]
  const productTarget = products.value.find(p => p.product_id === scope) ?? (productIndex !== undefined ? products.value[Number(productIndex)] : undefined)
  if (productTarget && productTarget.product_id !== selectedProduct.value && dirty.value) {
    navigate(() => locate(diagnostic))
    return
  }
  if (productTarget) {
    selectedModel.value = productTarget.upstream_model
    selectedProduct.value = productTarget.product_id
    step.value = 'editor'
    await nextTick()
  }
  const fieldPath = productEditor.value?.showField(path, diagnostic.code) ?? path
  await nextTick()
  const costIndex = /cost_rules(?:\[|\.)(\d+)/.exec(fieldPath)?.[1]
  const exactCost = costIndex === undefined ? undefined : editorElement.value?.querySelector<HTMLElement>(`[data-field="cost_rules.${costIndex}.cost"]`)
  const field = ['cost_rules', 'cost_coverage', 'adapter_config.execution.max_output_images', 'adapter_config.edit_execution.max_output_images', 'adapter_config.execution', 'adapter_config.edit_execution', 'adapter_config.model_family', 'adapter_config.wire_profile', 'adapter_config.size_mappings', 'capabilities.qualities', 'capabilities.combination_rules', 'pricing_rules', 'capabilities.references', 'capabilities', 'display_name', 'site_model', 'product_id', 'media_type'].find(key => fieldPath.includes(key)) ?? 'model'
  const section = exactCost ?? editorElement.value?.querySelector<HTMLElement>(`[data-field="${field === 'cost_coverage' ? 'cost_rules' : field}"]`)
  section?.querySelectorAll('details').forEach(node => { node.open = true })
  let ancestor = section
  while (ancestor && ancestor !== editorElement.value) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement ?? undefined
  }
  const target = section?.matches('input,select') ? section : section?.querySelector<HTMLElement>('input,select,button')
  target?.focus()
  section?.classList.add('mw-field-located')
  setTimeout(() => section?.classList.remove('mw-field-located'), 2500)
  section?.scrollIntoView?.({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || pending.value) { event.preventDefault(); event.returnValue = '' } }
watch(sourceGroups, groups => {
  if (!groups.length) return
  const next = new Set(collapsedSources.value)
  for (const group of groups) if (!knownSourceHosts.value.has(group.host)) next.add(group.host)
  collapsedSources.value = next
  knownSourceHosts.value = new Set(groups.map(group => group.host))
})
onBeforeRouteLeave(async () => { if (busy.value) { message.value = '操作正在进行，请等待完成后离开。'; return false } if (!await commitEditor()) return false; if (!dirty.value) return true; return new Promise<boolean>(resolve => { nextNavigation.value = () => resolve(true); routeResolve = resolve }) })
let routeResolve: ((value: boolean) => void) | undefined
watch(nextNavigation, value => { if (!value && routeResolve) { routeResolve(false); routeResolve = undefined } })
onMounted(() => { void loadSuppliers(); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { routeResolve?.(false); window.removeEventListener('beforeunload', beforeUnload) })
</script>

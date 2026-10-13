<template>
  <AppLayout>
    <div class="media-workbench" :class="`mw-step-${step}`" :aria-busy="!!pending || loading">
      <header class="mw-heading">
        <div>
          <p class="mw-eyebrow">MEDIA WORKBENCH</p>
          <h1>媒体工作台</h1>
          <p v-if="step !== 'editor'" class="mw-muted">按“来源与账号 → 模型 → 完整配置”完成媒体产品设置。</p>
        </div>
        <nav class="mw-steps" aria-label="工作台导航">
          <span :class="{ 'mw-step-current': step === 'suppliers' }">来源与账号</span>
          <span :class="{ 'mw-step-current': step === 'models' }">选择模型</span>
          <span :class="{ 'mw-step-current': step === 'editor' }">配置商品</span>
        </nav>
      </header>

      <div v-if="step === 'suppliers'" class="mw-statistics">
        <div><span>来源分组</span><strong data-test="source-count">{{ sourceGroups.length }}</strong></div>
        <div><span>Account 账号</span><strong data-test="account-count">{{ suppliers.length }}</strong></div>
        <div><span>待配置模型</span><strong>{{ suppliers.reduce((n, s) => n + s.pending_count, 0) }}</strong></div>
        <div><span>已发布模型</span><strong>{{ publishedCount }}</strong></div>
      </div>

      <div v-if="message" class="mw-banner" role="status" data-test="banner">
        <span>{{ message }}</span>
        <button v-if="detail && !deleted" class="btn btn-secondary" data-test="reload" :disabled="busy" @click="reloadDialog = true">重新读取</button>
        <button v-else-if="deleted" class="btn btn-secondary" :disabled="busy" @click="navigate(returnToSuppliers)">返回账号列表</button>
        <button v-else-if="!detail" class="btn btn-secondary" :disabled="busy" @click="loadSuppliers">重试读取</button>
      </div>
      <p v-if="loading" role="status">正在读取账号配置…</p>

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

        <section v-else-if="step === 'models'" class="mw-page mw-panel" aria-label="模型列表" data-test="model-page">
          <button type="button" class="mw-back btn btn-secondary" :disabled="busy" @click="navigate(() => { step = 'suppliers' })">← 返回来源与账号</button>
          <div v-if="detail" class="mw-page-heading mw-account-context">
            <div><p class="mw-eyebrow">模型管理 · Account #{{ detail.id }}</p><h2>{{ detail.name }}</h2><p class="mw-muted mw-account-host">{{ sourceHost(detail) || '未识别来源' }} · {{ detail.platform || '未知平台' }}</p><p class="mw-muted">媒体类型：{{ mediaTypeLabel }}</p><p class="mw-muted">{{ effectiveLabel(detail.effective_state) }}</p></div>
            <div class="mw-selection-feedback" data-test="selected-account-summary"><strong>已选择账号</strong><span>#{{ detail.id }} · {{ detail.name }}</span></div>
          </div>
          <div v-if="detail" class="mw-model-toolbar">
            <button class="btn btn-secondary" data-test="sync" :disabled="busy || deleted || conflict" @click="sync">{{ pending === 'sync' ? '同步中…' : '同步模型目录' }}</button>
            <router-link :to="accountLink(detail.id)" class="mw-link">打开账户详情 ↗</router-link>
          </div>
          <label class="mw-field">搜索模型<input v-model="search" class="input" placeholder="模型名称或精确 ID" type="search" data-test="model-search" /></label>
          <label class="mw-field">模型状态<select v-model="filter" class="input" data-test="model-filter"><option value="">全部状态</option><option v-for="state in modelStates" :key="state" :value="state">{{ modelLabel(state) }}</option></select></label>
          <p v-if="!filteredModels.length" class="mw-muted">没有匹配模型。可同步上游模型目录。</p>
          <div class="mw-model-list">
            <button v-for="row in filteredModels" :key="row.model_id" class="mw-model-row" :class="{ 'mw-selected': selectedModel === row.model_id }" :aria-pressed="selectedModel === row.model_id" :disabled="busy" :data-test="`model-${row.model_id}`" @click="navigate(() => openEditor(row.model_id))">
              <span class="mw-model-row-main"><strong>{{ row.model_id }}</strong><span class="mw-badge" :data-state="row.state">● {{ modelLabel(row.state) }}</span></span>
              <span v-if="rowProduct(row.model_id)">{{ productDisplayTitle(rowProduct(row.model_id)!) }} · {{ rowProduct(row.model_id)?.media_type === 'video' ? '视频' : '图片' }}</span>
              <small v-if="rowProduct(row.model_id)">{{ (rowProduct(row.model_id)?.capabilities.resolutions ?? []).join(' / ') }} · {{ priceLabel(rowProduct(row.model_id)) }}</small>
              <span class="mw-model-action">{{ rowProduct(row.model_id) ? '编辑配置 →' : '配置 →' }}</span>
            </button>
          </div>
            <section class="mw-sales-card" data-test="sales-state">
              <div><p class="mw-eyebrow">销售状态</p><strong>{{ salesLabel }}</strong><p class="mw-muted">发布配置与开启销售是两个独立动作；发布不会自动启用销售。</p></div>
              <button v-if="config" class="btn" :class="config.sales.enabled ? 'mw-danger' : 'btn-secondary'" data-test="sales" :disabled="busy || deleted || conflict || (!config.sales.enabled && !canResume)" @click="salesDialog = true">{{ config.sales.enabled ? '暂停销售' : '开启销售' }}</button>
              <span v-else class="mw-badge">首次保存后可开启</span>
            </section>
            <p v-if="config && !config.sales.enabled && !canResume" class="mw-muted">{{ resumeReason }}</p>

            <MediaValidationPanel v-if="config" :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :products="diagnosticProducts" :account-id="detail?.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
          <div class="mw-action-card" data-test="account-publication">
            <strong>Account 级发布与销售</strong><p class="mw-muted">发布会包含此 Account 的所有草稿商品；销售开关影响全部已发布商品。两者都需要单独确认。</p>
            <button class="btn btn-secondary" data-test="publish" :disabled="!canPublish" @click="publishDialog = true">{{ pending === 'publish' ? '发布中…' : '发布配置' }}</button>
          </div>
        </section>

        <section v-else ref="editorElement" class="mw-page mw-panel mw-editor-page" aria-label="模型配置编辑器" data-test="editor-page">
          <button type="button" class="mw-back btn btn-secondary" :disabled="busy" @click="navigate(backToModels)">← 返回模型列表</button>
          <div v-if="detail" class="mw-page-heading mw-account-context mw-product-context">
            <div><p class="mw-eyebrow">配置商品 · {{ product?.media_type === 'video' ? '视频' : '图片' }}</p><h2>{{ product?.display_name || selectedModel || '选择商品类型' }}</h2><p class="mw-muted">Account #{{ detail.id }} · {{ detail.name }}</p></div>
            <div class="mw-selection-feedback" data-test="selected-model-summary"><strong>当前上游模型</strong><span data-test="upstream-model-name">{{ selectedModel }}</span></div>
          </div>
          <template v-if="detail && selectedModel">
            <p v-if="selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING'" class="mw-muted">{{ selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING' ? '上游最新成功目录中未发现此模型，配置会保留且新报价由后台阻止。' : '请填写已确认的供应商规格；示例值不会自动写入能力或报价。' }}</p>
            <div v-if="!product" class="mw-start-product mw-banner">
              <h3>先选择产品类型</h3><p>第一次保存时，后台会根据这里提交的产品类型自动初始化此 Account 的媒体配置。</p>
              <div class="mw-product-type-actions"><button class="btn btn-primary" data-test="add-product-image" :disabled="busy || deleted || conflict" @click="addProduct('image')">开始配置图片</button><button class="btn btn-secondary" data-test="add-product-video" :disabled="busy || deleted || conflict" @click="addProduct('video')">开始配置视频</button></div>
            </div>
            <section v-if="product" class="mw-product-management" aria-label="当前商品管理" data-test="product-management">
              <div class="mw-section-heading"><strong>正在编辑的商品</strong><span class="mw-badge" data-test="product-status">{{ product.enabled ? '草稿：已启用' : '草稿：已停用' }}</span></div>
              <label v-if="modelProducts.length > 1" class="mw-field">切换商品（此模型共 {{ modelProducts.length }} 份）<select :value="selectedProduct" class="input" data-test="product-select" @change="changeProduct" :disabled="busy"><option v-for="(p, index) in modelProducts" :key="p.product_id" :value="p.product_id">{{ productOptionLabel(p, index) }}</option></select></label>
              <p v-else class="mw-muted">{{ productDisplayTitle(product) }} · {{ product.media_type === 'video' ? '视频' : '图片' }}</p>
              <label class="mw-product-toggle"><input type="checkbox" data-test="product-enabled" :checked="product.enabled" :disabled="managementDisabled" @change="updateProduct({ ...product, enabled: ($event.target as HTMLInputElement).checked })" /><span>启用此商品<span class="mw-muted">保存并发布后生效；不会改变 Account 销售开关。</span></span></label>
              <div v-if="addedProductIds.includes(product.product_id)" class="mw-product-local" role="status"><span>本次新增，尚未保存</span><button type="button" class="btn btn-secondary" data-test="undo-add-product" :disabled="managementDisabled" @click="removeProduct(product.product_id)">撤销新增</button></div>
              <details class="mw-product-options" data-test="product-options"><summary>更多商品操作</summary>
                <p class="mw-muted">同一模型通常只需一份商品：图片的文生图、参考图编辑及多种规格可在这里一起配置。仅在需要独立售价或销售方案时另建商品。</p>
                <div class="mw-product-type-actions"><button type="button" class="btn btn-secondary" data-test="new-independent-product" :disabled="managementDisabled" @click="newProductType = product.media_type">另建独立销售商品</button><button v-if="!addedProductIds.includes(product.product_id) && !removalReason(product)" type="button" class="btn mw-danger" data-test="remove-blank-product" :disabled="managementDisabled" @click="removeProductId = product.product_id">移除空白草稿</button></div>
                <p v-if="!addedProductIds.includes(product.product_id) && removalReason(product)" class="mw-muted" data-test="removal-protection">{{ removalReason(product) }}</p>
              </details>
            </section>
            <section v-if="removedProducts.length" class="mw-removal-notice" aria-label="待保存的草稿移除" data-test="pending-removals">
              <strong>待移除 {{ removedProducts.length }} 份空白草稿，保存后生效</strong>
              <ul><li v-for="removed in removedProducts" :key="removed.product_id"><span>{{ productDisplayTitle(removed) }} · {{ removed.media_type === 'video' ? '视频' : '图片' }}</span><button type="button" class="btn btn-secondary" :disabled="managementDisabled" :data-test="`undo-removal-${removed.product_id}`" @click="undoRemoval(removed.product_id)">撤销移除</button></li></ul>
              <p class="mw-muted">保留原草稿副本；已发布配置、历史任务、原片和结算不变。本次其他未保存修改也会一起保存。</p>
              <button type="button" class="btn btn-primary" data-test="save-removals" :disabled="managementDisabled" @click="saveDraft">保存草稿与移除操作</button>
            </section>
            <MediaProductEditor v-if="product" ref="productEditor" :key="`${detail.id}:${selectedProduct}`" :dirty="dirty" :binding="config?.adapter_bindings?.[product.media_type]" :native-adapter="detail.native_adapters?.[product.media_type]" :diagnostics="diagnostics" :product="product" :media-types="config?.media_types ?? [product.media_type]" :disabled="busy || deleted || conflict" @update:product="updateProduct" :account-label="`Account #${detail.id} · ${detail.name}`">
              <template #review>
            <MediaValidationPanel v-if="config" :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :products="diagnosticProducts" :account-id="detail?.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
              </template>
              <template #save>
                <div class="mw-save-draft">
                  <p class="mw-muted">保存本 Account 的草稿（共 {{ products.length }} 个商品），由后台检查。不会发布、启售或发起生成。</p>
                  <p v-if="dirty" data-test="unsaved" class="mw-muted">有未保存修改</p>
                  <button class="btn btn-primary" data-test="save" :disabled="busy || deleted || conflict || !products.length" @click="saveDraft">{{ pending === 'save' ? '保存中…' : '保存草稿' }}</button>
                  <button v-if="!dirty && config" type="button" class="btn btn-secondary" data-test="return-models" @click="backToModels">返回模型管理</button>
                  <p v-if="saveState === 'unconfirmed'" role="status" class="mw-field-error">保存结果未确认，请重新读取后核对，不要重复发布。</p>
                </div>
              </template>
            </MediaProductEditor>


          </template>
          <p v-else class="mw-muted">请先从模型列表选择一个模型。</p>
        </section>
      </main>
    </div>

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
    <MediaDialog :show="publishDialog" title="发布这次修改？" :busy="pending === 'publish'" @close="publishDialog = false">
      <p>这次会发布当前 Account 下列产品的草稿：</p>
      <ul class="mw-dialog-list"><li v-for="p in config?.draft.products ?? []" :key="p.product_id">{{ productDisplayTitle(p) }} · {{ p.media_type === 'video' ? '视频固定 1 条' : `图片 ${p.capabilities.count.min}～${p.capabilities.count.max} 张` }}</li></ul>
      <p>发布配置不会自动开启销售，已有订单不会改变，也不会发送真实生成请求。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-publish" :disabled="!canPublish" @click="confirmPublish">确认发布配置</button></template>
    </MediaDialog>
    <MediaDialog :show="salesDialog" :title="config?.sales.enabled ? '暂停媒体销售？' : '开启媒体销售？'" :busy="pending === 'sales'" @close="salesDialog = false">
      <p>下列已发布产品将一起受到 Account 级销售开关影响：</p>
      <ul class="mw-dialog-list" data-test="sales-products"><li v-for="p in config?.published?.products ?? []" :key="p.product_id">{{ productDisplayTitle(p) }} · {{ p.media_type === 'video' ? '视频' : '图片' }}</li></ul>
      <p v-if="!config?.published?.products?.length">暂无已发布产品。</p>
      <p>{{ config?.sales.enabled ? '暂停后停止新的媒体报价和新提交；已经提交的任务和历史订单不会被修改。' : '后台会核验已发布产品的销售条件；未发布草稿不会随销售开关生效。' }}</p>
      <template #actions><button class="btn" :class="config?.sales.enabled ? 'mw-danger' : 'btn-primary'" data-test="confirm-sales" :disabled="busy" @click="confirmSales">确认{{ config?.sales.enabled ? '暂停' : '开启' }}</button></template>
    </MediaDialog>
    <MediaDialog :show="reloadDialog" title="重新读取服务器配置？" :busy="busy" @close="reloadDialog = false">
      <p>当前未保存修改将被放弃。读取服务器最新草稿后再编辑，不会自动重试旧写入。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-reload" :disabled="busy" @click="reload">重新读取</button></template>
    </MediaDialog>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import MediaDialog from '@/components/admin/media/MediaDialog.vue'
import MediaProductEditor from '@/components/admin/media/MediaProductEditor.vue'
import MediaValidationPanel from '@/components/admin/media/MediaValidationPanel.vue'
import { useMediaWorkbench } from '@/composables/useMediaWorkbench'
import type { Product, Diagnostic, SupplierDetail } from '@/api/admin/mediaWorkbench'
import '@/styles/media-workbench.css'

const workbench = useMediaWorkbench()
const { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, loading, message,
  diagnostics, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
  addedProductIds, removedProducts, removalReason, removeProduct, undoRemoval,
  loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, sync, discard } = workbench
const step = ref('suppliers')
const search = ref('')
const filter = ref('')
const editorElement = ref<HTMLElement>()
const productEditor = ref<InstanceType<typeof MediaProductEditor>>()
const sourceListRef = ref<HTMLElement>()
const modelsScrollPosition = ref({ top: 0, left: 0 })
const publishDialog = ref(false)
const salesDialog = ref(false)
const reloadDialog = ref(false)
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
  SELLING: '媒体销售中', SALES_PAUSED: '媒体销售已暂停', PUBLISHED_NOT_READY: '发布未就绪',
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
const filteredModels = computed(() => detail.value?.models.filter(m => (!filter.value || m.state === filter.value) && `${m.model_id} ${rowProduct(m.model_id)?.display_name ?? ''}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const selectedRow = computed(() => detail.value?.models.find(m => m.model_id === selectedModel.value))
const modelProducts = computed(() => products.value.filter(p => p.upstream_model === selectedModel.value))
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
function modelLabel(state: string) { return ({ PENDING: '待配置', PUBLISHED: '已发布', DRAFT: '草稿修改', UI_FIXABLE: '需要修改', NEEDS_DEVELOPMENT: '需要适配', UNKNOWN: '检查暂不可用', UPSTREAM_NOT_DISCOVERED: '上游目录未发现', UPSTREAM_MISSING: '上游目录未发现', MODEL_SYNC_REQUIRED: '需要同步模型', DISABLED: '本站停用', INACTIVE: '本站停用' } as Record<string, string>)[state] ?? state }
function effectiveLabel(state: string) { return ({ SALES_PAUSED: '媒体销售已暂停', NOT_YET_ENABLED: '未开启销售', SALES_OFF_UNKNOWN: '销售已关闭（历史启售状态未知）', ACCOUNT_INACTIVE: 'Sub2 账户已停用', ACCOUNT_UNSCHEDULABLE: 'Sub2 账户不可调度', ACCOUNT_RUNTIME_BLOCKED: '账户暂时无法提供服务，请打开账户详情处理', PUBLISHED_NOT_READY: '已发布配置暂未满足销售条件', NOT_INITIALIZED: '未开启销售', PUBLISHED_VALIDATOR_NOT_WIRED: '后台检查尚未接入', UNSUPPORTED_ACCOUNT_TYPE: '此账户类型不支持媒体供应商', ACTIVE: '媒体销售中', SALES_ENABLED: '媒体销售中', SELLING: '媒体销售中' } as Record<string, string>)[state] ?? state }
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
  addProduct(type, true)
}
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
  navigate(() => { selectedProduct.value = id })
}
function updateProduct(value: Product) { const index = products.value.findIndex(p => p.product_id === selectedProduct.value); if (index >= 0) products.value[index] = value }
function navigate(action: () => void | Promise<void>) { if (busy.value) return; if (dirty.value) nextNavigation.value = action; else void action() }
async function openSupplier(id: number) { await selectSupplier(id); if (detail.value?.id === id) step.value = 'models' }
async function openEditor(modelId: string) {
  // AppLayout and .mw-page scroll with the document, not inside the model panel.
  modelsScrollPosition.value = { top: window.scrollY, left: window.scrollX }
  selectModel(modelId); step.value = 'editor'
  await nextTick()
  editorElement.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
}
async function backToModels() {
  step.value = 'models'
  await nextTick()
  window.scrollTo({ ...modelsScrollPosition.value, behavior: 'instant' })
}
async function saveAndNavigate() {
  if (!await saveDraft()) return
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
async function confirmPublish() { await publish(); publishDialog.value = false }
async function confirmSales() { if (config.value) await sales(!config.value.sales.enabled); salesDialog.value = false }
async function reload() {
  const accountId = detail.value?.id
  if (!accountId) return
  const previousStep = step.value
  const modelId = selectedModel.value
  const productId = selectedProduct.value
  await selectSupplier(accountId)
  reloadDialog.value = false
  if (detail.value?.id !== accountId || message.value) return
  const modelExists = detail.value.models.some(model => model.model_id === modelId) ||
    products.value.some(item => item.upstream_model === modelId)
  if (modelId && modelExists) {
    selectModel(modelId)
    if (products.value.some(item => item.product_id === productId && item.upstream_model === modelId)) selectedProduct.value = productId
  }
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
  const field = ['adapter_config.execution.max_output_images', 'adapter_config.edit_execution.max_output_images', 'adapter_config.execution', 'adapter_config.edit_execution', 'adapter_config.model_family', 'adapter_config.wire_profile', 'adapter_config.size_mappings', 'capabilities.qualities', 'capabilities.combination_rules', 'pricing_rules', 'capabilities.references', 'capabilities', 'display_name', 'site_model', 'product_id', 'media_type'].find(key => fieldPath.includes(key)) ?? 'model'
  const section = editorElement.value?.querySelector<HTMLElement>(`[data-field="${field}"]`)
  section?.querySelectorAll('details').forEach(node => { node.open = true })
  let ancestor = section
  while (ancestor && ancestor !== editorElement.value) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement ?? undefined
  }
  const target = section?.matches('input,select') ? section : section?.querySelector<HTMLElement>('input,select,button')
  target?.focus()
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
onBeforeRouteLeave(() => { if (busy.value) { message.value = '操作正在进行，请等待完成后离开。'; return false } if (!dirty.value) return true; return new Promise<boolean>(resolve => { nextNavigation.value = () => resolve(true); routeResolve = resolve }) })
let routeResolve: ((value: boolean) => void) | undefined
watch(nextNavigation, value => { if (!value && routeResolve) { routeResolve(false); routeResolve = undefined } })
onMounted(() => { void loadSuppliers(); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { routeResolve?.(false); window.removeEventListener('beforeunload', beforeUnload) })
</script>

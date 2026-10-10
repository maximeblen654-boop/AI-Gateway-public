<template>
  <AppLayout>
    <div class="media-workbench" :class="`mw-step-${step}`" :aria-busy="!!pending || loading">
      <header class="mw-heading">
        <div>
          <p class="mw-eyebrow">MEDIA WORKBENCH</p>
          <h1>媒体工作台</h1>
          <p class="mw-muted">按“来源与账号 → 模型 → 完整配置”完成媒体产品设置。</p>
        </div>
        <nav class="mw-steps" aria-label="配置步骤">
          <span :class="{ 'mw-step-current': step === 'suppliers' }">1 来源与账号</span>
          <span :class="{ 'mw-step-current': step === 'models' }">2 选择模型</span>
          <span :class="{ 'mw-step-current': step === 'editor' }">3 配置产品</span>
        </nav>
      </header>

      <div class="mw-statistics">
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
            <div><p class="mw-eyebrow">第 1 步</p><h2>先选择来源与 Account</h2><p class="mw-muted">来源域名默认折叠。搜索支持数字 Account ID、名称、域名和平台。</p></div>
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
            <div><p class="mw-eyebrow">第 2 步 · 已选择 Account #{{ detail.id }}</p><h2>{{ detail.name }}</h2><p class="mw-muted mw-account-host">{{ sourceHost(detail) || '未识别来源' }} · {{ detail.platform || '未知平台' }}</p><p class="mw-muted">媒体类型：{{ mediaTypeLabel }}</p><p class="mw-muted">{{ effectiveLabel(detail.effective_state) }}</p></div>
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
              <span v-if="rowProduct(row.model_id)">{{ rowProduct(row.model_id)?.display_name }} · {{ rowProduct(row.model_id)?.media_type === 'video' ? '视频' : '图片' }}</span>
              <small v-if="rowProduct(row.model_id)">内部 ID: {{ rowProduct(row.model_id)?.site_model }}</small>
              <small v-if="rowProduct(row.model_id)">{{ (rowProduct(row.model_id)?.capabilities.resolutions ?? []).join(' / ') }} · {{ priceLabel(rowProduct(row.model_id)) }}</small>
              <span class="mw-model-action">{{ rowProduct(row.model_id) ? '编辑配置 →' : '配置 →' }}</span>
            </button>
          </div>
        </section>

        <section v-else ref="editorElement" class="mw-page mw-panel mw-editor-page" aria-label="模型配置编辑器" data-test="editor-page">
          <button type="button" class="mw-back btn btn-secondary" :disabled="busy" @click="navigate(backToModels)">← 返回模型列表</button>
          <div v-if="detail" class="mw-page-heading mw-account-context">
            <div><p class="mw-eyebrow">第 3 步 · Account #{{ detail.id }}</p><h2>配置当前媒体模型</h2><p class="mw-muted">账号：{{ detail.name }} · {{ sourceHost(detail) || '未识别来源' }}</p><p class="mw-muted">媒体类型：{{ mediaTypeLabel }}</p><p class="mw-muted">在这里设置客户可选规格、哪些规格影响定价、保存、发布与销售状态。</p></div>
            <div class="mw-selection-feedback" data-test="selected-model-summary"><strong>当前上游模型</strong><span data-test="upstream-model-name">{{ selectedModel }}</span><small>{{ selectedRow?.state ? modelLabel(selectedRow.state) : '待配置' }}</small></div>
          </div>
          <template v-if="detail && selectedModel">
            <p class="mw-model-id">{{ selectedModel }}</p>
            <p class="mw-muted">{{ selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING' ? '上游最新成功目录中未发现此模型，配置会保留且新报价由后台阻止。' : '请填写已确认的供应商规格；示例值不会自动写入能力或报价。' }}</p>
            <div v-if="!product" class="mw-start-product mw-banner">
              <h3>先选择产品类型</h3><p>第一次保存时，后台会根据这里提交的产品类型自动初始化此 Account 的媒体配置。</p>
              <div class="mw-product-type-actions"><button class="btn btn-primary" data-test="add-product-image" :disabled="busy || deleted || conflict" @click="addProduct('image')">开始配置图片</button><button class="btn btn-secondary" data-test="add-product-video" :disabled="busy || deleted || conflict" @click="addProduct('video')">开始配置视频</button></div>
            </div>
            <div v-if="modelProducts.length > 1"><label class="mw-field">本站产品<select v-model="selectedProduct" class="input" data-test="product-select" :disabled="busy"><option v-for="p in modelProducts" :key="p.product_id" :value="p.product_id">{{ p.display_name }} · {{ p.product_id }}</option></select></label></div>
            <MediaProductEditor v-if="product" :product="product" :media-types="config?.media_types ?? [product.media_type]" :disabled="busy || deleted || conflict" @update:product="updateProduct" @identity="selectedProduct = $event" />
            <div v-if="product && !config && addablePreInitTypes.length" class="mw-product-type-actions"><button v-for="type in addablePreInitTypes" :key="type" class="btn btn-secondary" :disabled="busy || deleted || conflict" @click="addProduct(type)">添加{{ type === 'image' ? '图片' : '视频' }}产品后一起保存</button></div>
            <div v-if="product && config" class="mw-product-type-actions"><button v-for="type in config.media_types" :key="type" class="btn btn-secondary" :disabled="busy || deleted || conflict" @click="addProduct(type)">添加{{ type === 'image' ? '图片' : '视频' }}产品</button></div>

            <section class="mw-sales-card" data-test="sales-state">
              <div><p class="mw-eyebrow">销售状态</p><strong>{{ salesLabel }}</strong><p class="mw-muted">发布配置与开启销售是两个独立动作；发布不会自动启用销售。</p></div>
              <button v-if="config" class="btn" :class="config.sales.enabled ? 'mw-danger' : 'btn-secondary'" data-test="sales" :disabled="busy || deleted || conflict || (!config.sales.enabled && !canResume)" @click="salesDialog = true">{{ config.sales.enabled ? '暂停销售' : '开启销售' }}</button>
              <span v-else class="mw-badge">首次保存后可开启</span>
            </section>
            <p v-if="config && !config.sales.enabled && !canResume" class="mw-muted">{{ resumeReason }}</p>

            <MediaValidationPanel v-if="config" :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :account-id="detail.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
            <details v-if="config"><summary>技术详情</summary><dl><dt>草稿版本</dt><dd>{{ config.draft.revision }}</dd><dt>发布版本</dt><dd>{{ config.published?.revision || '尚未发布' }}</dd><dt>适配器版本</dt><dd>{{ config.validation.adapter_registry_revision || '后台未提供' }}</dd></dl></details>
            <div class="mw-action-card">
              <div><strong>保存、发布、销售</strong><p class="mw-muted">先保存草稿，后台检查通过后才能发布；发布不会改变销售开关。</p></div>
              <div class="mw-publish-bar"><small>{{ saveState === 'unconfirmed' ? '保存结果未确认' : dirty ? '未保存修改' : '服务器草稿' }}<span v-if="config"> · {{ config.draft.updated_at }}</span></small><div><button class="btn btn-primary" data-test="save" :disabled="busy || deleted || conflict || !products.length" @click="saveDraft">{{ pending === 'save' ? '保存中…' : '保存草稿' }}</button><button class="btn btn-primary" data-test="publish" :disabled="!canPublish" @click="publishDialog = true">{{ pending === 'publish' ? '发布中…' : '发布配置' }}</button></div></div>
            </div>
            <p v-if="!config" class="mw-muted">完成规格和售价后，点击“保存草稿”完成首次初始化。</p>
            <p v-else-if="!canPublish" class="mw-muted">保存最新草稿后，后台检查确认可发布时启用“发布配置”。</p>
          </template>
          <p v-else class="mw-muted">请先从模型列表选择一个模型。</p>
        </section>
      </main>
    </div>

    <MediaDialog :show="!!nextNavigation" title="有未保存修改" :busy="!!pending" @close="nextNavigation = null">
      <p>保存草稿后切换，或放弃当前未保存修改。</p>
      <template #actions><button class="btn btn-primary" data-test="save-navigate" :disabled="!!pending || conflict || deleted" @click="saveAndNavigate">保存草稿后切换</button><button class="btn btn-secondary" data-test="discard-navigate" :disabled="!!pending" @click="discardAndNavigate">放弃修改</button></template>
    </MediaDialog>
    <MediaDialog :show="publishDialog" title="发布这次修改？" :busy="pending === 'publish'" @close="publishDialog = false">
      <p>这次会发布当前 Account 下列产品的草稿：</p>
      <ul class="mw-dialog-list"><li v-for="p in config?.draft.products ?? []" :key="p.product_id">{{ p.display_name || p.upstream_model }} · {{ p.media_type === 'video' ? '视频固定 1 条' : `图片 ${p.capabilities.count.min}～${p.capabilities.count.max} 张` }}</li></ul>
      <p>发布配置不会自动开启销售，已有订单不会改变，也不会发送真实生成请求。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-publish" :disabled="!canPublish" @click="confirmPublish">确认发布配置</button></template>
    </MediaDialog>
    <MediaDialog :show="salesDialog" :title="config?.sales.enabled ? '暂停媒体销售？' : '开启媒体销售？'" :busy="pending === 'sales'" @close="salesDialog = false">
      <p>下列已发布产品将一起受到 Account 级销售开关影响：</p>
      <ul class="mw-dialog-list" data-test="sales-products"><li v-for="p in config?.published?.products ?? []" :key="p.product_id">{{ p.display_name || p.upstream_model }} · {{ p.media_type === 'video' ? '视频' : '图片' }}</li></ul>
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
  loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, sync, discard } = workbench
const step = ref('suppliers')
const search = ref('')
const filter = ref('')
const editorElement = ref<HTMLElement>()
const sourceListRef = ref<HTMLElement>()
const modelsScrollPosition = ref({ top: 0, left: 0 })
const publishDialog = ref(false)
const salesDialog = ref(false)
const reloadDialog = ref(false)
const accountSearch = ref('')
const accountFilter = ref('')
const platformFilter = ref('')
const collapsedSources = ref(new Set<string>())
const knownSourceHosts = ref(new Set<string>())
const nextNavigation = ref<(() => void | Promise<void>) | null>(null)
const busy = computed(() => !!pending.value || loading.value)
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
const addablePreInitTypes = computed(() => {
  const selectedProducts = products.value.filter(item => item.upstream_model === selectedModel.value)
  return ['image', 'video'].filter(type => !selectedProducts.some(item => item.media_type === type))
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
async function locate({ path, scope }: Diagnostic) { const productIndex = /products(?:\[|\.)(\d+)/.exec(path)?.[1]; const productTarget = products.value.find(p => p.product_id === scope) ?? (productIndex !== undefined ? products.value[Number(productIndex)] : undefined); if (productTarget) { selectedModel.value = productTarget.upstream_model; selectedProduct.value = productTarget.product_id; step.value = 'editor'; await nextTick() } const field = ['adapter_config.size_mappings', 'pricing_rules', 'capabilities', 'display_name', 'site_model', 'product_id', 'media_type'].find(key => path.includes(key)) ?? 'model'; const section = editorElement.value?.querySelector<HTMLElement>(`[data-field="${field}"]`); section?.querySelectorAll('details').forEach(node => { node.open = true }); const target = section?.matches('input,select') ? section : section?.querySelector<HTMLElement>('input,select,button'); target?.focus(); section?.scrollIntoView?.({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }
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

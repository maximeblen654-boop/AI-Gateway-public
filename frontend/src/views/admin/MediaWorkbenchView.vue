<template>
  <AppLayout>
    <div class="media-workbench" :class="`mw-step-${step}`" :aria-busy="!!pending || loading">
      <header class="mw-heading">
        <div><p class="mw-eyebrow">MEDIA WORKBENCH</p><h1>媒体工作台</h1><p class="mw-muted">供应商、模型、规格和售价，都在这里管理。</p></div>
        <button class="btn btn-primary" :disabled="busy" data-test="add-supplier" @click="navigate(() => { addDialog = true })">添加供应商</button>
      </header>
      <div class="mw-statistics">
        <div><span>供应商</span><strong>{{ suppliers.filter(s => s.media_workbench_v1).length }}</strong></div>
        <div><span>已发布模型</span><strong>{{ publishedCount }}</strong></div>
        <div><span>待配置模型</span><strong>{{ suppliers.reduce((n, s) => n + s.pending_count, 0) }}</strong></div>
        <div><span>需要处理</span><strong>{{ suppliers.reduce((n, s) => n + s.problem_count, 0) }}</strong></div>
      </div>
      <div v-if="message" class="mw-banner" role="status" data-test="banner">
        <span>{{ message }}</span>
        <button v-if="detail && !deleted" class="btn btn-secondary" data-test="reload" :disabled="busy" @click="reloadDialog = true">重新读取</button>
        <button v-else-if="deleted" class="btn btn-secondary" @click="navigate(returnToSuppliers)">返回供应商列表</button>
        <button v-else-if="!detail" class="btn btn-secondary" :disabled="busy" @click="loadSuppliers">重试读取</button>
      </div>
      <p v-if="loading" role="status">正在读取供应商配置…</p>
      <div class="mw-columns">
        <aside class="mw-suppliers mw-panel" aria-label="供应商列表">
          <h2>供应商</h2>
          <p v-if="!suppliers.length && !loading" class="mw-muted">暂无供应商，请先在账户管理添加 API-Key 账户。</p>
          <button v-for="supplier in suppliers" :key="supplier.id" type="button" class="mw-supplier" :class="{ 'mw-selected': detail?.id === supplier.id }" :aria-pressed="detail?.id === supplier.id" :disabled="busy" :data-test="`supplier-${supplier.id}`" @click="navigate(() => openSupplier(supplier.id))">
            <strong>{{ supplier.name }}</strong><span>Account #{{ supplier.id }} · {{ supplier.host }}</span>
            <span class="mw-status">{{ supplier.effective_sales ? '● 媒体销售中' : '○ ' + effectiveLabel(supplier.effective_state) }}</span>
            <span>{{ supplier.status === 'active' ? 'Sub2 正常' : 'Sub2 已停用' }} · {{ supplier.schedulable ? '可调度' : '不可调度' }}</span>
            <span>发现 {{ supplier.discovered_count }} · 已配置 {{ supplier.configured_count }} · 待配置 {{ supplier.pending_count }}</span>
            <small>最后同步 {{ supplier.model_catalog?.synced_at || '尚未同步' }}</small>
          </button>
        </aside>
        <section v-if="detail" class="mw-models mw-panel" aria-label="模型列表">
          <button type="button" class="mw-mobile-back btn btn-secondary" :disabled="busy" @click="navigate(() => { step = 'suppliers' })">← 供应商</button>
          <div class="mw-section-heading"><div><h2>{{ detail.name }}</h2><p class="mw-muted">{{ effectiveLabel(detail.effective_state) }}</p></div><router-link :to="accountLink(detail.id)" class="mw-link">打开账户详情 ↗</router-link></div>
          <div class="mw-supplier-actions">
            <button class="btn btn-secondary" data-test="sync" :disabled="busy || deleted || conflict" @click="sync">{{ pending === 'sync' ? '同步中…' : '同步模型' }}</button>
            <button v-if="config" class="btn" :class="config.sales.enabled ? 'mw-danger' : 'btn-secondary'" data-test="sales" :disabled="busy || deleted || conflict || (!config.sales.enabled && !canResume)" @click="salesDialog = true">{{ config.sales.enabled ? '暂停销售' : '恢复销售' }}</button>
          </div>
          <p v-if="config && !config.sales.enabled && !canResume" class="mw-muted">{{ resumeReason }}</p>
          <div v-if="!config" class="mw-banner"><p>选择媒体用途后即可配置此账户。</p><button class="btn btn-primary" :disabled="busy || deleted" @click="addAccountId = detail.id; addDialog = true">启用媒体工作台</button></div>
          <label class="mw-field">搜索模型<input v-model="search" class="input" placeholder="模型名称或精确 ID" type="search" /></label>
          <label class="mw-field">模型状态<select v-model="filter" class="input"><option value="">全部</option><option v-for="state in modelStates" :key="state" :value="state">{{ modelLabel(state) }}</option></select></label>
          <p v-if="!filteredModels.length" class="mw-muted">没有匹配模型。可同步上游模型目录。</p>
          <button v-for="row in filteredModels" :key="row.model_id" class="mw-model-row" :class="{ 'mw-selected': selectedModel === row.model_id }" :aria-pressed="selectedModel === row.model_id" :disabled="busy" :data-test="`model-${row.model_id}`" @click="navigate(() => { selectModel(row.model_id); step = 'editor' })">
            <strong>{{ row.model_id }}</strong><span class="mw-badge" :data-state="row.state">● {{ modelLabel(row.state) }}</span>
            <span v-if="rowProduct(row.model_id)">{{ rowProduct(row.model_id)?.display_name }} · {{ rowProduct(row.model_id)?.media_type === 'video' ? '视频' : '图片' }}</span>
            <small v-if="rowProduct(row.model_id)">内部 ID: {{ rowProduct(row.model_id)?.site_model }}</small>
            <small v-if="rowProduct(row.model_id)">{{ (rowProduct(row.model_id)?.capabilities.resolutions ?? []).join(' / ') }} · {{ priceLabel(rowProduct(row.model_id)) }}</small>
          </button>
        </section>
        <section v-if="detail && config && selectedModel" ref="editorElement" class="mw-editor mw-panel" aria-label="模型配置编辑器">
          <button type="button" class="mw-mobile-back btn btn-secondary" :disabled="busy" @click="navigate(() => { step = 'models' })">← 模型列表</button>
          <div class="mw-section-heading"><h2>模型配置</h2><span v-if="dirty" class="mw-badge" data-test="unsaved">● 未保存修改</span></div>
          <p class="mw-model-id">{{ selectedModel }}</p><p class="mw-muted">Account #{{ detail.id }} · 最近同步 {{ detail.model_catalog?.synced_at || '尚未同步' }}</p>
          <p v-if="selectedRow?.state === 'UPSTREAM_NOT_DISCOVERED' || selectedRow?.state === 'UPSTREAM_MISSING'" class="mw-banner">上游最新成功目录中未发现此模型。配置与历史保留，新报价由后台阻止。</p>
          <div v-if="modelProducts.length > 1"><label class="mw-field">本站产品<select v-model="selectedProduct" class="input" :disabled="busy"><option v-for="p in modelProducts" :key="p.product_id" :value="p.product_id">{{ p.display_name }} · {{ p.product_id }}</option></select></label></div>
          <MediaProductEditor v-if="product" :product="product" :media-types="config.media_types" :disabled="busy || deleted || conflict" @update:product="updateProduct" @identity="selectedProduct = $event" />
          <p v-else class="mw-muted">此模型待配置。添加产品后填写供应商已确认的规格与本站售价。</p>
          <div class="mw-add-product"><button v-for="type in config.media_types" :key="type" class="btn btn-secondary" :disabled="busy || deleted || conflict" @click="addProduct(type)">添加{{ type === 'image' ? '图片' : '视频' }}产品</button></div>
          <section v-if="procurement.length"><h3>采购成本（参考）</h3><p v-for="(entry, index) in procurement" :key="index">{{ entry.cost.currency }} {{ entry.cost.amount }} · {{ entry.source }}</p></section>
          <MediaValidationPanel :validation="config.validation" :current="validationCurrent && !dirty" :unavailable="validationUnavailable" :save-state="saveState" :diagnostics="diagnostics" :account-id="detail.id" :model-id="selectedModel" @locate="locate" @message="message = $event" />
          <details><summary>技术详情</summary><dl><dt>草稿版本</dt><dd>{{ config.draft.revision }}</dd><dt>发布版本</dt><dd>{{ config.published?.revision || '尚未发布' }}</dd><dt>适配器版本</dt><dd>{{ config.validation.adapter_registry_revision || '后台未提供' }}</dd></dl></details>
          <div class="mw-publish-bar">
            <small>{{ saveState === 'unconfirmed' ? '保存结果未确认' : dirty ? '未保存' : '服务器草稿' }} · {{ config.draft.updated_at }}</small>
            <div><button class="btn btn-primary" data-test="save" :disabled="busy || deleted || conflict" @click="saveDraft">{{ pending === 'save' ? '保存中…' : '保存草稿' }}</button><button class="btn btn-primary" data-test="publish" :disabled="!canPublish" @click="publishDialog = true">{{ pending === 'publish' ? '发布中…' : '发布' }}</button></div>
          </div>
          <p v-if="!canPublish" class="mw-muted">保存最新草稿后，后台检查确认可发布时启用“发布”。</p>
        </section>
        <section v-else-if="detail && step === 'editor'" class="mw-panel mw-editor"><p>同步模型或选择模型后配置。</p></section>
        <section v-else-if="!detail" class="mw-panel mw-welcome"><h2>从供应商开始</h2><p class="mw-muted">同步模型 → 配置规格和售价 → 保存草稿 → 自动检查 → 发布</p></section>
      </div>
    </div>
    <MediaDialog :show="!!nextNavigation" title="有未保存修改" :busy="!!pending" @close="nextNavigation = null">
      <p>保存草稿后切换，或放弃当前未保存修改。</p>
      <template #actions><button class="btn btn-primary" data-test="save-navigate" :disabled="!!pending || conflict || deleted" @click="saveAndNavigate">保存草稿后切换</button><button class="btn btn-secondary" data-test="discard-navigate" :disabled="!!pending" @click="discardAndNavigate">放弃修改</button></template>
    </MediaDialog>
    <MediaDialog :show="publishDialog" title="发布这次修改？" :busy="pending === 'publish'" @close="publishDialog = false">
      <p>发布当前草稿中的 {{ config?.draft.products.length ?? 0 }} 个产品。新报价将采用后台编译的新配置。</p><p>已有订单不会改变。不会发送真实生成请求。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-publish" :disabled="!canPublish" @click="confirmPublish">确认发布</button></template>
    </MediaDialog>
    <MediaDialog :show="salesDialog" :title="config?.sales.enabled ? '暂停媒体销售？' : '恢复媒体销售？'" :busy="pending === 'sales'" @close="salesDialog = false">
      <p>{{ config?.sales.enabled ? '暂停后停止新的媒体报价和新提交。已经提交的任务和历史订单不会被修改。' : '后台会核验此账户与已发布产品的当前销售条件。' }}</p>
      <template #actions><button class="btn" :class="config?.sales.enabled ? 'mw-danger' : 'btn-primary'" data-test="confirm-sales" :disabled="busy" @click="confirmSales">确认{{ config?.sales.enabled ? '暂停' : '恢复' }}</button></template>
    </MediaDialog>
    <MediaDialog :show="reloadDialog" title="重新读取服务器配置？" :busy="busy" @close="reloadDialog = false">
      <p>当前未保存修改将被放弃。读取服务器最新草稿后再编辑，不会自动重试旧写入。</p>
      <template #actions><button class="btn btn-primary" data-test="confirm-reload" :disabled="busy" @click="reload">重新读取</button></template>
    </MediaDialog>
    <MediaDialog :show="addDialog" title="添加媒体供应商" :busy="pending === 'initialize'" @close="addDialog = false">
      <label class="mw-field">现有 Sub2 API-Key 账户<select v-model="addAccountId" class="input" :disabled="busy"><option :value="0">请选择</option><option v-for="supplier in availableAccounts" :key="supplier.id" :value="supplier.id">{{ supplier.name }} · #{{ supplier.id }}</option></select></label>
      <p>没有合适账户？<router-link class="mw-link" to="/admin/accounts">去账户管理添加供应商 Key</router-link>。</p>
      <label class="mw-field">业务用途<select v-model="addMediaType" class="input" :disabled="busy"><option value="image">图片</option><option value="video">视频</option><option value="both">图片 + 视频</option></select></label>
      <p class="mw-muted">适配方式由后台匹配，保存后显示检查结果。</p>
      <p v-if="message" role="status">{{ message }}</p>
      <MediaValidationPanel v-if="diagnostics.length" :current="true" :unavailable="false" save-state="" :diagnostics="diagnostics" :account-id="addAccountId" model-id="" @locate="locate" @message="message = $event" />
      <template #actions><button class="btn btn-primary" data-test="initialize" :disabled="!addAccountId || busy" @click="addSupplier">添加</button></template>
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
import type { Product, Diagnostic } from '@/api/admin/mediaWorkbench'
import '@/styles/media-workbench.css'
const workbench = useMediaWorkbench()
const { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, loading, message,
  diagnostics, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
  loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, sync, initialize, discard } = workbench
const step = ref('suppliers')
const search = ref('')
const filter = ref('')
const editorElement = ref<HTMLElement>()
const publishDialog = ref(false)
const salesDialog = ref(false)
const reloadDialog = ref(false)
const addDialog = ref(false)
const addAccountId = ref(0)
const addMediaType = ref('image')
const nextNavigation = ref<(() => void | Promise<void>) | null>(null)
const busy = computed(() => !!pending.value || loading.value)
const publishedCount = computed(() => suppliers.value.reduce((n, s) => n + s.models.filter(m => m.state === 'PUBLISHED').length, 0))
const modelStates = computed(() => [...new Set(detail.value?.models.map(m => m.state) ?? [])])
const filteredModels = computed(() => detail.value?.models.filter(m => (!filter.value || m.state === filter.value) &&
  `${m.model_id} ${rowProduct(m.model_id)?.display_name ?? ''}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const selectedRow = computed(() => detail.value?.models.find(m => m.model_id === selectedModel.value))
const modelProducts = computed(() => products.value.filter(p => p.upstream_model === selectedModel.value))
const procurement = computed(() => config.value?.procurement?.entries.filter(p => p.product_id === selectedProduct.value) ?? [])
const availableAccounts = computed(() => suppliers.value.filter(s => s.type === 'apikey' && !s.media_workbench_v1))
const canResume = computed(() => detail.value?.sales_resume_ready ?? (detail.value?.effective_state === 'SALES_PAUSED' &&
  detail.value.status === 'active' && detail.value.schedulable && (config.value?.published?.offers?.length ?? 0) > 0))
const resumeReason = computed(() => !detail.value?.schedulable ? '账户不可调度，请打开账户详情处理。' : detail.value?.status !== 'active' ? '账户已停用，请打开账户详情处理。' : '后台尚未提供可恢复销售的已发布产品。')
const accountLink = (id: number) => ({ path: '/admin/accounts', query: { account_id: String(id) } })
function modelLabel(state: string) {
  return ({ PENDING: '待配置', PUBLISHED: '已发布', DRAFT: '草稿修改', UI_FIXABLE: '需要修改', NEEDS_DEVELOPMENT: '需要适配', UNKNOWN: '检查暂不可用', UPSTREAM_NOT_DISCOVERED: '上游目录未发现', UPSTREAM_MISSING: '上游目录未发现', MODEL_SYNC_REQUIRED: '需要同步模型', DISABLED: '本站停用', INACTIVE: '本站停用' } as Record<string, string>)[state] ?? state
}
function effectiveLabel(state: string) {
  return ({ SALES_PAUSED: '媒体销售已暂停', ACCOUNT_INACTIVE: 'Sub2 账户已停用', ACCOUNT_UNSCHEDULABLE: 'Sub2 账户不可调度', ACCOUNT_RUNTIME_BLOCKED: '账户暂时无法提供服务，请打开账户详情处理', PUBLISHED_NOT_READY: '已发布配置暂未满足销售条件', NOT_INITIALIZED: '待启用媒体工作台', PUBLISHED_VALIDATOR_NOT_WIRED: '后台检查尚未接入', UNSUPPORTED_ACCOUNT_TYPE: '此账户类型不支持媒体供应商', ACTIVE: '媒体销售中', SALES_ENABLED: '媒体销售中', SELLING: '媒体销售中' } as Record<string, string>)[state] ?? state
}
function updateProduct(value: Product) {
  const index = products.value.findIndex(p => p.product_id === selectedProduct.value)
  if (index >= 0) products.value[index] = value
}
function rowProduct(id: string) { return config.value?.draft.products.find(p => p.upstream_model === id) }
function priceLabel(p?: Product) {
  if (!p?.pricing_rules?.length) return '未配置售价'
  return p.pricing_rules.map(rule => rule.sale_price == null ? '未配置售价' : `${rule.sale_price.currency} ${rule.sale_price.amount}`).join(' / ')
}
function navigate(action: () => void | Promise<void>) {
  if (busy.value) return
  if (dirty.value) nextNavigation.value = action
  else void action()
}
async function openSupplier(id: number) { await selectSupplier(id); if (detail.value?.id === id) { search.value = ''; filter.value = ''; step.value = 'models' } }
async function saveAndNavigate() {
  if (!await saveDraft()) return
  const action = nextNavigation.value; nextNavigation.value = null; await action?.()
}
async function discardAndNavigate() { discard(); const action = nextNavigation.value; nextNavigation.value = null; await action?.() }
async function confirmPublish() { await publish(); publishDialog.value = false }
async function confirmSales() { await sales(!config.value?.sales.enabled); salesDialog.value = false }
async function reload() { if (detail.value) await selectSupplier(detail.value.id); reloadDialog.value = false }
async function addSupplier() {
  if (await initialize(addAccountId.value, addMediaType.value === 'both' ? ['image', 'video'] : [addMediaType.value])) { addDialog.value = false; step.value = 'models' }
}
async function returnToSuppliers() { detail.value = null; products.value = []; selectedModel.value = ''; step.value = 'suppliers'; await loadSuppliers() }
async function locate({ path, scope }: Diagnostic) {
  const productIndex = /products(?:\[|\.)(\d+)/.exec(path)?.[1]
  const productTarget = products.value.find(p => p.product_id === scope) ??
    (productIndex !== undefined ? products.value[Number(productIndex)] : undefined)
  if (productTarget) { selectedModel.value = productTarget.upstream_model; selectedProduct.value = productTarget.product_id; step.value = 'editor'; await nextTick() }
  const field = ['adapter_config.size_mappings', 'pricing_rules', 'capabilities', 'display_name', 'site_model', 'product_id', 'media_type'].find(key => path.includes(key)) ?? 'model'
  const section = editorElement.value?.querySelector<HTMLElement>(`[data-field="${field}"]`)
  section?.querySelectorAll('details').forEach(node => { node.open = true })
  const target = section?.matches('input,select') ? section : section?.querySelector<HTMLElement>('input,select,button')
  target?.focus(); section?.scrollIntoView?.({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || pending.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(() => {
  if (busy.value) { message.value = '操作正在进行，请等待完成后离开。'; return false }
  if (!dirty.value) return true
  return new Promise<boolean>(resolve => { nextNavigation.value = () => resolve(true); /* cancel resolves via route lifetime below */ routeResolve = resolve })
})
let routeResolve: ((value: boolean) => void) | undefined
// A cancelled dialog must also finish the router guard.
watch(nextNavigation, value => { if (!value && routeResolve) { routeResolve(false); routeResolve = undefined } })
onMounted(() => { void loadSuppliers(); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { routeResolve?.(false); window.removeEventListener('beforeunload', beforeUnload) })
</script>

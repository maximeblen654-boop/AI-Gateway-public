import { computed, onBeforeUnmount, ref } from 'vue'
import { mediaWorkbenchAPI, draftInput, type Product, type SupplierDetail, type Diagnostic } from '@/api/admin/mediaWorkbench'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function useMediaWorkbench() {
  const suppliers = ref<SupplierDetail[]>([])
  const detail = ref<SupplierDetail | null>(null)
  const products = ref<Product[]>([])
  const selectedModel = ref('')
  const selectedProduct = ref('')
  const pending = ref('')
  const loading = ref(false)
  const message = ref('')
  const errorStatus = ref(0)
  const errorDiagnostics = ref<Diagnostic[]>([])
  const deleted = ref(false)
  const conflict = ref(false)
  const validationUnavailable = ref(false)
  const saveState = ref('')
  let baseline = '[]'
  let loadSequence = 0
  let validationSequence = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const config = computed(() => detail.value?.media_workbench_v1)
  const dirty = computed(() => JSON.stringify(draftInput(products.value).products) !== baseline)
  const product = computed(() => products.value.find(p => p.product_id === selectedProduct.value))
  const validationCurrent = computed(() => !!config.value && config.value.validation.draft_revision === config.value.draft.revision)
  const canPublish = computed(() => !pending.value && !loading.value && !dirty.value && !deleted.value && !conflict.value && !validationUnavailable.value &&
    validationCurrent.value && config.value?.validation.status === 'PASS' && config.value.validation.publish_ready)
  const diagnostics = computed(() => errorDiagnostics.value.length ? errorDiagnostics.value : validationCurrent.value ? config.value?.validation.diagnostics ?? [] : [])

  function stopPolling() { validationSequence++; clearTimeout(pollTimer) }
  function apply(dto: SupplierDetail, replaceDraft: boolean) {
    detail.value = dto
    const index = suppliers.value.findIndex(s => s.id === dto.id)
    if (index >= 0) suppliers.value[index] = dto
    else suppliers.value.push(dto)
    if (replaceDraft) {
      products.value = clone(draftInput(dto.media_workbench_v1?.draft.products ?? []).products)
      baseline = JSON.stringify(products.value)
    }
    if (!selectedModel.value) selectedModel.value = dto.models[0]?.model_id ?? ''
    if (!products.value.some(p => p.product_id === selectedProduct.value && p.upstream_model === selectedModel.value)) {
      selectedProduct.value = products.value.find(p => p.upstream_model === selectedModel.value)?.product_id ?? ''
    }
  }
  function clearError() { message.value = ''; errorStatus.value = 0; errorDiagnostics.value = [] }
  function failure(error: unknown, affectsCurrentAccount = true) {
    const e = error as { status?: number; message?: string; metadata?: { diagnostics?: Diagnostic[] } }
    errorStatus.value = e.status ?? 0
    errorDiagnostics.value = e.metadata?.diagnostics ?? []
    if (e.status === 409) { conflict.value = true; stopPolling() }
    if ((e.status === 404 || e.status === 410) && affectsCurrentAccount) { deleted.value = true; stopPolling() }
    message.value = ({
      400: '输入不合法，请按后台提示修改字段。', 401: '登录已失效，请重新登录。',
      403: '当前账户没有媒体管理权限。', 404: '账户不存在或已删除。当前草稿保留为只读。',
      410: '账户已删除。当前草稿保留为只读。',
      409: '配置已被其他页面修改。请重新读取后再编辑，当前修改尚未覆盖服务器。',
      422: '后台未允许此操作。草稿保留，请查看检查结果。',
      503: '后台服务暂不可用。当前修改保留，操作结果需重新读取确认。'
    } as Record<number, string>)[e.status ?? 0] ?? '请求未完成，当前修改保留。请重新读取以确认服务器状态。'
    if ((e.status === 404 || e.status === 410) && !affectsCurrentAccount) message.value = '选中的账户不存在或已删除，请重新读取供应商列表。'
    if (e.message && ![401, 403, 404, 410, 409].includes(e.status ?? 0)) message.value += ` ${e.message}`
  }
  async function loadSuppliers() {
    loading.value = true
    try { suppliers.value = await mediaWorkbenchAPI.suppliers() } catch (e) { failure(e) }
    finally { loading.value = false }
  }
  async function selectSupplier(id: number) {
    if (pending.value) return
    const seq = ++loadSequence
    stopPolling(); loading.value = true; clearError()
    try {
      const dto = await mediaWorkbenchAPI.detail(id)
      if (seq !== loadSequence || disposed) return
      selectedModel.value = ''; selectedProduct.value = ''; deleted.value = false; conflict.value = false
      validationUnavailable.value = false; saveState.value = ''; apply(dto, true)
    } catch (e) { if (seq === loadSequence) failure(e, detail.value?.id === id || !detail.value) }
    finally { if (seq === loadSequence) loading.value = false }
  }
  function selectModel(id: string) {
    selectedModel.value = id
    selectedProduct.value = products.value.find(p => p.upstream_model === id)?.product_id ?? ''
  }
  function addProduct(mediaType: string) {
    if (!selectedModel.value || pending.value || deleted.value || conflict.value) return
    // Identity generation only; no capability or pricing is inferred from the model name.
    const id = `media-${crypto.randomUUID()}`
    products.value.push({ product_id: id, media_type: mediaType, site_model: selectedModel.value, display_name: selectedModel.value,
      upstream_model: selectedModel.value, enabled: true,
      capabilities: { resolutions: [], aspect_ratios: [], qualities: [], durations_seconds: [], count: { min: 1, max: 1 },
        references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] },
      pricing_rules: [], adapter_config: { size_mappings: [] } })
    selectedProduct.value = id
  }
  function pollValidation(id: number, revision: string, seq: number, attempt = 0) {
    pollTimer = setTimeout(async () => {
      if (seq !== validationSequence || disposed || config.value?.draft.revision !== revision || detail.value?.id !== id) return
      try {
        const dto = await mediaWorkbenchAPI.detail(id)
        if (seq !== validationSequence || disposed || detail.value?.id !== id || config.value?.draft.revision !== revision) return
        if (dto.media_workbench_v1?.draft.revision !== revision) {
          conflict.value = true; message.value = '草稿已被其他页面修改，请重新读取。'; return
        }
        apply(dto, false)
        if (['PENDING', 'VALIDATING', 'RUNNING'].includes(dto.media_workbench_v1.validation.status)) {
          if (attempt < 19) pollValidation(id, revision, seq, attempt + 1)
          else validationUnavailable.value = true
        }
      } catch (e) { validationUnavailable.value = true; failure(e) }
    }, 1000)
  }
  async function saveDraft(): Promise<boolean> {
    if (pending.value || loading.value || deleted.value || conflict.value || !config.value || !detail.value) return false
    pending.value = 'save'; saveState.value = 'saving'; clearError(); stopPolling(); validationUnavailable.value = false
    try {
      const dto = await mediaWorkbenchAPI.saveDraft(detail.value.id, config.value.record_version, products.value)
      if (disposed) return false
      apply(dto, true); saveState.value = 'saved'
      const c = dto.media_workbench_v1
      if (c && ['PENDING', 'VALIDATING', 'RUNNING'].includes(c.validation.status)) pollValidation(dto.id, c.draft.revision, validationSequence)
      return true
    } catch (e) { saveState.value = 'unconfirmed'; validationUnavailable.value = true; failure(e); return false }
    finally { pending.value = '' }
  }
  async function publish() {
    if (!canPublish.value || !detail.value || !config.value) return
    pending.value = 'publish'; clearError(); stopPolling()
    const id = detail.value.id
    try {
      const result = await mediaWorkbenchAPI.publish(id, config.value.record_version, config.value.draft.revision)
      // Accept either the editor DTO or the documented revision acknowledgement.
      // One authoritative DTO update refreshes the editor and all list counts.
      apply('media_workbench_v1' in result && result.id === id ? result : await mediaWorkbenchAPI.detail(id), true)
    } catch (e) {
      validationUnavailable.value = true
      failure(e)
      // Phase 2A returns the committed validation and CAS receipt in 422 data.
      // Preserve local edits while adopting that authoritative editor state.
      const receipt = (e as { data?: SupplierDetail }).data
      if (errorStatus.value === 422 && receipt?.id === id && receipt.media_workbench_v1) {
        apply(receipt, false)
        validationUnavailable.value = false
      } else if (errorStatus.value === 422 || errorStatus.value === 503) {
        validationUnavailable.value = true
        try { apply(await mediaWorkbenchAPI.detail(detail.value.id), false) } catch { /* preserve Draft and original error */ }
      }
    } finally { pending.value = '' }
  }
  async function sales(enabled: boolean) {
    if (pending.value || loading.value || deleted.value || conflict.value || !detail.value || !config.value) return
    pending.value = 'sales'; clearError(); stopPolling()
    try { apply(await mediaWorkbenchAPI.sales(detail.value.id, config.value.record_version, enabled), false) }
    catch (e) { failure(e) } finally { pending.value = '' }
  }
  async function sync() {
    if (pending.value || loading.value || deleted.value || conflict.value || !detail.value) return
    pending.value = 'sync'; clearError(); stopPolling()
    const id = detail.value.id
    try {
      await mediaWorkbenchAPI.sync(id)
      const dto = await mediaWorkbenchAPI.detail(id)
      if (dto.media_workbench_v1?.draft.revision !== config.value?.draft.revision) {
        conflict.value = true; message.value = '同步成功，但草稿版本已变化，请重新读取。'
      } else { apply(dto, false); validationUnavailable.value = true }
    } catch (e) {
      failure(e)
      if (![404, 410, 401, 403].includes(errorStatus.value)) message.value = '本次同步失败，仍使用上次成功目录。 ' + message.value
    } finally { pending.value = '' }
  }
  async function initialize(id: number, types: string[]) {
    if (pending.value || loading.value) return false
    pending.value = 'initialize'; clearError()
    try {
      const dto = await mediaWorkbenchAPI.initialize(id, types)
      stopPolling(); deleted.value = false; conflict.value = false; validationUnavailable.value = false; saveState.value = ''
      selectedModel.value = ''; selectedProduct.value = ''; apply(dto, true); return true
    } catch (e) { failure(e); return false } finally { pending.value = '' }
  }
  function discard() { if (detail.value) apply(detail.value, true) }
  onBeforeUnmount(() => { disposed = true; loadSequence++; stopPolling() })
  return { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, loading, message,
    errorStatus, diagnostics, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
    loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, sync, initialize, discard }
}

import { computed, onBeforeUnmount, ref } from 'vue'
import { mediaWorkbenchAPI, draftInput, type Product, type SupplierDetail, type Diagnostic, type LifecycleAction, type LifecycleTarget, type Validation } from '@/api/admin/mediaWorkbench'

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
  const publishValidation = ref<Validation | null>(null)
  const deleted = ref(false)
  const conflict = ref(false)
  const validationUnavailable = ref(false)
  const saveState = ref('')
  const saveFeedback = ref('')
  const publicationFeedback = ref('')
  const salesFeedback = ref('')
  const addedProductIds = ref<string[]>([])
  const removedProducts = ref<Product[]>([])
  let baseline = '[]'
  let loadSequence = 0
  let validationSequence = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const config = computed(() => detail.value?.media_workbench_v1)
  const dirty = computed(() => JSON.stringify(draftInput(products.value).products) !== baseline)
  const product = computed(() => products.value.find(p => p.product_id === selectedProduct.value))
  const validationCurrent = computed(() => !!config.value && config.value.validation.draft_revision === config.value.draft.revision)
  const canPublish = computed(() => !pending.value && !loading.value && !dirty.value && !deleted.value && !conflict.value && saveState.value !== 'unconfirmed' &&
    !!config.value && Number.isInteger(config.value.record_version) && config.value.record_version >= 0 && !!config.value.draft.revision && !!config.value.draft.products.length)
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
      addedProductIds.value = []; removedProducts.value = []
    }
    if (selectedModel.value && !dto.models.some(model => model.model_id === selectedModel.value)) selectedModel.value = ''
    if (!products.value.some(p => p.product_id === selectedProduct.value && p.upstream_model === selectedModel.value)) {
      selectedProduct.value = products.value.find(p => p.upstream_model === selectedModel.value)?.product_id ?? ''
    }
  }
  function clearError() { message.value = ''; errorStatus.value = 0; errorDiagnostics.value = []; publishValidation.value = null }
  function requiresPublishedRecovery(error: unknown) {
    const e = error as { status?: number; reason?: string }
    return e.status === 409 && e.reason === 'MEDIA_PUBLISHED_RECOVERY_REQUIRED'
  }
  function failure(error: unknown, affectsCurrentAccount = true) {
    const e = error as { status?: number; message?: string; metadata?: { diagnostics?: Diagnostic[] } }
    errorStatus.value = e.status ?? 0
    errorDiagnostics.value = e.metadata?.diagnostics ?? []
    if (requiresPublishedRecovery(error)) {
      message.value = '历史已发布配置需先受控校验恢复；没有发布本次草稿。'
      return
    }
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
      validationUnavailable.value = false; saveState.value = dto.media_workbench_v1?.draft.revision ? 'saved' : ''; saveFeedback.value = ''; publicationFeedback.value = ''; salesFeedback.value = ''; apply(dto, true)
    } catch (e) { if (seq === loadSequence) failure(e, detail.value?.id === id || !detail.value) }
    finally { if (seq === loadSequence) loading.value = false }
  }
  function selectModel(id: string) {
    selectedModel.value = id
    selectedProduct.value = products.value.find(p => p.upstream_model === id)?.product_id ?? ''
  }
  function addProduct(mediaType: string, independent = false) {
    if (!selectedModel.value || pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed') return
    const existing = products.value.filter(p => p.upstream_model === selectedModel.value && p.media_type === mediaType)
    const unfinished = existing.find(p => addedProductIds.value.includes(p.product_id))
    if (unfinished || (!independent && existing.length)) {
      selectedProduct.value = (unfinished ?? existing[0])!.product_id
      if (independent) message.value = '已有一份尚未保存的新商品，请先完成或撤销该商品。'
      return
    }
    // Identity generation only; no capability or pricing is inferred from the model name.
    const id = `media-${crypto.randomUUID()}`
    products.value.push({ product_id: id, media_type: mediaType, site_model: selectedModel.value, display_name: selectedModel.value,
      upstream_model: selectedModel.value, enabled: true,
      capabilities: { resolutions: [], aspect_ratios: [], qualities: [], durations_seconds: [], count: mediaType === 'video' ? { min: 1, max: 1 } : { min: 1, max: 10 },
        references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] },
      pricing_rules: [], adapter_config: { size_mappings: [] } })
    addedProductIds.value.push(id)
    selectedProduct.value = id
  }
  function removalReason(p: Product): string {
    if (config.value?.product_lifecycle?.[p.product_id]?.state === 'archived') return '已归档商品保留配置，请先恢复后再管理。'
    if (saveState.value === 'unconfirmed') return '保存结果未确认，请重新读取后再管理商品。'
    if (addedProductIds.value.includes(p.product_id)) return ''
    const permission = detail.value?.product_removal?.[p.product_id]
    if (!permission?.allowed) return permission?.reason || '请重新读取，确认空白草稿的移除条件。'
    const c = p.capabilities
    if (c.resolutions.length || c.aspect_ratios.length || c.qualities.length || c.durations_seconds.length ||
        c.combination_rules.length || p.cost_rules?.some(rule => rule.cost != null || Object.keys(rule.match).length > 0) || p.pricing_rules.some(rule => rule.sale_price != null || Object.values(rule.match).some(value => Array.isArray(value) ? value.length > 0 : value != null)) || Object.values(c.references).some(value =>
          typeof value === 'number' ? value !== 0 : value.min !== 0 || value.max !== 0)) {
      return '已有规格、参考素材要求或价格，不属于空白草稿。'
    }
    return ''
  }
  function removeProduct(id: string) {
    if (pending.value || loading.value || deleted.value || conflict.value) return
    const p = products.value.find(item => item.product_id === id)
    if (!p || removalReason(p)) return
    if (addedProductIds.value.includes(id)) addedProductIds.value = addedProductIds.value.filter(item => item !== id)
    else removedProducts.value.push(clone(p))
    products.value = products.value.filter(item => item.product_id !== id)
    if (selectedProduct.value === id) selectedProduct.value = products.value.find(item => item.upstream_model === selectedModel.value)?.product_id ?? ''
  }
  function undoRemoval(id: string) {
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed') return
    const p = removedProducts.value.find(item => item.product_id === id)
    if (!p) return
    products.value.push(p)
    const order = (config.value?.draft.products ?? []).map(item => item.product_id)
    products.value.sort((a, b) => (order.indexOf(a.product_id) < 0 ? Infinity : order.indexOf(a.product_id)) - (order.indexOf(b.product_id) < 0 ? Infinity : order.indexOf(b.product_id)))
    removedProducts.value = removedProducts.value.filter(item => item.product_id !== id)
    selectedModel.value = p.upstream_model; selectedProduct.value = id
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
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed' || !detail.value) return false
    if (!products.value.length && !removedProducts.value.length) {
      message.value = '请先选择图片或视频产品，再保存草稿。'
      return false
    }
    pending.value = 'save'; saveState.value = 'saving'; saveFeedback.value = '正在保存草稿…'; clearError(); stopPolling(); validationUnavailable.value = false
    const accountId = detail.value.id
    const submitted = JSON.stringify(draftInput(products.value).products)
    const previousVersion = config.value?.record_version ?? 0
    let writeAcknowledged = false
    try {
      // A nil media configuration is initialized atomically by the first explicit
      // SaveDraft. The server infers media_types from the submitted products.
      const args = [detail.value.id, config.value?.record_version ?? 0, products.value] as const
      const dto = removedProducts.value.length
        ? await mediaWorkbenchAPI.saveDraft(...args, removedProducts.value.map(p => p.product_id))
        : await mediaWorkbenchAPI.saveDraft(...args)
      writeAcknowledged = true
      if (disposed) return false
      // Re-read the authoritative persisted draft; never turn a lost response into a retry.
      const confirmed = await mediaWorkbenchAPI.detail(accountId)
      if (confirmed.media_workbench_v1?.draft.revision !== dto.media_workbench_v1?.draft.revision || JSON.stringify(draftInput(confirmed.media_workbench_v1?.draft.products ?? []).products) !== JSON.stringify(draftInput(dto.media_workbench_v1?.draft.products ?? []).products)) throw { status: 0, message: '保存回执与重新读取的版本不一致。' }
      apply(confirmed, true); saveState.value = 'saved'
      saveFeedback.value = `草稿已保存 · ${confirmed.media_workbench_v1?.draft.revision ?? ''}。${confirmed.media_workbench_v1?.validation.status === 'FAIL' ? '暂不能发布，请处理下方缺项。' : '发布前仍由后台检查选中的商品。'}`
      const c = confirmed.media_workbench_v1
      if (c && ['PENDING', 'VALIDATING', 'RUNNING'].includes(c.validation.status)) pollValidation(dto.id, c.draft.revision, validationSequence)
      return true
    } catch (e) {
      // Only a definite rejection of the write itself is safe to correct and
      // resubmit. A readback failure after acknowledgement remains uncertain.
      const rejected = !writeAcknowledged && [400, 422].includes((e as { status?: number }).status ?? 0)
      saveState.value = rejected ? 'failed' : 'unconfirmed'; validationUnavailable.value = true; failure(e)
      if (rejected) {
        saveFeedback.value = '草稿未保存，输入已保留。请修正字段后重新保存。'
        return false
      }
      if (ambiguous(e)) {
        saveFeedback.value = '保存结果未知，正在重新读取核对；不会重发保存请求。'
        try {
          const confirmed = await mediaWorkbenchAPI.detail(accountId)
          if ((confirmed.media_workbench_v1?.record_version ?? 0) > previousVersion && JSON.stringify(draftInput(confirmed.media_workbench_v1?.draft.products ?? []).products) === submitted) {
            apply(confirmed, true); saveState.value = 'saved'; validationUnavailable.value = false; clearError()
            saveFeedback.value = `草稿已保存（已重新读取核对）· ${confirmed.media_workbench_v1?.draft.revision ?? ''}`
            return true
          }
        } catch { /* Keep local input and require an explicit authoritative reload. */ }
      }
      saveFeedback.value = '草稿保存未确认，输入已保留。请重新读取核对实际结果后继续。'
      return false
    }
    finally { pending.value = '' }
  }
  async function publish(productIds: string[]): Promise<boolean> {
    if (!canPublish.value || !detail.value || !config.value) return false
    if (!productIds.length || new Set(productIds).size !== productIds.length || productIds.some(id => !config.value!.draft.products.some(p => p.product_id === id))) {
      message.value = '请明确选择本次要发布的已保存草稿商品。'
      return false
    }
    pending.value = 'publish'; clearError(); stopPolling(); publicationFeedback.value = '正在检查并发布选中的商品…'
    const id = detail.value.id
    const previousRevision = config.value.published?.revision
    const draftRevision = config.value.draft.revision
    const selectedNames = productIds.map(id => config.value!.draft.products.find(p => p.product_id === id)?.display_name || id).join('、')
    try {
      const result = await mediaWorkbenchAPI.publish(id, config.value.record_version, config.value.draft.revision, [...productIds])
      // Accept either the editor DTO or the documented revision acknowledgement.
      // One authoritative DTO update refreshes the editor and all list counts.
      const confirmed = 'media_workbench_v1' in result && result.id === id ? result : await mediaWorkbenchAPI.detail(id)
      const acknowledgedRevision = 'published_revision' in result ? result.published_revision : undefined
      if (!confirmed.media_workbench_v1?.published || (acknowledgedRevision && confirmed.media_workbench_v1.published.revision !== acknowledgedRevision)) throw { status: 0, message: '发布回执与重新读取的版本不一致。' }
      apply(confirmed, true)
      publicationFeedback.value = `${selectedNames} 已发布 · 版本 ${config.value.published?.revision ?? '待读取'}。${config.value.sales.enabled ? 'Account 工作台销售已开启，新版本按已发布范围生效。' : '尚未开启工作台销售，请在账号操作区开启。'}`
      return true
    } catch (e) {
      failure(e)
      publicationFeedback.value = '发布未完成，请查看检查结果；原发布版本继续保留。'
      if (ambiguous(e)) {
        publicationFeedback.value = '发布结果未知，正在重新读取核对；不会重发发布请求。'
        try {
          const confirmed = await mediaWorkbenchAPI.detail(id)
          const published = confirmed.media_workbench_v1?.published
          if (published && published.revision !== previousRevision && published.source_draft_revision === draftRevision && productIds.every(productId => published.products?.some(p => p.product_id === productId && JSON.stringify(draftInput([p]).products) === JSON.stringify(draftInput(products.value.filter(draft => draft.product_id === productId)).products)))) {
            apply(confirmed, true); clearError(); publicationFeedback.value = `${selectedNames} 已发布（已重新读取核对）· 版本 ${published.revision}`
            return true
          }
        } catch { /* Unknown publication never triggers an automatic retry. */ }
        publicationFeedback.value = '发布结果仍未确认，请重新读取实际版本后继续。'
      }
      if (requiresPublishedRecovery(e)) return false
      // A definite selected-product validation rejection did not publish the
      // Draft. Keep other selections available; ambiguous writes require reload.
      validationUnavailable.value = errorStatus.value !== 422
      if (errorStatus.value !== 422) saveState.value = 'unconfirmed'
      const receipt = (e as { data?: SupplierDetail }).data
      if (errorStatus.value === 422 && receipt?.id === id && receipt.media_workbench_v1) {
        apply(receipt, false)
        publishValidation.value = receipt.publish_validation ?? null
        if (publishValidation.value) errorDiagnostics.value = []
      }
      return false
    } finally { pending.value = '' }
  }
  const ambiguous = (error: unknown) => { const status = (error as { status?: number }).status ?? 0; return status === 0 || status === 408 || status >= 500 }
  async function sales(enabled: boolean): Promise<boolean> {
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed' || !detail.value || !config.value) return false
    pending.value = 'sales'; clearError(); stopPolling(); salesFeedback.value = enabled ? '正在开启 Account 工作台销售…' : '正在暂停 Account 工作台销售…'
    const id = detail.value.id, version = config.value.record_version
    try {
      const dto = await mediaWorkbenchAPI.sales(id, version, enabled)
      if (dto.media_workbench_v1?.sales.enabled !== enabled) throw { status: 0 }
      apply(dto, false)
      salesFeedback.value = `Account #${id} 工作台销售已${enabled ? '开启' : '暂停'}（服务端已确认）。`
      return true
    } catch (e) {
      failure(e)
      if (ambiguous(e)) {
        salesFeedback.value = '销售操作结果未知，正在重新读取核对；不会重发操作。'
        try {
          const dto = await mediaWorkbenchAPI.detail(id)
          if ((dto.media_workbench_v1?.record_version ?? 0) > version && dto.media_workbench_v1?.sales.enabled === enabled) {
            apply(dto, false); clearError(); salesFeedback.value = `Account #${id} 工作台销售已${enabled ? '开启' : '暂停'}（已重新读取核对）。`; return true
          }
        } catch { /* Keep the dialog and previous confirmed status visible. */ }
        saveState.value = 'unconfirmed'
      }
      salesFeedback.value = '销售操作失败或结果未确认，请保留此窗口并重新读取实际状态。'
      return false
    } finally { pending.value = '' }
  }
  async function lifecycle(action: LifecycleAction, target: LifecycleTarget): Promise<boolean> {
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed' || !detail.value) return false
    if (dirty.value) { message.value = '请先保存或放弃未保存修改，再管理上下架与归档。'; return false }
    pending.value = 'lifecycle'; clearError(); stopPolling()
    try {
      const dto = await mediaWorkbenchAPI.lifecycle(detail.value.id, config.value?.record_version ?? 0, action, target)
      if (disposed) return false
      apply(dto, true)
      return true
    } catch (e) {
      failure(e)
      if (![401, 403, 404, 409, 410, 422].includes(errorStatus.value)) {
        saveState.value = 'unconfirmed'; validationUnavailable.value = true
      }
      return false
    } finally { pending.value = '' }
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
  function discard() { if (detail.value) apply(detail.value, true) }
  onBeforeUnmount(() => { disposed = true; loadSequence++; stopPolling() })
  return { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, loading, message,
    errorStatus, diagnostics, publishValidation, saveFeedback, publicationFeedback, salesFeedback, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
    addedProductIds, removedProducts, removalReason, removeProduct, undoRemoval,
    loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, lifecycle, sync, discard }
}

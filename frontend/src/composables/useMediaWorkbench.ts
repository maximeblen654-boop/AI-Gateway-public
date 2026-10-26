import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { mediaWorkbenchAPI, draftInput, type Product, type SupplierDetail, type Diagnostic, type LifecycleAction, type LifecycleTarget, type Validation, type ModelBindingInput } from '@/api/admin/mediaWorkbench'
import { draftFingerprint, videoSaleInputsFingerprint, persistedFingerprint, confirmedRecoveryProduct, recoveryDifferences, recoveryKey, recoveryCopyKey, listDraftRecoveries, MAX_ACCOUNT_RECOVERIES, readDraftRecovery, encodeDraftRecovery, type DraftRecovery, type RecoveryEntry, type RecoveryIdentity } from './draftRecovery'
import type { VideoSaleInput } from '@/components/admin/media/videoSaleGroups'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function useMediaWorkbench(adminId: () => number | undefined = () => undefined) {
  const suppliers = ref<SupplierDetail[]>([])
  const detail = ref<SupplierDetail | null>(null)
  const products = ref<Product[]>([])
  const selectedModel = ref('')
  const selectedProduct = ref('')
  const pending = ref('')
  const autoSavePaused = ref(false)
  const loading = ref(false)
  const loadingAccountId = ref<number | null>(null)
  const message = ref('')
  const errorStatus = ref(0)
  const errorDiagnostics = ref<Diagnostic[]>([])
  const publishValidation = ref<Validation | null>(null)
  const bindingValidationProducts = ref<Product[]>([])
  const bindingValidationModel = ref('')
  const deleted = ref(false)
  const conflict = ref(false)
  const validationUnavailable = ref(false)
  const saveState = ref<'unsaved' | 'saving' | 'saved' | 'failed' | 'unconfirmed' | 'conflict'>('unsaved')
  const recovery = ref<DraftRecovery | null>(null)
  const recoveryEntries = ref<RecoveryEntry[]>([])
  const selectedRecoveryKey = ref('')
  const unresolvedProductConflicts = ref<string[]>([])
  const editorId = crypto.randomUUID()
  const ownedRecoveries = new Map<string, RecoveryEntry>()
  const adoptedRecoveries = new Map<string, RecoveryEntry>()
  const recoveryWarning = ref('')
  const serverSnapshot = ref<SupplierDetail | null>(null)
  const online = ref(typeof navigator === 'undefined' || navigator.onLine)
  const saveFeedback = ref('')
  const publicationFeedback = ref('')
  const salesFeedback = ref('')
  const addedProductIds = ref<string[]>([])
  const removedProducts = ref<Product[]>([])
  const pendingVideoInputs = ref<Record<string, VideoSaleInput[]>>({})
  const baseline = ref('[]')
  let applying = false
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined
  let queuedSave = false
  let rejectedInput = ''
  type Submission = { id: string; base: number; products: Product[]; removed: string[]; recoveryKeys: Map<string, string>; recoveryCopies: Map<string, string | null>; adopted: Map<string, RecoveryEntry> }
  let lastSubmission: Submission | undefined
  const retryCheck = ref<{ accountId: number; submissionId: string; base: number; revision: string } | null>(null)
  let loadSequence = 0
  let validationSequence = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const config = computed(() => detail.value?.media_workbench_v1)
  const committedDirty = computed(() => draftFingerprint(products.value) !== baseline.value)
  const hasPendingVideoSales = computed(() => Object.values(pendingVideoInputs.value).some(inputs => inputs.length > 0))
  const videoSaleInputs = computed(() => pendingVideoInputs.value[selectedProduct.value] ?? [])
  const dirty = computed(() => committedDirty.value || hasPendingVideoSales.value)
  const canRetryUnconfirmedSave = computed(() => saveState.value === 'unconfirmed' && !!retryCheck.value && online.value && !pending.value && !loading.value && !deleted.value && !conflict.value)
  const product = computed(() => products.value.find(p => p.product_id === selectedProduct.value))
  const validationCurrent = computed(() => !!config.value && config.value.validation.draft_revision === config.value.draft.revision)
  const canPublish = computed(() => !pending.value && !loading.value && !dirty.value && !deleted.value && !conflict.value && saveState.value !== 'unconfirmed' &&
    !!config.value && Number.isInteger(config.value.record_version) && config.value.record_version >= 0 && !!config.value.draft.revision && !!config.value.draft.products.length)
  const diagnostics = computed(() => errorDiagnostics.value.length ? errorDiagnostics.value : validationCurrent.value ? config.value?.validation.diagnostics ?? [] : [])
  const recoveryConflict = computed(() => !!recovery.value && (unresolvedProductConflicts.value.includes(recovery.value.product.product_id) || recovery.value.base_record_version !== (serverSnapshot.value ?? detail.value)?.media_workbench_v1?.record_version || recovery.value.base_draft_revision !== ((serverSnapshot.value ?? detail.value)?.media_workbench_v1?.draft.revision ?? '')))
  const recoveryDiff = computed(() => {
    if (!recovery.value) return []
    const differences = recoveryDifferences(recovery.value.product, (serverSnapshot.value ?? detail.value)?.media_workbench_v1?.draft.products.find(p => p.product_id === recovery.value!.identity.product_id))
    if (recovery.value.video_sale_inputs?.length) differences.push({ field: 'video_sale_inputs', label: '尚未应用的售价输入', local: recovery.value.video_sale_inputs.slice(0, 3).map(({ resolution, duration, amount }) => `${resolution} · ${duration}秒：${amount || '尚未填写'}`).join('；').slice(0, 160) + (recovery.value.video_sale_inputs.length > 3 ? '…' : ''), server: '这些输入尚未应用到服务器草稿。' })
    return differences
  })

  const productRecoveries = computed(() => recoveryEntries.value.filter(entry => entry.value.product.product_id === selectedProduct.value))
  // A buffer written by this live editor is normal autosave progress. It still
  // persists exactly as before; only foreign, failed or divergent copies need
  // the recovery decision UI. Never infer ownership from editor_id alone.
  const recoveryIsCurrentBuffer = computed(() => {
    const current = recovery.value, editing = product.value
    if (!current || !editing || !online.value || conflict.value || recoveryConflict.value || recoveryWarning.value ||
        !['unsaved', 'saving', 'saved'].includes(saveState.value)) return false
    const owned = ownedRecoveries.get(editing.product_id)
    return !!owned && selectedRecoveryKey.value === owned.key && current.copy_id === owned.value.copy_id &&
      productRecoveries.value.length === 1 && productRecoveries.value[0]?.raw === owned.raw &&
      draftFingerprint([current.product]) === draftFingerprint([editing]) &&
      videoSaleInputsFingerprint(current.video_sale_inputs ?? []) === videoSaleInputsFingerprint(videoSaleInputs.value)
  })
  const unsubmittedRecoveries = computed(() => recoveryEntries.value.filter(entry => !entry.value.removed_product && entry.value.identity.upstream_model === selectedModel.value &&
    !products.value.some(p => p.product_id === entry.value.product.product_id) && (entry.value.new_product === true ||
      entry.value.base_record_version === (config.value?.record_version ?? 0) && entry.value.base_draft_revision === (config.value?.draft.revision ?? '') &&
      /^media-[a-f0-9-]{36}$/i.test(entry.value.product.product_id) && !config.value?.published?.products?.some(p => p.product_id === entry.value.product.product_id))))
  function identity(p: Product): RecoveryIdentity | undefined {
    if (!detail.value) return
    const owned = ownedRecoveries.get(p.product_id)?.value.identity
    if (owned?.account_id === detail.value.id && owned.admin_id === adminId()) return owned
    const original = config.value?.draft.products.find(item => item.product_id === p.product_id) ?? p
    const value = { admin_id: adminId() ?? 0, account_id: detail.value.id, product_id: p.product_id, site_model: original.site_model, upstream_model: original.upstream_model }
    return recoveryKey(value) ? value : undefined
  }
  function refreshRecoveryEntries() {
    if (!detail.value || !Number.isSafeInteger(adminId()) || (adminId() ?? 0) <= 0) { recoveryEntries.value = []; return }
    const result = listDraftRecoveries(localStorage, adminId()!, detail.value.id)
    recoveryEntries.value = result.entries
    if (result.invalid) recoveryWarning.value = '部分浏览器恢复副本不可用或已损坏，未自动恢复任何内容。'
  }
  function persistRecovery() {
    if (applying) return
    // Removal is an edit even when no selected Product remains. Keep each
    // tombstone in this page's existing independently owned recovery slot.
    for (const removed of removedProducts.value) if (!persistProductRecovery(removed, true)) return
    if (product.value) persistProductRecovery(product.value)
  }
  function persistProductRecovery(p: Product, removed = false): boolean {
    const videoInputs = pendingVideoInputs.value[p.product_id] ?? []
    const submitted = lastSubmission?.products.find(item => item.product_id === p.product_id) ??
      (removed && lastSubmission?.removed.includes(p.product_id) ? p : undefined)
    const changedAfterSubmission = !!submitted && draftFingerprint([submitted]) !== draftFingerprint([p])
    if (!removed) {
      const original = config.value?.draft.products.find(item => item.product_id === p.product_id)
      if (original && draftFingerprint([original]) === draftFingerprint([p]) && !changedAfterSubmission && !videoInputs.length) {
        // An explicit edit back to the confirmed baseline supersedes only this
        // page's previous buffer. Unknown/in-flight submissions stay protected.
        const own = ownedRecoveries.get(p.product_id)
        if (!lastSubmission && saveState.value !== 'unconfirmed' && !conflict.value && own && !own.value.pending_submission) {
          clearRecovery(p.product_id, own.key, undefined, own.raw)
        }
        return true
      }
      if (!dirty.value && !changedAfterSubmission && !videoInputs.length) return true
    }
    const bound = identity(p)
    if (!bound) { recoveryWarning.value = '当前管理员或商品身份尚未确认，浏览器恢复副本不可用；请保留此页。'; return false }
    try {
      const previous = ownedRecoveries.get(p.product_id)
      refreshRecoveryEntries()
      // The page owns a stable editor key. A foreign rewrite of even that key
      // must never be silently overwritten; preserve both as separate copies.
      let writeEditor = previous?.value.editor_id ?? editorId
      let writeKey = recoveryCopyKey(bound, writeEditor)!
      if (localStorage.getItem(writeKey) !== null && localStorage.getItem(writeKey) !== previous?.raw) {
        writeEditor = crypto.randomUUID(); writeKey = recoveryCopyKey(bound, writeEditor)!
      }
      if (!localStorage.getItem(writeKey) && recoveryEntries.value.length >= MAX_ACCOUNT_RECOVERIES) {
        recoveryWarning.value = '此 Account 的浏览器恢复副本已达 32 份上限；请核对并明确丢弃旧副本。当前新输入仅保留在本页。'; return false
      }
      const unresolvedBase = unresolvedProductConflicts.value.includes(p.product_id)
        ? previous?.value ?? (recovery.value?.product.product_id === p.product_id ? recovery.value : undefined) : undefined
      const value: DraftRecovery = { version: 1, identity: bound, editor_id: writeEditor,
        new_product: addedProductIds.value.includes(p.product_id), ...(removed ? { removed_product: true } : {}), base_record_version: unresolvedBase?.base_record_version ?? config.value?.record_version ?? 0,
        base_draft_revision: unresolvedBase?.base_draft_revision ?? config.value?.draft.revision ?? '', updated_at: Date.now(), copy_id: crypto.randomUUID(), product: p,
        ...(videoInputs.length ? { video_sale_inputs: videoInputs } : {}),
        ...(lastSubmission && submitted ? { pending_submission: { submission_id: lastSubmission.id, base_record_version: lastSubmission.base, product: submitted } } : recovery.value?.product.product_id === p.product_id && recovery.value.pending_submission && saveState.value === 'unconfirmed' ? { pending_submission: recovery.value.pending_submission } : {}) }
      const raw = encodeDraftRecovery(value)
      localStorage.setItem(writeKey, raw)
      const entry = { key: writeKey, raw, value: readDraftRecovery(raw, bound)! }
      ownedRecoveries.set(p.product_id, entry)
      selectedRecoveryKey.value = writeKey; recovery.value = entry.value; recoveryWarning.value = ''
      refreshRecoveryEntries()
      return true
    } catch { recoveryWarning.value = '浏览器恢复副本写入失败（可能空间不足或存储被禁用）。当前输入仍在本页，请保留此页。'; return false }
  }
  function discoverRecovery() {
    recovery.value = null
    try {
      refreshRecoveryEntries()
      // A matching server receipt, complete payload and raw-copy CAS prove
      // this exact historical write was persisted; version equality alone does not.
      const verified = serverSnapshot.value ?? detail.value
      if (verified && !lastSubmission) for (const entry of [...recoveryEntries.value]) {
        if (encodeDraftRecovery(entry.value) === entry.raw && confirmedRecoveryProduct(entry.value, verified)) clearRecovery(entry.value.identity.product_id, entry.key, undefined, entry.raw)
      }
      if (!product.value) {
        const preview = recoveryEntries.value.find(entry => entry.key === selectedRecoveryKey.value && entry.value.identity.upstream_model === selectedModel.value)
        if (preview) recovery.value = preview.value
        return
      }
      const choices = productRecoveries.value
      const owned = ownedRecoveries.get(product.value.product_id)
      const entry = choices.find(e => e.key === selectedRecoveryKey.value) ?? choices.find(e => e.key === owned?.key) ?? choices[0]
      if (entry) { recovery.value = entry.value; selectedRecoveryKey.value = entry.key }
    } catch { recoveryWarning.value = '浏览器恢复副本不可用或已损坏，未自动恢复任何内容。' }
  }
  function chooseRecovery(key: string) {
    const entry = recoveryEntries.value.find(item => item.key === key)
    if (!entry) return
    const p = products.value.find(item => item.product_id === entry.value.product.product_id)
    // Selecting a copy is a preview, not an edit that rewrites its tombstone.
    applying = true
    selectedModel.value = entry.value.identity.upstream_model
    selectedProduct.value = p?.product_id ?? ''
    applying = false
    selectedRecoveryKey.value = key; recovery.value = entry.value
  }
  function clearRecovery(productId: string, key: string, expected: string | undefined, expectedCopy: string | null | undefined): boolean {
    if (!expectedCopy || !detail.value) return false
    try {
      // Maps can retain a same-ID Product from another Account/admin. Every
      // consumption path must prove ownership before even the raw-text bypass.
      const bound = (JSON.parse(expectedCopy) as DraftRecovery).identity
      if (bound?.admin_id !== adminId() || bound.account_id !== detail.value.id || bound.product_id !== productId) return false
      const value = readDraftRecovery(expectedCopy, bound)!
      if (key !== (value.editor_id ? recoveryCopyKey(bound, value.editor_id) : recoveryKey(bound))) return false
      if (localStorage.getItem(key) !== expectedCopy) return false
      if (expected !== undefined && draftFingerprint([value.product]) !== expected) return false
      localStorage.removeItem(key)
      for (const [id, entry] of ownedRecoveries) if (entry.key === key && entry.raw === expectedCopy) ownedRecoveries.delete(id)
      for (const [id, entry] of adoptedRecoveries) if (entry.key === key && entry.raw === expectedCopy) adoptedRecoveries.delete(id)
      if (selectedRecoveryKey.value === key) { recovery.value = null; selectedRecoveryKey.value = '' }
      refreshRecoveryEntries(); return true
    } catch { recoveryWarning.value = '浏览器恢复副本未能清除，请在下次打开时核对版本后处理。'; return false }
  }
  function currentOwnedRecovery(): RecoveryEntry | undefined {
    const entry = ownedRecoveries.get(selectedProduct.value)
    return entry && entry.value.identity.product_id === selectedProduct.value && entry.value.identity.account_id === detail.value?.id && entry.value.identity.admin_id === adminId() ? entry : undefined
  }
  function updateVideoSaleInputs(inputs: VideoSaleInput[]) {
    const p = product.value
    if (!p || p.media_type !== 'video') return
    pendingVideoInputs.value = { ...pendingVideoInputs.value, [p.product_id]: clone(inputs) }
    if (saveState.value !== 'unconfirmed' && !conflict.value && pending.value !== 'save') saveState.value = 'unsaved'
    clearTimeout(autoSaveTimer)
    const owned = currentOwnedRecovery()
    if (!inputs.length && !committedDirty.value && !lastSubmission && owned?.value.video_sale_inputs?.length) clearRecovery(p.product_id, owned.key, undefined, owned.raw)
    else persistProductRecovery(p)
    if (!inputs.length) scheduleSave()
  }
  function scheduleSave() {
    clearTimeout(autoSaveTimer)
    if (autoSavePaused.value || applying || hasPendingVideoSales.value || !dirty.value || !online.value || conflict.value || deleted.value || saveState.value === 'unconfirmed') return
    autoSaveTimer = setTimeout(() => { void flushAutoSave() }, 1500)
  }
  async function flushAutoSave() {
    clearTimeout(autoSaveTimer)
    if (autoSavePaused.value || hasPendingVideoSales.value || !dirty.value || !online.value || conflict.value || deleted.value || saveState.value === 'unconfirmed') return false
    // A step/blur event is not an explicit retry of an unchanged rejected input.
    if (rejectedInput === draftFingerprint(products.value)) return false
    if (pending.value || loading.value) { queuedSave = true; return false }
    return saveDraft()
  }
  // Leave confirmation owns this pause. Explicit saveDraft remains available
  // for "save and leave"; cancelling starts a fresh debounce for current input.
  watch(autoSavePaused, paused => { if (paused) clearTimeout(autoSaveTimer); else scheduleSave() }, { flush: 'sync' })
  watch(products, () => {
    if (applying) return
    if (saveState.value !== 'unconfirmed' && !conflict.value && pending.value !== 'save') saveState.value = 'unsaved'
    if (pending.value !== 'save') saveFeedback.value = ''
    persistRecovery(); scheduleSave()
  }, { deep: true, flush: 'sync' })
  watch(selectedProduct, () => { discoverRecovery(); if (dirty.value) persistRecovery() }, { flush: 'sync' })
  watch(adminId, () => { adoptedRecoveries.clear(); discoverRecovery() })

  function stopPolling() { validationSequence++; clearTimeout(pollTimer) }
  function apply(dto: SupplierDetail, replaceDraft: boolean) {
    detail.value = dto
    const index = suppliers.value.findIndex(s => s.id === dto.id)
    if (index >= 0) suppliers.value[index] = dto
    else suppliers.value.push(dto)
    if (replaceDraft) {
      applying = true
      products.value = clone(draftInput(dto.media_workbench_v1?.draft.products ?? []).products)
      baseline.value = draftFingerprint(products.value)
      addedProductIds.value = []; removedProducts.value = []
      applying = false
    }
    if (selectedModel.value && !dto.models.some(model => model.model_id === selectedModel.value)) selectedModel.value = ''
    if (!products.value.some(p => p.product_id === selectedProduct.value && p.upstream_model === selectedModel.value)) {
      selectedProduct.value = products.value.find(p => p.upstream_model === selectedModel.value)?.product_id ?? ''
    }
    if (replaceDraft) discoverRecovery()
  }
  function clearError() { message.value = ''; errorStatus.value = 0; errorDiagnostics.value = []; publishValidation.value = null; bindingValidationProducts.value = []; bindingValidationModel.value = '' }
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
    if (e.status === 409) { conflict.value = true; saveState.value = 'conflict'; stopPolling() }
    if ((e.status === 404 || e.status === 410) && affectsCurrentAccount) { deleted.value = true; stopPolling() }
    message.value = ({
      400: '输入不合法，请按后台提示修改字段。', 401: '登录已失效，请重新登录。',
      403: '当前账户没有媒体管理权限。', 404: '账户不存在或已删除。当前草稿保留为只读。',
      410: '账户已删除。当前草稿保留为只读。',
      409: '配置已被其他页面修改。请核对服务器与本地差异，当前输入已保留。',
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
  async function selectSupplier(id: number, discardConfirmed = false): Promise<boolean> {
    if (pending.value) return false
    if (!discardConfirmed && detail.value?.id === id && (dirty.value || saveState.value === 'unconfirmed' || conflict.value)) return await checkServer() && detail.value?.id === id && !disposed
    if (!discardConfirmed) persistRecovery()
    clearTimeout(autoSaveTimer)
    const seq = ++loadSequence
    stopPolling(); loading.value = true; loadingAccountId.value = id; clearError()
    try {
      const dto = await mediaWorkbenchAPI.detail(id)
      if (seq !== loadSequence || disposed) return false
      if (dto.id !== id) { message.value = '读取的账号与所选 Account 不一致，请重试。'; return false }
      adoptedRecoveries.clear() // Stop adoption tracking; keep the stored source copies.
      selectedModel.value = ''; selectedProduct.value = ''; deleted.value = false; conflict.value = false; unresolvedProductConflicts.value = []
      pendingVideoInputs.value = {}
      lastSubmission = undefined; retryCheck.value = null; rejectedInput = ''; serverSnapshot.value = null
      validationUnavailable.value = false; saveState.value = dto.media_workbench_v1?.draft.revision ? 'saved' : 'unsaved'; saveFeedback.value = ''; publicationFeedback.value = ''; salesFeedback.value = ''; apply(dto, true)
      return true
    } catch (e) { if (seq === loadSequence && !disposed) failure(e, detail.value?.id === id || !detail.value); return false }
    finally { if (seq === loadSequence) { loading.value = false; loadingAccountId.value = null } }
  }
  function selectModel(id: string) {
    selectedModel.value = id
    selectedProduct.value = products.value.find(p => p.upstream_model === id)?.product_id ?? ''
  }
  function addProduct(mediaType: string, independent = false) {
    if (!selectedModel.value || pending.value || loading.value || deleted.value || conflict.value) return
    const existing = products.value.filter(p => p.upstream_model === selectedModel.value && p.media_type === mediaType)
    const unfinished = existing.find(p => addedProductIds.value.includes(p.product_id))
    if (unfinished || (!independent && existing.length)) {
      selectedProduct.value = (unfinished ?? existing[0])!.product_id
      if (independent) message.value = '已有一份尚未保存的新商品，请先完成或撤销该商品。'
      return
    }
    if (!detail.value?.model_catalog?.models.includes(selectedModel.value)) {
      message.value = '此型号已不在上游当前目录中，不能另建新商品；原配置和历史记录仍保留。'
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
  function removalReason(p: Product, source = detail.value): string {
    if (source?.media_workbench_v1?.product_lifecycle?.[p.product_id]?.state === 'archived') return '已归档商品保留配置，请先恢复后再管理。'
    if (saveState.value === 'unconfirmed') return '保存结果未确认，请重新读取后再管理商品。'
    if (addedProductIds.value.includes(p.product_id)) return ''
    const permission = source?.product_removal?.[p.product_id]
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
    if (addedProductIds.value.includes(id)) {
      addedProductIds.value = addedProductIds.value.filter(item => item !== id)
      const owned = ownedRecoveries.get(id), adopted = adoptedRecoveries.get(id)
      if (owned) clearRecovery(id, owned.key, undefined, owned.raw)
      if (adopted) clearRecovery(id, adopted.key, undefined, adopted.raw)
    }
    else removedProducts.value.push(clone(p))
    delete pendingVideoInputs.value[id]
    products.value = products.value.filter(item => item.product_id !== id)
    if (selectedProduct.value === id) selectedProduct.value = products.value.find(item => item.upstream_model === selectedModel.value)?.product_id ?? ''
  }
  function undoRemoval(id: string) {
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed') return
    const p = removedProducts.value.find(item => item.product_id === id)
    if (!p) return
    removedProducts.value = removedProducts.value.filter(item => item.product_id !== id)
    clearRemovalRecoveries(id)
    delete pendingVideoInputs.value[id]
    products.value.push(p)
    const order = (config.value?.draft.products ?? []).map(item => item.product_id)
    products.value.sort((a, b) => (order.indexOf(a.product_id) < 0 ? Infinity : order.indexOf(a.product_id)) - (order.indexOf(b.product_id) < 0 ? Infinity : order.indexOf(b.product_id)))
    selectedModel.value = p.upstream_model; selectedProduct.value = id
  }
  function clearRemovalRecoveries(id?: string) {
    for (const entry of [...ownedRecoveries.values(), ...adoptedRecoveries.values()]) {
      if (entry.value.removed_product && (id === undefined || entry.value.identity.product_id === id) &&
          entry.value.identity.account_id === detail.value?.id && entry.value.identity.admin_id === adminId()) clearRecovery(entry.value.identity.product_id, entry.key, undefined, entry.raw)
    }
  }
  function pollValidation(id: number, revision: string, seq: number, attempt = 0) {
    pollTimer = setTimeout(async () => {
      if (seq !== validationSequence || disposed || config.value?.draft.revision !== revision || detail.value?.id !== id) return
      try {
        const dto = await mediaWorkbenchAPI.detail(id)
        if (seq !== validationSequence || disposed || detail.value?.id !== id || config.value?.draft.revision !== revision) return
        if (dto.media_workbench_v1?.draft.revision !== revision) {
          conflict.value = true; saveState.value = 'conflict'; message.value = '草稿已被其他页面修改，请核对服务器状态。'; return
        }
        apply(dto, false)
        if (['PENDING', 'VALIDATING', 'RUNNING'].includes(dto.media_workbench_v1.validation.status)) {
          if (attempt < 19) pollValidation(id, revision, seq, attempt + 1)
          else validationUnavailable.value = true
        }
      } catch (e) { validationUnavailable.value = true; failure(e) }
    }, 1000)
  }
  function diagnostic(stage: string, submission: Submission, dto?: SupplierDetail, error?: unknown) {
    // Deliberately omit request/response bodies, business values and credentials.
    console.warn('[media-workbench-save]', { submission_id: submission.id, base_record_version: submission.base,
      response_record_version: dto?.media_workbench_v1?.record_version, http_status: (error as { status?: number })?.status ?? 0, stage })
  }
  function receiptMatches(dto: SupplierDetail, submission: Submission): boolean {
    const c = dto.media_workbench_v1, receipt = c?.draft.save_receipt
    return dto.id === detail.value?.id && !!receipt && receipt.submission_id === submission.id && receipt.base_record_version === submission.base &&
      receipt.draft_revision === c!.draft.revision && c!.record_version > submission.base &&
      persistedFingerprint(submission.products, dto) === draftFingerprint(c!.draft.products)
  }
  function confirmSave(dto: SupplierDetail, submission: Submission, reconciled = false): boolean {
    if (!receiptMatches(dto, submission) || disposed) return false
    retryCheck.value = null
    rejectedInput = ''
    const unchanged = !hasPendingVideoSales.value && draftFingerprint(products.value) === draftFingerprint(submission.products)
    const local = clone(products.value)
    apply(dto, unchanged)
    baseline.value = draftFingerprint(dto.media_workbench_v1!.draft.products)
    if (!unchanged) {
      applying = true; products.value = local; applying = false
      // The confirmed write is the new CAS baseline. Keep subsequent edits.
      saveState.value = 'unsaved'; saveFeedback.value = '上一版输入已确认保存，较新的修改正在等待同步。'
      addedProductIds.value = addedProductIds.value.filter(id => !submission.products.some(p => p.product_id === id))
      removedProducts.value = removedProducts.value.filter(p => !submission.removed.includes(p.product_id))
    } else {
      saveState.value = 'saved'
      saveFeedback.value = `草稿已确认保存${reconciled ? '（已重新读取核对）' : ''}。${dto.media_workbench_v1!.validation.status === 'FAIL' ? '暂不能发布，请处理下方缺项。' : '发布前仍由后台检查选中的商品。'}`
    }
    for (const p of submission.products) {
      const key = submission.recoveryKeys.get(p.product_id)
      if (key) clearRecovery(p.product_id, key, draftFingerprint([p]), submission.recoveryCopies.get(p.product_id) ?? null)
      const adopted = submission.adopted.get(p.product_id)
      // The source was explicitly adopted before this submission. Subsequent
      // edits legitimately supersede it; do not compare source with final input.
      // Full identity and exact raw-copy CAS still protect every other copy.
      if (adopted) clearRecovery(p.product_id, adopted.key, undefined, adopted.raw)
    }
    for (const id of submission.removed) {
      const key = submission.recoveryKeys.get(id)
      if (key) clearRecovery(id, key, undefined, submission.recoveryCopies.get(id))
      const adopted = submission.adopted.get(id)
      if (adopted?.value.removed_product) clearRecovery(id, adopted.key, undefined, adopted.raw)
    }
    lastSubmission = undefined; if (recovery.value) delete recovery.value.pending_submission
    serverSnapshot.value = null; conflict.value = unresolvedProductConflicts.value.length > 0; validationUnavailable.value = false; clearError()
    if (!unchanged) { persistRecovery(); queuedSave = true }
    else discoverRecovery()
    const c = dto.media_workbench_v1!
    if (['PENDING', 'VALIDATING', 'RUNNING'].includes(c.validation.status)) pollValidation(dto.id, c.draft.revision, validationSequence)
    return true
  }
  async function saveDraft(): Promise<boolean> {
    clearTimeout(autoSaveTimer)
    if (hasPendingVideoSales.value) { persistRecovery(); saveFeedback.value = '售价输入尚未应用草稿，本地输入已保留。请完成或修正输入后再保存。'; return false }
    if (pending.value || loading.value || deleted.value || conflict.value || saveState.value === 'unconfirmed' || !detail.value) { if (pending.value === 'save' && dirty.value) queuedSave = true; return false }
    if (!online.value) { persistRecovery(); saveState.value = 'unsaved'; saveFeedback.value = '当前离线，输入已保留在本地；联网后先核对服务器版本。'; return false }
    if (!products.value.length && !removedProducts.value.length) {
      message.value = '请先选择图片或视频产品，再保存草稿。'; return false
    }
    retryCheck.value = null
    const submission: Submission = { id: crypto.randomUUID(), base: config.value?.record_version ?? 0,
      products: clone(draftInput(products.value).products), removed: removedProducts.value.map(p => p.product_id), recoveryKeys: new Map(), recoveryCopies: new Map(), adopted: new Map() }
    for (const p of submission.products) {
      const original = config.value?.draft.products.find(item => item.product_id === p.product_id)
      if (original && draftFingerprint([original]) === draftFingerprint([p])) continue
      const owned = ownedRecoveries.get(p.product_id); if (owned) submission.recoveryKeys.set(p.product_id, owned.key)
    }
    // Freeze adoption ownership before the request; never read a later page's
    // tracking Map when an old response arrives.
    for (const [id, entry] of adoptedRecoveries) {
      const identity = entry.value.identity
      const original = config.value?.draft.products.find(p => p.product_id === id)
      if (identity.admin_id === adminId() && identity.account_id === detail.value.id && identity.product_id === id &&
          (!original || original.site_model === identity.site_model && original.upstream_model === identity.upstream_model) &&
          (submission.products.some(p => p.product_id === id) || submission.removed.includes(id))) submission.adopted.set(id, clone(entry))
    }
    lastSubmission = submission; queuedSave = false; persistRecovery()
    for (const p of submission.products) { const owned = ownedRecoveries.get(p.product_id); if (owned && submission.recoveryKeys.has(p.product_id)) submission.recoveryKeys.set(p.product_id, owned.key) }
    for (const id of submission.removed) { const owned = ownedRecoveries.get(id); if (owned?.value.removed_product) submission.recoveryKeys.set(id, owned.key) }
    try { for (const [id, key] of submission.recoveryKeys) submission.recoveryCopies.set(id, localStorage.getItem(key)) } catch { /* The visible storage warning is set by persistRecovery. */ }
    pending.value = 'save'; saveState.value = 'saving'; saveFeedback.value = '正在保存草稿…'; clearError(); stopPolling(); validationUnavailable.value = false
    const accountId = detail.value.id
    let writeAcknowledged = false
    let response: SupplierDetail | undefined
    try {
      response = await mediaWorkbenchAPI.saveDraft(accountId, submission.base, submission.products, submission.removed, submission.id)
      writeAcknowledged = true
      if (disposed) return false
      const confirmed = await mediaWorkbenchAPI.detail(accountId)
      serverSnapshot.value = confirmed
      if (!receiptMatches(response, submission) || !receiptMatches(confirmed, submission) || response.media_workbench_v1!.draft.revision !== confirmed.media_workbench_v1!.draft.revision) {
        diagnostic('receipt_mismatch', submission, confirmed)
        const foreign = confirmed.media_workbench_v1?.draft.save_receipt
        if (foreign && foreign.submission_id !== submission.id && (confirmed.media_workbench_v1?.record_version ?? 0) > submission.base) {
          conflict.value = true; saveState.value = 'conflict'; message.value = '服务器已保存其他页面的版本，当前输入与恢复副本已保留。'
        } else saveState.value = 'unconfirmed'
        saveFeedback.value = '保存回执、服务器版本或提交内容不一致，尚未确认保存。请核对服务器状态。'
        persistRecovery(); return false
      }
      return confirmSave(confirmed, submission)
    } catch (e) {
      diagnostic(writeAcknowledged ? 'readback_failed' : 'write_failed', submission, response, e)
      const status = (e as { status?: number }).status ?? 0
      const rejected = !writeAcknowledged && status >= 400 && status < 500 && status !== 408 && status !== 409
      failure(e); validationUnavailable.value = true
      if (status === 409) {
        saveState.value = 'conflict'; saveFeedback.value = '服务器版本冲突，输入与恢复副本已保留；请核对差异。'; persistRecovery(); return false
      }
      saveState.value = rejected ? 'failed' : 'unconfirmed'
      if (rejected) {
        rejectedInput = draftFingerprint(submission.products)
        lastSubmission = undefined; persistRecovery(); saveFeedback.value = '草稿未保存，输入已保留。请修正字段后重新保存。'; return false
      }
      if (ambiguous(e)) {
        saveFeedback.value = '保存结果未知，正在读取核对；不会重发保存请求。'
        try {
          const confirmed = await mediaWorkbenchAPI.detail(accountId)
          serverSnapshot.value = confirmed
          if ((!response || receiptMatches(response, submission)) && confirmSave(confirmed, submission, true)) return true
          if (confirmed.media_workbench_v1?.draft.save_receipt && confirmed.media_workbench_v1.draft.save_receipt.submission_id !== submission.id && confirmed.media_workbench_v1.record_version > submission.base) {
            conflict.value = true; saveState.value = 'conflict'
          }
          diagnostic('reconcile_mismatch', submission, confirmed)
        } catch (readError) { diagnostic('reconcile_failed', submission, undefined, readError) }
      }
      saveFeedback.value = '草稿保存未确认，当前与后续输入保留在本地；核对确认前暂停自动写入。'
      persistRecovery(); return false
    } finally {
      pending.value = ''
      if (queuedSave && dirty.value && !disposed && saveState.value !== 'unconfirmed' && !conflict.value) scheduleSave()
    }
  }
  async function checkServer(): Promise<boolean> {
    if (pending.value || loading.value || !detail.value) return false
    retryCheck.value = null
    const id = detail.value.id
    pending.value = 'check'; stopPolling()
    try {
      const dto = await mediaWorkbenchAPI.detail(id)
      if (disposed || detail.value?.id !== id) return false
      serverSnapshot.value = dto
      if (lastSubmission && confirmSave(dto, lastSubmission, true)) return true
      const c = dto.media_workbench_v1, current = config.value
      if ((c?.record_version ?? 0) !== (current?.record_version ?? 0) || (c?.draft.revision ?? '') !== (current?.draft.revision ?? '')) {
        const unresolved = new Set(unresolvedProductConflicts.value)
        for (const p of products.value) {
          const base = current?.draft.products.find(item => item.product_id === p.product_id)
          const server = c?.draft.products.find(item => item.product_id === p.product_id)
          if ((pendingVideoInputs.value[p.product_id]?.length || draftFingerprint([p]) !== draftFingerprint(base ? [base] : [])) && draftFingerprint(server ? [server] : []) !== draftFingerprint(base ? [base] : [])) unresolved.add(p.product_id)
        }
        for (const p of removedProducts.value) {
          const base = current?.draft.products.find(item => item.product_id === p.product_id)
          const server = c?.draft.products.find(item => item.product_id === p.product_id)
          if (draftFingerprint(server ? [server] : []) !== draftFingerprint(base ? [base] : []) || server && removalReason(server, dto)) unresolved.add(p.product_id)
        }
        unresolvedProductConflicts.value = [...unresolved]
        conflict.value = true; saveState.value = 'conflict'
        message.value = '服务器版本已变化，当前输入未被替换。请比较差异后选择恢复本地内容或明确放弃修改。'
        return false
      }
      if (unresolvedProductConflicts.value.length) { conflict.value = true; saveState.value = 'conflict'; message.value = '仍有其他商品的版本冲突未处理，请逐商品核对；当前输入保持不变。'; return false }
      if (saveState.value === 'unconfirmed') {
        const uncertain = lastSubmission ? { submission_id: lastSubmission.id, base_record_version: lastSubmission.base } : recovery.value?.pending_submission
        // An unchanged GET does not prove that an earlier request cannot arrive
        // later. It only arms an explicit new CAS attempt, never an auto retry.
        if (uncertain && dto.id === id && uncertain.base_record_version === (c?.record_version ?? 0) &&
          draftFingerprint(c?.draft.products ?? []) === draftFingerprint(current?.draft.products ?? [])) {
          retryCheck.value = { accountId: id, submissionId: uncertain.submission_id, base: uncertain.base_record_version, revision: c?.draft.revision ?? '' }
          message.value = '服务器仍为发送前版本，尚未确认原请求。可主动重新核对并保存当前最新草稿；将使用新的提交 ID 和版本校验，迟到请求只允许一个版本写入。'
        } else message.value = '服务器尚无匹配本次提交的保存回执，结果仍待核对；当前输入保留，暂不重发。'
        return false
      }
      apply(dto, false); message.value = '服务器版本核对一致，当前输入保留。'
      return true
    } catch (e) { if (lastSubmission) diagnostic('check_failed', lastSubmission, undefined, e); failure(e); return false }
    finally { pending.value = ''; if (queuedSave && dirty.value && saveState.value !== 'unconfirmed' && !conflict.value) scheduleSave() }
  }
  async function retryUnconfirmedSave(): Promise<boolean> {
    if (!canRetryUnconfirmedSave.value) return false
    // Re-read on the human action, even if the prior check was only moments ago.
    // A late original save is either confirmed here or competes with the fresh
    // submission under the same server-side CAS; it cannot overwrite its winner.
    if (await checkServer()) return dirty.value ? saveDraft() : true
    const checked = retryCheck.value
    if (!canRetryUnconfirmedSave.value || !checked || checked.accountId !== detail.value?.id ||
      checked.base !== (config.value?.record_version ?? 0) || checked.revision !== (config.value?.draft.revision ?? '')) return false
    retryCheck.value = null
    saveState.value = 'unsaved'
    return saveDraft()
  }
  async function reloadFromServer(): Promise<boolean> {
    if (!detail.value || pending.value || loading.value) return false
    const abandoned = currentOwnedRecovery()
    const id = detail.value.id
    await selectSupplier(id, true)
    if (detail.value?.id !== id || message.value) return false
    if (abandoned) clearRecovery(abandoned.value.identity.product_id, abandoned.key, undefined, abandoned.raw)
    clearRemovalRecoveries()
    discoverRecovery(); return true
  }
  function discardRecovery() {
    const entry = recoveryEntries.value.find(item => item.key === selectedRecoveryKey.value)
    if (entry && recovery.value?.copy_id === entry.value.copy_id) clearRecovery(entry.value.identity.product_id, entry.key, undefined, entry.raw)
    discoverRecovery()
  }
  async function restoreRecovery(acceptConflict = false): Promise<boolean> {
    if (!recovery.value || !detail.value || pending.value || loading.value || (recoveryConflict.value && !acceptConflict)) return false
    const value = clone(recovery.value)
    const source = recoveryEntries.value.find(entry => entry.key === selectedRecoveryKey.value && entry.value.copy_id === value.copy_id)
    const latest = serverSnapshot.value ?? detail.value
    const remainingConflicts = new Set(unresolvedProductConflicts.value)
    const serverProducts = latest.media_workbench_v1?.draft.products ?? []
    const serverProduct = serverProducts.find(p => p.product_id === value.product.product_id)
    if (!value.removed_product && removedProducts.value.some(p => p.product_id === value.product.product_id)) {
      message.value = '此商品已有待移除操作，请先明确撤销移除，再恢复商品编辑。'; return false
    }
    if (value.removed_product) {
      const matchesIdentity = value.identity.admin_id === adminId() && value.identity.account_id === detail.value.id && latest.id === detail.value.id &&
        serverProduct?.site_model === value.identity.site_model && serverProduct.upstream_model === value.identity.upstream_model &&
        value.product.site_model === value.identity.site_model && value.product.upstream_model === value.identity.upstream_model
      if (!matchesIdentity || !serverProduct || removalReason(serverProduct, latest) || removalReason(value.product, latest)) {
        message.value = '此待移除副本的商品身份或空白移除条件已变化，未恢复移除操作。请核对服务器状态。'; return false
      }
      try {
        if (!source || localStorage.getItem(source.key) !== source.raw) { discoverRecovery(); message.value = '此恢复副本已被其他页面更新，请重新核对后选择。'; return false }
      } catch { recoveryWarning.value = '浏览器恢复副本不可用，未恢复移除操作。'; return false }
    }
    const sameBase = value.base_record_version === (latest.media_workbench_v1?.record_version ?? 0) && value.base_draft_revision === (latest.media_workbench_v1?.draft.revision ?? '')
    const newProduct = !serverProduct && (value.new_product === true || sameBase && /^media-[a-f0-9-]{36}$/i.test(value.product.product_id) && !latest.media_workbench_v1?.published?.products?.some(p => p.product_id === value.product.product_id))
    if (!serverProduct && !newProduct) { message.value = '服务器已无此商品，无法自动恢复。副本保留，请先核对商品身份。'; return false }
    if (recoveryConflict.value) {
      const previousBase = clone(config.value?.draft.products ?? [])
      const otherEdits = clone(products.value.filter(p => p.product_id !== value.product.product_id && draftFingerprint([p]) !== draftFingerprint(previousBase.filter(base => base.product_id === p.product_id))))
      const removals = clone(removedProducts.value)
      const added = [...addedProductIds.value]
      apply(latest, true)
      applying = true
      for (const p of otherEdits) {
        const server = products.value.find(item => item.product_id === p.product_id)
        const base = previousBase.find(item => item.product_id === p.product_id)
        if (draftFingerprint(server ? [server] : []) !== draftFingerprint(base ? [base] : [])) remainingConflicts.add(p.product_id)
        const at = products.value.findIndex(item => item.product_id === p.product_id)
        if (at >= 0) products.value[at] = p; else products.value.push(p)
      }
      for (const p of removals) {
        const server = products.value.find(item => item.product_id === p.product_id)
        const base = previousBase.find(item => item.product_id === p.product_id)
        if (server && (draftFingerprint([server]) !== draftFingerprint(base ? [base] : []) || removalReason(server, latest))) { remainingConflicts.add(p.product_id); continue }
        products.value = products.value.filter(item => item.product_id !== p.product_id)
      }
      addedProductIds.value = added; removedProducts.value = removals
      applying = false
    }
    const pendingReceipt = value.pending_submission
    const receipt = latest.media_workbench_v1?.draft.save_receipt
    const knownPending = pendingReceipt && receipt?.submission_id === pendingReceipt.submission_id && receipt.base_record_version === pendingReceipt.base_record_version && receipt.draft_revision === latest.media_workbench_v1?.draft.revision && serverProduct && persistedFingerprint([pendingReceipt.product], latest) === draftFingerprint([serverProduct])
    // Restoring B is not confirmation or an explicit retry of A's unknown write.
    const otherUnconfirmedWrite = saveState.value === 'unconfirmed' && (!pendingReceipt ||
      (lastSubmission ? lastSubmission.id !== pendingReceipt.submission_id : [...ownedRecoveries.values()].some(entry =>
        entry.value.pending_submission && entry.value.pending_submission.submission_id !== pendingReceipt.submission_id)))
    // A strictly newer CAS base prevents the old pending request from committing.
    // Require explicit conflict acceptance before resolving its matching copy.
    const obsoletePending = !!pendingReceipt && acceptConflict && (latest.media_workbench_v1?.record_version ?? 0) > pendingReceipt.base_record_version
    const identicalPersisted = !value.removed_product && !value.video_sale_inputs?.length && (!pendingReceipt || knownPending || obsoletePending) && !!serverProduct &&
      persistedFingerprint([value.product], latest) === draftFingerprint([serverProduct])
    // Only this explicit product choice resolves its conflict. A second restore
    // of the same product cannot erase another product's unresolved conflict.
    remainingConflicts.delete(value.product.product_id)
    unresolvedProductConflicts.value = [...remainingConflicts]
    conflict.value = remainingConflicts.size > 0
    saveState.value = conflict.value ? 'conflict' : otherUnconfirmedWrite || pendingReceipt && !knownPending && !acceptConflict ? 'unconfirmed' : 'unsaved'
    applying = true
    const index = products.value.findIndex(p => p.product_id === value.product.product_id)
    if (value.removed_product) {
      products.value = products.value.filter(p => p.product_id !== value.product.product_id)
      removedProducts.value = [...removedProducts.value.filter(p => p.product_id !== value.product.product_id), clone(value.product)]
    } else if (index >= 0) products.value[index] = clone(identicalPersisted ? serverProduct! : value.product)
    else products.value.push(clone(value.product))
    if (newProduct && !addedProductIds.value.includes(value.product.product_id)) addedProductIds.value.push(value.product.product_id)
    pendingVideoInputs.value = { ...pendingVideoInputs.value, [value.product.product_id]: value.removed_product ? [] : clone(value.video_sale_inputs ?? []) }
    applying = false
    selectedModel.value = value.product.upstream_model; selectedProduct.value = value.product.product_id
    if (source) adoptedRecoveries.set(value.product.product_id, source)
    if (!otherUnconfirmedWrite && (knownPending || acceptConflict)) { lastSubmission = undefined; delete value.pending_submission }
    recovery.value = value; saveFeedback.value = saveState.value === 'unconfirmed' ? '已恢复本地输入；上次发送结果仍待核对，自动写入已暂停。' : '已恢复本地输入，等待自动保存。'
    if (remainingConflicts.size) {
      const names = [...remainingConflicts].map(id => products.value.find(p => p.product_id === id)?.display_name || id)
      message.value = `其他商品也存在版本冲突：${names.join('、')}。其本地输入已保留，请切换商品逐一核对恢复副本；确认前暂停自动写入。`
      saveFeedback.value = '已恢复本地此商品；其他商品仍有冲突，自动写入已暂停。'
    }
    // Explicitly selecting an already persisted product needs no redundant PUT.
    // Unconfirmed writes and unapplied raw video inputs cannot take this path.
    if (source && identicalPersisted && !otherUnconfirmedWrite) {
      clearRecovery(value.identity.product_id, source.key, undefined, source.raw)
      if (!dirty.value && !conflict.value) { saveState.value = 'saved'; saveFeedback.value = '所选本地内容已与服务器草稿一致，无需重复保存。' }
    }
    persistRecovery(); scheduleSave(); return true
  }
  async function becameOnline() {
    online.value = true
    if (await checkServer()) { queuedSave = true; void flushAutoSave() }
  }
  function becameOffline() { online.value = false; retryCheck.value = null; clearTimeout(autoSaveTimer); persistRecovery(); if (dirty.value) saveFeedback.value = '当前离线，输入已保留在本地；联网后先核对服务器版本。' }
  function storageChanged(event: StorageEvent) { if (event.key?.startsWith('ai-gateway:media-draft:v1:')) discoverRecovery() }
  if (typeof window !== 'undefined') { window.addEventListener('online', becameOnline); window.addEventListener('offline', becameOffline); window.addEventListener('storage', storageChanged) }
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
    try {
      const result = await mediaWorkbenchAPI.publish(id, config.value.record_version, config.value.draft.revision, [...productIds])
      // Accept either the editor DTO or the documented revision acknowledgement.
      // One authoritative DTO update refreshes the editor and all list counts.
      const confirmed = 'media_workbench_v1' in result && result.id === id ? result : await mediaWorkbenchAPI.detail(id)
      const acknowledgedRevision = 'published_revision' in result ? result.published_revision : undefined
      if (!confirmed.media_workbench_v1?.published || (acknowledgedRevision && confirmed.media_workbench_v1.published.revision !== acknowledgedRevision)) throw { status: 0, message: '发布回执与重新读取的版本不一致。' }
      apply(confirmed, true)
      publicationFeedback.value = `配置已发布。${config.value.sales.enabled ? 'Account 工作台销售已开启，新版本按已发布范围生效。' : 'Account 销售尚未开启，请在账号操作区开启。'}`
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
            apply(confirmed, true); clearError(); publicationFeedback.value = `配置已发布（已重新读取核对）。${config.value.sales.enabled ? 'Account 工作台销售已开启，新版本按已发布范围生效。' : 'Account 销售尚未开启，请在账号操作区开启。'}`
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
  async function modelBinding(input: ModelBindingInput): Promise<boolean> {
    if (pending.value || loading.value || deleted.value || conflict.value || !online.value || saveState.value === 'unconfirmed' || !detail.value || !config.value) return false
    if (dirty.value) { message.value = '请先保存或放弃未保存修改，再更换型号或删除商品。'; return false }
    pending.value = 'model-binding'; clearError(); stopPolling(); clearTimeout(autoSaveTimer)
    try {
      const dto = await mediaWorkbenchAPI.modelBinding(detail.value.id, config.value.record_version, config.value.draft.revision, input)
      if (disposed) return false
      apply(dto, true)
      if (input.action === 'rebind' && input.new_model_id) selectModel(input.new_model_id)
      else { selectedProduct.value = ''; selectedModel.value = '' }
      message.value = input.action === 'delete' ? '当前商品已删除，历史订单、任务和账务保留。' : '绑定已更换；请查看商品状态，已下架商品可重新上架。'
      return true
    } catch (e) {
      failure(e)
      const receipt = (e as { data?: SupplierDetail }).data
      if (errorStatus.value === 422 && receipt?.id === detail.value?.id) {
        publishValidation.value = receipt.publish_validation ?? null
        bindingValidationProducts.value = receipt.binding_validation_products ?? []
        bindingValidationModel.value = input.new_model_id ?? input.old_model_id
      }
      if (![401, 403, 404, 409, 410, 422].includes(errorStatus.value)) { saveState.value = 'unconfirmed'; validationUnavailable.value = true }
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
        conflict.value = true; saveState.value = 'conflict'; message.value = '同步成功，但草稿版本已变化，请核对服务器状态。'
      } else { apply(dto, false); validationUnavailable.value = true }
    } catch (e) {
      failure(e)
      if (![404, 410, 401, 403].includes(errorStatus.value)) message.value = '本次同步失败，仍使用上次成功目录。 ' + message.value
    } finally { pending.value = '' }
  }
  function discard() {
    if (!detail.value) return
    const abandoned = currentOwnedRecovery()
    adoptedRecoveries.clear() // Explicitly abandoned adoption is not a future save's source.
    if (abandoned) clearRecovery(abandoned.value.identity.product_id, abandoned.key, undefined, abandoned.raw)
    clearRemovalRecoveries()
    pendingVideoInputs.value = {}
    clearTimeout(autoSaveTimer); apply(detail.value, true); saveState.value = conflict.value ? 'conflict' : config.value?.draft.revision ? 'saved' : 'unsaved'; saveFeedback.value = ''
  }
  onBeforeUnmount(() => { persistRecovery(); disposed = true; loadSequence++; stopPolling(); clearTimeout(autoSaveTimer); window.removeEventListener('online', becameOnline); window.removeEventListener('offline', becameOffline); window.removeEventListener('storage', storageChanged) })
  return { suppliers, detail, config, products, selectedModel, selectedProduct, product, pending, autoSavePaused, loading, loadingAccountId, message,
    errorStatus, diagnostics, publishValidation, bindingValidationProducts, bindingValidationModel, saveFeedback, publicationFeedback, salesFeedback, deleted, conflict, validationUnavailable, saveState, dirty, validationCurrent, canPublish,
    recovery, recoveryWarning, recoveryConflict, recoveryIsCurrentBuffer, recoveryDiff, recoveryEntries, productRecoveries, unsubmittedRecoveries, selectedRecoveryKey, chooseRecovery, unresolvedProductConflicts, serverSnapshot, online, checkServer, canRetryUnconfirmedSave, retryUnconfirmedSave, reloadFromServer, restoreRecovery, discardRecovery, flushAutoSave,
    videoSaleInputs, updateVideoSaleInputs,
    addedProductIds, removedProducts, removalReason, removeProduct, undoRemoval,
    loadSuppliers, selectSupplier, selectModel, addProduct, saveDraft, publish, sales, lifecycle, modelBinding, sync, discard }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { AxiosError, type AxiosResponse } from 'axios'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiClient } from '@/api/client'
import { mediaWorkbenchAPI, type SupplierDetail } from '@/api/admin/mediaWorkbench'
import { useMediaWorkbench } from '@/composables/useMediaWorkbench'

let bridge: ChildProcessWithoutNullStreams
const replies: ((value: { status: number; data: unknown }) => void)[] = []
const calls: { method: string; path: string; body: unknown }[] = []
const originalAdapter = apiClient.defaults.adapter
let denyReadback = false
function exchange(value: object): Promise<{ status: number; data: unknown }> {
  return new Promise(resolve => { replies.push(resolve); bridge.stdin.write(JSON.stringify(value) + '\n') })
}
beforeAll(async () => {
  if (!process.env.MEDIA_CONTRACT_BINARY || !existsSync(process.env.MEDIA_CONTRACT_BINARY)) throw new Error('Build the media_contract Go test binary and set MEDIA_CONTRACT_BINARY')
  bridge = spawn(process.env.MEDIA_CONTRACT_BINARY, ['-test.run=^TestMediaFrontendContractBridge$'], { stdio: 'pipe' })
  createInterface({ input: bridge.stdout }).on('line', line => {
    if (line.startsWith('{')) replies.shift()?.(JSON.parse(line))
  })
  bridge.stderr.on('data', data => process.stderr.write(data))
  await new Promise<void>((resolve, reject) => { bridge.once('spawn', resolve); bridge.once('error', reject) })
  apiClient.defaults.adapter = async config => {
    const method = config.method!.toUpperCase()
    const path = '/api/v1' + config.url
    const body = config.data ? JSON.parse(config.data) : undefined
    calls.push({ method, path, body })
    const reply = denyReadback && method === 'GET' && path.endsWith('/accounts/7')
      ? { status: 503, data: { code: 503, message: 'readback intentionally unavailable' } }
      : await exchange({ method, path, body: config.data ?? '' })
    const response: AxiosResponse = { ...reply, config, headers: {}, statusText: String(reply.status) }
    if (reply.status >= 400) throw new AxiosError('contract response', 'ERR_BAD_RESPONSE', config, undefined, response)
    return response
  }
})
afterAll(async () => {
  apiClient.defaults.adapter = originalAdapter
  if (!bridge) return
  bridge.stdin.end()
  await new Promise<void>(resolve => bridge.once('exit', () => resolve()))
})

describe('real frontend + Phase 2A HTTP control-plane contract (stdio, zero network)', () => {
  let state: ReturnType<typeof useMediaWorkbench>
  let published: string
  let wrapper: ReturnType<typeof mount>
  it('sync → specs/decimal price/size mapping → Save(+2 CAS) → PASS → Publish → readback', async () => {
    wrapper = mount(defineComponent({ setup() { state = useMediaWorkbench(); return () => null } }))
    await state.initialize(7, ['image', 'video'])
    await state.sync()
    expect(state.detail.value!.models).toContainEqual({ model_id: 'gpt-image-2', state: 'PENDING' })
    state.selectModel('gpt-image-2'); state.addProduct('image')
    const p = state.product.value!
    p.capabilities.resolutions = ['1K']; p.capabilities.aspect_ratios = ['1:1']
    p.adapter_config.size_mappings = [{ resolution: '1K', aspect_ratio: '1:1', wire_size: '1024x1024' }]
    p.pricing_rules = [{ match: {}, sale_price: { amount: '0.12345678901234567890', currency: 'USD', billing_mode: 'per_request' } }]
    const initialVersion = state.config.value!.record_version
    expect(await state.saveDraft()).toBe(true)
    expect(state.config.value!.record_version).toBe(initialVersion + 2)
    expect(state.config.value!.validation.status).toBe('PASS'); expect(state.canPublish.value).toBe(true)
    expect(state.products.value[0]!.adapter_config.size_mappings[0]!.wire_size).toBe('1024x1024')
    const expectedRevision = state.config.value!.draft.revision
    await state.publish()
    expect(state.errorStatus.value).toBe(0)
    published = state.config.value!.published!.revision
    const readback = await mediaWorkbenchAPI.detail(7)
    expect(readback.media_workbench_v1!.published!.revision).toBe(published)
    expect(readback.media_workbench_v1!.published!.source_draft_revision).toBe(expectedRevision)
    expect(readback.media_workbench_v1!.published!.offers).toHaveLength(1)
    expect(state.config.value!.record_version).toBe(initialVersion + 3)
    expect(state.products.value[0]!.pricing_rules[0]!.sale_price!.amount).toBe('0.12345678901234567890')
    expect((await exchange({ action: 'stats' })).data).toEqual({ calls: 1 })
  })
  it('uses real sales gates and preserves drafts while pausing/resuming', async () => {
    await state.sales(true); expect(state.detail.value!.effective_state).toBe('SELLING')
    state.products.value[0]!.display_name = 'unsaved edit'
    await state.sales(false); expect(state.detail.value!.effective_state).toBe('SALES_PAUSED')
    expect(state.products.value[0]!.display_name).toBe('unsaved edit')
    for (const action of ['status', 'schedulable', 'runtime']) {
      await exchange({ action, status: 'disabled', ready: false })
      const dto = await mediaWorkbenchAPI.detail(7)
      expect(dto.effective_sales).toBe(false)
      expect(dto.effective_state).toBe({ status: 'ACCOUNT_INACTIVE', schedulable: 'ACCOUNT_UNSCHEDULABLE', runtime: 'ACCOUNT_RUNTIME_BLOCKED' }[action])
      await expect(mediaWorkbenchAPI.sales(7, dto.media_workbench_v1!.record_version, true)).rejects.toMatchObject({ status: 422, reason: 'MEDIA_SALES_NOT_READY' })
      await exchange({ action, status: 'active', ready: true })
    }
    await state.selectSupplier(7)
  })
  it('returns UI_FIXABLE and NEEDS_DEVELOPMENT from real automatic validation, retaining Published', async () => {
    state.products.value[0]!.adapter_config.size_mappings = []
    await state.saveDraft()
    expect(state.canPublish.value).toBe(false)
    expect(state.diagnostics.value).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'UI_FIXABLE', path: expect.stringContaining('adapter_config.size_mappings') })]))
    expect(state.diagnostics.value[0]!.scope).toBe(state.products.value[0]!.product_id)
    expect(state.diagnostics.value[0]!.path).not.toContain('products[')
    expect(state.config.value!.published!.revision).toBe(published)
    state.products.value[0]!.adapter_config.size_mappings = [{ resolution: '1K', aspect_ratio: '1:1', wire_size: '1024x1024' }]
    state.products.value[0]!.pricing_rules[0]!.sale_price = null
    await state.saveDraft()
    expect(state.diagnostics.value).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'UI_FIXABLE', code: 'MISSING_PRICE' })]))
    state.products.value[0]!.media_type = 'video'
    await state.saveDraft()
    expect(state.diagnostics.value).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'NEEDS_DEVELOPMENT' })]))
    state.products.value[0]!.media_type = 'image'
    state.products.value[0]!.pricing_rules[0]!.sale_price = { amount: '0', currency: 'USD', billing_mode: 'per_request' }
    await state.saveDraft(); expect(state.canPublish.value).toBe(true)
  })
  it('consumes Publish 422 data receipt even when a follow-up GET is unavailable', async () => {
    // Dependencies change after the displayed PASS; Publish must revalidate.
    await exchange({ action: 'unknown' })
    denyReadback = true
    await state.publish()
    denyReadback = false
    expect(state.errorStatus.value).toBe(422)
    expect(state.config.value!.validation.status).toBe('FAIL')
    expect(state.diagnostics.value).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'UI_FIXABLE', code: 'MODEL_SYNC_REQUIRED' })]))
    expect(state.config.value!.published!.revision).toBe(published)
    expect(state.canPublish.value).toBe(false)
  })
  it('native sync preserves Draft/Published; removed models and changed catalog fail closed', async () => {
    const draft = state.config.value!.draft.revision
    await exchange({ action: 'models', models: ['gpt-image-3'] })
    await state.sync()
    expect(state.config.value!.draft.revision).toBe(draft)
    expect(state.config.value!.published!.revision).toBe(published)
    expect(state.detail.value!.models).toContainEqual({ model_id: 'gpt-image-2', state: 'UPSTREAM_NOT_DISCOVERED' })
    expect(state.canPublish.value).toBe(false)
    await state.sales(true); expect(state.errorStatus.value).toBe(422)
    await exchange({ action: 'models', models: ['gpt-image-2'] }); await state.sync(); await state.saveDraft()
    expect(state.canPublish.value).toBe(true)
    await state.publish()
  })
  it('returns a saved UNKNOWN receipt after local validation persistence fails', async () => {
    await exchange({ action: 'validation_unavailable' })
    const version = state.config.value!.record_version
    state.products.value[0]!.display_name = 'saved with unavailable validation'
    expect(await state.saveDraft()).toBe(true)
    expect(state.config.value!.record_version).toBe(version + 1)
    expect(state.config.value!.validation.status).toBe('UNKNOWN')
    expect(state.diagnostics.value).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'UNKNOWN', code: 'LOCAL_DEPENDENCY_UNAVAILABLE' })]))
    expect(state.canPublish.value).toBe(false)
    await state.saveDraft(); expect(state.canPublish.value).toBe(true)
  })
  it('rejects stale versions/revisions and unknown write fields without overwriting', async () => {
    const dto = await mediaWorkbenchAPI.detail(7)
    const c = dto.media_workbench_v1!
    await expect(mediaWorkbenchAPI.publish(7, c.record_version, 'stale-draft')).rejects.toMatchObject({ status: 409, reason: 'STALE_MEDIA_CONFIG' })
    await expect(mediaWorkbenchAPI.saveDraft(7, c.record_version - 1, state.products.value)).rejects.toMatchObject({ status: 409 })
    await expect(apiClient.put('/admin/media-workbench/accounts/7/draft', { expected_record_version: c.record_version, draft: { products: state.products.value }, adapter_bindings: {} })).rejects.toMatchObject({ status: 400 })
    await mediaWorkbenchAPI.sales(7, c.record_version, false)
    state.products.value[0]!.display_name = 'retain on conflict'
    await state.saveDraft()
    expect(state.conflict.value).toBe(true); expect(state.products.value[0]!.display_name).toBe('retain on conflict')
    await state.selectSupplier(7)
    expect(state.conflict.value).toBe(false)
  })
  it('keeps deleted Account edits read-only and verifies no validation supplier calls', async () => {
    // Go nil slices are legal in a saved incomplete Draft and encode as null.
    const p = state.products.value[0]!
    const result = await apiClient.put<SupplierDetail>('/admin/media-workbench/accounts/7/draft', {
      expected_record_version: state.config.value!.record_version,
      draft: { products: [{ ...p, capabilities: { ...p.capabilities, resolutions: null }, pricing_rules: null }] }
    })
    expect(result.data.media_workbench_v1!.draft.products[0]!.capabilities.resolutions).toBeNull()
    expect(result.data.media_workbench_v1!.draft.products[0]!.pricing_rules).toBeNull()
    await state.selectSupplier(7)
    expect(state.products.value[0]!.capabilities.resolutions).toEqual([])
    expect(state.products.value[0]!.pricing_rules).toEqual([])
    await exchange({ action: 'deleted', ready: true })
    state.products.value[0]!.display_name = 'retain after deletion'
    await state.saveDraft()
    expect(state.deleted.value).toBe(true); expect(state.canPublish.value).toBe(false)
    expect(state.products.value[0]!.display_name).toBe('retain after deletion')
    expect((await exchange({ action: 'stats' })).data).toEqual({ calls: 3 })
    const allowed = /^\/api\/v1\/admin\/(media-workbench\/(suppliers|accounts\/7(\/(initialize|draft|publish|sales))?)|accounts\/7\/models\/sync-upstream)$/
    expect(calls.every(call => allowed.test(call.path))).toBe(true)
    const publishedRequest = calls.find(call => call.path.endsWith('/publish'))!
    expect(Object.keys(publishedRequest.body as object).sort()).toEqual(['expected_draft_revision', 'expected_record_version'])
    const detail = state.detail.value as SupplierDetail
    expect(detail.id).toBe(7)
    wrapper.unmount()
  })
})

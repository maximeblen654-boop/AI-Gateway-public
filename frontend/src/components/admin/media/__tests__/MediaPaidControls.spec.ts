import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import MediaPaidControls from '../MediaPaidControls.vue'
import { supplier } from './fixtures'
const api = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn(), apply: vi.fn() }))
vi.mock('@/api/admin/mediaPaid', () => ({ mediaPaidAPI: api }))
const state = (media: string, effective = false) => ({ media, mode: 'managed-v1', requested_enabled: effective, effective_enabled: effective, reason: effective ? 'open' : 'closed', revision: 'r1' })
const create = (suppliers: ReturnType<typeof supplier>[] = []) => mount(MediaPaidControls, { props: { suppliers }, global: { stubs: { ConfirmDialog: { props: ['show'], template: '<div v-if="show"><button data-test="confirm" @click="$emit(\'confirm\')">confirm</button></div>' } } } })
beforeEach(() => { vi.resetAllMocks(); api.status.mockImplementation(async kind => state(kind)); api.check.mockResolvedValue({ pass: true, fingerprint: 'abc', checks: [] }) })
it('keeps separate state and requires preflight plus explicit confirmation', async () => {
 const w=create();await flushPromises()
 const image=w.find('[data-test="paid-image"]');const enable=image.findAll('button')[1]
 expect(enable.attributes('disabled')).toBeDefined()
 await image.findAll('button')[0].trigger('click');await flushPromises()
 expect(api.apply).not.toHaveBeenCalled();expect(enable.attributes('disabled')).toBeUndefined()
 await enable.trigger('click');expect(api.apply).not.toHaveBeenCalled()
 api.apply.mockResolvedValue({state:state('image',true)});api.status.mockImplementation(async kind=>state(kind,kind==='image'))
 await w.find('[data-test="confirm"]').trigger('click');await flushPromises()
 expect(api.apply).toHaveBeenCalledWith('image',true,expect.objectContaining({revision:'r1'}),expect.objectContaining({fingerprint:'abc'}))
 expect(image.text()).toContain('实际已开放');expect(w.find('[data-test="paid-video"]').text()).toContain('实际未开放')
})
it('does not report a failed apply or failed status fetch as successful', async () => {
 const w=create();await flushPromises();const image=w.find('[data-test="paid-image"]')
 await image.findAll('button')[0].trigger('click');await flushPromises();await image.findAll('button')[1].trigger('click')
 api.apply.mockRejectedValue(new Error('failure'));await w.find('[data-test="confirm"]').trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('未确认生效');expect(image.text()).toContain('实际未开放')
 api.status.mockRejectedValue(new Error('offline'));await w.find('header button').trigger('click');await flushPromises()
 expect(image.text()).toContain('状态未确认');expect(api.apply).toHaveBeenCalledTimes(1)
})


it('labels partial preflight by real product name and keeps failures distinct from global enablement',async()=>{
 const dto=supplier();dto.product_states=[{product_id:'private-product-b',display_name:'Banana 商品',upstream_model:'banana-image',media_type:'image',published:true,published_ready:false,state:'UPSTREAM_REMOVED',reason:'上游目录未发现此商品模型。',action:'先核对并同步目录，再重新检查。'}]
 api.check.mockResolvedValue({pass:true,fingerprint:'partial',checks:[{code:'native_quote',pass:true,account_id:77,product_id:'canvas-1'},{code:'published_specs',pass:false,account_id:77,product_id:'private-product-b'}]})
 const w=create([dto]);await flushPromises();const image=w.get('[data-test="paid-image"]')
 await image.findAll('button')[0].trigger('click');await flushPromises()
 expect(image.text()).toContain('部分商品不可用，开启后仅通过检查的商品可用')
 expect(image.text()).toContain('Account #77 · Banana 商品')
 expect(image.text()).toContain('上游目录未发现');expect(image.text()).toContain('先核对并同步目录')
 expect(image.text()).not.toContain('private-product-b');expect(image.text()).not.toContain('检查通过，开启时')
 expect(image.get('details').attributes('open')).toBeDefined()
 expect(image.findAll('button')[1].attributes('disabled')).toBeUndefined();expect(api.apply).not.toHaveBeenCalled()
 expect(w.text()).toContain('全局开关开放不代表每个商品或每个客户均可生成')
})

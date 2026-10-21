import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import MediaPaidControls from '../MediaPaidControls.vue'
import { supplier } from './fixtures'
const api = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn(), apply: vi.fn() }))
vi.mock('@/api/admin/mediaPaid', async importOriginal => ({ ...await importOriginal<typeof import('@/api/admin/mediaPaid')>(), mediaPaidAPI: api }))
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

it('shows applying until the server confirms the effective state', async () => {
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.attributes('data-phase')).toBe('check-passed')
 await video.findAll('button')[1].trigger('click')
 let finish!: (value: unknown) => void
 api.apply.mockReturnValue(new Promise(resolve => {finish=resolve}))
 await w.get('[data-test="confirm"]').trigger('click')
 expect(video.attributes('data-phase')).toBe('applying')
 expect(video.get('[data-test="paid-applying"]').text()).toContain('再次执行完整检查')
 expect(video.text()).not.toContain('实际已开放')
 expect(video.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
 api.status.mockImplementation(async kind=>state(kind,kind==='video'))
 finish({state:state('video',true)});await flushPromises()
 expect(video.attributes('data-phase')).toBe('confirmed-effective')
 expect(video.find('[data-test="paid-applying"]').exists()).toBe(false)
 expect(video.text()).toContain('实际已开放')
 expect(api.apply).toHaveBeenCalledTimes(1)
})
it('does not report a failed apply or failed status fetch as successful', async () => {
 const w=create();await flushPromises();const image=w.find('[data-test="paid-image"]')
 await image.findAll('button')[0].trigger('click');await flushPromises();await image.findAll('button')[1].trigger('click')
 api.apply.mockRejectedValue(new Error('failure'));await w.find('[data-test="confirm"]').trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('开启结果未确认');expect(image.text()).toContain('实际未开放')
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

it('explains safe quote stages without exposing arbitrary server error text or enabling sales', async () => {
 api.check.mockResolvedValue({pass:false, checks:[
  {code:'quote_account_cost',pass:false,account_id:44,path:'without_references'},
  {code:'quote_execution',pass:false,account_id:44,path:'with_references'},
  {code:'quote_unknown',pass:false},
  {code:'constructor',pass:false},
  {code:'__proto__',pass:false},
  {code:'https://secret.invalid?token=private',pass:false},
  {code:'published_offer',pass:false}
 ]})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('历史检查结果已失效，请重新执行开启前检查')
 expect(video.find('[data-test="cost-guide"]').exists()).toBe(false)
 expect(video.text()).toContain('视频协议或规格不兼容')
 expect(video.text()).toContain('报价检查原因未分类')
 expect(video.text()).toContain('没有可用的已发布商品')
 expect(video.text()).not.toContain('secret.invalid')
 expect(video.text()).not.toContain('function Object')
 expect(video.text()).toContain('其他服务端检查，请管理员核对诊断')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['image', 'video'])('keeps obsolete procurement reports closed without restoring any configuration UI: %s', async media => {
 api.check.mockResolvedValue({pass:false, group_id:31, checks:[
 {code:'quote_cost_channel_missing',pass:false,account_id:44},
 {code:'quote_cost_rule_missing',pass:false,account_id:44},
 {code:'quote_cost_contract',pass:false,account_id:44}
 ]})
 const w=create(); await flushPromises(); const panel=w.get(`[data-test="paid-${media}"]`)
 await panel.findAll('button')[0].trigger('click');await flushPromises()
 expect(panel.text()).toContain('历史检查结果已失效，请重新执行开启前检查')
 expect(panel.find('[data-test="cost-guide"]').exists()).toBe(false)
 expect(panel.text()).not.toContain('采购成本与售价')
 expect(panel.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['image', 'video'])('explains the %s amount-quota restriction without offering procurement or changing settings', async media => {
 api.check.mockResolvedValue({ pass:false, checks:[{ code:'quote_account_quota_requires_cost', pass:false, account_id:44 }] })
 const w=create(); await flushPromises(); const video=w.get(`[data-test="paid-${media}"]`)
 await video.findAll('button')[0].trigger('click'); await flushPromises()
 expect(video.text()).toContain('此 Account 设置了金额额度')
 expect(video.text()).toContain('采购成本未知，暂不可用')
 expect(video.text()).toContain('请使用无金额额度的账号')
 expect(video.text()).toContain('不会自动修改配置')
 expect(video.find('[data-test="cost-guide"]').exists()).toBe(false)
 expect(api.apply).not.toHaveBeenCalled()
})

it('shows a no-offer business failure as a readable report and keeps submission closed', async () => {
 api.check.mockResolvedValue({pass:false,fingerprint:'failed',checks:[{code:'published_offer',pass:false}]})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查未通过')
 expect(video.text()).toContain('没有可用的已发布商品')
 expect(video.text()).toContain('实际未开放')
 expect(w.find('[role="alert"]').exists()).toBe(false)
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['sidecar_runtime','dependencies_unavailable'])('keeps an unavailable dependency report distinct from request failure: %s', async code => {
 api.check.mockResolvedValue({pass:false,fingerprint:'failed',checks:[{code,pass:false}]})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查未通过')
 expect(video.text()).toMatch(/运行合同检查未通过|依赖暂时不可用/)
 expect(video.text()).toContain('实际未开放')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(w.find('[role="alert"]').exists()).toBe(false)
 expect(api.apply).not.toHaveBeenCalled()
})

it('identifies a POST failure without showing raw response content or issuing apply', async () => {
 api.check.mockRejectedValue({status:503,message:'DBerror https://private.invalid?token=SECRET'})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('开启前检查请求失败（POST）')
 expect(w.get('[role="alert"]').text()).toContain('服务暂时不可用')
 expect(video.text()).toContain('状态未确认')
 expect(video.find('.mw-paid-checks').exists()).toBe(false)
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(w.text()).not.toMatch(/DBerror|private\.invalid|SECRET/)
 expect(api.status).toHaveBeenCalledTimes(2)
 expect(api.apply).not.toHaveBeenCalled()
})

it('describes a check timeout as an unconfirmed request, without inventing a failed business report', async () => {
 api.check.mockRejectedValue({status:0,code:'ECONNABORTED',message:'timeout DBerror'})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('请求超时，服务端处理结果尚未确认')
 expect(w.get('[role="alert"]').text()).toContain('未执行开启')
 expect(video.find('.mw-paid-checks').exists()).toBe(false)
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.check).toHaveBeenCalledTimes(1)
 expect(api.apply).not.toHaveBeenCalled()
})

it('explains the bounded full check while waiting and does not offer confirmation early', async () => {
 let finish!: (value: unknown) => void
 api.check.mockReturnValue(new Promise(resolve => {finish=resolve}))
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click')
 expect(video.get('[role="status"]').text()).toContain('最多等待 120 秒')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
 finish({pass:true,fingerprint:'complete',checks:[]});await flushPromises()
 expect(video.find('[role="status"]').exists()).toBe(false)
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
})

it('preserves a successful POST report when its follow-up GET fails and requires a fresh check after refresh', async () => {
 api.check.mockResolvedValue({pass:true,fingerprint:'keep-report',checks:[{code:'native_quote',pass:true}]})
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 api.status.mockRejectedValueOnce({status:0,code:'ERR_NETWORK',message:'private.invalid'})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('检查报告已返回，但状态读取失败（GET）')
 expect(video.text()).toContain('原生非付费报价')
 expect(video.text()).toContain('运行状态暂时无法确认')
 expect(video.text()).toContain('状态未确认')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 await w.get('header button').trigger('click');await flushPromises()
 expect(video.text()).toContain('实际未开放')
 expect(video.text()).toContain('检查结果已失效')
 expect(video.text()).toContain('原生非付费报价')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it('refreshes each type independently and displays the actual server state', async () => {
 api.status.mockImplementation(async kind => {
  if(kind==='image') throw {status:403,message:'SECRET'}
  return state('video',true)
 })
 const w=create();await flushPromises()
 expect(w.get('[data-test="paid-image"]').text()).toContain('状态未确认')
 const video=w.get('[data-test="paid-video"]')
 expect(video.text()).toContain('实际已开放')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(video.findAll('button')[2].attributes('disabled')).toBeUndefined()
 expect(w.get('[role="alert"]').text()).toContain('图片状态读取失败（GET）')
 api.status.mockImplementation(async kind => state(kind))
 await w.get('header button').trigger('click');await flushPromises()
 expect(video.text()).toContain('实际未开放')
 expect(w.get('[data-test="paid-image"]').text()).toContain('实际未开放')
 expect(w.find('[role="alert"]').exists()).toBe(false)
 expect(api.apply).not.toHaveBeenCalled()
})

it('invalidates a passing report and closes its confirmation when actual state is refreshed', async () => {
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 await video.findAll('button')[1].trigger('click')
 expect(w.find('[data-test="confirm"]').exists()).toBe(true)
 api.status.mockImplementation(async kind => ({...state(kind),revision:'r2'}))
 await w.get('header button').trigger('click');await flushPromises()
 expect(w.find('[data-test="confirm"]').exists()).toBe(false)
 expect(video.text()).toContain('检查结果已失效')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['dependencies_unavailable','revision_changed'])('does not authorize a passing report when the follow-up state invalidates it: %s', async reason => {
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 api.status.mockResolvedValue({...state('video'),reason})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查结果已失效')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['apply_failed','no_approved_offer','runtime_restarted'])('allows a new passing report to reach the official second check after a closed previous grant: %s', async reason => {
 api.status.mockImplementation(async kind => ({...state(kind),reason}))
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查通过，开启时服务端将再次核对')
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 await video.findAll('button')[1].trigger('click')
 expect(w.find('[data-test="confirm"]').exists()).toBe(true)
 expect(api.apply).not.toHaveBeenCalled()
})

it.each(['state_unavailable','future_state'])('never treats an unknown state as closed or enables from it: %s', async reason => {
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 api.status.mockResolvedValue({...state('video'),reason})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('状态未确认')
 expect(video.text()).not.toContain('实际未开放')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it('keeps unmanaged controls disabled even when a previous report could pass', async () => {
 api.status.mockImplementation(async kind => ({...state(kind),mode:'legacy',reason:'deployment_mode'}))
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 expect(video.findAll('button')[0].attributes('disabled')).toBeDefined()
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.check).not.toHaveBeenCalled()
 expect(api.apply).not.toHaveBeenCalled()
})

it('invalidates confirmation on published dependency changes but keeps ordinary draft edits separate', async () => {
 const dto=supplier();const w=create([dto]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 const draftOnly=structuredClone(dto);draftOnly.media_workbench_v1!.draft.revision='mwd_new'
 await w.setProps({suppliers:[draftOnly]})
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 await video.findAll('button')[1].trigger('click')
 const published=structuredClone(draftOnly);published.media_workbench_v1!.published!.revision='mwp_new'
 await w.setProps({suppliers:[published]})
 expect(video.text()).toContain('检查结果已失效')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(w.find('[data-test="confirm"]').exists()).toBe(false)
 expect(api.apply).not.toHaveBeenCalled()
})

it('does not revalidate a report if supplier dependencies changed while its POST was running', async () => {
 let finish!: (value: unknown) => void
 api.check.mockReturnValue(new Promise(resolve => {finish=resolve}))
 const dto=supplier();const w=create([dto]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click')
 const changed=structuredClone(dto);changed.effective_sales=false
 await w.setProps({suppliers:[changed]})
 finish({pass:true,fingerprint:'outdated',checks:[]});await flushPromises()
 expect(video.text()).toContain('检查结果已失效')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it.each([true,false,null])('reads actual state after an enable PUT timeout without retrying its old fingerprint: %s', async actual => {
 const w=create();await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 await video.findAll('button')[1].trigger('click')
 api.apply.mockRejectedValue({status:0,code:'ECONNABORTED',message:'DBerror SECRET'})
 api.status.mockImplementation(async kind => {
  if(kind==='video' && actual===null) throw {status:503,message:'SECRET'}
  return state(kind,kind==='video' && actual===true)
 })
 await w.get('[data-test="confirm"]').trigger('click');await flushPromises()
 expect(w.get('[role="alert"]').text()).toContain('开启结果未确认')
 expect(w.get('[role="alert"]').text()).toContain('暂勿重复开启')
 expect(w.text()).not.toMatch(/DBerror|SECRET/)
 expect(video.text()).toContain(actual===null?'状态未确认':actual?'实际已开放':'实际未开放')
 expect(video.attributes('data-phase')).toBe('unconfirmed')
 expect(video.find('.mw-paid-checks').exists()).toBe(false)
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).toHaveBeenCalledTimes(1)
})

it('uses predefined product failure guidance rather than arbitrary server reason and action fields', async () => {
 const dto=supplier();dto.product_states=[{product_id:'canvas-1',display_name:'示例商品',upstream_model:'safe-model',media_type:'image',published:true,published_ready:false,state:'UPSTREAM_REMOVED',reason:'DBerror SECRET',action:'https://private.invalid'}]
 api.check.mockResolvedValue({pass:false,fingerprint:'failed',checks:[{code:'published_specs',pass:false,account_id:77,product_id:'canvas-1'}]})
 const w=create([dto]);await flushPromises();const image=w.get('[data-test="paid-image"]')
 await image.findAll('button')[0].trigger('click');await flushPromises()
 expect(image.text()).toContain('上游目录未发现此商品模型')
 expect(image.text()).not.toMatch(/DBerror|SECRET|private\.invalid/)
})


it('waits for supplier dependencies before starting a paid preflight', async () => {
 const w=create();await w.setProps({suppliersLoading:true});await flushPromises()
 const video=w.get('[data-test="paid-video"]')
 expect(video.findAll('button')[0].attributes('disabled')).toBeDefined()
 expect(video.text()).toContain('供应商列表仍在读取')
 await video.findAll('button')[0].trigger('click')
 expect(api.check).not.toHaveBeenCalled()
 await w.setProps({suppliers:[supplier()],suppliersLoading:false})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查通过，开启时服务端将再次核对')
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it('retains a fresh report across nonmaterial supplier and catalog ordering changes', async () => {
 const dto=supplier();const w=create([dto]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click');await flushPromises()
 const reordered=structuredClone(dto);reordered.model_catalog!.models.reverse()
 await w.setProps({suppliers:[reordered]})
 expect(video.text()).toContain('检查通过，开启时服务端将再次核对')
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 expect(api.apply).not.toHaveBeenCalled()
})

it('does not revive a report after a real dependency changes and returns while checking', async () => {
 let finish!: (value: unknown) => void
 api.check.mockReturnValue(new Promise(resolve => {finish=resolve}))
 const dto=supplier();const w=create([dto]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click')
 const changed=structuredClone(dto);changed.effective_sales=false
 await w.setProps({suppliers:[changed]});await w.setProps({suppliers:[dto]})
 finish({pass:true,fingerprint:'interrupted',checks:[]});await flushPromises()
 expect(video.text()).toContain('检查期间商品或账号配置发生变化')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})


it('uses the new POST report rather than the previous grant fingerprint and reason', async () => {
 api.status.mockImplementation(async kind => ({...state(kind),requested_enabled:true,reason:'dependencies_changed',fingerprint:'old-grant'}))
 const w=create([supplier()]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 api.check.mockResolvedValue({pass:true,fingerprint:'new-report',checks:[{code:'native_quote',pass:true}]})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('检查通过，开启时服务端将再次核对')
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 await video.findAll('button')[1].trigger('click')
 expect(w.find('[data-test="confirm"]').exists()).toBe(true)
 expect(api.apply).not.toHaveBeenCalled()
})

it('requires a new check if the switch revision changes during a passing POST', async () => {
 const w=create([supplier()]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 api.status.mockResolvedValue({...state('video'),revision:'changed-revision'})
 await video.findAll('button')[0].trigger('click');await flushPromises()
 expect(video.text()).toContain('开关版本在检查期间发生变化')
 expect(video.findAll('button')[1].attributes('disabled')).toBeDefined()
 expect(api.apply).not.toHaveBeenCalled()
})


it('preserves a passing POST when only catalog ordering and object insertion order change in flight', async () => {
 let finish!: (value: unknown) => void
 api.check.mockReturnValue(new Promise(resolve => {finish=resolve}))
 const dto=supplier();dto.media_workbench_v1!.adapter_bindings={video:{kind:'native_video',revision:'v1',auth:'account_apikey',task_flow:'async'}}
 const w=create([dto]);await flushPromises();const video=w.get('[data-test="paid-video"]')
 await video.findAll('button')[0].trigger('click')
 const reordered=structuredClone(dto);reordered.model_catalog!.models.reverse()
 reordered.media_workbench_v1!.adapter_bindings!.video={task_flow:'async',auth:'account_apikey',revision:'v1',kind:'native_video'}
 await w.setProps({suppliers:[reordered]})
 finish({pass:true,fingerprint:'stable-order',checks:[]});await flushPromises()
 expect(video.text()).toContain('检查通过，开启时服务端将再次核对')
 expect(video.findAll('button')[1].attributes('disabled')).toBeUndefined()
 expect(api.apply).not.toHaveBeenCalled()
})

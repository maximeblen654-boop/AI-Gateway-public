import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const client=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}))
vi.mock('../client',()=>({apiClient:client,buildGatewayUrl:(v:string)=>v}))
import { ensureStudioSession, studioRequest, studioQuoteSequence, studioTaskView, studioResultUrl, studioCoverUrl, recoverStudioMediaRead, studioResultExpired, studioErrorMessage, StudioError } from '../studioMedia'
beforeEach(()=>{vi.clearAllMocks();localStorage.clear()})
afterEach(()=>vi.unstubAllGlobals())
it('an authoritative media expiry is not described as a connection or generation failure',()=>{
 for(const code of ['image_result_expired','video_result_expired'])expect(studioErrorMessage(new StudioError(code,410))).toBe('原片已到期，无法继续预览或下载；原任务与结算记录保留，不会重新生成。')
})
it('switching website accounts replaces an earlier Studio session through a real ticket exchange',async()=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockResolvedValue({data:{ticket:'synthetic-ticket'}})
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:1}))).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2})));vi.stubGlobal('fetch',fetch)
 expect(await ensureStudioSession()).toEqual({owner_id:2});expect(client.post).toHaveBeenCalledWith('/auth/studio-media-ticket');expect(fetch.mock.calls[1][0]).toBe('/studio-v2/api/session/exchange')
})
it('result URLs come from validated task identity, never a supplier URL in the response',()=>{
 const v={contract:'published_image_binding_v1',task_id:'img_'+'a'.repeat(32),status:'completed',spec:{count:1},sale_price:{amount:'1.25',currency:'CNY',billing_mode:'per_request'},results:[{url:'https://untrusted.invalid'}]}
 const task=studioTaskView('image',v);expect(studioResultUrl(task)).toBe(`/studio-v2/api/image/tasks/${v.task_id}/results/0`);expect(()=>studioTaskView('image',{...v,task_id:'https://untrusted.invalid'})).toThrow();expect(()=>studioTaskView('image',{...v,sale_price:{amount:'NaN'}})).toThrow()
})
const retentionTask = (kind: 'image' | 'video') => ({contract:kind === 'image'?'published_image_binding_v1':'account_video_v1',[kind === 'image'?'task_id':'operation_id']:(kind === 'image'?'img_':'op_')+'a'.repeat(kind === 'image'?32:64),status:'completed',spec:{count:1},sale_price:{amount:'1.25',currency:'CNY',billing_mode:'per_request'},results:[{}],expires_at:'2000-01-01T00:00:00Z',billing_state:'billed'})
it.each([
 ['image','image_original_72h'],['image','image_legacy_7d'],['video','video_original_48h'],['video','legacy_unknown']
] as const)('preserves explicit %s original retention policy %s independently from quote expiry',(kind,policy)=>{
 const result_retention={persisted_at:'2026-10-19T00:00:00Z',expires_at:policy==='legacy_unknown'?null:'2099-01-01T00:00:00Z',expired:false,policy}
 const task=studioTaskView(kind,{...retentionTask(kind),result_retention})
 expect(task.resultRetention).toEqual({persistedAt:result_retention.persisted_at,expiresAt:result_retention.expires_at,expired:false,policy})
 expect(task.expiresAt).toBe('2000-01-01T00:00:00Z');expect(studioResultExpired(task)).toBe(false);expect(studioResultUrl(task)).toContain('/studio-v2/api/')
})
it.each(['image','video'] as const)('missing %s retention leaves the original deadline unknown without deriving it from creation or quote',kind=>{
 const task=studioTaskView(kind,{...retentionTask(kind),created_at:'2000-01-01T00:00:00Z'})
 expect(task.resultRetention).toBeUndefined();expect(studioResultExpired(task)).toBe(false);expect(studioResultUrl(task)).toContain('/studio-v2/api/')
})
it('blocks at the exact original deadline and respects the server expired flag without changing task or billing status',()=>{
 const expires_at='2026-10-22T00:00:00Z',deadline=Date.parse(expires_at)
 const task=studioTaskView('image',{...retentionTask('image'),result_retention:{persisted_at:'2026-10-19T00:00:00Z',expires_at,expired:false,policy:'image_original_72h'}})
 expect(studioResultExpired(task,deadline-1)).toBe(false);expect(studioResultUrl(task,0,deadline-1)).toContain('/results/0')
 expect(studioResultExpired(task,deadline)).toBe(true);expect(()=>studioResultUrl(task,0,deadline)).toThrow('result_expired')
 const serverExpired={...task,resultRetention:{...task.resultRetention!,expiresAt:'2099-01-01T00:00:00Z',expired:true}}
 expect(()=>studioResultUrl(serverExpired)).toThrow('result_expired');expect(serverExpired).toMatchObject({status:'completed',resultCount:1,billingState:'billed'})
})
it('accepts an explicitly unknown legacy deadline and rejects malformed retention data',()=>{
 const result_retention={persisted_at:null,expires_at:null,expired:false,policy:'legacy_unknown'}
 expect(studioTaskView('video',{...retentionTask('video'),result_retention}).resultRetention?.expiresAt).toBeNull()
 for(const changed of [{expires_at:'not-a-date'},{persisted_at:123},{expired:'false'},{policy:'guess_from_quote'}])expect(()=>studioTaskView('video',{...retentionTask('video'),result_retention:{...result_retention,...changed}})).toThrow('studio_contract')
})
it('upstream error details are not displayed',()=>{
 expect(studioErrorMessage(new StudioError('synthetic-secret-response',503))).not.toContain('synthetic-secret-response');expect(studioErrorMessage(new StudioError('image_quote_expired',409))).toContain('报价已失效')
})
it('an in-flight session for a previous website identity cannot send a new business request',async()=>{
 localStorage.setItem('auth_token','synthetic-user-a');client.get.mockResolvedValueOnce({data:{id:1}}).mockResolvedValueOnce({data:{id:2}})
 let finish!:(v:Response)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>{finish=r})).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(JSON.stringify({offers:[]})));vi.stubGlobal('fetch',fetch)
 const old=studioRequest('image','catalog');const rejected=expect(old).rejects.toThrow('studio_session_changed');await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1))
 localStorage.setItem('auth_token','synthetic-user-b');const current=studioRequest('image','catalog');finish(new Response(JSON.stringify({owner_id:1})))
 await rejected;expect(await current).toEqual({offers:[]});expect(fetch.mock.calls.filter(c=>String(c[0]).endsWith('/catalog'))).toHaveLength(1);expect(client.get).toHaveBeenCalledTimes(2)
})
it('valid blocked and pending Core states remain recoverable without presenting success',()=>{
 for(const status of ['reserve_pending','recovery_blocked'])expect(studioTaskView('video',{contract:'account_video_v1',operation_id:'op_'+'a'.repeat(64),status,spec:{count:1},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'}}).resultCount).toBe(0)
})
it('displays a frozen total only when unit price and quantity agree without repricing legacy receipts',()=>{
 const legacy={contract:'published_image_binding_v1',task_id:'img_'+'b'.repeat(32),status:'prepared',spec:{count:4},sale_price:{amount:'0.70',currency:'CNY',billing_mode:'per_request'}}
 const old=studioTaskView('image',legacy);expect(old.price.amount).toBe('0.70');expect(old.unitPrice).toBeUndefined()
 const quoted={...legacy,unit_price:legacy.sale_price,total_price:{...legacy.sale_price,amount:'2.80'},quantity:4}
 expect(studioTaskView('image',quoted)).toMatchObject({quantity:4,unitPrice:{amount:'0.70'},price:{amount:'2.80'}})
 expect(()=>studioTaskView('image',{...quoted,total_price:{...quoted.total_price,amount:'2.81'}})).toThrow('studio_contract')
 expect(()=>studioTaskView('image',{...quoted,quantity:2})).toThrow('studio_contract')
 expect(()=>studioTaskView('image',{...legacy,spec:{count:11}})).toThrow('studio_contract')
})

it.each(['image','video'] as const)('prepares a private native credential for %s without caller Group or key',async kind=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockResolvedValue({data:{prepared:true}})
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(JSON.stringify({offers:[]})));vi.stubGlobal('fetch',fetch)
 await studioRequest(kind,'catalog')
 expect(client.post).toHaveBeenCalledWith('/keys/studio-access',{media:kind})
 expect(fetch.mock.calls[1][0]).toBe(`/studio-v2/api/${kind}/catalog`)
})
it('does not allocate credentials when reading or recovering an existing task',async()=>{
 client.get.mockResolvedValue({data:{id:2}})
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(JSON.stringify({tasks:[]})));vi.stubGlobal('fetch',fetch)
 await studioRequest('image','tasks');expect(client.post).not.toHaveBeenCalled()
})
it('credential preparation denial stops the business request',async()=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockRejectedValue(new Error('GROUP_NOT_ALLOWED'))
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({owner_id:2})));vi.stubGlobal('fetch',fetch)
 await expect(studioRequest('image','catalog')).rejects.toThrow('GROUP_NOT_ALLOWED');expect(fetch).toHaveBeenCalledTimes(1)
})
it('identity changes during credential preparation cannot cross into a business request',async()=>{
 localStorage.setItem('auth_token','first');client.get.mockResolvedValue({data:{id:2}})
 client.post.mockImplementation(async()=>{localStorage.setItem('auth_token','second');return {data:{prepared:true}}})
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({owner_id:2})));vi.stubGlobal('fetch',fetch)
 await expect(studioRequest('image','catalog')).rejects.toThrow('studio_session_changed');expect(fetch).toHaveBeenCalledTimes(1)
})

it('prepares credentials for catalog but not for readiness reads',async()=>{
 client.get.mockResolvedValue({data:{id:2}})
 client.post.mockResolvedValue({data:{prepared:true}})
 const fetch=vi.fn().mockImplementation(async(url:string)=>{
  if(url.endsWith('/session'))return new Response(JSON.stringify({owner_id:2}))
  return new Response(JSON.stringify(url.endsWith('/readiness')?{paid_enabled:true}:{offers:[]}))
 });vi.stubGlobal('fetch',fetch)
 const catalog=studioRequest('image','catalog'),readiness=studioRequest('image','readiness')
 expect(await readiness).toEqual({paid_enabled:true});expect(await catalog).toEqual({offers:[]})
 expect(client.post).toHaveBeenCalledTimes(1)
 expect(client.post).toHaveBeenCalledWith('/keys/studio-access',{media:'image'})
 expect(fetch.mock.calls.filter(call=>String(call[0]).endsWith('/readiness'))).toHaveLength(1)
})

it('cancels an unused session response before continuing the normal ticket exchange',async()=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockResolvedValue({data:{ticket:'synthetic-ticket'}})
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel})
 const fetch=vi.fn().mockResolvedValueOnce(new Response(body,{status:401})).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2})));vi.stubGlobal('fetch',fetch)
 expect(await ensureStudioSession()).toEqual({owner_id:2});expect(cancel).toHaveBeenCalledTimes(1)
 expect(client.post).toHaveBeenCalledWith('/auth/studio-media-ticket')
})
it('releases an unread session response when website identity changes after headers',async()=>{
 localStorage.setItem('auth_token','synthetic-a');client.get.mockResolvedValue({data:{id:1}})
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel})
 vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(async()=>{localStorage.setItem('auth_token','synthetic-b');return new Response(body,{status:401})}))
 await expect(ensureStudioSession()).rejects.toThrow('studio_session_changed');expect(cancel).toHaveBeenCalledTimes(1);expect(client.post).not.toHaveBeenCalled()
})

it('uses a private cover endpoint and preserves the original expiry gate',()=>{
 const task=studioTaskView('video',retentionTask('video'))
 expect(studioCoverUrl(task)).toBe(studioResultUrl(task).replace('/original','/cover'))
 expect(()=>studioCoverUrl({...task,resultRetention:{persistedAt:null,expiresAt:null,expired:true,policy:'video_original_48h'}})).toThrow('result_expired')
})
it('repairs an expired media session and probes only the original HEAD before playback retries',async()=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockResolvedValue({data:{ticket:'synthetic-ticket'}})
 const src='/studio-v2/api/video/operations/op_'+'c'.repeat(64)+'/original'
 const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(null,{headers:{'content-type':'video/mp4'}}));vi.stubGlobal('fetch',fetch)
 await recoverStudioMediaRead(src)
 expect(fetch.mock.calls[2]).toMatchObject([src,{method:'HEAD',credentials:'same-origin',redirect:'error'}])
 expect(client.post).toHaveBeenCalledTimes(1);expect(client.post).toHaveBeenCalledWith('/auth/studio-media-ticket')
 expect(fetch.mock.calls.some(c=>String(c[0]).endsWith('/tasks'))).toBe(false)
})
it.each([401,403,409,410,503])('keeps media HEAD status %s distinct from a successful retry',async status=>{
 client.get.mockResolvedValue({data:{id:2}})
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(null,{status})))
 const code=status===410?'result_expired':status===401?'login_required':'result_load_failed'
 await expect(recoverStudioMediaRead('/studio-v2/api/video/operations/op_'+'d'.repeat(64)+'/cover')).rejects.toThrow(code)
 expect(client.post).not.toHaveBeenCalled()
})
it('rejects external sources before authentication and refuses identity changes during a probe',async()=>{
 await expect(recoverStudioMediaRead('https://untrusted.invalid/studio-v2/api/video/operations/op_'+'e'.repeat(64)+'/original')).rejects.toThrow('studio_contract')
 expect(client.get).not.toHaveBeenCalled()
 localStorage.setItem('auth_token','first');client.get.mockResolvedValue({data:{id:2}})
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockImplementationOnce(async()=>{localStorage.setItem('auth_token','second');return new Response(null,{headers:{'content-type':'video/mp4'}})}))
 await expect(recoverStudioMediaRead('/studio-v2/api/video/operations/op_'+'e'.repeat(64)+'/original')).rejects.toThrow('studio_session_changed')
})


function quoteTransport() {
 client.get.mockResolvedValue({data:{id:2}})
 client.post.mockResolvedValue({data:{prepared:true}})
 const fetch=vi.fn().mockImplementation(async (url:string)=>new Response(JSON.stringify(url.endsWith('/session')?{owner_id:2}:{accepted:true})))
 vi.stubGlobal('fetch',fetch)
 return fetch
}
it.each(['image','video'] as const)('validates one session for a dependent %s quote sequence',async kind=>{
 const fetch=quoteTransport()
 await studioQuoteSequence(async request=>{await request(kind,'quotes',{});await request(kind,'prepare',{})})
 expect(client.get).toHaveBeenCalledTimes(1)
 expect(fetch.mock.calls.map(call=>call[0])).toEqual(['/studio-v2/api/session',`/studio-v2/api/${kind}/quotes`,`/studio-v2/api/${kind}/prepare`])
 expect(client.post).toHaveBeenCalledTimes(1)
 expect(client.post).toHaveBeenCalledWith('/keys/studio-access',{media:kind})
 // The same dependent operations through separate requests take seven browser
 // round trips; this scope takes five. No quotes or preparation were skipped.
 const scopedTrips=client.get.mock.calls.length+client.post.mock.calls.length+fetch.mock.calls.length
 expect(scopedTrips).toBe(5)
 vi.clearAllMocks()
 await studioRequest(kind,'quotes',{});await studioRequest(kind,'prepare',{})
 expect(client.get.mock.calls.length+client.post.mock.calls.length+fetch.mock.calls.length).toBe(7)
})
it('does not reuse session validation between independent quote sequences',async()=>{
 const fetch=quoteTransport()
 for(let i=0;i<2;i++)await studioQuoteSequence(request=>request('video','quotes',{}))
 expect(client.get).toHaveBeenCalledTimes(2)
 expect(fetch.mock.calls.filter(call=>call[0]==='/studio-v2/api/session')).toHaveLength(2)
})
it('rejects an identity change between dependent quote calls before preparing',async()=>{
 const fetch=quoteTransport();localStorage.setItem('auth_token','original')
 await expect(studioQuoteSequence(async request=>{await request('image','quotes',{});localStorage.setItem('auth_token','replacement');await request('image','prepare',{})})).rejects.toThrow('studio_session_changed')
 expect(fetch.mock.calls.filter(call=>String(call[0]).endsWith('/quotes'))).toHaveLength(1)
 expect(client.post).not.toHaveBeenCalled()
 expect(fetch.mock.calls.some(call=>String(call[0]).endsWith('/prepare'))).toBe(false)
})
it('rejects identity changes during scoped credential preparation',async()=>{
 const fetch=quoteTransport();localStorage.setItem('auth_token','original')
 client.post.mockImplementationOnce(async()=>{localStorage.setItem('auth_token','replacement');return {data:{prepared:true}}})
 await expect(studioQuoteSequence(request=>request('image','prepare',{}))).rejects.toThrow('studio_session_changed')
 expect(fetch).toHaveBeenCalledTimes(1)
})
it('does not retry a rejected quote or run its dependent preparation',async()=>{
 const fetch=quoteTransport()
 fetch.mockImplementation(async (url:string)=>new Response(JSON.stringify(url.endsWith('/session')?{owner_id:2}:{error:'image_quote_expired'}),{status:url.endsWith('/session')?200:409}))
 await expect(studioQuoteSequence(async request=>{await request('image','quotes',{});await request('image','prepare',{})})).rejects.toThrow('image_quote_expired')
 expect(fetch).toHaveBeenCalledTimes(2);expect(client.post).not.toHaveBeenCalled()
})
it('does not enter a quote sequence when official authentication fails',async()=>{
 quoteTransport();client.get.mockRejectedValueOnce(new Error('auth unavailable'));const action=vi.fn()
 await expect(studioQuoteSequence(action)).rejects.toThrow('auth unavailable');expect(action).not.toHaveBeenCalled()
})

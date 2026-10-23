import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

async function localBff() {
 const {createAccountVideoRuntime,VIDEO_CONTRACT}=await import(new URL('../../../studio/bff/video-account.mjs',import.meta.url).href)
 const {createVideoHandler}=await import(new URL('../../../studio/bff/video-handler.mjs',import.meta.url).href)
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-status-browser-'))
 const owner={ownerId:9001,sessionProof:'synthetic-local-session'}
 const states=new Map<string,any>(),quotes=new Map<string,any>()
 let posts=0,polls=0,snapshots=0
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
 const profile={apiModelId:'3.0',upstreamModelId:'synthetic-video',documentedStatus:'enabled',inputMode:'images',durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:0,video:0,audio:0,total:0}}
 const call=async(_session:any,method:string,operation:string,payload:any,keyRef:number)=>{
  if(operation==='catalog')return {payload:{offers:[{offer_id:'video-standard',model:'3.0',video_profile:profile}]}}
  if(operation==='quotes'){
   const binding={version:VIDEO_CONTRACT,quote_id:'quote-'+quotes.size,owner:{user_id:9001,api_key_id:2,group_id:3},published_revision:'synthetic-published',offer:{offer_id:'video-standard',account_id:7,site_model:'3.0',adapter:{revision:'laoli_video_json_v136_r1'},sale_price:{amount:'1',currency:'CNY',billing_mode:'per_request'}},spec:payload.spec,request_hash:hash(JSON.stringify(payload.request)),expires_at:'2099-01-01T00:00:00Z'}
   const quote={contract:VIDEO_CONTRACT,quote_token:hash(binding.quote_id),binding_hash:hash(JSON.stringify(binding)),binding}
   quotes.set(quote.quote_token,quote);return {key_ref:2,payload:quote}
  }
  expect(keyRef).toBe(2)
  if(operation==='tasks'){
   expect(method).toBe('POST');posts++;const q=quotes.get(payload.quote_token)
   states.set(payload.task_id,{contract:VIDEO_CONTRACT,task_id:payload.task_id,upstream_id:'synthetic-'+posts,status:'processing',binding_hash:q.binding_hash,request_hash:q.binding.request_hash})
   return {key_ref:2,payload:{}}
  }
  const [,id,action]=operation.split('/'),state=states.get(id)
  expect(method).toBe('GET');expect(state).toBeTruthy()
  if(action==='snapshot')snapshots++;else {expect(action).toBeUndefined();polls++}
  return {key_ref:2,payload:state}
 }
 const make=()=>createAccountVideoRuntime({rootDir:root,call,resultStore:{metadata:()=>undefined}})
 const seed=make(),operations=[]
 for(let n=0;n<2;n++){
  const op=await seed.prepare(owner,{clientKey:'history-'+n,offerId:'video-standard',request:{model:'3.0',prompt:'synthetic fixture '+n,duration:5,resolution:'720p',ratio:'16:9',assets:[]}})
  await seed.dispatch(owner,op.operation_id);operations.push(op)
 }
 const success=operations[0],failure=operations[1]
 states.get(success.children[0].task_id).status='captured'
 states.get(success.children[0].task_id).result_retention={policy:'video_original_48h',persisted_at:'2026-10-23T00:48:32Z',expires_at:'2099-10-25T00:48:32Z',expired:false}
 states.get(failure.children[0].task_id).status='released'
 // Restart over the original accepted journals; the list must use native final states.
 const server=http.createServer(createVideoHandler({sessions:{authenticate:async()=>owner},tasks:make()}))
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 return {url:`http://127.0.0.1:${(server.address() as any).port}`,success,failure,counts:()=>({posts,polls,snapshots}),
  close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true})}}
}

for(const width of [1440,390])test(`video history retains success and refund across refresh ${width}`,async({page},info)=>{
 const bff=await localBff(),before=bff.counts()
 try{
  await page.setViewportSize({width,height:width===1440?1000:844})
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.addInitScript(()=>{
   sessionStorage.setItem('studio-media-view-9001',JSON.stringify({kind:'video',view:'compose'}))
   sessionStorage.setItem('studio-visual-fixture-video-history-real-bff',JSON.stringify({image:[],video:[]}))
  })
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort())
  await page.route('**/studio-v2/api/video/operations**',async route=>{
   const url=new URL(route.request().url())
   if(url.pathname.endsWith('/original')){await route.fulfill({path:fileURLToPath(new URL('./retention-video.mp4',import.meta.url)),contentType:'video/mp4'});return}
   expect(route.request().method()).toBe('GET')
   const response=await route.fetch({url:bff.url+url.pathname});await route.fulfill({response})
  })
  await page.goto('/tests/studio-workspace/index.html?scenario=video-history-real-bff')
  await page.getByTestId('studio-mode-history').click()
  const success=page.locator(`[data-task-id="${bff.success.operation_id}"] .studio-work-state`)
  const failure=page.locator(`[data-task-id="${bff.failure.operation_id}"] .studio-work-state`)
  await expect(success).toContainText('生成完成');await expect(failure).toContainText('生成失败，费用已释放')
  await page.getByRole('button',{name:'刷新记录',exact:true}).click()
  await expect(success).toContainText('生成完成');await expect(failure).toContainText('生成失败，费用已释放')
  await page.screenshot({path:info.outputPath(`history-${width}.png`),fullPage:true})
  expect(bff.counts().posts).toBe(before.posts);expect(bff.counts().polls).toBe(before.polls);expect(bff.counts().snapshots).toBeGreaterThan(0)
  await page.reload();await page.getByTestId('studio-mode-history').click()
  await expect(success).toContainText('生成完成');await expect(failure).toContainText('费用已释放')
  expect(bff.counts().posts).toBe(before.posts);expect(bff.counts().polls).toBe(before.polls)

  await page.goto('/tests/studio-workspace/index.html?scenario=empty')
  await page.getByTestId('studio-prompt').fill('本地报价文字验收')
  await page.getByTestId('studio-quote').click()
  const dialog=page.getByRole('dialog',{name:'确认本次生成'})
  await expect(dialog).toContainText('价格已锁定，尚未冻结余额。确认后将冻结对应余额。')
  await expect(page.getByTestId('studio-status')).toContainText('报价已锁定')
  await page.screenshot({path:info.outputPath(`quote-${width}.png`),fullPage:true})
  expect(bff.counts().posts).toBe(before.posts)
 }finally{await bff.close()}
})

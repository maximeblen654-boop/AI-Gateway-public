<template>
  <section class="rounded-2xl border border-teal-200 p-5" data-testid="studio-media-panel">
    <h2 class="text-lg font-semibold">素材工作台</h2>
    <label>类型<select v-model="kind" class="input" data-testid="studio-kind" :disabled="busy" @change="load"><option value="video">视频</option><option value="image">图片</option></select></label>
    <fieldset :disabled="busy || !!active" class="grid gap-3 md:grid-cols-3 mt-3">
      <label>模型<select v-model="offerId" class="input" data-testid="studio-offer-select" @change="selectOffer"><option v-for="o in offers" :key="o.offer_id" :value="o.offer_id">{{ o.display_name || o.upstream_model }}</option></select></label>
      <p v-if="offer" class="text-sm">内部 ID: {{ offer.model }}</p>
      <label v-if="offer?.spec.resolution?.length">分辨率<select v-model="resolution" class="input" data-testid="studio-resolution"><option v-for="v in offer.spec.resolution" :key="v">{{ v }}</option></select></label>
      <label v-if="kind === 'video'">时长<select v-model.number="duration" class="input" data-testid="studio-duration"><option v-for="v in offer?.spec.duration_seconds" :key="v" :value="v">{{ v }} 秒</option></select></label>
      <label v-if="offer?.spec.aspect_ratio?.length">比例<select v-model="ratio" class="input" data-testid="studio-ratio"><option v-for="v in offer.spec.aspect_ratio" :key="v">{{ v }}</option></select></label>
      <label v-if="kind === 'image' && offer?.spec.quality?.length">品质<select v-model="quality" class="input"><option v-for="v in offer.spec.quality" :key="v">{{ v }}</option></select></label>
      <label v-if="kind === 'image'">数量<input v-model.number="count" type="number" :min="offer?.spec.count.min" :max="offer?.spec.count.max" class="input" data-testid="studio-count" /></label>
      <label>提示词<textarea v-model="prompt" placeholder="描述你想生成的内容" class="input" data-testid="studio-prompt" /></label>
      <label>素材<input type="file" :accept="accept" :disabled="!offer || !accept" data-testid="studio-asset-input" @change="upload" /></label>
      <ol class="my-3"><li v-for="(a,i) in assets" :key="a.asset_ref">{{ i + 1 }}. {{ a.kind }} · {{ a.size }} bytes · 已保存 <button type="button" class="btn btn-secondary" @click="assets.splice(i,1)">移除</button></li></ol>
    </fieldset>
    <p v-if="!offers.length">暂无可用模型：模型可能尚未配置、已暂停或没有访问权限。</p>
    <p v-if="incompatible && !active" role="alert">当前模型不支持这些素材类型或数量，请调整素材。</p>
    <p v-if="offer?.input_mode === 'references' && assets.length && !active">点击下方准备按钮会将引用素材上传到所选模型的供应商，随后显示报价；确认生成前不会创建生成任务。</p>
    <button v-if="!active" class="btn btn-primary" :disabled="busy || !offer || incompatible || !prompt.trim()" data-testid="studio-quote" @click="quote">{{ busy ? '处理中…' : '准备素材并获取报价' }}</button>
    <p v-if="!enabled" data-testid="studio-gate">当前生成服务未开放，仍可查看报价和已有结果。</p>
    <p v-if="error" role="alert" data-testid="studio-error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="active" class="mt-4 space-y-2" data-testid="studio-task">
      <p>已冻结：{{ taskModel(active) }} · {{ specText(active) }}</p>
      <p data-testid="studio-price">本次报价：{{ active.price.amount }} {{ active.price.currency }}</p>
      <p v-if="active.status === 'prepared'">{{ expired ? '报价已失效，请重新获取报价并确认。' : `报价有效至 ${new Date(active.expiresAt).toLocaleString()}` }}</p>
      <p data-testid="studio-task-id">任务：{{ active.id }}</p>
      <p data-testid="studio-status" aria-live="polite">{{ statusText(active.status) }}</p>
      <p v-if="active.status === 'unknown'">结果待确认。系统只查询原任务，不会自动再次生成或更换供应商。</p>
      <button v-if="active.status === 'prepared'" class="btn btn-primary" data-testid="studio-generate" :disabled="busy || !enabled || expired" @click="generate">确认报价并生成</button>
      <button class="btn btn-secondary" data-testid="studio-refresh" :disabled="querying || busy" @click="refresh">查询原任务</button>
      <button v-if="['prepared','completed','failed','released'].includes(active.status)" class="btn btn-secondary" data-testid="studio-new" :disabled="busy" @click="newTask">{{ active.status === 'prepared' ? '调整输入并重新报价' : '新建任务' }}</button>
      <div v-if="active.status === 'completed'" class="grid gap-3" data-testid="studio-results">
        <div v-for="i in active.resultCount" :key="`${active.id}-${i}`">
          <img v-if="kind === 'image'" :src="studioResultUrl(active,i-1)" class="max-h-96 max-w-full" :alt="`生成图片 ${i}`" data-testid="studio-result-image" />
          <video v-else :src="studioResultUrl(active,i-1)" class="max-h-96 max-w-full" controls preload="metadata" data-testid="studio-result-video" />
          <a :href="studioResultUrl(active,i-1)" :download="`${active.id}-${i}`" class="btn btn-secondary" data-testid="studio-download">下载原始结果 {{ i }}</a>
        </div>
      </div>
    </div>
    <div class="mt-5">
      <h3 class="font-semibold">我的{{ kind === 'image' ? '图片' : '视频' }}任务</h3>
      <p class="text-sm">记录来自服务器；刷新或重新登录后可在此查询原任务。</p>
      <button class="btn btn-secondary" :disabled="busy || querying" @click="reloadHistory">刷新记录</button>
      <ul><li v-for="task in history" :key="task.id"><button class="btn btn-secondary my-1" :disabled="busy" :data-task-id="task.id" @click="selectTask(task)">{{ taskModel(task) }} · {{ task.price.amount }} {{ task.price.currency }} · {{ statusText(task.status) }} · {{ task.id }}</button></li></ul>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ensureStudioSession, studioCatalog, studioRequest, studioTaskView, studioHistory, studioTask, studioGenerate, studioResultUrl, studioErrorMessage, StudioError, uploadStudioAsset, type StudioOffer, type StudioKind, type StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'
const kind=ref<StudioKind>('video'), offers=ref<StudioOffer[]>([]), offerId=ref(''), assets=ref<StudioAssetReceipt[]>([])
const resolution=ref(''), ratio=ref(''), quality=ref(''), count=ref(1), duration=ref(5), prompt=ref('')
const busy=ref(false), querying=ref(false), enabled=ref(false), error=ref(''), notice=ref(''), history=ref<StudioTask[]>([]), active=ref<StudioTask|null>(null), clock=ref(Date.now())
const offer=computed(()=>offers.value.find(o=>o.offer_id===offerId.value))
const accept=computed(()=>['image','video','audio'].filter(k=>offer.value?.spec.references[k as StudioAssetReceipt['kind']].max).map(k=>`${k}/*`).join(','))
const incompatible=computed(()=>!offer.value || ['image','video','audio'].some(k=>{const n=assets.value.filter(a=>a.kind===k).length;const r=offer.value!.spec.references[k as StudioAssetReceipt['kind']];return n<r.min || n>r.max}) || assets.value.length>offer.value.spec.references.total_max)
const expired=computed(()=>!active.value || !Number.isFinite(Date.parse(active.value.expiresAt)) || clock.value>=Date.parse(active.value.expiresAt))
let storage='', attempted=new Set<string>(), intent:{fingerprint:string;clientKey:string;preparationId?:string;quoteToken?:string}|undefined
let generation=0, timer:ReturnType<typeof setInterval>|undefined, polling=false, mounted=true
const statuses:Record<string,string>={prepared:'报价已冻结，等待确认生成',processing:'生成中',queued:'排队中',completed:'生成完成，原始结果已保存',unknown:'结果待确认',billing_pending:'结果已保存，结算待确认',failed:'生成失败',released:'生成失败，费用已释放',reserve_pending:'结果待确认：费用预占处理中，请查询原任务',recovery_blocked:'结果待确认：原任务身份暂不可用，恢复受阻'}
const statusText=(status:string)=>statuses[status]||'结果待确认'
const taskModel=(task:StudioTask)=>offers.value.find(o=>o.offer_id===task.offerId)?.display_name||task.model||'已冻结的历史模型'
const specText=(task:StudioTask)=>[task.spec.resolution,task.spec.aspect_ratio,task.spec.duration_seconds?`${task.spec.duration_seconds}秒`:'',`${task.spec.count??1}份`].filter(Boolean).join(' / ')
function remember(){if(storage)sessionStorage.setItem(storage,JSON.stringify({kind:kind.value,id:active.value?.id,attempted:[...attempted]}))}
function accepted(task:StudioTask){if(task.status==='prepared'&&attempted.has(task.id))task={...task,status:'unknown'};active.value=task;history.value=[task,...history.value.filter(t=>t.id!==task.id)];remember()}
function selectOffer(){const s=offer.value?.spec;resolution.value=s?.resolution?.[0]||'';ratio.value=s?.aspect_ratio?.[0]||'';quality.value=s?.quality?.[0]||'';duration.value=s?.duration_seconds?.[0]||0;count.value=s?.count.min||1;intent=undefined}
function newTask(){if(busy.value || !active.value || !['prepared','completed','failed','released'].includes(active.value.status))return;active.value=null;intent=undefined;error.value='';notice.value='';remember()}
async function load(selectedId?:unknown){const epoch=++generation;busy.value=true;error.value='';active.value=null;enabled.value=false;offers.value=[];history.value=[];try{
 const [catalog,tasks,readiness]=await Promise.allSettled([studioCatalog(kind.value),studioHistory(kind.value),studioRequest<{paid_enabled:boolean}>(kind.value,'readiness')]);
 if(epoch!==generation)return;
 if(catalog.status==='fulfilled')offers.value=catalog.value;
 if(readiness.status==='fulfilled')enabled.value=readiness.value.paid_enabled===true;
 if(tasks.status==='rejected')throw tasks.reason;
 history.value=tasks.value;
 if(catalog.status==='rejected'||readiness.status==='rejected')notice.value='目录或生成服务暂不可用，仍可查询原任务和已保存结果。';
 if(!offers.value.some(o=>o.offer_id===offerId.value)){offerId.value=offers.value[0]?.offer_id||'';selectOffer()}
 const restored=history.value.find(t=>t.id===selectedId)||history.value[0];if(restored)accepted(restored);remember()
 }catch(e){error.value=studioErrorMessage(e)}finally{if(epoch===generation)busy.value=false}
 if(active.value)await refresh()
}
async function reloadHistory(){if(busy.value||querying.value)return;const epoch=generation,originalKind=kind.value;querying.value=true;try{const tasks=await studioHistory(originalKind);if(epoch===generation&&originalKind===kind.value)history.value=tasks}catch(e){if(epoch===generation)error.value=studioErrorMessage(e)}finally{querying.value=false}}
async function selectTask(task:StudioTask){if(busy.value)return;error.value='';accepted(task);await refresh()}
async function refresh(){if(!active.value||querying.value)return;const original=active.value;querying.value=true;try{const task=await studioTask(original);if(active.value?.id===original.id&&kind.value===original.kind){accepted(task);error.value=''}}catch(e){error.value=studioErrorMessage(e)}finally{querying.value=false}}
async function upload(e:Event){const input=e.target as HTMLInputElement,f=input.files?.[0];if(!f||busy.value||active.value)return;busy.value=true;error.value='';notice.value='素材上传中…';try{
 await ensureStudioSession();const k=f.type.split('/')[0] as StudioAssetReceipt['kind'];if(!['image','video','audio'].includes(k))throw new StudioError('asset_type_mismatch');assets.value.push(await uploadStudioAsset(f,k));notice.value='素材已私有保存，顺序如上。'
 }catch(e){notice.value='';error.value=studioErrorMessage(e)}finally{busy.value=false;input.value=''}}
async function quote(){if(busy.value||active.value||!offer.value||incompatible.value||!prompt.value.trim())return;busy.value=true;error.value='';notice.value='';try{
 const o=offer.value,refs=assets.value.map(a=>({kind:a.kind,asset_ref:a.asset_ref})),spec={resolution:resolution.value,aspect_ratio:ratio.value,duration_seconds:kind.value==='video'?duration.value:0,quality:kind.value==='image'?quality.value:'',count:kind.value==='image'?count.value:1,images:refs.filter(a=>a.kind==='image').length,videos:refs.filter(a=>a.kind==='video').length,audio:refs.filter(a=>a.kind==='audio').length}
 const fingerprint=JSON.stringify({kind:kind.value,offer:o.offer_id,spec,refs,prompt:prompt.value});if(intent?.fingerprint!==fingerprint)intent={fingerprint,clientKey:crypto.randomUUID()}
 if(kind.value==='video'){
   if(o.input_mode==='references'&&assets.value.length&&!intent.preparationId){const p=await studioRequest<{preparation_id:string}>('video','prepare',{offer_id:o.offer_id,model:o.model,spec,assets:refs});if(typeof p.preparation_id!=='string')throw new StudioError('studio_contract');intent.preparationId=p.preparation_id}
   accepted(studioTaskView('video',await studioRequest('video','quotes',{client_key:intent.clientKey,offer_id:o.offer_id,model:o.model,prompt:prompt.value,duration:spec.duration_seconds,resolution:spec.resolution,ratio:spec.aspect_ratio,assets:refs,...(intent.preparationId?{preparation_id:intent.preparationId}:{})})))
 }else{
   if(!intent.quoteToken){const q=await studioRequest<{quote_token:string}>('image','quotes',{offer_id:o.offer_id,spec});if(typeof q.quote_token!=='string')throw new StudioError('studio_contract');intent.quoteToken=q.quote_token}
   accepted(studioTaskView('image',await studioRequest('image','prepare',{quote_token:intent.quoteToken,client_key:intent.clientKey,prompt:prompt.value,asset_refs:refs.map(a=>a.asset_ref)})))
 }
 }catch(e){error.value=studioErrorMessage(e);history.value=await studioHistory(kind.value).catch(()=>history.value)}finally{busy.value=false}}
async function generate(){if(busy.value||!active.value||active.value.status!=='prepared'||!enabled.value||expired.value)return;
 const task=active.value;busy.value=true;error.value='';attempted.add(task.id);accepted({...task,status:'unknown'});
 try{accepted(await studioGenerate(task))}catch(e){if(e instanceof StudioError&&(e.code.includes('paid_gate_off')||e.code.endsWith('quote_expired'))){attempted.delete(task.id);accepted(task)}error.value=studioErrorMessage(e)}finally{busy.value=false}
}
onMounted(async()=>{try{const session=await ensureStudioSession();storage=`studio-media-view-${session.owner_id}`;let selected:unknown;try{const raw=JSON.parse(sessionStorage.getItem(storage)||'{}');if(raw.kind==='image'||raw.kind==='video')kind.value=raw.kind;selected=raw.id;if(Array.isArray(raw.attempted))attempted=new Set(raw.attempted.filter((id:unknown)=>typeof id==='string'))}catch{/* Server history remains authoritative. */}await load(selected)}catch(e){error.value=studioErrorMessage(e)}
 if(mounted)timer=setInterval(()=>{clock.value=Date.now();if(!polling&&!busy.value&&active.value&&['unknown','processing','queued','billing_pending'].includes(active.value.status)){polling=true;void refresh().finally(()=>{polling=false})}},3000)
})
onUnmounted(()=>{mounted=false;generation++;if(timer)clearInterval(timer)})
</script>

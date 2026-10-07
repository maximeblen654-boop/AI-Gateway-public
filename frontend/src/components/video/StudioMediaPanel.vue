<template>
  <section class="rounded-2xl border border-teal-200 p-5" data-testid="studio-media-panel">
    <h2 class="text-lg font-semibold">素材工作台</h2>
    <div class="grid gap-3 md:grid-cols-3 mt-3">
      <label>类型<select v-model="kind" class="input" data-testid="studio-kind" @change="load"><option value="video">视频</option><option value="image">图片</option></select></label>
      <label>模型<select v-model="offerId" class="input" data-testid="studio-offer-select" @change="selectOffer"><option v-for="o in offers" :key="o.offer_id" :value="o.offer_id">{{ o.display_name || o.upstream_model }}</option></select></label>
      <p v-if="offer" class="text-sm">内部 ID: {{ offer.model }}</p>
      <label v-if="offer?.spec.resolution?.length">分辨率<select v-model="resolution" class="input" data-testid="studio-resolution"><option v-for="v in offer.spec.resolution" :key="v">{{ v }}</option></select></label>
      <label v-if="kind === 'video'">时长<select v-model.number="duration" class="input" data-testid="studio-duration"><option v-for="v in offer?.spec.duration_seconds" :key="v" :value="v">{{ v }} 秒</option></select></label>
      <label v-if="offer?.spec.aspect_ratio?.length">比例<select v-model="ratio" class="input" data-testid="studio-ratio"><option v-for="v in offer.spec.aspect_ratio" :key="v">{{ v }}</option></select></label>
      <label>提示词<textarea v-model="prompt" placeholder="描述你想生成的内容" class="input" data-testid="studio-prompt" /></label>
      <label>素材<input type="file" :accept="accept" :disabled="busy || !offer" data-testid="studio-asset-input" @change="upload" /></label>
    </div>
    <ol class="my-3"><li v-for="(a,i) in assets" :key="a.asset_ref">{{ i + 1 }}. {{ a.kind }} · {{ a.size }} bytes <button class="btn btn-secondary" :disabled="busy" @click="assets.splice(i,1);save()">移除</button></li></ol>
    <p v-if="incompatible" role="alert">当前模型不支持这些素材类型或数量，请调整素材。</p>
    <button class="btn btn-primary" :disabled="busy || !offer || incompatible" data-testid="studio-quote" @click="quote">{{ busy ? '处理中…' : '准备素材并获取报价' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p data-testid="studio-status">{{ status }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ensureStudioSession, studioCatalog, studioRequest, uploadStudioAsset, type StudioOffer } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'
const kind=ref<'image'|'video'>('video'), offers=ref<StudioOffer[]>([]), offerId=ref(''), assets=ref<StudioAssetReceipt[]>([])
const resolution=ref(''), ratio=ref(''), duration=ref(5), prompt=ref(''), busy=ref(false), error=ref(''), status=ref('')
const offer=computed(()=>offers.value.find(o=>o.offer_id===offerId.value))
const accept=computed(()=>['image','video','audio'].filter(k=>offer.value?.spec.references[k as StudioAssetReceipt['kind']].max).map(k=>`${k}/*`).join(','))
const incompatible=computed(()=>!offer.value || ['image','video','audio'].some(k=>{const n=assets.value.filter(a=>a.kind===k).length;const r=offer.value!.spec.references[k as StudioAssetReceipt['kind']];return n<r.min || n>r.max}) || assets.value.length>offer.value.spec.references.total_max)
let storage='', intent:{fingerprint:string;clientKey:string;preparationId?:string;quoteToken?:string}|undefined
function save(){if(storage)sessionStorage.setItem(storage,JSON.stringify({kind:kind.value,offerId:offerId.value,assets:assets.value,resolution:resolution.value,ratio:ratio.value,duration:duration.value,prompt:prompt.value,intent,status:status.value}))}
function selectOffer(){const s=offer.value?.spec;resolution.value=s?.resolution?.[0]||'';ratio.value=s?.aspect_ratio?.[0]||'';duration.value=s?.duration_seconds?.[0]||0;save()}
async function load(){busy.value=true;error.value='';try{offers.value=await studioCatalog(kind.value);if(!offers.value.some(o=>o.offer_id===offerId.value)){offerId.value=offers.value[0]?.offer_id||'';selectOffer()}if(!offers.value.length)status.value='暂无可用模型'}catch(e){error.value=String(e)}finally{busy.value=false}}
async function upload(e:Event){const input=e.target as HTMLInputElement,f=input.files?.[0];if(!f)return;busy.value=true;error.value='';try{const k=f.type.split('/')[0] as StudioAssetReceipt['kind'];if(!['image','video','audio'].includes(k))throw Error('不支持的素材类型');assets.value.push(await uploadStudioAsset(f,k));status.value='素材已保存';save()}catch(e){error.value=String(e)}finally{busy.value=false;input.value=''}}
async function quote(){if(!offer.value)return;busy.value=true;error.value='';try{
 const o=offer.value,refs=assets.value.map(a=>({kind:a.kind,asset_ref:a.asset_ref})),spec={resolution:resolution.value,aspect_ratio:ratio.value,duration_seconds:kind.value==='video'?duration.value:0,quality:o.spec.quality?.[0]||'',count:1,images:refs.filter(a=>a.kind==='image').length,videos:refs.filter(a=>a.kind==='video').length,audio:refs.filter(a=>a.kind==='audio').length}
 const fingerprint=JSON.stringify({kind:kind.value,offer:o.offer_id,spec,refs,prompt:prompt.value});if(intent?.fingerprint!==fingerprint)intent={fingerprint,clientKey:crypto.randomUUID()};save()
 if(kind.value==='video'){
   // The server's Published catalog identifies the applicable input protocol.
   if(o.input_mode==='references'&&assets.value.length&&!intent.preparationId){const p=await studioRequest<{preparation_id:string}>('video','prepare',{offer_id:o.offer_id,model:o.model,spec,assets:refs});intent.preparationId=p.preparation_id;save()}
   const result=await studioRequest<{operation_id:string}>('video','quotes',{client_key:intent.clientKey,offer_id:o.offer_id,model:o.model,prompt:prompt.value,duration:spec.duration_seconds,resolution:spec.resolution,ratio:spec.aspect_ratio,assets:refs,...(intent.preparationId?{preparation_id:intent.preparationId}:{})});status.value=`报价已冻结，操作 ${result.operation_id}`
 }else{
   if(!intent.quoteToken){const q=await studioRequest<{quote_token:string}>('image','quotes',{offer_id:o.offer_id,spec});intent.quoteToken=q.quote_token;save()}
   const r=await studioRequest<{task_id:string}>('image','prepare',{quote_token:intent.quoteToken,client_key:intent.clientKey,prompt:prompt.value,asset_refs:refs.map(a=>a.asset_ref)});status.value=`图片请求已准备，操作 ${r.task_id}`
 }save()
 }catch(e){error.value=String(e)}finally{busy.value=false}}
onMounted(async()=>{try{const s=await ensureStudioSession();storage=`studio-media-${s.owner_id}`;const raw=sessionStorage.getItem(storage);if(raw){const v=JSON.parse(raw);kind.value=v.kind;offerId.value=v.offerId;assets.value=v.assets;resolution.value=v.resolution;ratio.value=v.ratio;duration.value=v.duration;prompt.value=v.prompt;intent=v.intent;status.value=v.status}await load()}catch(e){error.value=String(e)}})
</script>

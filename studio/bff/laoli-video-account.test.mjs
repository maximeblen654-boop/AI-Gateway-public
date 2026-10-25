import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccountVideoRuntime,VIDEO_CONTRACT} from './video-account.mjs';
import {createOperationJournal} from './operation-journal.js';

const revision='laoli_video_openai_20261024_r1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const session={ownerId:1,sessionProof:'fixture'};
const profile={apiModelId:'3.0',upstreamModelId:'3.0',documentedStatus:'enabled',inputMode:'laoli_openai_20261024',
 durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:9,video:0,audio:0,total:9}};
const request={model:'3.0',prompt:'fixture',duration:5,resolution:'720p',ratio:'16:9',assets:[]};

function fixture(t,mutateQuote=()=>{}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'laoli-quote-revision-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const counts={catalog:0,quotes:0};
 const runtime=createAccountVideoRuntime({rootDir:root,resultStore:{},call:async(s,method,operation,payload)=>{
  assert.equal(s.ownerId,1);
  if(operation==='catalog') {
   assert.equal(method,'GET');counts.catalog++;
   return{payload:{offers:[{offer_id:'laoli-offer',model:'3.0',video_profile:profile}]}};
  }
  assert.equal(operation,'quotes','preparing intent must not submit a generation or perform recovery');
  assert.equal(method,'POST');counts.quotes++;
  assert.equal(payload.request.model,'3.0');assert.equal(payload.request.seconds,5);assert.equal(payload.request.duration,undefined);
  const binding={version:VIDEO_CONTRACT,quote_id:'quote-id',owner:{user_id:1,api_key_id:2,group_id:3},published_revision:'pub',
   offer:{offer_id:'laoli-offer',account_id:7,site_model:'3.0',upstream_model:'3.0',adapter:{revision:'laoli_video_json_v136_r1'},sale_price:{amount:'1',currency:'CNY',billing_mode:'per_request'}},
   spec:payload.spec,request_hash:hash(JSON.stringify(payload.request)),expires_at:new Date(Date.now()+120000).toISOString()};
  const quote={contract:VIDEO_CONTRACT,quote_token:'a'.repeat(64),binding_hash:hash(JSON.stringify(binding)),binding,plan_adapter_revision:revision};
  mutateQuote(quote);
  return{key_ref:2,payload:quote};
 }});
 return{journal:createOperationJournal({rootDir:root}),counts,prepare:()=>runtime.prepare(session,{clientKey:'new-laoli-quote',offerId:'laoli-offer',request})};
}

test('new Laoli prepare creates an intent using the Core frozen plan revision and retains the generic Offer binding',async t=>{
 const f=fixture(t),prepared=await f.prepare();
 assert.equal(prepared.status,'intent');
 const op=f.journal.getForOwner(session.ownerId,prepared.operation_id),account=op.children[0].account;
 assert.equal(account.binding.offer.adapter.revision,'laoli_video_json_v136_r1');
 assert.equal(account.plan_adapter_revision,revision);assert.equal(account.plan.adapterRevision,revision);
 assert.deepEqual(f.counts,{catalog:1,quotes:1});
});

test('new Laoli rejects a tampered quoted frozen plan revision before persisting an intent',async t=>{
 const f=fixture(t,q=>{q.plan_adapter_revision='core_grok_video_r1'});
 await assert.rejects(f.prepare(),/Quote binding mismatch/);
 assert.equal(f.journal.getByClientKey(session.ownerId,'new-laoli-quote'),null);
 assert.deepEqual(f.counts,{catalog:1,quotes:1});
});

test('new Laoli fails closed if the Core quote omits the frozen plan revision',async t=>{
 const f=fixture(t,q=>{delete q.plan_adapter_revision});
 await assert.rejects(f.prepare(),/Quote binding mismatch/);
 assert.equal(f.journal.getByClientKey(session.ownerId,'new-laoli-quote'),null);
});

test('new Laoli cannot use Offer revision fallback even when a missing-field quote advertises the new revision',async t=>{
 const f=fixture(t,q=>{delete q.plan_adapter_revision;q.binding.offer.adapter.revision=revision});
 await assert.rejects(f.prepare(),/Quote binding mismatch/);
 assert.equal(f.journal.getByClientKey(session.ownerId,'new-laoli-quote'),null);
});

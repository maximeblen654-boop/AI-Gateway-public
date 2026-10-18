import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoAssetResolver} from './video-assets.mjs';
const session={ownerId:1};
function fixture(limits={image:30,video:0,audio:0,total:30},size=8){
 let reads=0;
 const intake={uploadPayload(_owner,id){reads++;return {kind:id.split('_')[0],size,bytes:Buffer.alloc(8),mimeType:'image/png',sha256:'fixture'}},inlineReceipt(_owner,id){return id}};
 const tasks={catalog:async()=>({offers:[{offer_id:'o',model:'m',video_profile:{documentedStatus:'enabled',inputMode:'inline_multimedia',mediaLimits:limits}}]})};
 return {resolve:createVideoAssetResolver({intake,tasks}),reads:()=>reads};
}
const refs=(kind,n)=>Array.from({length:n},(_,i)=>({kind,asset_ref:`${kind}_${i}`}));
for(const n of [0,1,16,20,30,31])test(`bounded material resolution ${n}`,async()=>{
 const f=fixture(),run=()=>f.resolve(session,refs('image',n),'o','m',{});
 if(n<=30){assert.equal((await run()).length,n);assert.equal(f.reads(),n)}
 else {await assert.rejects(run,/media_reference_limit_exceeded/);assert.equal(f.reads(),0)}
});
test('per-category and aggregate caps reject before reading bytes',async()=>{
 for(const assets of [refs('video',1),refs('audio',1)]) {const f=fixture();await assert.rejects(()=>f.resolve(session,assets,'o','m',{}),/limit/);assert.equal(f.reads(),0)}
 const f=fixture({image:30,video:10,audio:10,total:30});
 assert.equal((await f.resolve(session,[...refs('image',20),...refs('video',5),...refs('audio',5)],'o','m',{})).length,30);
});
test('byte budget stops retained base64 expansion',async()=>{
 const f=fixture(undefined,10*1024*1024);
 await assert.rejects(()=>f.resolve(session,refs('image',30),'o','m',{}),/media_request_too_large/);
 assert.equal(f.reads(),2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createOperationJournal} from './operation-journal.js';
import {createAccountVideoRuntime} from './video-account.mjs';
import {legacyRecoveryFromEnvironment} from './video-legacy-recovery.mjs';
import {createLegacySupplier,createLegacyLedger} from './legacy-clients.mjs';

const session={ownerId:1,sessionProof:'synthetic-proof'};
test('ordinary environment restores separate legacy root and original HTTP receipt without new POST',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-legacy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const old=path.join(root,'old');const journal=createOperationJournal({rootDir:old});
  const op=journal.createIntent({ownerId:1,clientKey:'old-click',quoteId:'old-quote',capabilityRevision:'old-revision',currency:'USD',children:[{keySlotId:'old-slot',holdAmountMinor:80,bodyBytes:Buffer.from('{"old":true}')}]});
  journal.markHeld(1,op.operationId,0,'old-hold');journal.markDispatching(1,op.operationId,0);
  let supplierGets=0,ledgerGets=0;
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'GET','Recovery must not submit or settle a captured order');
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/video-submissions/current'){
      supplierGets++;assert.equal(req.headers.authorization,'Bearer synthetic-only');assert.equal(req.headers['idempotency-key'],op.children[0].upstreamIdempotencyKey);
      res.end(JSON.stringify({receipt:'accepted',idempotency_key_hash:createHash('sha256').update(op.children[0].upstreamIdempotencyKey).digest('hex'),task:{id:'old-task'}}));
    }else{
      ledgerGets++;assert.equal(req.url,'/api/v1/internal/studio/video/orders/'+op.children[0].childId);assert.equal(req.headers['x-studio-session-proof'],session.sessionProof);
      res.end(JSON.stringify({ownerId:1,childId:op.children[0].childId,status:'captured'}));
    }
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const env={STUDIO_LEGACY_VIDEO_RECOVERY:'true',STUDIO_OPERATION_ROOT:old,STUDIO_VIDEO_BASE_URL:base,STUDIO_VIDEO_API_KEY:'synthetic-only',STUDIO_VIDEO_KEY_SLOT_ID:'old-slot',STUDIO_BRIDGE_URL:base,STUDIO_BRIDGE_SERVICE_TOKEN:'s'.repeat(32)};
  const make=()=>createAccountVideoRuntime({rootDir:path.join(root,'new'),call:()=>assert.fail('Account path must not handle legacy'),legacy:legacyRecoveryFromEnvironment(env)});
  const runtime=make();assert.equal(runtime.history(session)[0].contract,'legacy_slot');
  assert.equal((await runtime.recover(session,op.operationId)).children[0].status,'accepted');
  await make().recover(session,op.operationId);assert.equal(supplierGets,1);assert.equal(ledgerGets,2);
  await assert.rejects(make().recover({ownerId:2,sessionProof:'other'},op.operationId));assert.equal(ledgerGets,2);
  await assert.rejects(make().prepare(session,{clientKey:'old-click',offerId:'new-offer',request:{}}),/cannot be requoted/);
  assert.throws(()=>legacyRecoveryFromEnvironment({...env,STUDIO_OPERATION_ROOT:path.join(root,'missing')}));
  assert.equal(legacyRecoveryFromEnvironment({...env,STUDIO_LEGACY_VIDEO_RECOVERY:'false'}),undefined);
  const duplicate=createOperationJournal({rootDir:path.join(root,'new')});duplicate.createIntent({ownerId:1,clientKey:'old-click',quoteId:'different',capabilityRevision:'old-revision',currency:'USD',children:[{keySlotId:'old-slot',holdAmountMinor:80,bodyBytes:Buffer.from('{}')}]});
  await assert.rejects(make().recover(session,op.operationId),/Conflicting journal roots/);
});

test('legacy HTTP recovery rejects changed slots/hashes and preserves pending/not-found', async t => {
  let mode='pending',requests=0;
  const server=http.createServer((req,res)=>{
    requests++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/video-submissions/current');
    res.setHeader('Content-Type','application/json');
    if(mode==='pending'){res.writeHead(202);res.end('{"receipt":"pending"}');}
    else if(mode==='not_found'){res.writeHead(404);res.end('{"receipt":"not_found"}');}
    else res.end(JSON.stringify({receipt:'accepted',idempotency_key_hash:'0'.repeat(64),task:{id:'wrong'}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const supplier=createLegacySupplier({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'synthetic-only',keySlotId:'original-slot'});
  const request={keySlotId:'original-slot',idempotencyKey:'original-idempotency-key'};
  assert.equal((await supplier.recoverSubmission(request)).status,202);
  mode='not_found';assert.equal((await supplier.recoverSubmission(request)).status,404);
  mode='wrong_hash';await assert.rejects(supplier.recoverSubmission(request),/receipt_mismatch/);
  await assert.rejects(supplier.recoverSubmission({...request,keySlotId:'different'}),/slot_mismatch/);
  assert.throws(()=>supplier.submitOnce(request),/new_task_disabled/);assert.equal(requests,3);
});

for(const status of ['failed','not_submitted'])test(`legacy ${status} uses existing evidence and release HTTP contract`,async t=>{
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.method,'POST');const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));seen.push(req.url);
    assert.equal(req.headers['x-studio-session-proof'],session.sessionProof);
    if(req.url.endsWith('/snapshots/evidence')){assert.equal(body.status,status);assert.equal(body.userId,1);assert.equal(body.requestHash,'b'.repeat(64));}
    else assert.equal(req.url,'/api/v1/internal/studio/video/orders/op_original_c0/release');
    res.setHeader('Content-Type','application/json');res.end('{"status":"released"}');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const ledger=createLegacyLedger({baseUrl:`http://127.0.0.1:${server.address().port}`,serviceToken:'s'.repeat(32),session});
  const input={ownerId:1,childId:'op_original_c0',evidence:{ownerId:1,childId:'op_original_c0',requestHash:'b'.repeat(64),status,reason:'synthetic_failure',...(status==='failed'?{supplierTaskId:'original-task'}:{})}};
  assert.equal((await ledger.release(input)).status,'released');
  await assert.rejects(ledger.release({...input,ownerId:2}),/owner_mismatch/);
  assert.deepEqual(seen,['/api/v1/internal/studio/video/snapshots/evidence','/api/v1/internal/studio/video/orders/op_original_c0/release']);
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createImageResultStore} from '../../studio/bff/image-result-store.mjs';
const {createOperationJournal}=createRequire(import.meta.url)('../../studio/bff/operation-journal.js');
const parent=path.resolve(os.tmpdir());
const root=fs.mkdtempSync(path.join(parent,'studio-history-check-'));
try {
 const journal=createOperationJournal({rootDir:path.join(root,'journal')});
 const identities=[];
 for(let i=0;i<51;i++)identities.push(journal.createIntent({ownerId:1,clientKey:`fixture-${i}`,quoteId:`quote-${i}`,capabilityRevision:'fixture-v1',currency:'CNY',children:[{keySlotId:'isolated-slot',holdAmountMinor:1,bodyBytes:Buffer.from('{}')}]}).operationId);
 const page=journal.listForOwner(1);
 assert.equal(page.items.length,50); assert.equal(page.hasMore,true);
 const omitted=identities.find(id=>!page.items.some(item=>item.operationId===id));
 assert(journal.getForOwner(1,omitted)); assert.equal(journal.listForOwner(2).items.length,0);
 let clock=Date.parse('2026-10-14T00:00:00Z');
 const store=createImageResultStore({rootDir:path.join(root,'images'),now:()=>clock});
 const task='img_'+'a'.repeat(32);
 store.saveBase64(1,task,0,'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
 assert.equal(Date.parse(store.metadata(1,task,0).expires_at)-clock,72*3600000);
 assert.equal(store.read(1,task,0).length,68);
 clock+=72*3600000;
 assert.equal(store.metadata(1,task,0).expired,true);
 assert.throws(()=>store.read(1,task,0),/expired/);
 console.log(JSON.stringify({status:'PASS',video_created:51,video_returned:50,has_more:true,omitted_task_still_readable:true,other_owner_count:0,new_image_retention_hours:72,expired_original_read_rejected:true,production_action:false}));
} finally {
 const resolved=path.resolve(root);
 assert(resolved.startsWith(parent+path.sep)&&path.basename(resolved).startsWith('studio-history-check-'));
 fs.rmSync(resolved,{recursive:true,force:true});
}

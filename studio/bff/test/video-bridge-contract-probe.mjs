// Loopback synthetic Core; the real BFF and Go Bridge transports are exercised.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createAccountVideoClient,createAccountVideoRuntime} from '../video-account.mjs';
import {createVideoResultStore} from '../video-result-store.mjs';
const [baseUrl,root]=process.argv.slice(2);
const session={ownerId:1,sessionProof:'valid-proof'};
const call=createAccountVideoClient({baseUrl,serviceToken:'s'.repeat(32)});
const store=createVideoResultStore({rootDir:path.join(root,'results')});
const make=()=>createAccountVideoRuntime({rootDir:path.join(root,'journal'),call,resultStore:store});
let runtime=make();
const q=await runtime.prepare(session,{clientKey:'one-click',offerId:'offer-original',request:{model:'3.0',prompt:'<原片> & exact bytes',duration:5,resolution:'1280x720',ratio:'16:9',assets:[]}});
assert.equal((await runtime.dispatch(session,q.operation_id)).status,'unknown');
runtime=make();assert.equal((await runtime.recover(session,q.operation_id)).status,'captured');
assert.equal((await runtime.dispatch(session,q.operation_id)).status,'captured');
const result=await runtime.original(session,q.operation_id,{method:'GET'});assert.equal(result.status,200);assert.ok((await result.response.arrayBuffer()).byteLength>100);
await assert.rejects(runtime.recover({ownerId:2,sessionProof:'valid-proof'},q.operation_id));
process.stdout.write('Account video BFF -> Bridge -> Core, lost POST recovery, original decoding, single capture PASS\n');

import test from 'node:test';import assert from 'node:assert/strict';
import {effectivePaid,paidControlHandler} from './paid-control.mjs';
test('managed admission ignores stale environment and requires current Core agreement',async()=>{
 let state={control_mode:'managed-v1',paid_enabled:false};const tasks={readiness:async()=>state};
 assert.equal(await effectivePaid(tasks,{},true,true),false);
 state.paid_enabled=true;assert.equal(await effectivePaid(tasks,{},false,true),true);
 state.control_mode='legacy';assert.equal(await effectivePaid(tasks,{},true,true),false);
 tasks.readiness=async()=>{throw Error('offline')};assert.equal(await effectivePaid(tasks,{},true,true),false);
 assert.equal(await effectivePaid(tasks,{},false,false),false);
});
test('sidecar control rejects missing service identity',()=>{
 let code;const res={writeHead:s=>{code=s},end:()=>{}};
 paidControlHandler({STUDIO_BRIDGE_SERVICE_TOKEN:'s'.repeat(32)})({method:'GET',headers:{}},res);assert.equal(code,401);
});

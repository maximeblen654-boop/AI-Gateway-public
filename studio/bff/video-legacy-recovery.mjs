import {createOperationJournal} from './operation-journal.js';
import {createOperationCoordinator} from './operation-coordinator.mjs';
import {createVideoDelivery} from './video-delivery.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createVideoResultStore} from './video-result-store.mjs';
import {createLegacyLedger,createLegacySupplier} from './legacy-clients.mjs';

// Compose the existing slot adapters unchanged. This facade exposes recovery and
// original delivery only; it cannot create, reserve or submit a slot task.
export function createLegacyVideoRecovery({rootDir,ledger,supplier,resultStore}) {
  const journal=createOperationJournal({rootDir});
  const coordinator=createOperationCoordinator({journal,ledger,supplier});
  const delivery=createVideoDelivery({journal,ledger,supplier,resultStore,coordinator});
  function get(session,id){const op=journal.getForOwner(session.ownerId,id);if(!op||op.version!==1)throw Error('Original slot task required');return op;}
  return {
    get(session,id){const op=journal.getForOwner(session.ownerId,id);if(op&&op.version!==1)throw Error('Original slot task required');return op;},
    getByClientKey(session,key){const op=journal.getByClientKey(session.ownerId,key);if(op&&op.version!==1)throw Error('Original slot task required');return op;},
    history(session){return journal.listForOwner(session.ownerId).items.filter(op=>op.version===1);},
    async recover(session,id){
      let op=get(session,id);
      for(let i=0;i<op.children.length;i++){
        // Only dispatching may invoke advanceChild: this is the original GET
        // receipt path. Intent/held never re-enter legacy generation here.
        if(op.children[i].status==='dispatching')await coordinator.advanceChild(session.ownerId,id,i);
        op=get(session,id);
        if(['accepted','rejected'].includes(op.children[i].status)){
          const c=op.children[i],settled=await ledger.getSettlement({ownerId:session.ownerId,childId:c.childId});
          if(settled?.ownerId!==session.ownerId||settled.childId!==c.childId)throw Error('settlement_receipt_mismatch');
          if(!['captured','released'].includes(settled.status))await delivery.operation.reconcileChild(session.ownerId,id,i);
        }
      }
      return {operation_id:id,contract:'legacy_slot',children:get(session,id).children.map(c=>({task_id:c.childId,status:c.status}))};
    },
    original(session,id,{index=0,...options}={}){get(session,id);return delivery.openOriginal(session.ownerId,id,index,options);}
  };
}

export function legacyRecoveryFromEnvironment(env){
  if(env.STUDIO_LEGACY_VIDEO_RECOVERY!=='true')return undefined;
  const rootDir=env.STUDIO_OPERATION_ROOT;
  // Existing legacy roots are mandatory; never create an empty replacement.
  if(!rootDir||!path.isAbsolute(rootDir)||!fs.lstatSync(rootDir).isDirectory())throw Error('legacy_root_unavailable');
  const supplier=createLegacySupplier({baseUrl:env.STUDIO_VIDEO_BASE_URL,apiKey:env.STUDIO_VIDEO_API_KEY,keySlotId:env.STUDIO_VIDEO_KEY_SLOT_ID});
  const resultStore=createVideoResultStore({rootDir:path.join(rootDir,'video-results')});
  const forSession=session=>createLegacyVideoRecovery({rootDir,supplier,resultStore,ledger:createLegacyLedger({baseUrl:env.STUDIO_BRIDGE_URL,serviceToken:env.STUDIO_BRIDGE_SERVICE_TOKEN,session})});
  return Object.fromEntries(['get','getByClientKey','history','recover','original'].map(method=>[method,(session,...args)=>forSession(session)[method](session,...args)]));
}

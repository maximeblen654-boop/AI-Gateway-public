import {createOperationJournal} from './operation-journal.js';
import {createOperationCoordinator} from './operation-coordinator.mjs';
import {createVideoDelivery} from './video-delivery.mjs';

// Compose the existing slot adapters unchanged. This facade exposes recovery and
// original delivery only; it cannot create, reserve or submit a slot task.
export function createLegacyVideoRecovery({rootDir,ledger,supplier,resultStore}) {
  const journal=createOperationJournal({rootDir});
  const coordinator=createOperationCoordinator({journal,ledger,supplier});
  const delivery=createVideoDelivery({journal,ledger,supplier,resultStore,coordinator});
  function get(session,id){const op=journal.getForOwner(session.ownerId,id);if(!op||op.version!==1)throw Error('Original slot task required');return op;}
  return {
    async recover(session,id){
      let op=get(session,id);
      for(let i=0;i<op.children.length;i++){
        // Only dispatching may invoke advanceChild: this is the original GET
        // receipt path. Intent/held never re-enter legacy generation here.
        if(op.children[i].status==='dispatching')await coordinator.advanceChild(session.ownerId,id,i);
        op=get(session,id);
        if(['accepted','rejected'].includes(op.children[i].status))await delivery.operation.reconcileChild(session.ownerId,id,i);
      }
      return {operation_id:id,contract:'legacy_slot',children:get(session,id).children.map(c=>({task_id:c.childId,status:c.status}))};
    },
    original(session,id,options){get(session,id);return delivery.openOriginal(session.ownerId,id,0,options);}
  };
}

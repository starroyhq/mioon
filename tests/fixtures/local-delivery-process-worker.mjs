/** Synthetic business-process crash harness. Never imported by product code.
 * Parent owns the ChildProcess and sends SIGKILL only to that exact handle.
 * A synchronous stdout boundary parks the worker without an IPC reply; no
 * injected product flag, renderer inspection, model or media worker is used.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeSync} from 'node:fs';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {createServices,hash} from '../../packages/business/src/services.ts';
import {createTimelineRecoveryBoundary,readTimelineReceipt} from '../../packages/business/src/timeline-recovery.ts';
import {createLocalDelivery} from '../../packages/business/src/local-delivery.ts';
import {schemas,isTimelineMutationResponse,hasRequestNotAppliedProof,publicValue} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';

const [root,...extra]=process.argv.slice(2);assert.ok(path.isAbsolute(root));assert.equal(extra.length,0);assert.ok(process.send);
const store=openStore(root),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});
let armed=null,inOutcome=false,closing=false;const dispatches=[];
function boundary(phase){
 if(armed!==phase)return;
 writeSync(1,JSON.stringify({type:'boundary',phase,dispatches:dispatches.length})+'\n');
 // Only the test parent can release this boundary, by killing its exact child.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 throw Error('A crash-only boundary unexpectedly resumed');
}
const delivery=createLocalDelivery({root,storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
 guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
  readTimeline:projectId=>createTimelineRecoveryBoundary(store.db,{projectId}).read({sourceSemantics:false}),
  isRenderInput:value=>schemas['timeline.render'].safeParse(value).success,
  isRenderResponse:(input,value)=>isTimelineMutationResponse('timeline.render',input,value),
  isNotApplied:(input,error)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
  readReceipt:input=>{const saved=readTimelineReceipt(store.db,input,'timeline.render');if(!saved)return null;
   assert.equal(saved.requestHash,hash({operation:'timeline.render',input}));
   return publicValue(createTimelineRecoveryBoundary(store.db,input).replay('timeline.render',saved.response));},
  render:async input=>{dispatches.push(structuredClone(input));const response=await services.call('timeline.render',input);
   const saved=readTimelineReceipt(store.db,input,'timeline.render');assert.ok(saved,'A business commit must have its immutable receipt');
   boundary('afterBusinessReceiptCommit');return response;}},
 fault:point=>{if(point==='beforeOutcomePersist')inOutcome=true;
  boundary(inOutcome&&point==='afterDirectorySync'?'afterOutcomePersist':point);}});

process.on('message',async message=>{
 if(closing)return;
 const {id,method,input}=message;
 try{
  if(method==='close'){closing=true;await services.drain();store.close();process.disconnect();return;}
  let data;
  if(method==='arm'){assert.ok(['beforePersist','afterDirectorySync','beforeDispatch','afterBusinessReceiptCommit','beforeOutcomePersist','afterOutcomePersist'].includes(input));armed=input;inOutcome=false;data={armed};}
  else if(method==='observe')data={dispatches:structuredClone(dispatches)};
  else if(method==='rpc'){assert.ok(['timeline.track.add'].includes(input.operation));data=await services.call(input.operation,input.input);}
  else if(method==='executeBoth')data=await Promise.all([delivery.execute(input),delivery.recover(input)]);
  else{assert.ok(['get','put','discard','prepare','execute','recover'].includes(method));data=await delivery[method](input);}
  process.send({type:'reply',id,data});
 }catch(error){process.send({type:'reply',id,error:{code:error.code??'HARNESS_ERROR',message:error.message}});}
});
process.send({type:'ready',pid:process.pid,dispatches:0});

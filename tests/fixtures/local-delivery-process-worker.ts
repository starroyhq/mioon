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

const [root,...extra]=process.argv.slice(2);assert.ok(root&&path.isAbsolute(root));assert.equal(extra.length,0);const send=process.send?.bind(process);assert.ok(send);
const store=openStore(root),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});
let armed: string|null=null,inOutcome=false,closing=false;const dispatches: unknown[]=[];
function boundary(phase: string): never|void{
 if(armed!==phase)return;
 writeSync(1,JSON.stringify({type:'boundary',phase,dispatches:dispatches.length})+'\n');
 // Only the test parent can release this boundary, by killing its exact child.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 throw Error('A crash-only boundary unexpectedly resumed');
}
const delivery=createLocalDelivery({root,storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
 guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
  readTimeline:(projectId: string)=>createTimelineRecoveryBoundary(store.db,{projectId}).read({sourceSemantics:false}),
  isRenderInput:(value: unknown)=>schemas['timeline.render'].safeParse(value).success,
  isRenderResponse:(input: unknown,value: unknown)=>isTimelineMutationResponse('timeline.render',input,value),
  isNotApplied:(input: unknown,error: unknown)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
  readReceipt:(input: never)=>{const saved=readTimelineReceipt(store.db,input,'timeline.render');if(!saved)return null;
   assert.equal(saved.requestHash,hash({operation:'timeline.render',input}));
   return publicValue(createTimelineRecoveryBoundary(store.db,input as never).replay('timeline.render',saved.response as string));},
  render:async (input: never)=>{dispatches.push(structuredClone(input));const response=await services.call('timeline.render',input);
   const saved=readTimelineReceipt(store.db,input,'timeline.render');assert.ok(saved,'A business commit must have its immutable receipt');
   boundary('afterBusinessReceiptCommit');return response;}},
 fault:(point: string)=>{if(point==='beforeOutcomePersist')inOutcome=true;
  boundary(inOutcome&&point==='afterDirectorySync'?'afterOutcomePersist':point);}});

interface DeliveryWorkerMessage {id: string; method: string; input: Record<string, unknown> & {operation?: string; input?: unknown; requestId?: string; [key: string]: unknown}}
process.on('message',async (raw: unknown)=>{
 if(closing)return;
 const message=raw as DeliveryWorkerMessage;
 const {id,method,input}=message;
 try{
  if(method==='close'){closing=true;await services.drain();store.close();process.disconnect();return;}
  let data;
  if(method==='arm'){assert.ok(typeof input==='string'&&['beforePersist','afterDirectorySync','beforeDispatch','afterBusinessReceiptCommit','beforeOutcomePersist','afterOutcomePersist'].includes(input as never));armed=String(input);inOutcome=false;data={armed};}
  else if(method==='observe')data={dispatches:structuredClone(dispatches)};
  else if(method==='rpc'){assert.ok(['timeline.track.add'].includes(String(input.operation)));data=await services.call(String(input.operation),input.input as never);}
  else if(method==='executeBoth')data=await Promise.all([delivery.execute(input as never),delivery.recover(input as never)]);
  else{assert.ok(['get','put','discard','prepare','execute','recover'].includes(method));data=await (delivery as unknown as Record<string,(value: unknown)=>Promise<unknown>>)[method](input);}
  send({type:'reply',id,data});
 }catch(error){const failure=error as {code?: string; message?: string};send({type:'reply',id,error:{code:failure.code??'HARNESS_ERROR',message:failure.message??String(error)}});}
});
send({type:'ready',pid:process.pid,dispatches:0});

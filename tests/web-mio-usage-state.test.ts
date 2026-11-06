import test from 'node:test';
import assert from 'node:assert/strict';
import {createMioUsageController,EMPTY_MIO_USAGE_STATE} from '../apps/web/src/mio-usage-state.ts';
import type {MioUsageOwner,MioUsageState} from '../apps/web/src/mio-usage-state.ts';
import type {MioRunUsage} from '../packages/contracts/src/mio-run-usage.ts';
import {usageFixture,USAGE_PROJECT_ID as projectId,USAGE_RUN_ID as runId} from './helpers/mio-usage-fixture.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const owner:MioUsageOwner={scope:'workspace-A',projectId,instanceId:'server-A',selectionKey:'conversation-A',visible:true};
function harness(isAdmissionAllowed?:()=>boolean){
  let state:MioUsageState=EMPTY_MIO_USAGE_STATE;
  const requests:Array<{projectId:string;runId:string;signal?:AbortSignal;resolve:(value:MioRunUsage)=>void;reject:(error:unknown)=>void}>=[];
  const controller=createMioUsageController({isAdmissionAllowed,onChange:value=>{state=value;},client:{read:async(projectId,runId,options)=>await new Promise<MioRunUsage>((resolve,reject)=>requests.push({projectId,runId,signal:options?.signal,resolve,reject}))}});
  const sync=(revision=1,terminal=false)=>controller.sync(owner,[{runId,revision,terminal}]);
  return{controller,requests,sync,get state(){return state;}};
}

test('effective sequences and accepted read serials coalesce to one tail and same revision replaces the full DTO',async()=>{
  const h=harness();h.sync();await flush();assert.equal(h.requests.length,1);
  h.controller.observe({runId,serial:1,sequence:1});h.controller.observe({runId,serial:2,sequence:1});h.controller.observe({runId,serial:3,sequence:2});
  h.requests[0]!.resolve(usageFixture());await flush();assert.equal(h.requests.length,2);
  const lower=usageFixture({knownTotals:{inputTokens:500,outputTokens:20,cacheReadTokens:300,cacheWriteTokens:0}});
  h.requests[1]!.resolve(lower);await flush();assert.deepEqual(h.state.rounds[runId]!.value,lower);assert.equal(h.requests.length,2);
  h.controller.observe({runId,serial:4});await flush();assert.equal(h.requests.length,3);h.requests[2]!.resolve(usageFixture());await flush();assert.equal(h.state.rounds[runId]!.value!.knownTotals.outputTokens,100);h.controller.dispose();
});

test('a terminal transition requires its own trailing GET and failure never spins or falsely marks final',async()=>{
  const h=harness();h.sync();await flush();h.sync(1,true);
  h.requests[0]!.resolve(usageFixture());await flush();assert.equal(h.requests.length,2);assert.equal(h.state.rounds[runId]!.final,false);
  h.requests[1]!.reject(new Error('offline'));await flush();await flush();assert.equal(h.requests.length,2);assert.equal(h.state.rounds[runId]!.phase,'error');assert.equal(h.state.rounds[runId]!.stale,true);assert.equal(h.state.rounds[runId]!.final,false);
  h.controller.refresh(runId);await flush();h.requests[2]!.resolve(usageFixture());await flush();assert.equal(h.state.rounds[runId]!.final,true);h.controller.dispose();
});

test('stale revisions and bad run identities preserve old values without automatic retry',async()=>{
  const h=harness();h.sync();await flush();h.requests[0]!.resolve(usageFixture());await flush();h.sync(3,false);await flush();
  h.requests[1]!.resolve(usageFixture({revision:2}));await flush();assert.equal(h.state.rounds[runId]!.code,'USAGE_STALE');assert.equal(h.state.rounds[runId]!.value!.revision,1);assert.equal(h.requests.length,2);
  h.controller.refresh(runId);await flush();h.requests[2]!.resolve(usageFixture({runId:projectId,revision:3}));await flush();assert.equal(h.state.rounds[runId]!.code,'BACKEND_PROTOCOL_ERROR');assert.equal(h.state.rounds[runId]!.value!.revision,1);
  h.controller.refresh(runId);await flush();h.requests[3]!.resolve(usageFixture({revision:3}));await flush();assert.equal(h.state.rounds[runId]!.phase,'ready');assert.equal(h.state.rounds[runId]!.stale,false);h.controller.dispose();
});

test('project, instance, scope, selection and visibility epochs fence identical IDs and ignored-signal late replies',async()=>{
  for(const patch of [{projectId:'33333333-3333-4333-8333-333333333333'},{instanceId:'server-B'},{scope:'workspace-B'},{selectionKey:'conversation-B'},{visible:false}]){
    const h=harness();h.sync();await flush();h.controller.open(runId);h.controller.sync({...owner,...patch},[{runId,revision:1,terminal:false}]);await flush();
    assert.equal(h.requests[0]!.signal!.aborted,true);assert.equal(h.state.detailRunId,null);const revision=h.state.revision;
    h.requests[0]!.resolve(usageFixture());await flush();assert.equal(h.state.revision,revision);assert.equal(h.state.rounds[runId]?.value??null,null);h.controller.dispose();
  }
  const h=harness();h.sync();await flush();h.controller.sync({...owner,visible:false},[{runId,revision:1,terminal:false}]);h.controller.sync(owner,[{runId,revision:1,terminal:false}]);await flush();assert.equal(h.requests.length,2);h.requests[0]!.reject(new Error('late'));await flush();assert.notEqual(h.state.rounds[runId]!.phase,'error');h.controller.dispose();
});

test('history reads have bounded concurrency and details retain their exact earlier run as a new round arrives',async()=>{
  const h=harness(),ids=Array.from({length:7},(_,n)=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`),rounds=ids.map(runId=>({runId,revision:1,terminal:true}));
  h.controller.sync(owner,rounds);await flush();assert.equal(h.requests.length,4);
  h.controller.open(ids[0]!);h.requests[0]!.resolve(usageFixture({runId:ids[0]!}));await flush();assert.equal(h.state.detailRunId,ids[0]);assert.ok(h.requests.length<=5);
  h.controller.sync(owner,[...rounds,{runId,revision:1,terminal:false}]);assert.equal(h.state.detailRunId,ids[0]);
  h.controller.close();assert.equal(h.state.detailRunId,null);assert.equal(h.requests[0]!.projectId,projectId);h.controller.dispose();
});

test('only actual terminal metadata verifies a final read; hidden return forces new observation and dispose rejects late publication',async()=>{
  const h=harness();h.sync(1,false);await flush();h.requests[0]!.resolve(usageFixture());await flush();assert.equal(h.state.rounds[runId]!.final,false);
  h.sync(1,true);await flush();h.requests[1]!.resolve(usageFixture());await flush();assert.equal(h.state.rounds[runId]!.final,true);
  h.controller.sync({...owner,visible:false},[{runId,revision:1,terminal:true}]);h.controller.sync(owner,[{runId,revision:1,terminal:true}]);await flush();assert.equal(h.requests.length,3);const before=h.state.revision;h.controller.dispose();h.requests[2]!.resolve(usageFixture());await flush();assert.equal(h.state.revision,before);
});


test('the live lease fence blocks queued usage dispatch and every explicit read without waiting for a render',async()=>{
  let admitted=true;const h=harness(()=>admitted);
  h.sync();const before=h.state;admitted=false;await flush();
  assert.equal(h.requests.length,0,'a microtask queued under the old admission cannot dispatch');
  h.controller.observe({runId,serial:1});h.controller.refresh(runId);h.controller.open(runId);await flush();
  assert.equal(h.requests.length,0);assert.equal(h.state,before);assert.equal(h.state.detailRunId,null);
  h.controller.dispose();
});

for(const outcome of ['success','failure'] as const)test(`a revoked live usage admission fences a late ${outcome} and does not queue its trailing read`,async()=>{
  let admitted=true;const h=harness(()=>admitted);
  h.sync();await flush();assert.equal(h.requests.length,1);
  h.controller.observe({runId,serial:1});const before=h.state;admitted=false;
  if(outcome==='success')h.requests[0]!.resolve(usageFixture());else h.requests[0]!.reject(new Error('late read failure'));
  await flush();await flush();assert.equal(h.state,before);assert.equal(h.requests.length,1);
  h.controller.open(runId);h.controller.refresh(runId);await flush();assert.equal(h.state,before);assert.equal(h.requests.length,1);
  h.controller.dispose();
});

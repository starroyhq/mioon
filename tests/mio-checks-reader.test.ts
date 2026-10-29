import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createAgentTaskChecksReader,readAgentTaskChecks} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskChecks} from '../packages/contracts/src/agent-tasks-v2.ts';

const projectId='10000000-0000-4000-8000-000000000001',runId='10000000-0000-4000-8000-000000000002',targetId='10000000-0000-4000-8000-000000000003';
function checks():AgentTaskChecks{return {projectId,runId,runRevision:7,groups:[
 {id:'export_render',items:[{id:'export-status',type:'export_status',source:'host',status:'passed',target:{kind:'export',id:targetId},basis:[{kind:'export',id:targetId,revision:2}]}]},
 {id:'generation',items:[]},{id:'timeline',items:[]},{id:'decomposition_frames',items:[]},
]};}
const response=(data:unknown)=>new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});
const privateFree=(error:unknown,code:string):boolean=>{
 assert.ok(error instanceof Error);assert.equal((error as Error&{code?:unknown}).code,code);assert.equal(error.message,'Agent task request failed');assert.doesNotMatch(JSON.stringify(error),/PRIVATE|credential|provider prose/u);return true;
};
function deferredFetch(){
 const calls:Array<{url:string;options:RequestInit|undefined}>=[];let resolve!:(value:Response)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<Response>((yes,no)=>{resolve=yes;reject=no;});
 const fetchImpl:typeof fetch=async(url,options)=>{calls.push({url:String(url),options});return promise;};
 return {calls,fetchImpl,resolve,reject};
}
const microtasks=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};

test('checks reader uses only scoped GETs and requests full preflight only for true',async()=>{
 const calls:Array<{url:string;options:RequestInit|undefined}>=[],reader=createAgentTaskChecksReader({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return response(checks());}});
 assert.equal(typeof readAgentTaskChecks,'function');assert.deepEqual(await reader(projectId,runId),checks());await reader(projectId,runId,{preflight:false});await reader(projectId,runId,{preflight:true});
 const path=`/api/agent/tasks/v2/${projectId}/${runId}/checks`;assert.deepEqual(calls.map(call=>call.url),[path,path,`${path}?preflight=1`]);
 for(const call of calls){assert.equal(call.options?.method,'GET');assert.equal(call.options?.body,undefined);assert.equal(call.options?.credentials,'same-origin');assert.equal(call.options?.cache,'no-store');assert.ok(call.options?.signal instanceof AbortSignal);assert.equal(call.options?.signal?.aborted,false);}
});

test('checks reader validates strict schema and binds both project and run identities',async()=>{
 const valid=checks();
 for(const bad of [
  {...valid,projectId:targetId},{...valid,runId:targetId},{...valid,message:'PRIVATE_PROVIDER_PROSE'},
  {...valid,groups:valid.groups.slice(1)},
  {...valid,groups:valid.groups.map((group,index)=>index===0?{...group,items:[{...group.items[0],basis:[]}]}:group)},
  {...valid,groups:valid.groups.map((group,index)=>index===0?{...group,items:[{...group.items[0],reason:{code:'TASK_FAILED',message:'PRIVATE_PROVIDER_PROSE'}}]}:group)},
 ]){let calls=0;const reader=createAgentTaskChecksReader({fetchImpl:async()=>{calls++;return response(bad);}});await assert.rejects(reader(projectId,runId),error=>privateFree(error,'INVALID_RESPONSE'));assert.equal(calls,1);}
});

test('checks errors retain only safe codes and never backend, parsing or transport prose',async()=>{
 for(const [body,status,code] of [
  [{ok:false,error:{code:'AGENT_TASK_NOT_FOUND',message:'PRIVATE provider prose',details:{credential:'PRIVATE'}}},404,'AGENT_TASK_NOT_FOUND'],
  [{ok:false,error:{code:'PRIVATE provider prose',message:'PRIVATE'}},500,'INVALID_RESPONSE'],
  [{ok:true,data:checks()},500,'INVALID_RESPONSE'],
 ] as const){const reader=createAgentTaskChecksReader({fetchImpl:async()=>new Response(JSON.stringify(body),{status})});await assert.rejects(reader(projectId,runId),error=>privateFree(error,code));}
 const invalidJson=createAgentTaskChecksReader({fetchImpl:async()=>new Response('PRIVATE malformed JSON')});await assert.rejects(invalidJson(projectId,runId),error=>privateFree(error,'INVALID_RESPONSE'));
 const network=createAgentTaskChecksReader({fetchImpl:async()=>{throw new Error('PRIVATE credential provider prose');}});await assert.rejects(network(projectId,runId),error=>privateFree(error,'NETWORK'));
});

test('default lightweight reads time out at twelve seconds even when fetch ignores abort',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const transport=deferredFetch(),reader=createAgentTaskChecksReader({fetchImpl:transport.fetchImpl}),request=reader(projectId,runId);let settled=false;void request.then(()=>{settled=true;},()=>{settled=true;});
 t.mock.timers.tick(11999);await microtasks();assert.equal(settled,false);assert.equal(transport.calls[0].options?.signal?.aborted,false);
 const rejected=assert.rejects(request,error=>privateFree(error,'NETWORK'));t.mock.timers.tick(1);await rejected;assert.equal(transport.calls[0].options?.signal?.aborted,true);assert.equal(getEventListeners(transport.calls[0].options!.signal!,'abort').length,0);
 transport.resolve(response(checks()));await microtasks();assert.equal(transport.calls.length,1);
});

test('full reads allow at least sixty seconds and preserve longer configured timeouts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const timeoutMs of [undefined,5000,90000]){
  const transport=deferredFetch(),reader=createAgentTaskChecksReader({fetchImpl:transport.fetchImpl,...(timeoutMs===undefined?{}:{timeoutMs})}),request=reader(projectId,runId,{preflight:true}),limit=Math.max(timeoutMs??12000,60000);let settled=false;void request.then(()=>{settled=true;},()=>{settled=true;});
  t.mock.timers.tick(limit-1);await microtasks();assert.equal(settled,false);assert.equal(transport.calls[0].options?.signal?.aborted,false);
  const rejected=assert.rejects(request,error=>privateFree(error,'NETWORK'));t.mock.timers.tick(1);await rejected;assert.equal(transport.calls[0].options?.signal?.aborted,true);transport.resolve(response(checks()));await microtasks();
 }
});

test('external cancellation aborts the request and cleans listeners while late completion stays rejected',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const external=new AbortController(),transport=deferredFetch(),reader=createAgentTaskChecksReader({fetchImpl:transport.fetchImpl}),request=reader(projectId,runId,{preflight:true,signal:external.signal}),outcomes:string[]=[];void request.then(()=>{outcomes.push('resolved');},()=>{outcomes.push('rejected');});
 assert.equal(getEventListeners(external.signal,'abort').length,1);const rejected=assert.rejects(request,error=>privateFree(error,'NETWORK'));external.abort(new Error('PRIVATE provider prose'));await rejected;assert.equal(transport.calls[0].options?.signal?.aborted,true);assert.equal(getEventListeners(external.signal,'abort').length,0);assert.equal(getEventListeners(transport.calls[0].options!.signal!,'abort').length,0);
 transport.resolve(response(checks()));await microtasks();t.mock.timers.tick(120000);await microtasks();assert.deepEqual(outcomes,['rejected']);assert.equal(transport.calls.length,1);
});

test('an already cancelled read never calls fetch or installs listeners',async()=>{
 const external=new AbortController();external.abort(new Error('PRIVATE cancellation'));let calls=0;const reader=createAgentTaskChecksReader({fetchImpl:async()=>{calls++;return response(checks());}});
 await assert.rejects(reader(projectId,runId,{signal:external.signal}),error=>privateFree(error,'NETWORK'));assert.equal(calls,0);assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('successful and failed reads clear their timers and external listeners',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const successful of [true,false]){
  const external=new AbortController();let signal:AbortSignal|null|undefined;const reader=createAgentTaskChecksReader({fetchImpl:async(_url,options)=>{signal=options?.signal;return successful?response(checks()):response({PRIVATE:'provider prose'});}});
  if(successful)await reader(projectId,runId,{signal:external.signal});else await assert.rejects(reader(projectId,runId,{signal:external.signal}),error=>privateFree(error,'INVALID_RESPONSE'));
  assert.ok(signal);assert.equal(getEventListeners(external.signal,'abort').length,0);assert.equal(getEventListeners(signal,'abort').length,0);external.abort();t.mock.timers.tick(120000);assert.equal(signal.aborted,false,'Cleared timeout and external listener cannot abort a settled request');
 }
});

test('timeout also covers a body reader that ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveJson!:(value:unknown)=>void;const body=new Promise<unknown>(resolve=>{resolveJson=resolve;});
 const reader=createAgentTaskChecksReader({fetchImpl:async()=>{const result=response(checks());result.json=()=>body;return result;}}),request=reader(projectId,runId,{preflight:true});await microtasks();
 const rejected=assert.rejects(request,error=>privateFree(error,'NETWORK'));t.mock.timers.tick(60000);await rejected;resolveJson({ok:true,data:checks()});await microtasks();
});

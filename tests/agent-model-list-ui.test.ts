import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentModelListClient,createAgentModelListSession} from '../apps/web/src/agent-model-list-session.ts';
import type {AgentModelListClient} from '../apps/web/src/agent-model-list-session.ts';
import {agentModelListRows} from '../apps/web/src/agent-model-list-rows.ts';
import type {AgentModelListCacheRequest,AgentModelListSuccess} from '../packages/contracts/src/agent-model-list.ts';

const input=(serviceKey='openai',baseUrl='https://api.openai.com/v1'):AgentModelListCacheRequest=>({serviceKey,expectedSettingsRevision:0,selection:{presetId:serviceKey,platformId:'global',baseUrl,protocol:'responses'}});
const success=(ids:string[]=[],complete=true):AgentModelListSuccess=>({outcome:'success',models:ids.map(id=>({id,adaptation:'unverified'})),complete,source:'current_protocol',fetchedAt:'2026-11-04T00:00:00.000Z'});
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}

test('matching complete empty cache is a hit and never reads a key or sends a list request',async()=>{
 let reads=0,fetches=0;const session=createAgentModelListSession({client:{modelsCache:async()=>({status:'hit',result:success()}),modelsList:async()=>{fetches++;return success();}}});
 await session.open(input(),()=>{reads++;return {source:'input',value:'synthetic-secret'};});assert.equal(reads,0);assert.equal(fetches,0);assert.equal(session.getState().openai?.phase,'success');assert.equal(session.getState().openai?.fromCache,true);assert.deepEqual(session.getState().openai?.observation?.models,[]);session.dispose();
});

test('cache miss without a key waits; forced fetch uses one ephemeral DOM read without exposing input in state',async()=>{
 let reads=0,fetches=0;const emitted:unknown[]=[];const client:AgentModelListClient={modelsCache:async()=>({status:'miss'}),modelsList:async request=>{fetches++;assert.equal(request.credential.source,'input');if(request.credential.source==='input')assert.equal(request.credential.value,'synthetic-secret');return success(['new-model']);}};
 const session=createAgentModelListSession({client,onChange:state=>emitted.push(state)});await session.open(input(),()=>null);assert.equal(session.getState().openai?.phase,'waiting_key');assert.equal(fetches,0);
 await session.refresh(input(),()=>{reads++;return {source:'input',value:'synthetic-secret'};});assert.equal(reads,1);assert.equal(fetches,1);assert.equal(session.getState().openai?.phase,'success');assert.doesNotMatch(JSON.stringify(emitted),/synthetic-secret|credential|value/);session.dispose();
});

test('five outcomes preserve the last matching observation and do not invent verification or a missing-model result',async()=>{
 const results=[{outcome:'invalid_key',reason:'rejected'},{outcome:'unavailable',reason:'not_provided'},{outcome:'unreachable',reason:'timeout'},{outcome:'network_denied',reason:'policy'}] as const;
 for(const result of results){let fetch=0;const session=createAgentModelListSession({client:{modelsCache:async()=>({status:'hit',result:success(['old-model'])}),modelsList:async()=>{fetch++;return result;}}});await session.open(input(),()=>({source:'saved'}));await session.refresh(input(),()=>({source:'saved'}));assert.equal(session.getState().openai?.phase,result.outcome);assert.deepEqual(session.getState().openai?.observation?.models.map(model=>model.id),['old-model']);assert.equal(fetch,1);assert.equal('verification'in session.getState().openai!,false);session.dispose();}
});

test('switching detail, hiding, invalidating, changing selection, removing and disposal discard late results and cancel the request',async()=>{
 for(const action of ['switch','hide','invalidate','change','remove','dispose']){
  const pending=held<AgentModelListSuccess>();let signal:AbortSignal|undefined;const session=createAgentModelListSession({client:{modelsCache:async()=>({status:'miss'}),modelsList:async(_request,options)=>{signal=options.signal;return pending.promise;}}});
  const operation=session.refresh(input(),()=>({source:'saved'}));assert.ok(signal);if(action==='switch')await session.open(input('deepseek','https://api.deepseek.com'),()=>null);else if(action==='hide')session.suspend();else if(action==='invalidate')session.invalidate('openai');else if(action==='change')await session.open({...input(),selection:{...input().selection,protocol:'chat_completions'}},()=>null);else if(action==='remove')session.forget([]);else session.dispose();
  assert.equal(signal.aborted,true,action);pending.resolve(success(['late-model']));await operation;assert.equal(session.getState().openai?.observation?.models.some(model=>model.id==='late-model')??false,false,action);session.dispose();
 }
});

test('two forced fetches completing in reverse order retain only the latest request and its partial status',async()=>{
 const first=held<AgentModelListSuccess>(),second=held<AgentModelListSuccess>();let count=0;const session=createAgentModelListSession({client:{modelsCache:async()=>({status:'miss'}),modelsList:async()=>++count===1?first.promise:second.promise}});
 const a=session.refresh(input(),()=>({source:'saved'})),b=session.refresh(input(),()=>({source:'saved'}));second.resolve(success(['latest'],false));await b;first.resolve(success(['stale']));await a;assert.deepEqual(session.getState().openai?.observation?.models.map(model=>model.id),['latest']);assert.equal(session.getState().openai?.observation?.complete,false);session.dispose();
});

test('selection identity changes remove old receiver rows before an unavailable or failed result',async()=>{
 const session=createAgentModelListSession({client:{modelsCache:async()=>({status:'hit',result:success(['old'])}),modelsList:async()=>({outcome:'unreachable',reason:'timeout'})}});
 await session.open(input(),()=>({source:'saved'}));await session.refresh(input('openai','https://other.example'),()=>({source:'input',value:'synthetic-secret'}));assert.equal(session.getState().openai?.observation,null);session.dispose();
});

test('three-source rows deduplicate, sort stably, retain actual and pending selection, and recompute adaptation',()=>{
 const remote={...success(['remote-z','manual-adapted','remote-adapted','current','manual-z']),models:success(['remote-z','manual-adapted','remote-adapted','current','manual-z']).models.map(model=>({...model,adaptation:'adapted' as const}))};
 const rows=agentModelListRows({observation:remote,adaptedIds:['manual-adapted','remote-adapted'],manualIds:['manual-adapted','manual-z','manual-last'],currentId:'current',draftId:'pending'});
 assert.deepEqual(rows.map(row=>row.id),['current','manual-adapted','remote-adapted','remote-z','manual-z','manual-last','pending']);assert.equal(rows.find(row=>row.id==='remote-z')?.adapted,false);assert.equal(rows.find(row=>row.id==='manual-adapted')?.adapted,true);assert.equal(rows.find(row=>row.id==='pending')?.pending,true);
 assert.ok(agentModelListRows({observation:remote,adaptedIds:['remote-z'],manualIds:[],custom:true}).every(row=>!row.adapted));assert.equal(rows.length,new Set(rows.map(row=>row.id)).size);
});

test('only a complete successful matching list marks a missing actual Mio model; manual rows are never removed',()=>{
 for(const complete of [true,false])for(const showMissing of [true,false]){const rows=agentModelListRows({observation:success([],complete),adaptedIds:[],manualIds:['manual'],currentId:'current',showMissing});assert.deepEqual(rows.map(row=>row.id),['current','manual']);assert.equal(rows[0]!.missing,complete&&showMissing);assert.equal(rows[1]!.manual,true);}
 const rows=agentModelListRows({adaptedIds:['not-observed'],manualIds:[],currentId:'current'});assert.deepEqual(rows.map(row=>row.id),['current','not-observed']);assert.equal(rows[0]!.missing,false);assert.equal(rows[1]!.adapted,true);
});

test('partial lists supplement static adapted models after Mio and before provider-only rows; complete lists do not',()=>{
 for(const complete of [false,true]){
  const rows=agentModelListRows({observation:success(['remote-first','adapted-seen','remote-last'],complete),adaptedIds:['adapted-unseen','adapted-seen','current'],manualIds:['manual'],currentId:'current',draftId:'pending'});
  assert.deepEqual(rows.map(row=>row.id),complete?['current','adapted-seen','remote-first','remote-last','manual','pending']:['current','adapted-seen','adapted-unseen','remote-first','remote-last','manual','pending']);
  assert.ok(rows.filter(row=>['current','adapted-seen','adapted-unseen'].includes(row.id)).every(row=>row.adapted));
  assert.equal(rows.length,new Set(rows.map(row=>row.id)).size);assert.equal(rows.find(row=>row.id==='pending')?.pending,true);
  const custom=agentModelListRows({observation:success(['remote'],complete),adaptedIds:['adapted-unseen'],manualIds:['manual'],custom:true});
  assert.deepEqual(custom.map(row=>row.id),['remote','manual']);assert.ok(custom.every(row=>!row.adapted));
 }
});

test('a failed or pending refresh supplements adapted rows even while retaining an older complete observation',()=>{
 const options={observation:success(['remote']),adaptedIds:['adapted-unseen'],manualIds:['manual'],currentId:'current'};
 const retained=agentModelListRows({...options,hasCompleteList:false,showMissing:false});
 assert.deepEqual(retained.map(row=>row.id),['current','adapted-unseen','remote','manual']);assert.ok(retained.every(row=>!row.missing));
 assert.deepEqual(agentModelListRows({...options,hasCompleteList:true}).map(row=>row.id),['current','remote','manual']);
 const empty=agentModelListRows({...options,observation:success([]),hasCompleteList:true});assert.deepEqual(empty.map(row=>row.id),['current','manual']);
});

test('browser client uses authenticated no-store POSTs, strict bounds and never reflects remote errors or key text',async()=>{
 const requests:Array<{url:RequestInfo|URL;options?:RequestInit}>=[];const client=createAgentModelListClient({fetchImpl:async(url,options)=>{requests.push({url,options});return Response.json({ok:true,data:String(url).endsWith('/cache')?{status:'miss'}:success()});}}),controller=new AbortController();
 await client.modelsCache(input(),{signal:controller.signal});await client.modelsList({...input(),credential:{source:'input',value:'synthetic-secret'}},{signal:controller.signal});assert.deepEqual(requests.map(request=>request.url),['/api/agent/models/cache','/api/agent/models/list']);for(const request of requests){assert.equal(request.options?.method,'POST');assert.equal(request.options?.credentials,'same-origin');assert.equal(request.options?.cache,'no-store');assert.doesNotMatch(String(request.url),/synthetic-secret/);}
 for(const body of [{ok:false,error:{message:'synthetic-secret'}},{ok:true,data:{...success(),private:'synthetic-secret'}},{ok:true,data:success(),private:'synthetic-secret'}]){const bad=createAgentModelListClient({fetchImpl:async()=>Response.json(body)});await assert.rejects(bad.modelsList({...input(),credential:{source:'none'}},{signal:controller.signal}),error=>{assert.doesNotMatch(String(error),/synthetic-secret/);return true;});}
 const large=createAgentModelListClient({fetchImpl:async()=>new Response('x'.repeat(256*1024+1025))});await assert.rejects(large.modelsCache(input(),{signal:controller.signal}));
});

test('browser enforces the complete local envelope at the exact 256 KiB boundary and rejects one extra byte',async()=>{
 const json=JSON.stringify({ok:true,data:success()}),maximum=json+' '.repeat(256*1024-Buffer.byteLength(json)),controller=new AbortController();
 for(const extra of [0,1]){const client=createAgentModelListClient({fetchImpl:async()=>new Response(maximum+' '.repeat(extra))}),operation=client.modelsList({...input(),credential:{source:'none'}},{signal:controller.signal});if(extra)await assert.rejects(operation);else assert.deepEqual(await operation,success());}
});

test('browser cancellation and deadline settle even when fetch ignores its signal; late response cannot publish',async()=>{
 for(const mode of ['abort','timeout']){const pending=held<Response>(),controller=new AbortController();let signal:AbortSignal|null|undefined;const client=createAgentModelListClient({timeoutMs:mode==='timeout'?2:18000,fetchImpl:async(_url,options)=>{signal=options?.signal;return pending.promise;}});const operation=client.modelsList({...input(),credential:{source:'none'}},{signal:controller.signal});if(mode==='abort')controller.abort();await assert.rejects(operation);assert.equal(signal?.aborted,true);pending.resolve(Response.json({ok:true,data:success(['late'])}));}
});

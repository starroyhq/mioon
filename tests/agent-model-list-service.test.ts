import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSettings,AGENT_CREDENTIAL_ACQUIRE,sanitizeAgentSettingsResult} from '../packages/business/src/agent/settings.ts';
import {createAgentModelListService} from '../packages/business/src/agent/model-list-service.ts';
import {connectionFor} from '../packages/business/src/agent/settings-envelope.ts';
import {agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot,AgentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import type {AgentModelListRequest,AgentModelListSuccess} from '../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListCacheStore} from '../packages/business/src/agent/model-list-cache.ts';
import type {SettingsContextOptions} from '../packages/business/src/agent/settings.ts';
import {testAgentCredential} from './helpers/agent-settings-fixture.ts';

const success=(id='gpt-4.1-mini',complete=true):AgentModelListSuccess=>({outcome:'success',models:[{id,adaptation:'unverified'}],complete,source:'current_protocol',fetchedAt:'2026-11-04T00:00:00.000Z'});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function metadata(snapshot:AgentSettingsSnapshot,services=snapshot.services.map(agentServiceInput)){
 return {expectedRevision:snapshot.revision,services,mioSelection:snapshot.mioSelection,secretActions:[]};
}
function request(snapshot:AgentSettingsSnapshot,serviceKey='openai',source:'saved'|'input'|'none'='saved'):AgentModelListRequest{
 const entry=snapshot.services.find(entry=>entry.serviceKey===serviceKey);assert.ok(entry);const {model:_model,...selection}=connectionFor(entry);
 return {serviceKey,expectedSettingsRevision:snapshot.revision,selection,credential:source==='input'?{source,value:'SYNTHETIC_INPUT'}:{source}};
}
function cacheStore(){
 const values=new Map<string,AgentModelListSuccess>();let writes=0,reads=0,removes=0;
 const store:AgentModelListCacheStore={read(identity){reads++;return values.get(JSON.stringify(identity))??null;},write(identity,result){writes++;values.set(JSON.stringify(identity),structuredClone(result));return true;},remove(key){removes++;for(const identity of values.keys())if(JSON.parse(identity).serviceKey===key)values.delete(identity);}};
 return {store,values,get writes(){return writes;},get reads(){return reads;},get removes(){return removes;}};
}
async function fixture(t:test.TestContext,fetch:Parameters<typeof createAgentModelListService>[0]['fetch'],cache=cacheStore()){
 let disk:unknown=null,writes=0;
 const owner=await createAgentSettings({persistence:{load:async()=>disk,save:async value=>{disk=structuredClone(value);writes++;}}});
 const models=createAgentModelListService({settings:owner,cache:cache.store,fetch});
 t.after(async()=>{await models.close();await owner.close();});
 const snapshot=await owner.put({...metadata(await owner.get()),secretActions:[{serviceKey:'openai',action:'replace',storage:'session',value:'SYNTHETIC_A'},{serviceKey:'deepseek',action:'replace',storage:'session',value:'SYNTHETIC_B'}]});
 return {owner,models,cache,snapshot,get writes(){return writes;},get disk(){return structuredClone(disk);}};
}

test('saved discovery reads the named unselected service; input is ephemeral and collection state stays unchanged',async t=>{
 const seen:Array<{selection:unknown;key:string|null}>=[];
 const f=await fixture(t,async options=>{seen.push({selection:options.selection,key:options.apiKey});return success();});
 assert.equal(f.snapshot.mioSelection,null);const baseline=f.disk,writes=f.writes;
 assert.equal((await f.models.list(request(f.snapshot,'deepseek'))).outcome,'success');
 assert.equal(seen[0]?.key,'SYNTHETIC_B');
 await f.models.list(request(f.snapshot,'openai','input'));assert.equal(seen[1]?.key,'SYNTHETIC_INPUT');
 assert.deepEqual(await f.models.settings.get(),f.snapshot);assert.deepEqual(f.disk,baseline);assert.equal(f.writes,writes);
 assert.equal(JSON.stringify([...f.cache.values]).includes('SYNTHETIC'),false);
 assert.equal((await f.models.list(request(f.snapshot,'openai','none'))).outcome,'invalid_key');assert.equal(seen.length,2);
 await assert.rejects(f.models.list({...request(f.snapshot),expectedSettingsRevision:f.snapshot.revision-1}),{code:'AGENT_SETTINGS_CONFLICT'});
});

test('list purpose cannot loosen the existing inference acquisition witness or copy a key between entries',async t=>{
 const f=await fixture(t,async()=>success());
 const snapshot=await f.owner.put({...metadata(f.snapshot),mioSelection:{serviceKey:'openai',modelId:'gpt-4.1-mini'}});
 const active=testAgentCredential(snapshot);assert.equal((await f.owner[AGENT_CREDENTIAL_ACQUIRE](active)).apiKey,'SYNTHETIC_A');
 const other=snapshot.services.find(entry=>entry.serviceKey==='deepseek')!;
 await assert.rejects(f.owner[AGENT_CREDENTIAL_ACQUIRE]({...active,binding:{...active.binding,serviceKey:'deepseek',entryRevision:other.revision},configuration:connectionFor(other)}),{code:'AGENT_SETTINGS_CONFLICT'});
 const listing={purpose:'model_list',expectedRevision:snapshot.revision,binding:{serviceKey:other.serviceKey,entryRevision:other.revision,selectionRevision:snapshot.mioSelectionRevision},configuration:connectionFor(other)};
 assert.equal((await f.owner[AGENT_CREDENTIAL_ACQUIRE](listing)).apiKey,'SYNTHETIC_B');
 await assert.rejects(f.owner[AGENT_CREDENTIAL_ACQUIRE]({...listing,configuration:{...listing.configuration,baseUrl:'https://arbitrary.example.com'}}),{code:'AGENT_SETTINGS_VALIDATION'});
 await assert.rejects(f.owner[AGENT_CREDENTIAL_ACQUIRE]({...listing,configuration:{...listing.configuration,model:'forged'}}),{code:'AGENT_SETTINGS_CONFLICT'});
 const changed=await f.owner.put({...metadata(snapshot),secretActions:[{serviceKey:'deepseek',action:'replace',storage:'session',value:'SYNTHETIC_REPLACED'}]});
 await assert.rejects(f.owner[AGENT_CREDENTIAL_ACQUIRE](listing),{code:'AGENT_SETTINGS_CONFLICT'});
 assert.equal((await f.owner[AGENT_CREDENTIAL_ACQUIRE](active)).apiKey,'SYNTHETIC_A');assert.notEqual(changed.revision,snapshot.revision);
});

test('same-recipient protocol draft acquires the saved configuration but never persists a draft cache',async t=>{
 const f=await fixture(t,async options=>{assert.equal(options.apiKey,'SYNTHETIC_B');assert.equal(options.selection.protocol,'anthropic_messages');return success('deepseek-flash');});
 const input=request(f.snapshot,'deepseek');input.selection={...input.selection,protocol:'anthropic_messages',baseUrl:'https://api.deepseek.com/anthropic'};
 assert.equal((await f.models.list(input)).outcome,'success');assert.equal(f.cache.writes,0);
 const custom:AgentServiceInput={serviceKey:'00000000-0000-4000-8000-000000000001',presetId:'custom',name:'One',platformId:'custom',protocol:'chat_completions',addressInput:'https://custom.example.com/v1',manualModelIds:[]};
 const saved=sanitizeAgentSettingsResult(await f.models.settings.put(metadata(f.snapshot,[...f.snapshot.services.map(agentServiceInput),custom])));
 const wrong=request(saved,custom.serviceKey);wrong.selection.baseUrl='https://other.example.com/v1';
 await assert.rejects(f.models.list(wrong),{code:'AGENT_SETTINGS_CONFLICT'});assert.equal(f.cache.writes,0);
});

test('unsupported descriptors finish before credential acquisition; an unsaved custom entry remains transient',async t=>{
 let acquisitions=0,calls=0;const f=await fixture(t,async()=>{calls++;return success('custom-model');});
 const acquire=f.owner[AGENT_CREDENTIAL_ACQUIRE].bind(f.owner);f.owner[AGENT_CREDENTIAL_ACQUIRE]=async(...args)=>{acquisitions++;return acquire(...args);};
 assert.deepEqual(await f.models.list(request(f.snapshot,'qwen')),{outcome:'unavailable',reason:'not_provided'});assert.equal(acquisitions,0);assert.equal(calls,0);
 const input:AgentModelListRequest={serviceKey:'00000000-0000-4000-8000-000000000001',expectedSettingsRevision:f.snapshot.revision,selection:{presetId:'custom',platformId:'custom',baseUrl:'https://new.example.com/v1',protocol:'chat_completions'},credential:{source:'input',value:'SYNTHETIC_NEW'}};
 assert.equal((await f.models.list(input)).outcome,'success');assert.equal(f.cache.writes,0);assert.equal(acquisitions,0);
 assert.deepEqual(await f.models.cache(inputToCache(input)),{status:'miss'});
});
function inputToCache(input:AgentModelListRequest){const {credential:_credential,...rest}=input;return rest;}

test('cache reads require no key or network and recompute adaptation from current profiles',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return success();});
 assert.deepEqual(await f.models.cache(inputToCache(request(f.snapshot))),{status:'miss'});
 await f.models.list(request(f.snapshot));assert.equal(calls,1);assert.equal(f.cache.writes,1);
 f.owner[AGENT_CREDENTIAL_ACQUIRE]=async()=>{throw Error('cache must not acquire');};
 const hit=await f.models.cache(inputToCache(request(f.snapshot)));assert.equal(hit.status,'hit');
 if(hit.status==='hit')assert.equal(hit.result.models[0]?.adaptation,'adapted');
 assert.equal(calls,1);assert.equal(sanitizeAgentSettingsResult(await f.models.settings.get()).verification,'not_tested');
});

test('an explicitly saved local key is not silently replaced by anonymous discovery',async t=>{
 let calls=0;const f=await fixture(t,async options=>{calls++;assert.equal(options.apiKey,'SYNTHETIC_LOCAL');return {...success(),source:'public_local'};});
 const snapshot=sanitizeAgentSettingsResult(await f.models.settings.put({...metadata(f.snapshot),secretActions:[{serviceKey:'ollama',action:'replace',storage:'session',value:'SYNTHETIC_LOCAL'}]}));
 await assert.rejects(f.models.list(request(snapshot,'ollama','none'),{selfPort:9999}),{code:'AGENT_SETTINGS_VALIDATION'});assert.equal(calls,0);
 assert.equal((await f.models.list(request(snapshot,'ollama','saved'),{selfPort:9999})).outcome,'success');assert.equal(calls,1);
});

test('save/delete between network completion and commit cancels late publication and cannot recreate a removed custom entry',async t=>{
 const entered=deferred<void>(),answer=deferred<AgentModelListSuccess>();const f=await fixture(t,async()=>{entered.resolve();return answer.promise;});
 const custom:AgentServiceInput={serviceKey:'00000000-0000-4000-8000-000000000001',presetId:'custom',name:'One',platformId:'custom',protocol:'chat_completions',addressInput:'https://custom.example.com/v1',manualModelIds:[]};
 const initial=sanitizeAgentSettingsResult(await f.models.settings.put(metadata(f.snapshot,[...f.snapshot.services.map(agentServiceInput),custom])));
 const pending=f.models.list(request(initial,custom.serviceKey,'input')),rejected=assert.rejects(pending,{code:'AGENT_SETTINGS_CLOSED'});await entered.promise;
 await f.models.settings.put(metadata(initial,initial.services.filter(entry=>entry.serviceKey!==custom.serviceKey).map(agentServiceInput)));
 answer.resolve(success());await rejected;assert.equal(f.cache.writes,0);assert.equal(f.cache.values.size,0);assert.equal(f.cache.removes,1);
});

test('final cache witness and publication share admission with the entire following settings commit',async t=>{
 const cache=cacheStore(),entered=deferred<void>(),release=deferred<void>(),write=cache.store.write.bind(cache.store);
 cache.store.write=async(...args)=>{entered.resolve();await release.promise;return write(...args);};
 const f=await fixture(t,async()=>success(),cache);
 const pending=f.models.list(request(f.snapshot));await entered.promise;
 let settled=false;const writing=f.models.settings.put(metadata(f.snapshot)).then(value=>{settled=true;return value;});
 await Promise.resolve();assert.equal(settled,false);assert.equal(f.writes,1);
 release.resolve();assert.equal((await pending).outcome,'success');await writing;assert.equal(settled,true);assert.equal(f.writes,2);
});

test('the total list deadline also bounds waiting for the settings/cache admission queue',async t=>{
 const cache=cacheStore(),entered=deferred<void>(),release=deferred<void>(),write=cache.store.write.bind(cache.store);
 cache.store.write=async(...args)=>{entered.resolve();await release.promise;return write(...args);};
 const f=await fixture(t,async()=>success(),cache);
 const publishing=f.models.list(request(f.snapshot));await entered.promise;
 t.mock.timers.enable({apis:['setTimeout','Date']});
 try{
  const queued=f.models.list(request(f.snapshot,'deepseek'));
  t.mock.timers.tick(15000);
  assert.deepEqual(await queued,{outcome:'unreachable',reason:'timeout'});
  assert.equal(f.cache.writes,0,'deadline settles without waiting for the preceding publication');
 }finally{t.mock.timers.reset();release.resolve();}
 assert.equal((await publishing).outcome,'success');
 assert.equal(f.cache.writes,1,'expired queued request never dispatches or publishes later');
});

test('cancelled cache reads settle while an earlier publication owns admission',async t=>{
 const cache=cacheStore(),entered=deferred<void>(),release=deferred<void>(),write=cache.store.write.bind(cache.store);
 cache.store.write=async(...args)=>{entered.resolve();await release.promise;return write(...args);};
 const f=await fixture(t,async()=>success(),cache),publishing=f.models.list(request(f.snapshot));await entered.promise;
 const controller=new AbortController(),reading=f.models.cache(inputToCache(request(f.snapshot)),{signal:controller.signal});
 controller.abort();await assert.rejects(reading,{code:'AGENT_SETTINGS_CLOSED'});
 release.resolve();await publishing;assert.equal(f.cache.writes,1);
});

test('two fetches completing backwards retain only the newest epoch, including partial and complete empty lists',async t=>{
 const answers=[deferred<AgentModelListSuccess>(),deferred<AgentModelListSuccess>()],entered=[deferred<void>(),deferred<void>()];let calls=0;
 const f=await fixture(t,async()=>{const index=calls++;entered[index]!.resolve();return answers[index]!.promise;});
 const first=f.models.list(request(f.snapshot)),rejected=assert.rejects(first,{code:'AGENT_SETTINGS_CLOSED'});await entered[0]!.promise;
 const second=f.models.list(request(f.snapshot));await entered[1]!.promise;
 answers[1]!.resolve({...success('new',false),models:[]});assert.equal((await second).outcome,'success');answers[0]!.resolve(success('old'));await rejected;
 assert.equal(f.cache.writes,1);const hit=await f.models.cache(inputToCache(request(f.snapshot)));assert.equal(hit.status,'hit');if(hit.status==='hit'){assert.equal(hit.result.complete,false);assert.deepEqual(hit.result.models,[]);}
});

test('unrelated collection save and caller cancellation both reject delayed results without cache writes',async t=>{
 for(const operation of ['save','abort','close'] as const){
  const entered=deferred<void>(),answer=deferred<AgentModelListSuccess>(),f=await fixture(t,async()=>{entered.resolve();return answer.promise;});
  const controller=new AbortController(),pending=f.models.list(request(f.snapshot),{signal:controller.signal}),rejected=assert.rejects(pending,error=>['AGENT_SETTINGS_CONFLICT','AGENT_SETTINGS_CLOSED'].includes((error as {code:string}).code));await entered.promise;
  if(operation==='save')await f.models.settings.put(metadata(f.snapshot));
  else if(operation==='abort')controller.abort();else await f.models.close();
  answer.resolve(success());await rejected;assert.equal(f.cache.writes,0);
 }
});

test('legacy projected settings and failed list responses never create cache or change verification',async t=>{
 let writes=0;const owner=await createAgentSettings({persistence:{load:async()=>({version:2,revision:1,configuration:{presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',model:'gpt-4.1-mini',protocol:'chat_completions'},secret:null}),save:async()=>{writes++;}}});
 const store=cacheStore(),models=createAgentModelListService({settings:owner,cache:store.store,fetch:async()=>success()});t.after(async()=>{await models.close();await owner.close();});
 const snapshot=await owner.get();assert.ok(snapshot.notices.length);await models.list(request(snapshot,'openai','input'));
 assert.equal(store.writes,0);assert.equal(writes,0);assert.deepEqual(await owner.get(),snapshot);
 const f=await fixture(t,async()=>({outcome:'unreachable',reason:'http_error'}));
 assert.deepEqual(await f.models.list(request(f.snapshot)),{outcome:'unreachable',reason:'http_error'});assert.equal(f.cache.writes,0);
});

test('service activity remains local while every settings-owner call receives only transport context',async t=>{
 const f=await fixture(t,async()=>success());
 const operations:string[]=[],get=f.owner.get.bind(f.owner),put=f.owner.put.bind(f.owner),acquire=f.owner[AGENT_CREDENTIAL_ACQUIRE].bind(f.owner);
 function transport(operation:string,options?:SettingsContextOptions){
  operations.push(operation);assert.deepEqual(Object.keys(options??{}).sort(),['selfPort','signal']);
  assert.equal(options?.selfPort,4318);assert.ok(options?.signal instanceof AbortSignal);
 }
 f.owner.get=async options=>{transport('get',options);return get(options);};
 f.owner.put=async(input,options)=>{transport('put',options);return put(input,options);};
 f.owner[AGENT_CREDENTIAL_ACQUIRE]=async(input,options)=>{transport('acquire',options);return acquire(input,options);};
 let active=true;const options={selfPort:4318,isActive:()=>active};
 assert.deepEqual(await f.models.settings.get(options),f.snapshot);
 const saved=sanitizeAgentSettingsResult(await f.models.settings.put({...metadata(f.snapshot),mioSelection:{serviceKey:'openai',modelId:'gpt-4.1-mini'}},options));
 assert.equal((await f.models.settings[AGENT_CREDENTIAL_ACQUIRE]!(testAgentCredential(saved),options) as {apiKey:string}).apiKey,'SYNTHETIC_A');
 assert.equal((await f.models.list(request(saved),options)).outcome,'success');
 assert.equal((await f.models.cache(inputToCache(request(saved)),options)).status,'hit');
 assert.ok(operations.includes('put'));assert.ok(operations.includes('acquire'));assert.ok(operations.filter(value=>value==='get').length>1);
 const before=operations.length;active=false;
 await assert.rejects(f.models.settings.get(options),{code:'AGENT_SETTINGS_CLOSED'});
 await assert.rejects(f.models.list(request(saved),options),{code:'AGENT_SETTINGS_CLOSED'});
 assert.equal(operations.length,before,'Inactive admission cannot dispatch to the owner');
});

test('service-only activity loss still rejects a delayed provider reply without publishing its cache',async t=>{
 const entered=deferred<void>(),answer=deferred<AgentModelListSuccess>();let active=true;
 const f=await fixture(t,async()=>{entered.resolve();return answer.promise;});
 const pending=f.models.list(request(f.snapshot),{isActive:()=>active});
 const rejected=assert.rejects(pending,{code:'AGENT_SETTINGS_CLOSED'});
 await entered.promise;active=false;answer.resolve(success());await rejected;
 assert.equal(f.cache.writes,0);assert.equal(f.cache.values.size,0);
 assert.deepEqual(await f.owner.get(),f.snapshot);
});

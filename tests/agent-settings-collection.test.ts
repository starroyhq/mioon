import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AGENT_CREDENTIAL_ACQUIRE,createAgentSettings} from '../packages/business/src/agent/settings.ts';
import type {AgentSettingsService,PublicStorage,SecretCodec} from '../packages/business/src/agent/settings.ts';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.ts';
import {AGENT_CONNECTION_LIMITS,agentServiceInput,agentSettingsSnapshotSchema} from '../packages/contracts/src/agent-connection-settings.ts';
import type {AgentMioSelection,AgentSecretAction,AgentServiceInput,AgentSettingsSnapshot,AgentSettingsUpdate} from '../packages/contracts/src/agent-connection-settings.ts';
import {agentSettingsEnvelopeSchema} from '../packages/contracts/src/agent-connection-private.ts';
import {testAgentCredential,testAgentExecution} from './helpers/agent-settings-fixture.ts';

const persistent:PublicStorage={persistentAvailable:true,sessionScope:'app',reasonCode:null};
const selected:AgentMioSelection={serviceKey:'openai',modelId:'gpt-4.1-mini'};
const customKey=(index:number)=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const custom=(index:number,base='https://gateway.example.com/team/v1'):AgentServiceInput=>({serviceKey:customKey(index),presetId:'custom',name:`Custom ${index}`,platformId:'custom',protocol:'chat_completions',addressInput:base,manualModelIds:[]});
const replace=(serviceKey:string,value:string,storage:'session'|'persistent'='session'):AgentSecretAction=>({serviceKey,action:'replace',storage,value});
function memoryPersistence(initial:unknown=null){
 let value=structuredClone(initial),writes=0;
 return {load:async()=>structuredClone(value),save:async(candidate:unknown)=>{value=structuredClone(candidate);writes++;},get value(){return structuredClone(value);},get writes(){return writes;}};
}
// A transparent synthetic codec makes encrypted-envelope tampering deterministic.
// It is not an OS key store or a production encryption fallback.
const encode=(value:string)=>Buffer.from(value).toString('base64');
const decode=(value:string)=>Buffer.from(value,'base64').toString();
const syntheticCodec=():SecretCodec=>({encrypt:encode,decrypt:decode});
function update(snapshot:AgentSettingsSnapshot,options:{services?:AgentServiceInput[];selection?:AgentMioSelection|null;actions?:AgentSecretAction[]}={}):AgentSettingsUpdate{
 return {expectedRevision:snapshot.revision,services:options.services??snapshot.services.map(agentServiceInput),mioSelection:options.selection===undefined?snapshot.mioSelection:options.selection,secretActions:options.actions??[]};
}
function edit(snapshot:AgentSettingsSnapshot,key:string,changes:Partial<AgentServiceInput>):AgentServiceInput[]{
 return snapshot.services.map(entry=>({...agentServiceInput(entry),...(entry.serviceKey===key?changes:{})}));
}
const entry=(snapshot:AgentSettingsSnapshot,key:string)=>{const found=snapshot.services.find(value=>value.serviceKey===key);assert.ok(found);return found;};
const acquire=(settings:AgentSettingsService,snapshot:AgentSettingsSnapshot)=>settings[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(snapshot));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('saving B and its key changes only collection CAS while A keeps its execution witness and credential',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const a=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_A')]}));
 const frozen=testAgentCredential(a),before=testAgentExecution(a);
 const b=await settings.put(update(a,{services:edit(a,'deepseek',{manualModelIds:['synthetic-b-model']}),actions:[replace('deepseek','SYNTHETIC_B')]}));
 assert.equal(b.revision,a.revision+1);assert.equal(entry(b,'deepseek').revision,entry(a,'deepseek').revision+1);
 assert.equal(entry(b,'openai').revision,entry(a,'openai').revision);assert.deepEqual(b.execution,before);
 assert.equal((await settings[AGENT_CREDENTIAL_ACQUIRE](frozen)).apiKey,'SYNTHETIC_A');
 assert.equal(JSON.stringify(b).includes('SYNTHETIC_'),false);assert.equal(JSON.stringify(persistence.value).includes('SYNTHETIC_'),false);
 await assert.rejects(settings.put(update(a,{actions:[replace('deepseek','SYNTHETIC_STALE')]})),{code:'AGENT_SETTINGS_CONFLICT'});
 assert.deepEqual(await settings.get(),b);assert.equal((await acquire(settings,b)).apiKey,'SYNTHETIC_A');
});

test('selected entry metadata, key-only replacement and model/service ABA each reject the old execution witness',async t=>{
 const settings=await createAgentSettings({persistence:memoryPersistence()});t.after(()=>settings.close());
 let snapshot=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_A')]}));
 const original=testAgentCredential(snapshot);
 const changes:[string,(value:AgentSettingsSnapshot)=>AgentSettingsUpdate][]=[
  ['metadata',value=>update(value,{services:edit(value,'openai',{manualModelIds:['manual-model']})})],
  ['key only',value=>update(value,{actions:[replace('openai','SYNTHETIC_REPLACED')]})],
  ['model away',value=>update(value,{selection:{serviceKey:'openai',modelId:'manual-model'}})],
  ['model back',value=>update(value,{selection:selected})],
  ['service away',value=>update(value,{selection:{serviceKey:'deepseek',modelId:'deepseek-flash'}})],
  ['service back',value=>update(value,{selection:selected})],
 ];
 for(const [label,request] of changes){
  const previous=testAgentCredential(snapshot),next=await settings.put(request(snapshot));
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE](previous),{code:'AGENT_SETTINGS_CONFLICT'},label);
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE](original),{code:'AGENT_SETTINGS_CONFLICT'},`${label}: original ABA witness`);
  assert.equal(testAgentExecution(next).revision,testAgentExecution(snapshot).revision+1,label);snapshot=next;
 }
 assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_REPLACED');
});

test('two custom services at the same complete URL never share session keys, including rename and deletion',async t=>{
 const settings=await createAgentSettings({persistence:memoryPersistence()});t.after(()=>settings.close());
 const initial=await settings.get();
 let snapshot=await settings.put(update(initial,{services:[...initial.services.map(agentServiceInput),custom(1),custom(2)],selection:{serviceKey:customKey(1),modelId:'same-model'},actions:[replace(customKey(1),'SYNTHETIC_CUSTOM_A'),replace(customKey(2),'SYNTHETIC_CUSTOM_B')]}));
 assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_CUSTOM_A');
 const frozen=testAgentCredential(snapshot);
 snapshot=await settings.put(update(snapshot,{services:edit(snapshot,customKey(2),{name:'Renamed B'})}));
 assert.equal((await settings[AGENT_CREDENTIAL_ACQUIRE](frozen)).apiKey,'SYNTHETIC_CUSTOM_A');
 snapshot=await settings.put(update(snapshot,{selection:{serviceKey:customKey(2),modelId:'same-model'}}));
 assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_CUSTOM_B');
 await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE](frozen),{code:'AGENT_SETTINGS_CONFLICT'});
 snapshot=await settings.put(update(snapshot,{services:snapshot.services.filter(s=>s.serviceKey!==customKey(1)).map(agentServiceInput)}));
 assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_CUSTOM_B');
 snapshot=await settings.put(update(snapshot,{services:[...snapshot.services.map(agentServiceInput),custom(1)],selection:{serviceKey:customKey(1),modelId:'same-model'}}));
 assert.equal((await acquire(settings,snapshot)).apiKey,null,'recreated UUID does not resurrect its removed session key');
});

test('workspace ID and local origin preserve keys across protocol changes but changed ID, region or port clears only that service',async t=>{
 for(const mode of ['workspace','local'] as const){
  const settings=await createAgentSettings({persistence:memoryPersistence()});t.after(()=>settings.close());
  const key=mode==='workspace'?'qwen':'ollama',initial=await settings.get();
  const services=edit(initial,key,mode==='workspace'?{platformId:'workspace-cn-beijing',addressInput:'workspace-a'}:{addressInput:'http://localhost:11434'});
  let snapshot=await settings.put(update(initial,{services,selection:{serviceKey:key,modelId:'unknown-model'},actions:[replace(key,'SYNTHETIC_BOUND'),replace('deepseek','SYNTHETIC_UNRELATED')]}));
  for(const protocol of ['responses','anthropic_messages','chat_completions'] as const){
   snapshot=await settings.put(update(snapshot,{services:edit(snapshot,key,{protocol})}));
   assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_BOUND',`${mode}/${protocol}`);
  }
  if(mode==='workspace'){
   snapshot=await settings.put(update(snapshot,{services:edit(snapshot,key,{platformId:'workspace-ap-southeast-1'})}));
   assert.equal((await acquire(settings,snapshot)).apiKey,null,'region changes the recipient');
   snapshot=await settings.put(update(snapshot,{actions:[replace(key,'SYNTHETIC_REGION')]}));
  }
  snapshot=await settings.put(update(snapshot,{services:edit(snapshot,key,{addressInput:mode==='workspace'?'workspace-b':'http://localhost:11435'})}));
  assert.equal((await acquire(settings,snapshot)).apiKey,null);
  assert.deepEqual(entry(snapshot,'deepseek').secret,{configured:true,storage:'session'});
  snapshot=await settings.put(update(snapshot,{selection:{serviceKey:'deepseek',modelId:'deepseek-flash'}}));
  assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_UNRELATED');
 }
});

test('mixed multi-key update rolls back RAM and disk when its second persistent encryption fails',async t=>{
 const persistence=memoryPersistence();let encryptions=0;
 const settings=await createAgentSettings({persistence,storage:persistent,secretCodec:{...syntheticCodec(),encrypt(value){if(++encryptions===2)throw Error('SYNTHETIC_PRIVATE_FAILURE');return encode(value);}}});t.after(()=>settings.close());
 const baseline=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_A0'),replace('deepseek','SYNTHETIC_B0'),replace('qwen','SYNTHETIC_C0')]}));
 const disk=persistence.value,writes=persistence.writes;
 await assert.rejects(settings.put(update(baseline,{actions:[{serviceKey:'openai',action:'remove'},replace('deepseek','SYNTHETIC_B1','persistent'),replace('qwen','SYNTHETIC_C1','persistent')]})),error=>{
  assert.equal((error as {code:string}).code,'AGENT_SETTINGS_STORAGE_UNAVAILABLE');assert.doesNotMatch(String(error),/SYNTHETIC/);return true;
 });
 assert.equal(encryptions,2);assert.equal(persistence.writes,writes);assert.deepEqual(persistence.value,disk);assert.deepEqual(await settings.get(),baseline);
 let snapshot=baseline;
 for(const [serviceKey,modelId,value] of [['openai','gpt-4.1-mini','SYNTHETIC_A0'],['deepseek','deepseek-flash','SYNTHETIC_B0'],['qwen','qwen-plus','SYNTHETIC_C0']]){
  snapshot=await settings.put(update(snapshot,{selection:{serviceKey:serviceKey!,modelId:modelId!}}));assert.equal((await acquire(settings,snapshot)).apiKey,value);
 }
});

test('cancelling a queued encrypted collection save discards its late result and every proposed session mutation',async t=>{
 const persistence=memoryPersistence(),entered=deferred<void>(),answer=deferred<string>();
 const settings=await createAgentSettings({persistence,storage:persistent,secretCodec:{...syntheticCodec(),encrypt(){entered.resolve();return answer.promise;}}});t.after(()=>settings.close());
 const baseline=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_OLD')]})),disk=persistence.value;
 const controller=new AbortController(),pending=settings.put(update(baseline,{actions:[replace('openai','SYNTHETIC_NEW'),replace('deepseek','SYNTHETIC_PENDING','persistent')]}),{signal:controller.signal});
 await entered.promise;controller.abort();answer.resolve(encode('SYNTHETIC_LATE_RESULT'));
 await assert.rejects(pending,{code:'AGENT_SETTINGS_CLOSED'});
 assert.deepEqual(await settings.get(),baseline);assert.deepEqual(persistence.value,disk);assert.equal((await acquire(settings,baseline)).apiKey,'SYNTHETIC_OLD');
});

test('collection CAS rejects a second queued save before any of its key encryption runs',async t=>{
 const persistence=memoryPersistence(),entered=deferred<void>(),answer=deferred<string>();let encryptions=0;
 const settings=await createAgentSettings({persistence,storage:persistent,secretCodec:{...syntheticCodec(),encrypt(value){encryptions++;if(encryptions===1){entered.resolve();return answer.promise.then(()=>encode(value));}return encode(value);}}});t.after(()=>settings.close());
 const initial=await settings.get(),first=settings.put(update(initial,{selection:selected,actions:[replace('openai','SYNTHETIC_WINNER','persistent')]}));
 await entered.promise;
 const second=settings.put(update(initial,{selection:{serviceKey:'deepseek',modelId:'deepseek-flash'},actions:[replace('deepseek','SYNTHETIC_LOSER','persistent')]}));
 answer.resolve('release');const saved=await first;
 await assert.rejects(second,{code:'AGENT_SETTINGS_CONFLICT'});assert.equal(encryptions,1);assert.equal(persistence.writes,1);
 assert.deepEqual(await settings.get(),saved);assert.equal((await acquire(settings,saved)).apiKey,'SYNTHETIC_WINNER');
});

test('durable save failure leaves all replacements and removals unapplied in memory',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const baseline=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_OLD'),replace('deepseek','SYNTHETIC_B')]})),disk=persistence.value;
 persistence.save=async()=>{throw Error('SYNTHETIC_RAW_DISK_FAILURE');};
 await assert.rejects(settings.put(update(baseline,{actions:[replace('openai','SYNTHETIC_NEW'),{serviceKey:'deepseek',action:'remove'}]})),{code:'AGENT_SETTINGS_SAVE_FAILED'});
 assert.deepEqual(await settings.get(),baseline);assert.deepEqual(persistence.value,disk);assert.equal((await acquire(settings,baseline)).apiKey,'SYNTHETIC_OLD');
});

test('custom service, manual model and model ID limits accept the exact boundary and reject the next item atomically',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const initial=await settings.get();let snapshot=await settings.put(update(initial,{services:[...initial.services.map(agentServiceInput),...Array.from({length:10},(_,i)=>custom(i+1))],selection:{serviceKey:customKey(1),modelId:'m'.repeat(200)}}));
 assert.equal(snapshot.services.length,19);assert.equal(testAgentExecution(snapshot).configuration.model.length,200);
 const manual=Array.from({length:50},(_,i)=>i===0?'m'.repeat(200):`manual-${i}`);
 snapshot=await settings.put(update(snapshot,{services:edit(snapshot,customKey(1),{manualModelIds:manual})}));
 const disk=persistence.value;
 for(const invalid of [
  update(snapshot,{services:[...snapshot.services.map(agentServiceInput),custom(11)]}),
  update(snapshot,{services:edit(snapshot,customKey(1),{manualModelIds:[...manual,'manual-51']})}),
  update(snapshot,{services:edit(snapshot,customKey(1),{manualModelIds:['m'.repeat(201)]})}),
  update(snapshot,{selection:{serviceKey:customKey(1),modelId:'m'.repeat(201)}}),
 ]){
  await assert.rejects(settings.put(invalid),{code:'AGENT_SETTINGS_VALIDATION'});assert.deepEqual(await settings.get(),snapshot);assert.deepEqual(persistence.value,disk);
 }
});

test('the selected custom entry requires a separate saved Mio selection before deletion',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const initial=await settings.get();let snapshot=await settings.put(update(initial,{services:[...initial.services.map(agentServiceInput),custom(1)],selection:{serviceKey:customKey(1),modelId:'manual'},actions:[replace(customKey(1),'SYNTHETIC_SELECTED')]}));
 const removed=snapshot.services.filter(s=>s.serviceKey!==customKey(1)).map(agentServiceInput),disk=persistence.value;
 for(const selection of [snapshot.mioSelection,selected,null])await assert.rejects(settings.put(update(snapshot,{services:removed,selection})),{code:'AGENT_SETTINGS_VALIDATION'});
 assert.deepEqual(await settings.get(),snapshot);assert.deepEqual(persistence.value,disk);
 snapshot=await settings.put(update(snapshot,{selection:selected}));snapshot=await settings.put(update(snapshot,{services:snapshot.services.filter(s=>s.serviceKey!==customKey(1)).map(agentServiceInput)}));
 assert.equal(snapshot.services.some(s=>s.serviceKey===customKey(1)),false);assert.equal((await acquire(settings,snapshot)).apiKey,null);
});

test('malformed, duplicate and foreign secret actions cannot change any service in the collection',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const snapshot=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_OLD')]})),disk=persistence.value;
 for(const secretActions of [
  [replace('openai','SYNTHETIC_NEW'),replace('openai','SYNTHETIC_DUPLICATE')],
  [replace(customKey(10),'SYNTHETIC_FOREIGN')],
  [{serviceKey:'openai',action:'keep',value:'SYNTHETIC_SURPLUS'}],
  [replace('openai','SYNTHETIC_NEW'),{serviceKey:'deepseek',action:'replace',storage:'persistent',value:'\u0000SYNTHETIC_INVALID'}],
 ])await assert.rejects(settings.put({...update(snapshot),secretActions}),{code:'AGENT_SETTINGS_VALIDATION'});
 assert.deepEqual(await settings.get(),snapshot);assert.deepEqual(persistence.value,disk);assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_OLD');
});

test('credential and whole-collection UTF-8 byte limits accept byte zero and reject byte one without partial writes',async t=>{
 const persistence=memoryPersistence(),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
 const exactKey='界'.repeat(2730)+'xx';assert.equal(Buffer.byteLength(exactKey),8192);
 let snapshot=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai',exactKey)]}));
 assert.equal((await acquire(settings,snapshot)).apiKey,exactKey);
 let disk=persistence.value,writes=persistence.writes;
 await assert.rejects(settings.put(update(snapshot,{actions:[replace('openai',exactKey+'x')]})),{code:'AGENT_SETTINGS_VALIDATION'});
 assert.deepEqual(await settings.get(),snapshot);assert.deepEqual(persistence.value,disk);assert.equal(persistence.writes,writes);
 const keys=snapshot.services.filter(s=>s.serviceKey!=='ollama').map(s=>s.serviceKey);assert.equal(keys.length,8);
 const request=update(snapshot,{actions:keys.map((key,index)=>replace(key,index<7?'x'.repeat(8192):'x'))});
 const final=request.secretActions.at(-1);assert.ok(final?.action==='replace');
 const padding=AGENT_CONNECTION_LIMITS.dtoBytes-Buffer.byteLength(JSON.stringify(request));assert.ok(padding>0&&padding<8192);
 final.value+='x'.repeat(padding);assert.equal(Buffer.byteLength(JSON.stringify(request)),AGENT_CONNECTION_LIMITS.dtoBytes);
 snapshot=await settings.put(request);assert.equal((await acquire(settings,snapshot)).apiKey,'x'.repeat(8192));
 disk=persistence.value;writes=persistence.writes;
 const over={...request,expectedRevision:snapshot.revision,secretActions:request.secretActions.map(action=>action===final?{...action,value:final.value+'x'}:action)};
 assert.equal(Buffer.byteLength(JSON.stringify(over)),AGENT_CONNECTION_LIMITS.dtoBytes+1);
 await assert.rejects(settings.put(over),{code:'AGENT_SETTINGS_VALIDATION'});
 assert.deepEqual(await settings.get(),snapshot);assert.deepEqual(persistence.value,disk);assert.equal(persistence.writes,writes);
});

test('real private v3 file restarts all persistent service keys while session keys never reach the file',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-settings-collection-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const persistence=createAgentSettingsFile({directory:path.join(root,'private'),privateRoot:root}),codec=syntheticCodec();
 let settings=await createAgentSettings({persistence,storage:persistent,secretCodec:codec});t.after(()=>settings.close());
 let snapshot=await settings.put(update(await settings.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_DISK_A','persistent'),replace('deepseek','SYNTHETIC_DISK_B','persistent'),replace('qwen','SYNTHETIC_RAM_C')]}));
 const text=await readFile(path.join(root,'private/settings.json'),'utf8');assert.doesNotMatch(text,/SYNTHETIC_/u);assert.equal(JSON.parse(text).version,3);
 await settings.close();settings=await createAgentSettings({persistence,storage:persistent,secretCodec:codec});snapshot=await settings.get();
 assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_DISK_A');assert.deepEqual(entry(snapshot,'qwen').secret,{configured:false,storage:'none'});
 snapshot=await settings.put(update(snapshot,{selection:{serviceKey:'deepseek',modelId:'deepseek-flash'}}));assert.equal((await acquire(settings,snapshot)).apiKey,'SYNTHETIC_DISK_B');
 assert.equal(agentSettingsSnapshotSchema.safeParse(snapshot).success,true);
});

test('ciphertext copied between same-URL custom owners or carrying old/wrong plaintext schema fails closed',async t=>{
 const base=memoryPersistence(),writer=await createAgentSettings({persistence:base,storage:persistent,secretCodec:syntheticCodec()});t.after(()=>writer.close());
 const initial=await writer.get();await writer.put(update(initial,{services:[...initial.services.map(agentServiceInput),custom(1),custom(2)],selection:{serviceKey:customKey(2),modelId:'same-model'},actions:[replace(customKey(1),'SYNTHETIC_PRIVATE_A','persistent'),replace(customKey(2),'SYNTHETIC_PRIVATE_B','persistent')]}));
 const original=agentSettingsEnvelopeSchema.parse(base.value),a=original.services.find(s=>s.serviceKey===customKey(1)),b=original.services.find(s=>s.serviceKey===customKey(2));assert.ok(a?.secret&&b?.secret);
 const plaintext=JSON.parse(decode(b.secret.encrypted)) as Record<string,unknown>;
 const attacks=[
  a.secret.encrypted,
  encode(JSON.stringify({...plaintext,version:1})),
  encode(JSON.stringify({...plaintext,binding:'mioon.agent.credentials.v2'})),
  encode(JSON.stringify({...plaintext,serviceKey:customKey(1)})),
  encode(JSON.stringify({...plaintext,extra:'SYNTHETIC_UNKNOWN_FIELD'})),
  encode(JSON.stringify({...plaintext,value:17})),
 ];
 for(const encrypted of attacks){
  const forged=structuredClone(original),target=forged.services.find(s=>s.serviceKey===customKey(2));assert.ok(target?.secret);target.secret.encrypted=encrypted;
  const persistence=memoryPersistence(forged),settings=await createAgentSettings({persistence,storage:persistent,secretCodec:syntheticCodec()});t.after(()=>settings.close());
  const snapshot=await settings.get();assert.equal(testAgentExecution(snapshot).secret.configured,true);
  await assert.rejects(acquire(settings,snapshot),error=>{assert.equal((error as {code:string}).code,'AGENT_SETTINGS_STORAGE_UNAVAILABLE');assert.doesNotMatch(String(error),/SYNTHETIC_/u);return true;});
  assert.deepEqual(persistence.value,forged);assert.equal(persistence.writes,0);
 }
});

test('outer private v3 binding/schema corruption is rejected before any decrypt or save',async t=>{
 const base=memoryPersistence(),writer=await createAgentSettings({persistence:base,storage:persistent,secretCodec:syntheticCodec()});t.after(()=>writer.close());
 const saved=await writer.put(update(await writer.get(),{selection:selected,actions:[replace('openai','SYNTHETIC_PRIVATE','persistent')]}));
 const original=agentSettingsEnvelopeSchema.parse(base.value);
 for(const mutation of [
  (value:Record<string,unknown>)=>{value.version=4;},
  (value:Record<string,unknown>)=>{value.unexpected='SYNTHETIC_FIELD';},
  (value:Record<string,unknown>)=>{const services=value.services as Array<{secret:{binding:string}|null}>;services.find(s=>s.secret)!.secret!.binding='mioon.agent.credentials.v2';},
 ]){
  const forged:Record<string,unknown>=structuredClone(original);mutation(forged);const persistence=memoryPersistence(forged);let decrypts=0;
  const settings=await createAgentSettings({persistence,storage:persistent,secretCodec:{...syntheticCodec(),decrypt(){decrypts++;throw Error('must not decrypt');}}});t.after(()=>settings.close());
  await assert.rejects(settings.get(),{code:'AGENT_SETTINGS_CORRUPT'});await assert.rejects(settings.put(update(saved)),{code:'AGENT_SETTINGS_CORRUPT'});assert.equal(decrypts,0);assert.equal(persistence.writes,0);
 }
});

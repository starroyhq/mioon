import {AGENT_MODEL_LIST_LIMITS,agentModelListRequestSchema,agentModelListCacheRequestSchema,agentModelListResultSchema} from '../../../contracts/src/agent-model-list.ts';
import type {AgentModelListRequest,AgentModelListCacheRequest,AgentModelListResult,AgentModelListCacheResult,AgentModelListSelection} from '../../../contracts/src/agent-model-list.ts';
import type {AgentServiceSnapshot,AgentSettingsSnapshot} from '../../../contracts/src/agent-connection-settings.ts';
import {agentSettingsSnapshotSchema} from '../../../contracts/src/agent-connection-settings.ts';
import {AGENT_CREDENTIAL_ACQUIRE,sanitizeAgentSettingsResult,sanitizeAgentCredentialResult} from './settings.ts';
import type {AgentCredentialRequest,SettingsContextOptions} from './settings.ts';
import {agentSettingsError,agentCredentialBinding} from './config.ts';
import {connectionFor,serviceBinding} from './settings-envelope.ts';
import {parseAgentModelListSelection,resolveAgentModelListDescriptor,adaptAgentModelListModels} from './model-list-descriptors.ts';
import {fetchAgentModelList} from './model-list.ts';
import type {AgentModelListCacheIdentity,AgentModelListCacheStore} from './model-list-cache.ts';

export interface AgentModelListSettingsPort{
 get(options?:SettingsContextOptions):Promise<unknown>;
 put(input:unknown,options?:SettingsContextOptions):Promise<unknown>;
 [AGENT_CREDENTIAL_ACQUIRE]?(input:unknown,options?:SettingsContextOptions):Promise<unknown>;
 close():unknown;
}
interface FrozenList{
 snapshot:AgentSettingsSnapshot;entry:AgentServiceSnapshot|undefined;
 selection:AgentModelListSelection;identity:AgentModelListCacheIdentity|null;
}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const conflict=():never=>{throw agentSettingsError('AGENT_SETTINGS_CONFLICT');};
const validation=():never=>{throw agentSettingsError('AGENT_SETTINGS_VALIDATION');};

/** The application's single settings-write admission is also the cache commit
 * admission. Desktop main still owns encryption; no list payload crosses its
 * credential broker. Network work never holds this queue. */
export function createAgentModelListService({settings:owner,cache:store,fetch:fetchList=fetchAgentModelList,selfPort=()=>undefined,signal}:{settings:AgentModelListSettingsPort;cache?:AgentModelListCacheStore;fetch?:typeof fetchAgentModelList;selfPort?:()=>number|undefined;signal?:AbortSignal}){
 const lifetime=new AbortController(),epochs=new Map<string,number>(),pending=new Map<string,AbortController>();
 let tail:Promise<unknown>=Promise.resolve(),closed=false;
 const closeSignal=()=>lifetime.abort();signal?.addEventListener('abort',closeSignal,{once:true});if(signal?.aborted)closeSignal();
 function context(options:SettingsContextOptions={}):SettingsContextOptions{
  return {...options,selfPort:options.selfPort??selfPort(),signal:options.signal?AbortSignal.any([lifetime.signal,options.signal]):lifetime.signal};
 }
 function checkpoint(options:SettingsContextOptions):void{if(closed||options.signal?.aborted||options.isActive?.()===false)throw agentSettingsError('AGENT_SETTINGS_CLOSED');}
 function wait<T>(promise:Promise<T>,options:SettingsContextOptions):Promise<T>{
  // A caller's deadline bounds queue admission and credential waits too. The
  // queued work retains its checkpoint so it cannot dispatch after rejection.
  return new Promise<T>((resolve,reject)=>{
   const aborted=()=>reject(agentSettingsError('AGENT_SETTINGS_CLOSED'));
   if(options.signal?.aborted){promise.catch(()=>{});aborted();return;}
   options.signal?.addEventListener('abort',aborted,{once:true});
   promise.then(resolve,reject).finally(()=>options.signal?.removeEventListener('abort',aborted));
  });
 }
 function schedule<T>(operation:()=>T|Promise<T>):Promise<T>{
  const result=tail.then(()=>{if(closed||lifetime.signal.aborted)throw agentSettingsError('AGENT_SETTINGS_CLOSED');return operation();});tail=result.catch(()=>{});return result;
 }
 async function read(options:SettingsContextOptions):Promise<AgentSettingsSnapshot>{checkpoint(options);const value=sanitizeAgentSettingsResult(await owner.get(options));checkpoint(options);return value;}
 function freeze(snapshot:AgentSettingsSnapshot,input:AgentModelListCacheRequest,options:SettingsContextOptions):FrozenList{
  if(snapshot.revision!==input.expectedSettingsRevision)conflict();
  let selection:AgentModelListSelection;try{selection=parseAgentModelListSelection(input.selection,options);}catch{return validation();}
  if(!equal(selection,input.selection)||(selection.presetId==='custom'?['openai','anthropic','deepseek','qwen','zhipu','kimi','minimax','openrouter','ollama'].includes(input.serviceKey):input.serviceKey!==selection.presetId))return validation();
  const entry=snapshot.services.find(entry=>entry.serviceKey===input.serviceKey);
  if(entry&&entry.presetId!==selection.presetId)return validation();
  const descriptor=resolveAgentModelListDescriptor(selection,options);
  let identity:AgentModelListCacheIdentity|null=null;
  if(entry&&descriptor&&snapshot.notices.length===0){
   const {model:_model,...saved}=connectionFor(entry,'connection-validation',options);
   if(equal(saved,selection))identity={serviceKey:entry.serviceKey,binding:serviceBinding(entry),descriptor:descriptor.id};
  }
  return {snapshot,entry,selection,identity};
 }
 function invalidate(serviceKey:string):void{epochs.set(serviceKey,(epochs.get(serviceKey)??0)+1);pending.get(serviceKey)?.abort();pending.delete(serviceKey);}
 const wrapped:AgentModelListSettingsPort={
  get(options={}){const opts=context(options);return schedule(()=>read(opts));},
  put(input,options={}){
   const opts=context(options);
   return schedule(async()=>{
    checkpoint(opts);
    // The pre-read is a cache cleanup hint, not a new prerequisite for the
    // owner's put. Preserve its established validation and error semantics.
    const prior=agentSettingsSnapshotSchema.safeParse(await owner.get(opts));checkpoint(opts);
    const before=prior.success?prior.data:null,result=sanitizeAgentSettingsResult(await owner.put(input,opts));
    // An acknowledged owner commit remains committed even if cancellation
    // arrives now. Invalidate observations; never roll back settings or keys.
    for(const prior of before?.services??result.services){
     const next=result.services.find(entry=>entry.serviceKey===prior.serviceKey);
     if(!before||!next||next.revision!==prior.revision)invalidate(prior.serviceKey);
     if(!before||!next||serviceBinding(next)!==serviceBinding(prior))try{await store?.remove(prior.serviceKey);}catch{}
    }
    return result;
   });
  },
  ...(owner[AGENT_CREDENTIAL_ACQUIRE]?{[AGENT_CREDENTIAL_ACQUIRE](input:unknown,options:SettingsContextOptions={}){const opts=context(options);return schedule(()=>{checkpoint(opts);return owner[AGENT_CREDENTIAL_ACQUIRE]!(input,opts);});}}:{}),
  close(){return owner.close();},
 };
 return {
  settings:wrapped,
  async cache(raw:unknown,options:SettingsContextOptions={}):Promise<AgentModelListCacheResult>{
   const parsed=agentModelListCacheRequestSchema.safeParse(raw);if(!parsed.success)return validation();const opts=context(options);
   return wait(schedule(async()=>{
    const frozen=freeze(await read(opts),parsed.data,opts);if(!frozen.identity||!store)return {status:'miss'};
    let result;try{result=await store.read(frozen.identity);}catch{return {status:'miss'};}
    checkpoint(opts);if(!result)return {status:'miss'};
    return {status:'hit',result:{...result,models:adaptAgentModelListModels(frozen.selection,result.models)}};
   }),opts);
  },
  async list(raw:unknown,options:SettingsContextOptions={}):Promise<AgentModelListResult>{
   const started=Date.now(),parsed=agentModelListRequestSchema.safeParse(raw);if(!parsed.success)return validation();
   const input:AgentModelListRequest=parsed.data,controller=new AbortController(),timeout=new AbortController();
   const timer=setTimeout(()=>timeout.abort(),Math.max(0,AGENT_MODEL_LIST_LIMITS.totalTimeoutMs-(Date.now()-started)));
   const opts=context({...options,signal:AbortSignal.any([controller.signal,timeout.signal,...(options.signal?[options.signal]:[])])});
   let epoch=0;
   try{
    const frozen=await wait(schedule(async()=>{
     const frozen=freeze(await read(opts),input,opts);invalidate(input.serviceKey);epoch=epochs.get(input.serviceKey)!;pending.set(input.serviceKey,controller);return frozen;
    }),opts);
    const current=()=>{checkpoint(opts);if(epochs.get(input.serviceKey)!==epoch)conflict();};
    const descriptor=resolveAgentModelListDescriptor(frozen.selection,opts);
    if(!descriptor)return {outcome:'unavailable',reason:'not_provided'};
    let apiKey:string|null=null;
    if(input.credential.source==='input')apiKey=input.credential.value;
    else if(input.credential.source==='saved'){
     const entry=frozen.entry;if(!entry||!owner[AGENT_CREDENTIAL_ACQUIRE])throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
     const saved=connectionFor(entry,frozen.snapshot.mioSelection?.serviceKey===entry.serviceKey?frozen.snapshot.mioSelection.modelId:'connection-validation',opts);
     // Protocol may be a same-recipient draft, but acquisition is made against
     // the saved complete configuration, never that draft or a guessed model.
     if(agentCredentialBinding(saved)!==agentCredentialBinding({...frozen.selection,model:'connection-validation'}))conflict();
     const expected:AgentCredentialRequest={purpose:'model_list',expectedRevision:frozen.snapshot.revision,configuration:saved,binding:{serviceKey:entry.serviceKey,entryRevision:entry.revision,selectionRevision:frozen.snapshot.mioSelectionRevision}};
     const acquired=await wait(schedule(async()=>{current();const latest=freeze(await read(opts),input,opts);if(!latest.entry||latest.entry.revision!==entry.revision)conflict();return sanitizeAgentCredentialResult(await owner[AGENT_CREDENTIAL_ACQUIRE]!(expected,opts),expected);}),opts);
     current();apiKey=acquired.apiKey;
    }else{
     if(!descriptor.allowNone)return {outcome:'invalid_key',reason:'required'};
     if(descriptor.local&&frozen.entry?.secret.configured){
      const saved=connectionFor(frozen.entry);
      if(agentCredentialBinding(saved)===agentCredentialBinding({...frozen.selection,model:'connection-validation'}))return validation();
     }
    }
    if(!apiKey&&!descriptor.allowNone)return {outcome:'invalid_key',reason:'required'};
    current();
    // Input credentials and acquired plaintext remain scoped to this one call.
    const result=agentModelListResultSchema.parse(await wait(fetchList({selection:frozen.selection,apiKey,signal:opts.signal,selfPort:opts.selfPort}),opts));
    apiKey=null;
    return await wait(schedule(async()=>{
     current();const latest=freeze(await read(opts),input,opts);current();
     if(result.outcome==='success'&&frozen.identity&&latest.identity&&equal(frozen.identity,latest.identity)){
      // Keep admission until atomic publication is done. A queued save/delete
      // cannot enter between the final witness check and this write.
      try{await store?.write(frozen.identity,result);}catch{}
      current();
     }
     return result;
    }),opts);
   }catch(error){
    if(timeout.signal.aborted&&!lifetime.signal.aborted&&!options.signal?.aborted)return {outcome:'unreachable',reason:'timeout'};
    throw error;
   }finally{clearTimeout(timer);if(pending.get(input.serviceKey)===controller)pending.delete(input.serviceKey);}
  },
  async close(){closed=true;lifetime.abort();signal?.removeEventListener('abort',closeSignal);for(const controller of pending.values())controller.abort();pending.clear();await tail;},
 };
}

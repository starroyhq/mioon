import {AGENT_MODEL_LIST_LIMITS,agentModelListRequestSchema,agentModelListCacheRequestSchema,agentModelListResultSchema,agentDraftConnectionTestRequestSchema} from '../../../contracts/src/agent-model-list.ts';
import type {AgentModelListRequest,AgentModelListCacheRequest,AgentModelListResult,AgentModelListCacheResult,AgentModelListSelection,AgentDraftConnectionTestResult} from '../../../contracts/src/agent-model-list.ts';
import type {AgentServiceSnapshot,AgentSettingsSnapshot} from '../../../contracts/src/agent-connection-settings.ts';
import {agentSettingsSnapshotSchema} from '../../../contracts/src/agent-connection-settings.ts';
import {AGENT_CREDENTIAL_ACQUIRE,sanitizeAgentSettingsResult,sanitizeAgentCredentialResult} from './settings.ts';
import type {AgentCredentialRequest,SettingsContextOptions} from './settings.ts';
import {agentSettingsError,agentCredentialBinding} from './config.ts';
import {connectionFor,serviceBinding} from './settings-envelope.ts';
import {parseAgentModelListSelection,resolveAgentModelListDescriptor,adaptAgentModelListModels} from './model-list-descriptors.ts';
import {fetchAgentModelList} from './model-list.ts';
import {buildTaskModelRequest,createTaskGateway} from './task-gateway-v2.ts';
import type {TaskGateway} from './task-gateway-v2.ts';
import {agentChatHttpStatus,errorCode} from './chat-errors.ts';
import {agentChatProfile,agentModelThinkingTier,agentModelTokenLimits} from './model-profiles.ts';
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

const draftTestText='Mioon connection test. Reply with the single word OK.';
function draftTestBody(configuration: Parameters<typeof buildTaskModelRequest>[0],selfPort?:number):string{
 const body=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:draftTestText}],[],selfPort)) as Record<string,unknown>;
 const protocol=configuration.protocol;
 const tokenField=protocol==='chat_completions'?agentChatProfile(configuration).tokenField:protocol==='responses'?'max_output_tokens':'max_tokens';
 // Allow a small reply plus a reasoning reserve for models that cannot turn it off.
 const replyTokens=128,reasoningReserve=1024;
 const cap=replyTokens+(agentModelThinkingTier(configuration)==='required'?reasoningReserve:0);
 body[tokenField]=Math.min(cap,agentModelTokenLimits(configuration).outputTokens);
 // This isolated prompt has no project prefix worth caching.
 delete body.system;
 if(protocol==='responses')delete body.instructions;
 if(protocol!=='responses')body.messages=[{role:'user',content:draftTestText}];
 return JSON.stringify(body);
}

function testFailure(error:unknown):AgentDraftConnectionTestResult{
 const status=agentChatHttpStatus(error);
 if(status===401)return {outcome:'failed',reason:'rejected'};
 if(status===403)return {outcome:'failed',reason:'permission_denied'};
 if(status===404)return {outcome:'failed',reason:'not_found'};
 if(status===429)return {outcome:'failed',reason:'rate_limited'};
 if(status!==undefined&&status>=500&&status<=599)return {outcome:'failed',reason:'server_error'};
 switch(errorCode(error)){
  case 'AGENT_CHAT_NETWORK_DENIED':return {outcome:'failed',reason:'policy'};
  case 'AGENT_CHAT_CONNECT_FAILED':return {outcome:'failed',reason:'connection_failed'};
  case 'AGENT_CHAT_TIMEOUT':return {outcome:'failed',reason:'timeout'};
  case 'AGENT_CHAT_KEY_REQUIRED':return {outcome:'failed',reason:'required'};
  default:return {outcome:'failed',reason:'test_failed'};
 }
}


/** The application's single settings-write admission is also the cache commit
 * admission. Desktop main still owns encryption; no list payload crosses its
 * credential broker. Network work never holds this queue. */
export function createAgentModelListService({settings:owner,cache:store,fetch:fetchList=fetchAgentModelList,gateway=createTaskGateway(),selfPort=()=>undefined,signal}:{settings:AgentModelListSettingsPort;cache?:AgentModelListCacheStore;fetch?:typeof fetchAgentModelList;gateway?:TaskGateway;selfPort?:()=>number|undefined;signal?:AbortSignal}){
 const lifetime=new AbortController(),epochs=new Map<string,number>(),pending=new Map<string,AbortController>();
 let tail:Promise<unknown>=Promise.resolve(),closed=false;
 const closeSignal=()=>lifetime.abort();signal?.addEventListener('abort',closeSignal,{once:true});if(signal?.aborted)closeSignal();
 function context(options:SettingsContextOptions={}):SettingsContextOptions{
  return {...options,selfPort:options.selfPort??selfPort(),signal:options.signal?AbortSignal.any([lifetime.signal,options.signal]):lifetime.signal};
 }
 function ownerContext(options:SettingsContextOptions):Pick<SettingsContextOptions,'selfPort'|'signal'>{
  // Activity belongs to this service's admission checkpoints, not the desktop
  // settings transport, whose option whitelist deliberately rejects callbacks.
  return {selfPort:options.selfPort,signal:options.signal};
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
 async function read(options:SettingsContextOptions):Promise<AgentSettingsSnapshot>{checkpoint(options);const value=sanitizeAgentSettingsResult(await owner.get(ownerContext(options)));checkpoint(options);return value;}
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
 function ensureSavedRecipient(frozen:FrozenList,options:SettingsContextOptions):void{
  const entry=frozen.entry;
  if(!entry)return conflict();
  const saved=connectionFor(entry,'connection-validation',options);
  if(saved.baseUrl!==frozen.selection.baseUrl||saved.protocol!==frozen.selection.protocol||agentCredentialBinding(saved)!==agentCredentialBinding({...frozen.selection,model:'connection-validation'}))conflict();
 }
 async function credential(input:AgentModelListRequest,frozen:FrozenList,opts:SettingsContextOptions,current:()=>void):Promise<string|null>{
  if(input.credential.source==='input')return input.credential.value;
  if(input.credential.source==='none')return null;
  const entry=frozen.entry,acquire=owner[AGENT_CREDENTIAL_ACQUIRE];
  if(!entry||!acquire)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
  ensureSavedRecipient(frozen,opts);
  // Acquire only the complete saved service via the existing trusted broker.
  const saved=connectionFor(entry,frozen.snapshot.mioSelection?.serviceKey===entry.serviceKey?frozen.snapshot.mioSelection.modelId:'connection-validation',opts);
  const expected:AgentCredentialRequest={purpose:'model_list',expectedRevision:frozen.snapshot.revision,configuration:saved,binding:{serviceKey:entry.serviceKey,entryRevision:entry.revision,selectionRevision:frozen.snapshot.mioSelectionRevision}};
  const acquired=await wait(schedule(async()=>{
   current();
   const latest=freeze(await read(opts),input,opts);
   if(!latest.entry||latest.entry.revision!==entry.revision)conflict();
   return sanitizeAgentCredentialResult(await acquire.call(owner,expected,ownerContext(opts)),expected);
  }),opts);
  current();
  return acquired.apiKey;
 }
 async function run<T>(input:AgentModelListRequest,options:SettingsContextOptions,onTimeout:T,operation:(frozen:FrozenList,opts:SettingsContextOptions,current:()=>void)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),timeout=new AbortController();
  const timer=setTimeout(()=>timeout.abort(),AGENT_MODEL_LIST_LIMITS.totalTimeoutMs);
  const opts=context({...options,signal:AbortSignal.any([controller.signal,timeout.signal,...(options.signal?[options.signal]:[])])});
  let epoch=0;
  const current=()=>{checkpoint(opts);if(epochs.get(input.serviceKey)!==epoch)conflict();};
  try{
   const frozen=await wait(schedule(async()=>{
    const frozen=freeze(await read(opts),input,opts);
    invalidate(input.serviceKey);
    epoch=epochs.get(input.serviceKey)!;
    pending.set(input.serviceKey,controller);
    return frozen;
   }),opts);
   return await operation(frozen,opts,current);
  }catch(error){
   if(timeout.signal.aborted&&!lifetime.signal.aborted&&!options.signal?.aborted)return onTimeout;
   throw error;
  }finally{
   clearTimeout(timer);
   if(pending.get(input.serviceKey)===controller)pending.delete(input.serviceKey);
  }
 }

 const wrapped:AgentModelListSettingsPort={
  get(options={}){const opts=context(options);return schedule(()=>read(opts));},
  put(input,options={}){
   const opts=context(options);
   return schedule(async()=>{
    checkpoint(opts);
    // The pre-read is a cache cleanup hint, not a new prerequisite for the
    // owner's put. Preserve its established validation and error semantics.
    const prior=agentSettingsSnapshotSchema.safeParse(await owner.get(ownerContext(opts)));checkpoint(opts);
    const before=prior.success?prior.data:null,result=sanitizeAgentSettingsResult(await owner.put(input,ownerContext(opts)));
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
  ...(owner[AGENT_CREDENTIAL_ACQUIRE]?{[AGENT_CREDENTIAL_ACQUIRE](input:unknown,options:SettingsContextOptions={}){const opts=context(options);return schedule(()=>{checkpoint(opts);return owner[AGENT_CREDENTIAL_ACQUIRE]!(input,ownerContext(opts));});}}:{}),
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
   const parsed=agentModelListRequestSchema.safeParse(raw);
   if(!parsed.success)return validation();
   const input=parsed.data;
   return run<AgentModelListResult>(input,options,{outcome:'unreachable',reason:'timeout'},async(frozen,opts,current)=>{
    const descriptor=resolveAgentModelListDescriptor(frozen.selection,opts);
    if(!descriptor)return {outcome:'unavailable',reason:'not_provided'};
    // An input key belongs to the endpoint chosen in this draft, never a
    // different protocol's fallback. The pinned Ollama list stays local.
    if(input.credential.source==='input'&&descriptor.source==='same_platform_compatible')return {outcome:'unavailable',reason:'not_provided'};
    if(input.credential.source==='none'){
     if(!descriptor.allowNone)return {outcome:'invalid_key',reason:'required'};
     if(descriptor.local&&frozen.entry?.secret.configured){
      const saved=connectionFor(frozen.entry);
      if(agentCredentialBinding(saved)===agentCredentialBinding({...frozen.selection,model:'connection-validation'}))return validation();
     }
    }
    const apiKey=await credential(input,frozen,opts,current);
    if(!apiKey&&!descriptor.allowNone)return {outcome:'invalid_key',reason:'required'};
    current();
    const result=agentModelListResultSchema.parse(await wait(fetchList({selection:frozen.selection,apiKey,signal:opts.signal,selfPort:opts.selfPort}),opts));
    if(apiKey&&result.outcome==='success'&&result.models.some(model=>model.id.includes(apiKey)||model.displayName?.includes(apiKey)))return {outcome:'unreachable',reason:'invalid_response'};
    return wait(schedule(async()=>{
     current();
     const latest=freeze(await read(opts),input,opts);
     current();
     if(input.credential.source!=='input'&&result.outcome==='success'&&frozen.identity&&latest.identity&&equal(frozen.identity,latest.identity)){
      // Cache publication shares settings-write admission. Input results belong
      // only to their request even when the recipient is already saved.
      try{await store?.write(frozen.identity,result);}catch{}
      current();
     }
     return result;
    }),opts);
   });
  },
  async test(raw:unknown,options:SettingsContextOptions={}):Promise<AgentDraftConnectionTestResult>{
   const parsed=agentDraftConnectionTestRequestSchema.safeParse(raw);
   if(!parsed.success)return validation();
   const {model,...input}=parsed.data;
   return run<AgentDraftConnectionTestResult>(input,options,{outcome:'failed',reason:'timeout'},async(frozen,opts,current)=>{
    const configuration={...frozen.selection,model};
    const apiKey=await credential(input,frozen,opts,current);
    if(!apiKey&&configuration.presetId!=='ollama')return {outcome:'failed',reason:'required'};
    let result:AgentDraftConnectionTestResult={outcome:'failed',reason:'test_failed'};
    try{
     const body=draftTestBody(configuration,opts.selfPort);
     current();
     const observe=async()=>{
      for await(const item of gateway({configuration,body,apiKey,signal:opts.signal,selfPort:opts.selfPort,beforeSubmit:current})){
       current();
       if(item.type==='done'&&item.output.text.trim()&&!item.output.toolCalls.length)return {outcome:'success'} as const;
      }
      return {outcome:'failed',reason:'test_failed'} as const;
     };
     result=await wait(observe(),opts);
    }catch(error){
     current();
     result=testFailure(error);
    }
    return wait(schedule(async()=>{
     current();
     freeze(await read(opts),input,opts);
     current();
     return result;
    }),opts);
   });
  },
  async close(){closed=true;lifetime.abort();signal?.removeEventListener('abort',closeSignal);for(const controller of pending.values())controller.abort();pending.clear();await tail;},
 };
}

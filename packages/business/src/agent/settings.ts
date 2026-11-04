import {AGENT_PRESETS} from './presets.ts';
import {agentAdaptedModelHints} from './model-profiles.ts';
import {agentSettingsError,safeAgentSettingsError,exactObject,parseAgentConfiguration,parseAgentSettingsUpdate} from './config.ts';
import type {AgentConfiguration} from './config.ts';
import type {AgentSettingsFile} from './settings-file.ts';
import {loadSettingsEnvelope,emptyEnvelope,parseCurrentEnvelope,connectionFor,serviceBinding} from './settings-envelope.ts';
import type {SettingsEnvelope,ServiceState,LoadedSecret,SettingsNotice} from './settings-envelope.ts';
import {agentSettingsSnapshotSchema,agentSettingsBindingSchema,agentSettingsStorageSchema,agentServiceInput,agentSecretActionSchema} from '../../../contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot,AgentExecutionSettings,AgentSettingsBinding,AgentSettingsUpdate} from '../../../contracts/src/agent-connection-settings.ts';
export type {AgentSettingsSnapshot} from '../../../contracts/src/agent-connection-settings.ts';

export const sanitizeAgentSettingsError=safeAgentSettingsError;
// Trusted only: never exposed as a string HTTP/RPC/renderer operation.
export const AGENT_CREDENTIAL_ACQUIRE=Symbol('trusted Agent inference credential');
export interface AgentCredentialRequest{expectedRevision:number;configuration:AgentConfiguration;binding:AgentSettingsBinding;purpose?:'model_list'}
export interface AgentCredentialResult{revision:number;configuration:AgentConfiguration;binding:AgentSettingsBinding;apiKey:string|null}
export type PublicStorage=AgentSettingsSnapshot['storage'];
export function parseAgentCredentialRequest(value:unknown,options:{selfPort?:number}={}):AgentCredentialRequest{
 const listing=Boolean(value&&typeof value==='object'&&'purpose'in value&&value.purpose==='model_list');
 if(!exactObject(value,listing?['expectedRevision','configuration','binding','purpose']:['expectedRevision','configuration','binding'])||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<0)throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
 const configuration=parseAgentConfiguration(value.configuration,options),binding=agentSettingsBindingSchema.safeParse(value.binding);
 if(!binding.success||JSON.stringify(configuration)!==JSON.stringify(value.configuration))throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
 return {expectedRevision:Number(value.expectedRevision),configuration,binding:binding.data,...(listing?{purpose:'model_list' as const}:{})};
}
export function sanitizeAgentCredentialResult(value:unknown,expected:AgentCredentialRequest):AgentCredentialResult{
 if(!exactObject(value,['revision','configuration','binding','apiKey'])||value.revision!==expected.expectedRevision||JSON.stringify(value.configuration)!==JSON.stringify(expected.configuration)||JSON.stringify(value.binding)!==JSON.stringify(expected.binding))throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
 if(value.apiKey!==null){const parsed=agentSecretActionSchema.safeParse({serviceKey:expected.binding.serviceKey,action:'replace',storage:'session',value:value.apiKey});if(!parsed.success)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');}
 return {revision:expected.expectedRevision,configuration:{...expected.configuration},binding:{...expected.binding},apiKey:value.apiKey as string|null};
}
export function sanitizeAgentSettingsResult(value:unknown):AgentSettingsSnapshot{
 const result=agentSettingsSnapshotSchema.safeParse(value);if(!result.success)throw agentSettingsError('AGENT_SETTINGS_CORRUPT');return result.data;
}
function publicStorage(value:unknown):PublicStorage{
 const parsed=agentSettingsStorageSchema.safeParse(value);if(!parsed.success)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');return parsed.data;
}
function boundedCredentialRead<T>(operation:()=>T|Promise<T>,signal?:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  let settled=false;
  const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);if(error)reject(agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));else resolve(value as T);};
  const aborted=()=>finish(true),timer=setTimeout(aborted,5000);
  if(signal?.aborted)return aborted();signal?.addEventListener('abort',aborted,{once:true});
  Promise.resolve().then(()=>{if(signal?.aborted)throw agentSettingsError('AGENT_SETTINGS_CLOSED');return operation();}).then(value=>finish(null,value),()=>finish(true));
 });
}
export interface SettingsContextOptions{selfPort?:number;signal?:AbortSignal;isActive?:()=>boolean}
export interface SecretCodec{
 refreshStorage?(options?:SettingsContextOptions):Promise<unknown>|unknown;
 decrypt?(encrypted:string,options?:SettingsContextOptions):Promise<unknown>|unknown;
 encrypt?(value:string,options?:SettingsContextOptions):Promise<unknown>|unknown;
 close?():void;
}
export interface AgentSettingsDependencies{persistence:AgentSettingsFile;secretCodec?:SecretCodec;storage?:PublicStorage|(()=>PublicStorage);signal?:AbortSignal}
export interface AgentSettingsService{
 get(options?:SettingsContextOptions):Promise<AgentSettingsSnapshot>;
 [AGENT_CREDENTIAL_ACQUIRE](input:unknown,options?:SettingsContextOptions):Promise<AgentCredentialResult>;
 put(input:unknown,options?:SettingsContextOptions):Promise<AgentSettingsSnapshot>;
 close():Promise<void>;
}
interface SessionSecret{binding:string;value:string}
function nextRevision(value:number):number{if(value===Number.MAX_SAFE_INTEGER)throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');return value+1;}
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
function credentialState(entry:ServiceState,session:ReadonlyMap<string,SessionSecret>){return {configured:Boolean(entry.secret||session.has(entry.serviceKey)),storage:entry.secret?'persistent' as const:session.has(entry.serviceKey)?'session' as const:'none' as const};}
function execution(state:SettingsEnvelope,session:ReadonlyMap<string,SessionSecret>):AgentExecutionSettings|null{
 const choice=state.mioSelection;if(!choice)return null;
 const entry=state.services.find(s=>s.serviceKey===choice.serviceKey);if(!entry)throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
 return {revision:state.mioRevision,binding:{serviceKey:entry.serviceKey,entryRevision:entry.revision,selectionRevision:state.mioSelectionRevision},configuration:connectionFor(entry,choice.modelId),secret:credentialState(entry,session)};
}
/** Independent credential owners; collection revision is only the save CAS.
 * A selected-entry/selection witness is frozen by each run, never re-signed. */
export async function createAgentSettings({persistence,secretCodec,storage={persistentAvailable:false,sessionScope:'server',reasonCode:'WEB_SESSION_ONLY'},signal}:AgentSettingsDependencies):Promise<AgentSettingsService>{
 let state=emptyEnvelope(),session=new Map<string,SessionSecret>(),notices:SettingsNotice[]=[],fault:Error|null=null,tail:Promise<unknown>=Promise.resolve(),closing=false,refreshBlocked=false;
 const lifetime=new AbortController();
 const controls=(options:SettingsContextOptions={}):SettingsContextOptions&{signal:AbortSignal}=>({...options,signal:options.signal?AbortSignal.any([lifetime.signal,options.signal]):lifetime.signal});
 const checkpoint=(options?:SettingsContextOptions):void=>{if(closing||options?.signal?.aborted||options?.isActive?.()===false)throw agentSettingsError('AGENT_SETTINGS_CLOSED');};
 const refreshCapabilities=async(options:SettingsContextOptions):Promise<void>=>{
  if(typeof secretCodec?.refreshStorage!=='function')return;
  try{const refreshed=await boundedCredentialRead(()=>secretCodec.refreshStorage!(options),options.signal);refreshBlocked=!publicStorage(refreshed).persistentAvailable;}catch{refreshBlocked=true;}
 };
 const capabilities=():PublicStorage=>{const value=publicStorage(typeof storage==='function'?storage():storage);return refreshBlocked?{...value,persistentAvailable:false,reasonCode:value.reasonCode||'OS_SECRET_STORE_UNAVAILABLE'}:value;};
 function snapshot(candidate=state,keys:ReadonlyMap<string,SessionSecret>=session,messages:SettingsNotice[]=notices):AgentSettingsSnapshot{
  const presets=AGENT_PRESETS.map(p=>({...p,supportedModelHints:agentAdaptedModelHints(p.id),platforms:p.platforms.map(platform=>({...platform,supportedModelHints:agentAdaptedModelHints(p.id)}))}));
  return sanitizeAgentSettingsResult({revision:candidate.revision,services:candidate.services.map(entry=>({...agentServiceInput(entry),revision:entry.revision,secret:credentialState(entry,keys)})),mioSelection:candidate.mioSelection,mioSelectionRevision:candidate.mioSelectionRevision,execution:execution(candidate,keys),storage:capabilities(),presets,scope:'settings_only',verification:'not_tested',notices:messages});
 }
 const initialization=controls({signal});await refreshCapabilities(initialization);
 try{const loaded=loadSettingsEnvelope(await persistence.load());state=loaded.state;notices=loaded.notices;snapshot();}catch{fault=agentSettingsError('AGENT_SETTINGS_CORRUPT');}
 function schedule<T>(operation:()=>T|Promise<T>):Promise<T>{
  if(closing)return Promise.reject(agentSettingsError('AGENT_SETTINGS_CLOSED'));
  const result=tail.then(()=>{checkpoint();if(fault)throw fault;return operation();});tail=result.catch(()=>{});return result;
 }
 function match(expected:AgentCredentialRequest):{entry:ServiceState;binding:string}{
  if(expected.purpose==='model_list'){
   const entry=state.services.find(s=>s.serviceKey===expected.binding.serviceKey);
   // Discovery is not inference: it may read any one saved service, but may
   // never substitute the draft receiver or manufacture an execution witness.
   const selection=state.mioSelection;
   const model=selection&&selection.serviceKey===entry?.serviceKey?selection.modelId:'connection-validation';
   if(!entry||state.revision!==expected.expectedRevision||entry.revision!==expected.binding.entryRevision||state.mioSelectionRevision!==expected.binding.selectionRevision||!equal(connectionFor(entry,model),expected.configuration))throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
   return {entry,binding:serviceBinding(entry)};
  }
  const active=execution(state,session);
  if(!active||active.revision!==expected.expectedRevision||!equal(active.binding,expected.binding)||!equal(active.configuration,expected.configuration))throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
  const entry=state.services.find(s=>s.serviceKey===expected.binding.serviceKey);if(!entry)throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
  return {entry,binding:serviceBinding(entry)};
 }
 return {
  get(options={}){const context=controls(options);return schedule(async()=>{checkpoint(context);await refreshCapabilities(context);checkpoint(context);return snapshot();});},
  [AGENT_CREDENTIAL_ACQUIRE](input,options={}){
   let expected:AgentCredentialRequest;try{expected=parseAgentCredentialRequest(input,options);}catch(error){return Promise.reject(error);}const context=controls(options);
   const credentialCheckpoint=()=>{if(closing)throw agentSettingsError('AGENT_SETTINGS_CLOSED');if(context.signal.aborted||context.isActive?.()===false)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');};
   return schedule(async()=>{
    credentialCheckpoint();const {entry,binding}=match(expected);let apiKey:string|null=null;
    if(entry.secret){
     await refreshCapabilities(context);credentialCheckpoint();match(expected);
     if(!secretCodec?.decrypt||!capabilities().persistentAvailable||entry.secret.binding!==binding)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
     try{
      const raw=await boundedCredentialRead(()=>secretCodec.decrypt!(entry.secret!.encrypted,context),context.signal);credentialCheckpoint();match(expected);
      if(typeof raw!=='string')throw Error();const decoded:unknown=JSON.parse(raw);
      if(!exactObject(decoded,['version','serviceKey','binding','value'])||decoded.version!==2||decoded.serviceKey!==entry.serviceKey||decoded.binding!==binding)throw Error();
      const value=agentSecretActionSchema.parse({serviceKey:entry.serviceKey,action:'replace',storage:'persistent',value:decoded.value});if(value.action!=='replace')throw Error();apiKey=value.value;
     }catch{credentialCheckpoint();throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');}
    }else{
     const held=session.get(entry.serviceKey);if(held){if(held.binding!==binding)throw agentSettingsError('AGENT_SETTINGS_CONFLICT');apiKey=held.value;}
    }
    credentialCheckpoint();match(expected);
    return sanitizeAgentCredentialResult({revision:expected.purpose==='model_list'?state.revision:state.mioRevision,configuration:expected.configuration,binding:expected.binding,apiKey},expected);
   });
  },
  put(input,options={}){
   let update:AgentSettingsUpdate;try{update=parseAgentSettingsUpdate(input,options);}catch(error){return Promise.reject(error);}const context=controls(options);
   return schedule(async()=>{
    checkpoint(context);if(update.expectedRevision!==state.revision)throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
    const globalRevision=nextRevision(state.revision),ids=new Set(update.services.map(s=>s.serviceKey));
    if(state.mioSelection&&!ids.has(state.mioSelection.serviceKey))throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
    const actions=new Map(update.secretActions.map(action=>[action.serviceKey,action])),nextSession=new Map([...session].filter(([id])=>ids.has(id)));
    const services:ServiceState[]=[];
    for(const inputEntry of update.services){
     const prior=state.services.find(s=>s.serviceKey===inputEntry.serviceKey),binding=serviceBinding(inputEntry),same=Boolean(prior&&serviceBinding(prior)===binding),action=actions.get(inputEntry.serviceKey);
     let secret:LoadedSecret|null=same&&prior?prior.secret:null;
     if(!same)nextSession.delete(inputEntry.serviceKey);
     let keyChanged=Boolean(prior&&!same&&(prior.secret||session.has(prior.serviceKey)));
     if(action?.action==='remove'){keyChanged=keyChanged||Boolean(secret||nextSession.has(inputEntry.serviceKey));secret=null;nextSession.delete(inputEntry.serviceKey);}
     if(action?.action==='replace'){
      keyChanged=true;secret=null;nextSession.delete(inputEntry.serviceKey);
      if(action.storage==='persistent'){
       await refreshCapabilities(context);checkpoint(context);
       if(!secretCodec?.encrypt||!capabilities().persistentAvailable)throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
       let encrypted:unknown;
       try{encrypted=await boundedCredentialRead(()=>secretCodec.encrypt!(JSON.stringify({version:2,serviceKey:inputEntry.serviceKey,binding,value:action.value}),context),context.signal);}catch{checkpoint(context);throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');}
       checkpoint(context);if(typeof encrypted!=='string')throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');secret={binding,encrypted};
      }else nextSession.set(inputEntry.serviceKey,{binding,value:action.value});
     }
     const changed=!prior||!equal(agentServiceInput(prior),inputEntry)||keyChanged;
     services.push({...inputEntry,revision:prior?(changed?nextRevision(prior.revision):prior.revision):1,secret});
    }
    const selectionChanged=!equal(state.mioSelection,update.mioSelection),selected=update.mioSelection?services.find(s=>s.serviceKey===update.mioSelection!.serviceKey):undefined;
    const priorSelected=state.mioSelection?state.services.find(s=>s.serviceKey===state.mioSelection!.serviceKey):undefined;
    const activeChanged=selectionChanged||Boolean(selected&&priorSelected&&selected.revision!==priorSelected.revision);
    const candidate:SettingsEnvelope={version:3,revision:globalRevision,services,mioSelection:update.mioSelection,mioSelectionRevision:selectionChanged?nextRevision(state.mioSelectionRevision):state.mioSelectionRevision,mioRevision:activeChanged?nextRevision(state.mioRevision):state.mioRevision};
    let committed:SettingsEnvelope;try{committed=parseCurrentEnvelope(candidate);snapshot(committed,nextSession,[]);}catch{throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');}
    checkpoint(context);
    try{await persistence.save(committed);}catch{throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');}
    // Once the atomic file save starts, always pair its durable commit with RAM.
    state=committed;session=nextSession;notices=[];return snapshot();
   });
  },
  async close(){closing=true;lifetime.abort();secretCodec?.close?.();await tail;session.clear();},
 };
}

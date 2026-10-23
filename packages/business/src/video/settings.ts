import {randomUUID} from 'node:crypto';
import {VIDEO_PROVIDER_IDS,VIDEO_SECRET_NAMESPACE,VIDEO_SETTINGS_LIMITS,videoConnectionConfigurationSchema,videoSettingsUpdateSchema,videoSecretUpdateSchema,
  parseVideoBinding,videoConnectionEndpoint,videoOutputHosts} from '../../../contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoConnectionView,VideoSettingsSnapshot,VideoSettingsUpdate,VideoStorage,VideoExecutionBinding,VideoSecretUpdate,VideoProviderId} from '../../../contracts/src/video-providers.ts';
import {createVideoSettingsFile} from './settings-file.ts';

export const VIDEO_SECRET_LIMITS=Object.freeze({ciphertextCharacters:48*1024,plaintextBytes:32*1024,envelopeBytes:VIDEO_SETTINGS_LIMITS.fileBytes});
export interface VideoSettingsError extends Error {code:string;status:number}
export interface VideoSecretCodec {refreshStorage?():unknown|Promise<unknown>;encrypt(value:string):unknown|Promise<unknown>;decrypt(value:string):unknown|Promise<unknown>}
interface Revision {configuration:VideoConnectionConfiguration;revision:number;credentialRef:string|null}
interface Credential {ref:string;connectionId:string;providerId:VideoProviderId;region:string;workspaceId:string;endpoint:string;encrypted:string|null}
export interface VideoSettingsEnvelope {version:1;namespace:typeof VIDEO_SECRET_NAMESPACE;revision:number;connections:Revision[];history:Revision[];credentials:Credential[]}
export interface VideoSettingsOptions {directory:string;privateRoot?:string;secretCodec?:VideoSecretCodec;storage?:VideoStorage|(()=>VideoStorage);signal?:AbortSignal}
export interface VideoSettingsService {
 get():Promise<VideoSettingsSnapshot>;put(input:unknown):Promise<VideoSettingsSnapshot>;list():VideoConnectionView[];
 select(connectionId:string,configurationRevision:number,modelEntryId:string):VideoExecutionBinding;
 assertBinding(binding:unknown):void;acquire(binding:unknown,signal?:AbortSignal):Promise<string>;
 /** Saved key of a compatible connection's current revision, with the exact origin it is bound to. */
 acquireCompatible(connectionId:string,configurationRevision:number,signal?:AbortSignal):Promise<{endpoint:string;value:string}>;close():Promise<void>;
}
const messages:Readonly<Record<string,readonly[number,string]>>=Object.freeze({
 VIDEO_SETTINGS_VALIDATION:[400,'视频供应商配置格式无效。'],VIDEO_SETTINGS_CONFLICT:[409,'视频供应商配置已改变，请重新读取后确认。'],
 VIDEO_SETTINGS_DISABLED:[409,'此视频连接或模型未启用。'],VIDEO_SETTINGS_NOT_CONFIGURED:[409,'此视频连接的凭据不可用，请配置或明确恢复对应历史凭据。'],
 VIDEO_SETTINGS_STORAGE_UNAVAILABLE:[409,'系统安全存储不可用，请明确选择仅本次会话保存。'],
 VIDEO_SETTINGS_SAVE_FAILED:[503,'视频供应商配置未能安全保存，请重新读取当前状态。'],VIDEO_SETTINGS_CORRUPT:[503,'视频供应商配置不可读取或不安全，原文件未被覆盖。'],
 VIDEO_SETTINGS_CLOSED:[503,'视频供应商配置服务已关闭。'],VIDEO_BINDING_INVALID:[409,'视频任务连接绑定与保留的历史修订不一致。'],
});
export function videoSettingsError(code='VIDEO_SETTINGS_VALIDATION'):VideoSettingsError {
 const selected=Object.hasOwn(messages,code)?code:'VIDEO_SETTINGS_SAVE_FAILED',entry=messages[selected]!;
 return Object.assign(new Error(entry[1]),{code:selected,status:entry[0]});
}
export function sanitizeVideoSettingsError(value:unknown) {
 let code='VIDEO_SETTINGS_SAVE_FAILED';try{if(value&&typeof value==='object'&&'code'in value&&typeof value.code==='string')code=value.code;}catch{}
 const safe=videoSettingsError(code);return {code:safe.code,message:safe.message,status:safe.status};
}
const fail=(code:string):never=>{throw videoSettingsError(code);};
const copy=<T>(value:T):T=>structuredClone(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>object(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const validCiphertext=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=VIDEO_SECRET_LIMITS.ciphertextCharacters&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)&&Buffer.from(value,'base64').toString('base64')===value;
function parseRevision(value:unknown):Revision {
 if(!exact(value,['configuration','revision','credentialRef'])||!revision(value.revision)||value.revision===0||value.credentialRef!==null&&!uuid(value.credentialRef))return fail('VIDEO_SETTINGS_CORRUPT');
 const configuration=videoConnectionConfigurationSchema.safeParse(value.configuration);if(!configuration.success)return fail('VIDEO_SETTINGS_CORRUPT');
 return {configuration:configuration.data,revision:value.revision,credentialRef:value.credentialRef as string|null};
}
function parseCredential(value:unknown):Credential {
 if(!exact(value,['ref','connectionId','providerId','region','workspaceId','endpoint','encrypted'])||!uuid(value.ref)||!uuid(value.connectionId)||!VIDEO_PROVIDER_IDS.includes(value.providerId as VideoProviderId)||typeof value.region!=='string'||typeof value.workspaceId!=='string'||value.encrypted!==null&&!validCiphertext(value.encrypted))return fail('VIDEO_SETTINGS_CORRUPT');
 // A compatible credential is bound to its exact reviewed base URL; an official one to its fixed endpoint.
 try{if(typeof value.endpoint!=='string'||value.endpoint!==videoConnectionEndpoint({providerId:value.providerId as VideoProviderId,region:value.region,workspaceId:value.workspaceId,...(value.providerId==='compatible'?{baseUrl:value.endpoint}:{})}))throw Error();}catch{return fail('VIDEO_SETTINGS_CORRUPT');}
 return {ref:value.ref,connectionId:value.connectionId,providerId:value.providerId as VideoProviderId,region:value.region,workspaceId:value.workspaceId,endpoint:value.endpoint as string,encrypted:value.encrypted as string|null};
}
const recipient=(value:Pick<VideoConnectionConfiguration,'id'|'providerId'|'region'|'workspaceId'|'baseUrl'>)=>[value.id,value.providerId,value.region,value.workspaceId,videoConnectionEndpoint(value)];
const credentialRecipient=(value:Credential)=>[value.connectionId,value.providerId,value.region,value.workspaceId,value.endpoint];
export function validateVideoSettingsEnvelope(value:unknown):VideoSettingsEnvelope {
 try{
  if(!exact(value,['version','namespace','revision','connections','history','credentials'])||value.version!==1||value.namespace!==VIDEO_SECRET_NAMESPACE||!revision(value.revision)||!Array.isArray(value.connections)||value.connections.length>VIDEO_SETTINGS_LIMITS.connections||!Array.isArray(value.history)||!Array.isArray(value.credentials)||value.credentials.length>VIDEO_SETTINGS_LIMITS.credentials||Buffer.byteLength(JSON.stringify(value))>VIDEO_SETTINGS_LIMITS.fileBytes)throw Error();
  const connections=value.connections.map(parseRevision),history=value.history.map(parseRevision),credentials=value.credentials.map(parseCredential);
  if(new Set(connections.map(item=>item.configuration.id)).size!==connections.length||new Set(history.map(item=>`${item.configuration.id}:${item.revision}`)).size!==history.length||new Set(credentials.map(item=>item.ref)).size!==credentials.length)throw Error();
  for(const current of connections){const versions=history.filter(item=>item.configuration.id===current.configuration.id);if(!versions.length||Math.max(...versions.map(item=>item.revision))!==current.revision||!versions.some(item=>same(item,current)))throw Error();}
  for(const entry of history){if(!connections.some(item=>item.configuration.id===entry.configuration.id)||entry.revision>value.revision)throw Error();if(entry.credentialRef){const credential=credentials.find(item=>item.ref===entry.credentialRef);if(!credential||!same(recipient(entry.configuration),credentialRecipient(credential)))throw Error();}}
  if(credentials.some(credential=>!history.some(entry=>entry.configuration.id===credential.connectionId&&entry.credentialRef===credential.ref)))throw Error();
  return {version:1,namespace:VIDEO_SECRET_NAMESPACE,revision:value.revision,connections,history,credentials};
 }catch{return fail('VIDEO_SETTINGS_CORRUPT');}
}
interface VideoSecretPlaintext {version:1;namespace:typeof VIDEO_SECRET_NAMESPACE;credentialRef:string;connectionId:string;providerId:VideoProviderId;region:string;workspaceId:string;endpoint:string;value:string}
export function validateVideoSecretPlaintext(value:unknown):VideoSecretPlaintext {
 try{
  if(typeof value!=='string'||Buffer.byteLength(value)>VIDEO_SECRET_LIMITS.plaintextBytes)throw Error();
  const parsed:unknown=JSON.parse(value);
  if(!exact(parsed,['version','namespace','credentialRef','connectionId','providerId','region','workspaceId','endpoint','value'])||parsed.version!==1||parsed.namespace!==VIDEO_SECRET_NAMESPACE||!uuid(parsed.credentialRef))throw Error();
  const credential=parseCredential({ref:parsed.credentialRef,connectionId:parsed.connectionId,providerId:parsed.providerId,region:parsed.region,workspaceId:parsed.workspaceId,endpoint:parsed.endpoint,encrypted:null});
  const secret=videoSecretUpdateSchema.parse({action:'replace',storage:'persistent',value:parsed.value});if(secret.action!=='replace')throw Error();
  return {version:1,namespace:VIDEO_SECRET_NAMESPACE,credentialRef:credential.ref,connectionId:credential.connectionId,providerId:credential.providerId,region:credential.region,workspaceId:credential.workspaceId,endpoint:credential.endpoint,value:secret.value};
 }catch{return fail('VIDEO_SETTINGS_CORRUPT');}
}
function validateStorage(value:unknown):VideoStorage {
 if(!exact(value,['persistentAvailable','sessionScope','reasonCode'])||typeof value.persistentAvailable!=='boolean'||!['app','server'].includes(value.sessionScope as string)||![null,'WEB_SESSION_ONLY','OS_SECRET_STORE_UNAVAILABLE','LINUX_BASIC_TEXT'].includes(value.reasonCode as string|null)||value.persistentAvailable!==(value.reasonCode===null))return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
 return {persistentAvailable:value.persistentAvailable,sessionScope:value.sessionScope as VideoStorage['sessionScope'],reasonCode:value.reasonCode as string|null};
}
async function bounded<T>(operation:()=>T|Promise<T>,signal?:AbortSignal):Promise<T> {
 return new Promise<T>((resolve,reject)=>{let done=false;const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(videoSettingsError('VIDEO_SETTINGS_STORAGE_UNAVAILABLE')):resolve(value as T);};const abort=()=>finish(true),timer=setTimeout(abort,5000);if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(done)throw Error();return operation();}).then(value=>finish(null,value),()=>finish(true));});
}
/** Utility/server owns all state; desktop main supplies only a namespace-limited OS codec. */
export async function createVideoSettings({directory,privateRoot=directory,secretCodec,storage={persistentAvailable:false,sessionScope:'server',reasonCode:'WEB_SESSION_ONLY'},signal}:VideoSettingsOptions):Promise<VideoSettingsService> {
 const persistence=createVideoSettingsFile({directory,privateRoot}),lifetime=new AbortController();
 const activeSignal=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
 const operationSignal=(value?:AbortSignal)=>value?AbortSignal.any([activeSignal,value]):activeSignal;
 let state:VideoSettingsEnvelope={version:1,namespace:VIDEO_SECRET_NAMESPACE,revision:0,connections:[],history:[],credentials:[]},sessions=new Map<string,string>(),fault:VideoSettingsError|null=null,closing=false,pendingPuts=0,storageBlocked=false,tail:Promise<unknown>=Promise.resolve();
 try{state=await persistence.load()??state;}catch{fault=videoSettingsError('VIDEO_SETTINGS_CORRUPT');}
 const check=()=>{if(closing||activeSignal.aborted)fail('VIDEO_SETTINGS_CLOSED');if(fault)throw fault;};
 const capabilities=():VideoStorage=>{const value=validateStorage(typeof storage==='function'?storage():storage);return storageBlocked||value.persistentAvailable&&!secretCodec?{...value,persistentAvailable:false,reasonCode:'OS_SECRET_STORE_UNAVAILABLE'}:value;};
 const refresh=async(signal_?:AbortSignal)=>{if(!secretCodec?.refreshStorage)return;try{await bounded(()=>secretCodec.refreshStorage!(),operationSignal(signal_));storageBlocked=false;}catch{storageBlocked=true;}};
 const schedule=<T>(operation:()=>T|Promise<T>):Promise<T>=>{if(closing||activeSignal.aborted)return Promise.reject(videoSettingsError('VIDEO_SETTINGS_CLOSED'));const next=tail.then(()=>{check();return operation();}).catch(error=>{if(activeSignal.aborted)throw videoSettingsError('VIDEO_SETTINGS_CLOSED');throw error;});tail=next.catch(()=>{});return next;};
 const material=(ref:string|null):'none'|'session'|'persistent'=>!ref?'none':state.credentials.find(item=>item.ref===ref)?.encrypted?'persistent':sessions.has(ref)?'session':'none';
 const view=(entry:Revision):VideoConnectionView=>{const selected=material(entry.credentialRef);return {configuration:copy(entry.configuration),revision:entry.revision,credentialRef:entry.credentialRef,secret:{configured:selected!=='none',storage:selected},credentials:state.credentials.filter(item=>item.connectionId===entry.configuration.id).map(item=>{const selected=material(item.ref);return {ref:item.ref,region:item.region,endpoint:item.endpoint,configured:selected!=='none',storage:selected};})};};
 const snapshot=():VideoSettingsSnapshot=>({revision:state.revision,connections:state.connections.map(view),storage:capabilities()});
 const ensureStable=()=>{check();if(pendingPuts)fail('VIDEO_SETTINGS_CONFLICT');};
 const binding=(entry:Revision,modelEntryId:string):VideoExecutionBinding=>{const model=entry.configuration.models.find(item=>item.id===modelEntryId);if(!model||!entry.credentialRef)return fail('VIDEO_SETTINGS_NOT_CONFIGURED');return parseVideoBinding({version:1,connectionId:entry.configuration.id,configurationRevision:entry.revision,providerId:entry.configuration.providerId,region:entry.configuration.region,workspaceId:entry.configuration.workspaceId,endpoint:videoConnectionEndpoint(entry.configuration),credentialRef:entry.credentialRef,model:copy(model),outputHosts:copy(entry.configuration.outputHosts)});};
 const assertBinding=(input:unknown):VideoExecutionBinding=>{ensureStable();let selected:VideoExecutionBinding;try{selected=parseVideoBinding(input);}catch{return fail('VIDEO_BINDING_INVALID');}const historical=state.history.find(item=>item.configuration.id===selected.connectionId&&item.revision===selected.configurationRevision);if(!historical||!same(binding(historical,selected.model.id),selected))return fail('VIDEO_BINDING_INVALID');if(material(selected.credentialRef)==='none')return fail('VIDEO_SETTINGS_NOT_CONFIGURED');return selected;};
 async function secretOf(credential:Credential,requestSignal?:AbortSignal):Promise<string|undefined> {
  if(!credential.encrypted)return sessions.get(credential.ref);
  await refresh(requestSignal);check();if(!capabilities().persistentAvailable||!secretCodec)return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
  const plaintext=validateVideoSecretPlaintext(await bounded(()=>secretCodec.decrypt(credential.encrypted!),operationSignal(requestSignal)));
  if(plaintext.credentialRef!==credential.ref||!same(credentialRecipient(credential),[plaintext.connectionId,plaintext.providerId,plaintext.region,plaintext.workspaceId,plaintext.endpoint]))return fail('VIDEO_SETTINGS_CORRUPT');
  return plaintext.value;
 }
 async function storeSecret(nextSessions:Map<string,string>,credential:Credential,secret:Extract<VideoSecretUpdate,{action:'replace'}>) {
  credential.encrypted=null;nextSessions.delete(credential.ref);
  if(secret.storage==='session'){nextSessions.set(credential.ref,secret.value);return;}
  await refresh();check();if(!capabilities().persistentAvailable||!secretCodec)return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');
  const plaintext=JSON.stringify({version:1,namespace:VIDEO_SECRET_NAMESPACE,credentialRef:credential.ref,connectionId:credential.connectionId,providerId:credential.providerId,region:credential.region,workspaceId:credential.workspaceId,endpoint:credential.endpoint,value:secret.value});
  validateVideoSecretPlaintext(plaintext);const encrypted=await bounded(()=>secretCodec.encrypt(plaintext),activeSignal);check();if(!validCiphertext(encrypted))return fail('VIDEO_SETTINGS_STORAGE_UNAVAILABLE');credential.encrypted=encrypted;
 }
 return Object.freeze({
  get:()=>schedule(async()=>{await refresh();check();return snapshot();}),
  list(){ensureStable();return state.connections.map(view);},
  select(connectionId:string,configurationRevision:number,modelEntryId:string){ensureStable();const entry=state.connections.find(item=>item.configuration.id===connectionId);if(!entry||entry.revision!==configurationRevision)return fail('VIDEO_SETTINGS_CONFLICT');const model=entry.configuration.models.find(item=>item.id===modelEntryId);if(!entry.configuration.enabled||entry.configuration.archived||!model?.enabled||model.archived)return fail('VIDEO_SETTINGS_DISABLED');const selected=binding(entry,modelEntryId);if(!videoOutputHosts(selected).length)return fail('VIDEO_SETTINGS_NOT_CONFIGURED');assertBinding(selected);return selected;},
  assertBinding(input:unknown){assertBinding(input);},
  acquire(input:unknown,requestSignal?:AbortSignal){return schedule(async()=>{const selected=assertBinding(input),credential=state.credentials.find(item=>item.ref===selected.credentialRef)!;if(requestSignal?.aborted)return fail('VIDEO_SETTINGS_CLOSED');const value=await secretOf(credential,requestSignal);assertBinding(selected);if(requestSignal?.aborted)return fail('VIDEO_SETTINGS_CLOSED');if(!value)return fail('VIDEO_SETTINGS_NOT_CONFIGURED');return value;});},
  acquireCompatible(connectionId:string,configurationRevision:number,requestSignal?:AbortSignal){return schedule(async()=>{
   ensureStable();const entry=state.connections.find(item=>item.configuration.id===connectionId);
   if(!entry||entry.revision!==configurationRevision)return fail('VIDEO_SETTINGS_CONFLICT');if(entry.configuration.providerId!=='compatible')return fail('VIDEO_SETTINGS_VALIDATION');
   const credential=entry.credentialRef?state.credentials.find(item=>item.ref===entry.credentialRef):undefined;if(!credential)return fail('VIDEO_SETTINGS_NOT_CONFIGURED');
   const value=await secretOf(credential,requestSignal);if(requestSignal?.aborted)return fail('VIDEO_SETTINGS_CLOSED');
   // The key leaves only for the origin it was saved with, and only if nothing changed meanwhile.
   if(state.connections.find(item=>item.configuration.id===connectionId)?.revision!==configurationRevision||credential.endpoint!==videoConnectionEndpoint(entry.configuration))return fail('VIDEO_SETTINGS_CONFLICT');
   if(!value)return fail('VIDEO_SETTINGS_NOT_CONFIGURED');return {endpoint:credential.endpoint,value};
  });},
  put(input:unknown){let update:VideoSettingsUpdate;try{if(Buffer.byteLength(JSON.stringify(input))>VIDEO_SETTINGS_LIMITS.updateBytes)throw Error();update=videoSettingsUpdateSchema.parse(input);if(!Number.isSafeInteger(update.expectedRevision))throw Error();}catch{return Promise.reject(videoSettingsError('VIDEO_SETTINGS_VALIDATION'));}pendingPuts++;return schedule(async()=>{
   if(update.expectedRevision!==state.revision)return fail('VIDEO_SETTINGS_CONFLICT');if(state.revision===Number.MAX_SAFE_INTEGER)return fail('VIDEO_SETTINGS_SAVE_FAILED');
   const candidate=copy(state),nextSessions=new Map(sessions);candidate.revision++;
   if(update.action==='restoreCredential'){const credential=candidate.credentials.find(item=>item.ref===update.credentialRef&&item.connectionId===update.connectionId);if(!credential)return fail('VIDEO_SETTINGS_VALIDATION');await storeSecret(nextSessions,credential,update.secret);}
   else{const current=candidate.connections.find(item=>item.configuration.id===(update.action==='save'?update.configuration.id:update.connectionId));if(update.action==='archive'&&!current)return fail('VIDEO_SETTINGS_VALIDATION');
    const configuration=update.action==='save'?update.configuration:{...current!.configuration,enabled:false,archived:true};if(!current&&candidate.connections.length>=VIDEO_SETTINGS_LIMITS.connections)return fail('VIDEO_SETTINGS_VALIDATION');
    let ref=current?.credentialRef??null;const secret=update.action==='save'?update.secret:{action:'keep' as const},sameRecipient=!current||same(recipient(current.configuration),recipient(configuration));
    if(!sameRecipient&&ref&&secret.action==='keep'&&material(ref)!=='none')return fail('VIDEO_SETTINGS_CONFLICT');
    if(secret.action==='remove'&&ref){const credential=candidate.credentials.find(item=>item.ref===ref)!;credential.encrypted=null;nextSessions.delete(ref);}
    if(!sameRecipient)ref=null;
    if(secret.action==='replace'){if(candidate.credentials.length>=VIDEO_SETTINGS_LIMITS.credentials)return fail('VIDEO_SETTINGS_VALIDATION');const credential:Credential={ref:randomUUID(),connectionId:configuration.id,providerId:configuration.providerId,region:configuration.region,workspaceId:configuration.workspaceId,endpoint:videoConnectionEndpoint(configuration),encrypted:null};candidate.credentials.push(credential);ref=credential.ref;await storeSecret(nextSessions,credential,secret);}
    const entry:Revision={configuration:copy(configuration),revision:(current?.revision??0)+1,credentialRef:ref};if(current)candidate.connections[candidate.connections.indexOf(current)]=entry;else candidate.connections.push(entry);candidate.history.push(copy(entry));
   }
   check();validateVideoSettingsEnvelope(candidate);try{await persistence.save(candidate);}catch{try{const actual=await bounded(()=>persistence.load());if(!same(actual??{version:1,namespace:VIDEO_SECRET_NAMESPACE,revision:0,connections:[],history:[],credentials:[]},state))throw Error();}catch{fault=videoSettingsError('VIDEO_SETTINGS_SAVE_FAILED');sessions.clear();}return fail('VIDEO_SETTINGS_SAVE_FAILED');}
   state=candidate;sessions=nextSessions;return snapshot();
  }).finally(()=>{pendingPuts--;});},
  async close(){closing=true;lifetime.abort();await tail;sessions.clear();},
 });
}

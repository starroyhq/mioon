import {randomUUID,createHash} from 'node:crypto';
import {PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import {PROJECT_ENTRY_CONTROL_LIMITS,projectEntryControlRequestSchema,projectEntryControlCancelSchema,projectEntryControlReleaseSchema,projectEntryControlResponseSchema,projectEntryControlRevokedSchema,projectEntryControlCommandSchema,parseProjectEntryControlResult,projectEntryControlErrorSchema} from '../../../packages/contracts/src/project-entry-control.ts';
import type {ProjectEntryControlCommand,ProjectEntryControlResults} from '../../../packages/contracts/src/project-entry-control.ts';
import type {ProjectEntryControlPort,ProjectEntryWindowRevoked} from '../../../packages/contracts/src/project-entry-native.ts';
import {NATIVE_ASSET_MEDIA_LIMITS} from '../../../packages/contracts/src/asset-media-native.ts';
import type {NativeAssetMediaPort} from '../../../packages/contracts/src/asset-media-native.ts';

interface Port{postMessage(message:unknown):void}
interface RequestOptions{signal?:AbortSignal;timeoutMs?:number}
const failure=(code='PROJECT_ENTRY_UNAVAILABLE',details:Record<string,unknown>={})=>Object.assign(new Error(code),{code,status:code==='PROJECT_ENTRY_OUTCOME_UNKNOWN'?409:503,details});
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const size=(value:unknown):number=>{try{return Buffer.byteLength(JSON.stringify(value));}catch{return Infinity;}};
export function safeProjectEntryControlError(error:unknown){
 const known=record(error)&&typeof error.code==='string'&&(/^(?:PROJECT_|REQUEST_ID_|VALIDATION_|ASSET_MEDIA_NATIVE_|MEDIA_)[A-Z0-9_]+$/u.test(error.code)||['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT','PREFLIGHT_BUDGET','INSPECTION_BUDGET_EXCEEDED','NOT_FOUND'].includes(error.code));
 const code=record(error)&&(error.code==='EACCES'||error.code==='EPERM')?'PROJECT_ACCESS_DENIED':known?String(error.code):'PROJECT_ENTRY_UNAVAILABLE';
 const details:Record<string,unknown>={};
 if(record(error)&&record(error.details))for(const key of ['projectId','requestId','operation','database','reason','invalidReason','formatVersion','supportedFormatVersion'])if(Object.hasOwn(error.details,key))details[key]=error.details[key];
 // Project-addressed opens wrap the strict kernel failure. Only its verified
 // database and complete version pair may become public format details.
 const format=record(error)&&error.code==='PROJECT_UNAVAILABLE'&&details.reason==='PROJECT_FORMAT_NEWER'&&record(error.cause)&&error.cause.code==='PROJECT_FORMAT_NEWER'&&record(error.cause.details)?error.cause.details:code==='PROJECT_FORMAT_NEWER'?{...details}:undefined;
 delete details.formatVersion;delete details.supportedFormatVersion;
 if(format&&['project','history','cache'].includes(String(format.database))&&Number.isSafeInteger(format.formatVersion)&&Number(format.formatVersion)>0&&Number.isSafeInteger(format.supportedFormatVersion)&&Number(format.supportedFormatVersion)>0){details.database=format.database;details.formatVersion=format.formatVersion;details.supportedFormatVersion=format.supportedFormatVersion;}
 const status=code==='PROJECT_ACCESS_DENIED'?403:record(error)&&Number.isInteger(error.status)&&Number(error.status)>=400&&Number(error.status)<=599?Number(error.status):503;
 const parsed=projectEntryControlErrorSchema.safeParse({code,status,details});return parsed.success?parsed.data:{code:'PROJECT_ENTRY_UNAVAILABLE',status:503,details:{}};
}
const windowId=(command:ProjectEntryControlCommand):string|undefined=>'windowId'in command.input?command.input.windowId:undefined;
const mutates=(command:ProjectEntryControlCommand)=>!['capabilities','listRecent','prepareAcquire','inspectCopy','observeSource','release','acquire','openPath','mediaRelinkCandidate','mediaRelinkDiscard'].includes(command.operation);
const responseBudget=(command:ProjectEntryControlCommand)=>command.operation==='listRecent'?PROJECT_ENTRY_LIMITS.responseBytes:command.operation.startsWith('mediaRelink')?NATIVE_ASSET_MEDIA_LIMITS.responseBytes:PROJECT_ENTRY_CONTROL_LIMITS.requestBytes;

/** Main's bounded client is tied to one exact utility generation. It never
 * retries a mutation. Cancellation can release only that request's window ID. */
export function createProjectEntryControlClient({backendId,send,isCurrent=()=>true}:{backendId:string;send:(message:unknown)=>void;isCurrent?:()=>boolean}){
 const pending=new Map<string,{command:ProjectEntryControlCommand;deadline:number;resolve(value:unknown):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>;remove():void}>();
 const listeners=new Set<(event:ProjectEntryWindowRevoked)=>void>();let closed=false;
 const cancel=(requestId:string)=>{try{send({type:'project-entry-control-cancel',version:1,backendId,requestId});}catch{}};
 function request<C extends ProjectEntryControlCommand>(command:C,options:RequestOptions={}):Promise<ProjectEntryControlResults[C['operation']]> {
  projectEntryControlCommandSchema.parse(command);
  if(closed||!isCurrent())return Promise.reject(failure());
  if(pending.size>=PROJECT_ENTRY_CONTROL_LIMITS.pending)return Promise.reject(failure('PROJECT_ENTRY_BUSY'));
  const timeoutMs=options.timeoutMs??(mutates(command)?PROJECT_ENTRY_CONTROL_LIMITS.writeMs:PROJECT_ENTRY_CONTROL_LIMITS.readMs);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>PROJECT_ENTRY_CONTROL_LIMITS.maxMs)return Promise.reject(failure('PROJECT_ENTRY_INVALID'));
  const requestId=randomUUID(),message={type:'project-entry-control-request',version:1,backendId,requestId,deadline:Date.now()+timeoutMs,command};
  if(size(message)>PROJECT_ENTRY_CONTROL_LIMITS.requestBytes)return Promise.reject(failure('PROJECT_ENTRY_LIMIT'));
  return new Promise<unknown>((resolve,reject)=>{
   const stopped=()=>{const slot=pending.get(requestId);if(!slot)return;pending.delete(requestId);clearTimeout(slot.timer);slot.remove();cancel(requestId);reject(failure(mutates(command)?'PROJECT_ENTRY_OUTCOME_UNKNOWN':'PROJECT_ENTRY_UNAVAILABLE',{requestId,operation:command.operation}));};
   const timer=setTimeout(stopped,timeoutMs),remove=()=>options.signal?.removeEventListener('abort',stopped);
   pending.set(requestId,{command,deadline:message.deadline,resolve,reject,timer,remove});
   if(options.signal?.aborted)return stopped();options.signal?.addEventListener('abort',stopped,{once:true});
   try{send(message);}catch{stopped();}
  }) as Promise<ProjectEntryControlResults[C['operation']]>;
 }
 function handle(raw:unknown):boolean{
  if(!record(raw)||!['project-entry-control-response','project-entry-control-revoked'].includes(String(raw.type)))return false;
  if(closed||!isCurrent()||raw.backendId!==backendId)return true;
  if(raw.type==='project-entry-control-revoked'){
   const parsed=projectEntryControlRevokedSchema.safeParse(raw);if(!parsed.success)return true;
   for(const listener of listeners)try{listener(parsed.data.event);}catch{}return true;
  }
  if(typeof raw.requestId!=='string')return true;const slot=pending.get(raw.requestId);if(!slot)return true;
  pending.delete(raw.requestId);clearTimeout(slot.timer);slot.remove();
  if(Date.now()>=slot.deadline){cancel(raw.requestId);slot.reject(failure(mutates(slot.command)?'PROJECT_ENTRY_OUTCOME_UNKNOWN':'PROJECT_ENTRY_UNAVAILABLE',{requestId:raw.requestId,operation:slot.command.operation}));return true;}
  let explicitFailure=false;
  try{
   const budget=responseBudget(slot.command);
   if(size(raw)>budget)throw failure();const value=projectEntryControlResponseSchema.parse(raw);
   if(!value.ok){explicitFailure=true;throw Object.assign(new Error(value.error.code),value.error);}
   slot.resolve(parseProjectEntryControlResult(slot.command,value.data));
  }catch(error){cancel(raw.requestId);slot.reject(mutates(slot.command)&&!explicitFailure?failure('PROJECT_ENTRY_OUTCOME_UNKNOWN',{requestId:raw.requestId,operation:slot.command.operation}):record(error)&&typeof error.code==='string'?error:failure());}
  return true;
 }
 const api={
  nativeRelink:{
   candidate:(input:Parameters<NativeAssetMediaPort['candidate']>[0],options:RequestOptions={})=>request({operation:'mediaRelinkCandidate',input},options),
   preview:(input:Parameters<NativeAssetMediaPort['preview']>[0],options:RequestOptions={})=>request({operation:'mediaRelinkPreview',input},options),
   apply:(input:Parameters<NativeAssetMediaPort['apply']>[0],options:RequestOptions={})=>request({operation:'mediaRelinkApply',input},options),
   discard:async(input:Parameters<NativeAssetMediaPort['discard']>[0],options:RequestOptions={})=>{await request({operation:'mediaRelinkDiscard',input},options);},
  },
  capabilities:()=>request({operation:'capabilities',input:{}}),
  listRecent:()=>request({operation:'listRecent',input:{}}),
  prepareAcquire:(input:{projectId:string})=>request({operation:'prepareAcquire',input}),
  create:(input:Parameters<ProjectEntryControlPort['create']>[0])=>request({operation:'create',input}),
  openPath:(input:Parameters<ProjectEntryControlPort['openPath']>[0])=>request({operation:'openPath',input}),
  acquire:(input:Parameters<ProjectEntryControlPort['acquire']>[0])=>request({operation:'acquire',input}),
  release:(input:Parameters<ProjectEntryControlPort['release']>[0])=>{
   const message=projectEntryControlReleaseSchema.parse({type:'project-entry-control-release',version:1,backendId,...input});
   if(closed||!isCurrent())return;
   // Cleanup must remain admissible when all business slots are occupied.
   // The exact utility receives this fixed message outside the reply queue.
   send(message);
  },
  inspectSelectedCopy:(input:{projectFile:string})=>request({operation:'inspectCopy',input}),
  observeSource:(input:{projectFile:string})=>request({operation:'observeSource',input}),
  adoptCopy:(input:Parameters<NonNullable<ProjectEntryControlPort['adoptCopy']>>[0])=>request({operation:'adoptCopy',input}),
  saveAs:(input:Parameters<NonNullable<ProjectEntryControlPort['saveAs']>>[0])=>request({operation:'saveAs',input}),
  duplicate:(input:Parameters<NonNullable<ProjectEntryControlPort['duplicate']>>[0])=>request({operation:'duplicate',input}),
  copyTo:(input:Parameters<NonNullable<ProjectEntryControlPort['copyTo']>>[0])=>request({operation:'copyTo',input}),
  instantiateTemplate:(input:Extract<ProjectEntryControlCommand,{operation:'instantiateTemplate'}>['input'])=>request({operation:'instantiateTemplate',input}),
  onWindowRevoked(listener:(event:ProjectEntryWindowRevoked)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
 };
 return {api,request,handle,close(){if(closed)return;for(const [id,slot]of pending){cancel(id);clearTimeout(slot.timer);slot.remove();slot.reject(failure(mutates(slot.command)?'PROJECT_ENTRY_OUTCOME_UNKNOWN':'PROJECT_ENTRY_UNAVAILABLE',{requestId:id,operation:slot.command.operation}));}pending.clear();listeners.clear();closed=true;}};
}
export type DesktopProjectEntryControl=ReturnType<typeof createProjectEntryControlClient>['api'];

/** Utility owns the real server port. Completed catalogs are never retained;
 * small mutation receipts are bounded and valid only in this generation. */
export function createProjectEntryControlBroker({backendId,control,send,isCurrent=()=>true}:{backendId:string;control:ProjectEntryControlPort;send:(message:unknown)=>void;isCurrent?:()=>boolean}){
 const pending=new Map<string,{command:ProjectEntryControlCommand;cancelled:boolean;abort:AbortController;timer:ReturnType<typeof setTimeout>}>(),completed=new Map<string,{command:ProjectEntryControlCommand;fingerprint:string;response:unknown;retired:boolean}>();let closed=false;
 const releasedWindows=new Set<string>();
 const releaseWindow=(id:string)=>{if(releasedWindows.has(id))return;releasedWindows.add(id);control.release({windowId:id});};
 const unlisten=control.onWindowRevoked(event=>{releasedWindows.add(event.windowId);if(!closed&&isCurrent())send({type:'project-entry-control-revoked',version:1,backendId,event});});
 const release=(command:ProjectEntryControlCommand)=>{const id=windowId(command);if(id&&command.operation!=='release')releaseWindow(id);};
 const cleanNative=(command:ProjectEntryControlCommand,data:unknown)=>{
  if(!control.nativeRelink||!record(data))return;
  if(command.operation!=='mediaRelinkCandidate'&&command.operation!=='mediaRelinkPreview')return;
  const token=command.operation==='mediaRelinkCandidate'?{candidateToken:data.candidateToken}:command.operation==='mediaRelinkPreview'?{previewToken:data.previewToken}:null;
  if(token)void Promise.resolve().then(()=>control.nativeRelink!.discard({projectId:command.input.projectId,ownerToken:command.input.ownerToken,...token} as Parameters<NativeAssetMediaPort['discard']>[0])).catch(()=>{});
 };
 const respond=(requestId:string,error:unknown)=>{if(!closed&&isCurrent())send({type:'project-entry-control-response',version:1,backendId,requestId,ok:false,error:safeProjectEntryControlError(error)});};
 const abandoned=(requestId:string,command:ProjectEntryControlCommand)=>({type:'project-entry-control-response',version:1,backendId,requestId,ok:false,error:safeProjectEntryControlError(failure(mutates(command)?'PROJECT_ENTRY_OUTCOME_UNKNOWN':'PROJECT_ENTRY_UNAVAILABLE',{requestId,operation:command.operation}))});
 const remember=(requestId:string,command:ProjectEntryControlCommand,fingerprint:string,response:unknown,retired=false)=>{
  if(closed||command.operation==='listRecent')return;
  completed.set(requestId,{command,fingerprint,response,retired});if(completed.size>PROJECT_ENTRY_CONTROL_LIMITS.completed)completed.delete(completed.keys().next().value!);
 };
 const retire=(requestId:string,entry:{command:ProjectEntryControlCommand;response:unknown;retired:boolean},releaseWindow=true)=>{
  if(!entry.retired){entry.retired=true;if(releaseWindow)release(entry.command);if(record(entry.response)&&entry.response.ok===true)cleanNative(entry.command,entry.response.data);}
  // Retain a tombstone, including committed creates/adoptions. Replaying the
  // old ID observes uncertainty; it must never execute the mutation again.
  entry.response=abandoned(requestId,entry.command);
 };
 async function execute(command:ProjectEntryControlCommand,signal:AbortSignal):Promise<unknown>{switch(command.operation){
  case 'mediaRelinkCandidate':if(!control.nativeRelink)throw failure();return control.nativeRelink.candidate(command.input,{signal});
  case 'mediaRelinkPreview':if(!control.nativeRelink)throw failure();return control.nativeRelink.preview(command.input,{signal});
  case 'mediaRelinkApply':if(!control.nativeRelink)throw failure();return control.nativeRelink.apply(command.input,{signal});
  case 'mediaRelinkDiscard':if(!control.nativeRelink)throw failure();await control.nativeRelink.discard(command.input,{signal});return true;
  case 'capabilities':return {ready:true,create:typeof control.create==='function',open:['openPath','prepareAcquire','acquire','release'].every(key=>typeof control[key as keyof ProjectEntryControlPort]==='function'),saveAs:typeof control.saveAs==='function',duplicate:typeof control.duplicate==='function',copyTo:typeof control.copyTo==='function',adoptCopy:typeof control.adoptCopy==='function'&&typeof control.inspectSelectedCopy==='function',openOriginal:typeof control.observeSource==='function',copySource:typeof control.observeSource==='function'&&typeof control.copyTo==='function',...(typeof control.instantiateTemplate==='function'&&control.templates?.length?{templates:control.templates}:{})};
  case 'prepareAcquire':if(!control.prepareAcquire)throw failure();return control.prepareAcquire(command.input);
  case 'listRecent':return control.listRecent();case 'create':return control.create(command.input);case 'openPath':return control.openPath(command.input);case 'acquire':return control.acquire(command.input);case 'release':releaseWindow(command.input.windowId);return true;
  case 'inspectCopy':if(!control.inspectSelectedCopy)throw failure();return control.inspectSelectedCopy(command.input);
  case 'observeSource':if(!control.observeSource)throw failure();return control.observeSource(command.input);
  case 'adoptCopy':if(!control.adoptCopy)throw failure();return control.adoptCopy(command.input);
  case 'saveAs':if(!control.saveAs)throw failure();return control.saveAs(command.input);
  case 'duplicate':if(!control.duplicate)throw failure();return control.duplicate(command.input);
  case 'copyTo':if(!control.copyTo)throw failure();return control.copyTo(command.input);
  case 'instantiateTemplate':if(!control.instantiateTemplate||!control.templates?.some(template=>template.id===command.input.templateId&&template.version===command.input.templateVersion))throw failure();return control.instantiateTemplate(command.input);
 }}
 return {handle(raw:unknown):boolean{
  if(!record(raw)||!['project-entry-control-request','project-entry-control-cancel','project-entry-control-release'].includes(String(raw.type)))return false;
  if(closed||!isCurrent()||raw.backendId!==backendId)return true;
  if(raw.type==='project-entry-control-release'){
   const parsed=projectEntryControlReleaseSchema.safeParse(raw);if(!parsed.success)return true;
   for(const slot of pending.values())if(windowId(slot.command)===parsed.data.windowId){slot.cancelled=true;slot.abort.abort();}
   for(const [id,entry]of completed)if(windowId(entry.command)===parsed.data.windowId)retire(id,entry,false);
   releaseWindow(parsed.data.windowId);return true;
  }
  if(raw.type==='project-entry-control-cancel'){
   const parsed=projectEntryControlCancelSchema.safeParse(raw);if(parsed.success){const slot=pending.get(parsed.data.requestId);if(slot){slot.cancelled=true;slot.abort.abort();release(slot.command);}const prior=completed.get(parsed.data.requestId);if(prior)retire(parsed.data.requestId,prior);}return true;
  }
  const parsed=projectEntryControlRequestSchema.safeParse(raw);
  if(!parsed.success||size(raw)>PROJECT_ENTRY_CONTROL_LIMITS.requestBytes)return true;
  const {requestId,command,deadline}=parsed.data;
  if(deadline<=Date.now()||deadline>Date.now()+PROJECT_ENTRY_CONTROL_LIMITS.maxMs){respond(requestId,failure());return true;}
  const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex'),prior=completed.get(requestId);
  if(prior){if(prior.fingerprint===fingerprint)send(prior.response);else respond(requestId,failure('PROJECT_ENTRY_REQUEST_CONFLICT'));return true;}
  const intendedWindow=windowId(command);
  if(command.operation!=='release'&&intendedWindow&&releasedWindows.has(intendedWindow)){respond(requestId,failure());return true;}
  if(pending.has(requestId))return true;
  if(pending.size>=PROJECT_ENTRY_CONTROL_LIMITS.pending){respond(requestId,failure('PROJECT_ENTRY_BUSY'));return true;}
  const abort=new AbortController(),slot={command,cancelled:false,abort,timer:setTimeout(()=>{slot.cancelled=true;abort.abort();release(command);},Math.max(1,deadline-Date.now()))};pending.set(requestId,slot);
  void(async()=>{
   let response:unknown,executed=false,rawData:unknown;
   try{
    if(closed||slot.cancelled||!isCurrent()||Date.now()>=deadline)throw failure();
    rawData=await execute(command,abort.signal);executed=true;
    const data=parseProjectEntryControlResult(command,rawData);
    response={type:'project-entry-control-response',version:1,backendId,requestId,ok:true,data};
    if(size(response)>responseBudget(command))throw failure('PROJECT_ENTRY_LIMIT');
   }catch(error){response={type:'project-entry-control-response',version:1,backendId,requestId,ok:false,error:safeProjectEntryControlError(executed&&mutates(command)?failure('PROJECT_ENTRY_OUTCOME_UNKNOWN',{requestId,operation:command.operation}):error)};}
   clearTimeout(slot.timer);pending.delete(requestId);
   if(closed||slot.cancelled||!isCurrent()||Date.now()>=deadline){abort.abort();release(command);cleanNative(command,rawData);remember(requestId,command,fingerprint,abandoned(requestId,command),true);return;}
   remember(requestId,command,fingerprint,response);
   send(response);
  })();return true;
 },close(){closed=true;unlisten();for(const slot of pending.values()){clearTimeout(slot.timer);slot.cancelled=true;slot.abort.abort();release(slot.command);}for(const entry of completed.values())if(record(entry.response)&&entry.response.ok===true)cleanNative(entry.command,entry.response.data);completed.clear();}};
}

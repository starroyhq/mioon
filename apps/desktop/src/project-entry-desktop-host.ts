import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {PROJECT_ENTRY_DESKTOP_LIMITS,projectEntryDesktopRequestSchema,projectLocationFactsSchema,projectDesktopOpenResultSchema,projectDesktopRecentOpenResultSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryDesktopRequest,ProjectLocationFacts,ProjectStoragePurpose,ProjectDesktopOpenResult,ProjectPendingOpenNotice} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntryWindowSchema,projectEntrySourceObservationSchema} from '../../../packages/contracts/src/project-entry-native.ts';
import type {ProjectEntryWindow} from '../../../packages/contracts/src/project-entry-native.ts';
import {projectCopySourceSchema,projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse} from '../../../packages/contracts/src/project-copies.ts';
import {recentProjectSchema} from '../../../packages/contracts/src/project-registry.ts';
import type {RecentProject} from '../../../packages/contracts/src/project-registry.ts';
import type {DesktopProjectEntryControl} from './project-entry-control.ts';
import {safeProjectEntryControlError} from './project-entry-control.ts';
import {projectNameProblem} from '../../../packages/contracts/src/project-name.ts';
import type {ProjectWindowOpenResult} from './project-window-protocol.ts';

export interface ProjectEntryDesktopOwner<W=unknown>{window:W;windowId:string;backendId:string;contextId:string;projectId?:string;isCurrent():boolean}
export interface ProjectEntryLocationAdmission<W=unknown>{owner:ProjectEntryDesktopOwner<W>;file:string;facts:ProjectLocationFacts}
type OpenResult=Pick<ProjectWindowOpenResult,'ok'|'targetWindowId'|'reason'|'failure'>;
type PreparedOpenResult=Omit<OpenResult,'reason'>&{reason:string};
interface Options<E,W>{
 ownerForEvent(event:E):ProjectEntryDesktopOwner<W>|null;
 backend:DesktopProjectEntryControl;
 isReady():boolean;
 chooseDirectory(owner:ProjectEntryDesktopOwner<W>,input:{message:string}):Promise<string|null>;
 chooseOpenFile(owner:ProjectEntryDesktopOwner<W>):Promise<string|null>;
 chooseSaveFile(owner:ProjectEntryDesktopOwner<W>,input:{suggestedName:string;message:string}):Promise<string|null>;
 probeLocation(input:{path:string;purpose:ProjectStoragePurpose|'open';isDirectory:boolean}):Promise<ProjectLocationFacts>;
 /** Policy and any warning confirmation belong to the trusted caller. */
 admitLocation(owner:ProjectEntryDesktopOwner<W>,facts:ProjectLocationFacts):Promise<boolean>;
 adoptPrepared(prepared:ProjectEntryWindow,waitForReady?:boolean,origin?:Pick<ProjectEntryDesktopOwner<W>,'window'|'contextId'|'isCurrent'>):Promise<PreparedOpenResult>;
 openRecent(owner:ProjectEntryDesktopOwner<W>,projectId:string,entryToken:string,remember:boolean):Promise<OpenResult>;
 replaceAfterSaveAs?(owner:ProjectEntryDesktopOwner<W>,result:{copy:ProjectCopyResponse;window:ProjectEntryWindow}):Promise<void>;
 openPrivacySettings?(owner:ProjectEntryDesktopOwner<W>):Promise<void>;
 revealVerifiedPath?(owner:ProjectEntryDesktopOwner<W>,file:string):void|Promise<void>;
 notifyPendingOpen?(owner:ProjectEntryDesktopOwner<W>,notice:ProjectPendingOpenNotice):void;
}
type CopySource=ReturnType<typeof projectCopySourceSchema.parse>;
type Ticket<W>={owner:ProjectEntryDesktopOwner<W>;expires:number}&({kind:'storage';purpose:ProjectStoragePurpose;file:string;facts:ProjectLocationFacts;template?:{id:'timeline-basics';version:1;name:string;parentDir:string}}|{kind:'copy'|'source';source:CopySource;original:RecentProject|null;admittedFacts?:ProjectLocationFacts});
const unavailable=(code='PROJECT_ENTRY_UNAVAILABLE')=>Object.assign(new Error(code),{code,status:409});
const same=<W>(a:ProjectEntryDesktopOwner<W>,b:ProjectEntryDesktopOwner<W>)=>a.window===b.window&&a.windowId===b.windowId&&a.backendId===b.backendId&&a.contextId===b.contextId;
const sameFacts=(a:ProjectLocationFacts,b:ProjectLocationFacts)=>a.fileSystem===b.fileSystem&&a.isLocal===b.isLocal&&a.volumeReadOnly===b.volumeReadOnly&&a.permissionBits===b.permissionBits&&a.cloud===b.cloud;
const absolute=(file:string):boolean=>path.isAbsolute(file)&&path.resolve(file)===file;

/** System selections and observed copy stamps stay with their exact main-frame
 * owner. The renderer can confirm opaque tokens, never author trusted paths. */
export function createProjectEntryDesktopHost<E,W>(options:Options<E,W>){
 const tickets=new Map<string,Ticket<W>>(),operations=new Map<string,{fingerprint:string;promise:Promise<unknown>}>(),busy=new Set<string>(),pendingOpen=new Map<string,{owner:ProjectEntryDesktopOwner<W>;result:ProjectDesktopOpenResult;expires:number}>();let closed=false;
 const ownerKeyOf=(owner:ProjectEntryDesktopOwner<W>)=>owner.backendId+':'+owner.windowId+':'+owner.contextId;
 const check=(owner:ProjectEntryDesktopOwner<W>)=>{if(closed||!options.isReady()||!owner.isCurrent())throw unavailable();};
 const mutationResult=(owner:ProjectEntryDesktopOwner<W>)=>{try{check(owner);}catch{throw unavailable('PROJECT_ENTRY_OUTCOME_UNKNOWN');}};
 const sweep=()=>{const now=Date.now();for(const [id,ticket]of tickets)if(ticket.expires<=now||!ticket.owner.isCurrent())tickets.delete(id);for(const [key,pending]of pendingOpen)if(pending.expires<=now||!pending.owner.isCurrent())pendingOpen.delete(key);};
 function put(ticket:Ticket<W>):string{sweep();if(tickets.size>=PROJECT_ENTRY_DESKTOP_LIMITS.tickets)throw unavailable('PROJECT_ENTRY_LIMIT');const id=randomUUID();tickets.set(id,ticket);return id;}
 function ticketFor(token:string,owner:ProjectEntryDesktopOwner<W>):Ticket<W>{
  const previous=tickets.get(token);if(previous&&!same(previous.owner,owner))throw unavailable();
  sweep();const ticket=tickets.get(token);if(!ticket)throw unavailable('PROJECT_ENTRY_TICKET_EXPIRED');return ticket;
 }
 async function probe(owner:ProjectEntryDesktopOwner<W>,file:string,purpose:ProjectStoragePurpose|'open',isDirectory:boolean):Promise<ProjectLocationFacts>{
  check(owner);if(!absolute(file))throw unavailable('PROJECT_LOCATION_INVALID');
  const facts=projectLocationFactsSchema.parse(await options.probeLocation({path:file,purpose,isDirectory}));check(owner);
  return facts;
 }
 async function location(owner:ProjectEntryDesktopOwner<W>,file:string,purpose:ProjectStoragePurpose|'open',isDirectory:boolean):Promise<ProjectLocationFacts>{
  const facts=await probe(owner,file,purpose,isDirectory);
  if(!await options.admitLocation(owner,facts))throw unavailable('PROJECT_LOCATION_REJECTED');check(owner);return facts;
 }
 async function opened(owner:ProjectEntryDesktopOwner<W>,prepared:ProjectEntryWindow,waitForReady=false):Promise<ProjectDesktopOpenResult>{
  const parsed=projectEntryWindowSchema.parse(prepared);
  try{check(owner);}catch(error){options.backend.release({windowId:parsed.windowId});throw error;}
  // adoptPrepared owns cleanup on both success and refusal, including a
  // duplicate project that already has its own immutable editor/lease.
  const result=await options.adoptPrepared(parsed,waitForReady,waitForReady?owner:undefined);
  if(waitForReady)check(owner);
  if(result.reason==='cancelled')return {status:'cancelled'};
  if(result.failure){
   const {code,...details}=result.failure;
   throw Object.assign(new Error(code),{code,status:code==='PROJECT_ACCESS_DENIED'?403:409,details});
  }
  if(!result.ok||!result.targetWindowId)throw unavailable();
  return {status:'opened',projectId:parsed.project.projectId,windowId:result.targetWindowId};
 }
 async function selectedOpen(owner:ProjectEntryDesktopOwner<W>,file:string,admission?:ProjectEntryLocationAdmission<W>):Promise<ProjectDesktopOpenResult>{
  const facts=await probe(owner,file,'open',false);check(owner);
  // Only the trusted OS-open caller may reuse its confirmation. Re-observe
  // every fact and retain the exact document/path before skipping a warning.
  if(admission&&(!same(admission.owner,owner)||!admission.owner.isCurrent()||admission.file!==file||!sameFacts(admission.facts,facts)))throw unavailable('PROJECT_COPY_SOURCE_CHANGED');
  async function copySource(reason:'read-only'|'network'):Promise<ProjectDesktopOpenResult>{
   // No writable open, lease, registration or permission grant precedes this
   // read-only observation. The ticket still requires the ordinary S5 copyTo.
   const observed=projectEntrySourceObservationSchema.parse(await options.backend.observeSource({projectFile:file}));check(owner);
   const expires=Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs,token=put({kind:'source',source:observed.source,original:observed.original,owner,expires});
   return {status:'copy-source',token,name:observed.name,expiresAt:expires,displayPath:file,reason,facts};
  }
  if(!facts.isLocal||facts.volumeReadOnly)return await copySource(facts.isLocal?'read-only':'network');
  if(!admission&&!await options.admitLocation(owner,facts))throw unavailable('PROJECT_LOCATION_REJECTED');check(owner);
  try{return await opened(owner,await options.backend.openPath({projectFile:file,windowId:randomUUID(),deferRecent:true}),true);}
  catch(error){
   check(owner);
   if(error===null||typeof error!=='object'||!('code'in error))throw error;
   const details='details'in error&&error.details!==null&&typeof error.details==='object'?error.details as Record<string,unknown>:{};
   if(error.code==='PROJECT_INVALID'&&details.reason==='read-only'||error.code==='PROJECT_UNAVAILABLE'&&details.reason==='PROJECT_INVALID'&&details.invalidReason==='read-only')return await copySource('read-only');
   if(error.code!=='PROJECT_FILE_COPY')throw error;
   const observed=projectEntrySourceObservationSchema.parse(await options.backend.observeSource({projectFile:file}));check(owner);
   const expires=Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs,token=put({kind:'copy',source:observed.source,original:observed.original,admittedFacts:facts,owner,expires});
   return {status:'copy',token,name:observed.name,expiresAt:expires,...(observed.original?{original:{name:observed.original.name,displayPath:observed.original.projectFile}}:{})};
  }
 }
 async function mutate(token:string,owner:ProjectEntryDesktopOwner<W>,request:ProjectEntryDesktopRequest,run:(ticket:Ticket<W>)=>Promise<unknown>):Promise<unknown>{
  const key=`${owner.backendId}:${owner.windowId}:${owner.contextId}:${token}`,fingerprint=JSON.stringify(request),previous=operations.get(key);
  if(previous){if(previous.fingerprint!==fingerprint)throw unavailable('PROJECT_ENTRY_REQUEST_CONFLICT');return previous.promise;}
  const ticket=ticketFor(token,owner);tickets.delete(token);
  const promise=(async()=>{check(owner);return run(ticket);})();
  operations.set(key,{fingerprint,promise});if(operations.size>PROJECT_ENTRY_DESKTOP_LIMITS.tickets)operations.delete(operations.keys().next().value!);
  return promise;
 }
 const api = {
  rememberPendingOpen(owner:ProjectEntryDesktopOwner<W>,raw:ProjectDesktopOpenResult){
   check(owner);sweep();const result=projectDesktopOpenResultSchema.parse(raw);let expires=Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs;
   if(result.status==='copy'||result.status==='copy-source'){
    const ticket=tickets.get(result.token);if(!ticket||!same(ticket.owner,owner)||ticket.expires<=Date.now())return;
    expires=ticket.expires;result.expiresAt=expires;
   }
   if(pendingOpen.size>=PROJECT_ENTRY_DESKTOP_LIMITS.tickets)pendingOpen.delete(pendingOpen.keys().next().value!);
   pendingOpen.set(ownerKeyOf(owner),{owner,result,expires});
   options.notifyPendingOpen?.(owner,{backendId:owner.backendId,windowId:owner.windowId,contextId:owner.contextId});
  },
  async openPath(owner:ProjectEntryDesktopOwner<W>,file:string,admission?:ProjectEntryLocationAdmission<W>){check(owner);return selectedOpen(owner,file,admission);},
  async dispatch(event:E,raw:unknown):Promise<unknown>{
   if(Buffer.byteLength(JSON.stringify(raw))>PROJECT_ENTRY_DESKTOP_LIMITS.requestBytes)throw unavailable('PROJECT_ENTRY_LIMIT');
   const request=projectEntryDesktopRequestSchema.parse(raw),owner=options.ownerForEvent(event);
   if(!owner||closed||!owner.isCurrent())throw unavailable();
   if(request.action==='capabilities'){
    const ready=options.isReady();
    if(!ready)return {ready:false,create:false,open:false,saveAs:false,duplicate:false,copyTo:false,adoptCopy:false};
    try{const capability=await options.backend.capabilities();check(owner);return {...capability,saveAs:capability.saveAs&&Boolean(options.replaceAfterSaveAs),help:Boolean(options.openPrivacySettings),reveal:Boolean(options.revealVerifiedPath),locationFacts:Boolean(owner.projectId)&&capability.open,openOriginal:capability.openOriginal===true&&capability.open};}
    catch{return {ready:false,create:false,open:false,saveAs:false,duplicate:false,copyTo:false,adoptCopy:false};}
   }
   check(owner);
   if(request.action==='takePendingOpen'){
    sweep();const key=ownerKeyOf(owner),pending=pendingOpen.get(key);pendingOpen.delete(key);
    if(!pending||!same(pending.owner,owner)||pending.expires<=Date.now())return null;
    const result=pending.result;
    if(result.status==='copy'||result.status==='copy-source'){const ticket=tickets.get(result.token);if(!ticket||!same(ticket.owner,owner)||ticket.expires<=Date.now())return null;}
    return result;
   }
   const ownerKey=owner.backendId+':'+owner.windowId;
   if(busy.has(ownerKey)||busy.size>=PROJECT_ENTRY_DESKTOP_LIMITS.pending)throw unavailable('PROJECT_ENTRY_BUSY');
   busy.add(ownerKey);
   try{
    if(request.action==='listRecent'){const result=await options.backend.listRecent();check(owner);return result;}
    if(request.action==='openPrivacySettings'){
     if(!options.openPrivacySettings)throw unavailable();await options.openPrivacySettings(owner);check(owner);return null;
    }
    if(request.action==='reveal'){
     if(!options.revealVerifiedPath)throw unavailable();
     let file:string;
     if(request.projectId!==undefined){const project=await options.backend.prepareAcquire({projectId:request.projectId});check(owner);file=project.projectFile;}
     else{const ticket=ticketFor(request.token!,owner);file=ticket.kind==='storage'?ticket.file:ticket.source.sourceFile;}
     check(owner);if(!absolute(file))throw unavailable();await options.revealVerifiedPath(owner,file);check(owner);return null;
    }
    if(request.action==='currentLocation'){
     if(!owner.projectId)throw unavailable();const project=await options.backend.prepareAcquire({projectId:owner.projectId});check(owner);
     const facts=await probe(owner,project.projectFile,'open',false);check(owner);return {displayPath:project.projectFile,facts};
    }
    if(request.action==='openOriginal'){
     const ticket=ticketFor(request.token,owner);if(ticket.kind!=='copy'||!ticket.original)throw unavailable();
     const original=await options.backend.prepareAcquire({projectId:ticket.original.projectId});check(owner);
     if(original.fileIdentity.dev!==ticket.original.fileIdentity.dev||original.fileIdentity.ino!==ticket.original.fileIdentity.ino)throw unavailable('PROJECT_COPY_SOURCE_CHANGED');
     await location(owner,original.projectFile,'open',false);check(owner);
     return await opened(owner,await options.backend.acquire({projectId:original.projectId,windowId:randomUUID(),expectedProjectFile:original.projectFile}));
    }
    if(request.action==='chooseLocation'){
     if(request.purpose==='template'){
      const capability=await options.backend.capabilities();check(owner);
      const template=capability.templates?.find(value=>value.id==='timeline-basics'&&value.version===1);
      if(!template)throw unavailable('PROJECT_TEMPLATE_NOT_FOUND');
      const selected=await options.chooseSaveFile(owner,{suggestedName:request.suggestedName,message:request.message});check(owner);
      if(selected===null)return null;
      if(!absolute(selected)||!selected.endsWith('.mioon'))throw unavailable('PROJECT_LOCATION_INVALID');
      const parentDir=path.dirname(selected),name=path.basename(selected,'.mioon');
      if(projectNameProblem(name)!==null)throw unavailable('PROJECT_LOCATION_INVALID');
      // S5 creates a dedicated folder. Observe its real existing parent; the
      // final folder/file path is derived here, never from renderer display text.
      const file=path.join(parentDir,name,name+'.mioon'),facts=await location(owner,parentDir,'template',true);
      // Probe/admit the volume before any target I/O. Both the save-panel
      // name and S5's actual dedicated folder must be free, including symlinks.
      for(const target of [selected,path.dirname(file)]){
       let exists=false;
       try{await lstat(target);exists=true;}
       catch(error){if(error===null||typeof error!=='object'||!('code'in error)||error.code!=='ENOENT')throw error;}
       check(owner);if(exists)throw unavailable('PROJECT_FILE_EXISTS');
      }
      const bound={id:template.id,version:template.version,name,parentDir};
      return {token:put({kind:'storage',purpose:'template',file,facts,template:bound,owner,expires:Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs}),displayPath:file,facts,template:{...template,name}};
     }
     const file=request.purpose==='create'?await options.chooseDirectory(owner,{message:request.message}):await options.chooseSaveFile(owner,{suggestedName:request.suggestedName,message:request.message});
     check(owner);if(file===null)return null;
     const facts=await location(owner,file,request.purpose,request.purpose==='create');
     return {token:put({kind:'storage',purpose:request.purpose,file,facts,owner,expires:Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs}),displayPath:file,facts};
    }
    if(request.action==='createAtSelection')return await mutate(request.token,owner,request,async ticket=>{
     if(ticket.kind!=='storage'||ticket.purpose!=='create')throw unavailable();
     await location(owner,ticket.file,'create',true);check(owner);
     const project=recentProjectSchema.parse(await options.backend.create({name:request.name,...(request.description!==undefined?{description:request.description}:{}),...(request.timelinePresetId?{timelinePresetId:request.timelinePresetId}:{}),...(request.createFolder?{parentDir:ticket.file}:{projectFile:path.join(ticket.file,request.name+'.mioon')})}));
     mutationResult(owner);return {status:'created',project};
    });
    if(request.action==='instantiateTemplate')return await mutate(request.token,owner,request,async ticket=>{
     if(ticket.kind!=='storage'||ticket.purpose!=='template'||!ticket.template||ticket.template.id!==request.templateId||ticket.template.version!==request.templateVersion||ticket.template.name!==request.name)throw unavailable();
     await location(owner,ticket.template.parentDir,'template',true);check(owner);
     const copy=projectCopyResponseSchema.parse(await options.backend.instantiateTemplate({templateId:request.templateId,templateVersion:request.templateVersion,parentDir:ticket.template.parentDir,name:ticket.template.name,...(request.locale?{locale:request.locale}:{}),requestId:request.requestId}));
     mutationResult(owner);
     if(copy.requestId!==request.requestId||copy.project.projectFile!==ticket.file||copy.project.name!==ticket.template.name)throw unavailable('PROJECT_ENTRY_OUTCOME_UNKNOWN');
     return copy;
    });
    if(request.action==='openSelectedFile'){
     const file=await options.chooseOpenFile(owner);check(owner);return file===null?{status:'cancelled'}:await selectedOpen(owner,file);
    }
    if(request.action==='openRecent'){
     // The sealed window entry resolves moved registration and admits its
     // actual path once. Probing the catalog's old path here would prevent
     // findMoved and could show the same risk warning twice.
     const result=await options.openRecent(owner,request.projectId,request.entryToken,request.remember);check(owner);
     return projectDesktopRecentOpenResultSchema.parse(result.ok
      ? {status:'opened',projectId:request.projectId,windowId:result.targetWindowId}
      : result.reason==='cancelled' ? {status:'cancelled'} : {status:'failed',reason:result.reason,...(result.failure?{failure:result.failure}:{})});
    }
    if(request.action==='adoptCopy')return await mutate(request.token,owner,request,async ticket=>{
     if(ticket.kind!=='copy')throw unavailable();
     const facts=await probe(owner,ticket.source.sourceFile,'open',false);check(owner);
     if(!ticket.admittedFacts||!sameFacts(ticket.admittedFacts,facts))throw unavailable('PROJECT_COPY_SOURCE_CHANGED');
     const result=await options.backend.adoptCopy({...ticket.source,requestId:randomUUID(),windowId:randomUUID()});
     return await opened(owner,result.window);
    });
    if(request.action==='saveAs'||request.action==='duplicate')return await mutate(request.token,owner,request,async ticket=>{
     if(ticket.kind!=='storage'||ticket.purpose!==(request.action==='saveAs'?'save-as':'duplicate'))throw unavailable();
     if(owner.projectId!==undefined&&owner.projectId!==request.projectId)throw unavailable();
     if(request.action==='saveAs'&&(!options.replaceAfterSaveAs||owner.projectId!==request.projectId))throw unavailable();
     await location(owner,ticket.file,ticket.purpose,false);check(owner);
     const input={projectId:request.projectId,projectFile:ticket.file,requestId:request.requestId,...(request.name?{name:request.name}:{})};
     if(request.action==='duplicate'){const copy=projectCopyResponseSchema.parse(await options.backend.duplicate(input));mutationResult(owner);return copy;}
     const result=await options.backend.saveAs({...input,windowId:owner.windowId});
     mutationResult(owner);await options.replaceAfterSaveAs!(owner,result);return result.copy;
    });
    return await mutate(request.token,owner,request,async ticket=>{
     if(request.action!=='copyTo'||ticket.kind!=='storage'||ticket.purpose!=='copy-to')throw unavailable();
     const source=ticketFor(request.sourceToken,owner);if(source.kind==='storage')throw unavailable();
     await location(owner,ticket.file,'copy-to',false);check(owner);
     const copy=projectCopyResponseSchema.parse(await options.backend.copyTo({...source.source,projectFile:ticket.file,requestId:request.requestId,...(request.name?{name:request.name}:{})}));
     mutationResult(owner);return copy;
    });
   }finally{busy.delete(ownerKey);}
  },
  close(){closed=true;tickets.clear();operations.clear();pendingOpen.clear();},
 };
 return {...api,async handle(event:E,raw:unknown):Promise<unknown>{try{return {ok:true,data:await api.dispatch(event,raw)};}catch(error){return {ok:false,error:safeProjectEntryControlError(error)};}}};
}

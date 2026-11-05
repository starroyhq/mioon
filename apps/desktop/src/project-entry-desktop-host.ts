import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_ENTRY_DESKTOP_LIMITS,projectEntryDesktopRequestSchema,projectLocationFactsSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryDesktopRequest,ProjectLocationFacts,ProjectStoragePurpose,ProjectDesktopOpenResult} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntryWindowSchema} from '../../../packages/contracts/src/project-entry-native.ts';
import type {ProjectEntryWindow} from '../../../packages/contracts/src/project-entry-native.ts';
import {projectCopySourceSchema,projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse} from '../../../packages/contracts/src/project-copies.ts';
import {recentProjectSchema} from '../../../packages/contracts/src/project-registry.ts';
import type {DesktopProjectEntryControl} from './project-entry-control.ts';
import {safeProjectEntryControlError} from './project-entry-control.ts';

export interface ProjectEntryDesktopOwner<W=unknown>{window:W;windowId:string;backendId:string;contextId:string;projectId?:string;isCurrent():boolean}
interface OpenResult{ok:boolean;targetWindowId:string|null;reason:string}
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
 adoptPrepared(prepared:ProjectEntryWindow):Promise<OpenResult>;
 openRecent(owner:ProjectEntryDesktopOwner<W>,projectId:string,entryToken:string,remember:boolean):Promise<OpenResult>;
 replaceAfterSaveAs?(owner:ProjectEntryDesktopOwner<W>,result:{copy:ProjectCopyResponse;window:ProjectEntryWindow}):Promise<void>;
}
type CopySource=ReturnType<typeof projectCopySourceSchema.parse>;
type Ticket<W>={owner:ProjectEntryDesktopOwner<W>;expires:number}&({kind:'storage';purpose:ProjectStoragePurpose;file:string;facts:ProjectLocationFacts}|{kind:'copy';source:CopySource});
const unavailable=(code='PROJECT_ENTRY_UNAVAILABLE')=>Object.assign(new Error(code),{code,status:409});
const same=<W>(a:ProjectEntryDesktopOwner<W>,b:ProjectEntryDesktopOwner<W>)=>a.window===b.window&&a.windowId===b.windowId&&a.backendId===b.backendId&&a.contextId===b.contextId;
const absolute=(file:string):boolean=>path.isAbsolute(file)&&path.resolve(file)===file;

/** System selections and observed copy stamps stay with their exact main-frame
 * owner. The renderer can confirm opaque tokens, never author trusted paths. */
export function createProjectEntryDesktopHost<E,W>(options:Options<E,W>){
 const tickets=new Map<string,Ticket<W>>(),operations=new Map<string,{fingerprint:string;promise:Promise<unknown>}>(),busy=new Set<string>(),pendingOpen=new Map<string,ProjectDesktopOpenResult>();let closed=false;
 const ownerKeyOf=(owner:ProjectEntryDesktopOwner<W>)=>owner.backendId+':'+owner.windowId+':'+owner.contextId;
 const check=(owner:ProjectEntryDesktopOwner<W>)=>{if(closed||!options.isReady()||!owner.isCurrent())throw unavailable();};
 const mutationResult=(owner:ProjectEntryDesktopOwner<W>)=>{try{check(owner);}catch{throw unavailable('PROJECT_ENTRY_OUTCOME_UNKNOWN');}};
 const sweep=()=>{for(const [id,ticket]of tickets)if(ticket.expires<Date.now()||!ticket.owner.isCurrent())tickets.delete(id);};
 function put(ticket:Ticket<W>):string{sweep();if(tickets.size>=PROJECT_ENTRY_DESKTOP_LIMITS.tickets)throw unavailable('PROJECT_ENTRY_LIMIT');const id=randomUUID();tickets.set(id,ticket);return id;}
 function ticketFor(token:string,owner:ProjectEntryDesktopOwner<W>):Ticket<W>{sweep();const ticket=tickets.get(token);if(!ticket||!same(ticket.owner,owner))throw unavailable();return ticket;}
 async function location(owner:ProjectEntryDesktopOwner<W>,file:string,purpose:ProjectStoragePurpose|'open',isDirectory:boolean):Promise<ProjectLocationFacts>{
  check(owner);if(!absolute(file))throw unavailable('PROJECT_LOCATION_INVALID');
  const facts=projectLocationFactsSchema.parse(await options.probeLocation({path:file,purpose,isDirectory}));check(owner);
  if(!await options.admitLocation(owner,facts))throw unavailable('PROJECT_LOCATION_REJECTED');check(owner);return facts;
 }
 async function opened(owner:ProjectEntryDesktopOwner<W>,prepared:ProjectEntryWindow):Promise<ProjectDesktopOpenResult>{
  const parsed=projectEntryWindowSchema.parse(prepared);
  try{check(owner);}catch(error){options.backend.release({windowId:parsed.windowId});throw error;}
  // adoptPrepared owns cleanup on both success and refusal, including a
  // duplicate project that already has its own immutable editor/lease.
  const result=await options.adoptPrepared(parsed);
  if(!result.ok||!result.targetWindowId)throw unavailable();
  return {status:'opened',projectId:parsed.project.projectId,windowId:result.targetWindowId};
 }
 async function selectedOpen(owner:ProjectEntryDesktopOwner<W>,file:string):Promise<ProjectDesktopOpenResult>{
  await location(owner,file,'open',false);check(owner);
  try{return await opened(owner,await options.backend.openPath({projectFile:file,windowId:randomUUID()}));}
  catch(error){
   check(owner);
   if(error===null||typeof error!=='object'||!('code'in error)||error.code!=='PROJECT_FILE_COPY')throw error;
   const source=projectCopySourceSchema.parse(await options.backend.inspectSelectedCopy({projectFile:file}));check(owner);
   const token=put({kind:'copy',source,owner,expires:Date.now()+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs});
   return {status:'copy',token,name:path.basename(file)};
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
  rememberPendingOpen(owner:ProjectEntryDesktopOwner<W>,result:ProjectDesktopOpenResult){check(owner);if(pendingOpen.size>=PROJECT_ENTRY_DESKTOP_LIMITS.tickets)pendingOpen.delete(pendingOpen.keys().next().value!);pendingOpen.set(ownerKeyOf(owner),result);},
  async openPath(owner:ProjectEntryDesktopOwner<W>,file:string){check(owner);return selectedOpen(owner,file);},
  async dispatch(event:E,raw:unknown):Promise<unknown>{
   if(Buffer.byteLength(JSON.stringify(raw))>PROJECT_ENTRY_DESKTOP_LIMITS.requestBytes)throw unavailable('PROJECT_ENTRY_LIMIT');
   const request=projectEntryDesktopRequestSchema.parse(raw),owner=options.ownerForEvent(event);
   if(!owner||closed||!owner.isCurrent())throw unavailable();
   if(request.action==='capabilities'){
    const ready=options.isReady();
    if(!ready)return {ready:false,create:false,open:false,saveAs:false,duplicate:false,copyTo:false,adoptCopy:false};
    try{const capability=await options.backend.capabilities();check(owner);return {...capability,saveAs:capability.saveAs&&Boolean(options.replaceAfterSaveAs)};}
    catch{return {ready:false,create:false,open:false,saveAs:false,duplicate:false,copyTo:false,adoptCopy:false};}
   }
   check(owner);
   if(request.action==='takePendingOpen'){const key=ownerKeyOf(owner),result=pendingOpen.get(key)??null;pendingOpen.delete(key);return result;}
   const ownerKey=owner.backendId+':'+owner.windowId;
   if(busy.has(ownerKey)||busy.size>=PROJECT_ENTRY_DESKTOP_LIMITS.pending)throw unavailable('PROJECT_ENTRY_BUSY');
   busy.add(ownerKey);
   try{
    if(request.action==='listRecent'){const result=await options.backend.listRecent();check(owner);return result;}
    if(request.action==='chooseLocation'){
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
    if(request.action==='openSelectedFile'){
     const file=await options.chooseOpenFile(owner);check(owner);return file===null?{status:'cancelled'}:await selectedOpen(owner,file);
    }
    if(request.action==='openRecent'){
     // The sealed window entry resolves moved registration and admits its
     // actual path once. Probing the catalog's old path here would prevent
     // findMoved and could show the same risk warning twice.
     const result=await options.openRecent(owner,request.projectId,request.entryToken,request.remember);check(owner);
     if(!result.ok||!result.targetWindowId)throw unavailable();return {status:'opened',projectId:request.projectId,windowId:result.targetWindowId};
    }
    if(request.action==='adoptCopy')return await mutate(request.token,owner,request,async ticket=>{
     if(ticket.kind!=='copy')throw unavailable();await location(owner,ticket.source.sourceFile,'open',false);check(owner);
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
     const source=ticketFor(request.sourceToken,owner);if(source.kind!=='copy')throw unavailable();
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

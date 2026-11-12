import {PROJECT_ENTRY_DESKTOP_CHANNEL,PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT,PROJECT_ENTRY_DESKTOP_LIMITS,projectPendingOpenNoticeSchema,projectEntryDesktopRequestSchema,projectDesktopCapabilitiesSchema,projectDesktopSelectionSchema,projectDesktopOpenResultSchema,projectDesktopRecentOpenResultSchema,projectDesktopCreatedSchema,projectDesktopLocationSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntriesDesktopBridge,ProjectPendingOpenNotice} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntriesResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import {projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntryControlErrorSchema} from '../../../packages/contracts/src/project-entry-control.ts';
interface PendingOpenTransport{
 on(channel:typeof PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT,listener:(event:unknown,value:unknown)=>void):void;
 removeListener(channel:typeof PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT,listener:(event:unknown,value:unknown)=>void):void;
 context():Promise<{backendId:string;windowId:string;contextId:string}>;
}
export function createProjectEntriesDesktopBridge(invoke:(channel:typeof PROJECT_ENTRY_DESKTOP_CHANNEL,input:unknown)=>Promise<unknown>,pending?:PendingOpenTransport):ProjectEntriesDesktopBridge{
 const request=async(input:unknown):Promise<unknown>=>{
  const value=await invoke(PROJECT_ENTRY_DESKTOP_CHANNEL,projectEntryDesktopRequestSchema.parse(input));
  if(value===null||typeof value!=='object'||!('ok'in value)||typeof value.ok!=='boolean')throw new Error('Invalid project entry response');
  if(!value.ok){
   if(Object.keys(value).sort().join(',')!=='error,ok'||!('error'in value))throw new Error('Invalid project entry response');
   // contextBridge drops custom Error properties. The page rebuilds its own
   // Error from this strictly validated, cloneable rejection DTO.
   throw projectEntryControlErrorSchema.parse(value.error);
  }
  if(Object.keys(value).sort().join(',')!=='data,ok'||!('data'in value))throw new Error('Invalid project entry response');return value.data;
 };
 const subscribePendingOpen:NonNullable<ProjectEntriesDesktopBridge['subscribePendingOpen']>=listener=>{
  if(!pending||typeof listener!=='function')throw new Error('Invalid pending project subscription');
  let active=true,binding=false,identity:ProjectPendingOpenNotice|null=null,queued:ProjectPendingOpenNotice[]=[];
  const deliver=(notice:ProjectPendingOpenNotice)=>{
   if(!active||!identity||notice.backendId!==identity.backendId||notice.windowId!==identity.windowId||notice.contextId!==identity.contextId)return;
   // Callbacks stay outside the context handshake promise; renderer failures
   // must not be mistaken for a rejected identity or silently swallowed.
   queueMicrotask(()=>{if(active)listener();});
  };
  const bind=()=>{
   if(!active||identity||binding)return;binding=true;
   void Promise.resolve().then(()=>pending.context()).then(value=>{
    binding=false;if(!active)return;
    const parsed=projectPendingOpenNoticeSchema.safeParse(value&&{backendId:value.backendId,windowId:value.windowId,contextId:value.contextId});
    if(!parsed.success){queued=[];return;}identity=parsed.data;
    const notices=queued;queued=[];for(const notice of notices)deliver(notice);
   },()=>{binding=false;queued=[];});
  };
  const receive=(_event:unknown,value:unknown)=>{
   if(!active)return;const notice=projectPendingOpenNoticeSchema.safeParse(value);if(!notice.success)return;
   if(identity)deliver(notice.data);else{if(queued.length>=PROJECT_ENTRY_DESKTOP_LIMITS.tickets)queued.shift();queued.push(notice.data);bind();}
  };
  pending.on(PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT,receive);bind();
  return()=>{if(active){active=false;queued=[];pending.removeListener(PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT,receive);}};
 };
 return Object.freeze({
  capabilities:async()=>projectDesktopCapabilitiesSchema.parse(await request({action:'capabilities'})),
  listRecent:async()=>projectEntriesResponseSchema.parse(await request({action:'listRecent'})),
  chooseLocation:async(input:Parameters<ProjectEntriesDesktopBridge['chooseLocation']>[0])=>{const value=await request({action:'chooseLocation',...input});if(value===null)return null;const selection=projectDesktopSelectionSchema.parse(value);if(input.purpose==='template'?!selection.template:Object.hasOwn(selection,'template'))throw new Error('Invalid project selection');return selection;},
  createAtSelection:async(input:Parameters<ProjectEntriesDesktopBridge['createAtSelection']>[0])=>projectDesktopCreatedSchema.parse(await request({action:'createAtSelection',...input})),
  instantiateTemplate:async(input:Parameters<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>[0])=>{
   const result=projectCopyResponseSchema.parse(await request({action:'instantiateTemplate',...input}));
   if(result.requestId!==input.requestId||result.project.name!==input.name)throw new Error('Invalid template instance response');return result;
  },
  openSelectedFile:async()=>projectDesktopOpenResultSchema.parse(await request({action:'openSelectedFile'})),
  takePendingOpen:async()=>{const value=await request({action:'takePendingOpen'});return value===null?null:projectDesktopOpenResultSchema.parse(value);},
  ...(pending?{subscribePendingOpen}:{}),
  openPrivacySettings:async()=>{if(await request({action:'openPrivacySettings'})!==null)throw new Error('Invalid project entry response');},
  reveal:async(input:Parameters<ProjectEntriesDesktopBridge['reveal']>[0])=>{if(await request({action:'reveal',...input})!==null)throw new Error('Invalid project entry response');},
  openOriginal:async(input:Parameters<ProjectEntriesDesktopBridge['openOriginal']>[0])=>projectDesktopOpenResultSchema.parse(await request({action:'openOriginal',...input})),
  currentLocation:async()=>projectDesktopLocationSchema.parse(await request({action:'currentLocation'})),
  openRecent:async(input:Parameters<ProjectEntriesDesktopBridge['openRecent']>[0])=>projectDesktopRecentOpenResultSchema.parse(await request({action:'openRecent',...input})),
  adoptCopy:async(input:Parameters<ProjectEntriesDesktopBridge['adoptCopy']>[0])=>projectDesktopOpenResultSchema.parse(await request({action:'adoptCopy',...input})),
  saveAs:async(input:Parameters<ProjectEntriesDesktopBridge['saveAs']>[0])=>projectCopyResponseSchema.parse(await request({action:'saveAs',...input})),
  duplicate:async(input:Parameters<ProjectEntriesDesktopBridge['duplicate']>[0])=>projectCopyResponseSchema.parse(await request({action:'duplicate',...input})),
  copyTo:async(input:Parameters<ProjectEntriesDesktopBridge['copyTo']>[0])=>projectCopyResponseSchema.parse(await request({action:'copyTo',...input})),
 });
}

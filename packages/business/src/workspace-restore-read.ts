import {readCurrentWorkspaceRole} from './workspace-schema-dispatch.ts';
import {readTimelineVolumeEnvelopeCapability} from './timeline-volume-envelope-capability.ts';
import {assertTimelineAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {readTimelineAudioRoleCapability} from './timeline-audio-role-business.ts';
import {createMutationReplay} from './mutation-replay.ts';
import {createAssetAnnotationServices} from './asset-annotations.ts';
import {createLookPackInspectionServices,assertLookPackInspectInput} from './look-pack-inspection.ts';
import {createLutResourceServices,assertAgentTaskLutReadProfile} from './lut-resources.ts';
import {lutRestorePolicy} from '../../contracts/src/lut-resources.ts';
import {ownsStoreLock} from './db.ts';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {readOwnedTimelineAsset} from './timeline-sources.ts';
import {createWaveformHistoryReaders} from './waveforms-history.ts';
import {createImageHistoryReaders} from './images/history.ts';
import {createFrameHistoryReaders} from './frames-history.ts';
import {createSceneHistoryReaders} from './scene-history.ts';
import {AppError,parse,publicValue,TIMELINE_MUTATION_OPERATIONS,REFERENCE_MUTATION_OPERATIONS,SUBJECT_MUTATION_OPERATIONS,LOCAL_MUTATION_OPERATIONS} from '@mioon/contracts';
import {getWorkspaceRestoreContext,isRestoredRecordHeld} from './workspace-restore-schema.ts';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS,RESTORE_DENIED_OPERATIONS,refuseRestoredOperation,workspaceRestoreError} from './workspace-restore-policy.ts';
import {createLocalMutationServices} from './local-mutations.ts';
import {createReferenceServices} from './references.ts';
import {NO_MUTATION_REPLAY} from './mutation-replay.ts';
import {createInspectionServices} from './inspection.ts';
import {createProjectHomeServices} from './project-home.ts';
import {createTimelineServices} from './timeline.ts';
import {createSourceRangeServices} from './source-ranges.ts';
import {createAssetDispositionServices} from './asset-dispositions.ts';
import {createSubjectServices,createSubjectRecoveryBoundary} from './subjects.ts';
import {readTimelineReceipt,createTimelineRecoveryBoundary} from './timeline-recovery.ts';
import {readReferenceReceipt,createReferenceRecoveryBoundary} from './reference-recovery.ts';
import {readSubjectReceipt} from './subject-recovery.ts';
import {hasSubjectGeneration,validateSubjectGenerationOwnership,readGenerationLinkedJob} from './generation-inputs.ts';
import {checkpoint} from './operation-lifecycle.ts';
import {canonical,hash,now} from './services.ts';
import type {DatabaseSync} from 'node:sqlite';

type RestoreRecord = {[key: string]: unknown;id: string;projectId: string;createdAt?: string;updatedAt?: string};
type RestoreReadInput = {
 [key: string]: unknown;
 projectId: string;exportId: string;jobId: string;shotId: string;assetId: string;requestId: string;
 includeVolumeEnvelopeCapability?: boolean;includeAudioRoleCapability?: boolean;
};
interface RestoreReadStore {db: DatabaseSync;get: (table: string,id: string)=>RestoreRecord|undefined;list: (table: string,projectId?: string)=>RestoreRecord[]}
interface RestoreReadOptions {signal?: AbortSignal}
type RestoreHandler=(input: RestoreReadInput,context?: RestoreReadOptions)=>unknown;

// Only pure metadata readers are composed here. In particular this module never
// constructs image, frame, waveform, Comfy, provider, or Agent runtimes. The
// narrow constructors below define shared readers and mutation closures but do
// not execute recovery. No mutation closure is exposed by this composition.
export function createRestoredReadServices(store: RestoreReadStore,{signal}: RestoreReadOptions={}) {
 const restored=getWorkspaceRestoreContext(store);
 if(!restored)throw workspaceRestoreError();
 const {db,get,list}=store;
 const privateStorageEvidence=readCurrentWorkspaceRole(db)==='storage-private-59-evidence';
 const required=(table: string,id: string): RestoreRecord=>{const value=get(table,id);if(!value)throw new AppError('NOT_FOUND','找不到记录',404,{id});return value;};
 const denied=(): never=>{throw workspaceRestoreError();};
 const luts=createLutResourceServices(store,{signal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>assertAgentTaskLutReadProfile(restored.schemaVersion),assertImportAllowed:denied}});
 const lookPacks=createLookPackInspectionServices(store,{signal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>assertAgentTaskLutReadProfile(restored.schemaVersion)}});
 const timeline=createTimelineServices(store as never,{required,check:denied,hash,now} as never);
 const inspection=createInspectionServices(store as never);
 const projectHome=createProjectHomeServices(store as never);
 const ranges=createSourceRangeServices(store as never,{canonical,readOnly:true});
 const annotations=createAssetAnnotationServices(store as never,{mutate:createMutationReplay(store as never,{canonical,readOnly:true}),error:(...args: [string,string,number?,unknown?])=>new AppError(args[0],args[1],args[2],args[3]),restoredSchema:()=>getWorkspaceRestoreContext(store)?.schemaVersion??null});
 const dispositions=createAssetDispositionServices(store as never,{canonical,readOnly:true});
 const subjects=createSubjectServices(store as never,{canonical,now,readOnly:true});
 const references=createReferenceServices(store as never,{check:denied,hash,now});
 const locals=createLocalMutationServices(store as never,{check:denied,canonical,now,references,readOnly:true});
 const localReaders: Record<string, (input: unknown)=>unknown>={...(locals.handlers as unknown as Record<string, (input: unknown)=>unknown>),...(ranges.handlers as unknown as Record<string, (input: unknown)=>unknown>),...(dispositions.handlers as unknown as Record<string, (input: unknown)=>unknown>),...(subjects.handlers as unknown as Record<string, (input: unknown)=>unknown>)};
 const findTimeline=(projectId: string)=> {required('projects',projectId);return createTimelineRecoveryBoundary(db,{projectId,requestId:''}).read({legacyMissingProject:true,sourceSemantics:false});};
 function disclose(table: string,value: RestoreRecord,projectId?: string,exportId?: string): RestoreRecord {
  if(table==='exports')assertFloatTimelineExportRead(db,value as never,{...(exportId===undefined?{}:{rowIdentity:{id:exportId,...(projectId===undefined?{}:{projectId})}}),isTimelineRenderRecord,readOwnedAsset:(owner: string,id: string)=>readOwnedTimelineAsset(db,owner,id)} as never);
  if(table==='jobs'&&hasSubjectGeneration(value.snapshot)){
   if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','任务的项目归属已改变',409);
   validateSubjectGenerationOwnership(db,value as never);
  }else if(table==='versions'){
   const job=value.jobId?readGenerationLinkedJob(db,value.jobId as string):null;
   if(hasSubjectGeneration(value.snapshot)||hasSubjectGeneration(job?.snapshot)){
    if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','版本的项目归属已改变',409);
    if(!job||canonical(value.snapshot)!==canonical(job.snapshot))throw new AppError('INVALID_REFERENCE_MANIFEST','版本与任务的主体参考快照不一致',409);
    validateSubjectGenerationOwnership(db,job as never).version(value.id as string,value.shotId as string,value.assetId as string);
   }
  }
  return value;
 }
 // Keep the actual source row identity in this read-only restored composition.
 const exportValues=(projectId: string)=>db.prepare('SELECT id,projectId,data FROM exports WHERE projectId=?').all(projectId)
  .map(row=>disclose('exports',JSON.parse(row.data as string) as RestoreRecord,row.projectId as string,row.id as string));
 const readers: Record<string, RestoreHandler>={
  ...projectHome.handlers,
  ...luts.readers,
  ...lookPacks.readers,
  ...createWaveformHistoryReaders(store).handlers,
  ...createImageHistoryReaders(store).handlers,
  ...createFrameHistoryReaders(store).handlers,
  ...(privateStorageEvidence?{}:createSceneHistoryReaders(store).handlers),
  // Private restore59 has no editable audio capability. Omit the optional
  // disclosure rather than weakening the frozen scene59 DTO's identity rule.
  'workspace.restore.inspect':(input: RestoreReadInput)=>({restored:true,...(input.includeVolumeEnvelopeCapability?{volumeEnvelopeCapability:readTimelineVolumeEnvelopeCapability(db)}:{}),...(input.includeAudioRoleCapability&&!privateStorageEvidence?{audioRoleCapability:readTimelineAudioRoleCapability(db)}:{}),schemaVersion:restored.schemaVersion,workspaceOrigin:restored.workspaceOrigin,restorationId:restored.restorationId,
   profile:restored.profile,createdAt:restored.createdAt,
   source:{backupId:restored.sourceBackupId,schemaVersion:restored.sourceSchema,manifestHash:restored.manifestHash,dbHash:restored.sourceDbHash},
   heldCounts:Object.entries(restored.heldCounts as Record<string,unknown>).map(([kind,count])=>({kind,count})),
   operationPolicy:[...[...RESTORE_READ_OPERATIONS,...RESTORE_LOCAL_OPERATIONS].map(operation=>(privateStorageEvidence&&((RESTORE_LOCAL_OPERATIONS as readonly string[]).includes(operation)||operation.startsWith('scene.')))||operation==='timeline.clip.rippleRemove'&&![45,49,51,53,55,57,59,61].includes(restored.schemaVersion)
    ?{operation,available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}:lutRestorePolicy(operation,[53,55,57,59,61].includes(restored.schemaVersion)?51:restored.schemaVersion)),
    ...RESTORE_DENIED_OPERATIONS.map(operation=>({operation,available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}))],
   backupCreate:{available:false,reason:'RESTORE_BACKUP_UNAVAILABLE'}}),
  ...inspection.handlers,
  'project.list':()=>list('projects').sort((a,b)=>(b.updatedAt as string).localeCompare(a.updatedAt as string)),
  'project.get':(input: RestoreReadInput)=>({restore:{workspaceOrigin:restored.workspaceOrigin,heldExportIds:list('exports',input.projectId).filter(value=>isRestoredRecordHeld(store,'exports',value.id)).map(value=>value.id)},project:required('projects',input.projectId),timeline:findTimeline(input.projectId),timelineHistory:timeline.history(input.projectId),
   ...Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','exports'].map(table=>[table,(table==='exports'?exportValues(input.projectId):list(table,input.projectId).map(value=>disclose(table,value,input.projectId))).sort(table==='shots'?(a: RestoreRecord,b: RestoreRecord)=>(a.orderIndex as number)-(b.orderIndex as number):(a: RestoreRecord,b: RestoreRecord)=>(a.createdAt||'').localeCompare(b.createdAt||''))]))}),
  'asset.list':(input: RestoreReadInput)=>{required('projects',input.projectId);return list('assets',input.projectId);},
  'job.get':(input: RestoreReadInput)=>disclose('jobs',required('jobs',input.jobId)),
  'job.list':(input: RestoreReadInput)=>{required('projects',input.projectId);return list('jobs',input.projectId).map(value=>disclose('jobs',value,input.projectId));},
  'version.list':(input: RestoreReadInput)=>{const shot=required('shots',input.shotId);return list('versions',shot.projectId).filter(value=>value.shotId===shot.id).map(value=>disclose('versions',value,shot.projectId)).sort((a,b)=>(a.number as number)-(b.number as number));},
  'export.get':(input: RestoreReadInput)=>disclose('exports',required('exports',input.exportId),undefined,input.exportId),
  'timeline.get':(input: RestoreReadInput)=>findTimeline(input.projectId),
  'timeline.history.get':(input: RestoreReadInput)=>timeline.history(input.projectId),
  'timeline.format.get':(input: RestoreReadInput)=>timeline.handlers['timeline.format.get'](input as never),
  'asset.range.get':(input: RestoreReadInput)=>ranges.handlers['asset.range.get'](input as never),
  'asset.annotation.list':(input: RestoreReadInput)=>annotations.handlers['asset.annotation.list'](input as never),
  'asset.disposition.list':(input: RestoreReadInput)=>dispositions.handlers['asset.disposition.list'](input as never),
  'subject.list':(input: RestoreReadInput)=>subjects.handlers['subject.list'](input as never),
  'subject.version.list':(input: RestoreReadInput)=>subjects.handlers['subject.version.list'](input as never),
  'subject.binding.list':(input: RestoreReadInput)=>subjects.handlers['subject.binding.list'](input as never),
 };
 // These exact existing receipt readers verify original request hash and owned
 // response without entering a business mutator. Absence is never a probe by
 // attempted execution, and read replay never enqueues a captured export.
 function replay(operation: string,input: RestoreReadInput) {
  if(operation==='asset.annotation.set')throw workspaceRestoreError();
  if((TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation)){
   const saved=readTimelineReceipt(db,input as never,operation);
   if(!saved)return null;
   if(saved.requestHash!==hash({operation,input}))throw new AppError('IDEMPOTENCY_CONFLICT','同一时间线请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:createTimelineRecoveryBoundary(db,input).replay(operation,saved.response as string)};
  }
  if((REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(operation)){
   const saved=readReferenceReceipt(db,input);
   if(!saved)return null;
   if(saved.requestHash!==hash({operation,input}))throw new AppError('IDEMPOTENCY_CONFLICT','同一参考连线请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:createReferenceRecoveryBoundary(db,input).replay(operation,saved.response as string)};
  }
  if((LOCAL_MUTATION_OPERATIONS as readonly string[]).includes(operation)){
   const response=localReaders[operation](input);
   return response===NO_MUTATION_REPLAY?null:{response};
  }
  if((SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(operation)){
   const boundary=createSubjectRecoveryBoundary(db,input);boundary.context(operation);
   const saved=readSubjectReceipt(db,input,operation);
   return saved?{response:boundary.replay(operation,saved.response as string)}:null;
  }
  if(operation==='export.create'){
   const saved=db.prepare("SELECT requestHash,resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(input.requestId);
   if(!saved)return null;
   const row=db.prepare('SELECT projectId FROM exports WHERE id=?').get(saved.resourceId as string);
   if(!row||row.projectId!==input.projectId)throw workspaceRestoreError();
   if(saved.requestHash!==hash(input))throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:required('exports',saved.resourceId as string)};
  }
  return null;
 }
 const handlers: Readonly<Record<string, RestoreHandler>>=Object.freeze(Object.fromEntries([...RESTORE_READ_OPERATIONS,...RESTORE_LOCAL_OPERATIONS,...RESTORE_DENIED_OPERATIONS].map((operation): [string, RestoreHandler]=>[operation,(input: RestoreReadInput,context: RestoreReadOptions={})=>{
  checkpoint(signal);getWorkspaceRestoreContext(store);
  if(operation==='lut.look.inspect')assertLookPackInspectInput(input);
  const parsed=(parse as (op: string,input: unknown)=>Record<string,unknown>)(operation,input);
  assertTimelineAudioRoleWorkspace(db,parsed);
  if(Object.hasOwn(readers,operation))return readers[operation](parsed as RestoreReadInput,context);
  const saved=replay(operation,parsed as RestoreReadInput);if(saved)return saved.response;
  refuseRestoredOperation(store,operation,parsed);
 }])));
 async function call(operation: string,input: RestoreReadInput,context: RestoreReadOptions={}): Promise<unknown> {
  checkpoint(signal);checkpoint(context?.signal);
  if(!Object.hasOwn(handlers,operation)){(parse as (op: string,input: unknown)=>unknown)(operation,input);throw workspaceRestoreError();}
  const result=await handlers[operation](input,context);
  checkpoint(signal);checkpoint(context?.signal);
  return publicValue(result);
 }
 return Object.freeze({call,handlers,readers,replay,drain:async()=>{},inspection,publicValue,required,
  check:denied,event:denied,saveJob:denied,createJob:denied,saveGenerationGuarded:denied,validateGenerationDispatch:denied,
  updateShotInProject:denied,moveTimelineClipInProject:denied,imageApproval:denied,imageRejection:denied});
}

import {readTimelineVolumeEnvelopeCapability} from './timeline-volume-envelope-capability.ts';
import {assertTimelineAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {readTimelineAudioRoleCapability} from './timeline-audio-role-business.ts';
import {createMutationReplay} from './mutation-replay.ts';
import {createAssetAnnotationServices} from './asset-annotations.ts';
import {createLookPackInspectionServices,assertLookPackInspectInput} from './look-pack-inspection.ts';
import {createLutResourceServices,assertLutReadProfile} from './lut-resources.ts';
import {lutRestorePolicy} from '../../contracts/src/lut-resources.ts';
import {ownsStoreLock} from './db.ts';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {readOwnedTimelineAsset} from './timeline-sources.ts';
import {createWaveformHistoryReaders} from './waveforms-history.ts';
import {createImageHistoryReaders} from './images/history.ts';
import {createFrameHistoryReaders} from './frames-history.ts';
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

// Only pure metadata readers are composed here. In particular this module never
// constructs image, frame, waveform, Comfy, provider, or Agent runtimes. The
// narrow constructors below define shared readers and mutation closures but do
// not execute recovery. No mutation closure is exposed by this composition.
export function createRestoredReadServices(store,{signal}={}) {
 const restored=getWorkspaceRestoreContext(store);
 if(!restored)throw workspaceRestoreError();
 const {db,get,list}=store;
 const required=(table,id)=>{const value=get(table,id);if(!value)throw new AppError('NOT_FOUND','找不到记录',404,{id});return value;};
 const denied=()=>{throw workspaceRestoreError();};
 const luts=createLutResourceServices(store,{signal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>assertLutReadProfile(restored.schemaVersion),assertImportAllowed:denied}});
 const lookPacks=createLookPackInspectionServices(store,{signal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>assertLutReadProfile(restored.schemaVersion)}});
 const timeline=createTimelineServices(store,{required,check:denied,hash,now});
 const inspection=createInspectionServices(store);
 const projectHome=createProjectHomeServices(store);
 const ranges=createSourceRangeServices(store,{canonical,readOnly:true});
 const annotations=createAssetAnnotationServices(store,{mutate:createMutationReplay(store,{canonical,readOnly:true}),error:(...args)=>new AppError(...args),restoredSchema:()=>getWorkspaceRestoreContext(store)?.schemaVersion??null});
 const dispositions=createAssetDispositionServices(store,{canonical,readOnly:true});
 const subjects=createSubjectServices(store,{canonical,now,readOnly:true});
 const references=createReferenceServices(store,{check:denied,hash,now});
 const locals=createLocalMutationServices(store,{check:denied,canonical,now,references,readOnly:true});
 const localReaders={...locals.handlers,...ranges.handlers,...dispositions.handlers,...subjects.handlers};
 const findTimeline=projectId=>{required('projects',projectId);return createTimelineRecoveryBoundary(db,{projectId}).read({legacyMissingProject:true,sourceSemantics:false});};
 function disclose(table,value,projectId,exportId) {
  if(table==='exports')assertFloatTimelineExportRead(db,value,{...(exportId===undefined?{}:{rowIdentity:{id:exportId,...(projectId===undefined?{}:{projectId})}}),isTimelineRenderRecord,readOwnedAsset:(owner,id)=>readOwnedTimelineAsset(db,owner,id)});
  if(table==='jobs'&&hasSubjectGeneration(value.snapshot)){
   if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','任务的项目归属已改变',409);
   validateSubjectGenerationOwnership(db,value);
  }else if(table==='versions'){
   const job=value.jobId?readGenerationLinkedJob(db,value.jobId):null;
   if(hasSubjectGeneration(value.snapshot)||hasSubjectGeneration(job?.snapshot)){
    if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','版本的项目归属已改变',409);
    if(!job||canonical(value.snapshot)!==canonical(job.snapshot))throw new AppError('INVALID_REFERENCE_MANIFEST','版本与任务的主体参考快照不一致',409);
    validateSubjectGenerationOwnership(db,job).version(value.id,value.shotId,value.assetId);
   }
  }
  return value;
 }
 // Keep the actual source row identity in this read-only restored composition.
 const exportValues=projectId=>db.prepare('SELECT id,projectId,data FROM exports WHERE projectId=?').all(projectId)
  .map(row=>disclose('exports',JSON.parse(row.data),row.projectId,row.id));
 const readers={
  ...projectHome.handlers,
  ...luts.readers,
  ...lookPacks.readers,
  ...createWaveformHistoryReaders(store).handlers,
  ...createImageHistoryReaders(store).handlers,
  ...createFrameHistoryReaders(store).handlers,
  'workspace.restore.inspect':input=>({restored:true,...(input.includeVolumeEnvelopeCapability?{volumeEnvelopeCapability:readTimelineVolumeEnvelopeCapability(db)}:{}),...(input.includeAudioRoleCapability?{audioRoleCapability:readTimelineAudioRoleCapability(db)}:{}),schemaVersion:restored.schemaVersion,workspaceOrigin:restored.workspaceOrigin,restorationId:restored.restorationId,
   profile:restored.profile,createdAt:restored.createdAt,
   source:{backupId:restored.sourceBackupId,schemaVersion:restored.sourceSchema,manifestHash:restored.manifestHash,dbHash:restored.sourceDbHash},
   heldCounts:Object.entries(restored.heldCounts).map(([kind,count])=>({kind,count})),
   operationPolicy:[...[...RESTORE_READ_OPERATIONS,...RESTORE_LOCAL_OPERATIONS].map(operation=>operation==='timeline.clip.rippleRemove'&&![45,49].includes(restored.schemaVersion)
    ?{operation,available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}:lutRestorePolicy(operation,restored.schemaVersion)),
    ...RESTORE_DENIED_OPERATIONS.map(operation=>({operation,available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}))],
   backupCreate:{available:false,reason:'RESTORE_BACKUP_UNAVAILABLE'}}),
  ...inspection.handlers,
  'project.list':()=>list('projects').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
  'project.get':input=>({restore:{workspaceOrigin:restored.workspaceOrigin,heldExportIds:list('exports',input.projectId).filter(value=>isRestoredRecordHeld(store,'exports',value.id)).map(value=>value.id)},project:required('projects',input.projectId),timeline:findTimeline(input.projectId),timelineHistory:timeline.history(input.projectId),
   ...Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','exports'].map(table=>[table,(table==='exports'?exportValues(input.projectId):list(table,input.projectId).map(value=>disclose(table,value,input.projectId))).sort(table==='shots'?(a,b)=>a.orderIndex-b.orderIndex:(a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''))]))}),
  'asset.list':input=>{required('projects',input.projectId);return list('assets',input.projectId);},
  'job.get':input=>disclose('jobs',required('jobs',input.jobId)),
  'job.list':input=>{required('projects',input.projectId);return list('jobs',input.projectId).map(value=>disclose('jobs',value,input.projectId));},
  'version.list':input=>{const shot=required('shots',input.shotId);return list('versions',shot.projectId).filter(value=>value.shotId===shot.id).map(value=>disclose('versions',value,shot.projectId)).sort((a,b)=>a.number-b.number);},
  'export.get':input=>disclose('exports',required('exports',input.exportId),undefined,input.exportId),
  'timeline.get':input=>findTimeline(input.projectId),
  'timeline.history.get':input=>timeline.history(input.projectId),
  'timeline.format.get':timeline.handlers['timeline.format.get'],
  'asset.range.get':ranges.handlers['asset.range.get'],
  'asset.annotation.list':annotations.handlers['asset.annotation.list'],
  'asset.disposition.list':dispositions.handlers['asset.disposition.list'],
  'subject.list':subjects.handlers['subject.list'],
  'subject.version.list':subjects.handlers['subject.version.list'],
  'subject.binding.list':subjects.handlers['subject.binding.list'],
 };
 // These exact existing receipt readers verify original request hash and owned
 // response without entering a business mutator. Absence is never a probe by
 // attempted execution, and read replay never enqueues a captured export.
 function replay(operation,input) {
  if(operation==='asset.annotation.set')throw workspaceRestoreError();
  if(TIMELINE_MUTATION_OPERATIONS.includes(operation)){
   const saved=readTimelineReceipt(db,input,operation);
   if(!saved)return null;
   if(saved.requestHash!==hash({operation,input}))throw new AppError('IDEMPOTENCY_CONFLICT','同一时间线请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:createTimelineRecoveryBoundary(db,input).replay(operation,saved.response)};
  }
  if(REFERENCE_MUTATION_OPERATIONS.includes(operation)){
   const saved=readReferenceReceipt(db,input);
   if(!saved)return null;
   if(saved.requestHash!==hash({operation,input}))throw new AppError('IDEMPOTENCY_CONFLICT','同一参考连线请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:createReferenceRecoveryBoundary(db,input).replay(operation,saved.response)};
  }
  if(LOCAL_MUTATION_OPERATIONS.includes(operation)){
   const response=localReaders[operation](input);
   return response===NO_MUTATION_REPLAY?null:{response};
  }
  if(SUBJECT_MUTATION_OPERATIONS.includes(operation)){
   const boundary=createSubjectRecoveryBoundary(db,input);boundary.context(operation);
   const saved=readSubjectReceipt(db,input,operation);
   return saved?{response:boundary.replay(operation,saved.response)}:null;
  }
  if(operation==='export.create'){
   const saved=db.prepare("SELECT requestHash,resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(input.requestId);
   if(!saved)return null;
   const row=db.prepare('SELECT projectId FROM exports WHERE id=?').get(saved.resourceId);
   if(!row||row.projectId!==input.projectId)throw workspaceRestoreError();
   if(saved.requestHash!==hash(input))throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同内容',409,{requestId:input.requestId});
   return {response:required('exports',saved.resourceId)};
  }
  return null;
 }
 const handlers=Object.freeze(Object.fromEntries([...RESTORE_READ_OPERATIONS,...RESTORE_LOCAL_OPERATIONS,...RESTORE_DENIED_OPERATIONS].map(operation=>[operation,(input,context={})=>{
  checkpoint(signal);getWorkspaceRestoreContext(store);
  if(operation==='lut.look.inspect')assertLookPackInspectInput(input);
  const parsed=parse(operation,input);
  assertTimelineAudioRoleWorkspace(db,parsed);
  if(Object.hasOwn(readers,operation))return readers[operation](parsed,context);
  const saved=replay(operation,parsed);if(saved)return saved.response;
  refuseRestoredOperation(store,operation,parsed);
 }])));
 async function call(operation,input,context={}) {
  checkpoint(signal);checkpoint(context?.signal);
  if(!Object.hasOwn(handlers,operation)){parse(operation,input);throw workspaceRestoreError();}
  const result=await handlers[operation](input,context);
  checkpoint(signal);checkpoint(context?.signal);
  return publicValue(result);
 }
 return Object.freeze({call,handlers,readers,replay,drain:async()=>{},inspection,publicValue,required,
  check:denied,event:denied,saveJob:denied,createJob:denied,saveGenerationGuarded:denied,validateGenerationDispatch:denied,
  updateShotInProject:denied,moveTimelineClipInProject:denied,imageApproval:denied,imageRejection:denied});
}

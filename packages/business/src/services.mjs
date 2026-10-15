import {createMutationReplay} from './mutation-replay.mjs';
import {nullableTimelineClipColourSchema,timelineImageClipColourSchema} from '../../contracts/src/timeline-colour.ts';
import {createTimelineImageSourceServices} from './timeline-image-source.ts';
import {createLookPackInspectionServices,assertLookPackInspectInput} from './look-pack-inspection.ts';
import {createLutResourceServices} from './lut-resources.ts';
import {createTimelineColourSourceServices,createTimelineColourSourceProbe} from './timeline-colour-source.ts';
import {createTimelineLoudnessApplyServices} from './timeline-loudness-apply.ts';
import {createTimelineAudioPreviewServices} from './timeline-audio-preview.ts';
import {createTimelineAudioPreviewDecoder} from './timeline-audio-preview-decoder.ts';
import {createTimelineAudioContinuousServices} from './timeline-audio-continuous.ts';
import {createTimelineAudioContinuousDecoder} from './timeline-audio-continuous-decoder.ts';
import {createTimelineAudioPreviewCoordinator,createSavedTimelineAudioReader} from './timeline-audio-preview-coordinator.ts';
import {validateTimeline} from './timeline-inputs.mjs';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {lstatSync} from 'node:fs';
import {bindRestoredExport} from './workspace-restore-exports.mjs';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS,assertWorkspaceRestoreOrigin,refuseRestoredOperation,safeWorkspaceRestoreError,workspaceRestoreError} from './workspace-restore-policy.mjs';
import {withRestoreInvocation,freezeRestoreInput,hasRestoreInvocation,restoreEffectFence} from './workspace-restore-invocation.mjs';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.mjs';
import {createRestoredReadServices} from './workspace-restore-read.mjs';
import {inspectWorkspaceBackup} from './backup-readiness.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,rename,unlink,open,lstat} from 'node:fs/promises';
import path from 'node:path';
import {parse,AppError,publicValue,getGenerationIssue,getSubjectGenerationSnapshotIssue} from '@mioon/contracts';
import {normalizedCapabilities,generationLimit,providerSettings,usesInputProfiles} from './provider-registry.mjs';
import {prepareGenerationInputs,generationReferenceSelection,readGenerationAsset,assertGenerationReferenceIds,assertGenerationShotOwnership,assertGenerationJobOwnership,currentGenerationClaim,hasSubjectGeneration,validateSubjectGenerationOwnership,assertSubjectGenerationSelection,assertSubjectGenerationRequestVacant,readGenerationLinkedJob} from './generation-inputs.mjs';
import {fileInfo,safePath} from './media.mjs';
import {createTimelineServices} from './timeline.mjs';
import {createTimelineExportAdmissionServices} from './timeline-export-admission.mjs';
import {createTimelinePreflightServices} from './timeline-preflight.mjs';
import {createExportSamplePeakServices} from './export-sample-peak.ts';
import {createExportSamplePeakDecoder} from './export-sample-peak-decoder.ts';
import {createExportLoudnessServices} from './export-loudness.ts';
import {createExportLoudnessDecoder} from './export-loudness-decoder.ts';
import {createTimelineMixLoudnessServices} from './timeline-mix-loudness.ts';
import {createTimelineMixLoudnessDecoder} from './timeline-mix-loudness-decoder.ts';
import {ownsStoreLock} from './db.mjs';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {readOwnedTimelineAsset,readTimelinePreflightSnapshot,readTimelineSourceGraph} from './timeline-sources.mjs';
import {validateManagedSource,verifiedManagedHash} from './managed-media.mjs';
import {run,runStreaming,runStreamingWithBackpressure,checkMediaEffect} from './media-runtime.mjs';
import {withProbePermit} from './media-probe.mjs';
import {terminateMediaProcesses,waitForMediaProcesses} from './media-processes.mjs';
import {createReferenceServices} from './references.mjs';
import {createInspectionServices,createOwnedMediaGraphReader} from './inspection.mjs';
import {createLocalMutationServices} from './local-mutations.mjs';
import {createSourceRangeServices} from './source-ranges.mjs';
import {createSubjectServices} from './subjects.mjs';
import {createAssetAnnotationServices} from './asset-annotations.ts';
import {createAssetDispositionServices} from './asset-dispositions.mjs';
import {createWaveformServices} from './waveforms.mjs';
import {createImageServices} from './images.mjs';
import {createFrameServices} from './frames.mjs';
import {validateImageConsumption} from './image-consumption.mjs';
import {awaitProvider,boundedShutdown,checkpoint} from './operation-lifecycle.mjs';
export const now=()=>new Date().toISOString();
export function canonical(v){return JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);}
export const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function createServices(store,providers,{env=process.env,signal:ownerSignal,profileNow=Date.now,imageOptions,frameOptions,exportOptions}={}){
 const restored=getWorkspaceRestoreContext(store);
 const restoredReads=restored?createRestoredReadServices(store,{signal:ownerSignal}):null;
 const disabled=()=>{throw workspaceRestoreError();};
 const inactive=()=>({handlers:{},drain:async()=>{},approveReviewed:disabled,rejectReview:disabled});
 const active=new Set(),restoredLifetime=restored?new AbortController():null;let shutdownFailure;
 const {db,root,get,list,put,tx}=store;
 const luts=restored?inactive():createLutResourceServices(store,{signal:ownerSignal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>{},assertImportAllowed:()=>{if(getWorkspaceRestoreContext(store))disabled();}}});
 const lookPacks=restored?inactive():createLookPackInspectionServices(store,{signal:ownerSignal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>{}}});
 const required=(t,id)=>{const v=get(t,id);if(!v)throw new AppError('NOT_FOUND','找不到记录',404,{id});return v;};
 const check=(v,rev)=>{if(v.revision!==rev)throw new AppError('REVISION_CONFLICT','内容已有新版本，请重新读取后再修改',409,{entityId:v.id,expectedRevision:rev,currentRevision:v.revision,current:publicValue(v)});};
 const dedupe=(scope,requestId,requestHash,table)=>{const r=db.prepare(scope==='generation'?`SELECT CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash,CASE WHEN typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS resourceId FROM idempotency WHERE scope=? AND requestId=?`:'SELECT * FROM idempotency WHERE scope=? AND requestId=?').get(scope,requestId);if(!r)return null;if(r.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同内容',409,{requestId});return required(table,r.resourceId);};
 const idem=(scope,key,h,id)=>db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,h,id);
 const event=(job,event)=>{if(restored)disabled();return db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(job.id,JSON.stringify(event),now());};
 const saveJob=(job,patch)=>{if(restored)disabled();const current=required('jobs',job.id);if((current.revision||0)!==(job.revision||0))return current;const result={...current,...patch,revision:(current.revision||0)+1,updatedAt:now()};put('jobs',result);event(result,{status:result.status,phase:result.phase,error:result.error});return result;};
 const profilePolicy=restored?false:usesInputProfiles(providers),currentProfileDate=()=>new Date(profileNow()).toISOString().slice(0,10);
 const capabilitiesFor=(provider,asOf=currentProfileDate())=>normalizedCapabilities(provider,env,list('jobs').filter(j=>j.providerId===provider.id).length,{asOf,requireInputProfiles:profilePolicy||usesInputProfiles(provider)});
 const validateProvider=(source,providerId,requestedModel,parameters,projectId,frozen=false,subjectGraph=null)=>{
  const p=providers.get(providerId);if(!p)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
  const c=capabilitiesFor(p),first=c.models[0],model=requestedModel||(typeof first==='string'?first:first.id);
  const profiled=profilePolicy||usesInputProfiles(p);
  if(hasSubjectGeneration(source)&&!profiled)throw new AppError('INPUT_PROFILE_UNAVAILABLE','主体参考需要服务器已注册的精确输入规范',400);
  const selection=generationReferenceSelection(source,{frozen});
  const assets=selection.ids.map((id,index)=>{
   const asset=subjectGraph?subjectGraph.asset(id):profiled?readGenerationAsset(db,id,projectId):validateImageConsumption(db,required('assets',id),projectId);
   const role=frozen?source.referenceBindings?.[index]?.role:selection.references[index]?.role;
   return (selection.ids.length===2||role==='subject_reference')&&role&&!Object.hasOwn(asset,'role')?{...asset,role}:asset;
  });
  if(hasSubjectGeneration(source)&&!['ark','mock'].includes(providerId))throw new AppError('UNSUPPORTED_INPUT_ROLE','此供应商尚未实现主体参考视频输入',400,{providerId,model});
  const hasLastFrame=(frozen?source.referenceBindings:selection.references)?.some(reference=>reference?.role==='last_frame')||source.lastFrameAssetId!=null;
  if(hasLastFrame&&!['ark','mock'].includes(providerId))throw new AppError('UNSUPPORTED_INPUT_ROLE','此供应商尚未实现首尾帧输入；不会忽略尾帧',400,{providerId,model});
  // Config checks never reveal credentials. Raw adapter enabled remains distinct from
  // the exhausted/missing local generation limit exposed in the capability status.
  if(!p.capabilities.enabled||!p.capabilities.configured)throw new AppError('PROVIDER_DISABLED','真实供应商尚未安全配置并授权；当前可使用模拟供应商',403,{providerId,status:c.status,configuration:c.configuration});
  if(providerSettings[providerId]){
   const max=generationLimit(providerId,env),used=list('jobs').filter(j=>j.providerId===providerId).length;
   if(!max||used>=max)throw new AppError('LIVE_BUDGET_REQUIRED','需要后端设置已授权生成次数上限，或当前额度已耗尽',403,{providerId,budget:c.budget});
  }
  if(source.capabilities?.region&&c.region!==source.capabilities.region)throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);
  const subjectMode=hasSubjectGeneration(source);
  let prepared=subjectMode?prepareGenerationInputs({source:{...source,parameters},projectId,providerId,model,capabilities:c,readAsset:id=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,projectId),asOf:c.profileEvaluationDate,frozen}):null;
  const snapshot={...source,model,referenceAssetIds:selection.ids,referenceAssets:frozen?source.referenceAssets:assets,parameters,...(subjectMode?{providerId,...prepared.fields}:{})};
  const {inputProfiles:ignoredProfiles,...legacyCapabilities}=c;
  const issue=getGenerationIssue(snapshot,legacyCapabilities);if(issue)throw new AppError(issue.code,issue.message,400,{providerId,model});
  if(p.validate){try{p.validate(snapshot);}catch(error){throw new AppError(error.code||'UNSUPPORTED_PARAMETERS',error.message||'此供应商不支持所选参数',400,{providerId,model});}}
  prepared??=profiled?prepareGenerationInputs({source:{...source,parameters},projectId,providerId,model,capabilities:c,readAsset:id=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,projectId),asOf:c.profileEvaluationDate,frozen}):null;
  return {p,model,assets:prepared?.assets||assets,referenceAssetIds:selection.ids,capabilities:c,inputFields:prepared?.fields};
 };
 function replaySubjectJob(job,input,retryOfJobId=null){
  if(job.requestId!==input.requestId||job.requestHash!==hash(input)||job.shotId!==input.shotId||job.providerId!==input.providerId||input.model!==undefined&&job.model!==input.model||job.retryOfJobId!==retryOfJobId||job.snapshot?.shotRevision!==input.expectedRevision||job.snapshot?.subjectReference?.subjectVersionId!==input.subjectVersionId)throw new AppError('INVALID_REFERENCE_MANIFEST','任务身份与原始主体参考请求不一致',409);
  validateSubjectGenerationOwnership(db,job);
  return job;
 }
 const createJob=(input,retrySnapshot=null,retryOfJobId=null)=>tx(()=>{
  if(restored)disabled();
  const requestHash=hash(input),prior=dedupe('generation',input.requestId,requestHash,'jobs');
  if(prior)return input.subjectVersionId!==undefined||hasSubjectGeneration(prior.snapshot)?replaySubjectJob(prior,input,retryOfJobId):prior;
  assertSubjectGenerationRequestVacant(db,input);
  const shot=required('shots',input.shotId);if(!retrySnapshot)check(shot,input.expectedRevision);
  if(profilePolicy||usesInputProfiles(providers.get(input.providerId))||input.subjectVersionId!==undefined)assertGenerationShotOwnership(db,shot);
  let source=retrySnapshot||shot,subjectGraph=null;
  const subjectMode=input.subjectVersionId!==undefined||hasSubjectGeneration(source);
  let referenceConnections;
  if(subjectMode){
   subjectGraph=createOwnedMediaGraphReader(db,shot.projectId);
   if(retrySnapshot){
    const issue=getSubjectGenerationSnapshotIssue(retrySnapshot,{projectId:shot.projectId,requireProfilePin:true});if(issue)throw new AppError(issue.code,issue.message,400);
    subjectGraph.validateSubjectReference(retrySnapshot.subjectReference);
    if(input.subjectVersionId!==retrySnapshot.subjectReference.subjectVersionId)throw new AppError('INVALID_REFERENCE_MANIFEST','重试必须保留原始主体版本',409);
    referenceConnections=retrySnapshot.referenceConnections;
   }else{
    assertSubjectGenerationSelection(db,shot);
    const subjectReference=subjectGraph.subjectReference(input.subjectVersionId),version=subjectReference.subjectVersion;
    referenceConnections=[];
    source={...shot,subjectReference,referenceAssetIds:[version.assetId],referenceConnections,referenceBindings:[{role:'subject_reference',assetId:version.assetId,sha256:version.sha256}]};
   }
  }else referenceConnections=retrySnapshot?.referenceConnections||(!retrySnapshot?references.snapshot(shot):[]);
  const parameters=retrySnapshot?.parameters||{...shot.parameters,...input.parameters};
  const {model,assets,referenceAssetIds,capabilities,inputFields}=validateProvider({...source,referenceConnections},input.providerId,input.model,parameters,shot.projectId,Boolean(retrySnapshot),subjectGraph);
  const snapshot=retrySnapshot||{shotId:shot.id,shotRevision:shot.revision,title:shot.title,prompt:shot.prompt,referenceAssetIds:[...referenceAssetIds],...(shot.lastFrameAssetId!=null?{lastFrameAssetId:shot.lastFrameAssetId}:{}),referenceAssets:assets.map(a=>({id:a.id,relativePath:a.relativePath,mimeType:a.mimeType,sha256:a.sha256,width:a.width,height:a.height,...(Object.hasOwn(a,'role')?{role:a.role}:{}),...(inputFields?{sizeBytes:a.sizeBytes}:{})})),referenceConnections,aspectRatio:shot.aspectRatio,duration:shot.duration,providerId:input.providerId,model,parameters,capabilities,...(inputFields||{}),...(subjectMode?{subjectReference:source.subjectReference}:{})};
  const job={id:randomUUID(),projectId:shot.projectId,shotId:shot.id,requestId:input.requestId,requestHash,providerId:input.providerId,model,revision:1,status:'queued',phase:'waiting',progress:0,snapshot,providerJobId:null,submissionCount:0,error:null,createdAt:now(),updatedAt:now(),versionId:null,cancelScope:null,retryOfJobId};
  put('jobs',job);idem('generation',input.requestId,requestHash,job.id);event(job,{status:'queued'});
  if(subjectMode)replaySubjectJob(job,input,retryOfJobId);
  return job;
 });
 const exportAdmission=createTimelineExportAdmissionServices(store,{...exportOptions,signal:ownerSignal,hash});
 const timeline=createTimelineServices(store,{required,check,hash,now,exportAdmission});
 const preflight=createTimelinePreflightServices(store,{signal:ownerSignal});
 const samplePeak=restored?{...inactive(),handlers:{'timeline.export.samplePeak':disabled}}:createExportSamplePeakServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},
  ownsLock:()=>ownsStoreLock(store),isTimelineRenderRecord,
  readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createExportSamplePeakDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:signal=>terminateMediaProcesses({signal}),waitForClose:signal=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const loudness=restored?{...inactive(),handlers:{'timeline.export.loudness':disabled}}:createExportLoudnessServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},
  ownsLock:()=>ownsStoreLock(store),isTimelineRenderRecord,
  readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createExportLoudnessDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:signal=>terminateMediaProcesses({signal}),waitForClose:signal=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const mixLoudness=restored?{...inactive(),handlers:{'timeline.loudness.prepare':disabled}}:createTimelineMixLoudnessServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline:projectId=>{
   const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
   try{const {timeline}=readTimelinePreflightSnapshot(store,projectId);if(!timeline)return null;
    const assets=readTimelineSourceGraph(db,projectId,timeline);validateTimeline(timeline,assets,{structureOnly:true});
    return {timeline,assets:[...assets.values()]};
   }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
  },
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createTimelineMixLoudnessDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:signal=>terminateMediaProcesses({signal}),waitForClose:signal=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const assertLoudnessApplyAvailable=()=>{if(restored)throw workspaceRestoreError();checkpoint(ownerSignal);if(!ownsStoreLock(store))throw new AppError('EDIT_TASK_OWNER_REQUIRED','只有持有工作区锁的后端可以应用增益',403);};
 const loudnessApply=restored?{handlers:{'timeline.loudness.apply':disabled}}:createTimelineLoudnessApplyServices({
  measurement:mixLoudness,transactions:timeline.createLoudnessApplyTransactions(assertLoudnessApplyAvailable),assertAvailable:assertLoudnessApplyAvailable,
 });
 const readSavedAudioTimeline=createSavedTimelineAudioReader({db,
  readTimeline:projectId=>readTimelinePreflightSnapshot(store,projectId).timeline,
  readAssets:(projectId,timeline)=>readTimelineSourceGraph(db,projectId,timeline),
  validate:(timeline,assets)=>validateTimeline(timeline,assets,{structureOnly:true}),
 });
 const audioPreviewV1=restored?{...inactive(),handlers:{'timeline.audioPreview.plan':disabled},consumeSource:disabled}:createTimelineAudioPreviewServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline:readSavedAudioTimeline,
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createTimelineAudioPreviewDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:signal=>terminateMediaProcesses({signal}),waitForClose:signal=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const continuousAudio=restored?{...inactive(),handlers:{'timeline.audioPreview.continuousPlan':disabled},consumeBlock:disabled,retireSession:disabled,retireSessionById:disabled,assertNoContinuousSession:disabled}:createTimelineAudioContinuousServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline:readSavedAudioTimeline,validateSource:validateManagedSource,hash:verifiedManagedHash,
  decoder:createTimelineAudioContinuousDecoder({run,runStreamingWithBackpressure,withProbePermit,checkMediaEffect}),boundedShutdown,
 }});
 const audioPreview=createTimelineAudioPreviewCoordinator(audioPreviewV1,continuousAudio,AppError);
 const imageColourSource=restored?{...inactive(),handlers:{'timeline.colour.image.inspect':disabled,'timeline.colour.jpeg.inspect':disabled}}:createTimelineImageSourceServices(store,{signal:ownerSignal,runtime:{validateSource:validateManagedSource,runStreaming,waitForMediaProcesses,
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},ownsLock:()=>ownsStoreLock(store),
  readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(db,projectId,assetId),
 }});
 const colourSource=restored?{...inactive(),handlers:{'timeline.colour.source.inspect':disabled}}:createTimelineColourSourceServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:()=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();},ownsLock:()=>ownsStoreLock(store),
  readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  probe:createTimelineColourSourceProbe({run,withProbePermit,checkMediaEffect}),
  terminate:signal=>terminateMediaProcesses({signal}),waitForClose:signal=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const references=createReferenceServices(store,{required,check,hash,now});
 const inspection=createInspectionServices(store);
 const localMutations=createLocalMutationServices(store,{check,canonical,now,references});
 const sourceRanges=createSourceRangeServices(store,{canonical});
 const assetAnnotations=createAssetAnnotationServices(store,{mutate:createMutationReplay(store,{canonical}),error:(...args)=>new AppError(...args),restoredSchema:()=>getWorkspaceRestoreContext(store)?.schemaVersion??null});
 const assetDispositions=createAssetDispositionServices(store,{canonical});
 const subjects=createSubjectServices(store,{canonical,now});
 const waveforms=restored?inactive():createWaveformServices(store,{signal:ownerSignal});
 const images=restored?inactive():createImageServices(store,{...imageOptions,signal:ownerSignal});
 const frames=restored?inactive():createFrameServices(store,{...frameOptions,signal:ownerSignal});
 // Read disclosure verifies only retained subject ownership/provenance. It
 // never evaluates current provider lifecycle, quota, enabled state or POST policy.
 function subjectDisclosure(table,value,projectId,exportId){
  if(table==='exports')assertFloatTimelineExportRead(db,value,{...(exportId===undefined?{}:{rowIdentity:{id:exportId,...(projectId===undefined?{}:{projectId})}}),isTimelineRenderRecord,readOwnedAsset:(owner,id)=>readOwnedTimelineAsset(db,owner,id)});
  if(table==='jobs'&&hasSubjectGeneration(value.snapshot)){
   if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','任务的项目归属已改变',409);
   validateSubjectGenerationOwnership(db,value);
  }else if(table==='versions'){
   const job=value.jobId?readGenerationLinkedJob(db,value.jobId):null;
   if(hasSubjectGeneration(value.snapshot)||hasSubjectGeneration(job?.snapshot)){
    if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','版本的项目归属已改变',409);
    if(!job||canonical(value.snapshot)!==canonical(job.snapshot))throw new AppError('INVALID_REFERENCE_MANIFEST','版本与任务的主体参考快照不一致',409);
    const graph=validateSubjectGenerationOwnership(db,job);
    graph.version(value.id,value.shotId,value.assetId);
   }
  }
  return value;
 }
 // Retain the source row identity when disclosing exports; a decoded body
 // must not borrow another export's valid request receipt. No write/normalization.
 const exportValues=projectId=>db.prepare('SELECT id,projectId,data FROM exports WHERE projectId=?').all(projectId)
  .map(row=>subjectDisclosure('exports',JSON.parse(row.data),row.projectId,row.id));
 const handlers={
 ...luts.handlers,
 ...lookPacks.handlers,
 'workspace.backup.inspect':()=>inspectWorkspaceBackup(store),
 'workspace.restore.inspect':()=>({restored:false}),
 ...frames.handlers,
 ...images.handlers,
 ...preflight.handlers,
 ...samplePeak.handlers,
 ...loudness.handlers,
 ...mixLoudness.handlers,
 ...loudnessApply.handlers,
 ...audioPreview.handlers,
 ...colourSource.handlers,
 ...imageColourSource.handlers,
 ...exportAdmission.handlers,
 ...waveforms.handlers,
 ...sourceRanges.handlers,
 ...assetDispositions.handlers,
 ...assetAnnotations.handlers,
 ...subjects.handlers,
 ...inspection.handlers,
 ...timeline.handlers,
 ...references.handlers,
 ...localMutations.handlers,
 'project.create':i=>put('projects',{id:randomUUID(),name:i.name,description:i.description||'',revision:1,createdAt:now(),updatedAt:now()}),
 'project.list':()=>list('projects').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
 'project.get':i=>tx(()=>{const project=required('projects',i.projectId);return {project,timeline:timeline.ensure(i.projectId),timelineHistory:timeline.history(i.projectId),...Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','exports'].map(t=>[t,(t==='exports'?exportValues(i.projectId):list(t,i.projectId).map(value=>subjectDisclosure(t,value,i.projectId))).sort(t==='shots'?(a,b)=>a.orderIndex-b.orderIndex:(a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''))]))};}),
 'asset.import':async (i,{signal=ownerSignal}={})=>{
  const invocationFence=restoreEffectFence(store);
  checkpoint(signal);invocationFence?.();
  const importProject=required('projects',i.projectId);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(i.dataBase64)||i.dataBase64.length%4)throw new AppError('INVALID_MEDIA','无效的 base64');
  const bytes=Buffer.from(i.dataBase64,'base64');
  if(bytes.length>30*1024*1024||bytes.length===0)throw new AppError('INVALID_MEDIA','素材大小须为 1 字节至 30 MiB');
  const four=(start,value)=>bytes.toString('ascii',start,start+4)===value;
  const mp3Frame=bytes.length>=4&&bytes[0]===255&&(bytes[1]&224)===224&&(bytes[1]&24)!==8&&(bytes[1]&6)!==0&&(bytes[2]&240)!==240&&(bytes[2]&12)!==12;
  const detected=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
   bytes[0]===255&&bytes[1]===216?'image/jpeg':
   four(0,'RIFF')&&four(8,'WEBP')?'image/webp':
   four(0,'RIFF')&&four(8,'WAVE')?'audio/wav':
   bytes.toString('ascii',0,3)==='ID3'||mp3Frame?'audio/mpeg':
   four(4,'ftyp')?'iso-bmff':
   bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))?'video/webm':null;
  const matches=detected==='iso-bmff'?['video/mp4','audio/mp4'].includes(i.mimeType):detected===i.mimeType;
  if(!matches)throw new AppError('INVALID_MEDIA','文件类型与实际内容不符');
  const id=randomUUID(),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'}[i.mimeType],relativePath=`media/${id}.${ext}`,file=path.join(root,relativePath);
  checkpoint(signal);
  const expectedByteHash=restored?createHash('sha256').update(bytes).digest('hex'):null;
  let ownedHandle,ownedIdentity,writtenIdentity;
  const beforeEffect=restored?()=>{invocationFence();const row=db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?").get(i.projectId);let project;try{project=JSON.parse(row?.data);}catch{throw workspaceRestoreError();}if(!row||project?.id!==row.id||row.id!==i.projectId||project.createdAt!==importProject.createdAt)throw workspaceRestoreError();if(ownedIdentity){let actual;try{actual=lstatSync(file);}catch{throw workspaceRestoreError();}if(!actual.isFile()||actual.nlink!==1||actual.dev!==ownedIdentity.dev||actual.ino!==ownedIdentity.ino||writtenIdentity&&['size','mtimeMs','ctimeMs'].some(key=>actual[key]!==writtenIdentity[key]))throw workspaceRestoreError();}}:undefined;
  beforeEffect?.();
  if(!restored)await writeFile(file,bytes,{flag:'wx'});
  try{
   if(restored){ownedHandle=await open(file,'wx');ownedIdentity=await ownedHandle.stat();beforeEffect();await ownedHandle.writeFile(bytes);writtenIdentity=await ownedHandle.stat();beforeEffect();}
   checkpoint(signal);
   const info=await fileInfo(file,{signal,beforeEffect});checkpoint(signal);beforeEffect?.();
   if(restored&&info.sha256!==expectedByteHash)throw workspaceRestoreError();
   const hasVideo=info.hasVideo??(info.width>0&&info.height>0);
   if(i.mimeType.startsWith('audio/')?(!info.hasAudio||hasVideo||!(info.duration>0)):!hasVideo)
    throw Error('Declared media kind does not match decoded streams');
   return put('assets',{id,projectId:i.projectId,name:i.name,mimeType:i.mimeType,...info,relativePath,url:`/media/${id}`,createdAt:now(),provenance:'user-import'});
  }catch(e){if(!restored)await unlink(file).catch(()=>{});else if(ownedIdentity){const actual=await lstat(file).catch(()=>null);if(actual?.isFile()&&actual.dev===ownedIdentity.dev&&actual.ino===ownedIdentity.ino)await unlink(file).catch(()=>{});}if(e.terminationUnconfirmed||safeWorkspaceRestoreError(e))throw e;checkpoint(signal);throw new AppError('INVALID_MEDIA','无法解码素材或媒体类型不符，请检查文件');}finally{if(ownedHandle)await ownedHandle.close();}
 },
 'asset.list':i=>{required('projects',i.projectId);return list('assets',i.projectId);},
 'edge.create':i=>{required('projects',i.projectId);for(const id of [i.source,i.target]){const n=get('shots',id)||get('nodes',id);if(!n||n.projectId!==i.projectId)throw new AppError('INVALID_EDGE','只能连接同项目的节点');}if(i.source===i.target)throw new AppError('INVALID_EDGE','不能连接到自身');const existing=list('edges',i.projectId).find(e=>e.kind!=='reference'&&e.source===i.source&&e.target===i.target);return existing||put('edges',{id:randomUUID(),...i,kind:'decorative'});},
 'edge.delete':i=>{const edge=required('edges',i.edgeId);if(edge.kind==='reference')throw new AppError('REFERENCE_CONNECTED','首帧参考连线会影响生成输入；请使用 reference.detach 按镜头版本断开',409,{edgeId:edge.id});db.prepare('DELETE FROM edges WHERE id=?').run(i.edgeId);return {deleted:true};},
 'provider.list':()=>{const asOf=currentProfileDate();return [...providers.values()].map(provider=>capabilitiesFor(provider,asOf));},
 'generation.submit':i=>createJob(i),
 'job.get':i=>subjectDisclosure('jobs',required('jobs',i.jobId)),
 'job.list':i=>{required('projects',i.projectId);return list('jobs',i.projectId).map(value=>subjectDisclosure('jobs',value,i.projectId));},
 'job.retry':i=>{
  const old=required('jobs',i.jobId),subjectMode=hasSubjectGeneration(old.snapshot);
  if(subjectMode)validateSubjectGenerationOwnership(db,old);
  const newInput={shotId:old.shotId,expectedRevision:old.snapshot.shotRevision,requestId:i.requestId,providerId:old.providerId,model:old.model,parameters:old.snapshot.parameters,retryOfJobId:old.id,...(subjectMode?{subjectVersionId:old.snapshot.subjectReference.subjectVersionId}:{})};
  const prior=dedupe('generation',i.requestId,hash(newInput),'jobs');if(prior)return subjectMode||hasSubjectGeneration(prior.snapshot)?replaySubjectJob(prior,newInput,old.id):prior;
  if(old.status!=='failed')throw new AppError('UNSAFE_RETRY','只有明确失败的任务可重新提交；未知提交结果须先对账',409);
  const activeChild=list('jobs',old.projectId).find(child=>child.retryOfJobId===old.id&&['queued','submitting','running','downloading','submission_unknown'].includes(child.status));
  if(activeChild)throw new AppError('RETRY_ALREADY_ACTIVE','该失败任务已有重试正在处理，请查询已有任务',409,{jobId:activeChild.id});
  if(i.requestId===old.requestId)throw new AppError('NEW_REQUEST_REQUIRED','重试必须使用新的请求 ID',409);
  if(profilePolicy||usesInputProfiles(providers.get(old.providerId)))assertGenerationJobOwnership(db,old);
  return createJob(newInput,old.snapshot,old.id);
 },
 'job.cancel':i=>{const j=required('jobs',i.jobId);if(hasSubjectGeneration(j.snapshot))currentGenerationClaim(db,j);if(['succeeded','failed','cancelled'].includes(j.status))return subjectDisclosure('jobs',j);return subjectDisclosure('jobs',saveJob(j,{status:'cancelled',phase:'local_wait_stopped',cancelScope:'local_only',error:{code:'LOCAL_WAIT_STOPPED',message:'已停止本地等待；供应商任务未确认取消，可能仍会完成或计费',retryable:true}}));},
 'job.reconcile':async (i,{signal=ownerSignal}={})=>{
  checkpoint(signal);
  const j=required('jobs',i.jobId),subjectMode=hasSubjectGeneration(j.snapshot),context={jobId:j.id,requestId:j.requestId,providerRegion:j.snapshot.capabilities?.region,signal};
  const claim=()=>{if(subjectMode)currentGenerationClaim(db,j);};claim();
  // Paid task observation is not gated by current source availability or a new
  // provider profile. Identity is rechecked after awaits; disclosure is checked
  // only after safe progress is saved, and cannot authorize another submission.
  const disclose=value=>subjectDisclosure('jobs',value);
  if(['succeeded','failed','queued','submitting'].includes(j.status)){if(i.providerJobId)throw new AppError('INVALID_RECONCILIATION_STATE','当前任务状态不允许绑定供应商任务',409);return disclose(j);}
  if(i.providerJobId&&j.providerJobId&&i.providerJobId!==j.providerJobId)throw new AppError('TASK_ID_CONFLICT','已知供应商任务 ID 不可替换',409);
  if(i.providerJobId){
   const owner=list('jobs').find(other=>other.id!==j.id&&other.providerId===j.providerId&&other.providerJobId===i.providerJobId);if(owner)throw new AppError('TASK_ID_CONFLICT','供应商任务已属于另一个本地任务，不能替换其参数快照',409);
   if(j.providerId==='mock'){const own=await awaitProvider(()=>providers.get('mock').reconcile(j.requestId,context),signal);checkpoint(signal);claim();if(!own||own.providerJobId!==i.providerJobId)throw new AppError('TASK_ID_CONFLICT','模拟任务 ID 与此提交请求不匹配',409);}
  }
  const p=providers.get(j.providerId);if(j.snapshot.capabilities?.region&&p.capabilities.region!==j.snapshot.capabilities.region)throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);
  const found=i.providerJobId?{providerJobId:i.providerJobId}:j.providerJobId?{providerJobId:j.providerJobId}:await awaitProvider(()=>p.reconcile(j.requestId,context),signal);checkpoint(signal);claim();
  if(!found)return disclose(saveJob(j,{status:'submission_unknown',phase:'reconciliation_required',error:{code:'SUBMISSION_UNKNOWN',message:'无法确认是否已被受理；不会自动重新提交。请在供应商后台核实已有任务 ID',retryable:true}}));
  await awaitProvider(()=>p.poll(found.providerJobId,context),signal);checkpoint(signal);claim();
  const competing=list('jobs').find(other=>other.id!==j.id&&other.providerId===j.providerId&&other.providerJobId===found.providerJobId);if(competing)throw new AppError('TASK_ID_CONFLICT','供应商任务已由另一个本地任务占用',409);
  return disclose(saveJob(j,{status:'running',phase:'polling',providerJobId:found.providerJobId,error:null,cancelScope:null}));
 },
 'version.list':i=>{const s=required('shots',i.shotId);return list('versions',s.projectId).filter(v=>v.shotId===s.id).map(value=>subjectDisclosure('versions',value,s.projectId)).sort((a,b)=>a.number-b.number);},
 'export.create':i=>tx(()=>{const h=hash(i),prior=dedupe('export',i.requestId,h,'exports');if(prior)return prior;required('projects',i.projectId);const shots=list('shots',i.projectId).sort((a,b)=>a.orderIndex-b.orderIndex);if(!shots.length||shots.some(s=>!s.selectedVersionId))throw new AppError('MISSING_SELECTION','请为每个镜头选择已生成的视频版本');const versions=shots.map(s=>{const version=required('versions',s.selectedVersionId);if(restored){const graph=createOwnedMediaGraphReader(db,i.projectId),owned=graph.version(version.id,s.id,version.assetId),asset=graph.asset(owned.assetId);if(typeof owned.sha256!=='string'||owned.sha256!==asset.sha256)throw workspaceRestoreError();return owned;}return version;});const e={id:randomUUID(),projectId:i.projectId,requestId:i.requestId,status:'queued',orderedVersionIds:versions.map(v=>v.id),snapshot:versions.map(v=>({versionId:v.id,assetId:v.assetId,sha256:v.sha256,shotId:v.shotId})),assetId:null,url:null,error:null,createdAt:now(),updatedAt:now()};put('exports',e);idem('export',i.requestId,h,e.id);bindRestoredExport(store,'export.create',i,e,h);return e;}),
 'export.get':i=>subjectDisclosure('exports',required('exports',i.exportId),undefined,i.exportId)
 };
 // Public handlers are the same invocation boundary as RPC. Raw internal
 // mutation closures remain protected at their shared transaction precondition.
 const domainHandlers={...handlers};
 if(restored)for(const op of Object.keys({...domainHandlers,...restoredReads.handlers}))handlers[op]=(input,context={})=>call(op,input,context);
 async function call(op,input,context={}){
  if(op==='lut.look.inspect')assertLookPackInspectInput(input);
  const {signal:callSignal}=context;
  const signals=[ownerSignal,callSignal,restoredLifetime?.signal].filter(Boolean);
  const signal=restored?(signals.length>1?AbortSignal.any(signals):signals[0]):ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  if(restoredLifetime?.signal.aborted)throw workspaceRestoreError();
  checkpoint(signal);
  const operation=(async()=>{
   if(restored){
    if(op==='asset.annotation.set'||op==='timeline.export.samplePeak'||op==='timeline.export.loudness'||op==='timeline.loudness.prepare'||op==='timeline.audioPreview.plan'||op==='timeline.audioPreview.continuousPlan'||op==='timeline.colour.source.inspect'||op==='timeline.colour.image.inspect'||op==='timeline.colour.jpeg.inspect')throw workspaceRestoreError();
    const parsed=freezeRestoreInput(parse(op,input));
    // Frozen restored profiles admit only their own colour generation: video
    // in 31, video/PNG in 33, and video/PNG/JFIF in 35. No numeric widening.
    if(op==='timeline.clip.add'&&Object.hasOwn(parsed,'colour')||op==='timeline.clip.update'&&Object.hasOwn(parsed.patch,'colour')){
     if(![31,33,35,37].includes(restored.schemaVersion))throw workspaceRestoreError();
     const colour=op==='timeline.clip.add'?parsed.colour:parsed.patch.colour;
     if(restored.schemaVersion===31&&!nullableTimelineClipColourSchema.safeParse(colour).success)throw workspaceRestoreError();
     if(restored.schemaVersion===33&&!nullableTimelineClipColourSchema.safeParse(colour).success&&!timelineImageClipColourSchema.safeParse(colour).success)throw workspaceRestoreError();
    }
    if(Object.hasOwn(restoredReads.readers,op))return restoredReads.call(op,parsed,{signal});
    const saved=restoredReads.replay(op,parsed);if(saved)return publicValue(saved.response);
    if(!RESTORE_LOCAL_OPERATIONS.includes(op)){refuseRestoredOperation(store,op,parsed);}
    if(!hasRestoreInvocation(store,op,parsed))assertWorkspaceRestoreOrigin(store,context);
    return withRestoreInvocation(store,op,parsed,{signal},async frozen=>{
     refuseRestoredOperation(store,op,frozen);
     const result=await domainHandlers[op](frozen,{signal});
     restoreEffectFence(store)();checkpoint(signal);return publicValue(result);
    });
   }
   if(Object.hasOwn(inspection.handlers,op))return inspection.handlers[op](input);
   const parsed=parse(op,input),result=await domainHandlers[op](parsed,{signal});checkpoint(signal);
   return publicValue(result);
  })();
  active.add(operation);
  try{return await operation;}catch(error){if(error.terminationUnconfirmed)shutdownFailure=error;throw error;}finally{active.delete(operation);}
 }
 // Drain async RPC work before closing SQLite. Rejection is a settled operation;
 // an unbounded filesystem operation is a shutdown failure, never a safe close.
 const drain=async()=>{
  restoredLifetime?.abort();
  // Derived cache work may outlive its quick queued RPC acknowledgement. Stop
  // and join its explicit owner before SQLite can close, including late decode.
  const ownerDrains=[waveforms.drain(),preflight.drain(),images.drain(),frames.drain(),exportAdmission.drain(),samplePeak.drain(),loudness.drain(),mixLoudness.drain(),audioPreview.drain(),colourSource.drain(),imageColourSource.drain()];
  const results=await boundedShutdown(Promise.allSettled([...ownerDrains,...active]),'SERVICE_STOP_TIMEOUT');
  if(shutdownFailure)throw shutdownFailure;
  for(const result of results.slice(0,ownerDrains.length))if(result.status==='rejected')throw result.reason;
 };
 // Backend-only scoped entry, deliberately absent from handlers/RPC discovery.
 // It shares the same parsed input, handler, transaction and response journal.
 async function updateShotInProject(projectId,input){
  checkpoint(ownerSignal);
  if(typeof projectId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId))throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(await localMutations.updateShotInProject(projectId,parse('shot.update',input)));
 }
 // Backend-only reviewed startFrame move; not part of handlers or discovery.
 function moveTimelineClipInProject(projectId,input,target){
  checkpoint(ownerSignal);
  if(projectId!==input?.projectId||projectId!==target?.projectId)throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(timeline.moveClipInProject(parse('timeline.clip.update',input),target));
 }
 // Backend-only reviewed gain. The fixed boundary reuses the same clip update transaction.
 function setTimelineClipGainInProject(projectId,input,target){
  checkpoint(ownerSignal);
  if(projectId!==input?.projectId||projectId!==target?.projectId)throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(timeline.setClipGainInProject(parse('timeline.clip.update',input),target));
 }
 // Only queued/new provider dispatch uses lifecycle validation. Paid task
 // polling, download and reconciliation deliberately never call this boundary.
 function validateGenerationDispatch(job){
  if(restored)disabled();
  const provider=providers.get(job.providerId);
  const subjectMode=hasSubjectGeneration(job.snapshot);
  if(!profilePolicy&&!usesInputProfiles(provider)&&!subjectMode)return null;
  const subjectGraph=subjectMode?validateSubjectGenerationOwnership(db,job):null;
  currentGenerationClaim(db,job);
  if(!provider||provider.id!==job.providerId)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
  const capabilities=capabilitiesFor(provider);
  if(job.snapshot.providerId!==job.providerId||job.snapshot.model!==job.model)throw new AppError('INVALID_REFERENCE_MANIFEST','任务身份与冻结快照不一致');
  return prepareGenerationInputs({source:job.snapshot,projectId:job.projectId,providerId:job.providerId,model:job.model,capabilities,readAsset:id=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,job.projectId),asOf:capabilities.profileEvaluationDate,frozen:true});
 }
 // Limit this ownership fence to unaccepted claims and restart classification.
 // Policy rejection must not authorize writing a foreign or replaced record.
 let invalidGenerationReported=false;
 function saveGenerationGuarded(job,patch){
  if(restored)disabled();
  if(!profilePolicy&&!usesInputProfiles(providers.get(job.providerId))&&!hasSubjectGeneration(job.snapshot))return saveJob(job,patch);
  return tx(()=>{
   let current;try{current=currentGenerationClaim(db,job);}catch{
    if(!invalidGenerationReported){invalidGenerationReported=true;console.error('Skipped invalid local generation record.');}
    return null;
   }
   return saveJob(current,patch);
  });
 }
 return {call,drain,audioPreview,saveGenerationGuarded,validateGenerationDispatch,updateShotInProject:restored?disabled:updateShotInProject,moveTimelineClipInProject:restored?disabled:moveTimelineClipInProject,setTimelineClipGainInProject:restored?disabled:setTimelineClipGainInProject,required,check,event,saveJob,createJob,handlers,publicValue,inspection,imageApproval:images.approveReviewed,imageRejection:images.rejectReview};
}

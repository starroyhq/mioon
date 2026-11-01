import {createWorkspaceConfiguration} from './workspace-configuration.ts';
import {createWorkspaceBackupRuntime} from './workspace-backup-runtime.ts';
import {createExportControlServices} from './export-controls.ts';
import {createTaskDispositionServices} from './task-dispositions.ts';
import {createManagedAssetImportHandler} from './managed-asset-import.ts';
import {bindAgentTaskJobInside,assertAgentTaskJobEffect,assertTaskEffectOrigin,setAgentTaskJobStopper,withAgentTaskJobOrigin} from './agent/task-effects-v2.ts';
import {freezeStoryboardOutputGeometry} from './storyboard-output.ts';
import {AgentAuthorizationError} from './agent/authorizations.ts';
import type {AgentAuthorizations} from './agent/authorizations.ts';
import {createProjectHomeServices} from './project-home.ts';
import {createProjectLifecycleServices} from './project-lifecycle.ts';
import {validateManagedFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {readTimelineVolumeEnvelopeCapability} from './timeline-volume-envelope-capability.ts';
import {assertTimelineAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {readTimelineAudioRoleCapability} from './timeline-audio-role-business.ts';
import {createMutationReplay} from './mutation-replay.ts';
import {nullableTimelineClipColourSchema,timelineImageClipColourSchema} from '../../contracts/src/timeline-colour.ts';
import {isRestoredWorkspaceSchemaSince} from '../../contracts/src/workspace-schema-lineage.ts';
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
import {validateTimeline} from './timeline-inputs.ts';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {bindRestoredExport} from './workspace-restore-exports.ts';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS,assertWorkspaceRestoreOrigin,refuseRestoredOperation,safeWorkspaceRestoreError,workspaceRestoreError} from './workspace-restore-policy.ts';
import {withRestoreInvocation,freezeRestoreInput,hasRestoreInvocation,restoreEffectFence} from './workspace-restore-invocation.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {createRestoredReadServices} from './workspace-restore-read.ts';
import {inspectWorkspaceBackup} from './backup-readiness.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {parse,AppError,publicValue,getGenerationIssue,getSubjectGenerationSnapshotIssue} from '@mioon/contracts';
import {operationEffect} from '@mioon/contracts';
import type {OperationName} from '@mioon/contracts';
import {normalizedCapabilities,usesInputProfiles} from './provider-registry.ts';
import type {Provider} from './provider-registry.ts';
import {videoBindingCapabilities} from '../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../../contracts/src/video-providers.ts';
import {getWan30Capability,resolveWanGenerationParameters} from '../../contracts/src/wan-video.ts';
import type {VideoSettingsService} from './video/settings.ts';
import {createConfiguredVideoProvider} from './video/runtime.ts';
import {listVideoConnections,readVideoBinding,sameVideoExecutionDomain,prepareConfiguredVideoInputs} from './video/generation.ts';
import {prepareGenerationInputs,generationReferenceSelection,readGenerationAsset,assertGenerationReferenceIds,assertGenerationShotOwnership,assertGenerationJobOwnership,currentGenerationClaim,hasSubjectGeneration,validateSubjectGenerationOwnership,assertSubjectGenerationSelection,assertSubjectGenerationRequestVacant,readGenerationLinkedJob} from './generation-inputs.ts';
import type {GenerationAsset,GenerationJob,GenerationRecord,GenerationShot,GenerationSource,GenerationSubjectGraph} from './generation-inputs.ts';
import {createTimelineServices} from './timeline.ts';
import {createTimelineExportAdmissionServices} from './timeline-export-admission.ts';
import {createTimelinePreflightServices} from './timeline-preflight.ts';
import {createExportSamplePeakServices} from './export-sample-peak.ts';
import {createExportSamplePeakDecoder} from './export-sample-peak-decoder.ts';
import {createExportLoudnessServices} from './export-loudness.ts';
import {createExportLoudnessDecoder} from './export-loudness-decoder.ts';
import {createTimelineClipLoudnessServices} from './timeline-clip-loudness.ts';
import {createTimelineClipLoudnessDecoder} from './timeline-clip-loudness-decoder.ts';
import {createTimelineMixLoudnessServices} from './timeline-mix-loudness.ts';
import {createTimelineMixLoudnessDecoder} from './timeline-mix-loudness-decoder.ts';
import {ownsStoreLock} from './db.ts';
import type {WorkspaceStore} from './db.ts';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {readOwnedTimelineAsset,readTimelinePreflightSnapshot,readTimelineSourceGraph} from './timeline-sources.ts';
import {validateManagedSource,verifiedManagedHash} from './managed-media.ts';
import {run,runStreaming,runStreamingWithBackpressure,checkMediaEffect} from './media-runtime.ts';
import {withProbePermit} from './media-probe.ts';
import {terminateMediaProcesses,waitForMediaProcesses} from './media-processes.ts';
import {createReferenceServices} from './references.ts';
import {createInspectionServices,createOwnedMediaGraphReader} from './inspection.ts';
import {createLocalMutationServices} from './local-mutations.ts';
import {createSourceRangeServices} from './source-ranges.ts';
import {createSubjectServices} from './subjects.ts';
import {createAssetAnnotationServices} from './asset-annotations.ts';
import {createAssetDispositionServices} from './asset-dispositions.ts';
import {createWaveformServices} from './waveforms.ts';
import {createImageServices} from './images.ts';
import {createFrameServices} from './frames.ts';
import {createSceneServices} from './scene-tasks.ts';
import {createSubjectVariantServices} from './subject-variants.ts';
import {createPrevisServices} from './previs.ts';
import {isSubjectVersionHidden} from './subject-variant-visibility.ts';
import {validateImageConsumption} from './image-consumption.ts';
import {awaitProvider,boundedShutdown,checkpoint} from './operation-lifecycle.ts';

export type ServiceRow=Record<string, unknown>;
/** Minimum store identity accepted by createServices and startWorker. */
export interface ServiceStore { readonly db: DatabaseSync; readonly root: string }
export interface HandlerCallContext { readonly signal?: AbortSignal; readonly expectedWorkspaceOrigin?: unknown; readonly [key: string]: unknown }
export interface ServiceHandlerContext { readonly signal?: AbortSignal | null; readonly expectedWorkspaceOrigin?: unknown; readonly [key: string]: unknown }
export type ServiceHandler=(input: never,context?: ServiceHandlerContext)=>unknown;
export type ServiceHandlers=Record<string,(input: never,context?: ServiceHandlerContext)=>unknown>;
export interface CreateServicesOptions {
 videoSettings?: VideoSettingsService;
 videoFetch?: typeof fetch;
 env?: NodeJS.ProcessEnv;
 signal?: AbortSignal;
 profileNow?: ()=>number;
 imageOptions?: Parameters<typeof createImageServices>[1];
 frameOptions?: Parameters<typeof createFrameServices>[1];
 sceneOptions?: Parameters<typeof createSceneServices>[1];
 exportOptions?: Parameters<typeof createTimelineExportAdmissionServices>[1];
 agentAuthorizations?: AgentAuthorizations | null;
 readRecentOpened?: ()=>Readonly<Record<string,string>>;
 assertMutationAllowed?: ()=>void;
 workspaceBaseRoot?: string;
 backupQuiescent?: ()=>boolean;
}
type AudioPreviewService=ReturnType<typeof createTimelineAudioPreviewCoordinator>;
type ProjectLifecycleService=ReturnType<typeof createProjectLifecycleServices>;
type InspectionService=ReturnType<typeof createInspectionServices>;
/** Ordinary backend surface returned by createServices. */
export interface OrdinaryServices {
 handlers: ServiceHandlers;
 call: (operation: string,input: unknown,context?: ServiceHandlerContext)=>Promise<unknown>;
 drain: ()=>Promise<void>;
 isQuiescent: ()=>boolean;
 configuration: ReturnType<typeof createWorkspaceConfiguration>;
 backups: ReturnType<typeof createWorkspaceBackupRuntime>;
 audioPreview: AudioPreviewService;
 saveGenerationGuarded: (job: JobRecord,patch: ServiceRow)=>ServiceRow|null;
 validateGenerationDispatch: (job: JobRecord)=>unknown;
 resolveGenerationProvider?: (job: JobRecord)=>Provider|undefined;
 updateShotInProject: (projectId: string,input: unknown)=>Promise<unknown>;
 moveTimelineClipInProject: (projectId: string,input: unknown,target: unknown)=>unknown;
 setTimelineClipGainInProject: (projectId: string,input: unknown,target: unknown)=>unknown;
 compensateAgentTimelineInside:ReturnType<typeof createTimelineServices>['compensateAgentTargetsInside'];
 required: (table: string,id: string)=>ServiceRow;
 check: (value: ServiceRow,revision: unknown)=>void;
 event: (job: ServiceRow,entry: ServiceRow)=>void;
 saveJob: (job: JobRecord,patch: ServiceRow)=>ServiceRow;
 createJob: (input: GenerationSubmitInput,retrySnapshot?: JobRecord|null,retryOfJobId?: string|null)=>JobRecord;
 publicValue: typeof publicValue;
 inspection: InspectionService;
 imageApproval: (input: unknown)=>unknown;
 imageRejection: (input: unknown)=>unknown;
 setProjectDeletionCompanions: ProjectLifecycleService['setProjectDeletionCompanions'];
}
export interface ShotRecord extends ServiceRow {
 id: string;
 projectId: string;
 revision: number;
 parameters: ServiceRow;
 referenceAssetIds: unknown[];
 lastFrameAssetId?: string|null;
 selectedVersionId?: string|null;
 orderIndex?: number;
}
export interface JobRecord extends ServiceRow {
 id: string;
 projectId: string;
 shotId: string;
 requestId: string;
 requestHash: string;
 providerId: string;
 model: string;
 revision: number;
 status: string;
 phase?: string|null;
 snapshot: ServiceRow;
 providerJobId?: string|null;
 retryOfJobId?: string|null;
 submissionCount?: number;
}
export interface GenerationSubmitInput {
 connectionId?: string;
 configurationRevision?: number;
 modelEntryId?: string;
 shotId: string;
 expectedRevision: number;
 requestId: string;
 providerId: string;
 model?: string;
 parameters?: ServiceRow;
 subjectVersionId?: string;
 videoInput?: unknown;
 retryOfJobId?: string|null;
 readonly [key: string]: unknown;
}
const isRecord=(value: unknown): value is ServiceRow=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const stringValue=(value: unknown): string|undefined=>typeof value==='string'?value:undefined;
const recordValue=(value: unknown): ServiceRow|null=>isRecord(value)?value:null;
const arrayValue=(value: unknown): unknown[]=>Array.isArray(value)?value:[];

export const now=(): string=>new Date().toISOString();
export function canonical(v: unknown): string {return JSON.stringify(v,(_key: string,x: unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x) as string;}
export const hash=(v: unknown): string=>createHash('sha256').update(canonical(v)).digest('hex');
export function createServices(inputStore: ServiceStore,providers: ReadonlyMap<string,Provider>,
 {env=process.env,signal:ownerSignal,profileNow=Date.now,imageOptions,frameOptions,sceneOptions,exportOptions,agentAuthorizations,readRecentOpened,assertMutationAllowed,workspaceBaseRoot,backupQuiescent,videoSettings,videoFetch}: CreateServicesOptions={}): OrdinaryServices {
 const store: WorkspaceStore = inputStore as unknown as WorkspaceStore;
 const restored=getWorkspaceRestoreContext(store);
 const restoredReads=restored?createRestoredReadServices(store as unknown as Parameters<typeof createRestoredReadServices>[0],{signal:ownerSignal}):null;
 const disabled=(): never=>{throw workspaceRestoreError();};
 const inactive=()=>({handlers:{} as ServiceHandlers,drain:async(): Promise<void>=>{},approveReviewed:disabled as (...args: unknown[])=>never,rejectReview:disabled as (...args: unknown[])=>never});
 const nonBackupActive=new Set<Promise<unknown>>();
 const active=new Set<Promise<unknown>>(),restoredLifetime=restored?new AbortController():null;let shutdownFailure: unknown;
 const {db,root,get,list,put,tx}=store;
 const configuration=createWorkspaceConfiguration({root:workspaceBaseRoot??root,env});
 const backups=createWorkspaceBackupRuntime({store,configuration,isQuiescent:()=>nonBackupActive.size===0&&(backupQuiescent?.()??true)});
 const backupHandlers={
  'workspace.settings.get':()=>configuration.get(),
  'workspace.settings.set':(input:never)=>{if(restored)disabled();backups.assertMutationAllowed();return configuration.set(input);},
  'workspace.backup.status':()=>backups.getStatus(),
  'workspace.backup.list':()=>backups.list(),
  'workspace.backup.create':(input:never)=>backups.create(input),
  'workspace.backup.restore.stage':(input:never)=>backups.stageRestore(input),
 };
 const required=(t: string,id: string): ServiceRow=>{const v=get(t,id);if(!v)throw new AppError('NOT_FOUND','找不到记录',404,{id});return v as ServiceRow;};
 const projectHome=createProjectHomeServices(store,{readRecentOpened});
 const projectLifecycle=restored?{handlers:{} as ServiceHandlers,setProjectDeletionCompanions:disabled as (...args: unknown[])=>never}:createProjectLifecycleServices(store,{
  storage:{validateManagedFile,validateManagedDirectory},
  ownsLock:()=>ownsStoreLock(store),isReadOnly:()=>Boolean(restored),signal:ownerSignal,
  assertIdle:()=>{if(active.size)throw new AppError('PROJECT_DELETE_BUSY','工作区仍有异步操作在执行，请结束后再删除项目。',409);},
 });
 const luts=restored?inactive():createLutResourceServices(store,{signal:ownerSignal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>{},assertImportAllowed:()=>{if(getWorkspaceRestoreContext(store))disabled();}}});
 const lookPacks=restored?inactive():createLookPackInspectionServices(store,{signal:ownerSignal,runtime:{ownsLock:()=>ownsStoreLock(store),assertReadable:()=>{}}});
 const check=(v: ServiceRow,rev: unknown): void=>{if(v.revision!==rev)throw new AppError('REVISION_CONFLICT','内容已有新版本，请重新读取后再修改',409,{entityId:v.id,expectedRevision:rev,currentRevision:v.revision,current:publicValue(v)});};
 const dedupe=(scope: string,requestId: string,requestHash: string,table: string): ServiceRow|null=>{
  const r=db.prepare(scope==='generation'?`SELECT CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash,CASE WHEN typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS resourceId FROM idempotency WHERE scope=? AND requestId=?`:'SELECT * FROM idempotency WHERE scope=? AND requestId=?').get(scope,requestId);
  if(!r)return null;
  if(r.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同内容',409,{requestId});
  return required(table,r.resourceId as string);
 };
 const idem=(scope: string,key: string,h: string,id: string): void=>{db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,h,id);};
 const event=(job: ServiceRow,entry: ServiceRow): void=>{if(restored)disabled();db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(job.id as string,JSON.stringify(entry),now());};
 const saveJob=(job: JobRecord,patch: ServiceRow): ServiceRow=>{
  if(restored)disabled();
  const save=():ServiceRow=>{
   const current=required('jobs',job.id);
   const currentRevision=typeof current.revision==='number'?current.revision:0,jobRevision=typeof job.revision==='number'?job.revision:0;
   if(currentRevision!==jobRevision)return current;
   const result: ServiceRow={...current,...patch,revision:currentRevision+1,updatedAt:now()};put('jobs',result);event(result,{status:result.status,phase:result.phase,error:result.error});return result;
  };return db.isTransaction?save():tx(save);
 };
 const profilePolicy=restored?false:usesInputProfiles(providers),currentProfileDate=()=>new Date(profileNow()).toISOString().slice(0,10);
 const runtimeEnv=configuration.environment();
 const capabilitiesFor=(provider: Provider,asOf=currentProfileDate())=>normalizedCapabilities(provider,runtimeEnv,0,{asOf,requireInputProfiles:profilePolicy||usesInputProfiles(provider)});
 const configuredVideoProviders=new Map<string,Provider>();
 const boundProvider=(binding:VideoExecutionBinding):Provider=>{
  if(restored)disabled();
  if(!videoSettings)throw new AppError('VIDEO_SETTINGS_UNAVAILABLE','视频连接设置不可用。',409);
  videoSettings.assertBinding(binding);
  const key=canonical(binding);let provider=configuredVideoProviders.get(key);
  if(!provider){provider=createConfiguredVideoProvider({root,binding,acquireCredential:()=>videoSettings.acquire(binding,ownerSignal),...(videoFetch?{fetchImpl:videoFetch}:{})});configuredVideoProviders.set(key,provider);}
  return provider;
 };
 const resolveGenerationProvider=(job:JobRecord):Provider|undefined=>{
  const binding=readVideoBinding(job.snapshot);
  if(!binding)return providers.get(job.providerId);
  if(binding.providerId!==job.providerId||binding.model.modelId!==job.model)throw new AppError('VIDEO_BINDING_INVALID','任务身份与连接绑定不一致。');
  return boundProvider(binding);
 };
 const bindingRole=(bindings: unknown,index: number): unknown=>Array.isArray(bindings)?property(bindings[index],'role'):undefined;
 const hasLastFrameRole=(value: unknown): boolean=>Array.isArray(value)&&value.some(reference=>property(reference,'role')==='last_frame');
 const validateProvider=(source: GenerationSource,providerId: string,requestedModel: string|undefined,parameters: ServiceRow|undefined,projectId: string,frozen=false,subjectGraph: GenerationSubjectGraph|null=null)=>{
  const binding=readVideoBinding(source);
  if(source.videoInput!==undefined&&!binding)throw new AppError('UNSUPPORTED_INPUT_ROLE',providerId==='ark'?'Seedance 图片输入需要明确的 Seedance 2.5 连接。':'Wan 图片输入需要明确的 Wan 3.0 连接。');
  if(binding){
   configuration.assertLiveEnabled();
   if(binding.providerId!==providerId||requestedModel!==undefined&&requestedModel!==binding.model.modelId)throw new AppError('VIDEO_BINDING_INVALID','请求模型与所选连接不一致。');
   const p=boundProvider(binding),c=videoBindingCapabilities(binding,{asOf:currentProfileDate()});
   if(!c.configured)throw new AppError('VIDEO_SETTINGS_INCOMPLETE','请先配置此连接的输出域名。',409);
   const prepared=prepareConfiguredVideoInputs({source:{...source,parameters},binding,projectId,readAsset:id=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,projectId),frozen,asOf:currentProfileDate()});
   const executionConnectionName=frozen?source.executionConnectionName:videoSettings?.list().find(view=>view.configuration.id===binding.connectionId)?.configuration.name;
   return {p,model:binding.model.modelId,assets:prepared.assets,referenceAssetIds:prepared.assets.map(asset=>asset.id),capabilities:c,inputFields:{...prepared.fields,...(typeof executionConnectionName==='string'?{executionConnectionName}:{})}};
  }
  const p=providers.get(providerId);if(!p)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
  const c=capabilitiesFor(p),models=Array.isArray(property(c,'models'))?property(c,'models') as unknown[]:[],first=models[0],
   model=requestedModel||(typeof first==='string'?first:stringValue(property(first,'id')));
  if(!model)throw new AppError('UNSUPPORTED_PARAMETERS','供应商没有可用模型');
  const profiled=profilePolicy||usesInputProfiles(p);
  if(hasSubjectGeneration(source)&&!profiled)throw new AppError('INPUT_PROFILE_UNAVAILABLE','主体参考需要服务器已注册的精确输入规范',400);
  const selection=generationReferenceSelection(source,{frozen});
  const assets=selection.ids.map((id,index)=>{
   const asset=subjectGraph?subjectGraph.asset(id):profiled?readGenerationAsset(db,id,projectId):validateImageConsumption(db,required('assets',id) as unknown as {id: string; provenance?: unknown},projectId);
   const role=frozen?bindingRole(source.referenceBindings,index):selection.references?.[index]?.role;
   return (selection.ids.length===2||role==='subject_reference')&&role&&!Object.hasOwn(asset,'role')?{...asset,role}:asset;
  });
  if(hasSubjectGeneration(source)&&!['ark','mock'].includes(providerId))throw new AppError('UNSUPPORTED_INPUT_ROLE','此供应商尚未实现主体参考视频输入',400,{providerId,model});
  const hasLastFrame=(frozen?hasLastFrameRole(source.referenceBindings):hasLastFrameRole(selection.references))||source.lastFrameAssetId!=null;
  if(hasLastFrame&&!['ark','mock'].includes(providerId))throw new AppError('UNSUPPORTED_INPUT_ROLE','此供应商尚未实现首尾帧输入；不会忽略尾帧',400,{providerId,model});
  // Config checks never reveal credentials. Live calls still require the
  // adapter's explicit backend enable switch and credential configuration.
  if(!p.capabilities.enabled||!p.capabilities.configured)throw new AppError('PROVIDER_DISABLED','真实供应商尚未安全配置并授权；当前可使用模拟供应商',403,{providerId,status:property(c,'status'),configuration:property(c,'configuration')});
  if(property(source.capabilities,'region')&&property(c,'region')!==property(source.capabilities,'region'))throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);
  const subjectMode=hasSubjectGeneration(source);
  const prepare=(sourceValue: GenerationSource,capabilities: ServiceRow)=>prepareGenerationInputs({source:sourceValue,projectId,providerId,model,capabilities,readAsset:(id: string)=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,projectId),asOf:property(c,'profileEvaluationDate'),frozen});
  let prepared: ReturnType<typeof prepareGenerationInputs>|null=subjectMode?prepare({...source,parameters},c as unknown as ServiceRow):null;
  const snapshot={...source,model,referenceAssetIds:selection.ids,referenceAssets:frozen?source.referenceAssets:assets,parameters,...(subjectMode&&prepared?{providerId,...prepared.fields}:{})};
  const {inputProfiles: _ignoredProfiles,...legacyCapabilities}=c;
  const issue=getGenerationIssue(snapshot,legacyCapabilities);if(issue)throw new AppError(issue.code,issue.message,400,{providerId,model});
  if(p.validate){try{p.validate(snapshot);}catch(error){throw new AppError(stringValue(property(error,'code'))||'UNSUPPORTED_PARAMETERS',stringValue(property(error,'message'))||'此供应商不支持所选参数',400,{providerId,model});}}
  prepared??=profiled?prepare({...source,parameters},c as unknown as ServiceRow):null;
  return {p,model,assets:prepared?.assets||assets,referenceAssetIds:selection.ids,capabilities:c,inputFields:prepared?.fields};
 };
 function replaySubjectJob(job: JobRecord,input: GenerationSubmitInput,retryOfJobId: string|null=null): JobRecord {
  if(job.requestId!==input.requestId||job.requestHash!==hash(input)||job.shotId!==input.shotId||job.providerId!==input.providerId||input.model!==undefined&&job.model!==input.model||job.retryOfJobId!==retryOfJobId||
   property(job.snapshot,'shotRevision')!==input.expectedRevision||property(property(job.snapshot,'subjectReference'),'subjectVersionId')!==input.subjectVersionId)throw new AppError('INVALID_REFERENCE_MANIFEST','任务身份与原始主体参考请求不一致',409);
  validateSubjectGenerationOwnership(db,job);
  return job;
 }
 const createJob=(input: GenerationSubmitInput,retrySnapshot: JobRecord|null=null,retryOfJobId: string|null=null): JobRecord=>tx(()=>{
  if(restored)disabled();
  const requestHash=hash(input),prior=dedupe('generation',input.requestId,requestHash,'jobs');
  if(prior){const priorJob=prior as JobRecord;return input.subjectVersionId!==undefined||hasSubjectGeneration(priorJob.snapshot)?replaySubjectJob(priorJob,input,retryOfJobId):priorJob;}
  assertSubjectGenerationRequestVacant(db,input);
  const shot=required('shots',input.shotId) as ShotRecord;
  if(!isRecord(shot))throw new AppError('NOT_FOUND','找不到记录',404);
  if(!retrySnapshot)check(shot,input.expectedRevision);
  if(profilePolicy||usesInputProfiles(providers.get(input.providerId))||input.subjectVersionId!==undefined||input.connectionId)assertGenerationShotOwnership(db,shot);
  let source: GenerationSource=retrySnapshot||shot as unknown as GenerationSource,subjectGraph: GenerationSubjectGraph|null=null;
  if(!retrySnapshot&&input.videoInput!==undefined)source={...source,videoInput:input.videoInput};
  const subjectMode=input.subjectVersionId!==undefined||hasSubjectGeneration(source);
  let referenceConnections: unknown;
  if(subjectMode){
   subjectGraph=createOwnedMediaGraphReader(db,shot.projectId) as unknown as GenerationSubjectGraph;
   if(retrySnapshot){
    const retrySource=retrySnapshot as unknown as GenerationSource;
    const issue=getSubjectGenerationSnapshotIssue(retrySource,{projectId:shot.projectId,requireProfilePin:true});if(issue)throw new AppError(issue.code,issue.message,400);
    subjectGraph.validateSubjectReference(property(retrySource,'subjectReference'));
    if(input.subjectVersionId!==property(property(retrySource,'subjectReference'),'subjectVersionId'))throw new AppError('INVALID_REFERENCE_MANIFEST','重试必须保留原始主体版本',409);
    referenceConnections=property(retrySource,'referenceConnections');
   }else{
    assertSubjectGenerationSelection(db,shot);
    if(isSubjectVersionHidden(db,input.subjectVersionId as string))throw new AppError('SUBJECT_VERSION_HIDDEN','这个版本属于已撤销的补角度批次，已隐藏',409);
    const subjectReference=subjectGraph.subjectReference(input.subjectVersionId as string),version=subjectReference.subjectVersion;
    referenceConnections=[];
    source={...shot,subjectReference,referenceAssetIds:[version.assetId],referenceConnections,referenceBindings:[{role:'subject_reference',assetId:version.assetId,sha256:version.sha256}]};
   }
  }else referenceConnections=source.videoInput!==undefined?(retrySnapshot?property(retrySnapshot,'referenceConnections'):[]):(retrySnapshot?property(retrySnapshot,'referenceConnections'):undefined)??(!retrySnapshot?references.snapshot(shot as never):[]);
  const executionBinding=retrySnapshot?readVideoBinding(retrySnapshot):input.connectionId?videoSettings?.select(input.connectionId,input.configurationRevision!,input.modelEntryId!):null;
  if(input.connectionId&&!executionBinding)throw new AppError('VIDEO_SETTINGS_UNAVAILABLE','所选视频连接不可用。',409);
  if(executionBinding)source={...source,executionBinding};
  let parameters:unknown=(retrySnapshot?property(retrySnapshot,'parameters'):undefined)||{...(isRecord(shot.parameters)?shot.parameters:{}),...input.parameters};
  const wanCapability=executionBinding?.providerId==='wan'?getWan30Capability(executionBinding.model.modelId,executionBinding.region,executionBinding.model.templateId):undefined;
  // Missing historical parameters must not borrow the current shot's preferences during retry validation.
  if(wanCapability&&executionBinding)parameters=retrySnapshot?property(retrySnapshot,'parameters'):resolveWanGenerationParameters(executionBinding.model,wanCapability.defaults,{aspectRatio:shot.aspectRatio,parameters});
  const {model,assets,referenceAssetIds,capabilities,inputFields}=validateProvider({...source,referenceConnections},input.providerId,input.model,isRecord(parameters)?parameters:undefined,shot.projectId,Boolean(retrySnapshot),subjectGraph);
  const snapshot: ServiceRow=retrySnapshot??{shotId:shot.id,shotRevision:shot.revision,title:shot.title,prompt:shot.prompt,referenceAssetIds:[...referenceAssetIds],...(shot.lastFrameAssetId!=null?{lastFrameAssetId:shot.lastFrameAssetId}:{}),referenceAssets:(assets as GenerationAsset[]).map(a=>({id:a.id,relativePath:a.relativePath,mimeType:a.mimeType,sha256:a.sha256,width:a.width,height:a.height,...(Object.hasOwn(a,'role')?{role:a.role}:{}),...(inputFields?{sizeBytes:a.sizeBytes}:{})})),referenceConnections,aspectRatio:shot.aspectRatio,duration:shot.duration,providerId:input.providerId,model,parameters,capabilities,...(inputFields||{}),...(subjectMode?{subjectReference:property(source,'subjectReference')}:{})};
  const job: JobRecord={id:randomUUID(),projectId:shot.projectId,shotId:shot.id,requestId:input.requestId,requestHash,providerId:input.providerId,model,revision:1,status:'queued',phase:'waiting',progress:0,snapshot,providerJobId:null,submissionCount:0,error:null,createdAt:now(),updatedAt:now(),versionId:null,cancelScope:null,retryOfJobId};
  put('jobs',job);idem('generation',input.requestId,requestHash,job.id);event(job,{status:'queued'});bindAgentTaskJobInside(db,'job',job.id);
  if(subjectMode)replaySubjectJob(job,input,retryOfJobId);
  return job;
 });
 const exportAdmission=createTimelineExportAdmissionServices(store,{...exportOptions,signal:ownerSignal,hash});
 const timeline=createTimelineServices(store as unknown as Parameters<typeof createTimelineServices>[0],{required,check,hash,now,exportAdmission} as Parameters<typeof createTimelineServices>[1]);
 const assertOrdinaryObservation=():void=>{if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();assertTaskEffectOrigin();};
 const preflight=createTimelinePreflightServices(store,{signal:ownerSignal,beforeEffect:assertTaskEffectOrigin});
 const samplePeak=restored?{...inactive(),handlers:{'timeline.export.samplePeak':disabled as ServiceHandler}}:createExportSamplePeakServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,
  ownsLock:()=>ownsStoreLock(store),isTimelineRenderRecord,
  readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createExportSamplePeakDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const loudness=restored?{...inactive(),handlers:{'timeline.export.loudness':disabled as ServiceHandler}}:createExportLoudnessServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,
  ownsLock:()=>ownsStoreLock(store),isTimelineRenderRecord,
  readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createExportLoudnessDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const readSavedTimeline=(projectId: string)=>{
  const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{const {timeline:value}=readTimelinePreflightSnapshot(store,projectId,undefined);if(!value)return null;
   const assets=readTimelineSourceGraph(db,projectId,value);validateTimeline(value,assets,{structureOnly:true});
   return {timeline:value,assets:[...assets.values()]};
  }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
 };
 const clipLoudness=restored?{...inactive(),handlers:{'timeline.clip.loudness':disabled as ServiceHandler}}:createTimelineClipLoudnessServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline,
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createTimelineClipLoudnessDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const mixLoudness=restored?{...inactive(),handlers:{'timeline.loudness.prepare':disabled as ServiceHandler}}:createTimelineMixLoudnessServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline,
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createTimelineMixLoudnessDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const assertLoudnessApplyAvailable=(): void=>{if(restored)throw workspaceRestoreError();checkpoint(ownerSignal);if(!ownsStoreLock(store))throw new AppError('EDIT_TASK_OWNER_REQUIRED','只有持有工作区锁的后端可以应用增益',403);};
 const loudnessApply=restored?{handlers:{'timeline.loudness.apply':disabled as ServiceHandler}}:createTimelineLoudnessApplyServices({
  measurement:mixLoudness as unknown as Parameters<typeof createTimelineLoudnessApplyServices>[0]['measurement'],transactions:timeline.createLoudnessApplyTransactions(assertLoudnessApplyAvailable),assertAvailable:assertLoudnessApplyAvailable,
 });
 const readSavedAudioTimeline=createSavedTimelineAudioReader({db,
  readTimeline:projectId=>readTimelinePreflightSnapshot(store,projectId,undefined).timeline,
  readAssets:(projectId,timeline)=>readTimelineSourceGraph(db,projectId,timeline),
  validate:(timeline,assets)=>validateTimeline(timeline,assets,{structureOnly:true}),
 });
 const audioPreviewV1=restored?{...inactive(),handlers:{'timeline.audioPreview.plan':disabled as ServiceHandler},consumeSource:disabled as (...args: unknown[])=>never}:createTimelineAudioPreviewServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline:readSavedAudioTimeline,
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  decode:createTimelineAudioPreviewDecoder({run,runStreaming,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const continuousAudio=restored?{...inactive(),handlers:{'timeline.audioPreview.continuousPlan':disabled as ServiceHandler},consumeBlock:disabled as (...args: unknown[])=>never,retireSession:disabled as (...args: unknown[])=>never,retireSessionById:disabled as (...args: unknown[])=>never,assertNoContinuousSession:disabled as (...args: unknown[])=>never}:createTimelineAudioContinuousServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readSavedTimeline:readSavedAudioTimeline,validateSource:validateManagedSource,hash:verifiedManagedHash,
  decoder:createTimelineAudioContinuousDecoder({run,runStreamingWithBackpressure,withProbePermit,checkMediaEffect}),boundedShutdown,
 }});
 const audioPreview=createTimelineAudioPreviewCoordinator(audioPreviewV1 as unknown as Parameters<typeof createTimelineAudioPreviewCoordinator>[0],continuousAudio as unknown as Parameters<typeof createTimelineAudioPreviewCoordinator>[1],AppError);
 const imageColourSource=restored?{...inactive(),handlers:{'timeline.colour.image.inspect':disabled as ServiceHandler,'timeline.colour.jpeg.inspect':disabled as ServiceHandler}}:createTimelineImageSourceServices(store,{signal:ownerSignal,runtime:{validateSource:validateManagedSource,runStreaming,waitForMediaProcesses,
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(db,projectId,assetId),
 }});
 const colourSource=restored?{...inactive(),handlers:{'timeline.colour.source.inspect':disabled as ServiceHandler}}:createTimelineColourSourceServices(store,{signal:ownerSignal,runtime:{
  assertOrdinaryWorkspace:assertOrdinaryObservation,ownsLock:()=>ownsStoreLock(store),
  readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(db,projectId,assetId),
  validateSource:validateManagedSource,hash:verifiedManagedHash,
  probe:createTimelineColourSourceProbe({run,withProbePermit,checkMediaEffect}),
  terminate:(signal?: AbortSignal)=>terminateMediaProcesses({signal}),waitForClose:(signal?: AbortSignal)=>waitForMediaProcesses({signal}),boundedShutdown,
 }});
 const references=createReferenceServices(store as never,{required,check,hash,now} as Parameters<typeof createReferenceServices>[1]);
 const inspection=createInspectionServices(store);
 const localMutations=createLocalMutationServices(store,{check,canonical,now,references});
 const sourceRanges=createSourceRangeServices(store,{canonical});
 const assetAnnotations=createAssetAnnotationServices(store,{mutate:createMutationReplay(store,{canonical}),error:(...args)=>new AppError(...args as [string,string,number?,unknown?]),restoredSchema:()=>getWorkspaceRestoreContext(store)?.schemaVersion??null});
 const assetDispositions=createAssetDispositionServices(store,{canonical});
 const subjects=createSubjectServices(store,{canonical,now});
 const waveforms=restored?inactive():createWaveformServices(store,{signal:ownerSignal});
 const images=restored?inactive():createImageServices(store,{...imageOptions,signal:ownerSignal,assertLiveAllowed:()=>configuration.assertLiveEnabled()} as Parameters<typeof createImageServices>[1]);
 const frames=restored?inactive():createFrameServices(store,{...frameOptions,signal:ownerSignal} as Parameters<typeof createFrameServices>[1]);
 const scenes=restored?inactive():createSceneServices(store,{...sceneOptions,signal:ownerSignal});
 // Registered after images: finished variant images become subject versions in
 // the image service's publishing transaction.
 const subjectVariants=restored?inactive():createSubjectVariantServices(store);
 const previs=restored?inactive():createPrevisServices(store,{now});
 // Read disclosure verifies only retained subject ownership/provenance. It
 // never evaluates current provider lifecycle, quota, enabled state or POST policy.
 function subjectDisclosure(table: string,value: ServiceRow,projectId?: string,exportId?: string): ServiceRow {
  if(table==='exports')assertFloatTimelineExportRead(db,value,{...(exportId===undefined?{}:{rowIdentity:{id:exportId,...(projectId===undefined?{}:{projectId})}}),isTimelineRenderRecord,readOwnedAsset:(owner: string,id: string)=>readOwnedTimelineAsset(db,owner,id)});
  if(table==='jobs'&&hasSubjectGeneration(value.snapshot)){
   if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','任务的项目归属已改变',409);
   validateSubjectGenerationOwnership(db,value as unknown as GenerationJob);
  }else if(table==='versions'){
   const job=value.jobId?readGenerationLinkedJob(db,value.jobId as string):null;
   if(hasSubjectGeneration(value.snapshot)||hasSubjectGeneration(job?.snapshot)){
    if(projectId!==undefined&&value.projectId!==projectId)throw new AppError('INVALID_GENERATION_OWNERSHIP','版本的项目归属已改变',409);
    if(!job||canonical(value.snapshot)!==canonical(job.snapshot))throw new AppError('INVALID_REFERENCE_MANIFEST','版本与任务的主体参考快照不一致',409);
    const graph=validateSubjectGenerationOwnership(db,job as unknown as GenerationJob);
    graph.version(value.id as string,value.shotId as string,value.assetId as string);
   }
  }
  return value;
 }
 // Retain the source row identity when disclosing exports; a decoded body
 // must not borrow another export's valid request receipt. No write/normalization.
 const exportValues=(projectId: string): ServiceRow[]=>db.prepare('SELECT id,projectId,data FROM exports WHERE projectId=?').all(projectId)
  .map(row=>subjectDisclosure('exports',JSON.parse(String(row.data)) as ServiceRow,stringValue(row.projectId),stringValue(row.id)));
 const handlers: ServiceHandlers={
 ...backupHandlers,
 ...(!restored ? createExportControlServices(store,{signal:ownerSignal}).handlers : {}),
 ...(!restored ? createTaskDispositionServices(store,{ownsLock:()=>ownsStoreLock(store),isReadOnly:()=>Boolean(restored),signal:ownerSignal}).handlers : {}),
  ...luts.handlers,
  ...lookPacks.handlers,
  'workspace.backup.inspect':()=>inspectWorkspaceBackup(store),
  'workspace.restore.inspect':(input: never)=>{const request=recordValue(input)??{};return {restored:false,...(request.includeVolumeEnvelopeCapability?{volumeEnvelopeCapability:readTimelineVolumeEnvelopeCapability(db)}:{}),...(request.includeAudioRoleCapability?{audioRoleCapability:readTimelineAudioRoleCapability(db)}:{})};},
  ...frames.handlers,
  ...scenes.handlers,
  ...images.handlers,
  ...preflight.handlers,
  ...samplePeak.handlers,
  ...loudness.handlers,
  ...mixLoudness.handlers,
  ...clipLoudness.handlers,
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
  ...subjectVariants.handlers,
  ...previs.handlers,
  ...inspection.handlers,
  ...timeline.handlers,
  ...references.handlers,
  ...localMutations.handlers,
  ...projectHome.handlers,
  ...projectLifecycle.handlers,
  'agent.authorization.list':(input: ServiceRow)=>{if(!agentAuthorizations)throw new AgentAuthorizationError('AGENT_AUTHORIZATION_UNAVAILABLE');return agentAuthorizations.list(input);},
  'agent.authorization.grant':(input: ServiceRow)=>{if(!agentAuthorizations)throw new AgentAuthorizationError('AGENT_AUTHORIZATION_UNAVAILABLE');return agentAuthorizations.grant(input);},
  'agent.authorization.revoke':(input: ServiceRow)=>{if(!agentAuthorizations)throw new AgentAuthorizationError('AGENT_AUTHORIZATION_UNAVAILABLE');return agentAuthorizations.revoke(input);},
  'project.create':(input: ServiceRow)=>tx(()=>{const project=put('projects',{id:randomUUID(),name:input.name,description:input.description||'',revision:1,createdAt:now(),updatedAt:now()});if(input.timelinePresetId!==undefined)timeline.initializeProjectFormat(project.id,stringValue(input.timelinePresetId) as never);return project;}),
  'project.list':()=>list('projects').sort((a,b)=>stringValue(property(b,'updatedAt'))?.localeCompare(stringValue(property(a,'updatedAt'))||'')||0),
  'project.get':(input: ServiceRow)=>tx(()=>{const project=required('projects',stringValue(input.projectId) as string);return {project,timeline:timeline.ensure(stringValue(input.projectId) as string),timelineHistory:timeline.history(stringValue(input.projectId) as string),...Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','exports'].map(t=>[t,(t==='exports'?exportValues(stringValue(input.projectId) as string):list(t,stringValue(input.projectId)).map(value=>subjectDisclosure(t,value as ServiceRow,stringValue(input.projectId)))).sort(t==='shots'?(a: ServiceRow,b: ServiceRow)=>(Number(a.orderIndex)||0)-(Number(b.orderIndex)||0):(a: ServiceRow,b: ServiceRow)=>String(a.createdAt??'').localeCompare(String(b.createdAt??'')))]))};}),
  'asset.import':createManagedAssetImportHandler(store,{required,now,signal:ownerSignal,guarded:Boolean(restored),effectFence:()=>restoreEffectFence(store),unsafe:workspaceRestoreError,safeError:(error: unknown)=>Boolean(safeWorkspaceRestoreError(error))}) as ServiceHandler,
  'asset.list':(input: ServiceRow)=>{required('projects',stringValue(input.projectId) as string);return list('assets',stringValue(input.projectId));},
  'edge.create':(input: ServiceRow)=>tx(()=>{required('projects',stringValue(input.projectId) as string);for(const id of [input.source,input.target]){const n=(get('shots',String(id))||get('nodes',String(id))) as ServiceRow|null;if(!n||n.projectId!==input.projectId)throw new AppError('INVALID_EDGE','只能连接同项目的节点');}if(input.source===input.target)throw new AppError('INVALID_EDGE','不能连接到自身');const existing=list('edges',stringValue(input.projectId)).find(edge=>property(edge,'kind')!=='reference'&&property(edge,'source')===input.source&&property(edge,'target')===input.target) as ServiceRow|undefined;return existing||put('edges',{id:randomUUID(),...input,kind:'decorative'});}),
  'edge.delete':(input: ServiceRow)=>tx(()=>{const edge=required('edges',stringValue(input.edgeId) as string);if(edge.kind==='reference')throw new AppError('REFERENCE_CONNECTED','首帧参考连线会影响生成输入；请使用 reference.detach 按镜头版本断开',409,{edgeId:edge.id});db.prepare('DELETE FROM edges WHERE id=?').run(stringValue(input.edgeId) as string);return {deleted:true};}),
  'provider.list':()=>{const asOf=currentProfileDate();return [...providers.values()].map(provider=>capabilitiesFor(provider,asOf));},
  'video.connection.list':()=>{if(restored)disabled();return listVideoConnections(videoSettings,currentProfileDate());},
  'generation.submit':(input: GenerationSubmitInput)=>createJob(input),
  'job.get':(input: ServiceRow)=>subjectDisclosure('jobs',required('jobs',stringValue(input.jobId) as string)),
  'job.list':(input: ServiceRow)=>{required('projects',stringValue(input.projectId) as string);return list('jobs',stringValue(input.projectId)).map(value=>subjectDisclosure('jobs',value as ServiceRow,stringValue(input.projectId)));},
  'job.retry':(input: ServiceRow)=>{
   const old=required('jobs',stringValue(input.jobId) as string) as JobRecord,subjectMode=hasSubjectGeneration(old.snapshot);
   if(subjectMode)validateSubjectGenerationOwnership(db,old);
   const subjectReference=property(old.snapshot,'subjectReference');
   const binding=readVideoBinding(old.snapshot);
   const newInput: GenerationSubmitInput={shotId:old.shotId,expectedRevision:Number(property(old.snapshot,'shotRevision')),requestId:stringValue(input.requestId) as string,providerId:old.providerId,model:old.model,parameters:recordValue(property(old.snapshot,'parameters'))??undefined,retryOfJobId:old.id,...(binding?{connectionId:binding.connectionId,configurationRevision:binding.configurationRevision,modelEntryId:binding.model.id}:{}),...(old.snapshot.videoInput!==undefined?{videoInput:old.snapshot.videoInput}:{}),...(subjectMode?{subjectVersionId:stringValue(property(subjectReference,'subjectVersionId'))}:{})};
   const prior=dedupe('generation',newInput.requestId,hash(newInput),'jobs');if(prior){const priorJob=prior as JobRecord;return subjectMode||hasSubjectGeneration(priorJob.snapshot)?replaySubjectJob(priorJob,newInput,old.id):priorJob;}
   if(old.status!=='failed')throw new AppError('UNSAFE_RETRY','只有明确失败的任务可重新提交；未知提交结果须先对账',409);
   const activeChild=list('jobs',old.projectId).find(child=>property(child,'retryOfJobId')===old.id&&['queued','submitting','running','downloading','submission_unknown'].includes(String(property(child,'status'))));
   if(activeChild)throw new AppError('RETRY_ALREADY_ACTIVE','该失败任务已有重试正在处理，请查询已有任务',409,{jobId:property(activeChild,'id')});
   if(newInput.requestId===old.requestId)throw new AppError('NEW_REQUEST_REQUIRED','重试必须使用新的请求 ID',409);
   if(profilePolicy||usesInputProfiles(providers.get(old.providerId)))assertGenerationJobOwnership(db,old);
   return createJob(newInput,old.snapshot as unknown as JobRecord,old.id);
  },
  'job.cancel':(input: ServiceRow)=>{const j=required('jobs',stringValue(input.jobId) as string) as JobRecord;if(hasSubjectGeneration(j.snapshot))currentGenerationClaim(db,j);if(['succeeded','failed','cancelled'].includes(j.status))return subjectDisclosure('jobs',j);return subjectDisclosure('jobs',saveJob(j,{status:'cancelled',phase:'local_wait_stopped',cancelScope:'local_only',error:{code:'LOCAL_WAIT_STOPPED',message:'已停止本地等待；供应商任务未确认取消，可能仍会完成或计费',retryable:true}}));},
  'job.reconcile':async (input: ServiceRow,{signal:callSignal=ownerSignal}: ServiceHandlerContext={})=>{
   checkpoint(callSignal);
   const j=required('jobs',stringValue(input.jobId) as string) as JobRecord,subjectMode=hasSubjectGeneration(j.snapshot),
    context={jobId:j.id,requestId:j.requestId,providerRegion:property(j.snapshot,'capabilities')&&property(property(j.snapshot,'capabilities'),'region'),signal:callSignal};
   const claim=()=>{if(subjectMode)currentGenerationClaim(db,j);};claim();
   // Paid task observation is not gated by current source availability or a new
   // provider profile. Identity is rechecked after awaits; disclosure is checked
   // only after safe progress is saved, and cannot authorize another submission.
   const disclose=(value: ServiceRow)=>subjectDisclosure('jobs',value);
   if(['succeeded','failed','queued','submitting'].includes(j.status)){if(input.providerJobId)throw new AppError('INVALID_RECONCILIATION_STATE','当前任务状态不允许绑定供应商任务',409);return disclose(j);}
   if(input.providerJobId&&j.providerJobId&&input.providerJobId!==j.providerJobId)throw new AppError('TASK_ID_CONFLICT','已知供应商任务 ID 不可替换',409);
   if(input.providerJobId){
    const requested=String(input.providerJobId);
    const owner=list('jobs').find(other=>property(other,'id')!==j.id&&property(other,'providerId')===j.providerId&&property(other,'providerJobId')===requested&&sameVideoExecutionDomain(property(other,'snapshot'),j.snapshot));if(owner)throw new AppError('TASK_ID_CONFLICT','供应商任务已属于另一个本地任务，不能替换其参数快照',409);
    if(j.providerId==='mock'){const own=await awaitProvider(()=>{const mock=providers.get('mock');if(!mock)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');return mock.reconcile(j.requestId,context);},callSignal);checkpoint(callSignal);claim();if(!isRecord(own)||own.providerJobId!==requested)throw new AppError('TASK_ID_CONFLICT','模拟任务 ID 与此提交请求不匹配',409);}
   }
   const p=resolveGenerationProvider(j);if(!p)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
   const snapshotCapabilities=property(j.snapshot,'capabilities');
   if(property(snapshotCapabilities,'region')&&p.capabilities.region!==property(snapshotCapabilities,'region'))throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);
   const found: {providerJobId: string}|null=input.providerJobId?{providerJobId:String(input.providerJobId)}:j.providerJobId?{providerJobId:j.providerJobId}:await awaitProvider(()=>p.reconcile(j.requestId,context),callSignal).then(value=>isRecord(value)&&typeof value.providerJobId==='string'?{providerJobId:value.providerJobId}:null);checkpoint(callSignal);claim();
   if(!found)return disclose(saveJob(j,{status:'submission_unknown',phase:'reconciliation_required',error:{code:'SUBMISSION_UNKNOWN',message:'无法确认是否已被受理；不会自动重新提交。请在供应商后台核实已有任务 ID',retryable:true}}));
   await awaitProvider(()=>p.poll(found.providerJobId,context),callSignal);checkpoint(callSignal);claim();
   const competing=list('jobs').find(other=>property(other,'id')!==j.id&&property(other,'providerId')===j.providerId&&property(other,'providerJobId')===found.providerJobId&&sameVideoExecutionDomain(property(other,'snapshot'),j.snapshot));if(competing)throw new AppError('TASK_ID_CONFLICT','供应商任务已由另一个本地任务占用',409);
   return disclose(saveJob(j,{status:'running',phase:'polling',providerJobId:found.providerJobId,error:null,cancelScope:null}));
  },
  'version.list':(input: ServiceRow)=>{const s=required('shots',stringValue(input.shotId) as string);return list('versions',stringValue(s.projectId)).filter(v=>property(v,'shotId')===s.id).map(value=>subjectDisclosure('versions',value as ServiceRow,stringValue(s.projectId))).sort((a,b)=>(Number(a.number)||0)-(Number(b.number)||0));},
  'export.create':(input: ServiceRow)=>tx(()=>{const h=hash(input),prior=dedupe('export',stringValue(input.requestId) as string,h,'exports');if(prior)return prior;required('projects',stringValue(input.projectId) as string);const shots=list('shots',stringValue(input.projectId)).sort((a: unknown,b: unknown)=>(Number(property(a,'orderIndex'))||0)-(Number(property(b,'orderIndex'))||0));if(!shots.length||shots.some((s: unknown)=>!property(s,'selectedVersionId')))throw new AppError('MISSING_SELECTION','请为每个镜头选择已生成的视频版本');const versions=shots.map((s: unknown): ServiceRow=>{const shot=s as ServiceRow;const version=required('versions',String(property(shot,'selectedVersionId')));if(restored){const graph=createOwnedMediaGraphReader(db,stringValue(input.projectId) as string),owned=graph.version(String(version.id),String(property(shot,'id')),String(version.assetId)),asset=graph.asset(String(property(owned,'assetId')));if(typeof property(owned,'sha256')!=='string'||property(owned,'sha256')!==property(asset,'sha256'))throw workspaceRestoreError();return owned as ServiceRow;}return version;});const e={id:randomUUID(),projectId:stringValue(input.projectId),requestId:stringValue(input.requestId),status:'queued',outputGeometry:freezeStoryboardOutputGeometry(db,stringValue(input.projectId) as string),orderedVersionIds:versions.map(v=>v.id),snapshot:versions.map(v=>({versionId:v.id,assetId:v.assetId,sha256:v.sha256,shotId:v.shotId})),assetId:null,url:null,error:null,createdAt:now(),updatedAt:now()};put('exports',e);bindAgentTaskJobInside(db,'export',e.id);idem('export',stringValue(input.requestId) as string,h,String(e.id));bindRestoredExport(store,'export.create',input as unknown as {projectId: string; requestId: string},e as unknown as Parameters<typeof bindRestoredExport>[3],h);return e;}),
  'export.get':(input: ServiceRow)=>subjectDisclosure('exports',required('exports',stringValue(input.exportId) as string),undefined,stringValue(input.exportId)),
 } as unknown as ServiceHandlers;
 // Public handlers are the same invocation boundary as RPC. Raw internal
 // mutation closures remain protected at their shared transaction precondition.
 const domainHandlers: ServiceHandlers={...handlers};
 const removeJobStopper=setAgentTaskJobStopper(db,'job',(runId,stepId)=>{
  for(const row of db.prepare("SELECT j.id,j.projectId FROM jobs j JOIN agent_task_job_origins_v2 o ON o.kind='job' AND o.jobId=j.id AND o.projectId=j.projectId WHERE o.runId=? AND (? IS NULL OR o.stepId=?) AND json_valid(j.data) AND json_extract(j.data,'$.status')='queued'").all(runId,stepId??null,stepId??null))withAgentTaskJobOrigin(db,'job',String(row.id),()=>domainHandlers['job.cancel']!({jobId:String(row.id)} as never));
 });
 const removeExportStopper=setAgentTaskJobStopper(db,'export',(runId,stepId)=>{
  for(const row of db.prepare("SELECT e.id,e.projectId FROM exports e JOIN agent_task_job_origins_v2 o ON o.kind='export' AND o.jobId=e.id AND o.projectId=e.projectId WHERE o.runId=? AND (? IS NULL OR o.stepId=?) AND json_valid(e.data) AND json_extract(e.data,'$.status')='queued'").all(runId,stepId??null,stepId??null))withAgentTaskJobOrigin(db,'export',String(row.id),()=>domainHandlers['export.cancel']!({projectId:String(row.projectId),exportId:String(row.id)} as never));
 });
 if(restored)for(const op of Object.keys({...domainHandlers,...(restoredReads?.handlers??{})}))handlers[op]=(input: never,context: ServiceHandlerContext={})=>call(op,input,context);
 async function call(op: string,input: unknown,context: ServiceHandlerContext={}): Promise<unknown> {
  if(op==='lut.look.inspect')assertLookPackInspectInput(input);
  const {signal:callSignal}=context;
  const signals=[ownerSignal,callSignal,restoredLifetime?.signal].filter((value): value is AbortSignal=>Boolean(value));
  const signal: AbortSignal|undefined=restored?(signals.length>1?AbortSignal.any(signals):signals[0]):ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):(ownerSignal||callSignal)??undefined;
  if(restoredLifetime?.signal.aborted)throw workspaceRestoreError();
  checkpoint(signal);
  const operation: Promise<unknown>=(async()=>{
   if(restored){
    if(!restoredReads)throw workspaceRestoreError();
    if(op==='asset.annotation.set'||op==='timeline.export.samplePeak'||op==='timeline.export.loudness'||op==='timeline.loudness.prepare'||op==='timeline.clip.loudness'||op==='timeline.audioPreview.plan'||op==='timeline.audioPreview.continuousPlan'||op==='timeline.colour.source.inspect'||op==='timeline.colour.image.inspect'||op==='timeline.colour.jpeg.inspect')throw workspaceRestoreError();
    const parsed=freezeRestoreInput(parse(op as OperationName,input)) as ServiceRow;
    assertTimelineAudioRoleWorkspace(db,parsed);
    // Colour exists from source schema30 on. Frozen restored profiles admit
    // only their own colour generation: video in 31, video/PNG in 33, and
    // video/PNG/JFIF in 35. No numeric widening: lineage membership is exact.
    if(op==='timeline.clip.add'&&Object.hasOwn(parsed,'colour')||op==='timeline.clip.update'&&isRecord(parsed.patch)&&Object.hasOwn(parsed.patch,'colour')){
     if(!isRestoredWorkspaceSchemaSince(30,restored.schemaVersion))throw workspaceRestoreError();
     const patch=isRecord(parsed.patch)?parsed.patch:null;
     const colour=op==='timeline.clip.add'?parsed.colour:patch?.colour;
     if(restored.schemaVersion===31&&!nullableTimelineClipColourSchema.safeParse(colour).success)throw workspaceRestoreError();
     if(restored.schemaVersion===33&&!nullableTimelineClipColourSchema.safeParse(colour).success&&!timelineImageClipColourSchema.safeParse(colour).success)throw workspaceRestoreError();
    }
    if(Object.hasOwn(restoredReads.readers,op))return restoredReads.call(op,parsed as unknown as Parameters<typeof restoredReads.call>[1],{signal});
    const saved=restoredReads.replay(op,parsed as unknown as Parameters<typeof restoredReads.replay>[1]);if(saved)return publicValue(saved.response);
    if(!RESTORE_LOCAL_OPERATIONS.includes(op)){refuseRestoredOperation(store,op,parsed);}
    if(!hasRestoreInvocation(store,op,parsed))assertWorkspaceRestoreOrigin(store,context);
    return withRestoreInvocation(store,op,parsed,{signal},async frozen=>{
     refuseRestoredOperation(store,op,isRecord(frozen)?frozen:{});
     const result=await domainHandlers[op](frozen as never,{signal});
     restoreEffectFence(store)?.();checkpoint(signal);return publicValue(result);
    });
   }
   if(Object.hasOwn(inspection.handlers,op))return inspection.handlers[op](input as never);
   const parsed=parse(op as OperationName,input);const effect=operationEffect(op);if(!op.startsWith('workspace.backup.')&&op!=='workspace.settings.set'&&(effect.databaseWrite||effect.fileWrite||effect.localProcess)){backups.assertMutationAllowed();assertMutationAllowed?.();}const result=await domainHandlers[op](parsed as never,{signal});checkpoint(signal);
   return publicValue(result);
  })();
  active.add(operation);if(!op.startsWith('workspace.backup.'))nonBackupActive.add(operation);
  try{return await operation;}catch(error){if(property(error,'terminationUnconfirmed'))shutdownFailure=error;throw error;}finally{active.delete(operation);nonBackupActive.delete(operation);}
 }
 // Drain async RPC work before closing SQLite. Rejection is a settled operation;
 // an unbounded filesystem operation is a shutdown failure, never a safe close.
 const drain=async(): Promise<void>=>{
  removeJobStopper();removeExportStopper();
  restoredLifetime?.abort();backups.stop();await backups.drain();
  // Derived cache work may outlive its quick queued RPC acknowledgement. Stop
  // and join its explicit owner before SQLite can close, including late decode.
  const ownerDrains=[waveforms.drain(),preflight.drain(),images.drain(),frames.drain(),scenes.drain(),subjectVariants.drain(),exportAdmission.drain(),samplePeak.drain(),loudness.drain(),mixLoudness.drain(),clipLoudness.drain(),audioPreview.drain(),colourSource.drain(),imageColourSource.drain()];
  const results=await boundedShutdown(Promise.allSettled([...ownerDrains,...active]),'SERVICE_STOP_TIMEOUT');
  if(shutdownFailure)throw shutdownFailure;
  for(const result of results.slice(0,ownerDrains.length))if(result.status==='rejected')throw result.reason;
 };
 // Backend-only scoped entry, deliberately absent from handlers/RPC discovery.
 // It shares the same parsed input, handler, transaction and response journal.
 async function updateShotInProject(projectId: string,input: unknown): Promise<unknown> {
  checkpoint(ownerSignal);
  if(typeof projectId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId))throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(await localMutations.updateShotInProject(projectId,parse('shot.update',input) as Parameters<typeof localMutations.updateShotInProject>[1]));
 }
 // Backend-only reviewed startFrame move; not part of handlers or discovery.
 function moveTimelineClipInProject(projectId: string,input: unknown,target: unknown): unknown {
  checkpoint(ownerSignal);
  if(projectId!==property(input,'projectId')||projectId!==property(target,'projectId'))throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(timeline.moveClipInProject(parse('timeline.clip.update',input) as never,target));
 }
 // Backend-only reviewed gain. The fixed boundary reuses the same clip update transaction.
 function setTimelineClipGainInProject(projectId: string,input: unknown,target: unknown): unknown {
  checkpoint(ownerSignal);
  if(projectId!==property(input,'projectId')||projectId!==property(target,'projectId'))throw new AppError('VALIDATION_ERROR','项目范围无效');
  return publicValue(timeline.setClipGainInProject(parse('timeline.clip.update',input) as never,target));
 }
 // Only queued/new provider dispatch uses lifecycle validation. Paid task
 // polling, download and reconciliation deliberately never call this boundary.
 function validateGenerationDispatch(job: JobRecord): unknown {
  if(restored)disabled();
  assertAgentTaskJobEffect(db,'job',job.id);
  const binding=readVideoBinding(job.snapshot);
  if(binding){
   configuration.assertLiveEnabled();
   currentGenerationClaim(db,job);resolveGenerationProvider(job);
   const graph=hasSubjectGeneration(job.snapshot)?validateSubjectGenerationOwnership(db,job):null;
   return prepareConfiguredVideoInputs({source:job.snapshot,binding,projectId:job.projectId,readAsset:id=>graph?graph.asset(id):readGenerationAsset(db,id,job.projectId),frozen:true,asOf:currentProfileDate()});
  }
  const provider=providers.get(job.providerId);
  if(provider&&!provider.capabilities.mock&&(profilePolicy||usesInputProfiles(provider)))configuration.assertLiveEnabled();
  const subjectMode=hasSubjectGeneration(job.snapshot);
  if(!profilePolicy&&!usesInputProfiles(provider)&&!subjectMode)return null;
  const subjectGraph=subjectMode?validateSubjectGenerationOwnership(db,job):null;
  currentGenerationClaim(db,job);
  if(!provider||provider.id!==job.providerId)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
  const capabilities=capabilitiesFor(provider);
  if(property(job.snapshot,'providerId')!==job.providerId||property(job.snapshot,'model')!==job.model)throw new AppError('INVALID_REFERENCE_MANIFEST','任务身份与冻结快照不一致');
  return prepareGenerationInputs({source:job.snapshot as GenerationSource,projectId:job.projectId,providerId:job.providerId,model:job.model,capabilities,readAsset:(id: string)=>subjectGraph?subjectGraph.asset(id):readGenerationAsset(db,id,job.projectId),asOf:capabilities.profileEvaluationDate,frozen:true});
 }
 // Limit this ownership fence to unaccepted claims and restart classification.
 // Policy rejection must not authorize writing a foreign or replaced record.
 let invalidGenerationReported=false;
 function saveGenerationGuarded(job: JobRecord,patch: ServiceRow): ServiceRow|null {
  if(restored)disabled();
  const hasVideoBinding=job.snapshot!==null&&typeof job.snapshot==='object'&&Object.hasOwn(job.snapshot,'executionBinding');
  if(!profilePolicy&&!usesInputProfiles(providers.get(job.providerId))&&!hasSubjectGeneration(job.snapshot)&&!hasVideoBinding)return saveJob(job,patch);
  return tx(()=>{
   let current: ServiceRow;try{current=currentGenerationClaim(db,job);}catch{
    if(!invalidGenerationReported){invalidGenerationReported=true;console.error('Skipped invalid local generation record.');}
    return null;
   }
   return saveJob(current as JobRecord,patch);
  });
 }
 return {compensateAgentTimelineInside:timeline.compensateAgentTargetsInside,setProjectDeletionCompanions:projectLifecycle.setProjectDeletionCompanions,call,drain,isQuiescent:()=>active.size===0,configuration,backups,audioPreview,saveGenerationGuarded,validateGenerationDispatch,resolveGenerationProvider,updateShotInProject:restored?disabled:updateShotInProject,moveTimelineClipInProject:restored?disabled:moveTimelineClipInProject,setTimelineClipGainInProject:restored?disabled:setTimelineClipGainInProject,required,check,event,saveJob,createJob,handlers,publicValue,inspection,imageApproval:images.approveReviewed as (input: unknown)=>unknown,imageRejection:images.rejectReview as (input: unknown)=>unknown} as OrdinaryServices;
}

import {exportAssetName, generatedVideoAssetName} from './output-asset-names.ts';
import {isBackgroundTaskIndexUncertain} from './background-task-events.ts';
import type {BackgroundTaskRef} from './background-task-events.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {assertProjectStore} from './store-runtime.ts';
import {isCanvasArchived} from './canvas-active.ts';
import {createProjectBackgroundState,pauseUnavailableBackgroundTask,markBackgroundTaskInvalid} from './background-task-state.ts';
import {registerExportActivity,isCancelledExport,exportStage} from './export-controls.ts';
import {assertAgentTaskJobEffect,withAgentTaskJobOrigin,recordAgentTaskJobDispatch,allowAgentTaskJobTargetMutation,isAgentTaskEffectBlocked,agentTaskJobBinding,isAgentTaskJobStopped} from './agent/task-effects-v2.ts';
import {isFloatTimelineExport,claimFloatTimelineExport,sameFloatTimelineAttempt,requeueFloatTimelineExport,createFloatTimelineAttemptRegistry,ownedFloatTimelineMeasurement,bindFloatTimelineMeasurement,bindFloatTimelineFailure,assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {createTimelineColourLutReader,verifyTimelineColourLuts} from './timeline-colour-lut.ts';
import {requiresPreparedTimelineExportIdentity,hasSelectedTimelineExportRange,timelineExportRangeEffectError} from './timeline-export-range.ts';
import {timelineRenderDeliveryFields,hasTimelineDeliveryIdentity,TIMELINE_DELIVERY_RECEIPT_SQL} from '@mioon/contracts/timeline-delivery';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {isTimelineExportSnapshot,isTimelineRenderRecord} from '@mioon/contracts';
import {lstatSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {terminateMediaProcesses,waitForMediaProcesses} from './media-processes.ts';
import {rename,link,unlink,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {fileInfo,probe,safePath,stitch,run} from './media.ts';
import {storyboardOutputGeometry} from './storyboard-output.ts';
import {renderTimeline} from './timeline-media.ts';
import {readTimelineReceipt} from './timeline-recovery.ts';
import {prepareTimelineInputs,readOwnedTimelineAsset,validateFrozenTimelineSourceGraph,validatePreparedTimelineSources} from './timeline-sources.ts';
import {now} from './services.ts';
import {validateManagedSource, verifiedManagedHash} from './managed-media.ts';
import {ensureProjectOutputDirectory, registeredProjectStore, registeredProjectAssetReferences, referenceForPublishedMedia} from './project-media-storage.ts';
import type {JobRecord,OrdinaryServices,ServiceStore,ServiceRow} from './services.ts';
import type {Provider} from './provider-registry.ts';
import {readVideoBinding} from './video/generation.ts';
import {effectiveVideoParameters,isWan30Binding} from '../../contracts/src/wan-video.ts';
import {isSeedance25Binding} from '../../contracts/src/seedance-video.ts';
import {markGenerationPreflightFailure,isGenerationPreflightFailure,currentGenerationClaim,readGenerationLinkedJob} from './generation-inputs.ts';
import {assertMediaTerminated,awaitProvider,boundedShutdown,checkpoint} from './operation-lifecycle.ts';
import {publishProjectOutput,markProjectOutputRegistered,assertPublishedProjectOutput,registerVerifiedProjectOutputs} from './project-output-publication.ts';
import {createOutputArtifactStage,readOutputArtifact,writeOutputArtifact,outputArtifactStage,outputArtifactDigest,restoredArtifactAudioCheck,assertOutputArtifactStage,sealOutputArtifactStage} from './output-artifact-storage.ts';
import type {OutputArtifact} from '../../contracts/src/output-artifact.ts';
import {exportOutputArtifactIdentity} from '../../contracts/src/output-artifact.ts';
import type {ProjectOutputOwner} from '../../contracts/src/project-output-publication.ts';

type Services=Pick<OrdinaryServices,'saveJob'|'saveGenerationGuarded'|'validateGenerationDispatch'|'resolveGenerationProvider'>;

async function paidReferenceHash<T>(operation: Promise<T>): Promise<T> {
 try{return await operation;}catch(error){
  if(error&&typeof error==='object'&&'code' in error&&(error.code==='MEDIA_CHANGED'||error.code==='MEDIA_CHANGED_DURING_READ'))throw Object.assign(new Error('参考素材与已确认内容不一致'),{code:'REFERENCE_CHANGED',cause:error});
  throw error;
 }
}

type ExportRecord=Record<string, unknown>&{id: string; projectId: string; status: string};
type ExportSnapshotRow=Record<string, unknown>;
interface JobsStore {
 readonly db: DatabaseSync;
 readonly root: string;
 list(table: string,projectId?: string): unknown[];
 get(table: string,id: string): unknown;
 put<T extends object>(table: string,value: T): T;
 tx<T>(callback: ()=>T): T;
}
export type WorkerOperation=(value: never,signal: AbortSignal)=>Promise<unknown>;
export interface Worker {
 readonly stop: ()=>Promise<void>;
 readonly tick: ()=>Promise<void>;
 readonly isBusy: ()=>boolean;
}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const recordValue=(value: unknown): Record<string, unknown>|null=>isRecord(value)?value:null;
const stringValue=(value: unknown): string|undefined=>typeof value==='string'?value:undefined;
const numberValue=(value: unknown): number|undefined=>typeof value==='number'?value:undefined;
const arrayValue=(value: unknown): unknown[]=>Array.isArray(value)?value:[];
const isThenable=(value: unknown): value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?: unknown}).then==='function';
const isKnownAgentTaskBlock=(error: unknown): boolean=>isAgentTaskEffectBlocked(error)&&['AGENT_TASK_PAUSED','AGENT_TASK_STOPPED','AGENT_TASK_CONSENT_REQUIRED','AGENT_TASK_TARGET_CHANGED','AGENT_TASK_TARGET_CLAIMED','AGENT_TASK_APPROVAL_REQUIRED'].includes(stringValue(property(error,'code'))??'');

export function startWorker(inputStore: ServiceStore,services: Services,providers: ReadonlyMap<string,Provider>,{signal:ownerSignal}: {signal?: AbortSignal}={}): Worker {
 const store: JobsStore=inputStore as unknown as JobsStore;
 assertProjectStore(inputStore);
 const ownerProjectId=inputStore.projectId;
 const {list,get,put,tx,root}=store;
 const backgroundTasks=createProjectBackgroundState(inputStore);
 let stopped=Boolean(ownerSignal?.aborted),cycle: Promise<void>|null=null,stopping: Promise<void>|undefined,shutdownFailure: unknown;
 const operations=new Set<AbortController>(),floatClaims=createFloatTimelineAttemptRegistry();
 const invalidCandidates=new Map<string,{ref:BackgroundTaskRef;frozenJob?:string}>();
 const frozenJobIdentity=(job: Record<string,unknown>): string=>createHash('sha256').update(JSON.stringify([
  ...['id','projectId','shotId','providerId','model','requestId','requestHash','retryOfJobId'].map(name=>[name,typeof job[name],job[name]??null]),['snapshot',job.snapshot],
 ])).digest('hex');
 const observeInvalid=(kind: 'job'|'export',taskId: string,frozenJob?:string): void=>{invalidCandidates.set(`${kind}:${taskId}`,{ref:{kind,taskId},...(frozenJob?{frozenJob}:{})});};
 const invalidTimeline=(error: unknown): boolean=>error instanceof Error&&property(error,'code')==='INVALID_TIMELINE_SNAPSHOT'&&property(error,'status')===409;
 const saveGenerationGuarded=(job: JobRecord,patch: ServiceRow): ServiceRow|null=>{
  const value=services.saveGenerationGuarded(job,patch);if(value===null)observeInvalid('job',job.id,frozenJobIdentity(job));return value;
 };
 // Preserve relational identity before decoding worker-owned timeline exports.
 // This bound applies to the frozen export row, never its source bytes or the
 // combined jobs behind its lineages. Corrupt/oversized timeline rows are
 // left untouched. SQLite classifies mode before materialization; ordinary
 // storyboard rows retain their existing unbounded legacy handling.
 const exportUuid=(value: string): boolean=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
 const exportRowBytes=4*1024*1024,identity=(column: string): string=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
 const exportColumns=`${identity('id')},${identity('projectId')},
  CASE WHEN typeof(data)='text' THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data)='object' THEN
   CASE WHEN (SELECT count(*) FROM json_each(exports.data) WHERE key='mode')<=1 THEN
    CASE WHEN json_type(data,'$.mode')='text' AND length(CAST(json_extract(data,'$.mode') AS BLOB))=8 AND json_extract(data,'$.mode')='timeline'
     THEN CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${exportRowBytes} THEN data END
     ELSE ${'data'} END
   END END END END AS data`;
 let invalidExportReported=false;
 const invalidExport=(): null=>{if(!invalidExportReported){invalidExportReported=true;console.error('Skipped invalid local export record.');}return null;};
 function decodeExport(row: Record<string, unknown>|null|undefined): ExportRecord|null {
  if(!row)return null;
  if(typeof row.data!=='string')return invalidExport();
  let record: unknown;try{record=JSON.parse(row.data);}catch{return invalidExport();}
  if(!isRecord(record)||!exportUuid(String(row.id))||!exportUuid(String(row.projectId))||!exportUuid(String(record.id))||!exportUuid(String(record.projectId)))return invalidExport();
  const value=record as ExportRecord;
  if(value.id!==row.id||value.projectId!==row.projectId)return invalidExport();
  if(value.mode==='timeline'&&property(property(value.snapshot,'timeline'),'projectId')!==row.projectId)return invalidExport();
  try{assertFloatTimelineExportRead(store.db,record,{isTimelineRenderRecord,readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(store.db,projectId,assetId)});}catch(error){if(!invalidTimeline(error))throw error;return invalidExport();}
  return value;
 }
 const workerExport=(id: string,observe=true): ExportRecord|null=>{
  const value=decodeExport(store.db.prepare(`SELECT ${exportColumns} FROM exports WHERE id=?`).get(id) as Record<string,unknown>|undefined);
  if(!value&&observe)observeInvalid('export',id);return value;
 };
 // Custom delivery adds an awaited capability step. Preserve the complete
 // immutable acceptance identity across every existing async/publication fence;
 // a replaced snapshot must never be restored by publishing an older copy.
 const customExport=(e: ExportRecord): boolean=>requiresPreparedTimelineExportIdentity(e)||Boolean(e.snapshot&&isRecord(e.snapshot)&&Object.hasOwn(e.snapshot,'colourPlan'));
 const exportIdentity=(e: ExportRecord): string=>JSON.stringify(Object.fromEntries(['id','projectId','requestId','mode','purpose','timelineRevision','snapshot','createdAt'].map(key=>[key,e[key]])));
 // A removed delivery field must not disguise an accepted custom export as
 // a historical legacy job before the worker's first observation. The bounded
 // receipt-side discriminator adds no normalization or legacy render options.
 function receiptHasDelivery(e: ExportRecord): boolean {
  if(e.mode!=='timeline'||typeof e.requestId!=='string')return false;
  const row=store.db.prepare(`SELECT CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${exportRowBytes}
   THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response)='object' THEN ${TIMELINE_DELIVERY_RECEIPT_SQL} END END END AS delivery
   FROM timeline_requests WHERE requestId=?`).get(e.requestId);
  return property(row,'delivery')!==undefined&&property(row,'delivery')!==null;
 }
 function customReceiptMatches(e: ExportRecord): boolean {
  try{
   const input={projectId:e.projectId,requestId:e.requestId,expectedRevision:e.timelineRevision,purpose:e.purpose,...timelineRenderDeliveryFields(e.snapshot)};
   if(typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200)return false;
   const receipt=readTimelineReceipt(store.db,input as never,'timeline.render');
   if(!receipt)return false;
   const response: unknown=JSON.parse(String(receipt.response));
   return property(response,'status')==='queued'&&isTimelineRenderRecord(response,input as never)&&exportIdentity(response as ExportRecord)===exportIdentity(e);
  }catch(error){if(!(error instanceof SyntaxError)&&!invalidTimeline(error))throw error;return false;}
 }
 const currentOwnedExport=(e: ExportRecord,{cleanupOnly=false,observe=true}: {cleanupOnly?: boolean;observe?: boolean}={}): ExportRecord|null=>{
  const latest=workerExport(e.id,observe),refused=(): null=>{if(observe)observeInvalid('export',e.id);return null;};

  if(!latest||latest.mode!==e.mode||latest.id!==e.id||latest.projectId!==e.projectId)return refused();
  if((hasTimelineDeliveryIdentity(e)||hasTimelineDeliveryIdentity(latest)||receiptHasDelivery(e))&&(exportIdentity(latest)!==exportIdentity(e)||!customReceiptMatches(e)))return refused();
  if(!cleanupOnly&&!sameFloatTimelineAttempt(e,latest as never))return refused();
  return latest;
 };
 function verifyInvalidCandidates(): void {
  // A failed fence inside a transaction is only a candidate. Reread the exact
  // committed identity after it ends; rollback or a newer valid row must not
  // publish a phantom block. SQL/audit faults are not proof of invalid data.
  if(store.db.isTransaction)return;
  const candidates=[...invalidCandidates.values()];invalidCandidates.clear();
  for(const {ref,frozenJob} of candidates){
   backgroundTasks.refresh([ref]);
   let invalid=false;
   if(ref.kind==='job')try{
    const current=readGenerationLinkedJob(store.db,ref.taskId);
    if(current.id!==ref.taskId||current.projectId!==ownerProjectId||typeof current.shotId!=='string'||!isRecord(current.snapshot))invalid=true;
    else{
     currentGenerationClaim(store.db,current as unknown as JobRecord);
     // An abandoned unaccepted attempt cannot continue with changed frozen
     // input. Mutable progress/revision fields do not establish corruption.
     if(frozenJob&&['queued','submitting'].includes(String(current.status))&&frozenJobIdentity(current)!==frozenJob)invalid=true;
    }
   }catch(error){if(!(error instanceof AppError)||!['INVALID_GENERATION_OWNERSHIP','GENERATION_STATE_CHANGED'].includes(error.code))throw error;invalid=true;}
   else if(ref.kind==='export'){
    const current=workerExport(ref.taskId,false);invalid=!current||!currentOwnedExport(current,{observe:false});
   }
   if(invalid)markBackgroundTaskInvalid(store.db,ref);
  }
 }

 // An unconfirmed owned writer is a fatal lifecycle boundary. Preserve the
 // first failure and stop this cycle plus every future automatic/manual tick.
 const failShutdown=(error: unknown): void=>{if(shutdownFailure===undefined||shutdownFailure===null)shutdownFailure=error;abort();};
 const mediaPauseError=(table: string,status: string): {code: string; message: string; retryable: boolean}=>table==='jobs'&&status==='submission_unknown'
  ?{code:'SUBMISSION_UNKNOWN',message:'供应商可能已受理，结果尚未确认；不会自动重新提交生成。本地媒体进程退出尚未确认，后台已暂停后续任务。',retryable:false}
  :{code:'MEDIA_TERMINATION_UNCONFIRMED',message:'本地媒体进程退出尚未确认，后台已暂停后续任务。已保留现有任务与快照，请确认进程退出后重新启动。',retryable:false};
 const persistMediaPause=(table: string,id: string,projectId: string,mode?: unknown,attempt?: unknown): void=>{
  const apply=(): void=>{
   const latest=table==='exports'?workerExport(id):recordValue(get(table,id)) as (JobRecord&Record<string,unknown>)|null;
   const status=stringValue(property(latest,'status'));
   if(!latest||status===undefined||['succeeded','cancelled'].includes(status)||table==='exports'&&(property(latest,'mode')!==mode||property(latest,'projectId')!==projectId))return;

   if(table==='exports'&&isFloatTimelineExport(latest)&&(!attempt||!sameFloatTimelineAttempt(attempt,latest)))return;
   const error=mediaPauseError(table,status);
   if(property(property(latest,'error'),'code')===error.code&&property(property(latest,'error'),'message')===error.message)return;
   if(table==='jobs')services.saveJob(latest as JobRecord,{error});
   else put('exports',{...latest,error,updatedAt:now()});
  };
  if(table==='exports')tx(apply);else apply();
 };
 const safeError=(e: unknown,fallback='PROVIDER_ERROR'): {code: string; message: string; retryable: boolean}=>{
  const code=stringValue(property(e,'code'))||fallback;
  // Only Node filesystem errors carry this errno/syscall/path combination;
  // domain owner/effect codes and aborts retain their existing diagnostics.
  const filesystem=property(e,'name')!=='AbortError'&&(/^(?:E[A-Z0-9]+|UNKNOWN)$/u.test(code)||code.startsWith('ERR_FS_'))&&typeof property(e,'syscall')==='string'&&(typeof property(e,'path')==='string'||typeof property(e,'dest')==='string');
  const message=property(e,'uncertain')?'供应商可能已受理。正在对账，不会自动重新提交。':filesystem?'本地产物文件不可用，已保留任务记录':String(property(e,'message')||'任务操作失败');
  return {code,message:message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi,'[redacted]').slice(0,600),retryable:true};
 };
 let invalidQueuedReported=false;
 for(const ref of backgroundTasks.snapshot().filter(task=>task.kind==='job')){
  const job=recordValue(get('jobs',ref.taskId)) as JobRecord|null;
  if(job?.status==='queued'&&ref.reason==='BACKGROUND_TASK_INVALID'){
   // Projection already refused this identity. Preserve the former worker's
   // ownership diagnostic once on handover, without entering a write/dispatch
   // path or making a refused row hold a continuation lease.
   try{if(job.id!==ref.taskId||job.projectId!==inputStore.projectId)throw Error('Invalid project task owner');currentGenerationClaim(store.db,job);}
   catch{if(!invalidQueuedReported){invalidQueuedReported=true;console.error('Skipped invalid local generation record.');}}
   continue;
  }
  if(job&&job.status==='submitting')saveGenerationGuarded(job,{status:'submission_unknown',phase:'recovering_submit',error:{code:'SUBMISSION_UNKNOWN',message:'服务在提交期间中断；先对账，绝不盲目重新提交',retryable:true}});
  else if(job&&(job.status==='submission_unknown'||job.phase==='connection_required'&&['queued','running','downloading'].includes(job.status)))services.saveJob(job,{nextPollAt:0});
 }
 for(const ref of backgroundTasks.snapshot().filter(task=>task.kind==='export')){const e=workerExport(ref.taskId);if(e?.status==='running')tx(()=>{
  const current=currentOwnedExport(e);if(current?.status==='running')put('exports',{...(isFloatTimelineExport(current)?requeueFloatTimelineExport(current):current),status:'queued',updatedAt:now()});
 });}
 backgroundTasks.refresh();
 verifyInvalidCandidates();

 async function processJob(original: JobRecord,signal: AbortSignal): Promise<void> {
  checkpoint(signal);
  let j=recordValue(get('jobs',original.id)) as JobRecord|null;
  if(!j)return;
  let provider:Provider|undefined;
  const context: Record<string, unknown>={requestId:j.requestId,jobId:j.id,providerRegion:property(j.snapshot,'capabilities')&&property(property(j.snapshot,'capabilities'),'region'),signal};
  let acceptedProviderId: string|null=null,guardJob=j,postPermitted=false,blockedGate=false;
  const submissionCount=numberValue(j.submissionCount)??0;
  const nextPollAt=numberValue(j.nextPollAt);
  if(nextPollAt&&Date.now()<nextPollAt)return;
  try {
   const localOwner=registeredProjectStore(root),localComplete=j.status==='downloading'&&localOwner?readOutputArtifact(localOwner,{kind:'generation',id:j.id,requestId:j.requestId,inputHash:j.requestHash},'generation',outputArtifactDigest(JSON.stringify([j.projectId,j.id,j.requestId,j.requestHash,j.providerId,j.providerJobId,j.model,j.snapshot]))):null;
   provider=localComplete?providers.get(j.providerId):services.resolveGenerationProvider?services.resolveGenerationProvider(j):providers.get(j.providerId);
   if(j.status==='queued') {
    assertAgentTaskJobEffect(store.db,'job',j.id);
    if(!provider)throw Object.assign(Error('Provider is unavailable'),{code:'PROVIDER_NOT_FOUND'});
    services.validateGenerationDispatch(j);
    const preparedSnapshot=JSON.stringify(j.snapshot);
    // Prepare references before recording an attempt. A shutdown here has not
    // called an adapter and must leave the original queued snapshot untouched.
    const referenceAssets: Record<string, unknown>[]=[];
    for(const rawReference of arrayValue(property(j.snapshot,'referenceAssets'))) {
     checkpoint(signal);
     const reference=recordValue(rawReference);if(!reference)throw Error('Reference snapshot no longer matches managed asset');
     const asset=recordValue(get('assets',String(reference.id)));
     if(!asset||asset.projectId!==j.projectId||asset.sha256!==reference.sha256)throw Error('Reference snapshot no longer matches managed asset');
     const references=registeredProjectAssetReferences(root);
     if(references&&(asset.referenceRevision!==reference.referenceRevision||JSON.stringify(asset.reference)!==JSON.stringify(reference.reference)))throw Error('Reference revision no longer matches frozen asset');
     const admitted=references?await paidReferenceHash(references.prepareFullHash(String(asset.id),{signal,expectedReferenceRevision:Number(reference.referenceRevision),maxBytes:100*1024*1024,beforeEffect:()=>{services.validateGenerationDispatch(j!);checkpoint(signal);}})):null;
     if(admitted&&admitted.sha256!==reference.sha256)throw Error('Reference bytes differ from frozen full hash');
     const file=admitted?.file??await safePath(root,String(asset.relativePath));checkpoint(signal);
     // A source owner can change during an awaited path read, before an
     // adapter's own byte reads and final POST fence begin.
     services.validateGenerationDispatch(j);
     referenceAssets.push({...reference,...(references?{projectId:asset.projectId,reference:asset.reference,referenceRevision:asset.referenceRevision}:{}),path:file});
    }
    // Seedance 2.5 reference audio gets the same ownership, hash and path checks.
    const referenceAudios: Record<string, unknown>[]=[];
    for(const rawAudio of arrayValue(property(j.snapshot,'referenceAudios'))) {
     checkpoint(signal);
     const audio=recordValue(rawAudio);if(!audio)throw Error('Reference snapshot no longer matches managed asset');
     const asset=recordValue(get('assets',String(audio.id)));
     if(!asset||asset.projectId!==j.projectId||asset.sha256!==audio.sha256)throw Error('Reference snapshot no longer matches managed asset');
     const references=registeredProjectAssetReferences(root);
     if(references&&(asset.referenceRevision!==audio.referenceRevision||JSON.stringify(asset.reference)!==JSON.stringify(audio.reference)))throw Error('Reference revision no longer matches frozen audio');
     const admitted=references?await paidReferenceHash(references.prepareFullHash(String(asset.id),{signal,expectedReferenceRevision:Number(audio.referenceRevision),maxBytes:100*1024*1024,beforeEffect:()=>{services.validateGenerationDispatch(j!);checkpoint(signal);}})):null;
     if(admitted&&admitted.sha256!==audio.sha256)throw Error('Audio bytes differ from frozen full hash');
     const file=admitted?.file??await safePath(root,String(asset.relativePath));checkpoint(signal);
     services.validateGenerationDispatch(j);
     referenceAudios.push({...audio,...(references?{projectId:asset.projectId,reference:asset.reference,referenceRevision:asset.referenceRevision}:{}),path:file});
    }
    checkpoint(signal);
    const current=recordValue(get('jobs',j.id)) as JobRecord|null;
    if(!current||current.status!=='queued')return;
    j=current;
    if(JSON.stringify(j.snapshot)!==preparedSnapshot)throw Object.assign(Error('准备素材期间冻结快照已改变'),{code:'INVALID_REFERENCE_MANIFEST'});
    services.validateGenerationDispatch(j);
    const claimed=saveGenerationGuarded(guardJob,{status:'submitting',phase:'provider_submit',submissionCount:submissionCount+1});
    if(!claimed)return;
    j=claimed as JobRecord;guardJob=j;
    const claim=j;
    // Shared HTTP adapters invoke this synchronous fence after image preparation
    // and immediately before POST. No callback is used for poll/download/reconcile.
    const assertClaim=()=>{
     try{
      const latest=recordValue(get('jobs',claim.id));
      if(!latest||latest.status!=='submitting'||latest.revision!==claim.revision||JSON.stringify(latest.snapshot)!==preparedSnapshot)throw Object.assign(Error('提交前任务状态已更改'),{code:'GENERATION_STATE_CHANGED'});
      services.validateGenerationDispatch(claim);
     }catch(error){if(isAgentTaskEffectBlocked(error))blockedGate=true;throw markGenerationPreflightFailure(error as object);}
    };
    // During both image reads the same non-mutating claim/ownership fence
    // rejects drift. The final beforeSubmit fence still runs directly at POST.
    context.beforeSubmit=()=>{assertClaim();if(j!.providerId!=='mock')recordAgentTaskJobDispatch(store.db,'job',claim.id);postPermitted=true;};
    (context as unknown as {validateReferenceState: ()=>void}).validateReferenceState=assertClaim;
    const accepted: unknown=await awaitProvider(()=>provider!.submit({...j!.snapshot,referenceAssets,...(referenceAudios.length?{referenceAudios}:{})},context as never),signal,{submit:true});
    acceptedProviderId=stringValue(property(recordValue(accepted),'providerJobId'))??null;
    // Receipt persistence is the sole intentional write permitted after abort.
    // awaitProvider only delivers receipts inside its bounded settlement window.
    const latest=recordValue(get('jobs',j.id)) as JobRecord|null;
    if(latest)services.saveJob(latest,{providerJobId:acceptedProviderId,...latest.status==='cancelled'?{}:{status:'running',phase:'polling',progress:5,error:null}});
    return;
   }
   if(!provider&&!localComplete)throw Object.assign(Error('Provider is unavailable'),{code:'PROVIDER_NOT_FOUND'});
   if(j.status==='submission_unknown') {
    const found: unknown=j.providerJobId?{providerJobId:j.providerJobId}:await awaitProvider(()=>provider!.reconcile(String(j!.requestId),context as never),signal);
    checkpoint(signal);
    if(found&&isRecord(found)&&typeof found.providerJobId==='string')services.saveJob(j as JobRecord,{status:'running',phase:'reconciled',providerJobId:found.providerJobId,error:null,nextPollAt:0});
    else services.saveJob(j as JobRecord,{nextPollAt:Date.now()+5000});
    return;
   }
   if(j.status==='running') {
    const remote=await awaitProvider(()=>provider!.poll(String(j!.providerJobId),context as never),signal);checkpoint(signal);
    const latestStatus=stringValue(property(get('jobs',j.id),'status'));
    if(latestStatus==='cancelled')return;
    if(remote.status==='failed'){services.saveJob(j,{status:'failed',phase:'provider_failed',error:typeof remote.error==='object'?remote.error:{code:'GENERATION_FAILED',message:remote.error||'供应商任务失败',retryable:true}});return;}
    if(remote.status!=='succeeded'){services.saveJob(j,{progress:remote.progress==null?j.progress:Math.round(remote.progress*100),nextPollAt:Date.now()+(numberValue(property(provider!.capabilities,'minPollIntervalMs'))||350),error:null});return;}
    j=services.saveJob(j,{status:'downloading',phase:'downloading',progress:90,nextPollAt:0,error:null}) as JobRecord;
   }
   if(j.status==='downloading') {
    checkpoint(signal);
    const projectOwner=registeredProjectStore(root),owner:ProjectOutputOwner={kind:'generation',id:j.id,requestId:j.requestId,inputHash:j.requestHash},sourceIdentity=outputArtifactDigest(JSON.stringify([j.projectId,j.id,j.requestId,j.requestHash,j.providerId,j.providerJobId,j.model,j.snapshot]));
    // Local completion retains an already accepted result; dispatch authorization
    // remains at the queued/POST fences and selection has its own target gate.
    const checkOutput=():void=>{checkpoint(signal);const latest=recordValue(get('jobs',j!.id));if(!latest||latest.status!=='downloading'||outputArtifactDigest(JSON.stringify([latest.projectId,latest.id,latest.requestId,latest.requestHash,latest.providerId,latest.providerJobId,latest.model,latest.snapshot]))!==sourceIdentity)throw Object.assign(Error('Generation output owner changed'),{code:'GENERATION_STATE_CHANGED'});if(projectOwner&&artifact&&lstatSync(outputArtifactStage(projectOwner,artifact),{throwIfNoEntry:false}))assertOutputArtifactStage(projectOwner,artifact);};
    let artifact=projectOwner?readOutputArtifact(projectOwner,owner,'generation',sourceIdentity):null;
    const relativePath=`media/result-${j.id}.mp4`,file=path.join(root,relativePath),part=projectOwner?(artifact?outputArtifactStage(projectOwner,artifact):createOutputArtifactStage(projectOwner,owner,'generation')):file+'.part.mp4';
    let info;
    if(artifact)info=artifact.info;
    else if(projectOwner){
     if(!provider)throw Object.assign(Error('The completed local artifact is no longer available'),{code:'INVALID_OUTPUT_ARTIFACT'});
     checkOutput();await awaitProvider(()=>provider!.download(String(j!.providerJobId),part,context as never),signal);checkOutput();
     sealOutputArtifactStage(projectOwner,owner,part);checkOutput();
     const identity=lstatSync(part,{bigint:true});
     const beforeEffect=():void=>{checkOutput();const current=lstatSync(part,{bigint:true});if(!current.isFile()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||current.birthtimeNs!==identity.birthtimeNs||current.size!==identity.size||current.mtimeNs!==identity.mtimeNs||current.ctimeNs!==identity.ctimeNs)throw Object.assign(Error('Generated artifact changed during validation'),{code:'INVALID_OUTPUT_ARTIFACT'});};
     info=await fileInfo(part,{signal,beforeEffect});beforeEffect();
     if(!info.hasVideo)throw Error('Generated output must contain video');
     await run('ffmpeg',['-v','error','-i',part,'-f','null','-'],{signal,beforeEffect});beforeEffect();
    }else try {
     info=await fileInfo(file,{signal});checkpoint(signal);
     if(!info.hasVideo)throw Error('Generated output must contain video');
    } catch(error) {
     if(property(error,'terminationUnconfirmed'))throw error;
     checkpoint(signal);
     await awaitProvider(()=>provider!.download(String(j!.providerJobId),part,context as never),signal);checkpoint(signal);
     info=await fileInfo(part,{signal});checkpoint(signal);
     if(!info.hasVideo)throw Error('Generated output must contain video');
     await run('ffmpeg',['-v','error','-i',part,'-f','null','-'],{signal});checkpoint(signal);
     await rename(part,file);checkpoint(signal);
    }
    if(stringValue(property(get('jobs',j.id),'status'))==='cancelled')return;
    if(!artifact&&!provider!.capabilities.mock) {
     const binding=readVideoBinding(j.snapshot),wan30=Boolean(binding&&isWan30Binding(binding)),seedance=Boolean(binding&&isSeedance25Binding(binding));
     const effective=binding?effectiveVideoParameters(binding,j.snapshot):null;
     const expectedAspectRatio=wan30||seedance?effective!.aspectRatio:property(j.snapshot,'aspectRatio');
     const [ratioWidth,ratioHeight]=String(expectedAspectRatio).split(':').map(Number);
     // Seedance's documented 480p 21:9 size, 992×432, is 1.6% off the exact ratio.
     const actualRatio=info.width/info.height,expectedRatio=Number(ratioWidth)/Number(ratioHeight),tolerance=seedance?0.02:0.01;
     if(!Number.isFinite(actualRatio)||actualRatio<=0||(expectedAspectRatio==='adaptive'?actualRatio<1/8||actualRatio>8:Math.abs(actualRatio/expectedRatio-1)>tolerance)) {
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_ASPECT_RATIO_MISMATCH',message:'供应商已完成，但下载的视频比例与镜头要求不符。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
     if(wan30&&(!Number.isFinite(info.duration)||info.duration<1.85||info.duration>30.15||effective!.durationSeconds!==-1&&Math.abs(info.duration-Number(effective!.durationSeconds))>0.25)){
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_DURATION_MISMATCH',message:'供应商已完成，但视频时长不符合冻结的 Wan 模型要求。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
     // Seedance 2.5 renders whole seconds at 24 fps plus one frame; an automatic
     // duration stays inside its documented 4–30 second range.
     if(seedance&&(!Number.isFinite(info.duration)||info.duration<3.85||info.duration>30.15||effective!.durationSeconds!==-1&&Math.abs(info.duration-Number(effective!.durationSeconds))>0.25)){
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_DURATION_MISMATCH',message:'供应商已完成，但视频时长不符合冻结的 Seedance 生成时长。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
    }
    checkpoint(signal);
    if(projectOwner&&!artifact)artifact=writeOutputArtifact(projectOwner,{owner,kind:'generation',sourceIdentity,stageFile:part,info},checkOutput);
    const published=projectOwner&&artifact?await publishProjectOutput(projectOwner,{owner,assetId:artifact.assetId,publicationId:artifact.publicationId,targetKind:'generated',stageFile:part,mimeType:'video/mp4',sha256:info.sha256,sizeBytes:info.sizeBytes},{signal,beforeEffect:checkOutput}):null;
    const publishedReference=published?(({relativePath:_path,...locator})=>locator)(published):null;
    const commit = () => tx(()=>{if(projectOwner){checkOutput();if(published)assertPublishedProjectOutput(projectOwner,published.publication);}const previous=list('versions',j!.projectId).map(value=>recordValue(value)).find(v=>v?.jobId===j!.id);if(previous){if(artifact&&(previous.id!==artifact.versionId||previous.assetId!==artifact.assetId||previous.sha256!==artifact.info.sha256))throw Object.assign(Error('Generation result conflicts with completed artifact'),{code:'INVALID_OUTPUT_ARTIFACT'});services.saveJob(j!,{status:'succeeded',phase:'complete',versionId:previous.id,progress:100,error:null});return;}
     const asset={id:artifact?.assetId??randomUUID(),projectId:j!.projectId,name:generatedVideoAssetName(store.db,j!,String(property(j!.snapshot,'title'))),mimeType:'video/mp4',...info,...(publishedReference?{...publishedReference,producer:{kind:'generation',id:j!.id}}:{relativePath}),url:null as string|null,provenance:j!.providerId==='mock'?'synthetic-mock':'generated',createdAt:now()};asset.url=`/media/${asset.id}`;put('assets',asset);
     const version={id:artifact?.versionId??randomUUID(),projectId:j!.projectId,shotId:j!.shotId,jobId:j!.id,number:list('versions',j!.projectId).filter(value=>property(value,'shotId')===j!.shotId).length+1,providerId:j!.providerId,model:j!.model,isMock:j!.providerId==='mock',snapshot:j!.snapshot,assetId:asset.id,url:asset.url,sha256:info.sha256,createdAt:now()};put('versions',version);
     const shot=recordValue(get('shots',j!.shotId));if(shot&&!shot.selectedVersionId&&typeof shot.revision==='number'&&!isCanvasArchived(store.db,'shots',j!.shotId)&&allowAgentTaskJobTargetMutation(store.db,'job',j!.id,{kind:'shot',id:j!.shotId}))put('shots',{...shot,selectedVersionId:version.id,revision:shot.revision+1,updatedAt:now()});services.saveJob(j!,{status:'succeeded',phase:'complete',progress:100,versionId:version.id,error:null});
    });
    if (projectOwner && published) {
      await registerVerifiedProjectOutputs(projectOwner, {signal, beforeEffect: checkOutput}, () => {
        commit();
        return markProjectOutputRegistered(projectOwner, published.publication, {signal});
      });
    } else commit();
   }
  } catch(error) {
   if(isBackgroundTaskIndexUncertain(error))return;
   if(isAgentTaskEffectBlocked(error)&&!isKnownAgentTaskBlock(error))throw error;
   if(pauseUnavailableBackgroundTask(store.db,{kind:'job',taskId:original.id},error))return;
   if(property(error,'terminationUnconfirmed'))failShutdown(error);
   const latest=recordValue(get('jobs',guardJob.id)) as JobRecord|null;
   if(latest?.status==='cancelled'||latest?.status==='succeeded')return;
   const errorCode=stringValue(property(error,'code'));
   // A trusted host gate can prove that this attempt never reached POST. Keep
   // the original queue identity so explicit resume continues it exactly once.
   if((blockedGate||isAgentTaskEffectBlocked(error))&&!postPermitted&&!acceptedProviderId){
    const cancelled=isAgentTaskJobStopped(store.db,'job',j.id);if(j.status==='submitting'||j.status==='queued'&&cancelled)saveGenerationGuarded(guardJob,{status:cancelled?'cancelled':'queued',phase:cancelled?'cancelled_before_dispatch':'waiting',submissionCount,error:null,nextPollAt:0});
    return;
   }
   if(errorCode?.startsWith('VIDEO_SETTINGS_')||errorCode==='VIDEO_CREDENTIAL_UNAVAILABLE'){
    // Retain the exact configured connection and task when credentials need
    // restoring; this path never authorizes a replacement submission.
    const definitelyUnsubmitted=j.status==='submitting'&&(property(error,'beforeDispatch')===true||isGenerationPreflightFailure(error));
    if(latest)saveGenerationGuarded(latest,{...(definitelyUnsubmitted?{status:'queued',submissionCount}:{}),phase:'connection_required',error:safeError(error),nextPollAt:Date.now()+5000});
    return;
   }
   if(j.status==='submitting') {
    if(isGenerationPreflightFailure(error)&&!acceptedProviderId){
     // This fence ran before fetch, so no attempt was dispatched. Do not
     // overwrite a concurrent cancellation or requeue a rejected paid action.
     saveGenerationGuarded(guardJob,{status:'failed',phase:'input_preflight_failed',submissionCount,error:safeError(error),nextPollAt:0});
     return;
    }
    if(!latest)return;
    if(property(error,'beforeDispatch')===true&&!acceptedProviderId) {
     saveGenerationGuarded(guardJob,{status:'queued',phase:'waiting',submissionCount,error:null,nextPollAt:0});
     if(property(error,'terminationUnconfirmed'))persistMediaPause('jobs',j.id,'');
     return;
    }
    const uncertain=Boolean(property(error,'uncertain')||acceptedProviderId||signal.aborted);
    services.saveJob(latest,{status:uncertain?'submission_unknown':'failed',phase:uncertain?'reconciliation_required':'submit_failed',...(acceptedProviderId?{providerJobId:acceptedProviderId}:{}),error:safeError(uncertain?{code:'SUBMISSION_UNKNOWN',uncertain:true}:error),nextPollAt:Date.now()+800});
    if(property(error,'terminationUnconfirmed'))persistMediaPause('jobs',j.id,'');
   } else if(signal.aborted) {
    // Poll/download cancellation preserves the existing task and snapshot. A
    // restart resumes that task; it never creates a replacement generation.
    if(property(error,'terminationUnconfirmed'))persistMediaPause('jobs',j.id,'');
    return;
   } else if(j.providerId==='mock'&&j.status==='downloading'&&errorCode==='MOCK_RENDERER_UNSUPPORTED')services.saveJob(latest as JobRecord,{status:'failed',phase:'provider_failed',error:{...safeError(error),retryable:false},nextPollAt:0});
   else if(['running','downloading','submission_unknown'].includes(j.status))services.saveJob(latest as JobRecord,{error:safeError(error,j.status==='downloading'?'DOWNLOAD_FAILED':'POLL_ERROR'),nextPollAt:Date.now()+1000});
   else saveGenerationGuarded(guardJob,{status:'failed',error:safeError(error)});
  }
 }

 async function processExport(original: ExportRecord,signal: AbortSignal): Promise<void> {
  checkpoint(signal);
  try{assertAgentTaskJobEffect(store.db,'export',original.id);}catch(error){
   if(isKnownAgentTaskBlock(error)&&isAgentTaskJobStopped(store.db,'export',original.id)){tx(()=>{const latest=currentOwnedExport(original);if(latest?.status==='queued')put('exports',{...latest,status:'failed',error:{code:'EXPORT_CANCELLED',message:'导出已取消',retryable:false},updatedAt:now()});});return;}throw error;
  }
  let e: ExportRecord=original;
  if(!exportUuid(e.id)||!exportUuid(e.projectId)){invalidExport();return;}
  const claimed=tx(()=>{const current=currentOwnedExport(original);if(current?.status!=='queued')return null;const claimedRecord=isFloatTimelineExport(current)?claimFloatTimelineExport(current,now()):{...current,status:'running',updatedAt:now()};put('exports',claimedRecord);return isFloatTimelineExport(current)?claimedRecord:current;});
  if(!claimed)return;
  e=claimed as unknown as ExportRecord;
  floatClaims.remember(signal,e);
  const floatExport=isFloatTimelineExport(e);
  const writerOwner=registeredProjectStore(root),outputOwner:ProjectOutputOwner={kind:'export',id:e.id,requestId:typeof e.requestId==='string'?e.requestId:e.id,inputHash:outputArtifactDigest(exportOutputArtifactIdentity(e))};
  // Fresh non-overwriting publication also preserves a prior successful output.
  const relativePath=`media/export-${e.id}-${randomUUID()}.mp4`,file=path.join(root,relativePath);let part=file+'.part.mp4',artifact:OutputArtifact|null=null,artifactComplete=false,resumedArtifact=false;
  const colourExport=Boolean(e.snapshot&&isRecord(e.snapshot)&&Object.hasOwn(e.snapshot,'colourPlan'));
  const readLut=colourExport?createTimelineColourLutReader(store.db,e.projectId):undefined;
  const agentBound=!!agentTaskJobBinding(store.db,'export',e.id);
  const fencedAttempt=floatExport||hasSelectedTimelineExportRange(e.snapshot)||colourExport,effectError=timelineExportRangeEffectError;
  let preparedAssets: Map<string, unknown>|undefined,linkedOutput=false,publicationAccepted=false,
   outputIdentity: {dev: number; ino: number; isFile(): boolean; nlink: number}|undefined,outputHandle: Awaited<ReturnType<typeof open>>|undefined,claimLive=true,validateSources: (()=>void)|undefined,
   floatMeasurement: ReturnType<typeof ownedFloatTimelineMeasurement>|undefined,terminationUnconfirmed=false,renderStarted=false,blockedGate=false;
  const beforeStart=():void=>{if(agentBound&&!renderStarted){try{assertAgentTaskJobEffect(store.db,'export',e.id);}catch(error){if(isAgentTaskEffectBlocked(error))blockedGate=true;throw error;}renderStarted=true;}};
  const beforeEffect=(): void=>{if(agentBound&&!renderStarted){try{assertAgentTaskJobEffect(store.db,'export',e.id);}catch(error){if(isAgentTaskEffectBlocked(error))blockedGate=true;throw error;}}const latest=currentOwnedExport(e);if(!claimLive||stopped||signal.aborted||latest?.status!=='running'||writerOwner&&outputArtifactDigest(exportOutputArtifactIdentity(latest))!==outputOwner.inputHash)throw effectError();if(outputIdentity){let actual;try{actual=lstatSync(linkedOutput?file:part);}catch{throw effectError();}if(!actual.isFile()||actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}if(writerOwner&&artifact&&lstatSync(outputArtifactStage(writerOwner,artifact),{throwIfNoEntry:false}))assertOutputArtifactStage(writerOwner,artifact);validateSources?.();};
  const checkCustomSources=(): void=>{if(customExport(e))validatePreparedTimelineSources(store.db,e.projectId,e.snapshot as never,preparedAssets as never,{root});};
  try {
   beforeEffect?.();
   const outputGeometry=e.mode==='timeline'?property(e.snapshot,'timeline'):storyboardOutputGeometry(e);
   // Every cancellable export owns its staging inode, including legacy
   // delivery without an opt-in profile. A late cancel may land after link.
   if(writerOwner){artifact=readOutputArtifact(writerOwner,outputOwner,'export',outputOwner.inputHash);part=artifact?outputArtifactStage(writerOwner,artifact):createOutputArtifactStage(writerOwner,outputOwner,'export');artifactComplete=Boolean(artifact);resumedArtifact=Boolean(artifact);}
   if(!artifact){
   outputHandle=await open(part,'wx',writerOwner?0o600:0o666);outputIdentity=await outputHandle.stat();beforeEffect?.();
   if(e.mode==='timeline') {
    if(!isTimelineExportSnapshot(e.snapshot,{purpose:e.purpose}))throw Object.assign(Error('Invalid timeline export delivery profile'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    const assets=await prepareTimelineInputs(e.snapshot as never,{root,projectId:e.projectId,signal,
     beforeEffect,readLut:readLut as never,readAsset:(id: string)=>{beforeEffect?.();return readOwnedTimelineAsset(store.db,e.projectId,id) as never;},validateLinks:(timeline: unknown)=>{beforeEffect?.();return validateFrozenTimelineSourceGraph(store.db,e.projectId,timeline as never);}});checkpoint(signal);
    if(currentOwnedExport(e)?.status!=='running')return;
    preparedAssets=assets as unknown as Map<string, unknown>;
    validateSources=()=>validatePreparedTimelineSources(store.db,e.projectId,e.snapshot as never,preparedAssets as never,{root});
    const rendered=await (exportStage(store,e.id,'encoding'),renderTimeline(e.snapshot as never,assets as never,part,{signal,beforeEffect,...(agentBound?{beforeStart}:{}),readLut:readLut as never,...(customExport(e)?{beforeEncode:()=>{if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('The frozen export changed during local capability checking.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();}}:{})}));checkpoint(signal);
    if(floatExport)floatMeasurement=ownedFloatTimelineMeasurement(rendered);
   } else {
    // Every native await retains source ownership, including storyboard output
    // and timeline exports without an opt-in delivery profile.
    validateSources=()=>{
     for(const value of arrayValue(e.snapshot)){
      const frozen=recordValue(value);if(!frozen)throw effectError();
      const graph=createOwnedMediaGraphReader(store.db,e.projectId);
      const asset=graph.asset(frozen.assetId),version=graph.version(frozen.versionId,frozen.shotId,frozen.assetId);
      if(asset.sha256!==frozen.sha256||version.sha256!==frozen.sha256)throw effectError();
     }
    };
    beforeEffect();
    const files: string[]=[];


    for(const rawVersion of arrayValue(e.snapshot)) {
     checkpoint(signal);
     const frozen=recordValue(rawVersion);if(!frozen)throw Error('Export snapshot hash mismatch');
     const asset=recordValue(get('assets',String(frozen.assetId)));
     if(!asset||asset.projectId!==e.projectId||asset.sha256!==frozen.sha256)throw Error('Export snapshot hash mismatch');
     const mediaPath=registeredProjectStore(root)?validateManagedSource(root,asset).file:await safePath(root,String(asset.relativePath));checkpoint(signal);
     const actual=registeredProjectStore(root)?await verifiedManagedHash(root,asset,{signal,beforeEffect}):await fileInfo(mediaPath,{signal,beforeEffect});checkpoint(signal);
     if(actual.sha256!==frozen.sha256)throw Error('Export input bytes differ from frozen version hash');
     files.push(mediaPath);
    }
    if(currentOwnedExport(e)?.status!=='running')return;
    exportStage(store,e.id,'encoding');
    await stitch(files,part,{signal,beforeEffect,...(agentBound?{beforeStart}:{}),outputGeometry:storyboardOutputGeometry(e)});checkpoint(signal);
   }
   exportStage(store,e.id,'finalizing');
   }
   const info=artifact?.info??await fileInfo(part,{signal,beforeEffect});checkpoint(signal);
   // Recheck the preserved relational owner immediately before publication.
   if(currentOwnedExport(e)?.status!=='running')return;
   if(artifact){
    validateSources=()=>{
     if(e.mode==='timeline'){
      validateFrozenTimelineSourceGraph(store.db,e.projectId,property(e.snapshot,'timeline') as never);
      for(const raw of arrayValue(property(e.snapshot,'assets'))){const frozen=recordValue(raw),source=frozen?readOwnedTimelineAsset(store.db,e.projectId,frozen.id):null;if(!frozen||!source||source.sha256!==frozen.sha256||source.mimeType!==frozen.mimeType||source.referenceRevision!==frozen.referenceRevision||JSON.stringify(source.reference)!==JSON.stringify(frozen.reference))throw Object.assign(Error('Frozen export source identity changed'),{code:'TIMELINE_SOURCE_UNAVAILABLE'});}
     }else for(const raw of arrayValue(e.snapshot)){const frozen=recordValue(raw);if(!frozen)throw Error('Export snapshot hash mismatch');const graph=createOwnedMediaGraphReader(store.db,e.projectId),source=graph.asset(frozen.assetId),version=graph.version(frozen.versionId,frozen.shotId,frozen.assetId);if(source.sha256!==frozen.sha256||version.sha256!==frozen.sha256)throw Error('Export snapshot hash mismatch');}
    };validateSources();
   }else checkCustomSources();
   if(colourExport)verifyTimelineColourLuts((property(e.snapshot,'colourPlan') as never),readLut as never,true);
   // Retain only this attempt's owned output inode for conservative
   // cleanup if source ownership changes before the database commit.
   if(!artifact){
    const actual=await lstat(part);checkpoint(signal);beforeEffect?.();
    if(outputIdentity&&(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino))throw effectError();
    outputIdentity=actual;
    if(!outputIdentity.isFile()||outputIdentity.nlink!==1)throw Object.assign(Error('The local export output cannot be verified safely.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    if(currentOwnedExport(e)?.status!=='running')return;
    checkCustomSources();
   }
   if(writerOwner){
    if(!artifact){artifact=writeOutputArtifact(writerOwner,{owner:outputOwner,kind:'export',sourceIdentity:outputOwner.inputHash,stageFile:part,info,...(floatExport&&floatMeasurement?{audioCheck:bindFloatTimelineMeasurement(e as never,floatMeasurement,now())}:{})},beforeEffect);artifactComplete=true;}
    if(floatExport?!artifact.audioCheck:artifact.audioCheck!==undefined)throw Object.assign(Error('Output artifact has an invalid audio observation'),{code:'INVALID_OUTPUT_ARTIFACT'});
    const audioCheck=floatExport?restoredArtifactAudioCheck(artifact,e):undefined;
    const published=await publishProjectOutput(writerOwner,{owner:outputOwner,assetId:artifact.assetId,publicationId:artifact.publicationId,targetKind:'exports',stageFile:part,mimeType:'video/mp4',sha256:info.sha256,sizeBytes:info.sizeBytes},{signal,beforeEffect});checkpoint(signal);beforeEffect();
    const {relativePath:_publishedPath,...locator}=published;
    await registerVerifiedProjectOutputs(writerOwner, {signal, beforeEffect}, () => {
     tx(()=>{try{assertPublishedProjectOutput(writerOwner,published.publication);}catch(error){if(property(error,'code')==='INVALID_MEDIA')throw effectError();throw error;}beforeEffect();if(!resumedArtifact)checkCustomSources();if(!artifact)throw Error('Missing completed export artifact');
     const asset={id:artifact.assetId,projectId:e.projectId,name:exportAssetName(store.db,e,outputGeometry),mimeType:'video/mp4',...info,...locator,producer:{kind:'export',id:e.id},provenance:'export',createdAt:artifact.createdAt,url:`/media/${artifact.assetId}`};
     put('assets',asset);put('exports',{...e,status:'succeeded',assetId:asset.id,url:asset.url,error:null,...(audioCheck?{audioCheck}:{}),updatedAt:now()});
     });
     publicationAccepted=true;
     return markProjectOutputRegistered(writerOwner,published.publication,{signal});
    });
    return;
   }
   // link is an atomic, non-overwriting publication on the managed filesystem.
   beforeEffect?.();
   await link(part,file);linkedOutput=true;checkpoint(signal);beforeEffect?.();
   if(fencedAttempt&&outputIdentity){const actual=await lstat(part);beforeEffect?.();if(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}
   await unlink(part);checkpoint(signal);beforeEffect?.();
   const projectOwner=registeredProjectStore(root),publishedReference=projectOwner?await referenceForPublishedMedia(projectOwner,file,{sha256:info.sha256,signal,beforeEffect}):null;
   tx(()=>{beforeEffect?.();if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('Invalid local export record.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();
    const a: Record<string, unknown>&{url: string}={id:randomUUID(),projectId:e.projectId,name:exportAssetName(store.db,e,outputGeometry),mimeType:'video/mp4',...info,...(publishedReference?{...publishedReference,producer:{kind:'export',id:e.id}}:{relativePath}),provenance:'export',createdAt:now(),url:''};a.url=`/media/${String(a.id)}`;put('assets',a);put('exports',{...e,status:'succeeded',assetId:a.id,url:a.url,error:null,...(floatExport&&floatMeasurement?{audioCheck:bindFloatTimelineMeasurement(e as never,floatMeasurement,now(),{assetId:String(a.id),sha256:info.sha256})}:{}),updatedAt:now()});});
   publicationAccepted=true;
  } catch(error) {
   if(publicationAccepted)return;
   if(isBackgroundTaskIndexUncertain(error))return;
   if(pauseUnavailableBackgroundTask(store.db,{kind:'export',taskId:e.id},error))return;
   terminationUnconfirmed=Boolean(property(error,'terminationUnconfirmed'));
   if(property(error,'terminationUnconfirmed'))failShutdown(error);
   const failExport=(): void=>{
    const latest=currentOwnedExport(e);
    const latestStatus=stringValue(property(latest,'status'));
    if(!latest||isCancelledExport(latest)||latestStatus==='cancelled'||(customExport(e)||writerOwner&&artifact&&latest.assetId===artifact.assetId)&&latestStatus==='succeeded')return;
    if(agentBound&&!renderStarted&&(blockedGate||isAgentTaskEffectBlocked(error))){const cancelled=isAgentTaskJobStopped(store.db,'export',e.id);put('exports',{...(floatExport?requeueFloatTimelineExport(latest):latest),status:cancelled?'failed':'queued',error:cancelled?{code:'EXPORT_CANCELLED',message:'导出已取消',retryable:false}:null,updatedAt:now()});return;}
    const audioCheck=floatExport&&!signal.aborted?(floatMeasurement?bindFloatTimelineMeasurement(e as never,floatMeasurement,now()):bindFloatTimelineFailure(e as never,error,now())):undefined;
    put('exports',{...(floatExport&&signal.aborted?requeueFloatTimelineExport(latest):latest),status:signal.aborted?'queued':'failed',error:property(error,'terminationUnconfirmed')?mediaPauseError('exports',latestStatus??'failed'):signal.aborted?null:{...safeError(error,'EXPORT_FAILED'),...(audioCheck?.code==='EXPORT_AUDIO_OVER_RANGE'?{retryable:false}:{})},...(audioCheck?{audioCheck}:{}),updatedAt:now()});
   };
   tx(failExport);
  } finally {
   claimLive=false;
   const cleanup=async(): Promise<void>=>{
   const unpublished=(): boolean=>{const latest=currentOwnedExport(e,{cleanupOnly:floatExport});const status=stringValue(property(latest,'status'));return Boolean(latest&&exportIdentity(latest)===exportIdentity(e)&&status!==undefined&&['queued','running','failed'].includes(status)&&latest.assetId===null&&latest.url===null);};
   if(outputIdentity&&(!writerOwner||!artifactComplete)){try{const actual=await lstat(part).catch(()=>null);if(actual?.isFile()&&actual.dev===outputIdentity.dev&&actual.ino===outputIdentity.ino&&unpublished())await unlink(part).catch(()=>{});}catch{/* an uncertain read preserves the part file */}}
   // An uncertain commit, hostile replacement, foreign export, changed inode,
   // or failed cleanup never licenses removing an unknown/published output.
   // Keep the original failure; this cleanup makes no byte-race guarantee.
   if(!writerOwner&&linkedOutput&&!publicationAccepted&&outputIdentity){
    try{
     if(unpublished()){
      const current=await lstat(file).catch(()=>null);
      if(current?.isFile()&&current.nlink===1&&current.dev===outputIdentity.dev&&current.ino===outputIdentity.ino&&unpublished())await unlink(file).catch(()=>{});
     }
    }catch{/* An uncertain read or cleanup preserves the link and original error. */}
   }
   if(outputHandle)await outputHandle.close().catch(()=>{});
   };
   if((floatExport||colourExport)&&terminationUnconfirmed)void waitForMediaProcesses({signal}).then(cleanup).catch(()=>{});
   else await cleanup();
  }
 }

 async function operate(value: JobRecord|ExportRecord,action: WorkerOperation): Promise<void> {
  if(stopped)return;
  const controller=new AbortController();operations.add(controller);
  const exportActivity=action===processExport as unknown as WorkerOperation?registerExportActivity(inputStore,value.id,()=>controller.abort()):null;
  try {await withAgentTaskJobOrigin(store.db,action===processJob as WorkerOperation?'job':'export',value.id,()=>action(value as never,controller.signal));}
  finally {
   controller.abort();
   // An adapter await can be abandoned, but owned children cannot. Retain this
   // operation's signal until its remaining direct children have been reaped.
   try {assertMediaTerminated(await terminateMediaProcesses({signal:controller.signal}));}
   catch(error) {failShutdown(error);persistMediaPause(action===processJob as never?'jobs':'exports',value.id,value.projectId,property(value,'mode'),floatClaims.read(controller.signal));throw error;}
   finally {exportActivity?.close();operations.delete(controller);}
  }
 }
 async function advance(value: JobRecord|ExportRecord,action: WorkerOperation): Promise<void> {
  try {await operate(value,action);}
  catch(error) {
   // A trusted task control fence defers only its own candidate. Storage,
   // audit and uncertain-effect failures must still abort the whole cycle.
   if(!isKnownAgentTaskBlock(error))throw error;
  }
 }
 function tick(): Promise<void> {
  if(stopped)return Promise.resolve();
  if(cycle)return cycle;
  cycle=(async()=>{
   try {
    // Projection does not grant authority or classify failures of its gate.
    // Recheck only agent-blocked queued candidates through the original gate:
    // ordinary denials skip one candidate; audit/storage faults stop the cycle.
    verifyInvalidCandidates();
    for(const ref of backgroundTasks.snapshot()){if(ref.kind!=='job'||!ref.keepAlive&&!ref.reason?.startsWith('AGENT_'))continue;const job=recordValue(get('jobs',ref.taskId)) as JobRecord|null;if(job&&!stopped&&typeof job.status==='string'&&['queued','running','downloading','submission_unknown'].includes(job.status)&&(ref.keepAlive||job.status==='queued'))await advance(job,processJob as WorkerOperation);verifyInvalidCandidates();}
    if(stopped)return;
    for(const ref of backgroundTasks.snapshot()){if(ref.kind!=='export'||!ref.keepAlive&&!ref.reason?.startsWith('AGENT_'))continue;const e=workerExport(ref.taskId);if(e&&!stopped&&e.status==='queued')await advance(e,processExport as unknown as WorkerOperation);verifyInvalidCandidates();}
   } catch(error) {console.error('Worker cycle failed:',stringValue(property(error,'code'))||String(property(error,'name')));}
  })().finally(()=>{cycle=null;});
  return cycle;
 }
 const timer=setInterval(tick,200);
 const abort=(): void=>{stopped=true;clearInterval(timer);for(const controller of operations)controller.abort();};
 ownerSignal?.addEventListener('abort',abort,{once:true});
 if(stopped)clearInterval(timer);else void tick();
 return {
  isBusy:()=>cycle!==null||operations.size>0,
  stop:()=>stopping??=(async(): Promise<void>=>{
   abort();
   // Abort first: the signal fences children that could otherwise spawn after
   // the current owned-child set was captured by termination.
   await boundedShutdown(Promise.all([cycle,...[...operations].map(controller=>terminateMediaProcesses({signal:controller.signal}).then(assertMediaTerminated))]),'WORKER_STOP_TIMEOUT');
   ownerSignal?.removeEventListener('abort',abort);
   if(shutdownFailure)throw shutdownFailure;
  })(),
  tick,
 };
}

import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {isOpacityCandidateServicesForStore} from './opacity-candidate-services.ts';
import {matchesOpacityCandidateExport,claimOpacityCandidateExport,recoverOpacityCandidateExport,isOpacityCandidateExportClaim,revokeOpacityCandidateExportClaim,prepareOpacityCandidateRenderInputs} from './opacity-candidate-render-authority.ts';
import {bindTimelineOpacityRenderAttempt} from './timeline-opacity-render-binding.ts';
import {isFloatTimelineExport,claimFloatTimelineExport,sameFloatTimelineAttempt,requeueFloatTimelineExport,createFloatTimelineAttemptRegistry,ownedFloatTimelineMeasurement,bindFloatTimelineMeasurement,bindFloatTimelineFailure,assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {createTimelineColourLutReader,verifyTimelineColourLuts} from './timeline-colour-lut.ts';
import {requiresPreparedTimelineExportIdentity,hasSelectedTimelineExportRange,timelineExportRangeEffectError} from './timeline-export-range.ts';
import {timelineRenderDeliveryFields,hasTimelineDeliveryIdentity,TIMELINE_DELIVERY_RECEIPT_SQL} from '@mioon/contracts/timeline-delivery';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {matchesRestoredExport,restoreExportIdentity} from './workspace-restore-exports.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {isTimelineExportSnapshot,isTimelineRenderRecord} from '@mioon/contracts';
import {lstatSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
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
import type {JobRecord,OrdinaryServices,ServiceStore,ServiceRow} from './services.ts';
import type {Provider} from './provider-registry.ts';
import {markGenerationPreflightFailure,isGenerationPreflightFailure} from './generation-inputs.ts';
import {assertMediaTerminated,awaitProvider,boundedShutdown,checkpoint} from './operation-lifecycle.ts';

type Services=Pick<OrdinaryServices,'saveJob'|'saveGenerationGuarded'|'validateGenerationDispatch'|'resolveGenerationProvider'>;
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
}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const recordValue=(value: unknown): Record<string, unknown>|null=>isRecord(value)?value:null;
const stringValue=(value: unknown): string|undefined=>typeof value==='string'?value:undefined;
const numberValue=(value: unknown): number|undefined=>typeof value==='number'?value:undefined;
const arrayValue=(value: unknown): unknown[]=>Array.isArray(value)?value:[];
const isThenable=(value: unknown): value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?: unknown}).then==='function';

export function startWorker(inputStore: ServiceStore,services: Services,providers: ReadonlyMap<string,Provider>,{signal:ownerSignal}: {signal?: AbortSignal}={}): Worker {
 // Ordinary and verified candidate stores expose the same workspace surface.
 const store: JobsStore=inputStore as unknown as JobsStore;
 const opacity=getOpacityCandidateAssembly(inputStore);
 if(opacity&&!isOpacityCandidateServicesForStore(store,services as never))throw Object.assign(Error('The candidate worker requires its exact owned services.'),{code:'OPACITY_CANDIDATE_STORE_REQUIRED'});
 const restored=opacity?opacity.getRestoreContext():getWorkspaceRestoreContext(inputStore);
 const {list,get,put,tx,root}=store;
 let stopped=Boolean(ownerSignal?.aborted),cycle: Promise<void>|null=null,stopping: Promise<void>|undefined,shutdownFailure: unknown;
 const operations=new Set<AbortController>(),floatClaims=createFloatTimelineAttemptRegistry();
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
     ELSE ${restored?`CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${exportRowBytes} THEN data END`:'data'} END
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
  try{if(opacity){if(!matchesOpacityCandidateExport(store,record as never))return invalidExport();}else assertFloatTimelineExportRead(store.db,record,{isTimelineRenderRecord,readOwnedAsset:(projectId: string,assetId: string)=>readOwnedTimelineAsset(store.db,projectId,assetId)});}catch{return invalidExport();}
  return value;
 }
 const workerExports=(): ExportRecord[]=>store.db.prepare(`SELECT ${exportColumns} FROM exports${restored?" WHERE id IN (SELECT exportId FROM workspace_restore_export_origins WHERE workspaceOrigin=?) AND CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END IN ('queued','running') ORDER BY id":''}`).all(...(restored?[restored.workspaceOrigin]:[])).map(row=>decodeExport(row as Record<string,unknown>)).filter((value): value is ExportRecord=>Boolean(value&&(!restored||(opacity?matchesOpacityCandidateExport(store,value):matchesRestoredExport(store,value as never)))));
 const workerExport=(id: string): ExportRecord|null=>decodeExport(store.db.prepare(`SELECT ${exportColumns} FROM exports WHERE id=?`).get(id) as Record<string,unknown>|undefined);
 // Custom delivery adds an awaited capability step. Preserve the complete
 // immutable acceptance identity across every existing async/publication fence;
 // a replaced snapshot must never be restored by publishing an older copy.
 const customExport=(e: ExportRecord): boolean=>Boolean(opacity)||requiresPreparedTimelineExportIdentity(e)||Boolean(e.snapshot&&isRecord(e.snapshot)&&Object.hasOwn(e.snapshot,'colourPlan'));
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
   if(opacity)return matchesOpacityCandidateExport(store,e as never);
   const input={projectId:e.projectId,requestId:e.requestId,expectedRevision:e.timelineRevision,purpose:e.purpose,...timelineRenderDeliveryFields(e.snapshot)};
   if(typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200)return false;
   const receipt=readTimelineReceipt(store.db,input as never,'timeline.render');
   if(!receipt)return false;
   const response: unknown=JSON.parse(String(receipt.response));
   return property(response,'status')==='queued'&&isTimelineRenderRecord(response,input as never)&&exportIdentity(response as ExportRecord)===exportIdentity(e);
  }catch{return false;}
 }
 const currentOwnedExport=(e: ExportRecord,{cleanupOnly=false}: {cleanupOnly?: boolean}={}): ExportRecord|null=>{
  const latest=workerExport(e.id);
  if(opacity){if(!matchesOpacityCandidateExport(store,e as never)||!matchesOpacityCandidateExport(store,latest as never)||exportIdentity(e)!==exportIdentity(latest as ExportRecord)||!cleanupOnly&&e.status==='running'&&!isOpacityCandidateExportClaim(store,e as never))return null;}
  else if(restored&&(!matchesRestoredExport(store,e as never)||!matchesRestoredExport(store,latest as never)||restoreExportIdentity(e as never)!==restoreExportIdentity(latest as never)))return null;
  if(!latest||latest.mode!==e.mode||latest.id!==e.id||latest.projectId!==e.projectId)return null;
  if((opacity||hasTimelineDeliveryIdentity(e)||hasTimelineDeliveryIdentity(latest)||receiptHasDelivery(e))&&(exportIdentity(latest)!==exportIdentity(e)||!customReceiptMatches(e)))return null;
  if(!cleanupOnly&&!sameFloatTimelineAttempt(e,latest as never))return null;
  return latest;
 };

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
   if(opacity&&(table!=='exports'||!matchesOpacityCandidateExport(store,latest as never)))return;
   else if(restored&&!opacity&&(table!=='exports'||!matchesRestoredExport(store,latest as never)))return;
   if(table==='exports'&&isFloatTimelineExport(latest)&&(!attempt||!sameFloatTimelineAttempt(attempt,latest)))return;
   const error=mediaPauseError(table,status);
   if(property(property(latest,'error'),'code')===error.code&&property(property(latest,'error'),'message')===error.message)return;
   if(table==='jobs')services.saveJob(latest as JobRecord,{error});
   else put('exports',{...latest,error,updatedAt:now()});
  };
  if(table==='exports')tx(apply);else apply();
 };
 const safeError=(e: unknown,code='PROVIDER_ERROR'): {code: string; message: string; retryable: boolean}=>({code:stringValue(property(e,'code'))||code,message:property(e,'uncertain')?'供应商可能已受理。正在对账，不会自动重新提交。':String(property(e,'message')||'任务操作失败').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi,'[redacted]').slice(0,600),retryable:true});
 for(const j of restored||opacity?[]:list('jobs')){const job=recordValue(j) as JobRecord|null;if(job&&job.status==='submitting')services.saveGenerationGuarded(job,{status:'submission_unknown',phase:'recovering_submit',error:{code:'SUBMISSION_UNKNOWN',message:'服务在提交期间中断；先对账，绝不盲目重新提交',retryable:true}});}
 for(const e of workerExports())if(e.status==='running')tx(()=>{
  if(opacity){recoverOpacityCandidateExport(store,e as never,now());return;}
  const current=currentOwnedExport(e);if(current?.status==='running')put('exports',{...(isFloatTimelineExport(current)?requeueFloatTimelineExport(current):current),status:'queued',updatedAt:now()});
 });

 async function processJob(original: JobRecord,signal: AbortSignal): Promise<void> {
  checkpoint(signal);
  let j=recordValue(get('jobs',original.id)) as JobRecord|null;
  if(!j)return;
  let provider:Provider|undefined;
  const context: Record<string, unknown>={requestId:j.requestId,jobId:j.id,providerRegion:property(j.snapshot,'capabilities')&&property(property(j.snapshot,'capabilities'),'region'),signal};
  let acceptedProviderId: string|null=null,guardJob=j;
  const submissionCount=numberValue(j.submissionCount)??0;
  const nextPollAt=numberValue(j.nextPollAt);
  if(nextPollAt&&Date.now()<nextPollAt)return;
  try {
   provider=services.resolveGenerationProvider?services.resolveGenerationProvider(j):providers.get(j.providerId);
   if(j.status==='queued') {
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
     const file=await safePath(root,String(asset.relativePath));checkpoint(signal);
     // A source owner can change during an awaited path read, before an
     // adapter's own byte reads and final POST fence begin.
     services.validateGenerationDispatch(j);
     referenceAssets.push({...reference,path:file});
    }
    checkpoint(signal);
    const current=recordValue(get('jobs',j.id)) as JobRecord|null;
    if(!current||current.status!=='queued')return;
    j=current;
    if(JSON.stringify(j.snapshot)!==preparedSnapshot)throw Object.assign(Error('准备素材期间冻结快照已改变'),{code:'INVALID_REFERENCE_MANIFEST'});
    services.validateGenerationDispatch(j);
    const claimed=services.saveGenerationGuarded(guardJob,{status:'submitting',phase:'provider_submit',submissionCount:submissionCount+1});
    if(!claimed)return;
    j=claimed as JobRecord;guardJob=j;
    const claim=j;
    // Shared HTTP adapters invoke this synchronous fence after image preparation
    // and immediately before POST. No callback is used for poll/download/reconcile.
    context.beforeSubmit=()=>{
     try{
      const latest=recordValue(get('jobs',claim.id));
      if(!latest||latest.status!=='submitting'||latest.revision!==claim.revision||JSON.stringify(latest.snapshot)!==preparedSnapshot)throw Object.assign(Error('提交前任务状态已更改'),{code:'GENERATION_STATE_CHANGED'});
      services.validateGenerationDispatch(claim);
     }catch(error){throw markGenerationPreflightFailure(error as object);}
    };
    // During both image reads the same non-mutating claim/ownership fence
    // rejects drift. The final beforeSubmit fence still runs directly at POST.
    (context as unknown as {validateReferenceState: ()=>void}).validateReferenceState=context.beforeSubmit as ()=>void;
    const accepted: unknown=await awaitProvider(()=>provider!.submit({...j!.snapshot,referenceAssets},context as never),signal,{submit:true});
    acceptedProviderId=stringValue(property(recordValue(accepted),'providerJobId'))??null;
    // Receipt persistence is the sole intentional write permitted after abort.
    // awaitProvider only delivers receipts inside its bounded settlement window.
    const latest=recordValue(get('jobs',j.id)) as JobRecord|null;
    if(latest)services.saveJob(latest,{providerJobId:acceptedProviderId,...latest.status==='cancelled'?{}:{status:'running',phase:'polling',progress:5,error:null}});
    return;
   }
   if(!provider)throw Object.assign(Error('Provider is unavailable'),{code:'PROVIDER_NOT_FOUND'});
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
    if(remote.status!=='succeeded'){services.saveJob(j,{progress:remote.progress==null?j.progress:Math.round(remote.progress*100),nextPollAt:Date.now()+(numberValue(property(provider.capabilities,'minPollIntervalMs'))||350),error:null});return;}
    j=services.saveJob(j,{status:'downloading',phase:'downloading',progress:90,nextPollAt:0,error:null}) as JobRecord;
   }
   if(j.status==='downloading') {
    checkpoint(signal);
    const relativePath=`media/result-${j.id}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';
    let info;
    try {
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
    if(!provider.capabilities.mock) {
     const [ratioWidth,ratioHeight]=String(property(j.snapshot,'aspectRatio')).split(':').map(Number);
     const actualRatio=info.width/info.height,expectedRatio=Number(ratioWidth)/Number(ratioHeight);
     if(!Number.isFinite(actualRatio)||Math.abs(actualRatio/expectedRatio-1)>0.01) {
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_ASPECT_RATIO_MISMATCH',message:'供应商已完成，但下载的视频比例与镜头要求不符。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
    }
    checkpoint(signal);
    tx(()=>{const previous=list('versions',j!.projectId).map(value=>recordValue(value)).find(v=>v?.jobId===j!.id);if(previous){services.saveJob(j!,{status:'succeeded',phase:'complete',versionId:previous.id,progress:100,error:null});return;}
     const asset={id:randomUUID(),projectId:j!.projectId,name:`${String(property(j!.snapshot,'title'))} ${j!.providerId==='mock'?'模拟':'生成'}视频.mp4`,mimeType:'video/mp4',...info,relativePath,url:null as string|null,provenance:j!.providerId==='mock'?'synthetic-mock':'generated',createdAt:now()};asset.url=`/media/${asset.id}`;put('assets',asset);
     const version={id:randomUUID(),projectId:j!.projectId,shotId:j!.shotId,jobId:j!.id,number:list('versions',j!.projectId).filter(value=>property(value,'shotId')===j!.shotId).length+1,providerId:j!.providerId,model:j!.model,isMock:j!.providerId==='mock',snapshot:j!.snapshot,assetId:asset.id,url:asset.url,sha256:info.sha256,createdAt:now()};put('versions',version);
     const shot=recordValue(get('shots',j!.shotId));if(shot&&!shot.selectedVersionId&&typeof shot.revision==='number')put('shots',{...shot,selectedVersionId:version.id,revision:shot.revision+1,updatedAt:now()});services.saveJob(j!,{status:'succeeded',phase:'complete',progress:100,versionId:version.id,error:null});
    });
   }
  } catch(error) {
   if(property(error,'terminationUnconfirmed'))failShutdown(error);
   const latest=recordValue(get('jobs',guardJob.id)) as JobRecord|null;
   if(latest?.status==='cancelled')return;
   const errorCode=stringValue(property(error,'code'));
   if(errorCode?.startsWith('VIDEO_SETTINGS_')||errorCode==='VIDEO_CREDENTIAL_UNAVAILABLE'){
    // Missing connection credentials do not turn an accepted task into a new
    // generation. Restoring its exact binding resumes the same state and ID.
    const definitelyUnsubmitted=j.status==='submitting'&&(property(error,'beforeDispatch')===true||isGenerationPreflightFailure(error));
    if(latest)services.saveGenerationGuarded(latest,{...(definitelyUnsubmitted?{status:'queued',submissionCount}:{}),phase:'connection_required',error:safeError(error),nextPollAt:Date.now()+5000});
    return;
   }
   if(j.status==='submitting') {
    if(isGenerationPreflightFailure(error)&&!acceptedProviderId){
     // This fence ran before fetch, so no attempt was dispatched. Do not
     // overwrite a concurrent cancellation or requeue a rejected paid action.
     services.saveGenerationGuarded(guardJob,{status:'failed',phase:'input_preflight_failed',submissionCount,error:safeError(error),nextPollAt:0});
     return;
    }
    if(!latest)return;
    if(property(error,'beforeDispatch')===true&&!acceptedProviderId) {
     services.saveGenerationGuarded(guardJob,{status:'queued',phase:'waiting',submissionCount,error:null,nextPollAt:0});
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
   else services.saveGenerationGuarded(guardJob,{status:'failed',error:safeError(error)});
  }
 }

 async function processExport(original: ExportRecord,signal: AbortSignal): Promise<void> {
  checkpoint(signal);
  let e: ExportRecord=original;
  if(!exportUuid(e.id)||!exportUuid(e.projectId)){invalidExport();return;}
  const claimed=tx(()=>{const current=currentOwnedExport(original);if(current?.status!=='queued')return null;if(opacity)return claimOpacityCandidateExport(store,current as never,now());const claimedRecord=isFloatTimelineExport(current)?claimFloatTimelineExport(current,now()):{...current,status:'running',updatedAt:now()};put('exports',claimedRecord);return isFloatTimelineExport(current)?claimedRecord:current;});
  if(!claimed)return;
  e=claimed as unknown as ExportRecord;
  floatClaims.remember(signal,e);
  const floatExport=isFloatTimelineExport(e);
  // Fresh non-overwriting publication also preserves a prior successful output.
  const relativePath=`media/export-${e.id}-${randomUUID()}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';
  const colourExport=Boolean(e.snapshot&&isRecord(e.snapshot)&&Object.hasOwn(e.snapshot,'colourPlan'));
  const readLut=colourExport?createTimelineColourLutReader(store.db,e.projectId):undefined;
  const fencedAttempt=opacity||restored||floatExport||hasSelectedTimelineExportRange(e.snapshot)||colourExport,effectError=restored?workspaceRestoreError:timelineExportRangeEffectError;
  let preparedAssets: Map<string, unknown>|undefined,opacityBinding: ReturnType<typeof bindTimelineOpacityRenderAttempt>|undefined,linkedOutput=false,publicationAccepted=false,
   outputIdentity: {dev: number; ino: number; isFile(): boolean; nlink: number}|undefined,outputHandle: Awaited<ReturnType<typeof open>>|undefined,claimLive=true,validateSources: (()=>void)|undefined,
   floatMeasurement: ReturnType<typeof ownedFloatTimelineMeasurement>|undefined,terminationUnconfirmed=false;
  const beforeEffect=fencedAttempt?(): void=>{if(!claimLive||stopped||signal.aborted||currentOwnedExport(e)?.status!=='running')throw effectError();validateSources?.();if(outputIdentity){let actual;try{actual=lstatSync(linkedOutput?file:part);}catch{throw effectError();}if(!actual.isFile()||actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}}:undefined;
  const checkCustomSources=(): void=>{if(opacity)opacityBinding?.assert();else if(customExport(e))validatePreparedTimelineSources(store.db,e.projectId,e.snapshot as never,preparedAssets as never,{root});};
  try {
   beforeEffect?.();
   if(fencedAttempt){outputHandle=await open(part,'wx');outputIdentity=await outputHandle.stat();beforeEffect?.();}
   if(e.mode==='timeline') {
    if(!opacity&&!isTimelineExportSnapshot(e.snapshot,{purpose:e.purpose}))throw Object.assign(Error('Invalid timeline export delivery profile'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    const assets=opacity?await prepareOpacityCandidateRenderInputs(store as never,e,{signal,beforeEffect}):await prepareTimelineInputs(e.snapshot as never,{root,projectId:e.projectId,signal,
     beforeEffect,readLut:readLut as never,readAsset:(id: string)=>{beforeEffect?.();return readOwnedTimelineAsset(store.db,e.projectId,id) as never;},validateLinks:(timeline: unknown)=>{beforeEffect?.();return validateFrozenTimelineSourceGraph(store.db,e.projectId,timeline as never);}});checkpoint(signal);
    if(currentOwnedExport(e)?.status!=='running')return;
    if(customExport(e)||restored)preparedAssets=assets as unknown as Map<string, unknown>;
    if(opacity){opacityBinding=bindTimelineOpacityRenderAttempt(store as never,e as never,assets,{signal});validateSources=()=>opacityBinding?.assert();}
    else if(fencedAttempt)validateSources=()=>validatePreparedTimelineSources(store.db,e.projectId,e.snapshot as never,preparedAssets as never,{root});
    const rendered=await renderTimeline(e.snapshot as never,assets as never,part,{signal,beforeEffect,readLut:readLut as never,...(customExport(e)?{beforeEncode:()=>{if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('The frozen export changed during local capability checking.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();}}:{})});checkpoint(signal);
    if(floatExport)floatMeasurement=ownedFloatTimelineMeasurement(rendered);
   } else {
    const files: string[]=[];
    const checkStoryboard=(): void=>{if(restored)for(const rawFrozen of arrayValue(e.snapshot)){const frozen=recordValue(rawFrozen);if(!frozen)throw workspaceRestoreError();const graph=createOwnedMediaGraphReader(store.db,e.projectId) as unknown as {asset(id: string): Record<string,unknown>; version(id: string,shotId: string,assetId: string): Record<string,unknown>},asset=graph.asset(String(frozen.assetId)),version=graph.version(String(frozen.versionId),String(frozen.shotId),String(frozen.assetId));if(asset.sha256!==frozen.sha256||version.sha256!==frozen.sha256)throw workspaceRestoreError();}};
    if(restored)validateSources=checkStoryboard;
    checkStoryboard();
    for(const rawVersion of arrayValue(e.snapshot)) {
     checkpoint(signal);
     const frozen=recordValue(rawVersion);if(!frozen)throw Error('Export snapshot hash mismatch');
     const asset=recordValue(get('assets',String(frozen.assetId)));
     if(!asset||asset.projectId!==e.projectId||asset.sha256!==frozen.sha256)throw Error('Export snapshot hash mismatch');
     const mediaPath=await safePath(root,String(asset.relativePath));checkpoint(signal);
     const actual=await fileInfo(mediaPath,{signal,beforeEffect});checkpoint(signal);
     if(actual.sha256!==frozen.sha256)throw Error('Export input bytes differ from frozen version hash');
     files.push(mediaPath);
    }
    if(currentOwnedExport(e)?.status!=='running')return;
    checkStoryboard();
    await stitch(files,part,{signal,beforeEffect,outputGeometry:storyboardOutputGeometry(e)});checkpoint(signal);
   }
   const info=await fileInfo(part,{signal,beforeEffect});checkpoint(signal);
   // Recheck the preserved relational owner immediately before publication.
   if(currentOwnedExport(e)?.status!=='running')return;
   checkCustomSources();
   if(colourExport)verifyTimelineColourLuts((property(e.snapshot,'colourPlan') as never),readLut as never,true);
   // Retain only this custom attempt's owned output inode for conservative
   // cleanup if source ownership changes before the database commit.
   if(customExport(e)||restored){
    const actual=await lstat(part);checkpoint(signal);beforeEffect?.();
    if(fencedAttempt&&outputIdentity&&(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino))throw effectError();
    outputIdentity=actual;
    if(!outputIdentity.isFile()||outputIdentity.nlink!==1)throw Object.assign(Error('The local export output cannot be verified safely.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    if(currentOwnedExport(e)?.status!=='running')return;
    checkCustomSources();
   }
   // link is an atomic, non-overwriting publication on the managed filesystem.
   beforeEffect?.();
   await link(part,file);linkedOutput=true;checkpoint(signal);beforeEffect?.();
   if(fencedAttempt&&outputIdentity){const actual=await lstat(part);beforeEffect?.();if(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}
   await unlink(part);checkpoint(signal);beforeEffect?.();
   tx(()=>{beforeEffect?.();if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('Invalid local export record.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();
    const output=e.mode==='timeline'?property(e.snapshot,'timeline') as Record<string, unknown>:storyboardOutputGeometry(e);const width=numberValue(property(output,'width'))??0,height=numberValue(property(output,'height'))??0,ratio=width===height?'1x1':width>height?'16x9':'9x16';
    const a: Record<string, unknown>&{url: string}={id:randomUUID(),projectId:e.projectId,name:e.mode==='timeline'?`多轨时间线-${e.purpose==='preview'?'预览':'导出'}-${ratio}.mp4`:`分镜拼接-${ratio}.mp4`,mimeType:'video/mp4',relativePath,...info,provenance:'export',createdAt:now(),url:''};a.url=`/media/${String(a.id)}`;put('assets',a);put('exports',{...e,status:'succeeded',assetId:a.id,url:a.url,error:null,...(floatExport&&floatMeasurement?{audioCheck:bindFloatTimelineMeasurement(e as never,floatMeasurement,now(),{assetId:String(a.id),sha256:info.sha256})}:{}),updatedAt:now()});});
   publicationAccepted=true;
  } catch(error) {
   terminationUnconfirmed=Boolean(property(error,'terminationUnconfirmed'));
   if(property(error,'terminationUnconfirmed'))failShutdown(error);
   const failExport=(): void=>{
    const latest=currentOwnedExport(e);
    const latestStatus=stringValue(property(latest,'status'));
    if(!latest||latestStatus==='cancelled'||(customExport(e)||restored)&&latestStatus==='succeeded')return;
    const audioCheck=floatExport&&!signal.aborted?(floatMeasurement?bindFloatTimelineMeasurement(e as never,floatMeasurement,now()):bindFloatTimelineFailure(e as never,error,now())):undefined;
    put('exports',{...(floatExport&&signal.aborted?requeueFloatTimelineExport(latest):latest),status:signal.aborted?'queued':'failed',error:property(error,'terminationUnconfirmed')?mediaPauseError('exports',latestStatus??'failed'):signal.aborted?null:{...safeError(error,'EXPORT_FAILED'),...(audioCheck?.code==='EXPORT_AUDIO_OVER_RANGE'?{retryable:false}:{})},...(audioCheck?{audioCheck}:{}),updatedAt:now()});
   };
   tx(failExport);
  } finally {
   claimLive=false;
   opacityBinding?.close();
   const cleanup=async(): Promise<void>=>{
   if(!fencedAttempt)await unlink(part).catch(()=>{});
   else if(outputIdentity){try{const actual=await lstat(part).catch(()=>null);if(actual?.isFile()&&actual.dev===outputIdentity.dev&&actual.ino===outputIdentity.ino&&currentOwnedExport(e,{cleanupOnly:Boolean(opacity)||floatExport}))await unlink(part).catch(()=>{});}catch{/* an uncertain read preserves the part file */}}
   // An uncertain commit, hostile replacement, foreign export, changed inode,
   // or failed cleanup never licenses removing an unknown/published output.
   // Keep the original failure; this cleanup makes no byte-race guarantee.
   if((customExport(e)||restored)&&linkedOutput&&!publicationAccepted&&outputIdentity){
    try{
     const unpublished=(): boolean=>{const latest=currentOwnedExport(e,{cleanupOnly:Boolean(opacity)||floatExport});const status=stringValue(property(latest,'status'));return Boolean(latest&&status!==undefined&&['queued','running','failed'].includes(status)&&latest.assetId===null&&latest.url===null);};
     if(unpublished()){
      const current=await lstat(file).catch(()=>null);
      if(current?.isFile()&&current.nlink===1&&current.dev===outputIdentity.dev&&current.ino===outputIdentity.ino&&unpublished())await unlink(file).catch(()=>{});
     }
    }catch{/* An uncertain read or cleanup preserves the link and original error. */}
   }
   if(outputHandle)await outputHandle.close().catch(()=>{});
   };
   if((opacity||floatExport||colourExport)&&terminationUnconfirmed)void waitForMediaProcesses({signal}).then(cleanup).catch(()=>{});
   else await cleanup();
   if(opacity)revokeOpacityCandidateExportClaim(store as never,e as never);
  }
 }

 async function operate(value: JobRecord|ExportRecord,action: WorkerOperation): Promise<void> {
  if(stopped)return;
  const controller=new AbortController();operations.add(controller);
  try {await action(value as never,controller.signal);}
  finally {
   controller.abort();
   // An adapter await can be abandoned, but owned children cannot. Retain this
   // operation's signal until its remaining direct children have been reaped.
   try {assertMediaTerminated(await terminateMediaProcesses({signal:controller.signal}));}
   catch(error) {failShutdown(error);persistMediaPause(action===processJob as never?'jobs':'exports',value.id,value.projectId,property(value,'mode'),floatClaims.read(controller.signal));throw error;}
   finally {operations.delete(controller);}
  }
 }
 function tick(): Promise<void> {
  if(stopped)return Promise.resolve();
  if(cycle)return cycle;
  cycle=(async()=>{
   try {
    for(const j of restored||opacity?[]:list('jobs')){const job=recordValue(j) as JobRecord|null;if(job&&!stopped&&typeof job.status==='string'&&['queued','running','downloading','submission_unknown'].includes(job.status))await operate(job,processJob as WorkerOperation);}
    if(stopped)return;
    for(const e of workerExports())if(!stopped&&e.status==='queued')await operate(e,processExport as unknown as WorkerOperation);
   } catch(error) {console.error('Worker cycle failed:',stringValue(property(error,'code'))||String(property(error,'name')));}
  })().finally(()=>{cycle=null;});
  return cycle;
 }
 const timer=setInterval(tick,200);
 const abort=(): void=>{stopped=true;clearInterval(timer);for(const controller of operations)controller.abort();};
 ownerSignal?.addEventListener('abort',abort,{once:true});
 if(stopped)clearInterval(timer);else void tick();
 return {
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

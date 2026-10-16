import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {isOpacityCandidateServicesForStore} from './opacity-candidate-services.ts';
import {matchesOpacityCandidateExport,claimOpacityCandidateExport,recoverOpacityCandidateExport,isOpacityCandidateExportClaim,revokeOpacityCandidateExportClaim,prepareOpacityCandidateRenderInputs} from './opacity-candidate-render-authority.ts';
import {bindTimelineOpacityRenderAttempt} from './timeline-opacity-render-binding.ts';
import {isFloatTimelineExport,claimFloatTimelineExport,sameFloatTimelineAttempt,requeueFloatTimelineExport,createFloatTimelineAttemptRegistry,ownedFloatTimelineMeasurement,bindFloatTimelineMeasurement,bindFloatTimelineFailure,assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {createTimelineColourLutReader,verifyTimelineColourLuts} from './timeline-colour-lut.ts';
import {requiresPreparedTimelineExportIdentity,hasSelectedTimelineExportRange,timelineExportRangeEffectError} from './timeline-export-range.ts';
import {timelineRenderDeliveryFields,hasTimelineDeliveryIdentity,TIMELINE_DELIVERY_RECEIPT_SQL} from '@mioon/contracts/timeline-delivery';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {matchesRestoredExport,restoreExportIdentity} from './workspace-restore-exports.mjs';
import {workspaceRestoreError} from './workspace-restore-policy.mjs';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.mjs';
import {isTimelineExportSnapshot,isTimelineRenderRecord} from '@mioon/contracts';
import {lstatSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {terminateMediaProcesses,waitForMediaProcesses} from './media-processes.mjs';
import {rename,link,unlink,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {fileInfo,probe,safePath,stitch,run} from './media.mjs';
import {renderTimeline} from './timeline-media.mjs';
import {readTimelineReceipt} from './timeline-recovery.mjs';
import {prepareTimelineInputs,readOwnedTimelineAsset,validateFrozenTimelineSourceGraph,validatePreparedTimelineSources} from './timeline-sources.mjs';
import {now} from './services.mjs';
import {markGenerationPreflightFailure,isGenerationPreflightFailure} from './generation-inputs.mjs';
import {assertMediaTerminated,awaitProvider,boundedShutdown,checkpoint} from './operation-lifecycle.mjs';

export function startWorker(store,services,providers,{signal:ownerSignal}={}) {
 const opacity=getOpacityCandidateAssembly(store);
 if(opacity&&!isOpacityCandidateServicesForStore(store,services))throw Object.assign(Error('The candidate worker requires its exact owned services.'),{code:'OPACITY_CANDIDATE_STORE_REQUIRED'});
 const restored=opacity?opacity.getRestoreContext():getWorkspaceRestoreContext(store);
 const {list,get,put,tx,root}=store;
 let stopped=Boolean(ownerSignal?.aborted),cycle=null,stopping,shutdownFailure;
 const operations=new Set(),floatClaims=createFloatTimelineAttemptRegistry();
 // Preserve relational identity before decoding worker-owned timeline exports.
 // This bound applies to the frozen export row, never its source bytes or the
 // combined jobs behind its lineages. Corrupt/oversized timeline rows are
 // left untouched. SQLite classifies mode before materialization; ordinary
 // storyboard rows retain their existing unbounded legacy handling.
 const exportUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
 const exportRowBytes=4*1024*1024,identity=column=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
 const exportColumns=`${identity('id')},${identity('projectId')},
  CASE WHEN typeof(data)='text' THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data)='object' THEN
   CASE WHEN (SELECT count(*) FROM json_each(exports.data) WHERE key='mode')<=1 THEN
    CASE WHEN json_type(data,'$.mode')='text' AND length(CAST(json_extract(data,'$.mode') AS BLOB))=8 AND json_extract(data,'$.mode')='timeline'
     THEN CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${exportRowBytes} THEN data END
     ELSE ${restored?`CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${exportRowBytes} THEN data END`:'data'} END
   END END END END AS data`;
 let invalidExportReported=false;
 const invalidExport=()=>{if(!invalidExportReported){invalidExportReported=true;console.error('Skipped invalid local export record.');}return null;};
 function decodeExport(row){
  if(!row)return null;
  if(typeof row.data!=='string')return invalidExport();
  let record;try{record=JSON.parse(row.data);}catch{return invalidExport();}
  if(!record||typeof record!=='object'||Array.isArray(record)||!exportUuid(row.id)||!exportUuid(row.projectId)||!exportUuid(record.id)||!exportUuid(record.projectId))return invalidExport();
  if(record.id!==row.id||record.projectId!==row.projectId)return invalidExport();
  if(record.mode==='timeline'&&record.snapshot?.timeline?.projectId!==row.projectId)return invalidExport();
  try{if(opacity){if(!matchesOpacityCandidateExport(store,record))return invalidExport();}else assertFloatTimelineExportRead(store.db,record,{isTimelineRenderRecord,readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(store.db,projectId,assetId)});}catch{return invalidExport();}
  return record;
 }
 const workerExports=()=>store.db.prepare(`SELECT ${exportColumns} FROM exports${restored?" WHERE id IN (SELECT exportId FROM workspace_restore_export_origins WHERE workspaceOrigin=?) AND CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END IN ('queued','running') ORDER BY id":''}`).all(...(restored?[restored.workspaceOrigin]:[])).map(decodeExport).filter(value=>value&&(!restored||(opacity?matchesOpacityCandidateExport(store,value):matchesRestoredExport(store,value))));
 const workerExport=id=>decodeExport(store.db.prepare(`SELECT ${exportColumns} FROM exports WHERE id=?`).get(id));
 // Custom delivery adds an awaited capability step. Preserve the complete
 // immutable acceptance identity across every existing async/publication fence;
 // a replaced snapshot must never be restored by publishing an older copy.
 const customExport=e=>Boolean(opacity)||requiresPreparedTimelineExportIdentity(e)||Boolean(e?.snapshot&&Object.hasOwn(e.snapshot,'colourPlan'));
 const exportIdentity=e=>JSON.stringify(Object.fromEntries(['id','projectId','requestId','mode','purpose','timelineRevision','snapshot','createdAt'].map(key=>[key,e[key]])));
 // A removed delivery field must not disguise an accepted custom export as
 // a historical legacy job before the worker's first observation. The bounded
 // receipt-side discriminator adds no normalization or legacy render options.
 function receiptHasDelivery(e){
  if(e.mode!=='timeline'||typeof e.requestId!=='string')return false;
  const row=store.db.prepare(`SELECT CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${exportRowBytes}
   THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response)='object' THEN ${TIMELINE_DELIVERY_RECEIPT_SQL} END END END AS delivery
   FROM timeline_requests WHERE requestId=?`).get(e.requestId);
  return row?.delivery!==undefined&&row.delivery!==null;
 }
 function customReceiptMatches(e){
  try{
   if(opacity)return matchesOpacityCandidateExport(store,e);
   const input={projectId:e.projectId,requestId:e.requestId,expectedRevision:e.timelineRevision,purpose:e.purpose,...timelineRenderDeliveryFields(e.snapshot)};
   if(typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200)return false;
   const receipt=readTimelineReceipt(store.db,input,'timeline.render');
   if(!receipt)return false;
   const response=JSON.parse(receipt.response);
   return response.status==='queued'&&isTimelineRenderRecord(response,input)&&exportIdentity(response)===exportIdentity(e);
  }catch{return false;}
 }
 const currentOwnedExport=(e,{cleanupOnly=false}={})=>{
  const latest=workerExport(e.id);
  if(opacity){if(!matchesOpacityCandidateExport(store,e)||!matchesOpacityCandidateExport(store,latest)||exportIdentity(e)!==exportIdentity(latest)||!cleanupOnly&&e.status==='running'&&!isOpacityCandidateExportClaim(store,e))return null;}
  else if(restored&&(!matchesRestoredExport(store,e)||!matchesRestoredExport(store,latest)||restoreExportIdentity(e)!==restoreExportIdentity(latest)))return null;
  if(!latest||latest.mode!==e.mode||latest.id!==e.id||latest.projectId!==e.projectId)return null;
  if((opacity||hasTimelineDeliveryIdentity(e)||hasTimelineDeliveryIdentity(latest)||receiptHasDelivery(e))&&(exportIdentity(latest)!==exportIdentity(e)||!customReceiptMatches(e)))return null;
  if(!cleanupOnly&&!sameFloatTimelineAttempt(e,latest))return null;
  return latest;
 };

 // An unconfirmed owned writer is a fatal lifecycle boundary. Preserve the
 // first failure and stop this cycle plus every future automatic/manual tick.
 const failShutdown=error=>{shutdownFailure??=error;abort();};
 const mediaPauseError=(table,status)=>table==='jobs'&&status==='submission_unknown'
  ?{code:'SUBMISSION_UNKNOWN',message:'供应商可能已受理，结果尚未确认；不会自动重新提交生成。本地媒体进程退出尚未确认，后台已暂停后续任务。',retryable:false}
  :{code:'MEDIA_TERMINATION_UNCONFIRMED',message:'本地媒体进程退出尚未确认，后台已暂停后续任务。已保留现有任务与快照，请确认进程退出后重新启动。',retryable:false};
 const persistMediaPause=(table,id,projectId,mode,attempt)=>{
  const apply=()=>{
   const latest=table==='exports'?workerExport(id):get(table,id);
   if(!latest||['succeeded','cancelled'].includes(latest.status)||table==='exports'&&(latest.mode!==mode||latest.projectId!==projectId))return;
   if(opacity&&(table!=='exports'||!matchesOpacityCandidateExport(store,latest)))return;
   else if(restored&&!opacity&&(table!=='exports'||!matchesRestoredExport(store,latest)))return;
   if(table==='exports'&&isFloatTimelineExport(latest)&&(!attempt||!sameFloatTimelineAttempt(attempt,latest)))return;
   const error=mediaPauseError(table,latest.status);
   if(latest.error?.code===error.code&&latest.error?.message===error.message)return;
   if(table==='jobs')services.saveJob(latest,{error});
   else put('exports',{...latest,error,updatedAt:now()});
  };
  if(table==='exports')tx(apply);else apply();
 };
 const safeError=(e,code='PROVIDER_ERROR')=>({code:e.code||code,message:e.uncertain?'供应商可能已受理。正在对账，不会自动重新提交。':String(e.message||'任务操作失败').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi,'[redacted]').slice(0,600),retryable:true});
 for(const j of restored||opacity?[]:list('jobs'))if(j.status==='submitting')services.saveGenerationGuarded(j,{status:'submission_unknown',phase:'recovering_submit',error:{code:'SUBMISSION_UNKNOWN',message:'服务在提交期间中断；先对账，绝不盲目重新提交',retryable:true}});
 for(const e of workerExports())if(e.status==='running')tx(()=>{
  if(opacity){recoverOpacityCandidateExport(store,e,now());return;}
  const current=currentOwnedExport(e);if(current?.status==='running')put('exports',{...(isFloatTimelineExport(current)?requeueFloatTimelineExport(current):current),status:'queued',updatedAt:now()});
 });

 async function processJob(original,signal) {
  checkpoint(signal);
  let j=get('jobs',original.id);
  if(!j)return;
  const provider=providers.get(j.providerId),context={requestId:j.requestId,jobId:j.id,providerRegion:j.snapshot.capabilities?.region,signal};
  let acceptedProviderId=null,guardJob=j;
  const submissionCount=j.submissionCount;
  if(j.nextPollAt&&Date.now()<j.nextPollAt)return;
  try {
   if(j.status==='queued') {
    services.validateGenerationDispatch(j);
    const preparedSnapshot=JSON.stringify(j.snapshot);
    // Prepare references before recording an attempt. A shutdown here has not
    // called an adapter and must leave the original queued snapshot untouched.
    const referenceAssets=[];
    for(const ref of j.snapshot.referenceAssets) {
     checkpoint(signal);
     const asset=get('assets',ref.id);
     if(!asset||asset.projectId!==j.projectId||asset.sha256!==ref.sha256)throw Error('Reference snapshot no longer matches managed asset');
     const file=await safePath(root,asset.relativePath);checkpoint(signal);
     // A source owner can change during an awaited path read, before an
     // adapter's own byte reads and final POST fence begin.
     services.validateGenerationDispatch(j);
     referenceAssets.push({...ref,path:file});
    }
    checkpoint(signal);
    const current=get('jobs',j.id);
    if(!current||current.status!=='queued')return;
    j=current;
    if(JSON.stringify(j.snapshot)!==preparedSnapshot)throw Object.assign(Error('准备素材期间冻结快照已改变'),{code:'INVALID_REFERENCE_MANIFEST'});
    services.validateGenerationDispatch(j);
    const claimed=services.saveGenerationGuarded(guardJob,{status:'submitting',phase:'provider_submit',submissionCount:submissionCount+1});
    if(!claimed)return;
    j=claimed;guardJob=claimed;
    const claim=j;
    // Shared HTTP adapters invoke this synchronous fence after image preparation
    // and immediately before POST. No callback is used for poll/download/reconcile.
    context.beforeSubmit=()=>{
     try{
      const latest=get('jobs',claim.id);
      if(!latest||latest.status!=='submitting'||latest.revision!==claim.revision||JSON.stringify(latest.snapshot)!==preparedSnapshot)throw Object.assign(Error('提交前任务状态已更改'),{code:'GENERATION_STATE_CHANGED'});
      services.validateGenerationDispatch(claim);
     }catch(error){throw markGenerationPreflightFailure(error);}
    };
    // During both image reads the same non-mutating claim/ownership fence
    // rejects drift. The final beforeSubmit fence still runs directly at POST.
    context.validateReferenceState=context.beforeSubmit;
    const accepted=await awaitProvider(()=>provider.submit({...j.snapshot,referenceAssets},context),signal,{submit:true});
    acceptedProviderId=accepted.providerJobId;
    // Receipt persistence is the sole intentional write permitted after abort.
    // awaitProvider only delivers receipts inside its bounded settlement window.
    const latest=get('jobs',j.id);
    services.saveJob(latest,{providerJobId:acceptedProviderId,...latest.status==='cancelled'?{}:{status:'running',phase:'polling',progress:5,error:null}});
    return;
   }
   if(j.status==='submission_unknown') {
    const found=j.providerJobId?{providerJobId:j.providerJobId}:await awaitProvider(()=>provider.reconcile(j.requestId,context),signal);
    checkpoint(signal);
    if(found)services.saveJob(j,{status:'running',phase:'reconciled',providerJobId:found.providerJobId,error:null,nextPollAt:0});
    else services.saveJob(j,{nextPollAt:Date.now()+5000});
    return;
   }
   if(j.status==='running') {
    const remote=await awaitProvider(()=>provider.poll(j.providerJobId,context),signal);checkpoint(signal);
    if(get('jobs',j.id).status==='cancelled')return;
    if(remote.status==='failed'){services.saveJob(j,{status:'failed',phase:'provider_failed',error:typeof remote.error==='object'?remote.error:{code:'GENERATION_FAILED',message:remote.error||'供应商任务失败',retryable:true}});return;}
    if(remote.status!=='succeeded'){services.saveJob(j,{progress:remote.progress==null?j.progress:Math.round(remote.progress*100),nextPollAt:Date.now()+(provider.capabilities.minPollIntervalMs||350),error:null});return;}
    j=services.saveJob(j,{status:'downloading',phase:'downloading',progress:90,nextPollAt:0,error:null});
   }
   if(j.status==='downloading') {
    checkpoint(signal);
    const relativePath=`media/result-${j.id}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';
    let info;
    try {
     info=await fileInfo(file,{signal});checkpoint(signal);
     if(!info.hasVideo)throw Error('Generated output must contain video');
    } catch(error) {
     if(error.terminationUnconfirmed)throw error;
     checkpoint(signal);
     await awaitProvider(()=>provider.download(j.providerJobId,part,context),signal);checkpoint(signal);
     info=await fileInfo(part,{signal});checkpoint(signal);
     if(!info.hasVideo)throw Error('Generated output must contain video');
     await run('ffmpeg',['-v','error','-i',part,'-f','null','-'],{signal});checkpoint(signal);
     await rename(part,file);checkpoint(signal);
    }
    if(get('jobs',j.id).status==='cancelled')return;
    if(!provider.capabilities.mock) {
     const [ratioWidth,ratioHeight]=j.snapshot.aspectRatio.split(':').map(Number);
     const actualRatio=info.width/info.height,expectedRatio=ratioWidth/ratioHeight;
     if(!Number.isFinite(actualRatio)||Math.abs(actualRatio/expectedRatio-1)>0.01) {
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_ASPECT_RATIO_MISMATCH',message:'供应商已完成，但下载的视频比例与镜头要求不符。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
    }
    checkpoint(signal);
    tx(()=>{const previous=list('versions',j.projectId).find(v=>v.jobId===j.id);if(previous){services.saveJob(j,{status:'succeeded',phase:'complete',versionId:previous.id,progress:100,error:null});return;}
     const asset={id:randomUUID(),projectId:j.projectId,name:`${j.snapshot.title} ${j.providerId==='mock'?'模拟':'生成'}视频.mp4`,mimeType:'video/mp4',...info,relativePath,url:null,provenance:j.providerId==='mock'?'synthetic-mock':'generated',createdAt:now()};asset.url=`/media/${asset.id}`;put('assets',asset);
     const version={id:randomUUID(),projectId:j.projectId,shotId:j.shotId,jobId:j.id,number:list('versions',j.projectId).filter(v=>v.shotId===j.shotId).length+1,providerId:j.providerId,model:j.model,isMock:j.providerId==='mock',snapshot:j.snapshot,assetId:asset.id,url:asset.url,sha256:info.sha256,createdAt:now()};put('versions',version);
     const s=get('shots',j.shotId);if(!s.selectedVersionId)put('shots',{...s,selectedVersionId:version.id,revision:s.revision+1,updatedAt:now()});services.saveJob(j,{status:'succeeded',phase:'complete',progress:100,versionId:version.id,error:null});
    });
   }
  } catch(error) {
   if(error.terminationUnconfirmed)failShutdown(error);
   const latest=get('jobs',guardJob.id);
   if(latest?.status==='cancelled')return;
   if(j.status==='submitting') {
    if(isGenerationPreflightFailure(error)&&!acceptedProviderId){
     // This fence ran before fetch, so no attempt was dispatched. Do not
     // overwrite a concurrent cancellation or requeue a rejected paid action.
     services.saveGenerationGuarded(guardJob,{status:'failed',phase:'input_preflight_failed',submissionCount,error:safeError(error),nextPollAt:0});
     return;
    }
    if(!latest)return;
    if(error.beforeDispatch===true&&!acceptedProviderId) {
     services.saveGenerationGuarded(guardJob,{status:'queued',phase:'waiting',submissionCount,error:null,nextPollAt:0});
     if(error.terminationUnconfirmed)persistMediaPause('jobs',j.id);
     return;
    }
    const uncertain=Boolean(error.uncertain||acceptedProviderId||signal.aborted);
    services.saveJob(latest,{status:uncertain?'submission_unknown':'failed',phase:uncertain?'reconciliation_required':'submit_failed',...(acceptedProviderId?{providerJobId:acceptedProviderId}:{}),error:safeError(uncertain?{code:'SUBMISSION_UNKNOWN',uncertain:true}:error),nextPollAt:Date.now()+800});
    if(error.terminationUnconfirmed)persistMediaPause('jobs',j.id);
   } else if(signal.aborted) {
    // Poll/download cancellation preserves the existing task and snapshot. A
    // restart resumes that task; it never creates a replacement generation.
    if(error.terminationUnconfirmed)persistMediaPause('jobs',j.id);
    return;
   } else if(j.providerId==='mock'&&j.status==='downloading'&&error.code==='MOCK_RENDERER_UNSUPPORTED')services.saveJob(latest,{status:'failed',phase:'provider_failed',error:{...safeError(error),retryable:false},nextPollAt:0});
   else if(['running','downloading','submission_unknown'].includes(j.status))services.saveJob(latest,{error:safeError(error,j.status==='downloading'?'DOWNLOAD_FAILED':'POLL_ERROR'),nextPollAt:Date.now()+1000});
   else services.saveGenerationGuarded(guardJob,{status:'failed',error:safeError(error)});
  }
 }

 async function processExport(original,signal) {
  checkpoint(signal);
  let e=original;
  if(!exportUuid(e.id)||!exportUuid(e.projectId)){invalidExport();return;}
  e=tx(()=>{const current=currentOwnedExport(original);if(current?.status!=='queued')return null;if(opacity)return claimOpacityCandidateExport(store,current,now());const claimed=isFloatTimelineExport(current)?claimFloatTimelineExport(current,now()):{...current,status:'running',updatedAt:now()};put('exports',claimed);return isFloatTimelineExport(current)?claimed:current;});
  if(!e)return;
  floatClaims.remember(signal,e);
  const floatExport=isFloatTimelineExport(e);
  // Fresh non-overwriting publication also preserves a prior successful output.
  const relativePath=`media/export-${e.id}-${randomUUID()}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';
  const colourExport=Boolean(e?.snapshot&&Object.hasOwn(e.snapshot,'colourPlan'));
  const readLut=colourExport?createTimelineColourLutReader(store.db,e.projectId):undefined;
  const fencedAttempt=opacity||restored||floatExport||hasSelectedTimelineExportRange(e.snapshot)||colourExport,effectError=restored?workspaceRestoreError:timelineExportRangeEffectError;
  let preparedAssets,opacityBinding,linkedOutput=false,publicationAccepted=false,outputIdentity,outputHandle,claimLive=true,validateSources,floatMeasurement,terminationUnconfirmed=false;
  const beforeEffect=fencedAttempt?()=>{if(!claimLive||stopped||signal.aborted||currentOwnedExport(e)?.status!=='running')throw effectError();validateSources?.();if(outputIdentity){let actual;try{actual=lstatSync(linkedOutput?file:part);}catch{throw effectError();}if(!actual.isFile()||actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}}:undefined;
  const checkCustomSources=()=>{if(opacity)opacityBinding?.assert();else if(customExport(e))validatePreparedTimelineSources(store.db,e.projectId,e.snapshot,preparedAssets,{root});};
  try {
   beforeEffect?.();
   if(fencedAttempt){outputHandle=await open(part,'wx');outputIdentity=await outputHandle.stat();beforeEffect();}
   if(e.mode==='timeline') {
    if(!opacity&&!isTimelineExportSnapshot(e.snapshot,{purpose:e.purpose}))throw Object.assign(Error('Invalid timeline export delivery profile'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    const assets=opacity?await prepareOpacityCandidateRenderInputs(store,e,{signal,beforeEffect}):await prepareTimelineInputs(e.snapshot,{root,projectId:e.projectId,signal,
     beforeEffect,readLut,readAsset:id=>{beforeEffect?.();return readOwnedTimelineAsset(store.db,e.projectId,id);},validateLinks:timeline=>{beforeEffect?.();return validateFrozenTimelineSourceGraph(store.db,e.projectId,timeline);}});checkpoint(signal);
    if(currentOwnedExport(e)?.status!=='running')return;
    if(customExport(e)||restored)preparedAssets=assets;
    if(opacity){opacityBinding=bindTimelineOpacityRenderAttempt(store,e,assets,{signal});validateSources=()=>opacityBinding.assert();}
    else if(fencedAttempt)validateSources=()=>validatePreparedTimelineSources(store.db,e.projectId,e.snapshot,preparedAssets,{root});
    const rendered=await renderTimeline(e.snapshot,assets,part,{signal,beforeEffect,readLut,...(customExport(e)?{beforeEncode:()=>{if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('The frozen export changed during local capability checking.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();}}:{})});checkpoint(signal);
    if(floatExport)floatMeasurement=ownedFloatTimelineMeasurement(rendered);
   } else {
    const files=[];
    const checkStoryboard=()=>{if(restored)for(const frozen of e.snapshot){const graph=createOwnedMediaGraphReader(store.db,e.projectId),asset=graph.asset(frozen.assetId),version=graph.version(frozen.versionId,frozen.shotId,frozen.assetId);if(asset.sha256!==frozen.sha256||version.sha256!==frozen.sha256)throw workspaceRestoreError();}};
    if(restored)validateSources=checkStoryboard;
    checkStoryboard();
    for(const v of e.snapshot) {
     checkpoint(signal);
     const a=get('assets',v.assetId);
     if(!a||a.projectId!==e.projectId||a.sha256!==v.sha256)throw Error('Export snapshot hash mismatch');
     const mediaPath=await safePath(root,a.relativePath);checkpoint(signal);
     const actual=await fileInfo(mediaPath,{signal,beforeEffect});checkpoint(signal);
     if(actual.sha256!==v.sha256)throw Error('Export input bytes differ from frozen version hash');
     files.push(mediaPath);
    }
    if(currentOwnedExport(e)?.status!=='running')return;
    checkStoryboard();
    await stitch(files,part,{signal,beforeEffect});checkpoint(signal);
   }
   const info=await fileInfo(part,{signal,beforeEffect});checkpoint(signal);
   // Recheck the preserved relational owner immediately before publication.
   if(currentOwnedExport(e)?.status!=='running')return;
   checkCustomSources();
   if(colourExport)verifyTimelineColourLuts(e.snapshot.colourPlan,readLut,true);
   // Retain only this custom attempt's owned output inode for conservative
   // cleanup if source ownership changes before the database commit.
   if(customExport(e)||restored){
    const actual=await lstat(part);checkpoint(signal);beforeEffect?.();
    if(fencedAttempt&&(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino))throw effectError();
    outputIdentity=actual;
    if(!outputIdentity.isFile()||outputIdentity.nlink!==1)throw Object.assign(Error('The local export output cannot be verified safely.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
    if(currentOwnedExport(e)?.status!=='running')return;
    checkCustomSources();
   }
   // link is an atomic, non-overwriting publication on the managed filesystem.
   beforeEffect?.();
   await link(part,file);linkedOutput=true;checkpoint(signal);beforeEffect?.();
   if(fencedAttempt){const actual=await lstat(part);beforeEffect();if(actual.dev!==outputIdentity.dev||actual.ino!==outputIdentity.ino)throw effectError();}
   await unlink(part);checkpoint(signal);beforeEffect?.();
   tx(()=>{beforeEffect?.();if(currentOwnedExport(e)?.status!=='running')throw Object.assign(Error('Invalid local export record.'),{code:'INVALID_TIMELINE_SNAPSHOT'});checkCustomSources();const ratio=e.mode==='timeline'?(e.snapshot.timeline.width===e.snapshot.timeline.height?'1x1':e.snapshot.timeline.width>e.snapshot.timeline.height?'16x9':'9x16'):null;const a={id:randomUUID(),projectId:e.projectId,name:e.mode==='timeline'?`多轨时间线-${e.purpose==='preview'?'预览':'导出'}-${ratio}.mp4`:'分镜拼接-9x16.mp4',mimeType:'video/mp4',relativePath,...info,provenance:'export',createdAt:now()};a.url=`/media/${a.id}`;put('assets',a);put('exports',{...e,status:'succeeded',assetId:a.id,url:a.url,error:null,...(floatExport?{audioCheck:bindFloatTimelineMeasurement(e,floatMeasurement,now(),{assetId:a.id,sha256:a.sha256})}:{}),updatedAt:now()});});
   publicationAccepted=true;
  } catch(error) {
   terminationUnconfirmed=Boolean(error.terminationUnconfirmed);
   if(error.terminationUnconfirmed)failShutdown(error);
   const fail=()=>{
    const latest=currentOwnedExport(e);
    if(!latest||latest.status==='cancelled'||(customExport(e)||restored)&&latest.status==='succeeded')return;
    const audioCheck=floatExport&&!signal.aborted?(floatMeasurement?bindFloatTimelineMeasurement(e,floatMeasurement,now()):bindFloatTimelineFailure(e,error,now())):undefined;
    put('exports',{...(floatExport&&signal.aborted?requeueFloatTimelineExport(latest):latest),status:signal.aborted?'queued':'failed',error:error.terminationUnconfirmed?mediaPauseError('exports',latest?.status):signal.aborted?null:{...safeError(error,'EXPORT_FAILED'),...(audioCheck?.code==='EXPORT_AUDIO_OVER_RANGE'?{retryable:false}:{})},...(audioCheck?{audioCheck}:{}),updatedAt:now()});
   };
   tx(fail);
  } finally {
   claimLive=false;
   opacityBinding?.close();
   const cleanup=async()=>{
   if(!fencedAttempt)await unlink(part).catch(()=>{});
   else if(outputIdentity){try{const actual=await lstat(part).catch(()=>null);if(actual?.isFile()&&actual.dev===outputIdentity.dev&&actual.ino===outputIdentity.ino&&currentOwnedExport(e,{cleanupOnly:Boolean(opacity)||floatExport}))await unlink(part).catch(()=>{});}catch{}}
   // An uncertain commit, hostile replacement, foreign export, changed inode,
   // or failed cleanup never licenses removing an unknown/published output.
   // Keep the original failure; this cleanup makes no byte-race guarantee.
   if((customExport(e)||restored)&&linkedOutput&&!publicationAccepted&&outputIdentity){
    try{
     const unpublished=()=>{const latest=currentOwnedExport(e,{cleanupOnly:Boolean(opacity)||floatExport});return latest&&['queued','running','failed'].includes(latest.status)&&latest.assetId===null&&latest.url===null;};
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
   if(opacity)revokeOpacityCandidateExportClaim(store,e);
  }
 }

 async function operate(action,value) {
  if(stopped)return;
  const controller=new AbortController();operations.add(controller);
  try {await action(value,controller.signal);}
  finally {
   controller.abort();
   // An adapter await can be abandoned, but owned children cannot. Retain this
   // operation's signal until its remaining direct children have been reaped.
   try {assertMediaTerminated(await terminateMediaProcesses({signal:controller.signal}));}
   catch(error) {failShutdown(error);persistMediaPause(action===processJob?'jobs':'exports',value.id,value.projectId,value.mode,floatClaims.read(controller.signal));throw error;}
   finally {operations.delete(controller);}
  }
 }
 function tick() {
  if(stopped)return Promise.resolve();
  if(cycle)return cycle;
  cycle=(async()=>{
   try {
    for(const j of restored||opacity?[]:list('jobs'))if(!stopped&&['queued','running','downloading','submission_unknown'].includes(j.status))await operate(processJob,j);
    if(stopped)return;
    for(const e of workerExports())if(!stopped&&e.status==='queued')await operate(processExport,e);
   } catch(error) {console.error('Worker cycle failed:',error.code||error.name);}
  })().finally(()=>{cycle=null;});
  return cycle;
 }
 const timer=setInterval(tick,200);
 const abort=()=>{stopped=true;clearInterval(timer);for(const controller of operations)controller.abort();};
 ownerSignal?.addEventListener('abort',abort,{once:true});
 if(stopped)clearInterval(timer);else tick();
 return {
  stop:()=>stopping??=(async()=>{
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

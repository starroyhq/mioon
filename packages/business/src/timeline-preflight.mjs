import {timelineExportRangeFields,isTimelineExportRangeWithinDuration} from '@mioon/contracts/timeline-export-range';
import {timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import {timelineDeliveryNameFields} from '@mioon/contracts/timeline-delivery';
import {restoreEffectFence} from './workspace-restore-invocation.mjs';
import {refuseRestoredOperation,safeWorkspaceRestoreError} from './workspace-restore-policy.mjs';
import {AppError,EXPORT_PREFLIGHT_LIMITS,timelineOutputPreset} from '@mioon/contracts';
import {createHash} from 'node:crypto';
import {readTimelinePreflightSnapshot,readOwnedTimelineAsset,prepareTimelineInputs,probeTimelineSource} from './timeline-sources.mjs';
import {validateTimeline,validateSavedTimeline} from './timeline-inputs.mjs';
import {terminateMediaProcesses} from './media-processes.mjs';
import {checkpoint,assertMediaTerminated,awaitProvider,boundedShutdown} from './operation-lifecycle.mjs';
import {verifySubtitleFontResource,validateSubtitleSnapshotProfile} from './subtitle-resources.mjs';

const messages=Object.freeze({
 EXPORT_RANGE_BOUNDS:'The export range must fit inside the saved timeline and contain at least one 30fps frame; the end is exclusive.',
 SUBTITLE_RESOURCE_UNAVAILABLE:'The bundled subtitle font is missing or does not match this rendering profile.',
 TIMELINE_MISSING:'This project has no saved timeline. Add clips and save the timeline before exporting.',
 EMPTY_TIMELINE:'The saved timeline has no clips to export.',
 INVALID_TIMELINE_SNAPSHOT:'The saved timeline contains invalid or unsupported settings.',
 TIMELINE_SOURCE_UNAVAILABLE:'A referenced source is missing or is not available in this project.',
 PREFLIGHT_SOURCE_INVALID:'A source is missing or cannot be accessed safely in managed media.',
 PREFLIGHT_SOURCE_CHANGED:'A source changed or its bytes do not match the saved hash.',
 PREFLIGHT_MEDIA_INVALID:'A source has invalid or unsupported media metadata.',
 PREFLIGHT_INCOMPLETE:'The bounded media check could not finish. Export will verify the sources again.',
 PREFLIGHT_SNAPSHOT_BUDGET:'The saved metadata exceeds the bounded check budget. No media was changed.',
 PREFLIGHT_BUDGET:'The bounded file or total byte budget was reached. Export is still available.',
 PREFLIGHT_TIMEOUT:'The bounded media check reached its time limit. Export is still available.',
 PREFLIGHT_BUSY:'Another export check is running. Try this check again when it finishes.',
 PREFLIGHT_STALE:'The saved timeline or its source metadata changed. Run the check again.',
});
const issue=(code,severity='error')=>({code,severity,message:messages[code]});
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const timelineSnapshotHash=snapshot=>createHash('sha256').update(canonical(snapshot)).digest('hex');
function summary(snapshot,verified){
 const t=snapshot.timeline,assets=verified??new Map(snapshot.assets.map(a=>[a.id,a])),tracks=new Map(t.tracks.map(lane=>[lane.id,lane]));
 if(!isTimelineExportRangeWithinDuration(snapshot,t.durationFrames)||!timelineOutputPreset(t)||!Number.isInteger(t.durationFrames)||t.durationFrames<0||t.durationFrames>18000)return null;
 return {...timelineDeliveryNameFields(snapshot),...timelineExportRangeFields(snapshot),...(Object.hasOwn(snapshot,'delivery')?{delivery:snapshot.delivery}:{}),fps:t.fps,width:t.width,height:t.height,durationFrames:t.durationFrames,trackCount:t.tracks.length,clipCount:t.clips.length,assetCount:assets.size,
  visualClipCount:t.clips.filter(c=>tracks.get(c.trackId)?.kind==='video'&&!tracks.get(c.trackId).hidden).length,
  audibleClipCount:t.clips.filter(c=>tracks.has(c.trackId)&&!tracks.get(c.trackId).muted&&c.gain>0&&assets.get(c.assetId)?.hasAudio===true).length,
  mutedTrackCount:t.tracks.filter(lane=>lane.muted===true).length,hiddenVideoTrackCount:t.tracks.filter(lane=>lane.kind==='video'&&lane.hidden===true).length};
}
function classify(error){
 if(error.code==='SUBTITLE_RESOURCE_UNAVAILABLE')return ['blocked','SUBTITLE_RESOURCE_UNAVAILABLE'];
 if(error.code==='INSPECTION_BUDGET_EXCEEDED')return ['incomplete','PREFLIGHT_SNAPSHOT_BUDGET'];
 if(error.code==='MANAGED_SOURCE_LIMIT'||error.code==='PREFLIGHT_BUDGET')return ['incomplete','PREFLIGHT_BUDGET'];
 if(['MEDIA_TIMEOUT','MEDIA_OUTPUT_LIMIT','MEDIA_SPAWN_FAILED','MEDIA_INVALID_CONFIGURATION','MEDIA_CANCELLED','MEDIA_PROCESS_FAILED'].includes(error.code))return ['incomplete','PREFLIGHT_INCOMPLETE'];
 if(error.code==='MANAGED_SOURCE_INVALID')return ['blocked','PREFLIGHT_SOURCE_INVALID'];
 if(error.code==='MANAGED_SOURCE_CHANGED')return ['blocked','PREFLIGHT_SOURCE_CHANGED'];
 if(error.code==='TIMELINE_SOURCE_UNAVAILABLE')return ['blocked','TIMELINE_SOURCE_UNAVAILABLE'];
 if(error.code==='INVALID_TIMELINE_SNAPSHOT')return ['blocked','INVALID_TIMELINE_SNAPSHOT'];
 return ['blocked','PREFLIGHT_MEDIA_INVALID'];
}

/** Explicit read-only check. Nothing is persisted, initialized, derived or
 * scheduled. One attempt per service, no backlog. Actual exports always recheck
 * ownership, bytes, streams and renderer rules; a report cannot promise future
 * bytes or full decode success. Owned children are joined before drain/close.
 */
export function createTimelinePreflightServices(store,{signal:ownerSignal,probe=probeTimelineSource,limits=EXPORT_PREFLIGHT_LIMITS}={}){
 const active=new Set();let stopped=false,shutdownFailure;
 async function preflight(input,{signal:callSignal}={}){
  refuseRestoredOperation(store,'timeline.export.preflight',input);
  const beforeEffect=restoreEffectFence(store);
  const started=performance.now();
  const external=ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  checkpoint(external);if(shutdownFailure)throw shutdownFailure;if(stopped)throw new AppError('OPERATION_CANCELLED','Operation interrupted by shutdown',503);
  const report={projectId:input.projectId,timelineId:null,timelineRevision:null,expectedRevision:input.expectedRevision,snapshotHash:null,
   checkedAt:new Date().toISOString(),status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]};
  let initial;
  try{initial=readTimelinePreflightSnapshot(store,input.projectId,input.exportSettings,input);}
  catch(error){if(error.code==='NOT_FOUND')throw error;if(error.code==='INSPECTION_BUDGET_EXCEEDED'){report.status='incomplete';report.issues=[issue('PREFLIGHT_SNAPSHOT_BUDGET','warning')];return report;}report.issues=[issue(error.code==='TIMELINE_SOURCE_UNAVAILABLE'?'TIMELINE_SOURCE_UNAVAILABLE':'INVALID_TIMELINE_SNAPSHOT')];return report;}
  if(!initial.timeline){report.issues=[issue('TIMELINE_MISSING')];return report;}
  report.timelineId=initial.timeline.id;report.timelineRevision=initial.timeline.revision;report.snapshotHash=timelineSnapshotHash(initial.snapshot);
  report.summary=summary(initial.snapshot);report.checks.totalAssets=initial.snapshot.assets.length;
  const rangeIssue=timelineExportRangeBoundsIssue(input,initial.timeline.durationFrames);
  if(rangeIssue){report.snapshotHash=null;report.summary=null;}
  if(initial.timeline.revision!==input.expectedRevision){report.status='stale';report.issues=[issue('PREFLIGHT_STALE')];return report;}
  if(rangeIssue){report.issues=[issue('EXPORT_RANGE_BOUNDS')];return report;}
  if(!initial.timeline.clips.length){report.issues=[issue('EMPTY_TIMELINE')];return report;}
  // Early structural check shares the renderer validator. Actual stream flags
  // and durations below replace these saved values and are validated again.
  try{
   if(validateSubtitleSnapshotProfile(initial.snapshot))report.checks.subtitles={profileId:initial.snapshot.subtitleProfile.profileId,fontVerified:false,inkMeasured:false};
   const savedAssets=new Map(initial.snapshot.assets.map(a=>[a.id,a]));
   validateTimeline(initial.timeline,savedAssets,{structureOnly:true});
   validateSavedTimeline(JSON.parse(JSON.stringify(initial.timeline)),{track:(timeline,id)=>timeline.tracks.find(t=>t.id===id),asset:(_projectId,id)=>savedAssets.get(id)});
  }
  catch{report.issues=[issue('INVALID_TIMELINE_SNAPSHOT')];return report;}
  const remaining=limits.timeoutMs-(performance.now()-started);
  if(remaining<=0){report.status='incomplete';report.issues=[issue('PREFLIGHT_TIMEOUT','warning')];return report;}
  if(active.size){report.status='incomplete';report.issues=[issue('PREFLIGHT_BUSY','warning')];return report;}
  const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  const entry={controller,task:null};active.add(entry);let timedOut=false;
  const budget={sourceBytes:limits.sourceBytes,totalBytes:limits.totalBytes,bytesHashed:0};
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},remaining);
  const preparation=(async()=>{
   if(report.checks.subtitles){await verifySubtitleFontResource({signal,beforeEffect});checkpoint(signal);report.checks.subtitles.fontVerified=true;}
   return prepareTimelineInputs(initial.snapshot,{root:store.root,projectId:input.projectId,readAsset:id=>{beforeEffect?.();return readOwnedTimelineAsset(store.db,input.projectId,id);},
   signal,budget,beforeEffect,probe:async(file,options)=>{beforeEffect?.();const result=await probe(file,{...options,beforeEffect});beforeEffect?.();return result;},onChecked:()=>{report.checks.checkedAssets++;}});
  })();
  // A caller can observe its deadline, but the exact underlying preparation
  // remains owned until it settles. No new check is admitted, nor successful
  // drain/SQLite close reported, while a non-cooperative read is outstanding.
  entry.task=preparation.catch(error=>{if(error.terminationUnconfirmed)shutdownFailure=error;}).finally(async()=>{
   try{assertMediaTerminated(await terminateMediaProcesses({signal}));}catch(error){shutdownFailure=error;throw error;}
   finally{active.delete(entry);}
  });
  entry.task.catch(error=>{shutdownFailure??=error;});
  const work=(async()=>{
   try{
    const verified=await awaitProvider(()=>preparation,signal);
    checkpoint(signal);beforeEffect?.();report.status='ready';report.summary=summary(initial.snapshot,verified);
   }catch(error){
    if(error.terminationUnconfirmed){shutdownFailure=error;throw error;}
    if(safeWorkspaceRestoreError(error))throw error;
    checkpoint(external);if(stopped)checkpoint(controller.signal);
    const [status,code]=timedOut?['incomplete','PREFLIGHT_TIMEOUT']:classify(error);
    report.status=status;report.issues=[issue(code,status==='incomplete'?'warning':'error')];
    if(initial.snapshot.assets.some(a=>a.id===error.timelineAssetId))report.issues[0].assetId=error.timelineAssetId;
   }finally{
    clearTimeout(timer);controller.abort();
    try{assertMediaTerminated(await terminateMediaProcesses({signal}));}catch(error){shutdownFailure=error;throw error;}
   }
   checkpoint(external);if(stopped)checkpoint(controller.signal);
   report.checks.bytesHashed=budget.bytesHashed;
   // Recheck a fresh coherent snapshot only after all asynchronous reads. A
   // changed row, owner, frozen metadata or revision can never publish ready.
   let current;
   try{current=readTimelinePreflightSnapshot(store,input.projectId,input.exportSettings,input);}
   catch{current=null;}
   if(!current?.snapshot||timelineSnapshotHash(current.snapshot)!==report.snapshotHash){report.status='stale';report.issues=[issue('PREFLIGHT_STALE')];}
   return report;
  })();
  return work;
 }
 const stop=()=>{stopped=true;for(const entry of active)entry.controller.abort();};
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(){stop();await boundedShutdown(Promise.allSettled([...active].map(entry=>entry.task)),'PREFLIGHT_STOP_TIMEOUT');ownerSignal?.removeEventListener('abort',stop);if(shutdownFailure)throw shutdownFailure;}
 return {handlers:{'timeline.export.preflight':preflight},drain};
}

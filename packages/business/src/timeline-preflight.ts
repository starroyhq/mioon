import {timelineExportRangeFields,isTimelineExportRangeWithinDuration} from '@mioon/contracts/timeline-export-range';
import {timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import {timelineDeliveryNameFields} from '@mioon/contracts/timeline-delivery';
import {restoreEffectFence} from './workspace-restore-invocation.ts';
import {refuseRestoredOperation,safeWorkspaceRestoreError} from './workspace-restore-policy.ts';
import {AppError,EXPORT_PREFLIGHT_LIMITS,timelineOutputPreset} from '@mioon/contracts';
import {createHash} from 'node:crypto';
import {readTimelinePreflightSnapshot,readOwnedTimelineAsset,prepareTimelineInputs,probeTimelineSource} from './timeline-sources.ts';
import {validateTimeline,validateSavedTimeline} from './timeline-inputs.ts';
import {terminateMediaProcesses} from './media-processes.ts';
import {checkpoint,assertMediaTerminated,awaitProvider,boundedShutdown} from './operation-lifecycle.ts';
import {verifySubtitleFontResource,validateSubtitleSnapshotProfile} from './subtitle-resources.ts';
import {inspectSubtitleRenderer} from './subtitle-renderer-capability.ts';
import {TIMELINE_COLOUR_PREFLIGHT_MESSAGES} from '../../contracts/src/timeline-colour.ts';
import {createTimelineColourLutReader} from './timeline-colour-lut.ts';
import {createOpacityCandidatePreflightRuntime,OPACITY_CANDIDATE_PREFLIGHT_MESSAGES} from './opacity-candidate-preflight.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {TimelinePreflightSnapshot,TimelinePreflightSnapshotAsset} from './timeline-sources.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

interface PreflightStore {db: DatabaseSync;root: string}
interface PreflightLimits {timeoutMs: number;sourceBytes: number;totalBytes: number}
interface PreflightProbeOptions {signal?: AbortSignal;timeout?: number;beforeSpawn?: ()=>void;beforeEffect?: ()=>void;verifiedJfif?: boolean}
interface PreflightProbeResult {probe: unknown;width: number;height: number;duration: number|null;hasVideo: boolean;hasAudio: boolean;videoStreamIndex: number|string|null;audioStreamIndex: number|string|null}
type PreflightInput = {[key: string]: unknown;projectId: string;expectedRevision: number;requestId?: string;exportSettings?: unknown;exportRange?: unknown;deliveryName?: string;preflightSnapshotHash?: string};
interface PreflightChecks {totalAssets: number;checkedAssets: number;bytesHashed: number;fullDecode: boolean;subtitles?: {profileId: string;fontVerified: boolean;inkMeasured: boolean}}
interface PreflightIssue {code: string;severity: string;message: string|undefined;assetId?: string}
export interface TimelinePreflightReport {projectId: string;timelineId: string|null;timelineRevision: number|null;expectedRevision: number;snapshotHash: string|null;checkedAt: string;status: string;summary: unknown;checks: PreflightChecks;issues: PreflightIssue[]}
interface PreflightServiceOptions {signal?: AbortSignal;probe?: (file: string,options: PreflightProbeOptions)=>Promise<PreflightProbeResult>;limits?: PreflightLimits;/** Trusted host fence; never accepted from RPC input. */beforeEffect?:()=>void}
interface PreflightCallOptions {signal?: AbortSignal}
interface PreflightAttempt {controller: AbortController;task: Promise<unknown>|null}

const messages: Readonly<Record<string,string>>=Object.freeze({
 ...TIMELINE_COLOUR_PREFLIGHT_MESSAGES,
 EXPORT_RANGE_BOUNDS:'The export range must fit inside the saved timeline and contain at least one 30fps frame; the end is exclusive.',
 SUBTITLE_RESOURCE_UNAVAILABLE:'The bundled subtitle font is missing or does not match this rendering profile.',
 SUBTITLE_RENDERER_UNAVAILABLE:'This FFmpeg build lacks the drawtext options required for subtitles. Select a build with libfreetype and libharfbuzz.',
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
const issue=(code: string,severity='error'): PreflightIssue=>({code,severity,message:messages[code]??(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES as Record<string,string>)[code]});
const canonical=(v: unknown): string|undefined=>JSON.stringify(v,(_key: string,x: unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const timelineSnapshotHash=(snapshot: unknown): string=>createHash('sha256').update(canonical(snapshot) as string).digest('hex');
function summary(snapshot: TimelinePreflightSnapshot,verified?: Map<string, {hasAudio?: boolean}>|null): Record<string, unknown>|null{
 const t=snapshot.timeline,assets=verified??new Map(snapshot.assets.map(a=>[a.id,a])),tracks=new Map(t.tracks.map(lane=>[lane.id,lane]));
 if(!isTimelineExportRangeWithinDuration(snapshot,t.durationFrames)||!timelineOutputPreset(t)||!Number.isInteger(t.durationFrames)||t.durationFrames<0||t.durationFrames>18000)return null;
 return {...timelineDeliveryNameFields(snapshot),...timelineExportRangeFields(snapshot),...(Object.hasOwn(snapshot,'delivery')?{delivery:snapshot.delivery}:{}),fps:t.fps,width:t.width,height:t.height,durationFrames:t.durationFrames,trackCount:t.tracks.length,clipCount:t.clips.length,assetCount:assets.size,
  visualClipCount:t.clips.filter(c=>tracks.get(c.trackId)?.kind==='video'&&!tracks.get(c.trackId)!.hidden).length,
  audibleClipCount:t.clips.filter(c=>tracks.has(c.trackId)&&!tracks.get(c.trackId)!.muted&&c.gain>0&&assets.get(c.assetId)?.hasAudio===true).length,
  mutedTrackCount:t.tracks.filter(lane=>lane.muted===true).length,hiddenVideoTrackCount:t.tracks.filter(lane=>lane.kind==='video'&&lane.hidden===true).length};
}
function classify(error: unknown,opacity=false): [string,string]{
 const failure=error as {code?: string};
 if(opacity&&Object.hasOwn(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES,failure.code as string))return ['blocked',failure.code as string];
 if(Object.hasOwn(TIMELINE_COLOUR_PREFLIGHT_MESSAGES,failure.code as string))return ['blocked',failure.code as string];
 if(failure.code==='SUBTITLE_RESOURCE_UNAVAILABLE')return ['blocked','SUBTITLE_RESOURCE_UNAVAILABLE'];
 if(failure.code==='SUBTITLE_RENDERER_UNAVAILABLE')return ['blocked','SUBTITLE_RENDERER_UNAVAILABLE'];
 if(failure.code==='SUBTITLE_RENDERER_UNVERIFIED')return ['incomplete','PREFLIGHT_INCOMPLETE'];
 if(failure.code==='INSPECTION_BUDGET_EXCEEDED')return ['incomplete','PREFLIGHT_SNAPSHOT_BUDGET'];
 if(failure.code==='MANAGED_SOURCE_LIMIT'||failure.code==='PREFLIGHT_BUDGET')return ['incomplete','PREFLIGHT_BUDGET'];
 if(['MEDIA_TIMEOUT','MEDIA_OUTPUT_LIMIT','MEDIA_SPAWN_FAILED','MEDIA_INVALID_CONFIGURATION','MEDIA_CANCELLED','MEDIA_PROCESS_FAILED'].includes(failure.code as string))return ['incomplete','PREFLIGHT_INCOMPLETE'];
 if(failure.code==='MANAGED_SOURCE_INVALID')return ['blocked','PREFLIGHT_SOURCE_INVALID'];
 if(failure.code==='MANAGED_SOURCE_CHANGED')return ['blocked','PREFLIGHT_SOURCE_CHANGED'];
 if(failure.code==='TIMELINE_SOURCE_UNAVAILABLE')return ['blocked','TIMELINE_SOURCE_UNAVAILABLE'];
 if(failure.code==='INVALID_TIMELINE_SNAPSHOT')return ['blocked','INVALID_TIMELINE_SNAPSHOT'];
 return ['blocked','PREFLIGHT_MEDIA_INVALID'];
}

/** Explicit read-only check. Nothing is persisted, initialized, derived or
 * scheduled. One attempt per service, no backlog. Actual exports always recheck
 * ownership, bytes, streams and renderer rules; a report cannot promise future
 * bytes or full decode success. Owned children are joined before drain/close.
 */
export function createTimelinePreflightServices(store: PreflightStore,{signal:ownerSignal,probe=probeTimelineSource,limits=EXPORT_PREFLIGHT_LIMITS,beforeEffect:hostBeforeEffect}: PreflightServiceOptions={}){
 const opacity=createOpacityCandidatePreflightRuntime(store);
 const readSnapshot=(input: PreflightInput): {timeline: TimelineRecord|null;snapshot: TimelinePreflightSnapshot|null}=>opacity?opacity.readSnapshot(input) as {timeline: TimelineRecord|null;snapshot: TimelinePreflightSnapshot|null}:readTimelinePreflightSnapshot(store,input.projectId,input.exportSettings,input);
 const active=new Set<PreflightAttempt>();let stopped=false,shutdownFailure: unknown;
 async function preflight(input: PreflightInput,{signal:callSignal}: PreflightCallOptions={}): Promise<TimelinePreflightReport>{
  if(opacity)input=opacity.parse(input) as unknown as PreflightInput;
  const workspaceBeforeEffect=opacity?opacity.begin(input):(refuseRestoredOperation(store,'timeline.export.preflight',input),restoreEffectFence(store));
  let hostEffectFailure:unknown;
  const beforeEffect=hostBeforeEffect?()=>{try{hostBeforeEffect();}catch(error){hostEffectFailure??=error;throw hostEffectFailure;}workspaceBeforeEffect?.();}:workspaceBeforeEffect;
  beforeEffect?.();
  const started=performance.now();
  const external=ownerSignal&&callSignal&&ownerSignal!==callSignal?AbortSignal.any([ownerSignal,callSignal]):ownerSignal||callSignal;
  checkpoint(external);if(shutdownFailure)throw shutdownFailure;if(stopped)throw new AppError('OPERATION_CANCELLED','Operation interrupted by shutdown',503);
  const report: TimelinePreflightReport={projectId:input.projectId,timelineId:null,timelineRevision:null,expectedRevision:input.expectedRevision,snapshotHash:null,
   checkedAt:new Date().toISOString(),status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]};
  let initial;
  try{initial=readSnapshot(input);}
  catch(error){const failure=error as {code?: string};if(failure.code==='NOT_FOUND'||opacity&&(safeWorkspaceRestoreError(error)||failure.code==='RESTORE_STORE_UNVERIFIED'))throw error;if(failure.code==='INSPECTION_BUDGET_EXCEEDED'){report.status='incomplete';report.issues=[issue('PREFLIGHT_SNAPSHOT_BUDGET','warning')];return report;}report.issues=[issue(Object.hasOwn(TIMELINE_COLOUR_PREFLIGHT_MESSAGES,failure.code as string)||opacity&&Object.hasOwn(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES,failure.code as string)?failure.code as string:failure.code==='TIMELINE_SOURCE_UNAVAILABLE'?'TIMELINE_SOURCE_UNAVAILABLE':'INVALID_TIMELINE_SNAPSHOT')];return report;}
  if(!initial.timeline){report.issues=[issue('TIMELINE_MISSING')];return report;}
  report.timelineId=initial.timeline.id;report.timelineRevision=initial.timeline.revision;
  if(!opacity){report.snapshotHash=timelineSnapshotHash(initial.snapshot);report.summary=summary(initial.snapshot!);report.checks.totalAssets=initial.snapshot!.assets.length;}
  const rangeIssue=timelineExportRangeBoundsIssue(input,initial.timeline.durationFrames);
  if(rangeIssue){report.snapshotHash=null;report.summary=null;}
  if(initial.timeline.revision!==input.expectedRevision){report.status='stale';report.issues=[issue('PREFLIGHT_STALE')];return report;}
  if(rangeIssue){report.issues=[issue('EXPORT_RANGE_BOUNDS')];return report;}
  if(!initial.timeline.clips.length){report.issues=[issue('EMPTY_TIMELINE')];return report;}
  if(opacity){report.snapshotHash=timelineSnapshotHash(initial.snapshot);report.summary=summary(initial.snapshot!);report.checks.totalAssets=initial.snapshot!.assets.length;}
  const validation: TimelinePreflightSnapshot=opacity?(opacity.validationSnapshot(initial) as unknown as TimelinePreflightSnapshot):initial.snapshot!;
  const validationTimeline: TimelineRecord=opacity?validation.timeline:initial.timeline;
  // Early structural check shares the renderer validator. Actual stream flags
  // and durations below replace these saved values and are validated again.
  try{
   if(validateSubtitleSnapshotProfile(validation))report.checks.subtitles={profileId:(validation as TimelinePreflightSnapshot).subtitleProfile!.profileId,fontVerified:false,inkMeasured:false};
   const savedAssets=new Map<string, TimelinePreflightSnapshotAsset>(validation.assets.map((a: TimelinePreflightSnapshotAsset)=>[a.id,a]));
   const trackFn=(timeline: TimelineRecord,id: string)=>timeline.tracks.find(t=>t.id===id)!;
   if(opacity)validateSavedTimeline(JSON.parse(JSON.stringify(validationTimeline)),{track:trackFn,asset:(_projectId: string,id: string)=>savedAssets.get(id)! as never});
   validateTimeline(validationTimeline,savedAssets as unknown as ReadonlyMap<string, import('./timeline-inputs.ts').ManagedAssetRecord>,{structureOnly:true});
   if(!opacity)validateSavedTimeline(JSON.parse(JSON.stringify(validationTimeline)),{track:trackFn,asset:(_projectId: string,id: string)=>savedAssets.get(id)! as never});
  }
  catch(error){const failure=error as {code?: string};report.issues=[issue(opacity&&Object.hasOwn(OPACITY_CANDIDATE_PREFLIGHT_MESSAGES,failure.code as string)?failure.code as string:'INVALID_TIMELINE_SNAPSHOT')];return report;}
  const remaining=limits.timeoutMs-(performance.now()-started);
  if(remaining<=0){report.status='incomplete';report.issues=[issue('PREFLIGHT_TIMEOUT','warning')];return report;}
  if(active.size){report.status='incomplete';report.issues=[issue('PREFLIGHT_BUSY','warning')];return report;}
  const controller=new AbortController(),signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  const entry: PreflightAttempt={controller,task:null};active.add(entry);let timedOut=false;
  const budget={sourceBytes:limits.sourceBytes,totalBytes:limits.totalBytes,bytesHashed:0};
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},remaining);
  const preparation=(async()=>{
   if(report.checks.subtitles){await verifySubtitleFontResource({signal,beforeEffect});checkpoint(signal);report.checks.subtitles.fontVerified=true;await inspectSubtitleRenderer({signal,beforeEffect});checkpoint(signal);}
   const options={signal,budget,beforeEffect,probe:async(file: string,probeOptions: PreflightProbeOptions)=>{beforeEffect?.();const result=await probe(file,{...probeOptions,beforeEffect});beforeEffect?.();return result;},onChecked:()=>{report.checks.checkedAssets++;}};
   return opacity?opacity.prepare(initial as never,input as never,options as never):prepareTimelineInputs(initial.snapshot as never,{root:store.root,projectId:input.projectId,readAsset:(id: string)=>{beforeEffect?.();return readOwnedTimelineAsset(store.db,input.projectId,id) as unknown as import('./timeline-inputs.ts').ManagedAssetRecord|null;},
    ...options,readLut:createTimelineColourLutReader(store.db,input.projectId) as never});
  })();
  // A caller can observe its deadline, but the exact underlying preparation
  // remains owned until it settles. No new check is admitted, nor successful
  // drain/SQLite close reported, while a non-cooperative read is outstanding.
  entry.task=preparation.catch((error: {terminationUnconfirmed?: boolean})=>{if(error.terminationUnconfirmed)shutdownFailure=error;}).finally(async()=>{
   try{assertMediaTerminated(await terminateMediaProcesses({signal}));}catch(error){shutdownFailure=error;throw error;}
   finally{active.delete(entry);}
  });
  entry.task.catch((error: unknown)=>{shutdownFailure??=error;});
  const work=(async()=>{
   try{
    const verified=await awaitProvider(()=>preparation,signal);
    checkpoint(signal);beforeEffect?.();opacity?.assertPrepared(initial,input,verified,beforeEffect);report.status='ready';report.summary=summary(initial.snapshot!,verified as Map<string,{hasAudio?: boolean}>);
   }catch(rawError){
    const error=rawError as {terminationUnconfirmed?: boolean;code?: string;timelineAssetId?: string};
    if(error.terminationUnconfirmed){shutdownFailure=rawError;throw rawError;}
    if(hostEffectFailure)throw hostEffectFailure;
    if(safeWorkspaceRestoreError(rawError)||opacity&&error.code==='RESTORE_STORE_UNVERIFIED')throw rawError;
    checkpoint(external);if(stopped)checkpoint(controller.signal);
    const [status,code]=timedOut?['incomplete','PREFLIGHT_TIMEOUT']:classify(rawError,Boolean(opacity));
    report.status=status;report.issues=[issue(code,status==='incomplete'?'warning':'error')];
    if(initial.snapshot!.assets.some(a=>a.id===error.timelineAssetId))report.issues[0].assetId=error.timelineAssetId;
   }finally{
    clearTimeout(timer);controller.abort();
    try{assertMediaTerminated(await terminateMediaProcesses({signal}));}catch(error){shutdownFailure=error;throw error;}
   }
   checkpoint(external);if(stopped)checkpoint(controller.signal);
   report.checks.bytesHashed=budget.bytesHashed;
   // Recheck a fresh coherent snapshot only after all asynchronous reads. A
   // changed row, owner, frozen metadata or revision can never publish ready.
   let current;
   try{beforeEffect?.();current=readSnapshot(input);}
   catch(error){if(hostEffectFailure)throw hostEffectFailure;const failure=error as {code?: string};if(opacity&&(safeWorkspaceRestoreError(error)||failure.code==='RESTORE_STORE_UNVERIFIED'))throw error;current=null;}
   if(!current?.snapshot||timelineSnapshotHash(current.snapshot)!==report.snapshotHash){report.status='stale';report.issues=[issue('PREFLIGHT_STALE')];}
   return report;
  })();
  return work;
 }
 const stop=(): void=>{stopped=true;for(const entry of active)entry.controller.abort();};
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(): Promise<void>{stop();await boundedShutdown(Promise.allSettled([...active].map(entry=>entry.task)),'PREFLIGHT_STOP_TIMEOUT');ownerSignal?.removeEventListener('abort',stop);if(shutdownFailure)throw shutdownFailure;}
 return {handlers:{'timeline.export.preflight':preflight},drain};
}

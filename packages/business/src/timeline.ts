import {getOpacityCandidateAssembly,isOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import {bindAgentTaskJobInside} from './agent/task-effects-v2.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';
import {opacityEnvelopeFieldsAfterEdit} from '../../contracts/src/timeline-opacity-envelope.ts';
import {assertTimelineVolumeEnvelopeWorkspace as legacyAssertVolumeWorkspace,admitTimelineVolumeEnvelopeWrite,volumeEnvelopeMutationError} from './timeline-volume-envelope-admission.ts';
import {volumeEnvelopeFieldsAfterEdit,splitVolumeEnvelopeFields} from '../../contracts/src/timeline-volume-envelope.ts';
import {ownsStoreLock} from './db.ts';
import {assertTimelineAudioRoleWorkspace as legacyAssertAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {createTimelineLoudnessTransactions} from './timeline-loudness-transactions.ts';
import {hasSelectedTimelineExportRange,timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import {bindRestoredExport} from './workspace-restore-exports.ts';
import {refuseRestoredOperation as legacyRefuseRestoredOperation} from './workspace-restore-policy.ts';
import {createAgentTimelineMoveBoundary, createAgentTimelineGainBoundary} from './agent/timeline-edit-domain.ts';
import {createSubtitleMutations} from './timeline-subtitles.ts';
import {randomUUID} from 'node:crypto';
import {AppError,sourceFrameCount,isTimelineMutationResponse as legacyMutationResponse,timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET,TIMELINE_SUBTITLE_PROFILE_ID} from '@mioon/contracts';
import {getTimelineFormat,readTimelineFormatOwner,readTimelineFormatState,assertTimelineFormatEligible} from './timeline-format.ts';
import {canonicalFormatValue} from './timeline-format-receipts.ts';
import {freezeTimelineSnapshot} from './timeline-inputs.ts';
import {removeTimelineClipWithRipple} from './timeline-ripple-remove.ts';
import {initializeProjectTimelineFormat} from './project-timeline-format.ts';
export {TIMELINE_LIMITS} from './timeline-inputs.ts';
import {readTimelinePreflightSnapshot} from './timeline-sources.ts';
import {createTimelineReplacementBoundary} from './timeline-replacement.ts';
import {appendTimelineShots,refreshTimelineSources} from './timeline-shot-sync.ts';
import {crossfadeTimelineClips} from './timeline-crossfade.ts';
import {splitTimelineAtScenes} from './timeline-scene-split.ts';
import type {TimelineSceneSplitPlan} from './timeline-scene-split.ts';
import {readSceneSplitCuts} from './scene-history.ts';
import type {TimelineShotAppendPlan,TimelineSourceRefreshPlan} from './timeline-shot-sync.ts';
import {createTimelineRecoveryBoundary as legacyRecoveryBoundary,readTimelineReceipt,rejectTimelineMutation,invalidTimeline,admitTimelineImageResponse as legacyAdmitImageResponse,TIMELINE_RESPONSE_BYTES} from './timeline-recovery.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {TimelineClipRecord,TimelineRecord,TimelineSubtitlesRecord,TimelineTrackRecord,TimelineSubtitleCueRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary,TimelineRecoveryInput,TimelineRejectionState} from './timeline-recovery.ts';
import type {ReplacementInput} from './timeline-replacement.ts';

interface TimelineRectInput {x: number;y: number;width: number;height: number}
interface TimelineClipPatch {
 rect?: TimelineRectInput;startFrame?: number;durationFrames?: number;sourceInFrame?: number;gain?: number;
 fadeInFrames?: number;fadeOutFrames?: number;colour?: Record<string,unknown>|null;audioRole?: string;
 volumeEnvelope?: unknown;opacityEnvelope?: unknown;name?: string;trackId?: string;hidden?: boolean;muted?: boolean;
}
type TimelineMutationInput = {
 [key: string]: unknown;
 projectId: string;requestId: string;expectedRevision: number;patch: TimelineClipPatch;
 expectedProjectRevision?: number;presetId?: string;clipId?: string;trackId?: string;assetId?: string;atFrame?: number;kind?: string;
 name?: string;startFrame?: number;durationFrames?: number;sourceInFrame?: number;gain?: number;
 fadeInFrames?: number;fadeOutFrames?: number;colour?: Record<string,unknown>|null;audioRole?: string;volumeEnvelope?: unknown;
 rect?: TimelineRectInput;exportSettings?: unknown;purpose?: string;deliveryName?: string;exportRange?: unknown;
 preflightSnapshotHash?: string;versionId?: string;
};
interface TimelinePreset {id: string;fps: number;width: number;height: number}
interface TimelineStore {db: DatabaseSync;put: (table: string,value: unknown)=>unknown;tx: <T>(callback: ()=>T)=>T}
interface TimelineTransactionContext {boundary: TimelineRecoveryBoundary;requestHash: string;write: ()=>void}
interface TimelineServiceDeps {
 required: (table: string,id: string)=>void;
 check: (timeline: {revision?: number},expectedRevision: number)=>void;
 hash: (value: unknown)=>string;
 now: ()=>string;
 exportAdmission: {render: (input: TimelineMutationInput,options: unknown,callbacks: unknown)=>unknown};
}
interface RenderAdmission {timelineId?: string;snapshotHash: string;failure?: Error|null}
interface TimelineHistoryResult {
 projectId: string;timelineId: string|null;revision: number|null;cursor: number;length: number;
 canUndo: boolean;canRedo: boolean;undoEntry: unknown;redoEntry: unknown;
}
type DomainError = Error & {code: string;status: number;details?: Record<string,unknown>};
interface TimelineWriteOptions {sourceSemantics?: boolean}
export interface AgentTimelineCompensation {kind:string;id:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}

const defaultRect=(timeline: {width: number;height: number}): TimelineRectInput=>({x:0,y:0,width:timeline.width,height:timeline.height});
// The shared wire schema admits every preset's envelope. Submitted rectangles
// still receive the legacy input-validation error against this saved pair;
// persisted corruption continues through the separate aggregate boundary.
function validateSubmittedRect(timeline: {width: number;height: number},rect: TimelineRectInput,path: string[]): void{
 if(rect.x+rect.width>timeline.width||rect.y+rect.height>timeline.height)
  throw new AppError('VALIDATION_ERROR','输入字段无效',400,{issues:[{path,message:`Rectangle must stay inside the ${timeline.width}×${timeline.height} output`}]});
}
const clone=(value: unknown)=>JSON.parse(JSON.stringify(value));

// The timeline is its own aggregate: revision checks and idempotent responses
// must be committed in the same SQLite transaction as every mutation.
export function createTimelineServices(store: TimelineStore,{required,check,hash,now,exportAdmission}: TimelineServiceDeps){
 const opacity=getOpacityCandidateAssembly(store),domain=opacity?createOpacityCandidateDomain(store):null;
 const assertTimelineAudioRoleWorkspace=opacity?()=>opacity.checkpoint():legacyAssertAudioRoleWorkspace;
 const assertTimelineVolumeEnvelopeWorkspace=opacity?()=>opacity.checkpoint():legacyAssertVolumeWorkspace;
 const refuseRestoredOperation=(target: unknown,operation: string,input?: Record<string, unknown>): void=>{
  if(opacity){opacity.refuseOperation(operation,input);return;}
  legacyRefuseRestoredOperation(target as never,operation,input);
 };
 const createTimelineRecoveryBoundary: (db: DatabaseSync,input: TimelineMutationInput)=>TimelineRecoveryBoundary=domain?((_db: DatabaseSync,input: TimelineMutationInput)=>domain.boundary(input) as unknown as TimelineRecoveryBoundary):(legacyRecoveryBoundary as never);
 const isTimelineMutationResponse: (operation: string,input: unknown,response: unknown)=>boolean=domain?domain.isMutationResponse:legacyMutationResponse;
 const admitTimelineImageResponse=(value: unknown): void=>{legacyAdmitImageResponse(value as TimelineRecord);if(domain)domain.admit(value);};
 const {db,put,tx}=store;
 function find(projectId: string): TimelineRecord|null{
  const row=db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
  if(!row)return null;
  const value=JSON.parse(row.data as string) as TimelineRecord;assertTimelineAudioRoleWorkspace(db,value);return value;
 }
 function ensure(projectId: string): TimelineRecord{
  required('projects',projectId);
  const existing=find(projectId);
  if(existing)return existing;
  refuseRestoredOperation(store,'timeline.get',{projectId});
  return put('timelines',newTimeline(projectId)) as TimelineRecord;
 }
 function newTimeline(projectId: string,preset: TimelinePreset=timelineOutputPreset(DEFAULT_TIMELINE_OUTPUT_PRESET) as TimelinePreset): TimelineRecord{
  const createdAt=now();
  return {
   id:randomUUID(),projectId,revision:1,fps:preset.fps,width:preset.width,height:preset.height,
   tracks:[['video','Video 1'],['video','Video 2'],['audio','Audio 1']].map(([kind,name],orderIndex)=>({id:randomUUID(),name,kind,orderIndex,hidden:false,muted:false})),
   clips:[],durationFrames:0,createdAt,updatedAt:createdAt
  };
 }
 function track(timeline: TimelineRecord,id: string): TimelineTrackRecord{
  const result=timeline.tracks.find(item=>item.id===id);
  if(!result)throw new AppError('TRACK_NOT_FOUND','轨道不属于此时间线',404,{trackId:id});
  return result;
 }
 function clip(timeline: TimelineRecord,id: string): TimelineClipRecord{
  const result=timeline.clips.find(item=>item.id===id);
  if(!result)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId:id});
  return result;
 }
 function transaction<T>(operation: string,input: TimelineRecoveryInput,apply: (context: TimelineTransactionContext)=>T,boundary: TimelineRecoveryBoundary=createTimelineRecoveryBoundary(db,input as TimelineMutationInput)): T{
  assertTimelineAudioRoleWorkspace(db,input);
  assertTimelineVolumeEnvelopeWorkspace(db,input);
  refuseRestoredOperation(store,operation,input);
  const state: TimelineRejectionState={operation,receiptAbsent:false,writesStarted:false,transactionEntered:false,callbackFailed:false,ownedScope:()=>opacity?opacity.ownsLock():ownsStoreLock(store)};
  const write=()=>{state.writesStarted=true;};
  try{return tx(()=>{
   state.transactionEntered=true;
   try{
    const requestHash=hash({operation,input}),previous=readTimelineReceipt(db,input,operation);
    if(previous&&previous.requestHash!==requestHash)
     throw new AppError('IDEMPOTENCY_CONFLICT','同一时间线请求 ID 已用于不同内容',409,{requestId:input.requestId});
    if(previous)return boundary.replay(operation,previous.response as string) as T;
    state.receiptAbsent=true;
    refuseRestoredOperation(store,operation,input);
    return apply({boundary,requestHash,write});
   }catch(error){state.callbackFailed=true;throw error;}
  });}catch(error){rejectTimelineMutation(db,input,error,state);throw error;}
 }
 function editable(timeline: TimelineRecord,input: {expectedRevision: number}): void{
  check(timeline,input.expectedRevision);
  if(timeline.revision===Number.MAX_SAFE_INTEGER)throw new AppError('TIMELINE_REVISION_LIMIT','时间线版本已达到安全上限',409);
 }
 function currentOrEnsure(input: {projectId: string},boundary: TimelineRecoveryBoundary,write: ()=>void,{sourceSemantics=true}: TimelineWriteOptions={}): TimelineRecord{
  const current=boundary.read({legacyMissingProject:true,sourceSemantics});
  if(current)return current;
  // ensure() is itself a write on legacy projects. A later error in this
  // attempt is deliberately ineligible for pre-write rejection proof.
  write();ensure(input.projectId as string);
  const created=boundary.read();if(!created)invalidTimeline();return created;
 }
 function saveResponse(operation: string,input: TimelineRecoveryInput,requestHash: string,response: unknown,boundary: TimelineRecoveryBoundary): unknown{
  // Do not reconstruct a response from the current aggregate on retries. An
  // old successful request must return precisely its original response.
  if(!isTimelineMutationResponse(operation,input,response))invalidTimeline();
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId as string,requestHash,JSON.stringify(response));
  if(operation==='timeline.format.set')db.prepare('INSERT INTO timeline_format_requests(requestId,projectId,input) VALUES(?,?,?)').run(input.requestId as string,input.projectId,canonicalFormatValue(input) as string);
  boundary.verify(operation,response,requestHash);
  return response;
 }
 // History owns only editable timeline state. Revisions, IDs/timestamps of the
 // aggregate, media, selected versions, jobs and exports are never restored.
 const snapshot=(timeline: TimelineRecord)=>clone({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames,...(Object.hasOwn(timeline,'subtitles')?{subtitles:timeline.subtitles}:{})});
 const cursor=(projectId: string): number=>(db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(projectId)?.position as number|undefined)??0;
 const setCursor=(projectId: string,position: number): void=>{db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET position=excluded.position').run(projectId,position);};
 function history(projectId: string): TimelineHistoryResult{
  required('projects',projectId);
  // One SQLite statement gives even independent connections a single read
  // snapshot. Metadata reads never initialize a timeline or acquire a write lock.
  const row=db.prepare(`SELECT t.data AS timeline,COALESCE(c.position,0) AS position,
   (SELECT COUNT(*) FROM timeline_history h WHERE h.projectId=p.id) AS length,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=c.position) AS undoEntry,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=COALESCE(c.position,0)+1) AS redoEntry
   FROM projects p LEFT JOIN timelines t ON t.projectId=p.id LEFT JOIN timeline_history_cursors c ON c.projectId=p.id WHERE p.id=?`).get(projectId)!;
  const timeline=row.timeline?JSON.parse(row.timeline as string):null,position=row.position as number,length=row.length as number;
  return {projectId,timelineId:timeline?.id??null,revision:timeline?.revision??null,cursor:position,length,canUndo:position>0,canRedo:position<length,
   undoEntry:row.undoEntry?JSON.parse(row.undoEntry as string):null,redoEntry:row.redoEntry?JSON.parse(row.redoEntry as string):null};
 }
 function recordEdit(operation: string,timeline: TimelineRecord,before: unknown): void{
  const position=cursor(timeline.projectId)+1;
  // Branch replacement shares the edit transaction, so rejected edits cannot
  // erase redo. Exact old request responses remain independently durable.
  db.prepare('DELETE FROM timeline_history WHERE projectId=? AND position>=?').run(timeline.projectId,position);
  db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?)')
   .run(randomUUID(),timeline.projectId,position,operation,timeline.updatedAt,JSON.stringify(before),JSON.stringify(snapshot(timeline)));
  setCursor(timeline.projectId,position);
 }
 function travel(operation: string,input: TimelineMutationInput,direction: number): unknown{
  return transaction(operation,input,({boundary,requestHash,write})=>{
   let timeline=boundary.read({legacyMissingProject:true});
   const empty=()=>new AppError(direction<0?'NOTHING_TO_UNDO':'NOTHING_TO_REDO',direction<0?'没有可撤销的时间线编辑':'没有可重做的时间线编辑',409);
   if(!timeline)throw empty();
   editable(timeline,input);
   const position=cursor(input.projectId),column=direction<0?'beforeSnapshot':'afterSnapshot';
   const entry=db.prepare(`SELECT CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TIMELINE_RESPONSE_BYTES} THEN ${column} END AS snapshot FROM timeline_history WHERE projectId=? AND position=?`).get(input.projectId,position+(direction>0?1:0));
   if(!entry)throw empty();
   const before=snapshot(timeline);
   timeline=boundary.restored(timeline!,entry.snapshot as string);
   timeline.revision++;
   timeline.updatedAt=now();
   admitTimelineImageResponse(timeline);
   admitTimelineVolumeEnvelopeWrite(timeline,{before,after:snapshot(timeline),related:input});
   write();put('timelines',timeline);
   setCursor(input.projectId,position+direction);
   return saveResponse(operation,input,requestHash,timeline,boundary);
  });
 }
 // respond wraps the saved timeline for operations whose acknowledgement also
 // carries per-item outcomes; by default the response is the timeline itself.
 function mutate(operation: string,input: TimelineMutationInput,apply: (timeline: TimelineRecord,boundary: TimelineRecoveryBoundary)=>void,specialBoundary?: TimelineRecoveryBoundary,respond?: (timeline: TimelineRecord)=>unknown): unknown{
  return transaction(operation,input,({boundary,requestHash,write})=>{
   const submittedRect=operation==='timeline.clip.add'?input.rect:operation==='timeline.clip.update'?input.patch.rect:undefined;
   // Check explicit input before legacy ensure() can write an absent timeline.
   const current=submittedRect===undefined?undefined:boundary.read({legacyMissingProject:true});
   if(submittedRect!==undefined)validateSubmittedRect((current??timelineOutputPreset(DEFAULT_TIMELINE_OUTPUT_PRESET))!,submittedRect,operation==='timeline.clip.add'?['rect']:['patch','rect']);
   const timeline=specialBoundary?boundary.read()!:(current??currentOrEnsure(input,boundary,write));
   editable(timeline,input);
   const before=snapshot(timeline);
   apply(timeline,boundary);
   boundary.validate(timeline);
   timeline.revision++;
   timeline.updatedAt=now();
   admitTimelineImageResponse(timeline);
   admitTimelineVolumeEnvelopeWrite(timeline,{before,after:snapshot(timeline),related:input});
   write();put('timelines',timeline);
   recordEdit(operation,timeline,before);
   return saveResponse(operation,input,requestHash,respond?respond(timeline):timeline,boundary);
  },specialBoundary);
 }
 // One split edit, shared by the single split and the scene split: the left
 // clip is shortened in place and the right clip is inserted after it.
 function splitClip(timeline: TimelineRecord,left: TimelineClipRecord,atFrame: number,boundary: TimelineRecoveryBoundary): TimelineClipRecord{
  const end=left.startFrame+left.durationFrames;
  if(atFrame<=left.startFrame||atFrame>=end)
   throw new AppError('SPLIT_BOUNDS','分割点必须位于所选片段内部，不能位于起止帧',400,{clipId:left.id,startFrame:left.startFrame,endFrame:end,atFrame});
  const source=boundary.asset(left.assetId),leftDuration=atFrame-left.startFrame;
  const fadeInFrames=left.fadeInFrames??0,fadeOutFrames=left.fadeOutFrames??0;
  if(leftDuration<fadeInFrames||leftDuration>left.durationFrames-fadeOutFrames)
   throw new AppError('SPLIT_FADE_BOUNDS','分割点不能位于音频淡入或淡出内部；可在淡入结束或淡出开始帧分割',400,{clipId:left.id,atFrame,minFrame:left.startFrame+fadeInFrames,maxFrame:end-fadeOutFrames});
  // A still has no advancing source clock. Moving media keeps contiguous
  // source ranges; copying the complete clip also preserves frozen references.
  let envelopes;try{envelopes=splitVolumeEnvelopeFields(left as never,leftDuration as never);}
  catch{throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_INVALID');}
  const right={...clone(left),...(envelopes as [unknown,unknown])[1] as object,id:randomUUID(),startFrame:atFrame,durationFrames:end-atFrame,
   sourceInFrame:(source.mimeType.startsWith('image/')?0:left.sourceInFrame+leftDuration) as number} as TimelineClipRecord;
  // Preserve the original envelope at its two outer edges. Do not introduce
  // keys into legacy clips or make an omitted zero explicit at an inner edge.
  if(Object.hasOwn(left,'fadeInFrames'))right.fadeInFrames=0;
  if(Object.hasOwn(left,'fadeOutFrames'))left.fadeOutFrames=0;
  Object.assign(left,(envelopes as [unknown,unknown])[0] as object);
  left.durationFrames=leftDuration;
  timeline.clips.splice(timeline.clips.indexOf(left)+1,0,right);
  return right;
 }
 function updateClip(input: TimelineMutationInput,boundary?: TimelineRecoveryBoundary): unknown{
  return mutate('timeline.clip.update',input,timeline=>{
   const target=clip(timeline,input.clipId as string);let envelope;
   try{envelope=volumeEnvelopeFieldsAfterEdit(target as never,input.patch as never);}
   catch{throw volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_INVALID');}
   Object.assign(target,input.patch,envelope,...(opacity?[opacityEnvelopeFieldsAfterEdit(target,input.patch)]:[]));
  },boundary);
 }
 function renderSnapshot(input: TimelineMutationInput,boundary: TimelineRecoveryBoundary,write: ()=>void,expectedTimelineId?: string): unknown{
  // Explicit settings/ranges cannot initialize a timeline. The omitted path retains
  // exactly its historical lazy-initialization and frozen projection behavior.
  const timeline=input.exportSettings===undefined&&!hasSelectedTimelineExportRange(input)?currentOrEnsure(input,boundary,write,{sourceSemantics:false}):boundary.read({legacyMissingProject:true,sourceSemantics:false});
  if(expectedTimelineId!==undefined&&timeline?.id!==expectedTimelineId)throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);
  if(!timeline)throw new AppError('EMPTY_TIMELINE','请先向时间线添加片段');
  check(timeline,input.expectedRevision);
  boundary.validate(clone(timeline));
  if(!timeline.clips.length)throw new AppError('EMPTY_TIMELINE','请先向时间线添加片段');
  const rangeIssue=timelineExportRangeBoundsIssue(input,timeline.durationFrames);
  if(rangeIssue)throw new AppError(rangeIssue.code as string,rangeIssue.message as string,rangeIssue.status as number);
  const frozen=domain?domain.freezeRenderSnapshot(timeline,boundary.sources(timeline),input.exportSettings,input):freezeTimelineSnapshot(timeline,boundary.sources(timeline),input.exportSettings,input);
  if(input.preflightSnapshotHash!==undefined){
   let current;
   try{current=(domain?domain.readPreflightSnapshot(Object.fromEntries(['projectId','expectedRevision','purpose','exportSettings','deliveryName','exportRange'].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]))):readTimelinePreflightSnapshot(store,input.projectId,input.exportSettings,input)).snapshot;}
   catch{throw new AppError('PREFLIGHT_STALE','导出检查已过期，请重新检查已保存的时间线',409);}
   if(!current||hash(current)!==input.preflightSnapshotHash||hash(frozen)!==input.preflightSnapshotHash)
    throw new AppError('PREFLIGHT_STALE','导出检查已过期，请重新检查已保存的时间线',409);
  }
  return frozen;
 }
 function render(input: TimelineMutationInput,admission?: RenderAdmission): unknown{
  return transaction('timeline.render',input,({boundary,requestHash,write})=>{
   const frozen=renderSnapshot(input,boundary,write,admission?.timelineId);
   if(admission&&hash(frozen)!==admission.snapshotHash)
    throw new AppError('EXPORT_CAPABILITY_STALE','时间线或素材元数据已变化，请重新检查当前导出配置',409);
   if(admission?.failure)throw admission.failure;
   const createdAt=now();
   const result={id:randomUUID(),projectId:input.projectId,requestId:input.requestId,mode:'timeline',purpose:input.purpose,timelineRevision:(frozen as {timeline:{revision:number}}).timeline.revision,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt,updatedAt:createdAt};
   write();put('exports',result);
   bindAgentTaskJobInside(db,'export',result.id);
   const response=saveResponse('timeline.render',input,requestHash,result,boundary);
   if(opacity)opacity.bindExport('timeline.render',input,result,requestHash);
   else bindRestoredExport(store,'timeline.render',input,result,requestHash);
   return response;
  });
 }
 const handlers: Record<string, (input: TimelineMutationInput,options?: unknown)=>unknown>={
  // Handlers share one aggregate transaction and receipt boundary.
  ...(createSubtitleMutations(mutate) as unknown as Record<string, (input: TimelineMutationInput,options?: unknown)=>unknown>),
  'timeline.format.get':(input: TimelineMutationInput)=>getTimelineFormat(db,input,{store}),
  'timeline.format.set':(input: TimelineMutationInput)=>transaction('timeline.format.set',input,({boundary,requestHash,write})=>{
   const context=readTimelineFormatOwner(db,input);
   check(context.project,input.expectedProjectRevision as number);
   const revision=context.timeline?.revision??0;
   if(revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','时间线已有新版本，请重新读取后再修改',409,{expectedRevision:input.expectedRevision,currentRevision:revision});
   if(revision===Number.MAX_SAFE_INTEGER)throw new AppError('TIMELINE_REVISION_LIMIT','时间线版本已达到安全上限',409);
   assertTimelineFormatEligible(readTimelineFormatState(db,input,{admission:true,context,store}));
   const preset=timelineOutputPreset(input.presetId as string)!;
   if(context.timeline&&timelineOutputPreset(context.timeline)?.id===preset.id)throw new AppError('TIMELINE_FORMAT_UNCHANGED','时间线已使用此输出规格',409);
   const timeline=context.timeline??newTimeline(input.projectId,preset);
   if(context.timeline){timeline.fps=preset.fps;timeline.width=preset.width;timeline.height=preset.height;timeline.revision++;timeline.updatedAt=now();}
   boundary.validate(timeline);
   write();put('timelines',timeline);
   return saveResponse('timeline.format.set',input,requestHash,timeline,boundary);
  }),
  'timeline.get':(input: TimelineMutationInput)=>domain?domain.boundary(input).read({legacyMissingProject:true}):ensure(input.projectId),
  'timeline.history.get':(input: TimelineMutationInput)=>{if(domain)domain.boundary(input).read({legacyMissingProject:true});return history(input.projectId);},
  'timeline.undo':(input: TimelineMutationInput)=>travel('timeline.undo',input,-1),
  'timeline.redo':(input: TimelineMutationInput)=>travel('timeline.redo',input,1),
  'timeline.track.add':(input: TimelineMutationInput)=>mutate('timeline.track.add',input,timeline=>{
   const number=timeline.tracks.filter(item=>item.kind===input.kind).length+1;
   timeline.tracks.push({id:randomUUID(),name:input.name||`${input.kind==='video'?'Video':'Audio'} ${number}`,kind:input.kind as string,orderIndex:Math.max(-1,...timeline.tracks.map(item=>item.orderIndex))+1,hidden:false,muted:false});
  }),
  'timeline.track.update':(input: TimelineMutationInput)=>mutate('timeline.track.update',input,timeline=>{
   const lane=track(timeline,input.trackId as string);
   if(lane.kind==='audio'&&input.patch.hidden!==undefined)
    throw new AppError('AUDIO_HIDDEN_UNSUPPORTED','音频轨道不支持隐藏画面，请使用静音');
   Object.assign(lane,input.patch);
  }),
  'timeline.clip.add':(input: TimelineMutationInput)=>mutate('timeline.clip.add',input,(timeline,boundary)=>{
   const source=boundary.inputAsset(input.assetId as string);
   timeline.clips.push({id:randomUUID(),trackId:input.trackId as string,assetId:input.assetId as string,name:input.name||source.name||'Clip',startFrame:input.startFrame as number,durationFrames:input.durationFrames as number,sourceInFrame:input.sourceInFrame??0,rect:input.rect||defaultRect(timeline),gain:input.gain??1,
    ...Object.fromEntries(['fadeInFrames','fadeOutFrames','colour','audioRole','volumeEnvelope',...(isOpacityCandidateApplicationStore(store)?['opacityEnvelope']:[])].filter(field=>input[field]!==undefined).map(field=>[field,input[field]]))});
  }),
  'timeline.clip.update':(input: TimelineMutationInput)=>updateClip(input),
  'timeline.clip.replaceSource':(input: TimelineMutationInput)=>{
   const boundary=createTimelineReplacementBoundary(db,input as unknown as ReplacementInput);
   return mutate('timeline.clip.replaceSource',input,boundary.apply,boundary);
  },
  'timeline.clip.remove':(input: TimelineMutationInput)=>mutate('timeline.clip.remove',input,timeline=>{
   clip(timeline,input.clipId as string);
   timeline.clips=timeline.clips.filter(item=>item.id!==input.clipId);
  }),
  'timeline.clip.rippleRemove':(input: TimelineMutationInput)=>mutate('timeline.clip.rippleRemove',input,timeline=>removeTimelineClipWithRipple(timeline,input.clipId as string)),
  'timeline.clip.split':(input: TimelineMutationInput)=>mutate('timeline.clip.split',input,(timeline,boundary)=>{
   splitClip(timeline,clip(timeline,input.clipId as string),input.atFrame as number,boundary);
  }),
  'timeline.clip.splitAtScenes':(input: TimelineMutationInput)=>{
   let plan: TimelineSceneSplitPlan|undefined;
   return mutate('timeline.clip.splitAtScenes',input,(timeline,boundary)=>{
    const cuts=readSceneSplitCuts(db,input.projectId,input.assetId as string,input.resultId as string);
    plan=splitTimelineAtScenes(timeline,input.assetId as string,cuts,(piece,atFrame)=>splitClip(timeline,piece,atFrame,boundary));
   },undefined,timeline=>({operation:'timeline.clip.splitAtScenes',requestId:input.requestId,timeline,...plan}));
  },
  'timeline.clip.crossfade':(input: TimelineMutationInput)=>{
   let plan: ReturnType<typeof crossfadeTimelineClips>|undefined;
   return mutate('timeline.clip.crossfade',input,(timeline,boundary)=>{plan=crossfadeTimelineClips(timeline,boundary,input.outgoingClipId as string,input.incomingClipId as string);},undefined,
    timeline=>({operation:'timeline.clip.crossfade',requestId:input.requestId,timeline,...plan}));
  },
  'timeline.seed':(input: TimelineMutationInput)=>mutate('timeline.seed',input,(timeline,boundary)=>{
   if(timeline.clips.length)throw new AppError('TIMELINE_NOT_EMPTY','只有空时间线可以从镜头顺序导入',409);
   const shots=boundary.shots();
   if(!shots.length||shots.some(item=>!item.selectedVersionId))throw new AppError('MISSING_SELECTION','请先为每个镜头选择已生成的视频版本');
   const lane=timeline.tracks.filter(item=>item.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex)[0];
   if(!lane)throw new AppError('TRACK_NOT_FOUND','时间线没有视频轨道',404);
   let startFrame=0;
   for(const shot of shots){
    const version=boundary.version(shot.selectedVersionId as string,shot.id);
    if(version.projectId!==timeline.projectId||version.shotId!==shot.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');
    const source=boundary.asset(version.assetId);
    if(source.sha256!==version.sha256)throw new AppError('ASSET_HASH_MISMATCH','镜头版本与素材哈希不一致',409);
    const durationFrames=sourceFrameCount(source.duration as number|null) as number|null;
    if(!Number.isSafeInteger(durationFrames)||(durationFrames as number)<1)throw new AppError('SOURCE_BOUNDS','所选版本没有有效时长');
    timeline.clips.push({id:randomUUID(),trackId:lane.id,assetId:source.id,name:shot.title,startFrame,durationFrames:durationFrames as number,sourceInFrame:0,rect:defaultRect(timeline),gain:1});
    startFrame+=durationFrames as number;
   }
  }),
  'timeline.clip.refreshSources':(input: TimelineMutationInput)=>{
   let plan: TimelineSourceRefreshPlan|undefined;
   return mutate('timeline.clip.refreshSources',input,(timeline,boundary)=>{plan=refreshTimelineSources(timeline,boundary,input.clipIds as string[]);},undefined,
    timeline=>({operation:'timeline.clip.refreshSources',requestId:input.requestId,timeline,...plan}));
  },
  'timeline.shots.append':(input: TimelineMutationInput)=>{
   let plan: TimelineShotAppendPlan|undefined;
   return mutate('timeline.shots.append',input,(timeline,boundary)=>{plan=appendTimelineShots(timeline,boundary);},undefined,
    timeline=>({operation:'timeline.shots.append',requestId:input.requestId,timeline,...plan}));
  },
  'timeline.render':(input: TimelineMutationInput,options: unknown={})=>{
   refuseRestoredOperation(store,'timeline.render',input);
   return input.exportSettings===undefined?render(input):exportAdmission.render(input,options,{
   prepare:()=>{
    const result=transaction<{snapshot: unknown;mode?: string;replayed?: boolean;response?: unknown}>('timeline.render',input,({boundary,write})=>({snapshot:renderSnapshot(input,boundary,write)}));
    return result.mode==='timeline'?{replayed:true,response:result}:result;
   },
   accept:(admission: RenderAdmission)=>render(input,admission),
  });}
 };
 // Fixed backend-only Agent scope. It uses precisely the existing update,
 // history, revision and receipt transaction, with no second mutation engine.
 const moveClipInProject=(input: TimelineMutationInput,target: unknown)=>updateClip(input,createAgentTimelineMoveBoundary(db,input as never,target) as never);
 const setClipGainInProject=(input: TimelineMutationInput,target: unknown)=>updateClip(input,createAgentTimelineGainBoundary(db,input as never,target) as never);
 const createLoudnessApplyTransactions=(assertAvailable: ()=>void)=>createTimelineLoudnessTransactions({
  db,transaction,editable,snapshot,recordEdit,saveResponse,now,admitTimelineImageResponse,admitTimelineVolumeEnvelopeWrite,
  putTimeline:(value: unknown)=>{put('timelines',value);},
  error:(code: string,status=409)=>new AppError(code,'已审核的固定增益无法应用，请重新检查当前时间线',status),
  isDomainError:(error: unknown): boolean=>error instanceof AppError,
 } as never,assertAvailable);
 const initializeProjectFormat=(projectId: string,presetId: string)=>initializeProjectTimelineFormat({
  inTransaction:()=>db.isTransaction,requireProject:(id: string)=>required('projects',id),findTimeline:find,
  create:newTimeline,save:(value: unknown)=>put('timelines',value),
 } as never,projectId,presetId);
 // A task undo merges only its exact targets into the current aggregate. The
 // existing timeline boundary still validates all media, tracks and bounds;
 // unrelated edits survive and the manual history remains coherent.
 const compensateAgentTargetsInside=(projectId:string,targets:readonly AgentTimelineCompensation[]):unknown=>{
  if(!db.isTransaction)throw Error('Agent compensation requires its control transaction');
  const current=find(projectId);if(!current)throw new AppError('REVISION_CONFLICT','时间线已改变',409);
  const input={projectId,requestId:`agent-compensation-${randomUUID()}`,expectedRevision:current.revision,patch:{}};
  const boundary=createTimelineRecoveryBoundary(db,input),timeline=boundary.read()!,before=snapshot(timeline);
  for(const target of targets){
   if(target.kind==='timeline'){
    if(target.before)for(const field of ['fps','width','height'] as const){const value=target.before[field];if(typeof value!=='number')throw new AppError('INVALID_TIMELINE_SNAPSHOT','撤销数据无效',409);timeline[field]=value;}
    continue;
   }
   const field=target.kind==='timeline_clip'?'clips':target.kind==='timeline_track'?'tracks':target.kind==='timeline_subtitle'?'subtitles':null;
   if(!field)throw new AppError('INVALID_TIMELINE_SNAPSHOT','撤销目标无效',409);
   const children=field==='subtitles'?(timeline.subtitles?.cues??[]):timeline[field],retained=children.filter(child=>child.id!==target.id);
   if(target.before)retained.push(clone(target.before));
   if(field==='clips')timeline.clips=retained as TimelineClipRecord[];
   else if(field==='tracks')timeline.tracks=retained as TimelineTrackRecord[];
   else timeline.subtitles={profileId:timeline.subtitles?.profileId??TIMELINE_SUBTITLE_PROFILE_ID,cues:retained as TimelineSubtitleCueRecord[]};
  }
  boundary.validate(timeline);timeline.revision++;timeline.updatedAt=now();admitTimelineImageResponse(timeline);
  admitTimelineVolumeEnvelopeWrite(timeline,{before,after:snapshot(timeline),related:input});
  put('timelines',timeline);recordEdit('agent.task.undo',timeline,before);return timeline;
 };
 return {ensure,history,handlers,moveClipInProject,setClipGainInProject,createLoudnessApplyTransactions,initializeProjectFormat,compensateAgentTargetsInside};
}

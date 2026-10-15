import {createTimelineLoudnessTransactions} from './timeline-loudness-transactions.ts';
import {hasSelectedTimelineExportRange,timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import {bindRestoredExport} from './workspace-restore-exports.mjs';
import {refuseRestoredOperation} from './workspace-restore-policy.mjs';
import {createAgentTimelineMoveBoundary, createAgentTimelineGainBoundary} from './agent/timeline-edit-domain.mjs';
import {createSubtitleMutations} from './timeline-subtitles.mjs';
import {randomUUID} from 'node:crypto';
import {AppError,sourceFrameCount,isTimelineMutationResponse,timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET} from '@mioon/contracts';
import {getTimelineFormat,readTimelineFormatOwner,readTimelineFormatState,assertTimelineFormatEligible} from './timeline-format.mjs';
import {canonicalFormatValue} from './timeline-format-receipts.mjs';
import {freezeTimelineSnapshot} from './timeline-inputs.mjs';
export {TIMELINE_LIMITS} from './timeline-inputs.mjs';
import {readTimelinePreflightSnapshot} from './timeline-sources.mjs';
import {createTimelineReplacementBoundary} from './timeline-replacement.mjs';
import {createTimelineRecoveryBoundary,readTimelineReceipt,rejectTimelineMutation,invalidTimeline,admitTimelineImageResponse,TIMELINE_RESPONSE_BYTES} from './timeline-recovery.mjs';

const defaultRect=timeline=>({x:0,y:0,width:timeline.width,height:timeline.height});
// The shared wire schema admits every preset's envelope. Submitted rectangles
// still receive the legacy input-validation error against this saved pair;
// persisted corruption continues through the separate aggregate boundary.
function validateSubmittedRect(timeline,rect,path){
 if(rect.x+rect.width>timeline.width||rect.y+rect.height>timeline.height)
  throw new AppError('VALIDATION_ERROR','输入字段无效',400,{issues:[{path,message:`Rectangle must stay inside the ${timeline.width}×${timeline.height} output`}]});
}
const clone=value=>JSON.parse(JSON.stringify(value));

// The timeline is its own aggregate: revision checks and idempotent responses
// must be committed in the same SQLite transaction as every mutation.
export function createTimelineServices(store,{required,check,hash,now,exportAdmission}){
 const {db,put,tx}=store;
 function find(projectId){
  const row=db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
  return row?JSON.parse(row.data):null;
 }
 function ensure(projectId){
  required('projects',projectId);
  const existing=find(projectId);
  if(existing)return existing;
  refuseRestoredOperation(store,'timeline.get',{projectId});
  return put('timelines',newTimeline(projectId));
 }
 function newTimeline(projectId,preset=timelineOutputPreset(DEFAULT_TIMELINE_OUTPUT_PRESET)){
  const createdAt=now();
  return {
   id:randomUUID(),projectId,revision:1,fps:preset.fps,width:preset.width,height:preset.height,
   tracks:[['video','Video 1'],['video','Video 2'],['audio','Audio 1']].map(([kind,name],orderIndex)=>({id:randomUUID(),name,kind,orderIndex,hidden:false,muted:false})),
   clips:[],durationFrames:0,createdAt,updatedAt:createdAt
  };
 }
 function track(timeline,id){
  const result=timeline.tracks.find(item=>item.id===id);
  if(!result)throw new AppError('TRACK_NOT_FOUND','轨道不属于此时间线',404,{trackId:id});
  return result;
 }
 function clip(timeline,id){
  const result=timeline.clips.find(item=>item.id===id);
  if(!result)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId:id});
  return result;
 }
 function transaction(operation,input,apply,boundary=createTimelineRecoveryBoundary(db,input)){
  refuseRestoredOperation(store,operation,input);
  const state={operation,receiptAbsent:false,writesStarted:false,transactionEntered:false,callbackFailed:false};
  const write=()=>{state.writesStarted=true;};
  try{return tx(()=>{
   state.transactionEntered=true;
   try{
    const requestHash=hash({operation,input}),previous=readTimelineReceipt(db,input,operation);
    if(previous&&previous.requestHash!==requestHash)
     throw new AppError('IDEMPOTENCY_CONFLICT','同一时间线请求 ID 已用于不同内容',409,{requestId:input.requestId});
    if(previous)return boundary.replay(operation,previous.response);
    state.receiptAbsent=true;
    refuseRestoredOperation(store,operation,input);
    return apply({boundary,requestHash,write});
   }catch(error){state.callbackFailed=true;throw error;}
  });}catch(error){rejectTimelineMutation(db,input,error,state);throw error;}
 }
 function editable(timeline,input){
  check(timeline,input.expectedRevision);
  if(timeline.revision===Number.MAX_SAFE_INTEGER)throw new AppError('TIMELINE_REVISION_LIMIT','时间线版本已达到安全上限',409);
 }
 function currentOrEnsure(input,boundary,write,{sourceSemantics=true}={}){
  const current=boundary.read({legacyMissingProject:true,sourceSemantics});
  if(current)return current;
  // ensure() is itself a write on legacy projects. A later error in this
  // attempt is deliberately ineligible for pre-write rejection proof.
  write();ensure(input.projectId);
  const created=boundary.read();if(!created)invalidTimeline();return created;
 }
 function saveResponse(operation,input,requestHash,response,boundary){
  // Do not reconstruct a response from the current aggregate on retries. An
  // old successful request must return precisely its original response.
  if(!isTimelineMutationResponse(operation,input,response))invalidTimeline();
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(response));
  if(operation==='timeline.format.set')db.prepare('INSERT INTO timeline_format_requests(requestId,projectId,input) VALUES(?,?,?)').run(input.requestId,input.projectId,canonicalFormatValue(input));
  boundary.verify(operation,response,requestHash);
  return response;
 }
 // History owns only editable timeline state. Revisions, IDs/timestamps of the
 // aggregate, media, selected versions, jobs and exports are never restored.
 const snapshot=timeline=>clone({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames,...(Object.hasOwn(timeline,'subtitles')?{subtitles:timeline.subtitles}:{})});
 const cursor=projectId=>db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(projectId)?.position??0;
 const setCursor=(projectId,position)=>db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET position=excluded.position').run(projectId,position);
 function history(projectId){
  required('projects',projectId);
  // One SQLite statement gives even independent connections a single read
  // snapshot. Metadata reads never initialize a timeline or acquire a write lock.
  const row=db.prepare(`SELECT t.data AS timeline,COALESCE(c.position,0) AS position,
   (SELECT COUNT(*) FROM timeline_history h WHERE h.projectId=p.id) AS length,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=c.position) AS undoEntry,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=COALESCE(c.position,0)+1) AS redoEntry
   FROM projects p LEFT JOIN timelines t ON t.projectId=p.id LEFT JOIN timeline_history_cursors c ON c.projectId=p.id WHERE p.id=?`).get(projectId);
  const timeline=row.timeline?JSON.parse(row.timeline):null,position=row.position,length=row.length;
  return {projectId,timelineId:timeline?.id??null,revision:timeline?.revision??null,cursor:position,length,canUndo:position>0,canRedo:position<length,
   undoEntry:row.undoEntry?JSON.parse(row.undoEntry):null,redoEntry:row.redoEntry?JSON.parse(row.redoEntry):null};
 }
 function recordEdit(operation,timeline,before){
  const position=cursor(timeline.projectId)+1;
  // Branch replacement shares the edit transaction, so rejected edits cannot
  // erase redo. Exact old request responses remain independently durable.
  db.prepare('DELETE FROM timeline_history WHERE projectId=? AND position>=?').run(timeline.projectId,position);
  db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?)')
   .run(randomUUID(),timeline.projectId,position,operation,timeline.updatedAt,JSON.stringify(before),JSON.stringify(snapshot(timeline)));
  setCursor(timeline.projectId,position);
 }
 function travel(operation,input,direction){
  return transaction(operation,input,({boundary,requestHash,write})=>{
   let timeline=boundary.read({legacyMissingProject:true});
   const empty=()=>new AppError(direction<0?'NOTHING_TO_UNDO':'NOTHING_TO_REDO',direction<0?'没有可撤销的时间线编辑':'没有可重做的时间线编辑',409);
   if(!timeline)throw empty();
   editable(timeline,input);
   const position=cursor(input.projectId),column=direction<0?'beforeSnapshot':'afterSnapshot';
   const entry=db.prepare(`SELECT CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TIMELINE_RESPONSE_BYTES} THEN ${column} END AS snapshot FROM timeline_history WHERE projectId=? AND position=?`).get(input.projectId,position+(direction>0?1:0));
   if(!entry)throw empty();
   timeline=boundary.restored(timeline,entry.snapshot);
   timeline.revision++;
   timeline.updatedAt=now();
   admitTimelineImageResponse(timeline);
   write();put('timelines',timeline);
   setCursor(input.projectId,position+direction);
   return saveResponse(operation,input,requestHash,timeline,boundary);
  });
 }
 function mutate(operation,input,apply,specialBoundary){
  return transaction(operation,input,({boundary,requestHash,write})=>{
   const submittedRect=operation==='timeline.clip.add'?input.rect:operation==='timeline.clip.update'?input.patch.rect:undefined;
   // Check explicit input before legacy ensure() can write an absent timeline.
   const current=submittedRect===undefined?undefined:boundary.read({legacyMissingProject:true});
   if(submittedRect!==undefined)validateSubmittedRect(current??timelineOutputPreset(DEFAULT_TIMELINE_OUTPUT_PRESET),submittedRect,operation==='timeline.clip.add'?['rect']:['patch','rect']);
   const timeline=specialBoundary?boundary.read():current??currentOrEnsure(input,boundary,write);
   editable(timeline,input);
   const before=snapshot(timeline);
   apply(timeline,boundary);
   boundary.validate(timeline);
   timeline.revision++;
   timeline.updatedAt=now();
   admitTimelineImageResponse(timeline);
   write();put('timelines',timeline);
   recordEdit(operation,timeline,before);
   return saveResponse(operation,input,requestHash,timeline,boundary);
  },specialBoundary);
 }
 function updateClip(input,boundary){
  return mutate('timeline.clip.update',input,timeline=>{Object.assign(clip(timeline,input.clipId),input.patch);},boundary);
 }
 function renderSnapshot(input,boundary,write,expectedTimelineId){
  // Explicit settings/ranges cannot initialize a timeline. The omitted path retains
  // exactly its historical lazy-initialization and frozen projection behavior.
  const timeline=input.exportSettings===undefined&&!hasSelectedTimelineExportRange(input)?currentOrEnsure(input,boundary,write,{sourceSemantics:false}):boundary.read({legacyMissingProject:true,sourceSemantics:false});
  if(expectedTimelineId!==undefined&&timeline?.id!==expectedTimelineId)throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);
  if(!timeline)throw new AppError('EMPTY_TIMELINE','请先向时间线添加片段');
  check(timeline,input.expectedRevision);
  boundary.validate(clone(timeline));
  if(!timeline.clips.length)throw new AppError('EMPTY_TIMELINE','请先向时间线添加片段');
  const rangeIssue=timelineExportRangeBoundsIssue(input,timeline.durationFrames);
  if(rangeIssue)throw new AppError(rangeIssue.code,rangeIssue.message,rangeIssue.status);
  const frozen=freezeTimelineSnapshot(timeline,boundary.sources(timeline),input.exportSettings,input);
  if(input.preflightSnapshotHash!==undefined){
   let current;
   try{current=readTimelinePreflightSnapshot(store,input.projectId,input.exportSettings,input).snapshot;}
   catch{throw new AppError('PREFLIGHT_STALE','导出检查已过期，请重新检查已保存的时间线',409);}
   if(!current||hash(current)!==input.preflightSnapshotHash||hash(frozen)!==input.preflightSnapshotHash)
    throw new AppError('PREFLIGHT_STALE','导出检查已过期，请重新检查已保存的时间线',409);
  }
  return frozen;
 }
 function render(input,admission){
  return transaction('timeline.render',input,({boundary,requestHash,write})=>{
   const frozen=renderSnapshot(input,boundary,write,admission?.timelineId);
   if(admission&&hash(frozen)!==admission.snapshotHash)
    throw new AppError('EXPORT_CAPABILITY_STALE','时间线或素材元数据已变化，请重新检查当前导出配置',409);
   if(admission?.failure)throw admission.failure;
   const createdAt=now();
   const result={id:randomUUID(),projectId:input.projectId,requestId:input.requestId,mode:'timeline',purpose:input.purpose,timelineRevision:frozen.timeline.revision,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt,updatedAt:createdAt};
   write();put('exports',result);
   const response=saveResponse('timeline.render',input,requestHash,result,boundary);
   bindRestoredExport(store,'timeline.render',input,result,requestHash);
   return response;
  });
 }
 const handlers={
  ...createSubtitleMutations(mutate),
  'timeline.format.get':input=>getTimelineFormat(db,input,{store}),
  'timeline.format.set':input=>transaction('timeline.format.set',input,({boundary,requestHash,write})=>{
   const context=readTimelineFormatOwner(db,input);
   check(context.project,input.expectedProjectRevision);
   const revision=context.timeline?.revision??0;
   if(revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','时间线已有新版本，请重新读取后再修改',409,{expectedRevision:input.expectedRevision,currentRevision:revision});
   if(revision===Number.MAX_SAFE_INTEGER)throw new AppError('TIMELINE_REVISION_LIMIT','时间线版本已达到安全上限',409);
   assertTimelineFormatEligible(readTimelineFormatState(db,input,{admission:true,context,store}));
   const preset=timelineOutputPreset(input.presetId);
   if(context.timeline&&timelineOutputPreset(context.timeline)?.id===preset.id)throw new AppError('TIMELINE_FORMAT_UNCHANGED','时间线已使用此输出规格',409);
   const timeline=context.timeline??newTimeline(input.projectId,preset);
   if(context.timeline){timeline.fps=preset.fps;timeline.width=preset.width;timeline.height=preset.height;timeline.revision++;timeline.updatedAt=now();}
   boundary.validate(timeline);
   write();put('timelines',timeline);
   return saveResponse('timeline.format.set',input,requestHash,timeline,boundary);
  }),
  'timeline.get':input=>ensure(input.projectId),
  'timeline.history.get':input=>history(input.projectId),
  'timeline.undo':input=>travel('timeline.undo',input,-1),
  'timeline.redo':input=>travel('timeline.redo',input,1),
  'timeline.track.add':input=>mutate('timeline.track.add',input,timeline=>{
   const number=timeline.tracks.filter(item=>item.kind===input.kind).length+1;
   timeline.tracks.push({id:randomUUID(),name:input.name||`${input.kind==='video'?'Video':'Audio'} ${number}`,kind:input.kind,orderIndex:Math.max(-1,...timeline.tracks.map(item=>item.orderIndex))+1,hidden:false,muted:false});
  }),
  'timeline.track.update':input=>mutate('timeline.track.update',input,timeline=>{
   const lane=track(timeline,input.trackId);
   if(lane.kind==='audio'&&input.patch.hidden!==undefined)
    throw new AppError('AUDIO_HIDDEN_UNSUPPORTED','音频轨道不支持隐藏画面，请使用静音');
   Object.assign(lane,input.patch);
  }),
  'timeline.clip.add':input=>mutate('timeline.clip.add',input,(timeline,boundary)=>{
   const source=boundary.inputAsset(input.assetId);
   timeline.clips.push({id:randomUUID(),trackId:input.trackId,assetId:input.assetId,name:input.name||source.name||'Clip',startFrame:input.startFrame,durationFrames:input.durationFrames,sourceInFrame:input.sourceInFrame??0,rect:input.rect||defaultRect(timeline),gain:input.gain??1,
    ...Object.fromEntries(['fadeInFrames','fadeOutFrames','colour'].filter(field=>input[field]!==undefined).map(field=>[field,input[field]]))});
  }),
  'timeline.clip.update':input=>updateClip(input),
  'timeline.clip.replaceSource':input=>{
   const boundary=createTimelineReplacementBoundary(db,input);
   return mutate('timeline.clip.replaceSource',input,boundary.apply,boundary);
  },
  'timeline.clip.remove':input=>mutate('timeline.clip.remove',input,timeline=>{
   clip(timeline,input.clipId);
   timeline.clips=timeline.clips.filter(item=>item.id!==input.clipId);
  }),
  'timeline.clip.split':input=>mutate('timeline.clip.split',input,(timeline,boundary)=>{
   const left=clip(timeline,input.clipId),end=left.startFrame+left.durationFrames;
   if(input.atFrame<=left.startFrame||input.atFrame>=end)
    throw new AppError('SPLIT_BOUNDS','分割点必须位于所选片段内部，不能位于起止帧',400,{clipId:left.id,startFrame:left.startFrame,endFrame:end,atFrame:input.atFrame});
   const source=boundary.asset(left.assetId),leftDuration=input.atFrame-left.startFrame;
   const fadeInFrames=left.fadeInFrames??0,fadeOutFrames=left.fadeOutFrames??0;
   if(leftDuration<fadeInFrames||leftDuration>left.durationFrames-fadeOutFrames)
    throw new AppError('SPLIT_FADE_BOUNDS','分割点不能位于音频淡入或淡出内部；可在淡入结束或淡出开始帧分割',400,{clipId:left.id,atFrame:input.atFrame,minFrame:left.startFrame+fadeInFrames,maxFrame:end-fadeOutFrames});
   // A still has no advancing source clock. Moving media keeps contiguous
   // source ranges; copying the complete clip also preserves frozen references.
   const right={...clone(left),id:randomUUID(),startFrame:input.atFrame,durationFrames:end-input.atFrame,
    sourceInFrame:source.mimeType.startsWith('image/')?0:left.sourceInFrame+leftDuration};
   // Preserve the original envelope at its two outer edges. Do not introduce
   // keys into legacy clips or make an omitted zero explicit at an inner edge.
   if(Object.hasOwn(left,'fadeInFrames'))right.fadeInFrames=0;
   if(Object.hasOwn(left,'fadeOutFrames'))left.fadeOutFrames=0;
   left.durationFrames=leftDuration;
   timeline.clips.splice(timeline.clips.indexOf(left)+1,0,right);
  }),
  'timeline.seed':input=>mutate('timeline.seed',input,(timeline,boundary)=>{
   if(timeline.clips.length)throw new AppError('TIMELINE_NOT_EMPTY','只有空时间线可以从镜头顺序导入',409);
   const shots=boundary.shots();
   if(!shots.length||shots.some(item=>!item.selectedVersionId))throw new AppError('MISSING_SELECTION','请先为每个镜头选择已生成的视频版本');
   const lane=timeline.tracks.filter(item=>item.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex)[0];
   if(!lane)throw new AppError('TRACK_NOT_FOUND','时间线没有视频轨道',404);
   let startFrame=0;
   for(const shot of shots){
    const version=boundary.version(shot.selectedVersionId,shot.id);
    if(version.projectId!==timeline.projectId||version.shotId!==shot.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');
    const source=boundary.asset(version.assetId);
    if(source.sha256!==version.sha256)throw new AppError('ASSET_HASH_MISMATCH','镜头版本与素材哈希不一致',409);
    const durationFrames=sourceFrameCount(source.duration);
    if(!Number.isSafeInteger(durationFrames)||durationFrames<1)throw new AppError('SOURCE_BOUNDS','所选版本没有有效时长');
    timeline.clips.push({id:randomUUID(),trackId:lane.id,assetId:source.id,name:shot.title,startFrame,durationFrames,sourceInFrame:0,rect:defaultRect(timeline),gain:1});
    startFrame+=durationFrames;
   }
  }),
  'timeline.render':(input,options={})=>{
   refuseRestoredOperation(store,'timeline.render',input);
   return input.exportSettings===undefined?render(input):exportAdmission.render(input,options,{
   prepare:()=>{
    const result=transaction('timeline.render',input,({boundary,write})=>({snapshot:renderSnapshot(input,boundary,write)}));
    return result.mode==='timeline'?{replayed:true,response:result}:result;
   },
   accept:admission=>render(input,admission),
  });}
 };
 // Fixed backend-only Agent scope. It uses precisely the existing update,
 // history, revision and receipt transaction, with no second mutation engine.
 const moveClipInProject=(input,target)=>updateClip(input,createAgentTimelineMoveBoundary(db,input,target));
 const setClipGainInProject=(input,target)=>updateClip(input,createAgentTimelineGainBoundary(db,input,target));
 const createLoudnessApplyTransactions=assertAvailable=>createTimelineLoudnessTransactions({
  db,transaction,editable,snapshot,recordEdit,saveResponse,now,admitTimelineImageResponse,
  putTimeline:value=>{put('timelines',value);},
  error:(code,status=409)=>new AppError(code,'已审核的固定增益无法应用，请重新检查当前时间线',status),
  isDomainError:error=>error instanceof AppError,
 },assertAvailable);
 return {ensure,history,handlers,moveClipInProject,setClipGainInProject,createLoudnessApplyTransactions};
}

import {assertTimelineVolumeEnvelopeWorkspace,hasTimelineVolumeEnvelope,admitTimelineVolumeEnvelopeWrite,TIMELINE_VOLUME_ENVELOPE_REJECTION_CODES} from './timeline-volume-envelope-admission.ts';
import {assertTimelineAudioRoleWorkspace} from './workspace-schema-dispatch.ts';
import {timelineImageResponseBudgetIssue} from './timeline-image-budget.ts';
import {validateTimelineColourBindings} from './timeline-colour-business.ts';
import {createTimelineLoudnessRecovery} from './timeline-loudness-recovery.ts';
import {TIMELINE_LOUDNESS_APPLY_OPERATION,TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES,createTimelineLoudnessApplyContracts} from '@mioon/contracts/timeline-loudness-apply';
import {readTimelineFormatProvenance} from './timeline-format-receipts.ts';
import {AppError,TIMELINE_SUBTITLE_OPERATIONS,TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES,isTimelineMutationResponse,isTimelineRecord,isTimelineRenderRecord,TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';
export {TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import {validateSavedTimeline} from './timeline-inputs.ts';

const loudnessApplyContracts=createTimelineLoudnessApplyContracts({isTimelineRecord});
const clone=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const invalidTimeline=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的请求响应无效',409);};
const unavailable=()=>{throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);};
export function admitTimelineImageResponse(timeline){
 const issue=timelineImageResponseBudgetIssue(timeline,TIMELINE_RESPONSE_BYTES);
 if(issue)throw new AppError(issue.code,issue.message,issue.status,issue.details);
}
// History owns only editable state. Reuse this projection for travel and
// read-only eligibility inspection so an omitted historical subtitle field
// removes current cues rather than leaking them into an earlier snapshot.
export function restoreTimelineEditableSnapshot(timeline,saved){
 if(!object(saved)||!['tracks','clips','durationFrames'].every(key=>Object.hasOwn(saved,key))||Object.keys(saved).some(key=>!['tracks','clips','durationFrames','subtitles'].includes(key)))invalidTimeline();
 const result={...timeline,tracks:saved.tracks,clips:saved.clips,durationFrames:saved.durationFrames};
 delete result.subtitles;
 if(Object.hasOwn(saved,'subtitles'))result.subtitles=saved.subtitles;
 return result;
}

const bounded=(column,bytes)=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;
const identity=column=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
const definiteRejections=new Set(['AUDIO_ROLE_CLIP_UNSUPPORTED','TIMELINE_IMAGE_AGGREGATE_BUDGET','TIMELINE_COLOUR_SOURCE_MISMATCH','TIMELINE_COLOUR_LOOK_UNAVAILABLE','EXPORT_RANGE_BOUNDS','REVISION_CONFLICT','TIMELINE_REVISION_LIMIT','SOURCE_UNCHANGED','INVALID_CLIP_TYPE','SOURCE_BOUNDS',
 'SUBTITLE_LIMIT','SUBTITLE_BOUNDS','SUBTITLE_OVERLAP','SUBTITLE_NOT_FOUND','INVALID_FADE','FADE_AUDIO_UNSUPPORTED','AUDIO_HIDDEN_UNSUPPORTED','TIMELINE_LIMIT','CLIP_OVERLAP','SPLIT_BOUNDS','SPLIT_FADE_BOUNDS',
 'TIMELINE_FORMAT_UNCHANGED','TIMELINE_FORMAT_LOCKED','TIMELINE_NOT_EMPTY','MISSING_SELECTION','NOTHING_TO_UNDO','NOTHING_TO_REDO','EMPTY_TIMELINE','PREFLIGHT_STALE',...TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES]);

// A proof is attached only outside the transaction after its rollback. A fresh
// receipt absence is necessary, but cannot make a post-write or scope failure
// definite. The caller marks *every* write, including legacy initialization.
export function rejectTimelineMutation(db,input,error,{receiptAbsent,writesStarted,transactionEntered,callbackFailed,operation,ownedScope=false}){
 // New loudness proofs require its owner-aware adapter's exact post-rollback
 // binding; never fall back to the legacy optional operation/project proof.
 if(TIMELINE_VOLUME_ENVELOPE_REJECTION_CODES.includes(error?.code)){
  try{if(typeof ownedScope==='function'&&ownedScope()&&transactionEntered&&callbackFailed&&receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&!db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId)&&ownedScope())
   error.details={...error.details,mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId};}catch{ /* uncertain rollback/ownership never releases a key */ }
  return;
 }
 if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return;
 if(transactionEntered&&callbackFailed&&receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&definiteRejections.has(error.code))
  error.details={...error.details,mutationOutcome:'not_applied',requestId:input.requestId,...(error.code==='AUDIO_ROLE_CLIP_UNSUPPORTED'||error.code==='TIMELINE_IMAGE_AGGREGATE_BUDGET'||operation==='timeline.format.set'||TIMELINE_SUBTITLE_OPERATIONS.includes(operation)||operation==='timeline.render'&&(Object.hasOwn(input,'exportRange')||TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES.includes(error.code))?{operation,projectId:input.projectId}:{})};
}

export function readTimelineReceipt(db,input,operation){
 const bytes=operation===TIMELINE_LOUDNESS_APPLY_OPERATION?TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES:operation==='timeline.render'?TIMELINE_RENDER_RESPONSE_BYTES:operation==='timeline.clip.replaceSource'?TIMELINE_REPLACEMENT_RESPONSE_BYTES:TIMELINE_RESPONSE_BYTES;
 const row=db.prepare(`SELECT ${bounded('requestHash',64)} AS requestHash,${bounded('response',bytes)} AS response FROM timeline_requests WHERE requestId=?`).get(input.requestId);
 if(row&&(typeof row.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(row.requestHash)))invalidTimeline();
 return row;
}

// Reads preserve stored JSON exactly. Each source gets the existing bounded
// ownership reader independently, rather than imposing the inspection-wide
// budget on a valid 100-clip edit, history entry or frozen export.
export function createTimelineRecoveryBoundary(db,input){
 const guarded=fn=>{try{return fn();}catch(error){if(error.code==='INSPECTION_UNAVAILABLE')unavailable();throw error;}};
 const graph=()=>guarded(()=>createOwnedMediaGraphReader(db,input.projectId));
 const asset=id=>guarded(()=>graph().asset(id));
 const inputAsset=id=>{
  const row=db.prepare(`SELECT ${identity('projectId')} FROM assets WHERE id=?`).get(id);
  if(!row)throw new AppError('NOT_FOUND','找不到记录',404,{id});
  if(row.projectId!==input.projectId)throw new AppError('CROSS_PROJECT_REFERENCE','素材不属于此项目');
  return asset(id);
 };
 const clipSource=clip=>guarded(()=>graph().clipSource(clip));
 const version=(id,shotId,assetId)=>guarded(()=>graph().version(id,shotId,assetId));
 function sources(timeline){
  const assets=new Map(),seen=new Set();
  for(const clip of timeline.clips){
   const key=JSON.stringify([clip.assetId,...['versionId','shotId','jobId'].map(field=>[Object.hasOwn(clip,field),clip[field]])]);
   if(seen.has(key))continue;
   assets.set(clip.assetId,clipSource(clip));seen.add(key);
  }
  try{validateTimelineColourBindings(db,timeline,assets);}catch(error){
   if(['TIMELINE_COLOUR_SOURCE_MISMATCH','TIMELINE_COLOUR_LOOK_UNAVAILABLE'].includes(error.code))throw new AppError(error.code,error.message,error.status);throw error;
  }
  return assets;
 }
 function validate(timeline){
  assertTimelineAudioRoleWorkspace(db,timeline);
  assertTimelineVolumeEnvelopeWorkspace(db,timeline);
  const assets=sources(timeline);
  validateSavedTimeline(timeline,{track:(value,id)=>{
   const track=value.tracks.find(track=>track.id===id);
   if(!track)throw new AppError('TRACK_NOT_FOUND','轨道不属于此时间线',404,{trackId:id});return track;
  },asset:(_projectId,id)=>assets.get(id)});
  admitTimelineImageResponse(timeline);
  admitTimelineVolumeEnvelopeWrite(timeline);
  if(!isTimelineRecord(timeline,{projectId:input.projectId}))invalidTimeline();
  return timeline;
 }
 function validateReadonly(timeline){
  assertTimelineAudioRoleWorkspace(db,timeline);
  assertTimelineVolumeEnvelopeWorkspace(db,timeline);
  if(!isTimelineRecord(timeline,{projectId:input.projectId}))invalidTimeline();
  try{const checked=validate(clone(timeline));if(checked.durationFrames!==timeline.durationFrames)invalidTimeline();}
  catch(error){if(['TIMELINE_SOURCE_UNAVAILABLE','INSPECTION_BUDGET_EXCEEDED'].includes(error.code))throw error;invalidTimeline();}
  return timeline;
 }
 function read({legacyMissingProject=false,sourceSemantics=true}={}){
  if(legacyMissingProject&&!db.prepare('SELECT 1 FROM projects WHERE id=?').get(input.projectId))
   throw new AppError('NOT_FOUND','找不到记录',404,{id:input.projectId});
  graph(); // Validate the current project before any aggregate/CAS disclosure.
  const row=db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data',TIMELINE_RESPONSE_BYTES)} AS data FROM timelines WHERE projectId=? LIMIT 1`).get(input.projectId);
  if(!row)return null;
  let timeline;try{timeline=JSON.parse(row.data);}catch{unavailable();}
  if(!object(timeline)||!uuid(row.id)||row.id!==timeline.id||row.projectId!==input.projectId||timeline.projectId!==input.projectId)unavailable();
  assertTimelineAudioRoleWorkspace(db,timeline);
  assertTimelineVolumeEnvelopeWorkspace(db,timeline);
  if(sourceSemantics)return validateReadonly(timeline);
  // Historical render acknowledgements retain their own frozen media metadata.
  // Current structure and source ownership remain mandatory even when later
  // metadata discovery changes duration or audio flags under the same bytes.
  if(!isTimelineRecord(timeline,{projectId:input.projectId}))invalidTimeline();
  sources(timeline);return timeline;
 }
 function shots(){
  graph();
  const rows=db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data',INSPECTION_ROW_LIMITS.shots)} AS data FROM shots WHERE projectId=? LIMIT 101`).all(input.projectId);
  const values=rows.map(row=>{
   let value;try{value=JSON.parse(row.data);}catch{unavailable();}
   if(!object(value)||!uuid(row.id)||value.id!==row.id||row.projectId!==input.projectId||value.projectId!==input.projectId||
    !(value.selectedVersionId===null||uuid(value.selectedVersionId))||!Number.isSafeInteger(value.orderIndex)||value.orderIndex<0)unavailable();
   return value;
  });
  if(values.length>100)throw new AppError('TIMELINE_LIMIT','时间线最多支持100个片段',400);
  return values.sort((a,b)=>a.orderIndex-b.orderIndex);
 }
 function restored(timeline,text){
  let saved;try{saved=JSON.parse(text);}catch{invalidTimeline();}
  const result=restoreTimelineEditableSnapshot(timeline,saved);
  if(timelineImageResponseBudgetIssue(result,TIMELINE_RESPONSE_BYTES)||hasTimelineVolumeEnvelope(result)&&Buffer.byteLength(JSON.stringify(result))>TIMELINE_RESPONSE_BYTES){
   // History omits revision/timestamps. First check its strict structure and
   // source ownership in the smallest constructor envelope, then distinguish
   // growth caused by today's revision from malformed stored editable data.
   // This projection is verification-only: it is never returned or persisted.
   validateReadonly({...result,revision:1,updatedAt:timeline.createdAt});
   admitTimelineImageResponse(result);
   admitTimelineVolumeEnvelopeWrite(result);
  }
  validateReadonly(result);return result;
 }
 function renderRecord(response){
  const row=db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data',TIMELINE_RENDER_RESPONSE_BYTES)} AS data FROM exports WHERE id=? AND projectId=?`).get(response.id,input.projectId);
  let current;try{current=JSON.parse(row?.data);}catch{unavailable();}
  if(!row||row.id!==response.id||row.projectId!==input.projectId||!isTimelineRenderRecord(current,input)||current.id!==response.id)unavailable();
  for(const field of ['id','projectId','requestId','mode','purpose','timelineRevision'])if(current[field]!==response[field])invalidTimeline();
  if(JSON.stringify(current.snapshot)!==JSON.stringify(response.snapshot))invalidTimeline();
  if(current.assetId!==null)asset(current.assetId);
  return current;
 }
 function responseSources(operation,response,{historical=false}={}){
  assertTimelineAudioRoleWorkspace(db,response);
  assertTimelineVolumeEnvelopeWorkspace(db,response);
  const timeline=operation==='timeline.render'?response.snapshot.timeline:response;
  if(operation==='timeline.render'&&historical){
   // The shared ACK validator checked frame/fade semantics against the frozen
   // asset DTO. Replaying must not substitute current duration/audio metadata.
   if(!isTimelineRecord(timeline,{projectId:input.projectId}))invalidTimeline();
   sources(timeline);
  }else validateReadonly(timeline);
  if(operation==='timeline.clip.split'){
   const left=timeline.clips.find(clip=>clip.id===input.clipId);
   const right=timeline.clips.find(clip=>clip.id!==left?.id&&clip.trackId===left?.trackId&&clip.startFrame===input.atFrame);
   if(!left||!right)invalidTimeline();
   // The shared wire guard cannot know the source MIME. Narrow its still-image
   // alternative here: moving media must keep an exactly contiguous clock.
   const source=asset(left.assetId),still=source.mimeType.startsWith('image/');
   if(still?left.sourceInFrame!==0||right.sourceInFrame!==0:right.sourceInFrame!==left.sourceInFrame+left.durationFrames)invalidTimeline();
  }
  if(operation==='timeline.render'){
   for(const frozen of response.snapshot.assets){
    const source=asset(frozen.id);
    if(source.sha256!==frozen.sha256||source.mimeType!==frozen.mimeType||
     (Object.hasOwn(frozen,'relativePath')&&source.relativePath!==frozen.relativePath)||
     (!historical&&(['duration','width','height'].some(field=>Object.hasOwn(frozen,field)&&source[field]!==frozen[field])||
      typeof frozen.hasAudio==='boolean'&&frozen.hasAudio!==source.hasAudio)))unavailable();
   }
  }
  return timeline;
 }
 const loudnessRecovery=createTimelineLoudnessRecovery(input,{
  invalid:invalidTimeline,isResponse:loudnessApplyContracts.isTimelineLoudnessApplyResponse,
  readCurrent:historical=>read({sourceSemantics:!historical}),sources,
  readReceipt:()=>readTimelineReceipt(db,input,TIMELINE_LOUDNESS_APPLY_OPERATION),
 });
 function replay(operation,text){
  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return loudnessRecovery.replay(text);
  if(operation==='timeline.format.set')readTimelineFormatProvenance(db,input,readTimelineReceipt(db,input,operation)?.requestHash);
  let response;try{response=JSON.parse(text);}catch{invalidTimeline();}
  if(!isTimelineMutationResponse(operation,input,response))invalidTimeline();
  const current=read({sourceSemantics:operation!=='timeline.render'});
  if(!current)unavailable();
  const timeline=responseSources(operation,response,{historical:true});
  if(current.id!==timeline.id||current.revision<timeline.revision)invalidTimeline();
  if(operation==='timeline.render')renderRecord(response);
  // No requirement that the historical target clip still exists, matches, or
  // occupies the current revision. Return the retained response, unchanged.
  return response;
 }
 function verify(operation,response,requestHash){
  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return loudnessRecovery.verify(response,requestHash);
  if(operation==='timeline.format.set')readTimelineFormatProvenance(db,input,requestHash);
  if(!isTimelineMutationResponse(operation,input,response))invalidTimeline();
  const current=read();if(!current)unavailable();
  responseSources(operation,response);
  if(operation==='timeline.render'){
   if(current.id!==response.snapshot.timeline.id||JSON.stringify(renderRecord(response))!==JSON.stringify(response))invalidTimeline();
  }else if(JSON.stringify(current)!==JSON.stringify(response))invalidTimeline();
  const saved=readTimelineReceipt(db,input,operation);
  if(saved?.requestHash!==requestHash||saved.response!==JSON.stringify(response))invalidTimeline();
 }
 return {read,asset,inputAsset,clipSource,version,sources,shots,validate,validateReadonly,restored,replay,verify};
}

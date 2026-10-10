import {AppError,isTimelineReplacementResponse} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';
import {validateSavedTimeline} from './timeline-inputs.mjs';

export const REPLACEMENT_RESPONSE_BYTES=INSPECTION_ROW_LIMITS.timelines;
const invalid=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的替换响应无效',409);};
const unavailable=()=>{throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);};
const category=value=>typeof value==='string'?value.split('/')[0]:null;
const provenance=['versionId','shotId','jobId'];
const definiteRejections=new Set(['REVISION_CONFLICT','SOURCE_UNCHANGED','INVALID_CLIP_TYPE','SOURCE_BOUNDS','INVALID_FADE','FADE_AUDIO_UNSUPPORTED']);

// This boundary applies only to explicit source replacement. Legacy mutations
// and receipts keep their established behavior. Every read runs synchronously
// inside the existing timeline transaction; no media bytes or providers enter.
export function createTimelineReplacementBoundary(db,input){
 let graph;
 const guarded=fn=>{
  try{return fn();}catch(error){
   if(error.code==='INSPECTION_UNAVAILABLE')unavailable();
   throw error;
  }
 };
 function read(){
  return guarded(()=>{
   graph=createOwnedMediaGraphReader(db,input.projectId);
   const timeline=graph.timeline();
   if(!timeline)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
   return timeline;
  });
 }
 function validate(timeline){
  return guarded(()=>{
   graph.validateTimeline(timeline);
   return validateSavedTimeline(timeline,{
    track:(value,id)=>value.tracks.find(track=>track.id===id),
    asset:(_projectId,id)=>graph.asset(id)
   });
  });
 }
 function apply(timeline){
  return guarded(()=>{
   const clip=timeline.clips.find(clip=>clip.id===input.clipId);
   if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
   const previous=graph.clipSource(clip),source=graph.asset(input.assetId);
   if(previous.id===source.id)throw new AppError('SOURCE_UNCHANGED','片段已使用此素材，无需替换',409);
   if(!['video','audio','image'].includes(category(source.mimeType))||category(previous.mimeType)!==category(source.mimeType))
    throw new AppError('INVALID_CLIP_TYPE','替换素材必须与原素材同为视频、音频或图片',400);
   const version=input.versionId===undefined?null:graph.version(input.versionId,undefined,source.id);
   // The asset ID already pins the managed immutable source identity/hash.
   // Asset-only selection must not invent stored version/shot provenance.
   for(const key of provenance)delete clip[key];
   clip.assetId=source.id;
   if(version){clip.versionId=version.id;clip.shotId=version.shotId;}
  });
 }
 function replay(text){
  let response;
  try{response=JSON.parse(text);}catch{invalid();}
  if(!isTimelineReplacementResponse(response,input))invalid();
  const current=read();
  if(response.id!==current.id||response.revision!==input.expectedRevision+1||current.revision<response.revision)invalid();
  // Validate receipt semantics on a copy: the legacy validator recomputes the
  // aggregate duration, but an exact replay must never normalize saved bytes.
  const checked=JSON.parse(JSON.stringify(response));
  try{validate(checked);}catch(error){
   if(['TIMELINE_SOURCE_UNAVAILABLE','INSPECTION_BUDGET_EXCEEDED'].includes(error.code))throw error;
   invalid();
  }
  if(checked.durationFrames!==response.durationFrames)invalid();
  // Do not require the current clip to still exist or match. A historical
  // receipt remains exact after undo, deletion, later replacement or branching.
  return response;
 }
 function verify(response,requestHash){
  // Discard the read cache after writes, including any SQLite triggers. A
  // changed owner or persisted result rolls back history and receipt together.
  if(!isTimelineReplacementResponse(response,input))invalid();
  const current=read();
  validate(JSON.parse(JSON.stringify(current)));
  if(JSON.stringify(current)!==JSON.stringify(response))invalid();
  const saved=db.prepare(`SELECT CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash,
   CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${REPLACEMENT_RESPONSE_BYTES} THEN response END AS response
   FROM timeline_requests WHERE requestId=?`).get(input.requestId);
  if(saved?.response!==JSON.stringify(response)||saved.requestHash!==requestHash)invalid();
 }
 function rejected(error,{receiptAbsent,writesStarted}){
  // A 4xx replay failure cannot prove an earlier commit was not applied. Only
  // an absent receipt observed under this transaction's lock and a completed
  // rollback of a known pre-write business rejection may release that key.
  if(receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&definiteRejections.has(error.code))
   error.details={...error.details,mutationOutcome:'not_applied',requestId:input.requestId};
 }
 return {read,apply,validate,replay,verify,rejected};
}

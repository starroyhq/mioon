import {retainedTimelineCatalog} from './timeline-retained-catalog.ts';
import type {DatabaseSync} from 'node:sqlite';
import {validateVolumeEnvelope,VOLUME_ENVELOPE_PROFILE} from '../../contracts/src/timeline-volume-envelope.ts';
import {isVolumeEnvelopeProcessingSnapshot} from '../../contracts/src/timeline-volume-envelope-processing.ts';
// Historical schemas validate only a projection; no projection is persisted.
import {timelineRetainedRuntime} from './timeline-retained-runtime.ts';
import {createTimelineLoudnessApplyContracts} from '../../contracts/src/timeline-loudness-apply.ts';
import {isTimelineClipLoudnessResponse} from '../../contracts/src/timeline-clip-loudness.ts';
import {isTimelineMixLoudnessResponse} from '../../contracts/src/timeline-mix-loudness.ts';
import {TIMELINE_CROSSFADE_OPERATION,createTimelineCrossfadeContracts} from '../../contracts/src/timeline-crossfade.ts';
import {TIMELINE_CLIP_GAINS_OPERATION,createTimelineClipGainsContracts} from '../../contracts/src/timeline-clip-gains.ts';
import {TIMELINE_CLIP_TRANSFORM_OPERATION,createTimelineClipTransformContracts} from '../../contracts/src/timeline-clip-transform-operation.ts';
import {TIMELINE_CLIP_TRANSITION_OPERATION,createTimelineClipTransitionContracts} from '../../contracts/src/timeline-clip-transition-operation.ts';
import {WRAPPED_TIMELINE_OPERATIONS} from './timeline-retained-receipts.ts';

const JSON_BYTES=4*1024*1024, SNAPSHOT_BYTES=256*1024;
const keys=['volumeEnvelope','volumeEnvelopeProfile','volumeEnvelopeProcessingProfile','volumeEnvelopeSha256'];
const knownCodes=new Set(['INVALID_VOLUME_ENVELOPE','VOLUME_ENVELOPE_SOURCE_UNSUPPORTED','TIMELINE_VOLUME_ENVELOPE_INVALID','TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED','TIMELINE_VOLUME_ENVELOPE_LIMIT','TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED']);
const codeEvidence=(value:unknown)=>typeof value==='string'&&/(?:^|_)VOLUME_ENVELOPE(?:_|$)/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:object,key:string)=>Object.hasOwn(value,key);
// Ephemeral LRA/target candidates are not retained playback evidence.
const historicalClipLoudness=(value:Record<string,unknown>):boolean=>
 !['loudnessRange','target','candidate'].some(key=>own(value,key))&&isTimelineClipLoudnessResponse(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const families=[['timelines',['data']],['timeline_history',['beforeSnapshot','afterSnapshot']],['timeline_requests',['response']],['edit_tasks',['input']],['exports',['data']],] as const;
function invalid():never {throw Object.assign(new Error('Invalid retained volume-envelope records'),{code:'WORKSPACE_VOLUME_ENVELOPE_INVALID'});}
function walk(root:unknown,visit:(value:Record<string,unknown>)=>void):void {
 const pending=[{value:root,depth:0}];let nodes=0;
 while(pending.length){const {value,depth}=pending.pop()!;if(++nodes>200000||depth>128)invalid();
  if(value===null||typeof value!=='object')continue;
  if(object(value))visit(value);
  const children=Object.values(value);
  if(nodes+pending.length+children.length>200000)invalid();
  for(const child of children)pending.push({value:child,depth:depth+1});
 }
}
/** Ordinary decoded JSON only, not an adversarial object-execution boundary. */
export function hasTimelineVolumeEnvelopeEvidence(root:unknown):boolean {
 let found=false;walk(root,value=>{if(keys.some(key=>own(value,key))||value.profileId===VOLUME_ENVELOPE_PROFILE||codeEvidence(value.errorCode)||codeEvidence(value.code))found=true;});return found;
}

/** Scan all retained rows, including completed tasks, historical receipts and
 * archived history. This is read-only admission, never a migration or capability. */
export function validateTimelineVolumeEnvelopeRows(db:Pick<DatabaseSync,'prepare'>,projectCell:(text:string)=>string=value=>value):void {
 const runtime=timelineRetainedRuntime;
 const isTimelineLoudnessApplyResponse=(root:unknown,input:unknown)=>createTimelineLoudnessApplyContracts({isTimelineRecord:timelineRetainedRuntime.isTimelineRecord}).isTimelineLoudnessApplyResponse(root,input);
 const names=new Map<string,{type:unknown;sql:unknown}>();
 for(const row of retainedTimelineCatalog(db,['timelines','timeline_history','timeline_requests','edit_tasks','exports','assets'])){
  if(typeof row.name!=='string'||names.has(row.name))invalid();names.set(row.name,{type:row.type,sql:row.sql});
 }
 for(const item of names.values())if(item.type!=='table'||typeof item.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(item.sql))invalid();
 function ownership(assetId:unknown,owner:unknown):void {
  if(!uuid(assetId)||!uuid(owner)||!names.has('assets'))invalid();
  const rows=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId FROM assets WHERE id=? LIMIT 2").all(assetId);
  if(rows.length!==1||rows[0]!.projectId!==owner)invalid();
 }
 function source(clip:Record<string,unknown>,owner:unknown,frozen:unknown[]|undefined):void {
  ownership(clip.assetId,owner);
  if(clip.volumeEnvelope===null)return;
  let asset:unknown;
  if(frozen){const matches=frozen.filter(item=>object(item)&&item.id===clip.assetId);if(matches.length!==1)invalid();asset=matches[0];}
  else {
   const row=db.prepare("SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN data END AS data FROM assets WHERE id=? LIMIT 1").get(clip.assetId as string);
   if(typeof row?.data!=='string')invalid();try{asset=JSON.parse(row.data);}catch{invalid();}
  }
  // Cached metadata is not actual-source proof. Historical frozen metadata is
  // never replaced by today's cache; only id/project ownership is read above.
  if(!object(asset)||!['audio/wav','audio/mpeg','audio/mp4','video/mp4','video/webm'].includes(String(asset.mimeType)))invalid();
  if(frozen&&(!Number.isFinite(asset.duration)||Number(asset.duration)<=0||!Number.isSafeInteger(clip.sourceInFrame)||Number(clip.sourceInFrame)<0||Number(clip.sourceInFrame)+Number(clip.durationFrames)>Math.floor(Number(asset.duration)*30+1e-6)))invalid();
 }
 function inspect(root:unknown,owner:unknown,table:string,operation:unknown,request:unknown,bindings:{owner:boolean;operation:boolean;request:boolean}):void {
  const loudness=table==='timeline_requests'&&operation==='timeline.loudness.apply'||object(root)&&root.operation==='timeline.loudness.apply';
  if(loudness){
   // Discriminate the whole root before traversing any nested snapshot. A
   // malformed labelled ACK must never fall back to a valid render subtree.
   if(table!=='timeline_requests'||!object(root)||root.operation!=='timeline.loudness.apply'||!object(root.timeline)||!object(root.application))invalid();
   if(bindings.owner&&owner!==root.timeline.projectId||bindings.operation&&operation!==root.operation||bindings.request&&request!==root.requestId)invalid();
   const application=root.application;
   const input={projectId:root.timeline.projectId,requestId:root.requestId,expectedRevision:application.beforeRevision,
    candidateDigest:application.candidateDigest,snapshotSha256:application.snapshotSha256,mixProfile:application.mixProfile,measurementProfile:application.measurementProfile,target:application.target};
   // Payload validation establishes self-consistency, not independent authority.
   if(!Boolean(isTimelineLoudnessApplyResponse(root,input))||Buffer.byteLength(JSON.stringify(root))>SNAPSHOT_BYTES)invalid();
  }
  // A wrapped receipt's timeline is a timeline record, not a render snapshot,
  // so it carries no frozen assets.
  const wrapped=!loudness&&table==='timeline_requests'&&object(root)&&WRAPPED_TIMELINE_OPERATIONS.includes(root.operation as string);
  if(wrapped){
   // Bind the wrapper to its row and its timeline to the record validator; the
   // clips inside are still checked one by one below, sources included.
   const timeline=root.timeline;
   if(!object(timeline)||typeof root.requestId!=='string'||bindings.request&&request!==root.requestId||
    !timelineRetainedRuntime.isTimelineRecord(timeline,{projectId:timeline.projectId}))invalid();
   if(root.operation===TIMELINE_CROSSFADE_OPERATION){
    const summary=root.crossfade,revision=Number(timeline.revision);
    const input=object(summary)?{projectId:timeline.projectId,expectedRevision:revision-1,requestId:root.requestId,outgoingClipId:summary.outgoingClipId,incomingClipId:summary.incomingClipId}:null;
    if(!input||!createTimelineCrossfadeContracts({isTimelineRecord:timelineRetainedRuntime.isTimelineRecord}).isTimelineCrossfadeResponse(root,input))invalid();
   }
   if(root.operation===TIMELINE_CLIP_GAINS_OPERATION){
    const changes=root.gains,revision=Number(timeline.revision);
    const input=Array.isArray(changes)&&changes.every(object)?{projectId:timeline.projectId,expectedRevision:revision-1,requestId:root.requestId,gains:changes.map(change=>({clipId:change.clipId,gain:change.gain}))}:null;
    if(!input||!createTimelineClipGainsContracts({isTimelineRecord:timelineRetainedRuntime.isTimelineRecord}).isTimelineClipGainsResponse(root,input))invalid();
   }
   if(root.operation===TIMELINE_CLIP_TRANSFORM_OPERATION){
    const revision=Number(timeline.revision);
    const input={projectId:timeline.projectId,expectedRevision:revision-1,requestId:root.requestId,clipId:root.clipId,transform:root.transform};
    if(!createTimelineClipTransformContracts({isTimelineRecord:timelineRetainedRuntime.isTimelineRecord}).isTimelineClipTransformResponse(root,input))invalid();
   }
   if(root.operation===TIMELINE_CLIP_TRANSITION_OPERATION){
    const revision=Number(timeline.revision);
    const input={projectId:timeline.projectId,expectedRevision:revision-1,requestId:root.requestId,clipId:root.clipId,transition:root.transition};
    if(!createTimelineClipTransitionContracts({isTimelineRecord:timelineRetainedRuntime.isTimelineRecord}).isTimelineClipTransitionResponse(root,input))invalid();
   }
  }
  const admitted=new WeakMap<object,Set<string>>();
  const mark=(value:object,key:string)=>{let set=admitted.get(value);if(!set)admitted.set(value,set=new Set());set.add(key);};
  const envelope=(value:Record<string,unknown>,partial:boolean)=>{
   if(!own(value,'volumeEnvelope'))return;
   // A historical update can outlive its clip, its duration and an Undo. The
   // lexical bound is 18000, not a lookup of the current clip or its cache.
   const duration=partial&&!own(value,'durationFrames')?18000:value.durationFrames;
   try{validateVolumeEnvelope(value.volumeEnvelope,duration as number);}catch{invalid();}
   mark(value,'volumeEnvelope');if(object(value.volumeEnvelope))mark(value.volumeEnvelope,'profileId');
  };
  const intent=(input:unknown,op:unknown)=>{
   if(!object(input)||!uuid(input.projectId)||input.projectId!==owner||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1||typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200||Buffer.byteLength(JSON.stringify(input))>8192)invalid();
   let fields:Record<string,unknown>;
   if(op==='timeline.clip.add'){if(!uuid(input.assetId)||!uuid(input.trackId))invalid();fields=input;}
   else if(op==='timeline.clip.update'&&uuid(input.clipId)&&object(input.patch))fields=input.patch;
   else invalid();
   envelope(fields,op==='timeline.clip.update');
   const projected={...input};
   const projectedFields=op==='timeline.clip.add'?projected:{...fields};
   delete projectedFields.volumeEnvelope;
   if(op==='timeline.clip.update'){
    // Validate the historical non-envelope fields; an envelope-only patch has
    // no historical counterpart. The temporary nonempty field is never saved,
    // hashed, returned or dispatched, and does not alter the retained intent.
    projected.patch=Object.keys(projectedFields).length?projectedFields:{gain:0};
   }
   if(!runtime?.validateClipIntent(op as 'timeline.clip.add'|'timeline.clip.update',projected))invalid();
   // Arrays are admitted only in the exact typed points leaf, never generally.
   const visit=(value:unknown,depth:number,budget:{nodes:number}):void=>{
    if(++budget.nodes>128||depth>8)invalid();
    if(value===null||typeof value==='boolean')return;
    if(typeof value==='string'){if(!/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value))invalid();return;}
    if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))invalid();return;}
    if(!object(value))invalid();
    for(const [key,child]of Object.entries(value)){
     if(value===fields.volumeEnvelope&&key==='points'&&Array.isArray(child)){
      if(++budget.nodes>128||depth+1>8)invalid();for(const point of child)visit(point,depth+2,budget);
     }else visit(child,depth+1,budget);
    }
   };visit(input,0,{nodes:0});
  };
  if(table==='edit_tasks')intent(root,operation);
  const pending:[unknown,unknown,unknown[]|undefined][]=[[root,owner,undefined]];
  while(pending.length){const [value,parentOwner,parentFrozen]=pending.pop()!;if(value===null||typeof value!=='object')continue;
   if(Array.isArray(value)){for(const child of value)pending.push([child,parentOwner,parentFrozen]);continue;}
   if(!object(value))continue;
   if(own(value,'projectId')&&parentOwner!=null&&value.projectId!==parentOwner)invalid();
   const project=parentOwner??value.projectId;
   const frozen=object(value.timeline)&&Array.isArray(value.assets)?value.assets:parentFrozen;
   if(object(value.timeline)&&hasTimelineVolumeEnvelopeEvidence(value.timeline)){
    if(value===root&&(loudness||wrapped)){ /* Exact complete ACK admitted above. */ }else{
     if(value.operation==='timeline.loudness.apply')invalid();
     if(!Array.isArray(value.assets)||!isVolumeEnvelopeProcessingSnapshot(value))invalid();
     if(own(value,'volumeEnvelopeProfile'))mark(value,'volumeEnvelopeProfile');
    }
   }
   if(Array.isArray(value.clips)&&Array.isArray(value.tracks)&&hasTimelineVolumeEnvelopeEvidence(value.clips)){
    if(value.clips.length>100||Buffer.byteLength(JSON.stringify(value))>SNAPSHOT_BYTES)invalid();
    for(const clip of value.clips){if(!object(clip))invalid();if(own(clip,'volumeEnvelope')){envelope(clip,false);source(clip,project,frozen);}}
   }
   if(own(value,'volumeEnvelopeProcessingProfile')){
    if(!historicalClipLoudness(value)&&!isTimelineMixLoudnessResponse(value))invalid();
    mark(value,'volumeEnvelopeProcessingProfile');if(object(value.identity)&&own(value.identity,'volumeEnvelopeSha256'))mark(value.identity,'volumeEnvelopeSha256');
   }
   for(const key of ['code','errorCode'])if(codeEvidence((value as Record<string,unknown>)[key])){if(!knownCodes.has((value as Record<string,unknown>)[key] as string))invalid();mark(value,key);}
   for(const child of Object.values(value))pending.push([child,project,frozen]);
  }
  walk(root,value=>{for(const key of keys)if(own(value,key)&&!admitted.get(value)?.has(key))invalid();
   if(value.profileId===VOLUME_ENVELOPE_PROFILE&&!admitted.get(value)?.has('profileId'))invalid();
  });
 }
 const keySql=keys.map(key=>`'${key}'`).join(',');
 const evidenceSql=`key IN (${keySql}) OR key='profileId' AND value='${VOLUME_ENVELOPE_PROFILE}' OR key IN ('code','errorCode') AND CAST(value AS TEXT) GLOB '*VOLUME_ENVELOPE*'`;
 for(const [table,fields]of families){
  if(!names.has(table))continue;
  const columns=new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row=>row.name));
  if(table==='edit_tasks'&&columns.has('errorCode'))for(const row of db.prepare("SELECT CASE WHEN typeof(errorCode)='text' AND length(CAST(errorCode AS BLOB))<=80 THEN errorCode END AS code FROM edit_tasks WHERE CAST(errorCode AS TEXT) GLOB '*VOLUME_ENVELOPE*'").iterate()){
   if(typeof row.code!=='string'||!knownCodes.has(row.code))invalid();
  }
  const owner=columns.has('projectId')?"CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END":'NULL';
  const operation=columns.has('operation')?"CASE WHEN typeof(operation)='text' AND length(CAST(operation AS BLOB))<=128 THEN operation END":'NULL';
  const request=columns.has('requestId')?"CASE WHEN typeof(requestId)='text' AND length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800 THEN requestId END":'NULL';
  for(const field of fields.filter(field=>columns.has(field))){const column=quote(field);
   const bounded=`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES}`;
   const query=`SELECT ${owner} AS owner,${operation} AS operation,${request} AS request,CASE WHEN ${bounded} THEN json_valid(${column}) ELSE 0 END AS valid,CASE WHEN ${bounded} THEN ${column} END AS value,CASE WHEN ${bounded} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicates,CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 0 WHEN typeof(${column})!='text' THEN 1 ELSE 0 END AS opaque FROM ${quote(table)} WHERE CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 1 WHEN typeof(${column})!='text' THEN 1 WHEN length(CAST(${column} AS BLOB))=0 THEN 0 WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE ${evidenceSql}) ELSE 1 END`;
   for(const row of db.prepare(query).iterate()){
    // Unrelated malformed JSON stays with its domain reader. Decode
    // member/string tokens, including escaped spellings, before JSON.parse can
    // erase duplicate evidence. Oversized/non-TEXT cells are never parsed.
    // Cold archives preserve opaque (non-TEXT) historical cells; such cells
    // cannot carry readable envelope evidence into any admission reader. Restore
    // classification paths keep the strict default and still fail closed.
    if(row.opaque===1){invalid();continue;}
    if(row.valid===0&&typeof row.value==='string'){
     let evidence=false;
     for(const match of row.value.matchAll(/"(?:[^"\\]|\\.)*"/g))try{const token=JSON.parse(match[0]);if(keys.includes(token)||token===VOLUME_ENVELOPE_PROFILE||codeEvidence(token))evidence=true;}catch{}
     if(!evidence)continue;
    }
    if(typeof row.value!=='string'||row.duplicates!==0)invalid();
    let value:unknown;try{value=JSON.parse(projectCell(row.value));}catch{invalid();}
    // Bound the entire retained shape before any semantic traversal.
    walk(value,()=>{});inspect(value,row.owner,table,row.operation,row.request,{owner:columns.has('projectId'),operation:columns.has('operation'),request:columns.has('requestId')});
   }
  }
 }
}

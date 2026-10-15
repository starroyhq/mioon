import {assertVolumeEnvelopeSource} from './timeline-volume-envelope-source.ts';
import {parseTimelineAudioPreviewProbe} from './timeline-audio-preview-decoder.ts';
import {readManagedTimelineImage,validateTimelineImageSourceInterpretation} from './timeline-image-source.ts';
import path from 'node:path';
import {AppError,isTimelineSubtitleSnapshotProfile,getTimelineSubtitleIssue,isTimelineExportSnapshot} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';
import {validateManagedSource,verifiedManagedHash,sameManagedFile} from './managed-media.mjs';
import {run,runStreaming,checkMediaEffect} from './media-runtime.mjs';
import {parseProbeOutput,withProbePermit} from './media-probe.mjs';
import {validateTimeline,freezeTimelineSnapshot} from './timeline-inputs.mjs';
import {isTimelineColourSnapshot} from '../../contracts/src/timeline-colour.ts';
import {validateTimelineColourSourceInterpretation} from './timeline-colour-source.ts';
import {createTimelineColourLutReader,verifyTimelineColourLuts} from './timeline-colour-lut.ts';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fault=(code,message)=>Object.assign(Error(message),{code});
const invalid=()=>fault('INVALID_TIMELINE_SNAPSHOT','Saved timeline data cannot be validated safely');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const bounded=(column,table)=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS[table]} THEN ${column} END`;
export function readOwnedTimelineAsset(db,projectId,id){
 if(!uuid(id))return null;
 try{return createOwnedMediaGraphReader(db,projectId).asset(id);}catch(error){if(error.code==='INSPECTION_BUDGET_EXCEEDED')throw error;return null;}
}
export function readTimelineSourceGraph(db,projectId,timeline){
 const graph=createOwnedMediaGraphReader(db,projectId),assets=new Map();
 for(const clip of timeline.clips){const asset=graph.clipSource(clip);assets.set(asset.id,asset);}
 return assets;
}

// Recovered exports have at most 100 clips, but are not subject to the
// preflight aggregate read budget. Validate every clip before file I/O using
// the exact same independently bounded graph (4 MiB/1024 records per lineage).
// Readers are discarded between clips, preserving the resident metadata bound.
export function validateFrozenTimelineSourceGraph(db,projectId,timeline){
 const seen=new Set();
 for(const clip of timeline.clips){
  const fields=['versionId','shotId','jobId'];
  if(fields.some(key=>Object.hasOwn(clip,key)&&!uuid(clip[key])))throw invalid();
  const key=JSON.stringify([clip.assetId,...fields.map(field=>[Object.hasOwn(clip,field),clip[field]])]);
  if(seen.has(key))continue;
  createOwnedMediaGraphReader(db,projectId).clipSource(clip);seen.add(key);
 }
}

// A custom profile adds a capability await after media preparation. Recheck
// the same bounded owned graph and immutable source identity before consuming
// cached paths and again at publication. Metadata discovered by ffprobe (size,
// duration, dimensions and audio flags) is deliberately not an identity fence.
// Legacy/custom delivery retains its original DB-only behavior. Managed colour
// additionally pins the SHA-verified file identity (including size/mtime/ctime)
// across capability/encode/publication awaits. This is not an OS parser sandbox
// or a guarantee against a privileged same-user/root pathname race.
export function validatePreparedTimelineSources(db,projectId,snapshot,prepared,{root}={}){
 try{
  if(snapshot?.timeline?.projectId!==projectId||!Array.isArray(snapshot.timeline.clips)||snapshot.timeline.clips.length>100||!Array.isArray(snapshot.assets)||snapshot.assets.length>100||!(prepared instanceof Map)||typeof root!=='string')throw invalid();
  validateFrozenTimelineSourceGraph(db,projectId,snapshot.timeline);
  if(prepared.size!==snapshot.assets.length)throw invalid();
  for(const frozen of snapshot.assets){
   const current=readOwnedTimelineAsset(db,projectId,frozen.id),verified=prepared.get(frozen.id);
   if(!current||!verified||current.id!==frozen.id||current.projectId!==projectId||verified.id!==frozen.id||
    ['sha256','mimeType','relativePath'].some(key=>typeof frozen[key]!=='string'||current[key]!==frozen[key]||verified[key]!==frozen[key])||
    verified.path!==path.resolve(root,current.relativePath))throw invalid();
   if(snapshot.colourPlan&&(!verified.colourSourceIdentity||!sameManagedFile(verified.colourSourceIdentity,validateManagedSource(root,current).info)))throw invalid();
  }
  if(snapshot.colourPlan){
   if(!isTimelineColourSnapshot(snapshot))throw invalid();
   verifyTimelineColourLuts(snapshot.colourPlan,createTimelineColourLutReader(db,projectId),false);
  }
 }catch{throw fault('TIMELINE_SOURCE_UNAVAILABLE','A frozen timeline source is no longer available in this project.');}
}

// The transaction contains bounded synchronous reads only. No timeline.ensure,
// writes, write locks, asynchronous work, or unbounded JSON enters this path.
export function readTimelinePreflightSnapshot(store,projectId,exportSettings,deliveryInput={}){
 const {db}=store,outer=db.isTransaction;
 if(!outer)db.exec('BEGIN DEFERRED');
 try{
  const projectRow=db.prepare(`SELECT ${bounded('data','projects')} AS data FROM projects WHERE id=?`).get(projectId);
  const project=parse(projectRow?.data);
  if(!object(project)||project.id!==projectId)throw new AppError('NOT_FOUND','找不到记录',404);
  const row=db.prepare(`SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=36 THEN id END AS id,${bounded('data','timelines')} AS data FROM timelines WHERE projectId=? LIMIT 1`).get(projectId);
  if(!row)return {timeline:null,snapshot:null};
  const timeline=parse(row.data);
  if(!object(timeline)||!uuid(row.id)||timeline.id!==row.id||timeline.projectId!==projectId||
   !Number.isSafeInteger(timeline.revision)||timeline.revision<1||!Array.isArray(timeline.clips)||timeline.clips.length>100||
   !Array.isArray(timeline.tracks)||timeline.tracks.length>12||timeline.clips.some(c=>!object(c)||!uuid(c.id)||!uuid(c.assetId)||!uuid(c.trackId))||
   timeline.tracks.some(t=>!object(t)||!uuid(t.id)))throw invalid();
  if(Object.hasOwn(timeline,'subtitles')&&getTimelineSubtitleIssue(timeline.subtitles,timeline.durationFrames))throw invalid();
  let assets;
  try{assets=readTimelineSourceGraph(db,projectId,timeline);}
  catch(error){if(error.code==='INSPECTION_BUDGET_EXCEEDED')throw error;throw fault('TIMELINE_SOURCE_UNAVAILABLE','A referenced source is unavailable in this project');}
  return {timeline,snapshot:freezeTimelineSnapshot(timeline,assets,exportSettings,deliveryInput)};
 }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
}

// Both worker and preflight use one restricted local-only metadata probe. The
// allowlist includes all supported still/audio/video containers, not playlists.
export async function probeTimelineSource(file,{signal,timeout,beforeSpawn,beforeEffect,verifiedJfif=false}={}){
 return withProbePermit(signal,async()=>{
  const output=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe',
   // Only a hash-owned, structurally admitted and decoded JFIF receives this
   // closed demuxer choice. Never admit image2 or its filename patterns globally.
   ...(verifiedJfif===true?['-format_whitelist','jpeg_pipe','-f','jpeg_pipe']:
    ['-format_whitelist','mov,matroska,mp3,wav,png_pipe,jpeg_pipe,webp_pipe']),
   '-show_format','-show_streams','-of','json',file],{signal,timeout,beforeSpawn,beforeEffect});
  checkMediaEffect(beforeEffect,signal);return parseProbeOutput(output);
 });
}

// These are preparation budgets, never export limits. The render worker omits
// budget entirely and re-verifies source ownership, bytes and metadata itself.
export async function prepareTimelineInputs(snapshot,{root,projectId,readAsset,signal,budget,probe=probeTimelineSource,onChecked,validateLinks,beforeEffect,readLut}={}){
 checkMediaEffect(beforeEffect,signal);
 if(!snapshot?.timeline||!Array.isArray(snapshot.assets))throw Error('Timeline render has no frozen snapshot');
 if(snapshot.timeline.projectId!==projectId||!isTimelineSubtitleSnapshotProfile(snapshot)||!isTimelineExportSnapshot(snapshot)||!isTimelineColourSnapshot(snapshot))throw invalid();
 if(snapshot.assets.length>100||snapshot.assets.some(a=>!object(a)||!uuid(a.id)||typeof a.mimeType!=='string'||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256))||new Set(snapshot.assets.map(a=>a.id)).size!==snapshot.assets.length)throw invalid();
 validateTimeline(snapshot.timeline,new Map(snapshot.assets.map(a=>[a.id,a])),{structureOnly:true});
 const referenced=new Set(snapshot.timeline.clips.map(clip=>clip.assetId));
 if(referenced.size!==snapshot.assets.length||snapshot.assets.some(asset=>!referenced.has(asset.id)))throw invalid();
 validateLinks?.(snapshot.timeline);
 if(snapshot.colourPlan)verifyTimelineColourLuts(snapshot.colourPlan,readLut,true);
 const assets=new Map();
 for(const frozen of snapshot.assets){
  checkMediaEffect(beforeEffect,signal);
  const a=readAsset(frozen.id);
  if(!a||a.projectId!==projectId||a.sha256!==frozen.sha256||a.mimeType!==frozen.mimeType||assets.has(a.id))throw fault('TIMELINE_SOURCE_UNAVAILABLE','Timeline snapshot does not match managed asset');
  try{
  if(frozen.relativePath!==undefined&&frozen.relativePath!==a.relativePath)throw fault('TIMELINE_SOURCE_UNAVAILABLE','Timeline snapshot path no longer matches managed asset');
  const maxBytes=budget?.sourceBytes??Infinity;
  checkMediaEffect(beforeEffect,signal);const source=validateManagedSource(root,a,{maxBytes});
  if(budget&&source.info.size>budget.totalBytes-budget.bytesHashed)throw fault('PREFLIGHT_BUDGET','Preflight byte budget was reached');
  let hashed,hashEffectFailure;
  try{
   checkMediaEffect(beforeEffect,signal);
   hashed=await verifiedManagedHash(root,a,{signal,maxBytes,expected:source.info,onBytes:bytes=>{
    // The shared hash helper sanitizes arbitrary callback failures. Retain the
    // backend fence's exact rejection until that helper closes its descriptor.
    try{checkMediaEffect(beforeEffect,signal);}catch(error){hashEffectFailure=error;throw error;}
    if(budget){if(bytes>budget.totalBytes-budget.bytesHashed)throw fault('PREFLIGHT_BUDGET','Preflight byte budget was reached');budget.bytesHashed+=bytes;}
   }});
  }catch(error){throw hashEffectFailure??error;}
  checkMediaEffect(beforeEffect,signal);
  const checkSource=()=>{checkMediaEffect(beforeEffect,signal);const latest=readAsset(frozen.id);if(!latest||latest.projectId!==projectId||latest.sha256!==a.sha256||latest.mimeType!==a.mimeType||latest.relativePath!==a.relativePath||!sameManagedFile(hashed.info,validateManagedSource(root,a,{maxBytes}).info))throw fault('MANAGED_SOURCE_CHANGED','Timeline input bytes differ from frozen asset hash');};
  checkSource();
  const imageColour=snapshot.colourPlan?.clips.some(item=>item.assetId===a.id&&item.kind==='image')?await readManagedTimelineImage(root,a,{signal,beforeEffect:checkSource,expected:hashed.info},{validateSource:validateManagedSource,runStreaming}):null;
  checkSource();
  const media=await probe(hashed.file,{signal,beforeSpawn:checkSource,beforeEffect,...(imageColour?.evidence.profileId==='jfif-ycbcr8-srgb-v1'?{verifiedJfif:true}:{})});checkMediaEffect(beforeEffect,signal);checkSource();
  const automated=snapshot.timeline.clips.filter(clip=>clip.assetId===a.id&&clip.volumeEnvelope!=null);
  if(automated.length){
   // The actual probe is bracketed by managed hash/identity checks. Include
   // muted/zero-gain automation; cached hasAudio is not stream evidence.
   const audio=parseTimelineAudioPreviewProbe(JSON.stringify(media.probe));
   for(const clip of automated)assertVolumeEnvelopeSource(clip,{mimeType:a.mimeType,audio});
  }
  if(snapshot.colourPlan)for(const planned of snapshot.colourPlan.clips.filter(item=>item.assetId===a.id)){
   const clip=snapshot.timeline.clips.find(item=>item.id===planned.clipId);
   if(planned.kind==='image')validateTimelineImageSourceInterpretation({source:clip?.colour?.source,evidence:imageColour?.evidence,probe:media.probe,assetSha256:hashed.sha256,streamIndex:media.videoStreamIndex});
   else validateTimelineColourSourceInterpretation({source:clip?.colour?.source,probe:media.probe,assetSha256:hashed.sha256,streamIndex:media.videoStreamIndex});
  }
  assets.set(a.id,{...frozen,sizeBytes:hashed.sizeBytes,sha256:hashed.sha256,width:media.width,height:media.height,duration:media.duration,
   hasVideo:media.hasVideo,hasAudio:media.hasAudio,videoStreamIndex:media.videoStreamIndex,audioStreamIndex:media.audioStreamIndex,path:hashed.file,...(snapshot.colourPlan?{colourProbe:media.probe,colourSourceIdentity:hashed.info,...(imageColour?{colourImageEvidence:imageColour.evidence}:{})}:{})});
  onChecked?.(a.id);
  }catch(error){if(error&&typeof error==='object'){error.timelineAssetId=a.id;if(error.code==='MANAGED_SOURCE_CHANGED')error.message='Export input bytes differ from frozen version hash';}throw error;}
 }
 checkMediaEffect(beforeEffect,signal);validateTimeline(snapshot.timeline,assets);
 if(snapshot.colourPlan){
  for(const verified of assets.values()){
   checkMediaEffect(beforeEffect,signal);const current=readAsset(verified.id);
   if(!current||current.sha256!==verified.sha256||current.mimeType!==verified.mimeType||current.relativePath!==verified.relativePath||!sameManagedFile(verified.colourSourceIdentity,validateManagedSource(root,current).info))throw fault('MANAGED_SOURCE_CHANGED','A colour-managed source changed during preparation.');
  }
  verifyTimelineColourLuts(snapshot.colourPlan,readLut,true);
 }
 return assets;
}

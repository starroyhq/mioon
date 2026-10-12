import {createHash} from 'node:crypto';
import {AppError,parse,WAVEFORM_ALGORITHM,WAVEFORM_BINS_PER_SECOND,sourceFrameCount} from '@mioon/contracts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';

export const WAVEFORM_CACHE_LIMITS=Object.freeze({entries:64,bytes:16*1024*1024,recordBytes:384*1024,
 active:1,queued:4,sourceBytes:512*1024*1024,attemptMs:180000,bins:60000,sampleFrames:600*48000});
const terminal=new Set(['ready','interrupted','error','unsupported']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,sha=/^[0-9a-f]{64}$/;
export const waveformMessages=Object.freeze({
 CACHE_CORRUPT:'The saved waveform is invalid. Request an explicit retry to rebuild it.',
 WAVEFORM_OWNER_REQUIRED:'Waveform preparation requires the exclusive backend owner. Use the running backend or restart after its owner stops.',
 WAVEFORM_BUSY:'The local waveform queue is full. Try the request again later.',
 WAVEFORM_CAPACITY:'The local waveform cache cannot admit another operation safely. Review its disposable cache before retrying.',
 WAVEFORM_CACHE_UNAVAILABLE:'The waveform cache is outside safe limits. Stop the backend and clear only its disposable waveform cache before retrying.',
 WAVEFORM_INTERRUPTED:'Waveform preparation was interrupted. Request an explicit retry to restart it.',
 WAVEFORM_TIMEOUT:'Waveform preparation exceeded its time limit.',
 WAVEFORM_SOURCE_INVALID:'The managed source cannot be verified safely.',
 WAVEFORM_SOURCE_CHANGED:'The managed source changed during waveform preparation.',
 WAVEFORM_SOURCE_TOO_LARGE:'Waveforms support source files up to 512 MiB.',
 WAVEFORM_NO_AUDIO:'The source has no supported audio stream.',
 WAVEFORM_CHANNELS_UNSUPPORTED:'Waveforms support mono and stereo audio only.',
 WAVEFORM_DURATION_UNSUPPORTED:'Waveforms require a known audio duration of at most 600 seconds.',
 WAVEFORM_TIMING_UNSUPPORTED:'This audio stream cannot be aligned safely to source time.',
 WAVEFORM_DECODE_FAILED:'The local audio decoder could not prepare a valid waveform.',
});
export const waveformReason=code=>({code,message:messages[code]});
export const waveformFault=(code,status='error')=>Object.assign(new Error(messages[code]),{waveformCode:code,waveformStatus:status});
const missing=()=>{throw new AppError('NOT_FOUND','找不到记录',404);};
const mediaTypes=new Set(['video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']);
export const isWaveformMediaType=value=>mediaTypes.has(value);
export const waveformSourceMetadata=asset=>({mimeType:asset.mimeType,hasAudio:asset.hasAudio??null,sizeBytes:asset.sizeBytes??null});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const waveformDigest=peaks=>{
 const bytes=Buffer.allocUnsafe(peaks.length*2);
 for(let i=0;i<peaks.length;i++)bytes.writeUInt16LE(peaks[i],i*2);
 return createHash('sha256').update(bytes).digest('hex');
};
const keyFor=(projectId,sourceSha256)=>createHash('sha256').update(JSON.stringify([projectId,sourceSha256,WAVEFORM_ALGORITHM])).digest('hex');
export const waveformRowBytes=row=>Buffer.byteLength(JSON.stringify({cacheKey:row.cacheKey,projectId:row.projectId,
 sourceSha256:row.sourceSha256,algorithm:row.algorithm,status:row.status,attemptId:row.attemptId,data:row.data}));

const messages=waveformMessages,reason=waveformReason,sourceMetadata=waveformSourceMetadata,digest=waveformDigest,rowBytes=waveformRowBytes;

/** Saved waveform metadata/peaks only. No runtime owner, reconciliation, cache
 * admission/eviction, probe, decode, file access, queue or polling is created.
 * The normal waveform service reuses these exact readers and validators. */
export function createWaveformHistoryReaders({db}){
 const cacheBounded=()=>db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM waveform_cache LIMIT 65)').get().n<=WAVEFORM_CACHE_LIMITS.entries;
 function owned(input){
  // Bind both relational owners before parsing JSON, inspecting cache state or
  // touching the filesystem. Oversized/foreign JSON never enters JS memory.
  const row=db.prepare(`SELECT a.id,a.projectId,p.id AS foundProjectId,
   CASE WHEN length(CAST(a.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.assets} THEN a.data END AS assetData,
   CASE WHEN length(CAST(p.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.projects} THEN p.data END AS projectData
   FROM assets a LEFT JOIN projects p ON p.id=? WHERE a.id=? AND a.projectId=?`).get(input.projectId,input.assetId,input.projectId);
  if(!row||row.id!==input.assetId||row.projectId!==input.projectId||row.foundProjectId!==input.projectId)missing();
  let asset,project;try{asset=JSON.parse(row.assetData);project=JSON.parse(row.projectData);}catch{missing();}
  if(!object(asset)||!object(project)||project.id!==input.projectId||asset.id!==input.assetId||asset.projectId!==input.projectId)missing();
  return asset;
 }
 function sourceKey(asset){return typeof asset.sha256==='string'&&sha.test(asset.sha256)?keyFor(asset.projectId,asset.sha256):null;}
 function load(cacheKey){
  return db.prepare(`SELECT position,
   CASE WHEN length(CAST(cacheKey AS BLOB))=64 THEN cacheKey END AS cacheKey,
   CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
   CASE WHEN length(CAST(sourceSha256 AS BLOB))=64 THEN sourceSha256 END AS sourceSha256,
   CASE WHEN length(CAST(algorithm AS BLOB)) BETWEEN 1 AND 100 THEN algorithm END AS algorithm,
   CASE WHEN length(CAST(status AS BLOB)) BETWEEN 1 AND 16 THEN status END AS status,
   CASE WHEN length(CAST(attemptId AS BLOB))=36 THEN attemptId END AS attemptId,bytes,reservedBytes,
   CASE WHEN length(CAST(data AS BLOB)) BETWEEN 2 AND ${WAVEFORM_CACHE_LIMITS.recordBytes} THEN data END AS data
   FROM waveform_cache WHERE cacheKey=?`).get(cacheKey);
 }
 function valid(row,asset){
  if(!row||row.cacheKey!==sourceKey(asset)||row.projectId!==asset.projectId||row.sourceSha256!==asset.sha256||
   row.algorithm!==WAVEFORM_ALGORITHM||!uuid.test(row.attemptId)||!['queued','running',...terminal].includes(row.status)||
   !Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>WAVEFORM_CACHE_LIMITS.recordBytes||
   !Number.isSafeInteger(row.reservedBytes)||row.reservedBytes<0||row.reservedBytes>WAVEFORM_CACHE_LIMITS.recordBytes||typeof row.data!=='string')return null;
  let data;try{data=JSON.parse(row.data);}catch{return null;}
  if(!object(data)||rowBytes({...row,data})!==row.bytes)return null;
  const keys=Object.keys(data);
  if(row.status==='ready'){
   if(keys.length!==8||!['duration','sourceFrames','sampleFrames','peaks','peakDigest','clipped','channels','source'].every(key=>Object.hasOwn(data,key))||
    !Number.isFinite(data.duration)||data.duration<=0||data.duration>600||data.duration!==asset.duration||data.sourceFrames!==sourceFrameCount(asset.duration)||
    !isWaveformMediaType(asset.mimeType)||asset.hasAudio===false||JSON.stringify(data.source)!==JSON.stringify(sourceMetadata(asset))||
    !Number.isSafeInteger(data.sampleFrames)||data.sampleFrames<1||data.sampleFrames>WAVEFORM_CACHE_LIMITS.sampleFrames||
    Math.abs(data.duration-data.sampleFrames/48000)>.1+1e-6||![1,2].includes(data.channels)||typeof data.clipped!=='boolean'||
    !Array.isArray(data.peaks)||data.peaks.length!==Math.ceil(data.sampleFrames/480)||data.peaks.length>WAVEFORM_CACHE_LIMITS.bins||
    data.peaks.some(value=>!Number.isInteger(value)||value<0||value>65535)||
    typeof data.peakDigest!=='string'||!sha.test(data.peakDigest)||digest(data.peaks)!==data.peakDigest||row.reservedBytes!==0)return null;
  }else if(['queued','running'].includes(row.status)){
   if(keys.length||row.reservedBytes!==WAVEFORM_CACHE_LIMITS.recordBytes)return null;
  }else if(keys.length!==1||!object(data.reason)||Object.keys(data.reason).length!==2||
   !Object.hasOwn(messages,data.reason.code)||data.reason.message!==messages[data.reason.code]||row.reservedBytes!==0)return null;
  return data;
 }
 function response(input,status,data={},attemptId){
  const out={projectId:input.projectId,assetId:input.assetId,algorithm:WAVEFORM_ALGORITHM,status,binsPerSecond:WAVEFORM_BINS_PER_SECOND};
  if(attemptId&&uuid.test(attemptId))out.attemptId=attemptId;
  if(data.reason)out.reason=data.reason;
  if(status==='ready')Object.assign(out,{duration:data.duration,sourceFrames:data.sourceFrames,decodedSampleFrames:data.sampleFrames,clipped:data.clipped});
  return out;
 }
 function state(input,asset,row){
  if(!cacheBounded())return response(input,'error',{reason:reason('WAVEFORM_CACHE_UNAVAILABLE')});
  if(!sourceKey(asset))return response(input,'error',{reason:reason('WAVEFORM_SOURCE_INVALID')});
  if(!row)return response(input,'missing');
  const data=valid(row,asset);
  return data?response(input,row.status,data,row.attemptId):response(input,'error',{reason:reason('CACHE_CORRUPT')});
 }
 function get(input){
  const asset=owned(input),cacheKey=sourceKey(asset),row=cacheKey?load(cacheKey):null,out=state(input,asset,row);
  if(out.status!=='ready')return out;
  const data=valid(row,asset),start=input.sourceStartFrame??0,end=input.sourceEndFrame??data.sourceFrames,points=input.points??512;
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(end)||end<=start||end>data.sourceFrames||!Number.isSafeInteger(points)||points<1||points>2048)
   throw new AppError('SOURCE_BOUNDS','Waveform range is outside the decoded source bounds',400,{availableFrames:data.sourceFrames});
  // Retain the 100 Hz source clock. Partition only the requested bins and take
  // absolute maxima; never stretch a whole-source waveform over a trimmed clip.
  const first=Math.floor(start*100/30),last=Math.ceil(end*100/30);
  const count=Math.min(points,last-first),peaks=[];
  for(let i=0;i<count;i++){
   const groupStart=start*1600+(end-start)*1600*i/count,groupEnd=start*1600+(end-start)*1600*(i+1)/count;
   // Coverage is checked at the exact requested source time, not just the
   // rounded 100 Hz bucket: a final partial bucket must not fill a later gap.
   if(groupStart>=data.sampleFrames){peaks.push(null);continue;}
   const from=Math.floor(groupStart/480),to=Math.ceil(Math.min(groupEnd,data.sampleFrames)/480);let peak=0;
   for(let j=from;j<to;j++)peak=Math.max(peak,data.peaks[j]);
   peaks.push(peak/65535);
  }
  return {...out,sourceStartFrame:start,sourceEndFrame:end,peaks};
 }
 const handlers=Object.freeze({'asset.waveform.get':input=>get(parse('asset.waveform.get',input))});
 return Object.freeze({handlers,cacheBounded,owned,sourceKey,load,valid,response,state});
}

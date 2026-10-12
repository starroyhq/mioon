import {getWorkspaceRestoreContext} from './workspace-restore-schema.mjs';
import {workspaceRestoreError} from './workspace-restore-policy.mjs';
import {randomUUID} from 'node:crypto';
import {AppError,WAVEFORM_ALGORITHM,sourceFrameCount} from '@mioon/contracts';
import {validateManagedSource,verifiedManagedHash,sameManagedFile as sameFile} from './managed-media.mjs';
import {run} from './media-runtime.mjs';
import {parseProbeOutput,withProbePermit} from './media-probe.mjs';
import {decodeWaveform} from './waveform-decoder.mjs';
import {boundedShutdown} from './operation-lifecycle.mjs';
import {ownsStoreLock} from './db.mjs';
import {createWaveformHistoryReaders,WAVEFORM_CACHE_LIMITS,waveformMessages as messages,waveformReason as reason,waveformFault as fault,isWaveformMediaType,waveformSourceMetadata as sourceMetadata,waveformDigest as digest,waveformRowBytes as rowBytes} from './waveforms-history.mjs';

export {WAVEFORM_ALGORITHM};
export {WAVEFORM_CACHE_LIMITS};
const owners=new WeakMap(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const checkSignal=signal=>{if(signal?.aborted)throw fault('WAVEFORM_INTERRUPTED','interrupted');};

export async function probeWaveform(file,{signal,beforeSpawn}={}){
 return withProbePermit(signal,async()=>{
  checkSignal(signal);beforeSpawn?.();
  const output=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe',
   '-format_whitelist','mov,matroska,mp3,wav','-show_format','-show_streams','-of','json',file],{signal});
  checkSignal(signal);return parseProbeOutput(output);
 });
}

/** Only this service owns its asynchronous work. drain() aborts, fences and joins
 * every attempt before the caller may close SQLite. No startup decode occurs.
 * Filesystem protection is against other OS users. Same-UID/root mutation can
 * still race FFmpeg's pathname-only open; this is not a hostile-decoder sandbox.
 */
export function createWaveformServices(store,{signal:ownerSignal,decode=decodeWaveform,probe=probeWaveform}={}){
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const existingOwner=owners.get(store.db);
 if(existingOwner){
  if(existingOwner.signal===ownerSignal&&existingOwner.decode===decode&&existingOwner.probe===probe&&existingOwner.root===store.root)return existingOwner.service;
  throw new AppError('WAVEFORM_SERVICE_ACTIVE','This store already owns a waveform service with a different lifecycle',409);
 }
 const {db,root,tx}=store,queue=[],inflight=new Map(),tasks=new Set();
 let active=null,stopped=false,shutdownFailure,draining;
 const history=createWaveformHistoryReaders(store),{cacheBounded,owned,sourceKey,load,response,state}=history;
 function safeBudgetRows(){
  return !db.prepare(`SELECT 1 AS invalid FROM waveform_cache WHERE
   typeof(cacheKey)!='text' OR length(CAST(cacheKey AS BLOB))!=64 OR
   typeof(projectId)!='text' OR length(CAST(projectId AS BLOB))!=36 OR
   typeof(sourceSha256)!='text' OR length(CAST(sourceSha256 AS BLOB))!=64 OR
   typeof(algorithm)!='text' OR length(CAST(algorithm AS BLOB)) NOT BETWEEN 1 AND 100 OR
   typeof(attemptId)!='text' OR length(CAST(attemptId AS BLOB))!=36 OR
   typeof(status)!='text' OR status NOT IN ('queued','running','ready','interrupted','error','unsupported') OR
   typeof(data)!='text' OR length(CAST(data AS BLOB)) NOT BETWEEN 2 AND 393216 OR
   typeof(bytes)!='integer' OR bytes NOT BETWEEN 1 AND 393216 OR
   typeof(reservedBytes)!='integer' OR reservedBytes NOT BETWEEN 0 AND 393216 LIMIT 1`).get();
 }
 const ownToken={signal:ownerSignal,decode,probe,root};owners.set(db,ownToken);
 const requireOwner=()=>{if(!ownsStoreLock(store))throw fault('WAVEFORM_OWNER_REQUIRED');};

 function save(row,status,data,reservedBytes=0){
  if(!ownsStoreLock(store))return false;
  const next={...row,status,data},bytes=rowBytes(next);
  if(bytes>WAVEFORM_CACHE_LIMITS.recordBytes)throw fault('WAVEFORM_CAPACITY');
  return db.prepare(`UPDATE waveform_cache SET status=?,data=?,bytes=?,reservedBytes=?
   WHERE cacheKey=? AND projectId=? AND attemptId=? AND status IN ('queued','running')`)
   .run(status,JSON.stringify(data),bytes,reservedBytes,row.cacheKey,row.projectId,row.attemptId).changes===1;
 }
 // Only unfinished disposable records change at startup. Retain attempt IDs so
 // stale callbacks cannot overwrite a later, explicitly requested attempt.
 try{
  const unfinished=()=>Boolean(db.prepare("SELECT 1 FROM waveform_cache WHERE status IN ('queued','running') LIMIT 1").get());
  // Empty/ready-only construction is genuinely read-only and never consumes a
  // caller's first business transaction. Shared/read-only handles never repair.
  if(ownsStoreLock(store)&&cacheBounded()&&unfinished())tx(()=>{
   if(!ownsStoreLock(store)||!cacheBounded()||!unfinished())return;
   for(const {cacheKey} of db.prepare("SELECT cacheKey FROM waveform_cache WHERE status IN ('queued','running') AND length(CAST(cacheKey AS BLOB))=64 LIMIT 64").all()){
    const row=load(cacheKey);if(!row.projectId||!row.sourceSha256||!row.algorithm||!uuid.test(row.attemptId))continue;
    save(row,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});
   }
  });
 }catch(error){owners.delete(db);throw error;}

 function sourceFailure(error,signal){
  checkSignal(signal);
  if(error.code==='MANAGED_SOURCE_LIMIT')throw fault('WAVEFORM_SOURCE_TOO_LARGE','unsupported');
  throw fault(error.code==='MANAGED_SOURCE_CHANGED'?'WAVEFORM_SOURCE_CHANGED':'WAVEFORM_SOURCE_INVALID');
 }
 function validatedSource(asset){
  try{return validateManagedSource(root,asset,{maxBytes:WAVEFORM_CACHE_LIMITS.sourceBytes});}
  catch(error){sourceFailure(error);}
 }
 async function verifiedHash(asset,signal,expected){
  try{return await verifiedManagedHash(root,asset,{signal,expected,maxBytes:WAVEFORM_CACHE_LIMITS.sourceBytes});}
  catch(error){sourceFailure(error,signal);}
 }
 function currentSource(entry){
  requireOwner();
  const latest=owned(entry.input);
  if(latest.sha256!==entry.asset.sha256||latest.relativePath!==entry.asset.relativePath||latest.duration!==entry.asset.duration||latest.mimeType!==entry.asset.mimeType||
   latest.hasAudio!==entry.asset.hasAudio||latest.sizeBytes!==entry.asset.sizeBytes)throw fault('WAVEFORM_SOURCE_CHANGED');
  return latest;
 }
 function audioPlan(info){
  const stream=info?.probe?.streams?.find(value=>value?.codec_type==='audio');
  if(!stream)throw fault('WAVEFORM_NO_AUDIO','unsupported');
  if(![1,2].includes(stream.channels))throw fault('WAVEFORM_CHANNELS_UNSUPPORTED','unsupported');
  const container=info.duration;
  let duration=Number(stream.duration);
  if(!(Number.isFinite(duration)&&duration>0)){
   const match=typeof stream.time_base==='string'&&/^(\d+)\/(\d+)$/.exec(stream.time_base);
   const calculated=match&&Number(stream.duration_ts)*Number(match[1])/Number(match[2]);
   duration=Number.isFinite(calculated)&&calculated>0?calculated:container;
  }
  if(!Number.isFinite(container)||container<=0||container>600||!Number.isFinite(duration)||duration<=0||duration>600||sourceFrameCount(duration)===null)throw fault('WAVEFORM_DURATION_UNSUPPORTED','unsupported');
  const start=value=>value===undefined||value===null||value===''||value==='N/A'?null:Number(value);
  let audioStart=start(stream.start_time),formatStart=start(info.probe.format?.start_time);
  // Untimed WAV has a known sample-zero origin; other missing/unknown origins
  // are unsupported instead of silently shifting the displayed waveform.
  if(audioStart===null&&formatStart===null&&info.probe.format?.format_name==='wav')audioStart=formatStart=0;
  if(audioStart===null||formatStart===null||audioStart<0||formatStart<0)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
  const offset=audioStart-formatStart;
  if(!Number.isFinite(offset)||Math.abs(offset)>1/48000||Math.abs(duration-container)>.1+1e-6)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
  return {duration,channels:stream.channels};
 }
 async function runAttempt(entry){
  const controller=entry.controller,timer=setTimeout(()=>{entry.timedOut=true;controller.abort();},WAVEFORM_CACHE_LIMITS.attemptMs);
  try{
   checkSignal(controller.signal);currentSource(entry);
   if(!isWaveformMediaType(entry.asset.mimeType)||entry.asset.hasAudio===false)throw fault('WAVEFORM_NO_AUDIO','unsupported');
   const before=await verifiedHash(entry.asset,controller.signal);currentSource(entry);
   if(entry.asset.sizeBytes!==undefined&&entry.asset.sizeBytes!==before.info.size)throw fault('WAVEFORM_SOURCE_CHANGED');
   const metadata=await probe(before.file,{signal:controller.signal,beforeSpawn:requireOwner});checkSignal(controller.signal);
   const plan=audioPlan(metadata);
   if(!Number.isFinite(entry.asset.duration)||entry.asset.duration<=0||entry.asset.duration>600||
    sourceFrameCount(entry.asset.duration)===null)throw fault('WAVEFORM_DURATION_UNSUPPORTED','unsupported');
   if(Math.abs(metadata.duration-entry.asset.duration)>.1+1e-6)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
   if(!sameFile(before.info,validatedSource(entry.asset).info))throw fault('WAVEFORM_SOURCE_CHANGED');
   currentSource(entry);
   const decoded=await decode(before.file,{signal:controller.signal,...plan});checkSignal(controller.signal);requireOwner();
   if(!(decoded?.peaks instanceof Uint16Array)||typeof decoded.clipped!=='boolean'||
    !Number.isSafeInteger(decoded.sampleFrames)||decoded.sampleFrames<1||decoded.sampleFrames>WAVEFORM_CACHE_LIMITS.sampleFrames||
    decoded.peaks.length!==Math.ceil(decoded.sampleFrames/480)||decoded.peaks.length>WAVEFORM_CACHE_LIMITS.bins||
    Math.abs(decoded.sampleFrames/48000-plan.duration)>.1+1e-6)throw fault('WAVEFORM_DECODE_FAILED');
   const duration=entry.asset.duration,sourceFrames=sourceFrameCount(duration);
   if(Math.abs(duration-decoded.sampleFrames/48000)>.1+1e-6)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
   if(sourceFrames===null)throw fault('WAVEFORM_DURATION_UNSUPPORTED','unsupported');
   const after=await verifiedHash(entry.asset,controller.signal,before.info);checkSignal(controller.signal);requireOwner();
   const data={duration,sourceFrames,sampleFrames:decoded.sampleFrames,channels:plan.channels,source:sourceMetadata(entry.asset),
    peaks:Array.from(decoded.peaks),peakDigest:digest(decoded.peaks),clipped:decoded.clipped};
   tx(()=>{
    checkSignal(controller.signal);if(stopped)throw fault('WAVEFORM_INTERRUPTED','interrupted');
    currentSource(entry);
    if(!sameFile(after.info,validatedSource(entry.asset).info))throw fault('WAVEFORM_SOURCE_CHANGED');
    if(!save(entry.row,'ready',data))throw fault('WAVEFORM_INTERRUPTED','interrupted');
    // A database trigger cannot reassign the asset as a side effect of a cache
    // publication and still commit a ready result under the original owner.
    currentSource(entry);
   });
  }catch(error){
   if(error.terminationUnconfirmed)shutdownFailure=error;
   const status=entry.timedOut?'error':stopped||controller.signal.aborted?'interrupted':error.waveformStatus||'error';
   const code=entry.timedOut?'WAVEFORM_TIMEOUT':status==='interrupted'?'WAVEFORM_INTERRUPTED':
    error.waveformCode||(['WAVEFORM_DURATION_MISMATCH'].includes(error.code)?'WAVEFORM_TIMING_UNSUPPORTED':'WAVEFORM_DECODE_FAILED');
   try{save(entry.row,error.code==='WAVEFORM_DURATION_MISMATCH'?'unsupported':status,{reason:reason(code)});}catch(failure){shutdownFailure??=failure;}
  }finally{clearTimeout(timer);}
 }
 function pump(){
  if(stopped||active||!queue.length)return;
  if(!ownsStoreLock(store)){stop();return;}
  const entry=queue.shift();active=entry;
  if(!save(entry.row,'running',{},WAVEFORM_CACHE_LIMITS.recordBytes)){
   inflight.delete(entry.row.cacheKey);active=null;queueMicrotask(pump);return;
  }
  const task=Promise.resolve().then(()=>runAttempt(entry)).finally(()=>{
   tasks.delete(task);inflight.delete(entry.row.cacheKey);if(active===entry)active=null;pump();
  });
  tasks.add(task);
  // The owned task is always observed, even if an unexpected SQLite failure
  // reaches pump/finally. drain reports the failure rather than closing early.
  task.catch(error=>{shutdownFailure??=error;});
 }
 function admit(asset,input,cacheKey){
  requireOwner();
  const row={cacheKey,projectId:asset.projectId,sourceSha256:asset.sha256,algorithm:WAVEFORM_ALGORITHM,
   status:'queued',attemptId:randomUUID(),data:{}},bytes=rowBytes(row);
  tx(()=>{
   currentSource({asset,input});
   if(!cacheBounded())throw fault('WAVEFORM_CAPACITY');
   const existing=load(cacheKey);
   // In-memory owners, rather than persisted status alone, fence active work.
   if(inflight.has(cacheKey))throw fault('WAVEFORM_BUSY');
   if(existing)db.prepare('DELETE FROM waveform_cache WHERE cacheKey=?').run(cacheKey);
   if(!safeBudgetRows())throw fault('WAVEFORM_CAPACITY');
   const totals=()=>db.prepare(`SELECT count(*) AS entries,
    coalesce(sum(max(bytes,reservedBytes,length(CAST(data AS BLOB))+length(CAST(cacheKey||projectId||sourceSha256||algorithm||status||attemptId AS BLOB))+512)),0) AS bytes
    FROM waveform_cache`).get();
   let total=totals();
   const candidates=db.prepare("SELECT cacheKey FROM waveform_cache WHERE status NOT IN ('queued','running') AND length(CAST(cacheKey AS BLOB))=64 ORDER BY position,cacheKey LIMIT 64").all();
   for(const candidate of candidates){
    if(total.entries<WAVEFORM_CACHE_LIMITS.entries&&total.bytes+WAVEFORM_CACHE_LIMITS.recordBytes<=WAVEFORM_CACHE_LIMITS.bytes)break;
    if(inflight.has(candidate.cacheKey))continue;
    db.prepare('DELETE FROM waveform_cache WHERE cacheKey=?').run(candidate.cacheKey);total=totals();
   }
   if(total.entries>=WAVEFORM_CACHE_LIMITS.entries||total.bytes+WAVEFORM_CACHE_LIMITS.recordBytes>WAVEFORM_CACHE_LIMITS.bytes)throw fault('WAVEFORM_CAPACITY');
   db.prepare(`INSERT INTO waveform_cache(cacheKey,projectId,sourceSha256,algorithm,status,attemptId,data,bytes,reservedBytes)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(cacheKey,asset.projectId,asset.sha256,WAVEFORM_ALGORITHM,'queued',row.attemptId,'{}',bytes,WAVEFORM_CACHE_LIMITS.recordBytes);
   currentSource({asset,input});
  });
  return row;
 }
 function request(input){
  const asset=owned(input);
  if(!ownsStoreLock(store))return response(input,'error',{reason:reason('WAVEFORM_OWNER_REQUIRED')});
  const cacheKey=sourceKey(asset),row=cacheKey?load(cacheKey):null,current=state(input,asset,row);
  if(!cacheKey||current.status==='ready'||inflight.has(cacheKey))return current;
  if(row&&!input.retry)return current;
  if(stopped)return response(input,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});
  if(inflight.size>=WAVEFORM_CACHE_LIMITS.active+WAVEFORM_CACHE_LIMITS.queued)return response(input,'error',{reason:reason('WAVEFORM_BUSY')});
  let admitted;
  try{admitted=admit(asset,input,cacheKey);}catch(error){if(error.waveformCode)return response(input,error.waveformStatus,{reason:reason(error.waveformCode)});throw error;}
  const entry={input:{projectId:input.projectId,assetId:input.assetId},asset,row:admitted,controller:new AbortController()};
  inflight.set(cacheKey,entry);queue.push(entry);pump();
  return state(input,asset,load(cacheKey));
 }
 function stop(){
  if(stopped)return;stopped=true;
  for(const entry of inflight.values()){
   entry.controller.abort();
   try{save(entry.row,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});}catch(error){shutdownFailure??=error;}
  }
  for(const entry of queue)inflight.delete(entry.row.cacheKey);
  queue.length=0;
 }
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(){
  if(draining)return draining;
  stop();
  draining=(async()=>{
   await boundedShutdown(Promise.allSettled([...tasks]),'WAVEFORM_STOP_TIMEOUT');
   if(shutdownFailure)throw shutdownFailure;
   ownerSignal?.removeEventListener('abort',stop);
   if(owners.get(db)===ownToken)owners.delete(db);
  })();
  return draining;
 }
 ownToken.service={handlers:{'asset.waveform.request':request,...history.handlers},drain};
 return ownToken.service;
}

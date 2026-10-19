import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError,parse,WAVEFORM_ALGORITHM,sourceFrameCount} from '@mioon/contracts';
import {validateManagedSource,verifiedManagedHash,sameManagedFile as sameFile} from './managed-media.ts';
import type {ManagedSource,VerifiedManagedSource} from './managed-media.ts';
import {run} from './media-runtime.ts';
import {parseProbeOutput,withProbePermit} from './media-probe.ts';
import type {ProbeResult} from './media-probe.ts';
import {decodeWaveform} from './waveform-decoder.ts';
import {boundedShutdown} from './operation-lifecycle.ts';
import {ownsStoreLock} from './db.ts';
import {createWaveformHistoryReaders,WAVEFORM_CACHE_LIMITS,waveformMessages as messages,waveformReason as reason,waveformFault as fault,isWaveformMediaType,waveformSourceMetadata as sourceMetadata,waveformDigest as digest,waveformRowBytes as rowBytes,waveformInput as asInput} from './waveforms-history.ts';
import type {WaveformAsset,WaveformCacheRow,WaveformFault,WaveformGetInput,WaveformMessageCode,WaveformResponse,WaveformStatus,WaveformStoredData} from './waveforms-history.ts';

export {WAVEFORM_ALGORITHM};
export {WAVEFORM_CACHE_LIMITS};
export interface WaveformDecodePlan { readonly duration: number; readonly channels: number }
export interface WaveformDecoded { readonly peaks: Uint16Array; readonly clipped: boolean; readonly sampleFrames: number }
export type WaveformDecoder=(file: string, options: {signal?: AbortSignal|null; channels: number; duration: number})=>Promise<WaveformDecoded>;
export type WaveformProbe=(file: string, options: {signal?: AbortSignal|null; beforeSpawn?: ()=>void})=>Promise<ProbeResult>;
export interface WaveformStore {
 readonly db: DatabaseSync;
 readonly root: string;
 tx<T>(callback: ()=>T): T;
}
export interface WaveformService {
 readonly handlers: Readonly<Record<string,(input: unknown, context?: {signal?: AbortSignal|null})=>unknown>>;
 readonly drain: ()=>Promise<void>;
}
interface WaveformAttempt {
 readonly input: Readonly<{projectId: string; assetId: string}>;
 readonly asset: WaveformAsset;
 readonly row: WaveformCacheRow;
 readonly controller: AbortController;
 timedOut: boolean;
}
interface WaveformOwner {
 readonly signal: AbortSignal|undefined;
 readonly decode: WaveformDecoder;
 readonly probe: WaveformProbe;
 readonly root: string;
 service: WaveformService;
}
const owners=new WeakMap<DatabaseSync,WaveformOwner>(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const property=(value: unknown,key: string): unknown=>value!==null&&typeof value==='object'&&key in value?(value as Record<string,unknown>)[key]:undefined;
const messageCode=(value: unknown): WaveformMessageCode=>value as WaveformMessageCode;
const checkSignal=(signal?: AbortSignal|null): void=>{if(signal?.aborted)throw fault('WAVEFORM_INTERRUPTED','interrupted');};
const isFault=(error: unknown): error is WaveformFault=>error instanceof Error&&typeof property(error,'waveformCode')==='string';

export async function probeWaveform(file: string,{signal,beforeSpawn}: {signal?: AbortSignal|null; beforeSpawn?: ()=>void}={}): Promise<ProbeResult> {
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
export function createWaveformServices(store: WaveformStore,{signal:ownerSignal,decode=decodeWaveform,probe=probeWaveform}: {signal?: AbortSignal; decode?: WaveformDecoder; probe?: WaveformProbe}={}): WaveformService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const existingOwner=owners.get(store.db);
 if(existingOwner){
  if(existingOwner.signal===ownerSignal&&existingOwner.decode===decode&&existingOwner.probe===probe&&existingOwner.root===store.root)return existingOwner.service;
  throw new AppError('WAVEFORM_SERVICE_ACTIVE','This store already owns a waveform service with a different lifecycle',409);
 }
 const {db,root,tx}=store,queue: WaveformAttempt[]=[],inflight=new Map<string,WaveformAttempt>(),tasks=new Set<Promise<void>>();
 let active: WaveformAttempt|null=null,stopped=false,shutdownFailure: unknown,draining: Promise<void>|undefined;
 const history=createWaveformHistoryReaders(store),{cacheBounded,owned,sourceKey,load,response,state}=history;
 function safeBudgetRows(): boolean {
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
 const ownToken: WaveformOwner={signal:ownerSignal,decode,probe,root,service:undefined as unknown as WaveformService};owners.set(db,ownToken);
 const requireOwner=(): void=>{if(!ownsStoreLock(store))throw fault('WAVEFORM_OWNER_REQUIRED');};

 function save(row: WaveformCacheRow,status: WaveformStatus,data: unknown,reservedBytes=0): boolean {
  if(!ownsStoreLock(store))return false;
  const next={...row,status,data},bytes=rowBytes(next);
  if(bytes>WAVEFORM_CACHE_LIMITS.recordBytes)throw fault('WAVEFORM_CAPACITY');
  return db.prepare(`UPDATE waveform_cache SET status=?,data=?,bytes=?,reservedBytes=?
   WHERE cacheKey=? AND projectId=? AND attemptId=? AND status IN ('queued','running')`)
   .run(status,JSON.stringify(data) as string,bytes,reservedBytes,row.cacheKey,row.projectId,row.attemptId).changes===1;
 }
 // Only unfinished disposable records change at startup. Retain attempt IDs so
 // stale callbacks cannot overwrite a later, explicitly requested attempt.
 try{
  const unfinished=()=>Boolean(db.prepare("SELECT 1 FROM waveform_cache WHERE status IN ('queued','running') LIMIT 1").get());
  // Empty/ready-only construction is genuinely read-only and never consumes a
  // caller's first business transaction. Shared/read-only handles never repair.
  if(ownsStoreLock(store)&&cacheBounded()&&unfinished())tx(()=>{
   if(!ownsStoreLock(store)||!cacheBounded()||!unfinished())return;
   for(const candidate of db.prepare("SELECT cacheKey FROM waveform_cache WHERE status IN ('queued','running') AND length(CAST(cacheKey AS BLOB))=64 LIMIT 64").all()){
    const cacheKey=candidate.cacheKey;
    if(typeof cacheKey!=='string')continue;
    const row=load(cacheKey);if(!row||!row.projectId||!row.sourceSha256||!row.algorithm||!uuid.test(row.attemptId))continue;
    save(row,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});
   }
  });
 }catch(error){owners.delete(db);throw error;}

 function sourceFailure(error: unknown,signal?: AbortSignal|null): never {
  checkSignal(signal);
  if(property(error,'code')==='MANAGED_SOURCE_LIMIT')throw fault('WAVEFORM_SOURCE_TOO_LARGE','unsupported');
  throw fault(property(error,'code')==='MANAGED_SOURCE_CHANGED'?'WAVEFORM_SOURCE_CHANGED':'WAVEFORM_SOURCE_INVALID');
 }
 function validatedSource(asset: WaveformAsset): ManagedSource {
  try{return validateManagedSource(root,asset,{maxBytes:WAVEFORM_CACHE_LIMITS.sourceBytes});}
  catch(error){sourceFailure(error);}
 }
 async function verifiedHash(asset: WaveformAsset,signal?: AbortSignal|null,expected?: ManagedSource['info']): Promise<VerifiedManagedSource> {
  try{return await verifiedManagedHash(root,asset,{signal,expected,maxBytes:WAVEFORM_CACHE_LIMITS.sourceBytes});}
  catch(error){sourceFailure(error,signal);}
 }
 function currentSource(entry: {asset: WaveformAsset;input: WaveformGetInput}): WaveformAsset {
  requireOwner();
  const latest=owned(entry.input);
  if(latest.sha256!==entry.asset.sha256||latest.relativePath!==entry.asset.relativePath||latest.duration!==entry.asset.duration||latest.mimeType!==entry.asset.mimeType||
   latest.hasAudio!==entry.asset.hasAudio||latest.sizeBytes!==entry.asset.sizeBytes)throw fault('WAVEFORM_SOURCE_CHANGED');
  return latest;
 }
 function audioPlan(info: ProbeResult): WaveformDecodePlan {
  const stream=info?.probe?.streams?.find(value=>value?.codec_type==='audio');
  if(!stream)throw fault('WAVEFORM_NO_AUDIO','unsupported');
  const declaredChannels=typeof stream.channels==='number'?stream.channels:Number.NaN;
  if(declaredChannels!==1&&declaredChannels!==2)throw fault('WAVEFORM_CHANNELS_UNSUPPORTED','unsupported');
  const container=info.duration;
  let duration=Number(stream.duration);
  if(!(Number.isFinite(duration)&&duration>0)){
   const match=typeof stream.time_base==='string'&&/^(\d+)\/(\d+)$/.exec(stream.time_base);
   const calculated=match?Number(stream.duration_ts)*Number(match[1])/Number(match[2]):Number.NaN;
   duration=Number.isFinite(calculated)&&calculated>0?calculated:container;
  }
  if(!Number.isFinite(container)||container<=0||container>600||!Number.isFinite(duration)||duration<=0||duration>600||sourceFrameCount(duration)===null)throw fault('WAVEFORM_DURATION_UNSUPPORTED','unsupported');
  const start=(value: unknown): number|null=>value===undefined||value===null||value===''||value==='N/A'?null:Number(value);
  let audioStart=start(stream.start_time),formatStart=start(info.probe.format?.start_time);
  // Untimed WAV has a known sample-zero origin; other missing/unknown origins
  // are unsupported instead of silently shifting the displayed waveform.
  if(audioStart===null&&formatStart===null&&info.probe.format?.format_name==='wav')audioStart=formatStart=0;
  if(audioStart===null||formatStart===null||audioStart<0||formatStart<0)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
  const offset=audioStart-formatStart;
  if(!Number.isFinite(offset)||Math.abs(offset)>1/48000||Math.abs(duration-container)>.1+1e-6)throw fault('WAVEFORM_TIMING_UNSUPPORTED','unsupported');
  return {duration,channels:declaredChannels};
 }
 async function runAttempt(entry: WaveformAttempt): Promise<void> {
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
   if(property(error,'terminationUnconfirmed'))shutdownFailure=error;
   const status: WaveformStatus=entry.timedOut?'error':stopped||controller.signal.aborted?'interrupted':isFault(error)?(error.waveformStatus as WaveformStatus):'error';
   const code: WaveformMessageCode=entry.timedOut?'WAVEFORM_TIMEOUT':status==='interrupted'?'WAVEFORM_INTERRUPTED':
    isFault(error)?messageCode(property(error,'waveformCode')):(['WAVEFORM_DURATION_MISMATCH'].includes(String(property(error,'code')))?'WAVEFORM_TIMING_UNSUPPORTED':'WAVEFORM_DECODE_FAILED');
   try{save(entry.row,property(error,'code')==='WAVEFORM_DURATION_MISMATCH'?'unsupported':status,{reason:reason(code)});}catch(failure){if(shutdownFailure===undefined||shutdownFailure===null)shutdownFailure=failure;}
  }finally{clearTimeout(timer);}
 }
 function pump(): void {
  if(stopped||active||!queue.length)return;
  if(!ownsStoreLock(store)){stop();return;}
  const entry=queue.shift();if(!entry)return;active=entry;
  if(!save(entry.row,'running',{},WAVEFORM_CACHE_LIMITS.recordBytes)){
   inflight.delete(entry.row.cacheKey);active=null;queueMicrotask(pump);return;
  }
  const task=Promise.resolve().then(()=>runAttempt(entry)).finally(()=>{
   tasks.delete(task);inflight.delete(entry.row.cacheKey);if(active===entry)active=null;pump();
  });
  tasks.add(task);
  // The owned task is always observed, even if an unexpected SQLite failure
  // reaches pump/finally. drain reports the failure rather than closing early.
  task.catch(error=>{if(shutdownFailure===undefined||shutdownFailure===null)shutdownFailure=error;});
 }
 function admit(asset: WaveformAsset,input: WaveformGetInput,cacheKey: string,sourceSha256: string): WaveformCacheRow {
  requireOwner();
  const seed: {cacheKey: string;projectId: string;sourceSha256: string;algorithm: string;status: string;attemptId: string;data: unknown}={cacheKey,projectId:asset.projectId,sourceSha256,algorithm:WAVEFORM_ALGORITHM,
   status:'queued',attemptId:randomUUID(),data:{}},bytes=rowBytes(seed),row=seed as unknown as WaveformCacheRow;
  tx(()=>{
   currentSource({asset,input});
   if(!cacheBounded())throw fault('WAVEFORM_CAPACITY');
   const existing=load(cacheKey);
   // In-memory owners, rather than persisted status alone, fence active work.
   if(inflight.has(cacheKey))throw fault('WAVEFORM_BUSY');
   if(existing)db.prepare('DELETE FROM waveform_cache WHERE cacheKey=?').run(cacheKey);
   if(!safeBudgetRows())throw fault('WAVEFORM_CAPACITY');
   const totals=(): {entries: number; bytes: number}=>{
    const row=db.prepare(`SELECT count(*) AS entries,
     coalesce(sum(max(bytes,reservedBytes,length(CAST(data AS BLOB))+length(CAST(cacheKey||projectId||sourceSha256||algorithm||status||attemptId AS BLOB))+512)),0) AS bytes
     FROM waveform_cache`).get();
    const entries=row?.entries,sum=row?.bytes;
    return {entries:typeof entries==='number'?entries:0,bytes:typeof sum==='number'?sum:0};
   };
   let total=totals();
   const candidates=db.prepare("SELECT cacheKey FROM waveform_cache WHERE status NOT IN ('queued','running') AND length(CAST(cacheKey AS BLOB))=64 ORDER BY position,cacheKey LIMIT 64").all();
   for(const candidate of candidates){
    if(total.entries<WAVEFORM_CACHE_LIMITS.entries&&total.bytes+WAVEFORM_CACHE_LIMITS.recordBytes<=WAVEFORM_CACHE_LIMITS.bytes)break;
    if(typeof candidate.cacheKey!=='string'||inflight.has(candidate.cacheKey))continue;
    db.prepare('DELETE FROM waveform_cache WHERE cacheKey=?').run(candidate.cacheKey);total=totals();
   }
   if(total.entries>=WAVEFORM_CACHE_LIMITS.entries||total.bytes+WAVEFORM_CACHE_LIMITS.recordBytes>WAVEFORM_CACHE_LIMITS.bytes)throw fault('WAVEFORM_CAPACITY');
   db.prepare(`INSERT INTO waveform_cache(cacheKey,projectId,sourceSha256,algorithm,status,attemptId,data,bytes,reservedBytes)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(cacheKey,asset.projectId,sourceSha256,WAVEFORM_ALGORITHM,'queued',row.attemptId,'{}',bytes,WAVEFORM_CACHE_LIMITS.recordBytes);
   currentSource({asset,input});
  });
  return row;
 }
 function request(input: WaveformGetInput): WaveformResponse {
  const asset=owned(input);
  if(!ownsStoreLock(store))return response(input,'error',{reason:reason('WAVEFORM_OWNER_REQUIRED')});
  const sourceSha256=typeof asset.sha256==='string'?asset.sha256:null,cacheKey=sourceSha256?sourceKey(asset):null,row=cacheKey?load(cacheKey):null,current=state(input,asset,row);
  if(!cacheKey||!sourceSha256||current.status==='ready'||inflight.has(cacheKey))return current;
  if(row&&!input.retry)return current;
  if(stopped)return response(input,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});
  if(inflight.size>=WAVEFORM_CACHE_LIMITS.active+WAVEFORM_CACHE_LIMITS.queued)return response(input,'error',{reason:reason('WAVEFORM_BUSY')});
  let admitted: WaveformCacheRow;
  try{admitted=admit(asset,input,cacheKey,sourceSha256);}
  catch(error){
   if(isFault(error))return response(input,error.waveformStatus as WaveformStatus,{reason:reason(messageCode(property(error,'waveformCode')))});
   throw error;
  }
  const entry: WaveformAttempt={input:{projectId:input.projectId,assetId:input.assetId},asset,row:admitted,controller:new AbortController(),timedOut:false};
  inflight.set(cacheKey,entry);queue.push(entry);pump();
  return state(input,asset,load(cacheKey));
 }
 function stop(): void {
  if(stopped)return;stopped=true;
  for(const entry of inflight.values()){
   entry.controller.abort();
   try{save(entry.row,'interrupted',{reason:reason('WAVEFORM_INTERRUPTED')});}catch(error){if(shutdownFailure===undefined||shutdownFailure===null)shutdownFailure=error;}
  }
  for(const entry of queue)inflight.delete(entry.row.cacheKey);
  queue.length=0;
 }
 ownerSignal?.addEventListener('abort',stop,{once:true});if(ownerSignal?.aborted)stop();
 async function drain(): Promise<void> {
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
 ownToken.service={handlers:{'asset.waveform.request':(input: unknown,context?: {signal?: AbortSignal|null})=>request(asInput(parse('asset.waveform.request',input))),...history.handlers},drain};
 return ownToken.service;
}

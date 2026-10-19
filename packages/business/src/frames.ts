import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '@mioon/contracts';
import {FRAME_LIMITS,FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_MUTATION_OPERATIONS,frameSchemas,frameSnapshotSchema,frameTaskResponseSchema,isFrameMutationResponse,canonicalFrameInput as canonical} from '../../contracts/src/frame-extraction.ts';
import {createFrameHistoryReaders,frameServiceMessages as messages,frameServiceFailure as failure,safeFrameFailure,framePublicFailure} from './frames-history.ts';
import type {FrameHistoryReaders,FrameTaskInput,FrameTaskResponse} from './frames-history.ts';
import {createFrameOwnershipReader} from './frame-ownership.ts';
import type {FrameTaskView,FrameTaskSnapshot} from './frame-ownership.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {createFrameStorage} from './frame-storage.ts';
import type {FrameStorage,FrameStorageTask,FrameReceipt,FrameSourceSnapshot} from './frame-storage.ts';
import {decodeManagedFrame} from './frame-decoder.ts';
import type {DecodeManagedFrameOptions,DecodedManagedFrame} from './frame-decoder.ts';
import {validateManagedSource,verifiedManagedHash,sameManagedFile} from './managed-media.ts';
import type {ManagedFileIdentity,ManagedSource,VerifiedManagedSource} from './managed-media.ts';
import {validatePng} from './images/png.ts';
import {ownsStoreLock} from './db.ts';
import {boundedShutdown,assertMediaTerminated} from './operation-lifecycle.ts';
import {hasUnconfirmedMediaProcesses,terminateMediaProcesses,waitForMediaProcesses} from './media-processes.ts';

export type FrameRow=Record<string, unknown>;
export interface FrameStore {readonly db: DatabaseSync; readonly root: string; tx<T>(callback: ()=>T): T}
export type FrameFault=(stage: string,details?: Record<string,unknown>)=>unknown;
export interface FrameServicesOptions {
 signal?: AbortSignal;
 decode?: (options?: DecodeManagedFrameOptions)=>Promise<DecodedManagedFrame>;
 autoRun?: boolean;
 fault?: FrameFault;
}
export interface FrameService {
 readonly handlers: Readonly<Record<string,(input: unknown,context?: {signal?: AbortSignal|null})=>unknown>>;
 readonly drain: ()=>Promise<void>;
}
interface FrameOwnerRecord {
 readonly root: string;
 readonly signal: AbortSignal|undefined;
 readonly decode: (options?: DecodeManagedFrameOptions)=>Promise<DecodedManagedFrame>;
 readonly autoRun: boolean;
 readonly fault: FrameFault;
 service: FrameService;
}
interface FrameSourceIdentity extends FrameSourceSnapshot {}
interface FrameAttempt {readonly id: string; readonly projectId: string; readonly local: boolean}
interface FrameExtractRequest extends FrameTaskInput {readonly expectedRevision?: number}
interface FrameTaskRequest extends FrameTaskInput {readonly taskId: string; readonly expectedRevision: number}
interface FrameSourceInput {readonly projectId: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly sourceFrame: number; readonly requestId?: string}
type FrameReader={frameTask(id: string): FrameTaskView; asset(id: string): FrameRow};
type FrameMutationResponse=FrameTaskResponse;

const noop: FrameFault=()=>{};
const isThenable=(value: unknown): value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?: unknown}).then==='function';
const isRecord=(value: unknown): value is FrameRow=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const asFault=(file: string): {file: string; info: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}}=>file as unknown as {file: string; info: {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}};
const owners=new WeakMap<DatabaseSync,FrameOwnerRecord>(),verifiedRefusals=new WeakMap<object,unknown>(),now=(): string=>new Date().toISOString();
const hash=(value: unknown): string=>createHash('sha256').update(canonical(value)).digest('hex');
const equal=(a: unknown,b: unknown): boolean=>canonical(a)===canonical(b);
function fail(code: string,status?: number): never {throw failure(code,status);}
function missing(): never {return fail('FRAME_NOT_FOUND',404);}
function invalid(): never {return fail('FRAME_RECORD_INVALID');}
export function safeFrameServiceError(cause: unknown): {code: string; message: string; status: number; details?: Record<string,unknown>} {
 const safe=safeFrameFailure(cause),proof=isRecord(cause)?verifiedRefusals.get(cause):null;
 return {...safe,...(proof?{details:{frameOutcome:proof}}:{})};
}
const bounded=(name: string,size: number,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
function publicFailure(cause: unknown): AppError {
 const safe=safeFrameServiceError(cause),error=framePublicFailure(cause,safe.details??{});
 if(safe.details&&isRecord(error))verifiedRefusals.set(error,safe.details.frameOutcome as unknown);return error;
}
const maxRevision=(value: unknown): void=>{if(!Number.isSafeInteger(value)||(value as number)>=Number.MAX_SAFE_INTEGER)fail('FRAME_CAPACITY',507);};
const stageTask=(value: FrameTaskView): FrameStorageTask=>({...value.row,snapshot:value.snapshot} as unknown as FrameStorageTask);

/** Local-only, single-owner extraction. The immutable ACK is committed before
 * any work is queued. Startup and historical replay never enter the work queue.
 * This module has no provider, model, settings, network, or generic tool seam. */
export function createFrameServices(store: FrameStore,{signal:ownerSignal,decode=decodeManagedFrame as unknown as (options?: DecodeManagedFrameOptions)=>Promise<DecodedManagedFrame>,autoRun=true,fault=noop}: FrameServicesOptions={}): FrameService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.decode!==decode||old.autoRun!==autoRun||old.fault!==fault)fail('FRAME_SERVICE_ACTIVE');return old.service;}
 const {db,root,tx}=store,queue: FrameAttempt[]=[],pending=new Set<string>(),preparations=new Map<string,{operation: string;projectId: string;canonicalInput: string;promise: Promise<unknown>}>(),active=new Set<Promise<unknown>>(),attemptSignals=new Set<AbortSignal>();
 const controller=new AbortController(),signal: AbortSignal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reported=false,draining: Promise<void>|undefined;
 const registration: FrameOwnerRecord={root,signal:ownerSignal,decode,autoRun,fault,service:undefined as unknown as FrameService};
 const storage=createFrameStorage(store,{validatePng});
 const history: FrameHistoryReaders=createFrameHistoryReaders(store),{schemaPresent,project,task,prior}=history;
 const graph=(projectId: string): FrameReader=>createOwnedMediaGraphReader(db,projectId) as unknown as FrameReader;
 function owner({allowStopped=false}: {allowStopped?: boolean}={}): void {
  if(owners.get(db)!==registration||!ownsStoreLock(store))fail('FRAME_OWNER_REQUIRED',403);
  if(!allowStopped&&(stopped||signal.aborted))fail('FRAME_SERVICE_STOPPED',503);
 }
 function current(original: FrameTaskView,{allowStopped=false}: {allowStopped?: boolean}={}): FrameTaskView {
  owner({allowStopped});const value=task(original.row.projectId,original.row.id);
  for(const key of ['revision','state','inputHash','input','snapshot','started','stagedReceipt','assetId'])if(value.row[key]!==original.row[key])fail('FRAME_REVISION_CONFLICT');
  return value;
 }
 function change(original: FrameTaskView,patch: Record<string, unknown>,{allowStopped=false}: {allowStopped?: boolean}={}): FrameTaskView {
  const value=current(original,{allowStopped});maxRevision(value.row.revision);
  if(Object.keys(patch).some(key=>!['state','started','stagedReceipt','assetId','errorCode'].includes(key)))throw Error('Invalid internal frame patch');
  const entries=Object.entries(patch),result=db.prepare(`UPDATE frame_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
   .run(...entries.map(([,entry])=>entry) as import('node:sqlite').SQLInputValue[],now(),value.row.id,value.row.projectId,value.row.revision);
  if(result.changes!==1)fail('FRAME_REVISION_CONFLICT');return task(value.row.projectId,value.row.id);
 }
 const count=(table: string,where: string,args: readonly import('node:sqlite').SQLInputValue[],cap: number): number=>{
  const value=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1)?.n;
  return typeof value==='number'?value:0;
 };
 function capacity(projectId: string,{extract=false,taskId,recover=false}: {extract?: boolean; taskId?: string; recover?: boolean}={}): void {
  if(count('frame_requests','',[],FRAME_LIMITS.requestsGlobal)>=FRAME_LIMITS.requestsGlobal||count('frame_requests','projectId=?',[projectId],FRAME_LIMITS.requestsPerProject)>=FRAME_LIMITS.requestsPerProject||
   taskId&&count('frame_requests','taskId=?',[taskId],FRAME_LIMITS.requestsPerTask)>=FRAME_LIMITS.requestsPerTask)fail('FRAME_CAPACITY',507);
  if(recover&&(running||db.prepare("SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') LIMIT 1").get()))fail('FRAME_QUEUE_FULL');
  if(!extract)return;
  if(count('frame_tasks','',[],FRAME_LIMITS.tasksGlobal)>=FRAME_LIMITS.tasksGlobal||count('frame_tasks','projectId=?',[projectId],FRAME_LIMITS.tasksPerProject)>=FRAME_LIMITS.tasksPerProject)fail('FRAME_CAPACITY',507);
  if(count('frame_tasks',"state='queued'",[],FRAME_LIMITS.queuedGlobal)>=FRAME_LIMITS.queuedGlobal||count('frame_tasks',"state='queued' AND projectId=?",[projectId],FRAME_LIMITS.queuedPerProject)>=FRAME_LIMITS.queuedPerProject)fail('FRAME_QUEUE_FULL');
 }
 function source(input: FrameSourceInput,snapshot?: FrameTaskSnapshot): {asset: FrameRow; frozen: FrameSourceSnapshot} {
  project(input.projectId);if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND projectId=? LIMIT 1').get(input.sourceAssetId,input.projectId))missing();
  const asset=graph(input.projectId).asset(input.sourceAssetId);
  if(asset.sha256!==input.sourceHash)fail('FRAME_SOURCE_CHANGED');
  const frozen={assetId:asset.id as string,sha256:asset.sha256 as string,mimeType:asset.mimeType as string,sizeBytes:asset.sizeBytes as number,relativePath:asset.relativePath as string,duration:asset.duration as number,width:asset.width as number,height:asset.height as number};
  if(snapshot&&!equal(frozen,snapshot.source))fail('FRAME_SOURCE_CHANGED');
  return {asset,frozen};
 }
 function sourceFile(asset: FrameRow): ManagedSource {
  try{const result=validateManagedSource(root,asset,{maxBytes:FRAME_LIMITS.sourceBytes});if(result.info.size!==asset.sizeBytes)fail('FRAME_SOURCE_CHANGED');return result;}
  catch(cause){if(property(cause,'code')==='FRAME_SOURCE_CHANGED')throw cause;fail('FRAME_SOURCE_INVALID');}
 }
 async function sourceHash(asset: FrameRow,expected?: ManagedSource['info']): Promise<VerifiedManagedSource> {
  try{return await verifiedManagedHash(root,asset,{signal,expected,maxBytes:FRAME_LIMITS.sourceBytes});}
  catch(cause){if(signal.aborted)fail('FRAME_SERVICE_STOPPED',503);fail(property(cause,'code')==='MANAGED_SOURCE_CHANGED'?'FRAME_SOURCE_CHANGED':'FRAME_SOURCE_INVALID');}
 }
 function sourceFence(original: FrameTaskView,expected?: ManagedFileIdentity): {file: string; info: ManagedFileIdentity; asset: FrameRow; value: FrameTaskView} {
  const value=current(original),{asset}=source(value.input as unknown as FrameSourceInput,value.snapshot),file=sourceFile(asset);
  if(expected&&!sameManagedFile(file.info,expected))fail('FRAME_SOURCE_CHANGED');return {...file,asset,value};
 }
 function record(operation: string,input: FrameTaskInput,response: FrameTaskResponse): void {
  if(!isFrameMutationResponse(operation,input,response))invalid();fault('before_request_receipt',{operation,input});
  db.prepare('INSERT INTO frame_requests(requestId,operation,projectId,taskId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?,?)')
   .run(input.requestId,operation,input.projectId,response.id,hash(input),canonical(input),canonical(response));
 }
 function accepted(operation: string,input: FrameTaskInput,value: FrameMutationResponse): FrameMutationResponse {
  if(operation==='frame.task.cancelQueued'){
   const index=queue.findIndex(entry=>entry.id===value.id);if(index!==-1)queue.splice(index,1);pending.delete(value.id);
  }
  fault('after_acceptance',{operation,input,response:value});if(operation!=='frame.task.cancelQueued')enqueue(value.id,input.projectId,operation==='frame.task.recoverResult');return value;
 }
 async function extract(input: FrameExtractRequest): Promise<FrameTaskResponse> {
  owner();project(input.projectId);const replay=prior('frame.extract',input);if(replay)return replay;
  capacity(input.projectId,{extract:true});const {asset,frozen}=source(input),id=randomUUID(),snapshot={schemaVersion:1,projectId:input.projectId,taskId:id,source:frozen,requested:{sourceFrame:input.sourceFrame,fps:30},profile:FRAME_PROFILE};
  if(!frameSnapshotSchema.safeParse(snapshot).success)fail('FRAME_SOURCE_INVALID');
  const file=sourceFile(asset),verified=await sourceHash(asset,file.info);owner();
  const result=tx(()=>{
   owner();project(input.projectId);const previous=prior('frame.extract',input);if(previous)return {value:previous,replayed:true};
   capacity(input.projectId,{extract:true});const latest=source(input,snapshot as unknown as FrameTaskSnapshot),checked=sourceFile(latest.asset);if(!sameManagedFile(verified.info,checked.info))fail('FRAME_SOURCE_CHANGED');
   const timestamp=now(),value={id,projectId:input.projectId,requestId:input.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,sourceFrame:input.sourceFrame,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
   if(!frameTaskResponseSchema.safeParse(value).success)invalid();
   db.prepare("INSERT INTO frame_tasks(id,projectId,requestId,inputHash,input,snapshot,state,revision,started,stagedReceipt,assetId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)")
    .run(id,input.projectId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   record('frame.extract',input,value as unknown as FrameTaskResponse);task(input.projectId,id);return {value:value as unknown as FrameTaskResponse,replayed:false};
  });
  return result.replayed?result.value:accepted('frame.extract',input,result.value);
 }
 function cancel(input: FrameTaskRequest): FrameTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('frame.task.cancelQueued',input);if(replay)return {value:replay,replayed:true};
   const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('FRAME_REVISION_CONFLICT');
   if(!['queued','interrupted'].includes(target.row.state)||target.row.started||target.receipt)fail('FRAME_STATE_CONFLICT');capacity(input.projectId,{taskId:target.row.id});
   const value=change(target,{state:'cancelled_before_start',errorCode:null}).dto;record('frame.task.cancelQueued',input,value);return {value,replayed:false};
  });return result.replayed?result.value:accepted('frame.task.cancelQueued',input,result.value);
 }
 async function recover(input: FrameTaskRequest): Promise<FrameTaskResponse> {
  owner();project(input.projectId);const replay=prior('frame.task.recoverResult',input);if(replay)return replay;
  const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('FRAME_REVISION_CONFLICT');
  if(!['interrupted','local_result_error'].includes(target.row.state)||!target.row.started)fail('FRAME_STATE_CONFLICT');capacity(input.projectId,{taskId:target.row.id,recover:true});
  const before=sourceFence(target),verified=await sourceHash(before.asset,before.info);sourceFence(target,verified.info);
  let receipt: FrameReceipt;
  try{const staged=storage.readReceipt(stageTask(target));if(!staged)fail('FRAME_RESULT_INVALID');receipt=staged;await storage.verify(stageTask(target),receipt,()=>{sourceFence(target,verified.info);},{signal});}
  catch(cause){const code=property(cause,'code');if(typeof code==='string'&&['FRAME_OWNER_REQUIRED','FRAME_SERVICE_STOPPED','FRAME_REVISION_CONFLICT','FRAME_SOURCE_CHANGED'].includes(code))throw cause;fail('FRAME_RESULT_INVALID');}
  const result=tx(()=>{
   owner();project(input.projectId);const previous=prior('frame.task.recoverResult',input);if(previous)return {value:previous,replayed:true};
   sourceFence(target,verified.info);capacity(input.projectId,{taskId:target.row.id,recover:true});
   // Re-observe immutable manifest identity after asynchronous PNG validation.
   const latest=storage.readReceipt(stageTask(target));if(!latest||!equal(latest,receipt))fail('FRAME_RESULT_INVALID');
   const value=change(target,{state:'persisting',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:null}).dto;
   record('frame.task.recoverResult',input,value);return {value,replayed:false};
  });return result.replayed?result.value:accepted('frame.task.recoverResult',input,result.value);
 }
 function diagnose(): void {if(!reported){reported=true;console.error('Skipped invalid local frame record.');}}
 async function finalize(original: FrameTaskView,expected?: ManagedSource['info']): Promise<void> {
  let checked=sourceFence(original,expected);const verified=await sourceHash(checked.asset,checked.info);checked=sourceFence(original,verified.info);
  const receipt=checked.value.receipt;if(!receipt)fail('FRAME_RESULT_INVALID');
  const check=(): void=>{sourceFence(original,verified.info);if(db.prepare('SELECT 1 FROM assets WHERE id=? LIMIT 1').get(receipt.assetId))fail('FRAME_RESULT_INVALID');};
  const file=await storage.publish(stageTask(original),receipt,check,{signal});check();fault('after_media_publication',{taskId:original.row.id});
  const result=tx(()=>{
   check();const timestamp=now(),asset={id:receipt.assetId,projectId:original.row.projectId,name:`Frame ${original.input.sourceFrame}.png`,mimeType:'image/png',sha256:receipt.sha256,width:receipt.width,height:receipt.height,sizeBytes:receipt.byteLength,relativePath:file.relativePath,url:`/media/${receipt.assetId}`,provenance:'extracted-frame',createdAt:timestamp};
   db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(asset.id,asset.projectId,JSON.stringify(asset));
   const completed=change(original,{state:'succeeded',assetId:asset.id,errorCode:null});graph(asset.projectId).asset(asset.id);fault('before_result_commit',{taskId:original.row.id});return completed;
  });
  try{storage.discardStagedPng(stageTask(result),()=>{current(result);});}catch{/* Retaining a private stage cannot undo a committed result. */}
 }
 async function execute(entry: FrameAttempt): Promise<void> {
  let original: FrameTaskView|undefined,registeredSignal: AbortSignal|undefined;
  try{
   owner();original=task(entry.projectId,entry.id);
   if(entry.local){if(original.row.state!=='persisting')return;await finalize(original);return;}
   if(original.row.state!=='queued')return;
   const before=sourceFence(original),verified=await sourceHash(before.asset,before.info);sourceFence(original,verified.info);
   const beforeSpawn=(attemptSignal: AbortSignal): void=>{
    if(!attemptSignal||typeof attemptSignal.addEventListener!=='function'||attemptSignal.aborted)fail('FRAME_INTERRUPTED');
    if(registeredSignal&&registeredSignal!==attemptSignal)fail('FRAME_RECORD_INVALID');registeredSignal=attemptSignal;attemptSignals.add(attemptSignal);
    const started=tx(()=>{
     const value=sourceFence(original as FrameTaskView,verified.info).value;
     if(value.row.state==='queued')return change(value,{state:'running',started:1,errorCode:null});
     if(value.row.state!=='running'||!value.row.started)fail('FRAME_STATE_CONFLICT');return value;
    });original=started;fault('after_start_fence',{taskId:started.row.id});
   };
   const started=original as FrameTaskView;
   const result=await decode({root,asset:before.asset,file:verified.file,info:verified.info as unknown as Record<string,unknown>,requestedFrame:started.input.sourceFrame,signal,beforeSpawn});
   sourceFence(started,verified.info);if(started.row.state!=='running'||!started.row.started||!registeredSignal)invalid();
   const receipt=await storage.stage(stageTask(original),result,()=>{sourceFence(original as FrameTaskView,verified.info);},{signal});fault('after_result_manifest',{taskId:original.row.id});
   original=tx(()=>{sourceFence(original as FrameTaskView,verified.info);return change(original as FrameTaskView,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null});});fault('after_result_receipt',{taskId:original.row.id});
   await finalize(original,verified.info);
  }catch(cause){
   console.error('FRAME_EXEC_FAIL',cause);
   if(original)try{
    const checked=current(original,{allowStopped:true});if(!['queued','running','persisting'].includes(checked.row.state))return;
    let receipt=checked.receipt;try{receipt??=storage.readReceipt(stageTask(checked));}catch{/* malformed retained receipt is a local result error */}
    tx(()=>{
     const causeCode=property(cause,'code');
     if(receipt&&checked.row.started)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'FRAME_RESULT_INVALID'},{allowStopped:true});
     else if(stopped||signal.aborted||property(cause,'terminationUnconfirmed')||(typeof causeCode==='string'&&['MEDIA_CANCELLED','FRAME_INTERRUPTED','FRAME_SERVICE_STOPPED'].includes(causeCode)))change(checked,{state:'interrupted',errorCode:'FRAME_INTERRUPTED'},{allowStopped:true});
     else change(checked,{state:'failed',errorCode:typeof causeCode==='string'&&Object.hasOwn(messages,causeCode)?causeCode:causeCode==='MANAGED_SOURCE_CHANGED'?'FRAME_SOURCE_CHANGED':'FRAME_STORAGE_FAILED'},{allowStopped:true});
    });
   }catch(cause2){console.error('FRAME_EXEC_RECORD_FAIL',cause2);diagnose();}
  }finally{
   // A decoder error is not evidence of child close. This exact registered
   // attempt owns the resource slot until every owned handle emits close.
   if(registeredSignal){await waitForMediaProcesses({signal:registeredSignal});attemptSignals.delete(registeredSignal);}
  }
 }
 function enqueue(id: string,projectId: string,local: boolean): void {
  if(!autoRun||stopped||signal.aborted||pending.has(id))return;
  const target=task(projectId,id);if(target.row.state!==(local?'persisting':'queued'))return;
  if(queue.length>=FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal)fail('FRAME_QUEUE_FULL');
  pending.add(id);const entry: FrameAttempt={id,projectId,local};if(local)queue.unshift(entry);else queue.push(entry);queueMicrotask(pump);
 }
 function pump(): void {
  if(running||stopped||signal.aborted)return;const entry=queue[0];if(!entry)return;
  // A durable active row whose enqueue was lost must remain visible for
  // restart reconciliation; it cannot cause unrelated queued tasks to fail.
  try{owner();if(!entry.local&&db.prepare("SELECT 1 FROM frame_tasks WHERE state IN ('running','persisting') LIMIT 1").get())return;}catch{diagnose();return;}
  queue.shift();running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;pump();});active.add(promise);void promise.catch(diagnose);
 }
 function reconcile(): void {
  if(!ownsStoreLock(store)||!schemaPresent())return;
  const rows=db.prepare(`SELECT ${bounded('id',36)},${bounded('projectId',36)} FROM frame_tasks WHERE state IN ('queued','running','persisting') ORDER BY id LIMIT ?`).all(FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal+1);
  if(rows.length>FRAME_LIMITS.queuedGlobal+FRAME_LIMITS.activeGlobal){diagnose();return;}
  for(const row of rows)try{const projectId=String(row.projectId),id=String(row.id);const target=task(projectId,id);tx(()=>change(target,{state:'interrupted',errorCode:'FRAME_INTERRUPTED'}));}catch{diagnose();}
 }
 const refusalCodes=new Set(['FRAME_CAPACITY','FRAME_QUEUE_FULL','FRAME_REVISION_CONFLICT','FRAME_STATE_CONFLICT','FRAME_SOURCE_INVALID','FRAME_SOURCE_CHANGED','FRAME_RESULT_INVALID']);
 function proveRefusal(operation: string,input: FrameTaskInput,cause: unknown): void {
  // An error label alone is never proof of nonacceptance. A fresh exclusive
  // synchronous transaction must establish scope and absence of this exact
  // global request ID after the failed operation's transaction has ended.
  if(!(cause instanceof AppError)||!refusalCodes.has(cause.code)||db.isTransaction)return;
  try{
   const proof=tx(()=>{
    owner();project(input.projectId);
    if(operation==='frame.extract'){
     if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND projectId=? LIMIT 1').get(input.sourceAssetId,input.projectId))missing();
     graph(input.projectId).asset(input.sourceAssetId);
    }else task(input.projectId,(input as FrameTaskRequest).taskId);
    if(db.prepare('SELECT 1 FROM frame_requests WHERE requestId=? LIMIT 1').get(input.requestId))return null;
    return {status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)};
   });
   if(proof){cause.details={frameOutcome:proof};verifiedRefusals.set(cause,proof);}
  }catch{/* Unknown scope, owner, storage or commit outcome remains unknown. */}
 }
 function prepareMutation<T>(operation: string,input: FrameTaskInput,invoke: ()=>T): T|Promise<unknown> {
  owner();project(input.projectId);const replay=prior(operation,input);if(replay)return replay as unknown as T;
  const exact=canonical(input),existing=preparations.get(input.requestId);
  if(existing){if(existing.operation!==operation||existing.canonicalInput!==exact)fail('FRAME_REQUEST_CONFLICT');return existing.promise;}
  if(preparations.size>=FRAME_LIMITS.queuedGlobal||[...preparations.values()].filter(entry=>entry.projectId===input.projectId).length>=FRAME_LIMITS.queuedPerProject)fail('FRAME_QUEUE_FULL');
  const entry: {operation: string;projectId: string;canonicalInput: string;promise: Promise<unknown>}={operation,projectId:input.projectId,canonicalInput:exact,promise:Promise.resolve()};
  entry.promise=Promise.resolve().then(invoke).finally(()=>{if(preparations.get(input.requestId)===entry)preparations.delete(input.requestId);});
  preparations.set(input.requestId,entry);return entry.promise;
 }
 function guardedMutation<T>(operation: string,input: FrameTaskInput,invoke: ()=>T): T|Promise<unknown> {
  try{const result=invoke();if(isThenable(result))return Promise.resolve(result).catch((cause: unknown)=>{proveRefusal(operation,input,cause);throw cause;});return result;}
  catch(cause){proveRefusal(operation,input,cause);throw cause;}
 }
 type FrameOperationHandler=(input: FrameTaskInput)=>unknown;
 const handlers: Record<string,(input: unknown,context?: {signal?: AbortSignal|null})=>unknown>={'frame.extract':(input: unknown)=>extract(input as FrameExtractRequest),'frame.task.cancelQueued':(input: unknown)=>cancel(input as FrameTaskRequest),'frame.task.recoverResult':(input: unknown)=>recover(input as FrameTaskRequest)};
 for(const [operation,handler] of Object.entries(handlers))handlers[operation]=(input: unknown)=>{
  try{
   if(!schemaPresent())fail('FRAME_SCHEMA_REQUIRED',503);
   const schema=Object.hasOwn(frameSchemas,operation)?frameSchemas[operation as keyof typeof frameSchemas]:null;
   if(!schema)throw new AppError('UNKNOWN_OPERATION','Unknown frame operation',404);
   const parsed=schema.safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR','Invalid frame operation input.',400);
   const data=parsed.data as unknown as FrameTaskInput;
   const mutating=FRAME_MUTATION_OPERATIONS.includes(operation as 'frame.extract');
   if(mutating&&Buffer.byteLength(canonical(data))>FRAME_LIMITS.inputBytes)fail('FRAME_CAPACITY',507);
   const invoke=()=>operation==='frame.extract'||operation==='frame.task.recoverResult'?prepareMutation(operation,data,()=>(handler as FrameOperationHandler)(data)):(handler as FrameOperationHandler)(data);
   const value=mutating?guardedMutation(operation,data,invoke):(handler as FrameOperationHandler)(data);
   return value&&typeof (value as PromiseLike<unknown>).then==='function'?Promise.resolve(value).catch((cause: unknown)=>{throw publicFailure(cause);}):value;
  }catch(cause){throw publicFailure(cause);}
 };
 function drain(): Promise<void> {
  if(draining)return draining;stopped=true;controller.abort();queue.length=0;
  const result=boundedShutdown((async()=>{
   const results=await Promise.all([...attemptSignals].map(attemptSignal=>terminateMediaProcesses({signal:attemptSignal})));assertMediaTerminated(results.flat());
   await Promise.allSettled([...active,...[...preparations.values()].map(entry=>entry.promise)]);if([...attemptSignals].some(attemptSignal=>hasUnconfirmedMediaProcesses({signal:attemptSignal})))assertMediaTerminated([{status:'unconfirmed'}]);
  })(),'FRAME_STOP_TIMEOUT');draining=result;void result.catch(()=>{if(draining===result)draining=undefined;});return result;
 }
 Object.assign(handlers,history.handlers);
 const service: FrameService={handlers,drain};registration.service=service;owners.set(db,registration);
 try{reconcile();}catch(cause){owners.delete(db);throw cause;}return service;
}

import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {AppError,SCENE_DETECTION_PROFILE_ID,SCENE_LIMITS,SCENE_MUTATION_OPERATIONS,SCENE_REFUSAL_CODES,SOURCE_RANGE_FPS,sceneSchemas,sceneSnapshotSchema,
 sceneTaskResponseSchema,sceneResultSummarySchema,isSceneMutationResponse,normalizeSceneDetectionOptions,canonicalSceneInput as canonical} from '@mioon/contracts';
import type {SceneTaskResponse,SceneResultSummary} from '@mioon/contracts';
import {createSceneHistoryReaders,sceneServiceMessages as messages,sceneServiceFailure as failure,safeSceneFailure,scenePublicFailure} from './scene-history.ts';
import type {SceneTaskView,SceneDetectInput} from './scene-history.ts';
import {detectManagedScenes} from './scene-detection-decoder.ts';
import type {DetectManagedScenesOptions,ManagedSceneDetection} from './scene-detection-decoder.ts';
import {validateManagedSource,sameManagedFile} from './managed-media.ts';
import type {ManagedFileIdentity,ManagedSource} from './managed-media.ts';
import {ownsStoreLock} from './db.ts';
import {boundedShutdown,assertMediaTerminated} from './operation-lifecycle.ts';
import {hasUnconfirmedMediaProcesses,terminateMediaProcesses,waitForMediaProcesses} from './media-processes.ts';

export interface SceneStore {readonly db: DatabaseSync; readonly root: string; tx<T>(callback: ()=>T): T}
export type SceneFault=(stage: string,details?: Record<string,unknown>)=>unknown;
export interface SceneServicesOptions {
 signal?: AbortSignal;
 detect?: (options: DetectManagedScenesOptions)=>Promise<ManagedSceneDetection>;
 autoRun?: boolean;
 fault?: SceneFault;
}
export interface SceneService {
 readonly handlers: Readonly<Record<string,(input: unknown)=>unknown>>;
 readonly drain: ()=>Promise<void>;
}
interface SceneOwnerRecord {
 readonly root: string; readonly signal: AbortSignal|undefined; readonly detect: NonNullable<SceneServicesOptions['detect']>;
 readonly autoRun: boolean; readonly fault: SceneFault; service: SceneService;
}
interface SceneTaskRequest {readonly projectId: string; readonly taskId: string; readonly expectedRevision: number; readonly requestId: string}
interface SceneCutsInput {readonly projectId: string; readonly assetId: string; readonly sourceHash: string; readonly expectedResultId: string; readonly cuts: readonly number[]; readonly requestId: string}
type SceneMutationInput=Record<string,unknown>&{readonly projectId: string; readonly requestId: string};
interface Progress {frames: number; frameCount: number; cuts: number}

const noop: SceneFault=()=>{};
const isRecord=(value: unknown): value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const owners=new WeakMap<DatabaseSync,SceneOwnerRecord>(),verifiedRefusals=new WeakMap<object,unknown>(),now=(): string=>new Date().toISOString();
const hash=(value: unknown): string=>createHash('sha256').update(canonical(value)).digest('hex');
function fail(code: string,status?: number): never {throw failure(code,status);}
function invalid(): never {return fail('SCENE_RECORD_INVALID');}
export function safeSceneServiceError(cause: unknown): {code: string; message: string; status: number; details?: Record<string,unknown>} {
 const safe=safeSceneFailure(cause),proof=isRecord(cause)?verifiedRefusals.get(cause):null;
 return {...safe,...(proof?{details:{sceneOutcome:proof}}:{})};
}
function publicFailure(cause: unknown): AppError {
 const safe=safeSceneServiceError(cause),error=scenePublicFailure(cause,safe.details??{});
 if(safe.details&&isRecord(error))verifiedRefusals.set(error,safe.details.sceneOutcome);return error;
}
const maxRevision=(value: unknown): void=>{if(!Number.isSafeInteger(value)||(value as number)>=Number.MAX_SAFE_INTEGER)fail('SCENE_CAPACITY',507);};
// Decoder and source failures keep their own code; anything else is reported
// as a generic detection failure rather than a storage or provider fault.
const decoderCodes: Readonly<Record<string,string>>=Object.freeze({MANAGED_SOURCE_CHANGED:'SCENE_SOURCE_CHANGED',MANAGED_SOURCE_INVALID:'SCENE_SOURCE_INVALID',
 MANAGED_SOURCE_LIMIT:'SCENE_SOURCE_INVALID',SCENE_FRAMES_INVALID:'SCENE_DECODE_INCOMPLETE',SCENE_FRAME_LIMIT:'SCENE_DECODE_INCOMPLETE',SCENE_DETECTION_INVALID:'SCENE_PROFILE_UNSUPPORTED'});

/** Local-only, single-owner scene detection. The immutable acknowledgement is
 * committed before work is queued; startup and replay never enter the queue.
 * One task decodes at a time. A running task can be cancelled: it becomes
 * cancelling, its decoder is stopped, and it ends cancelled with no result. */
export function createSceneServices(store: SceneStore,{signal:ownerSignal,detect=detectManagedScenes,autoRun=true,fault=noop}: SceneServicesOptions={}): SceneService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.detect!==detect||old.autoRun!==autoRun||old.fault!==fault)fail('SCENE_SERVICE_ACTIVE');return old.service;}
 const {db,root,tx}=store,queue: {id: string; projectId: string}[]=[],pending=new Set<string>(),active=new Set<Promise<unknown>>(),attemptSignals=new Set<AbortSignal>();
 const attempts=new Map<string,AbortController>(),progress=new Map<string,Progress>();
 const controller=new AbortController(),signal: AbortSignal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reported=false,draining: Promise<void>|undefined;
 const registration: SceneOwnerRecord={root,signal:ownerSignal,detect,autoRun,fault,service:undefined as unknown as SceneService};
 const history=createSceneHistoryReaders(store),{schemaPresent,project,asset,task,summary,latestResultId,prior}=history;
 function owner({allowStopped=false}: {allowStopped?: boolean}={}): void {
  if(owners.get(db)!==registration||!ownsStoreLock(store))fail('SCENE_OWNER_REQUIRED',403);
  if(!allowStopped&&(stopped||signal.aborted))fail('SCENE_SERVICE_STOPPED',503);
 }
 function change(original: SceneTaskView,patch: Record<string,SQLInputValue>,{allowStopped=false}: {allowStopped?: boolean}={}): SceneTaskView {
  owner({allowStopped});const value=task(original.row.projectId,original.row.id);
  for(const key of ['revision','state','started','resultId'] as const)if(value.row[key]!==original.row[key])fail('SCENE_REVISION_CONFLICT');
  maxRevision(value.row.revision);
  if(Object.keys(patch).some(key=>!['state','started','resultId','errorCode'].includes(key)))throw Error('Invalid internal scene patch');
  const entries=Object.entries(patch),result=db.prepare(`UPDATE scene_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
   .run(...entries.map(([,entry])=>entry),now(),value.row.id,value.row.projectId,value.row.revision);
  if(result.changes!==1)fail('SCENE_REVISION_CONFLICT');return task(value.row.projectId,value.row.id);
 }
 const count=(table: string,where: string,args: readonly SQLInputValue[],cap: number): number=>{
  const value=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1)?.n;
  return typeof value==='number'?value:0;
 };
 function capacity(projectId: string,{detect: accepting=false,taskId,assetId}: {detect?: boolean; taskId?: string; assetId?: string}={}): void {
  if(count('scene_requests','',[],SCENE_LIMITS.requestsGlobal)>=SCENE_LIMITS.requestsGlobal||count('scene_requests','projectId=?',[projectId],SCENE_LIMITS.requestsPerProject)>=SCENE_LIMITS.requestsPerProject||
   taskId&&count('scene_requests','taskId=?',[taskId],SCENE_LIMITS.requestsPerTask)>=SCENE_LIMITS.requestsPerTask)fail('SCENE_CAPACITY',507);
  if(assetId&&(count('scene_results','',[],SCENE_LIMITS.resultsGlobal)>=SCENE_LIMITS.resultsGlobal||count('scene_results','projectId=?',[projectId],SCENE_LIMITS.resultsPerProject)>=SCENE_LIMITS.resultsPerProject||
   count('scene_results','projectId=? AND assetId=?',[projectId,assetId],SCENE_LIMITS.resultsPerAsset)>=SCENE_LIMITS.resultsPerAsset))fail('SCENE_CAPACITY',507);
  if(!accepting)return;
  if(count('scene_tasks','',[],SCENE_LIMITS.tasksGlobal)>=SCENE_LIMITS.tasksGlobal||count('scene_tasks','projectId=?',[projectId],SCENE_LIMITS.tasksPerProject)>=SCENE_LIMITS.tasksPerProject)fail('SCENE_CAPACITY',507);
  if(count('scene_tasks',"state='queued'",[],SCENE_LIMITS.queuedGlobal)>=SCENE_LIMITS.queuedGlobal||count('scene_tasks',"state='queued' AND projectId=?",[projectId],SCENE_LIMITS.queuedPerProject)>=SCENE_LIMITS.queuedPerProject)fail('SCENE_QUEUE_FULL');
 }
 function sourceFile(source: Record<string,unknown>): ManagedSource {
  try{const result=validateManagedSource(root,source,{maxBytes:SCENE_LIMITS.sourceBytes});if(result.info.size!==source.sizeBytes)fail('SCENE_SOURCE_CHANGED');return result;}
  catch(cause){if(property(cause,'code')==='SCENE_SOURCE_CHANGED')throw cause;fail('SCENE_SOURCE_INVALID');}
 }
 /** The task's frozen source must still be the owned asset and the same file. */
 function sourceFence(original: SceneTaskView,expected?: ManagedFileIdentity): {source: Record<string,unknown>; file: string; info: ManagedFileIdentity} {
  const value=task(original.row.projectId,original.row.id),source=asset(value.row.projectId,value.row.sourceAssetId),frozen=value.snapshot.source;
  if(source.sha256!==frozen.sha256||source.sizeBytes!==frozen.sizeBytes||source.relativePath!==frozen.relativePath)fail('SCENE_SOURCE_CHANGED');
  const file=sourceFile(source);if(expected&&!sameManagedFile(file.info,expected))fail('SCENE_SOURCE_CHANGED');
  return {source,...file};
 }
 function record(operation: string,input: SceneMutationInput,response: unknown,{taskId=null,resultId=null}: {taskId?: string|null; resultId?: string|null}): void {
  if(!isSceneMutationResponse(operation,input,response))invalid();fault('before_request_receipt',{operation,input});
  db.prepare('INSERT INTO scene_requests(requestId,operation,projectId,taskId,resultId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?,?,?)')
   .run(input.requestId,operation,input.projectId,taskId,resultId,hash(input),canonical(input),canonical(response));
 }
 function accept(input: SceneDetectInput): SceneTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.detect',input as unknown as SceneMutationInput);if(replay)return {value:replay as SceneTaskResponse,replayed:true};
   const source=asset(input.projectId,input.sourceAssetId);
   if(source.sha256!==input.sourceHash)fail('SCENE_SOURCE_CHANGED');
   if(db.prepare("SELECT 1 FROM scene_tasks WHERE projectId=? AND sourceAssetId=? AND kind='detect' AND state IN ('queued','running','cancelling') LIMIT 1").get(input.projectId,input.sourceAssetId))fail('SCENE_TASK_ACTIVE');
   capacity(input.projectId,{detect:true});
   const id=randomUUID(),options=normalizeSceneDetectionOptions(input.options as Parameters<typeof normalizeSceneDetectionOptions>[0]);
   const snapshot={schemaVersion:1,projectId:input.projectId,taskId:id,kind:'detect',
    source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration},
    options,profileId:SCENE_DETECTION_PROFILE_ID,fps:SOURCE_RANGE_FPS};
   if(!sceneSnapshotSchema.safeParse(snapshot).success)fail('SCENE_SOURCE_INVALID');
   sourceFile(source);
   const timestamp=now(),value={id,projectId:input.projectId,kind:'detect',requestId:input.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,
    options,profileId:SCENE_DETECTION_PROFILE_ID,fps:SOURCE_RANGE_FPS,state:'queued',revision:1,started:false,result:null,progress:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
   if(!sceneTaskResponseSchema.safeParse(value).success)invalid();
   db.prepare("INSERT INTO scene_tasks(id,projectId,kind,sourceAssetId,requestId,inputHash,input,snapshot,state,revision,started,resultId,stagedReceipt,outcome,errorCode,createdAt,updatedAt) VALUES(?,?,'detect',?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,NULL,?,?)")
    .run(id,input.projectId,input.sourceAssetId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   record('scene.detect',input as unknown as SceneMutationInput,value,{taskId:id});task(input.projectId,id);
   return {value:value as SceneTaskResponse,replayed:false};
  });
  if(!result.replayed){fault('after_acceptance',{input,response:result.value});enqueue(result.value.id,input.projectId);}
  return result.value;
 }
 function cancel(input: SceneTaskRequest): SceneTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.task.cancel',input as unknown as SceneMutationInput);if(replay)return {value:replay as SceneTaskResponse,replayed:true};
   const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('SCENE_REVISION_CONFLICT');
   const unstarted=target.row.state==='queued'||target.row.state==='interrupted'&&!target.row.started;
   if(!unstarted&&target.row.state!=='running')fail('SCENE_STATE_CONFLICT');
   capacity(input.projectId,{taskId:target.row.id});
   const value=change(target,unstarted?{state:'cancelled_before_start',errorCode:null}:{state:'cancelling'}).dto;
   record('scene.task.cancel',input as unknown as SceneMutationInput,value,{taskId:target.row.id});return {value,replayed:false};
  });
  if(!result.replayed){
   const value=result.value;fault('after_acceptance',{input,response:value});
   // An unstarted task may already be hashing its source; stop that too.
   if(value.state==='cancelled_before_start'){const index=queue.findIndex(entry=>entry.id===value.id);if(index!==-1)queue.splice(index,1);pending.delete(value.id);attempts.get(value.id)?.abort();}
   else{const attempt=attempts.get(value.id);if(attempt)attempt.abort();else finishCancel(value.projectId,value.id);}
  }
  return result.value;
 }
 /** A cancelling task with no live attempt in this process has no decoder to wait for. */
 function finishCancel(projectId: string,id: string): void {
  try{tx(()=>{const target=task(projectId,id);if(target.row.state==='cancelling')change(target,{state:'cancelled'},{allowStopped:true});});}catch{diagnose();}
 }
 function saveCuts(input: SceneCutsInput): SceneResultSummary {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.cuts.save',input as unknown as SceneMutationInput);if(replay)return replay as SceneResultSummary;
   const source=asset(input.projectId,input.assetId);
   if(source.sha256!==input.sourceHash)fail('SCENE_SOURCE_CHANGED');
   const latest=latestResultId(input.projectId,input.assetId);if(latest!==input.expectedResultId)fail('SCENE_RESULT_CONFLICT');
   const base=history.result(input.projectId,latest);
   if(base.sourceHash!==source.sha256||base.profileId!==SCENE_DETECTION_PROFILE_ID)fail('SCENE_RESULT_STALE');
   if(input.cuts.some(frame=>frame>=base.frameCount))fail('SCENE_CUTS_INVALID');
   capacity(input.projectId,{assetId:input.assetId});
   // A kept cut keeps its detected score; an added or moved cut has none.
   const scores=new Map(base.cuts.map(cut=>[cut.frame,cut.score] as const)),cuts=input.cuts.map(frame=>({frame,score:scores.get(frame)??null}));
   const id=randomUUID(),createdAt=now(),position=Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM scene_results').get()!.n);
   db.prepare("INSERT INTO scene_results(id,projectId,assetId,position,sourceHash,origin,taskId,basedOnResultId,requestId,profileId,fps,frameCount,options,cuts,createdAt) VALUES(?,?,?,?,?,'manual',NULL,?,?,?,30,?,NULL,?,?)")
    .run(id,input.projectId,input.assetId,position,base.sourceHash,base.id,input.requestId,base.profileId,base.frameCount,JSON.stringify(cuts),createdAt);
   const value={id,projectId:input.projectId,assetId:input.assetId,sourceHash:base.sourceHash,origin:'manual',taskId:null,basedOnResultId:base.id,requestId:input.requestId,
    profileId:base.profileId,fps:SOURCE_RANGE_FPS,frameCount:base.frameCount,createdAt,cutCount:cuts.length};
   if(!sceneResultSummarySchema.safeParse(value).success)invalid();
   record('scene.cuts.save',input as unknown as SceneMutationInput,value,{resultId:id});
   if(canonical(summary(input.projectId,id))!==canonical(value))invalid();
   return value as SceneResultSummary;
  });
 }
 function diagnose(): void {if(!reported){reported=true;console.error('Skipped invalid local scene record.');}}
 async function execute(entry: {id: string; projectId: string}): Promise<void> {
  let original: SceneTaskView|undefined,registeredSignal: AbortSignal|undefined;
  const attempt=new AbortController();
  try{
   owner();original=task(entry.projectId,entry.id);
   if(original.row.state!=='queued')return;
   const before=sourceFence(original);
   attempts.set(entry.id,attempt);
   const beforeSpawn=(attemptSignal: AbortSignal): void=>{
    if(!attemptSignal||typeof attemptSignal.addEventListener!=='function'||attemptSignal.aborted)fail('SCENE_INTERRUPTED');
    if(registeredSignal&&registeredSignal!==attemptSignal)invalid();registeredSignal=attemptSignal;attemptSignals.add(attemptSignal);
    original=tx(()=>{
     const value=task(entry.projectId,entry.id);sourceFence(value,before.info);
     if(value.row.state==='queued')return change(value,{state:'running',started:1,errorCode:null});
     if(value.row.state!=='running'||!value.row.started)fail('SCENE_INTERRUPTED');return value;
    });
    fault('after_start_fence',{taskId:entry.id});
   };
   const detected=await detect({root,asset:before.source,file:before.file,info:before.info as unknown as Record<string,unknown>,options:original.snapshot.options,
    signal:AbortSignal.any([signal,attempt.signal]),beforeSpawn,
    onProgress:value=>{progress.set(entry.id,{frames:value.frames,frameCount:value.frameCount,cuts:value.cuts.length});}});
   fault('after_detection',{taskId:entry.id});
   tx(()=>{
    const value=task(entry.projectId,entry.id);
    // A cancel that arrived after the decoder finished still wins.
    if(value.row.state==='cancelling'){change(value,{state:'cancelled'},{allowStopped:true});return;}
    if(!original||value.row.state!=='running'||value.row.revision!==original.row.revision)fail('SCENE_REVISION_CONFLICT');
    sourceFence(value,before.info);
    if(detected.sourceHash!==value.input.sourceHash||detected.profileId!==value.snapshot.profileId||detected.fps!==SOURCE_RANGE_FPS)fail('SCENE_SOURCE_CHANGED');
    if(!Number.isSafeInteger(detected.frameCount)||detected.frameCount<1||detected.frameCount>SCENE_LIMITS.frameCount)fail('SCENE_DECODE_INCOMPLETE');
    if(detected.cuts.length>SCENE_LIMITS.cuts)fail('SCENE_CUTS_LIMIT');
    capacity(entry.projectId,{assetId:value.row.sourceAssetId});
    const id=randomUUID(),position=Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM scene_results').get()!.n);
    db.prepare("INSERT INTO scene_results(id,projectId,assetId,position,sourceHash,origin,taskId,basedOnResultId,requestId,profileId,fps,frameCount,options,cuts,createdAt) VALUES(?,?,?,?,?,'detected',?,NULL,NULL,?,30,?,?,?,?)")
     .run(id,entry.projectId,value.row.sourceAssetId,position,value.input.sourceHash,value.row.id,value.snapshot.profileId,detected.frameCount,canonical(value.snapshot.options),
      JSON.stringify(detected.cuts.map(cut=>({frame:cut.frame,score:cut.score}))),now());
    change(value,{state:'succeeded',resultId:id,errorCode:null});fault('before_result_commit',{taskId:entry.id});
   });
  }catch(cause){
   if(original)try{
    const checked=task(entry.projectId,entry.id);
    if(checked.row.state==='cancelling'){tx(()=>change(checked,{state:'cancelled'},{allowStopped:true}));return;}
    if(!['queued','running'].includes(checked.row.state))return;
    tx(()=>{
     const code=property(cause,'code'),mapped=typeof code==='string'?decoderCodes[code]??code:'';
     if(stopped||signal.aborted||property(cause,'terminationUnconfirmed')||['MEDIA_CANCELLED','SCENE_INTERRUPTED','SCENE_SERVICE_STOPPED'].includes(mapped))change(checked,{state:'interrupted',errorCode:'SCENE_INTERRUPTED'},{allowStopped:true});
     else change(checked,{state:'failed',errorCode:Object.hasOwn(messages,mapped)&&!['SCENE_RECORD_INVALID','SCENE_REVISION_CONFLICT','SCENE_OWNER_REQUIRED'].includes(mapped)?mapped:'SCENE_DETECTION_FAILED'},{allowStopped:true});
    });
   }catch{diagnose();}
  }finally{
   attempts.delete(entry.id);progress.delete(entry.id);
   // A decoder error is not evidence of child close. This attempt owns the
   // active slot until every owned process has closed.
   if(registeredSignal){await waitForMediaProcesses({signal:registeredSignal});attemptSignals.delete(registeredSignal);}
  }
 }
 function enqueue(id: string,projectId: string): void {
  if(!autoRun||stopped||signal.aborted||pending.has(id))return;
  if(queue.length>=SCENE_LIMITS.queuedGlobal+SCENE_LIMITS.activeGlobal)fail('SCENE_QUEUE_FULL');
  pending.add(id);queue.push({id,projectId});queueMicrotask(pump);
 }
 function pump(): void {
  if(running||stopped||signal.aborted)return;const entry=queue[0];if(!entry)return;
  // A durable active row whose attempt was lost must stay visible for
  // restart reconciliation; it cannot cause unrelated queued tasks to fail.
  try{owner();if(db.prepare("SELECT 1 FROM scene_tasks WHERE state IN ('running','cancelling','persisting') LIMIT 1").get())return;}catch{diagnose();return;}
  queue.shift();running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;pump();});active.add(promise);void promise.catch(diagnose);
 }
 function reconcile(): void {
  if(!ownsStoreLock(store)||!schemaPresent())return;
  const rows=db.prepare("SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END AS id,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId FROM scene_tasks WHERE state IN ('queued','running','cancelling','persisting') ORDER BY id LIMIT ?")
   .all(SCENE_LIMITS.queuedGlobal+SCENE_LIMITS.activeGlobal+1);
  if(rows.length>SCENE_LIMITS.queuedGlobal+SCENE_LIMITS.activeGlobal){diagnose();return;}
  for(const row of rows)try{
   const target=task(String(row.projectId),String(row.id));
   tx(()=>change(target,target.row.state==='cancelling'?{state:'cancelled'}:{state:'interrupted',errorCode:'SCENE_INTERRUPTED'}));
  }catch{diagnose();}
 }
 const refusalCodes=new Set<string>(SCENE_REFUSAL_CODES);
 function proveRefusal(operation: string,input: SceneMutationInput,cause: unknown): void {
  // An error label alone never proves nonacceptance. A fresh synchronous
  // transaction must establish scope and absence of this exact request ID.
  if(!(cause instanceof AppError)||!refusalCodes.has(cause.code)||db.isTransaction)return;
  try{
   const proof=tx(()=>{
    owner();project(input.projectId);
    if(operation==='scene.detect')asset(input.projectId,String(input.sourceAssetId));
    else if(operation==='scene.cuts.save')asset(input.projectId,String(input.assetId));
    else task(input.projectId,String(input.taskId));
    if(db.prepare('SELECT 1 FROM scene_requests WHERE requestId=? LIMIT 1').get(input.requestId))return null;
    return {status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)};
   });
   if(proof){cause.details={sceneOutcome:proof};verifiedRefusals.set(cause,proof);}
  }catch{/* Unknown scope, owner, storage or commit outcome remains unknown. */}
 }
 const mutations: Record<string,(input: never)=>unknown>={
  'scene.detect':(input: SceneDetectInput)=>accept(input),
  'scene.task.cancel':(input: SceneTaskRequest)=>cancel(input),
  'scene.cuts.save':(input: SceneCutsInput)=>saveCuts(input),
 };
 const handlers: Record<string,(input: unknown)=>unknown>={};
 for(const operation of SCENE_MUTATION_OPERATIONS)handlers[operation]=(input: unknown)=>{
  try{
   if(!schemaPresent())fail('SCENE_SCHEMA_REQUIRED',503);
   const parsed=sceneSchemas[operation].safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR','Invalid scene operation input.',400);
   const data=parsed.data as unknown as SceneMutationInput;
   if(Buffer.byteLength(canonical(data))>SCENE_LIMITS.inputBytes)fail('SCENE_CAPACITY',507);
   try{return mutations[operation]!(data as never);}catch(cause){proveRefusal(operation,data,cause);throw cause;}
  }catch(cause){throw publicFailure(cause);}
 };
 // Live progress is advisory and never stored; saved reads stay unchanged.
 const withProgress=(value: unknown): unknown=>{
  if(!isRecord(value)||value.state!=='running'||typeof value.id!=='string')return value;
  const live=progress.get(value.id);return live?{...value,progress:{...live}}:value;
 };
 Object.assign(handlers,history.handlers,{
  'scene.task.get':(input: unknown)=>withProgress(history.handlers['scene.task.get']!(input)),
  'scene.task.list':(input: unknown)=>{const page=history.handlers['scene.task.list']!(input) as {items: unknown[]};return {...page,items:page.items.map(withProgress)};},
 });
 function drain(): Promise<void> {
  if(draining)return draining;stopped=true;controller.abort();queue.length=0;
  const result=boundedShutdown((async()=>{
   const results=await Promise.all([...attemptSignals].map(attemptSignal=>terminateMediaProcesses({signal:attemptSignal})));assertMediaTerminated(results.flat());
   await Promise.allSettled([...active]);if([...attemptSignals].some(attemptSignal=>hasUnconfirmedMediaProcesses({signal:attemptSignal})))assertMediaTerminated([{status:'unconfirmed'}]);
  })(),'SCENE_STOP_TIMEOUT');draining=result;void result.catch(()=>{if(draining===result)draining=undefined;});return result;
 }
 const service: SceneService={handlers,drain};registration.service=service;owners.set(db,registration);
 try{reconcile();}catch(cause){owners.delete(db);throw cause;}return service;
}

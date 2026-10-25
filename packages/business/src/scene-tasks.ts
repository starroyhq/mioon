import {bindAgentTaskJobInside,assertAgentTaskJobEffect,withAgentTaskJobOrigin,isAgentTaskEffectBlocked,setAgentTaskJobResumer,setAgentTaskJobStopper,agentTaskJobBinding,isAgentTaskJobStopped} from './agent/task-effects-v2.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {AppError,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,SCENE_DETECTION_PROFILE_ID,SCENE_KEYFRAME_PROVENANCE,SCENE_LIMITS,SCENE_MUTATION_OPERATIONS,SCENE_REFUSAL_CODES,
 SCENE_SHOT_LAYOUT,SCENE_SHOT_TITLE_PREFIX,SOURCE_RANGE_FPS,sceneSchemas,sceneSnapshotSchema,sceneShotsSnapshotSchema,sceneShotsReceiptSchema,sceneShotsOutcomeSchema,
 sceneDetectTaskResponseSchema,sceneShotsTaskResponseSchema,sceneResultSummarySchema,isSceneMutationResponse,normalizeSceneDetectionOptions,sceneSegmentBounds,sceneShotPlan,
 canonicalSceneInput as canonical} from '@mioon/contracts';
import type {SceneDetectTaskResponse,SceneShotsTaskResponse,SceneResultSummary,SceneShotAspectRatio,SceneShotsReceipt} from '@mioon/contracts';
import {createSceneHistoryReaders,sceneServiceMessages as messages,sceneServiceFailure as failure,safeSceneFailure,scenePublicFailure} from './scene-history.ts';
import type {SceneTaskView,SceneDetectView,SceneShotsView,SceneDetectInput,SceneShotsInput} from './scene-history.ts';
import {detectManagedScenes} from './scene-detection-decoder.ts';
import type {DetectManagedScenesOptions,ManagedSceneDetection} from './scene-detection-decoder.ts';
import {decodeSceneKeyframes} from './scene-keyframe-decoder.ts';
import type {DecodeSceneKeyframesOptions,DecodedSceneKeyframes} from './scene-keyframe-decoder.ts';
import {createSceneShotsStorage} from './scene-shots-storage.ts';
import {validatePng} from './images/png.ts';
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
 decodeKeyframes?: (options: DecodeSceneKeyframesOptions)=>Promise<DecodedSceneKeyframes>;
 autoRun?: boolean;
 fault?: SceneFault;
}
export interface SceneService {
 readonly handlers: Readonly<Record<string,(input: unknown)=>unknown>>;
 readonly drain: ()=>Promise<void>;
}
interface SceneOwnerRecord {
 readonly root: string; readonly signal: AbortSignal|undefined; readonly detect: NonNullable<SceneServicesOptions['detect']>;
 readonly decodeKeyframes: NonNullable<SceneServicesOptions['decodeKeyframes']>; readonly autoRun: boolean; readonly fault: SceneFault; service: SceneService;
}
interface SceneTaskRequest {readonly projectId: string; readonly taskId: string; readonly expectedRevision: number; readonly requestId: string}
interface SceneCutsInput {readonly projectId: string; readonly assetId: string; readonly sourceHash: string; readonly expectedResultId: string; readonly cuts: readonly number[]; readonly requestId: string}
type SceneMutationInput=Record<string,unknown>&{readonly projectId: string; readonly requestId: string};

const noop: SceneFault=()=>{};
const isRecord=(value: unknown): value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const owners=new WeakMap<DatabaseSync,SceneOwnerRecord>(),verifiedRefusals=new WeakMap<object,unknown>(),now=(): string=>new Date().toISOString();
const hash=(value: unknown): string=>createHash('sha256').update(canonical(value)).digest('hex');
const digest=(bytes: Buffer): string=>createHash('sha256').update(bytes).digest('hex');
const ACTIVE_STATES="('queued','running','cancelling','persisting')";
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
// as a generic detection or storyboard failure, never a storage or provider fault.
const decoderCodes: Readonly<Record<string,string>>=Object.freeze({MANAGED_SOURCE_CHANGED:'SCENE_SOURCE_CHANGED',MANAGED_SOURCE_INVALID:'SCENE_SOURCE_INVALID',
 MANAGED_SOURCE_LIMIT:'SCENE_SOURCE_INVALID',SCENE_FRAMES_INVALID:'SCENE_DECODE_INCOMPLETE',SCENE_FRAME_LIMIT:'SCENE_DECODE_INCOMPLETE',SCENE_DETECTION_INVALID:'SCENE_PROFILE_UNSUPPORTED',
 FRAME_PROFILE_UNSUPPORTED:'SCENE_PROFILE_UNSUPPORTED',FRAME_NO_FRAME:'SCENE_KEYFRAME_UNAVAILABLE',FRAME_ATTEMPT_TIMEOUT:'SCENE_ATTEMPT_TIMEOUT'});
const internalCodes=new Set(['SCENE_RECORD_INVALID','SCENE_REVISION_CONFLICT','SCENE_OWNER_REQUIRED']);
const stopCodes=new Set(['MEDIA_CANCELLED','SCENE_INTERRUPTED','SCENE_SERVICE_STOPPED']);

/** Local-only, single-owner scene detection and storyboarding. The immutable
 * acknowledgement is committed before work is queued; startup and replay never
 * enter the queue. One task decodes at a time. A running task can be cancelled:
 * it becomes cancelling, its decoder is stopped, and it ends cancelled with no
 * result. A storyboard stages one keyframe per segment, publishes them, then
 * creates every image asset and shot in one transaction. */
export function createSceneServices(store: SceneStore,{signal:ownerSignal,detect=detectManagedScenes,decodeKeyframes=decodeSceneKeyframes,autoRun=true,fault=noop}: SceneServicesOptions={}): SceneService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.detect!==detect||old.decodeKeyframes!==decodeKeyframes||old.autoRun!==autoRun||old.fault!==fault)fail('SCENE_SERVICE_ACTIVE');return old.service;}
 const {db,root,tx}=store,queue: {id: string; projectId: string}[]=[],pending=new Set<string>(),active=new Set<Promise<unknown>>(),attemptSignals=new Set<AbortSignal>();
 const attempts=new Map<string,AbortController>(),progress=new Map<string,Record<string,number>>(),resumeRequested=new Set<string>();
 const controller=new AbortController(),signal: AbortSignal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reported=false,draining: Promise<void>|undefined;
 const registration: SceneOwnerRecord={root,signal:ownerSignal,detect,decodeKeyframes,autoRun,fault,service:undefined as unknown as SceneService};
 const history=createSceneHistoryReaders(store),{schemaPresent,project,asset,task,summary,latestResultId,prior}=history;
 const storage=createSceneShotsStorage(store);
 function owner({allowStopped=false}: {allowStopped?: boolean}={}): void {
  if(owners.get(db)!==registration||!ownsStoreLock(store))fail('SCENE_OWNER_REQUIRED',403);
  if(!allowStopped&&(stopped||signal.aborted))fail('SCENE_SERVICE_STOPPED',503);
 }
 function change<T extends SceneTaskView>(original: T,patch: Record<string,SQLInputValue>,{allowStopped=false}: {allowStopped?: boolean}={}): T {
  owner({allowStopped});const value=task(original.row.projectId,original.row.id);
  for(const key of ['revision','state','started','resultId','stagedReceipt','outcome'] as const)if(value.row[key]!==original.row[key])fail('SCENE_REVISION_CONFLICT');
  maxRevision(value.row.revision);
  if(Object.keys(patch).some(key=>!['state','started','resultId','errorCode','stagedReceipt','outcome'].includes(key)))throw Error('Invalid internal scene patch');
  const entries=Object.entries(patch),result=db.prepare(`UPDATE scene_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
   .run(...entries.map(([,entry])=>entry),now(),value.row.id,value.row.projectId,value.row.revision);
  if(result.changes!==1)fail('SCENE_REVISION_CONFLICT');return task(value.row.projectId,value.row.id) as T;
 }
 const count=(table: string,where: string,args: readonly SQLInputValue[],cap: number): number=>{
  const value=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1)?.n;
  return typeof value==='number'?value:0;
 };
 function capacity(projectId: string,{accept: accepting=false,taskId,assetId}: {accept?: boolean; taskId?: string; assetId?: string}={}): void {
  if(count('scene_requests','',[],SCENE_LIMITS.requestsGlobal)>=SCENE_LIMITS.requestsGlobal||count('scene_requests','projectId=?',[projectId],SCENE_LIMITS.requestsPerProject)>=SCENE_LIMITS.requestsPerProject||
   taskId&&count('scene_requests','taskId=?',[taskId],SCENE_LIMITS.requestsPerTask)>=SCENE_LIMITS.requestsPerTask)fail('SCENE_CAPACITY',507);
  if(assetId&&(count('scene_results','',[],SCENE_LIMITS.resultsGlobal)>=SCENE_LIMITS.resultsGlobal||count('scene_results','projectId=?',[projectId],SCENE_LIMITS.resultsPerProject)>=SCENE_LIMITS.resultsPerProject||
   count('scene_results','projectId=? AND assetId=?',[projectId,assetId],SCENE_LIMITS.resultsPerAsset)>=SCENE_LIMITS.resultsPerAsset))fail('SCENE_CAPACITY',507);
  if(!accepting)return;
  if(count('scene_tasks','',[],SCENE_LIMITS.tasksGlobal)>=SCENE_LIMITS.tasksGlobal||count('scene_tasks','projectId=?',[projectId],SCENE_LIMITS.tasksPerProject)>=SCENE_LIMITS.tasksPerProject)fail('SCENE_CAPACITY',507);
  if(count('scene_tasks',"state='queued'",[],SCENE_LIMITS.queuedGlobal)>=SCENE_LIMITS.queuedGlobal||count('scene_tasks',"state='queued' AND projectId=?",[projectId],SCENE_LIMITS.queuedPerProject)>=SCENE_LIMITS.queuedPerProject)fail('SCENE_QUEUE_FULL');
 }
 /** One scene task per video at a time; a storyboard in progress also locks the cut list. */
 function idle(projectId: string,assetId: string,{kind}: {kind?: 'shots'}={}): void {
  if(db.prepare(`SELECT 1 FROM scene_tasks WHERE projectId=? AND sourceAssetId=?${kind?' AND kind=?':''} AND state IN ${ACTIVE_STATES} LIMIT 1`).get(projectId,assetId,...(kind?[kind]:[])))fail('SCENE_TASK_ACTIVE');
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
 function touchProject(projectId: string): void {
  const value=project(projectId);maxRevision(value.revision);
  db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...value,revision:(value.revision as number)+1,updatedAt:now()}),projectId);
 }
 function accept(input: SceneDetectInput): SceneDetectTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.detect',input as unknown as SceneMutationInput);if(replay)return {value:replay as SceneDetectTaskResponse,replayed:true};
   const source=asset(input.projectId,input.sourceAssetId);
   if(source.sha256!==input.sourceHash)fail('SCENE_SOURCE_CHANGED');
   idle(input.projectId,input.sourceAssetId);
   capacity(input.projectId,{accept:true});
   const id=randomUUID(),options=normalizeSceneDetectionOptions(input.options as Parameters<typeof normalizeSceneDetectionOptions>[0]);
   const snapshot={schemaVersion:1,projectId:input.projectId,taskId:id,kind:'detect',
    source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration},
    options,profileId:SCENE_DETECTION_PROFILE_ID,fps:SOURCE_RANGE_FPS};
   if(!sceneSnapshotSchema.safeParse(snapshot).success)fail('SCENE_SOURCE_INVALID');
   sourceFile(source);
   const timestamp=now(),value={id,projectId:input.projectId,kind:'detect',requestId:input.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,
    options,profileId:SCENE_DETECTION_PROFILE_ID,fps:SOURCE_RANGE_FPS,state:'queued',revision:1,started:false,result:null,progress:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
   if(!sceneDetectTaskResponseSchema.safeParse(value).success)invalid();
   db.prepare("INSERT INTO scene_tasks(id,projectId,kind,sourceAssetId,requestId,inputHash,input,snapshot,state,revision,started,resultId,stagedReceipt,outcome,errorCode,createdAt,updatedAt) VALUES(?,?,'detect',?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,NULL,?,?)")
    .run(id,input.projectId,input.sourceAssetId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   record('scene.detect',input as unknown as SceneMutationInput,value,{taskId:id});task(input.projectId,id);
   return {value:value as SceneDetectTaskResponse,replayed:false};
  });
  if(!result.replayed){fault('after_acceptance',{input,response:result.value});enqueue(result.value.id,input.projectId);}
  return result.value;
 }
 // New shots follow the project's format; a project without a timeline yet
 // uses the default portrait format.
 function projectAspectRatio(projectId: string): SceneShotAspectRatio {
  const row=db.prepare("SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.width') END AS width,CASE WHEN json_valid(data) THEN json_extract(data,'$.height') END AS height FROM timelines WHERE projectId=? LIMIT 1").get(projectId);
  const width=row?.width,height=row?.height;
  if(typeof width!=='number'||typeof height!=='number'||!(width>0)||!(height>0))return '9:16';
  return width>height?'16:9':width<height?'9:16':'1:1';
 }
 function defaultOrigin(projectId: string): {x: number; y: number} {
  const lowest=(table: string): number|null=>{
   const value=db.prepare(`SELECT MAX(CASE WHEN json_valid(data) AND json_type(data,'$.position.y') IN ('integer','real') THEN json_extract(data,'$.position.y') END) AS y FROM ${table} WHERE projectId=?`).get(projectId)?.y;
   return typeof value==='number'&&Number.isFinite(value)?value:null;
  };
  const bottoms=[lowest('shots'),lowest('nodes')].filter((value): value is number=>value!==null);
  return {x:SCENE_SHOT_LAYOUT.left,y:bottoms.length?Math.max(...bottoms)+SCENE_SHOT_LAYOUT.gap:SCENE_SHOT_LAYOUT.top};
 }
 function acceptShots(input: SceneShotsInput): SceneShotsTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.shots.create',input as unknown as SceneMutationInput);if(replay)return {value:replay as SceneShotsTaskResponse,replayed:true};
   const source=asset(input.projectId,input.sourceAssetId);
   if(source.sha256!==input.sourceHash)fail('SCENE_SOURCE_CHANGED');
   idle(input.projectId,input.sourceAssetId);
   if(latestResultId(input.projectId,input.sourceAssetId)!==input.resultId)fail('SCENE_RESULT_CONFLICT');
   const base=history.result(input.projectId,input.resultId);
   if(base.sourceHash!==source.sha256||base.profileId!==SCENE_DETECTION_PROFILE_ID)fail('SCENE_RESULT_STALE');
   const cuts=base.cuts.map(cut=>cut.frame);
   const segments=input.segments.map(segment=>{const bounds=sceneSegmentBounds(cuts,base.frameCount,segment);if(!bounds)fail('SCENE_SEGMENTS_INVALID');return [segment,bounds[0],bounds[1]];});
   capacity(input.projectId,{accept:true});
   const id=randomUUID(),titlePrefix=input.titlePrefix??SCENE_SHOT_TITLE_PREFIX,aspectRatio=projectAspectRatio(input.projectId);
   const origin=input.position?{x:input.position.x,y:input.position.y}:defaultOrigin(input.projectId);
   const snapshot={schemaVersion:1,projectId:input.projectId,taskId:id,kind:'shots',
    source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration,width:source.width,height:source.height},
    resultId:base.id,frameCount:base.frameCount,frame:{profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,fps:SOURCE_RANGE_FPS},aspectRatio,titlePrefix,origin,segments};
   if(!sceneShotsSnapshotSchema.safeParse(snapshot).success)fail('SCENE_SOURCE_INVALID');
   sourceFile(source);
   const timestamp=now(),value={id,projectId:input.projectId,kind:'shots',requestId:input.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,resultId:base.id,
    segments:[...input.segments],titlePrefix,aspectRatio,state:'queued',revision:1,started:false,shots:null,progress:null,undo:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
   if(!sceneShotsTaskResponseSchema.safeParse(value).success)invalid();
   db.prepare("INSERT INTO scene_tasks(id,projectId,kind,sourceAssetId,requestId,inputHash,input,snapshot,state,revision,started,resultId,stagedReceipt,outcome,errorCode,createdAt,updatedAt) VALUES(?,?,'shots',?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,NULL,?,?)")
    .run(id,input.projectId,input.sourceAssetId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   // Mio's storyboard step owns this task: a stopped run retires it before it starts.
   bindAgentTaskJobInside(db,'scene',id);
   record('scene.shots.create',input as unknown as SceneMutationInput,value,{taskId:id});task(input.projectId,id);
   return {value:value as SceneShotsTaskResponse,replayed:false};
  });
  if(!result.replayed){fault('after_acceptance',{input,response:result.value});enqueue(result.value.id,input.projectId);}
  return result.value;
 }
 function cancel(input: SceneTaskRequest): SceneDetectTaskResponse|SceneShotsTaskResponse {
  const result=tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.task.cancel',input as unknown as SceneMutationInput);if(replay)return {value:replay as SceneDetectTaskResponse|SceneShotsTaskResponse,replayed:true};
   const target=task(input.projectId,input.taskId);if(target.row.revision!==input.expectedRevision)fail('SCENE_REVISION_CONFLICT');
   const unstarted=target.row.state==='queued'||target.row.state==='interrupted'&&!target.row.started;
   // A storyboard that is saving its result finishes or fails on its own.
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
 /** Staged keyframes, and any published file no asset row claimed, never outlive their task. */
 function discardShots(view: SceneTaskView): void {
  if(view.kind!=='shots')return;
  try{
   storage.discard(view.row.id,view.snapshot.segments.length);
   if(view.receipt&&!view.outcome)storage.withdraw(view.receipt.keyframes.map(keyframe=>keyframe.assetId),assetId=>Boolean(db.prepare('SELECT 1 FROM assets WHERE id=? LIMIT 1').get(assetId)));
  }catch{diagnose();}
 }
 /** A cancelling task with no live attempt in this process has no decoder to wait for. */
 function finishCancel(projectId: string,id: string): void {
  try{const ended=tx(()=>{const target=task(projectId,id);return target.row.state==='cancelling'?change(target,{state:'cancelled'},{allowStopped:true}):null;});if(ended)discardShots(ended);}catch{diagnose();}
 }
 function saveCuts(input: SceneCutsInput): SceneResultSummary {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.cuts.save',input as unknown as SceneMutationInput);if(replay)return replay as SceneResultSummary;
   const source=asset(input.projectId,input.assetId);
   if(source.sha256!==input.sourceHash)fail('SCENE_SOURCE_CHANGED');
   idle(input.projectId,input.assetId,{kind:'shots'});
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
 /** Removes the untouched shots of a built storyboard. Its keyframe images stay. */
 function undo(input: SceneTaskRequest): SceneShotsTaskResponse {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('scene.shots.undo',input as unknown as SceneMutationInput);if(replay)return replay as SceneShotsTaskResponse;
   const target=task(input.projectId,input.taskId);
   if(target.kind!=='shots')fail('SCENE_STATE_CONFLICT');
   if(target.row.revision!==input.expectedRevision)fail('SCENE_REVISION_CONFLICT');
   if(target.row.state!=='succeeded'||!target.outcome)fail('SCENE_STATE_CONFLICT');
   const state=history.undoState(target);
   if(!state.available)throw new AppError('SCENE_UNDO_BLOCKED',messages.SCENE_UNDO_BLOCKED!,409,{blockers:state.blockers});
   capacity(input.projectId,{taskId:target.row.id});
   for(const shotId of target.outcome.shotIds)if(db.prepare('DELETE FROM shots WHERE id=? AND projectId=?').run(shotId,input.projectId).changes!==1)invalid();
   touchProject(input.projectId);
   const value=change(target,{state:'undone'}).dto;
   record('scene.shots.undo',input as unknown as SceneMutationInput,value,{taskId:target.row.id});
   return value;
  });
 }
 function diagnose(): void {if(!reported){reported=true;console.error('Skipped invalid local scene record.');}}
 /** Moves a task that stopped early to its end state; failures keep their code. */
 function settle(view: SceneTaskView,cause: unknown,fallback: string): SceneTaskView|null {
  return tx(()=>{
   const checked=task(view.row.projectId,view.row.id);
   if(checked.row.state==='cancelling')return change(checked,{state:'cancelled'},{allowStopped:true});
   if(!['queued','running','persisting'].includes(checked.row.state))return checked;
   const code=property(cause,'code'),mapped=typeof code==='string'?decoderCodes[code]??code:'';
   if(stopped||signal.aborted||property(cause,'terminationUnconfirmed')||stopCodes.has(mapped))return change(checked,{state:'interrupted',errorCode:'SCENE_INTERRUPTED'},{allowStopped:true});
   const errorCode=Object.hasOwn(messages,mapped)&&!internalCodes.has(mapped)?mapped:fallback;
   // Only a staged storyboard can fail while saving its result.
   return change(checked,checked.row.state==='persisting'?{state:'local_result_error',errorCode:errorCode==='SCENE_SHOTS_FAILED'?'SCENE_STORAGE_FAILED':errorCode}:{state:'failed',errorCode},{allowStopped:true});
  });
 }
 /** The start fence, inside the decoder just before its first child process. */
 function starter(entry: {id: string; projectId: string},before: {info: ManagedFileIdentity},state: {original: SceneTaskView; registered?: AbortSignal; gate: ()=>void}) {
  return (attemptSignal: AbortSignal): void=>{
   state.gate();
   if(!attemptSignal||typeof attemptSignal.addEventListener!=='function'||attemptSignal.aborted)fail('SCENE_INTERRUPTED');
   if(state.registered&&state.registered!==attemptSignal)invalid();state.registered=attemptSignal;attemptSignals.add(attemptSignal);
   state.original=tx(()=>{
    const value=task(entry.projectId,entry.id);sourceFence(value,before.info);
    if(value.row.state==='queued')return change(value,{state:'running',started:1,errorCode:null});
    if(value.row.state!=='running'||!value.row.started)fail('SCENE_INTERRUPTED');return value;
   });
   fault('after_start_fence',{taskId:entry.id});
  };
 }
 async function executeDetect(entry: {id: string; projectId: string},queued: SceneDetectView,attempt: AbortController,state: {original: SceneTaskView; registered?: AbortSignal; gate: ()=>void}): Promise<void> {
  const before=sourceFence(queued);
  const detected=await detect({root,asset:before.source,file:before.file,info:before.info as unknown as Record<string,unknown>,options:queued.snapshot.options,
   signal:AbortSignal.any([signal,attempt.signal]),beforeSpawn:starter(entry,before,state),
   onProgress:value=>{progress.set(entry.id,{frames:value.frames,frameCount:value.frameCount,cuts:value.cuts.length});}});
  fault('after_detection',{taskId:entry.id});
  tx(()=>{
   const value=task(entry.projectId,entry.id);
   // A cancel that arrived after the decoder finished still wins.
   if(value.row.state==='cancelling'){change(value,{state:'cancelled'},{allowStopped:true});return;}
   if(value.kind!=='detect'||value.row.state!=='running'||value.row.revision!==state.original.row.revision)fail('SCENE_REVISION_CONFLICT');
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
 }
 async function executeShots(entry: {id: string; projectId: string},queued: SceneShotsView,attempt: AbortController,state: {original: SceneTaskView; registered?: AbortSignal; gate: ()=>void}): Promise<void> {
  const before=sourceFence(queued),plan=sceneShotPlan(queued.snapshot),attemptSignal=AbortSignal.any([signal,attempt.signal]);
  progress.set(entry.id,{done:0,total:plan.length});
  const decoded=await decodeKeyframes({root,asset:before.source,file:before.file,info:before.info as unknown as Record<string,unknown>,marks:plan.map(item=>item.sourceFrame),
   signal:attemptSignal,beforeSpawn:starter(entry,before,state),
   onFrame:frame=>{for(const position of frame.marks)storage.stage(entry.id,position,frame.bytes);progress.set(entry.id,{done:frame.marks.at(-1)!+1,total:plan.length});}});
  fault('after_keyframes',{taskId:entry.id});
  if(decoded.sourceHash!==queued.input.sourceHash||decoded.profileId!==FRAME_PROFILE_ID||decoded.selectionRule!==FRAME_SELECTION_RULE||decoded.frameOf.length!==plan.length)fail('SCENE_SHOTS_FAILED');
  const keyframes=[];
  for(const [index,item] of plan.entries()){
   const bytes=storage.staged(entry.id,index);
   try{await validatePng(bytes,{width:decoded.width,height:decoded.height,opaque:true,signal:attemptSignal});}catch(cause){if(attemptSignal.aborted)throw cause;fail('SCENE_SHOTS_FAILED');}
   keyframes.push({segment:item.segment,sourceFrame:item.sourceFrame,assetId:randomUUID(),sha256:digest(bytes),width:decoded.width,height:decoded.height,byteLength:bytes.length});
  }
  const receipt={schemaVersion:1,projectId:entry.projectId,taskId:entry.id,inputHash:queued.row.inputHash,sourceAssetId:queued.input.sourceAssetId,sourceHash:queued.input.sourceHash,
   profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,fps:SOURCE_RANGE_FPS,probe:decoded.probe,keyframes};
  if(!sceneShotsReceiptSchema.safeParse(receipt).success)fail('SCENE_SHOTS_FAILED');
  const staged=tx(()=>{
   const value=task(entry.projectId,entry.id);
   if(value.row.state==='cancelling')return change(value,{state:'cancelled'},{allowStopped:true});
   if(value.kind!=='shots'||value.row.state!=='running'||value.row.revision!==state.original.row.revision)fail('SCENE_REVISION_CONFLICT');
   sourceFence(value,before.info);
   return change(value,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null});
  });
  state.original=staged;fault('after_shots_receipt',{taskId:entry.id});
  if(staged.row.state!=='persisting'){discardShots(staged);return;}
  const saved=receipt as SceneShotsReceipt;
  for(const [index,keyframe] of saved.keyframes.entries()){if(attemptSignal.aborted)fail('SCENE_INTERRUPTED');storage.publish(keyframe.assetId,storage.staged(entry.id,index));}
  fault('after_media_publication',{taskId:entry.id});
  const built=tx(()=>{
   const value=task(entry.projectId,entry.id);
   if(value.kind!=='shots'||value.row.state!=='persisting'||value.row.revision!==staged.row.revision)fail('SCENE_REVISION_CONFLICT');
   sourceFence(value,before.info);
   const timestamp=now(),projectId=entry.projectId,snapshot=value.snapshot;
   const order=Number(db.prepare("SELECT COALESCE(MAX(CASE WHEN json_valid(data) AND json_type(data,'$.orderIndex')='integer' THEN json_extract(data,'$.orderIndex') END),-1)+1 AS n FROM shots WHERE projectId=?").get(projectId)!.n);
   const shotIds=plan.map(()=>randomUUID());
   for(const [index,item] of plan.entries()){
    const keyframe=saved.keyframes[index]!;
    const image={id:keyframe.assetId,projectId,name:`${item.title}.png`,mimeType:'image/png',sha256:keyframe.sha256,width:keyframe.width,height:keyframe.height,sizeBytes:keyframe.byteLength,
     relativePath:`media/${keyframe.assetId}.png`,url:`/media/${keyframe.assetId}`,provenance:SCENE_KEYFRAME_PROVENANCE,createdAt:timestamp};
    db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(image.id,projectId,JSON.stringify(image));
    const shot={id:shotIds[index]!,projectId,title:item.title,prompt:'',referenceAssetIds:[keyframe.assetId],aspectRatio:snapshot.aspectRatio,duration:item.duration,parameters:{},
     position:item.position,orderIndex:order+index,revision:1,selectedVersionId:null,createdAt:timestamp,updatedAt:timestamp};
    db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(shot.id,projectId,JSON.stringify(shot));
   }
   touchProject(projectId);
   const outcome={schemaVersion:1,shotIds,createdAt:timestamp};
   if(!sceneShotsOutcomeSchema.safeParse(outcome).success)invalid();
   const done=change(value,{state:'succeeded',outcome:canonical(outcome),errorCode:null});
   fault('before_shots_commit',{taskId:entry.id});return done;
  });
  discardShots(built);
 }
 // An Assistant-bound task whose run journal is not ready yet stays queued.
 function execute(entry: {id: string; projectId: string}): Promise<void> {
  try{return withAgentTaskJobOrigin(db,'scene',entry.id,()=>executeInside(entry));}catch(cause){return Promise.reject(cause);}
 }
 async function executeInside(entry: {id: string; projectId: string}): Promise<void> {
  let queued: SceneTaskView|undefined,blockedGate=false;
  const attempt=new AbortController();
  const state: {original: SceneTaskView; registered?: AbortSignal; gate: ()=>void}={original:undefined as unknown as SceneTaskView,
   gate:()=>{try{assertAgentTaskJobEffect(db,'scene',entry.id);}catch(error){if(isAgentTaskEffectBlocked(error))blockedGate=true;throw error;}}};
  try{
   owner();queued=task(entry.projectId,entry.id);state.original=queued;
   if(queued.row.state!=='queued')return;
   state.gate();
   attempts.set(entry.id,attempt);
   if(queued.kind==='detect')await executeDetect(entry,queued,attempt,state);
   else await executeShots(entry,queued,attempt,state);
  }catch(cause){
   if(queued)try{
    const checked=task(entry.projectId,entry.id);
    // An unstarted task an Assistant gate held back waits for its run to resume.
    if(!checked.row.started&&checked.row.state==='queued'&&(blockedGate||isAgentTaskEffectBlocked(cause))){
     if(isAgentTaskJobStopped(db,'scene',entry.id)){const ended=tx(()=>change(checked,{state:'cancelled_before_start',errorCode:null},{allowStopped:true}));discardShots(ended);}
     return;
    }
    const ended=settle(checked,cause,checked.kind==='shots'?'SCENE_SHOTS_FAILED':'SCENE_DETECTION_FAILED');
    if(ended&&!['succeeded','undone'].includes(ended.row.state))discardShots(ended);
   }catch{diagnose();}
  }finally{
   attempts.delete(entry.id);progress.delete(entry.id);
   // A decoder error is not evidence of child close. This attempt owns the
   // active slot until every owned process has closed.
   if(state.registered){await waitForMediaProcesses({signal:state.registered});attemptSignals.delete(state.registered);}
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
  try{owner();if(db.prepare(`SELECT 1 FROM scene_tasks WHERE state IN ('running','cancelling','persisting') LIMIT 1`).get())return;}catch{diagnose();return;}
  queue.shift();running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;if(resumeRequested.delete(entry.id))enqueue(entry.id,entry.projectId);pump();});active.add(promise);void promise.catch(diagnose);
 }
 function reconcile(): void {
  if(!ownsStoreLock(store)||!schemaPresent())return;
  const rows=db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END AS id,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId FROM scene_tasks WHERE state IN ${ACTIVE_STATES} ORDER BY id LIMIT ?`)
   .all(SCENE_LIMITS.queuedGlobal+SCENE_LIMITS.activeGlobal+1);
  if(rows.length>SCENE_LIMITS.queuedGlobal+SCENE_LIMITS.activeGlobal){diagnose();return;}
  for(const row of rows)try{
   const target=task(String(row.projectId),String(row.id));
   // An Assistant's accepted storyboard waits for its run to resume or stop.
   if(target.row.state==='queued'&&!target.row.started&&agentTaskJobBinding(db,'scene',target.row.id))continue;
   const ended=tx(()=>change(target,target.row.state==='cancelling'?{state:'cancelled'}:{state:'interrupted',errorCode:'SCENE_INTERRUPTED'}));
   discardShots(ended);
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
    if(operation==='scene.detect'||operation==='scene.shots.create')asset(input.projectId,String(input.sourceAssetId));
    else if(operation==='scene.cuts.save')asset(input.projectId,String(input.assetId));
    else task(input.projectId,String(input.taskId));
    if(db.prepare('SELECT 1 FROM scene_requests WHERE requestId=? LIMIT 1').get(input.requestId))return null;
    return {status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)};
   });
   if(proof){cause.details={...(isRecord(cause.details)?cause.details:{}),sceneOutcome:proof};verifiedRefusals.set(cause,proof);}
  }catch{/* Unknown scope, owner, storage or commit outcome remains unknown. */}
 }
 const mutations: Record<string,(input: never)=>unknown>={
  'scene.detect':(input: SceneDetectInput)=>accept(input),
  'scene.task.cancel':(input: SceneTaskRequest)=>cancel(input),
  'scene.cuts.save':(input: SceneCutsInput)=>saveCuts(input),
  'scene.shots.create':(input: SceneShotsInput)=>acceptShots(input),
  'scene.shots.undo':(input: SceneTaskRequest)=>undo(input),
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
 const removeResumer=setAgentTaskJobResumer(db,'scene',runId=>{for(const row of db.prepare("SELECT t.id,t.projectId FROM scene_tasks t JOIN agent_task_job_origins_v2 o ON o.kind='scene' AND o.jobId=t.id AND o.projectId=t.projectId WHERE o.runId=? AND t.state='queued' AND t.started=0 ORDER BY t.createdAt,t.id").all(runId)){if(pending.has(String(row.id)))resumeRequested.add(String(row.id));else enqueue(String(row.id),String(row.projectId));}});
 const removeStopper=setAgentTaskJobStopper(db,'scene',(runId,stepId)=>{for(const row of db.prepare("SELECT t.id,t.projectId,t.revision FROM scene_tasks t JOIN agent_task_job_origins_v2 o ON o.kind='scene' AND o.jobId=t.id AND o.projectId=t.projectId WHERE o.runId=? AND (? IS NULL OR o.stepId=?) AND t.state IN ('queued','interrupted') AND t.started=0 ORDER BY t.id").all(runId,stepId??null,stepId??null))withAgentTaskJobOrigin(db,'scene',String(row.id),()=>{
  try{handlers['scene.task.cancel']!({projectId:String(row.projectId),taskId:String(row.id),expectedRevision:Number(row.revision),requestId:`agent-stop:${runId}:${String(row.id)}`});}
  catch(error){if(property(error,'code')!=='SCENE_CAPACITY')throw error;
   // The stop needs no receipt of its own when the request quota is full; the
   // same unstarted-state guard applies.
   tx(()=>{const target=task(String(row.projectId),String(row.id));if(!target.row.started&&['queued','interrupted'].includes(target.row.state))change(target,{state:'cancelled_before_start',errorCode:null});});
  }
 });});
 function drain(): Promise<void> {
  removeResumer();removeStopper();if(draining)return draining;stopped=true;controller.abort();queue.length=0;
  const result=boundedShutdown((async()=>{
   const results=await Promise.all([...attemptSignals].map(attemptSignal=>terminateMediaProcesses({signal:attemptSignal})));assertMediaTerminated(results.flat());
   await Promise.allSettled([...active]);if([...attemptSignals].some(attemptSignal=>hasUnconfirmedMediaProcesses({signal:attemptSignal})))assertMediaTerminated([{status:'unconfirmed'}]);
  })(),'SCENE_STOP_TIMEOUT');draining=result;void result.catch(()=>{if(draining===result)draining=undefined;});return result;
 }
 const service: SceneService={handlers,drain};registration.service=service;owners.set(db,registration);
 try{reconcile();}catch(cause){owners.delete(db);removeResumer();removeStopper();throw cause;}return service;
}

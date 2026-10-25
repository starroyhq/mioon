import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync,SQLOutputValue} from 'node:sqlite';
import {AppError,SCENE_DETECTION_PROFILE_ID,SCENE_LIMITS,SCENE_SHOT_CONTENT_FIELDS,SCENE_SHOT_TITLE_PREFIX,sceneSchemas,sceneSnapshotSchema,sceneShotsSnapshotSchema,
 sceneShotsReceiptSchema,sceneShotsOutcomeSchema,sceneDetectTaskResponseSchema,sceneShotsTaskResponseSchema,sceneResultSchema,sceneResultSummarySchema,
 sceneResultResponseSchema,sceneRequestResponseSchema,isSceneMutationResponse,sceneShotPlan,canonicalSceneInput as canonical} from '@mioon/contracts';
import type {SceneDetectTaskResponse,SceneShotsTaskResponse,SceneResult,SceneResultSummary,SceneResultResponse,SceneTaskSnapshot,SceneShotsSnapshot,
 SceneShotsReceipt,SceneShotsOutcome,SceneUndoBlocker} from '@mioon/contracts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {sceneKeyframeAssetMatches} from './scene-keyframe-ownership.ts';

export const sceneServiceMessages: Readonly<Record<string,string>>=Object.freeze({
 SCENE_NOT_FOUND:'The scene record is unavailable for this project.',SCENE_RECORD_INVALID:'The saved scene record cannot be verified safely.',
 SCENE_REQUEST_CONFLICT:'This request ID was already used for a different scene operation or input.',SCENE_REVISION_CONFLICT:'The scene task changed. Read it again before choosing an action.',
 SCENE_STATE_CONFLICT:'The scene task does not allow this action.',SCENE_CAPACITY:'The retained scene task, result or request capacity is full.',
 SCENE_QUEUE_FULL:'The local scene queue is full. Try a new request later.',SCENE_TASK_ACTIVE:'This video already has a scene detection or storyboard in progress.',
 SCENE_OWNER_REQUIRED:'Scene detection requires the current exclusive workspace owner.',SCENE_SERVICE_STOPPED:'The scene service has stopped. Reopen the workspace to inspect the original task.',
 SCENE_SERVICE_ACTIVE:'This store already owns a different scene service.',SCENE_SCHEMA_REQUIRED:'The scene schema is unavailable.',
 SCENE_SOURCE_INVALID:'The managed source does not meet the local scene detection profile.',SCENE_SOURCE_CHANGED:'The managed source changed after the scene request was prepared.',
 SCENE_RESULT_CONFLICT:'A newer scene result exists for this video. Read it again first.',SCENE_RESULT_STALE:'The scene result no longer matches its source or scoring profile.',
 SCENE_CUTS_INVALID:'Cuts must be strictly increasing frames inside the source.',
 SCENE_CUTS_LIMIT:'The detected cuts exceed the scene result limit. Lower the sensitivity or raise the shortest shot.',
 SCENE_SEGMENTS_INVALID:'The chosen segments are not segments of this scene result.',
 SCENE_UNDO_BLOCKED:'Some shots of this storyboard were generated, edited, connected or bound to a subject, so it can no longer be undone.',
 SCENE_DETECTION_FAILED:'Local scene detection failed.',SCENE_INTERRUPTED:'The local scene task was interrupted. No automatic retry will occur.',
 SCENE_PROFILE_UNSUPPORTED:'The source does not match the supported local scene detection profile.',SCENE_DECODE_INCOMPLETE:'The decoded frames do not cover the source duration.',
 SCENE_ATTEMPT_TIMEOUT:'Local scene detection exceeded its time limit.',MEDIA_TERMINATION_UNCONFIRMED:'An owned media process has not confirmed its close.',
 SCENE_SHOTS_FAILED:'The storyboard keyframes could not be captured. No shots were created.',
 SCENE_KEYFRAME_UNAVAILABLE:'No decodable frame exists at a chosen segment\'s middle. No shots were created.',
 SCENE_STORAGE_FAILED:'The storyboard keyframes could not be saved. No shots were created.',
});
export const sceneServiceFailure=(code: string,status=409): AppError=>new AppError(code,sceneServiceMessages[code]??sceneServiceMessages.SCENE_DETECTION_FAILED??'',status);
function fail(code: string,status?: number): never {throw sceneServiceFailure(code,status);}
function missing(): never {return fail('SCENE_NOT_FOUND',404);}
function invalid(): never {return fail('SCENE_RECORD_INVALID');}
const text=(name: string,max: number,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const integer=(name: string,max: number): string=>`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${max} THEN ${name} ELSE -1 END AS ${name}`;
const taskColumns=[text('id',36),text('projectId',36),text('kind',16),text('sourceAssetId',36),text('requestId',800),text('inputHash',64),text('input',SCENE_LIMITS.inputBytes),
 text('snapshot',SCENE_LIMITS.snapshotBytes),text('state',40),integer('revision',Number.MAX_SAFE_INTEGER),integer('started',1),text('resultId',36,true),
 text('stagedReceipt',SCENE_LIMITS.receiptBytes,true),text('outcome',SCENE_LIMITS.outcomeBytes,true),text('errorCode',80,true),text('createdAt',40),text('updatedAt',40)].join(',');
const requestColumns=[text('requestId',800),text('operation',80),text('projectId',36),text('taskId',36,true),text('resultId',36,true),text('inputHash',64),
 text('canonicalInput',SCENE_LIMITS.inputBytes),text('response',SCENE_LIMITS.responseBytes)].join(',');
const resultColumns=[text('id',36),text('projectId',36),text('assetId',36),integer('position',Number.MAX_SAFE_INTEGER),text('sourceHash',64),text('origin',16),
 text('taskId',36,true),text('basedOnResultId',36,true),text('requestId',800,true),text('profileId',40),integer('fps',30),integer('frameCount',SCENE_LIMITS.frameCount),
 text('options',1024,true),text('cuts',SCENE_LIMITS.cutsBytes),text('createdAt',40)].join(',');
const readErrors: Readonly<Record<string,[string,number]>>=Object.freeze({VALIDATION_ERROR:['Invalid scene operation input.',400],INVALID_CURSOR:['Invalid or expired scene cursor.',400],
 INSPECTION_UNAVAILABLE:['Scene source data is unavailable.',404],INSPECTION_BUDGET_EXCEEDED:['Scene source inspection exceeded its safe budget.',429]});
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const errorProperty=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
export function safeSceneFailure(cause: unknown): {code: string; message: string; status: number} {
 const rawCode=errorProperty(cause,'code');
 const code=typeof rawCode==='string'&&Object.hasOwn(sceneServiceMessages,rawCode)?rawCode:'SCENE_DETECTION_FAILED';
 const rawStatus=errorProperty(cause,'status');
 return {code,message:sceneServiceMessages[code]??'',status:typeof rawStatus==='number'&&Number.isInteger(rawStatus)&&rawStatus>=400&&rawStatus<=599?rawStatus:503};
}
export function scenePublicFailure(cause: unknown,details: Record<string,unknown>={}): AppError {
 const rawCode=errorProperty(cause,'code');
 const read=typeof rawCode==='string'&&Object.hasOwn(readErrors,rawCode)?readErrors[rawCode]:null;if(read)return new AppError(rawCode as string,read[0],read[1]);
 const safe=safeSceneFailure(cause);
 // Undo refusals name the blocking shots; nothing else leaves a scene error.
 const blockers=safe.code==='SCENE_UNDO_BLOCKED'?errorProperty(errorProperty(cause,'details'),'blockers'):undefined;
 return new AppError(safe.code,safe.message,safe.status,{...(Array.isArray(blockers)?{blockers}:{}),...details});
}
const sha=(value: string): string=>createHash('sha256').update(value).digest('hex');
function decode(value: unknown): unknown {if(typeof value!=='string')invalid();try{return JSON.parse(value);}catch{return invalid();}}
function parsed<T>(schema: {safeParse(value: unknown): {success: true; data: T} | {success: false}},value: unknown): T {
 const result=schema.safeParse(decode(value));if(!result.success)invalid();return result.data;
}

export interface SceneDetectInput {readonly projectId: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly options?: Record<string,unknown>; readonly requestId: string}
export interface SceneShotsInput {
 readonly projectId: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly resultId: string; readonly segments: readonly number[];
 readonly titlePrefix?: string; readonly position?: {readonly x: number; readonly y: number}; readonly requestId: string;
}
export interface SceneTaskRow {
 readonly id: string; readonly projectId: string; readonly kind: string; readonly sourceAssetId: string; readonly requestId: string; readonly inputHash: string;
 readonly input: string; readonly snapshot: string; readonly state: string; readonly revision: number; readonly started: number; readonly resultId: string | null;
 readonly stagedReceipt: string | null; readonly outcome: string | null; readonly errorCode: string | null; readonly createdAt: string; readonly updatedAt: string;
}
export interface SceneDetectView {readonly kind: 'detect'; readonly row: SceneTaskRow; readonly input: SceneDetectInput; readonly snapshot: SceneTaskSnapshot; readonly dto: SceneDetectTaskResponse}
export interface SceneShotsView {
 readonly kind: 'shots'; readonly row: SceneTaskRow; readonly input: SceneShotsInput; readonly snapshot: SceneShotsSnapshot;
 readonly receipt: SceneShotsReceipt | null; readonly outcome: SceneShotsOutcome | null; readonly dto: SceneShotsTaskResponse;
}
export type SceneTaskView=SceneDetectView|SceneShotsView;
export interface SceneUndoState {readonly available: boolean; readonly blockers: SceneUndoBlocker[]}
export interface SceneHistoryReaders {
 readonly handlers: Readonly<Record<string,(input: unknown)=>unknown>>;
 schemaPresent(): boolean;
 project(projectId: string): Record<string, unknown>;
 asset(projectId: string,assetId: string,graph?: MediaGraph): Record<string, unknown>;
 task(projectId: string,id: string,graph?: MediaGraph): SceneTaskView;
 result(projectId: string,id: string): SceneResult;
 summary(projectId: string,id: string): SceneResultSummary;
 latestResultId(projectId: string,assetId: string): string | null;
 prior(operation: string,input: Record<string,unknown> & {projectId: string; requestId: string}): unknown;
 undoState(view: SceneShotsView): SceneUndoState;
}
type MediaGraph=ReturnType<typeof createOwnedMediaGraphReader>;
const revisionFloor: Readonly<Record<string,number>>=Object.freeze({queued:1,running:2,cancelling:3,succeeded:3,cancelled:4,cancelled_before_start:2,interrupted:2,failed:2});
// queued 1 -> running 2 -> persisting 3 -> succeeded 4 -> undone 5.
const shotsRevisionFloor: Readonly<Record<string,number>>=Object.freeze({queued:1,running:2,cancelling:3,persisting:3,succeeded:4,undone:5,cancelled:4,
 cancelled_before_start:2,interrupted:2,failed:2,local_result_error:4});

/** Saved metadata only. No decoder, file I/O, startup reconciliation or queue
 * is reachable; the live service and restored workspaces share these readers. */
export function createSceneHistoryReaders({db}: {db: DatabaseSync}): SceneHistoryReaders {
 const secret=randomBytes(32);
 function schemaPresent(): boolean {
  const n=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('scene_tasks','scene_requests','scene_results')").get()?.n;
  if(n===3)return true;if(n||db.prepare('SELECT 1 FROM schema_version WHERE version=58').get())invalid();return false;
 }
 function project(projectId: string): Record<string, unknown> {
  const row=db.prepare(`SELECT ${text('data',16384)} FROM projects WHERE id=? LIMIT 1`).get(projectId);let value: unknown;
  try{value=JSON.parse(String(row?.data));}catch{return missing();}
  if(!isRecord(value)||value.id!==projectId)missing();return value;
 }
 function asset(projectId: string,assetId: string,graph?: MediaGraph): Record<string, unknown> {
  if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND projectId=? LIMIT 1').get(assetId,projectId))missing();
  return (graph??createOwnedMediaGraphReader(db,projectId)).asset(assetId) as unknown as Record<string, unknown>;
 }
 // A raw asset row, for keyframes only: the media graph validates keyframes
 // through this task's receipt, so it cannot be used here.
 function assetRow(projectId: string,assetId: string): Record<string, unknown> | null {
  const row=db.prepare(`SELECT ${text('projectId',36)},${text('data',65536)} FROM assets WHERE id=? LIMIT 1`).get(assetId);
  if(!row)return null;if(row.projectId!==projectId)invalid();
  const value=decode(row.data);return isRecord(value)?value:invalid();
 }
 function resultRow(id: string): Record<string, SQLOutputValue> {
  const rows=db.prepare(`SELECT ${resultColumns} FROM scene_results WHERE id=? LIMIT 2`).all(id);if(rows.length!==1)invalid();return rows[0]!;
 }
 function result(projectId: string,id: string): SceneResult {
  const row=resultRow(id);
  if(row.id!==id||row.projectId!==projectId)invalid();
  const value={id:row.id,projectId:row.projectId,assetId:row.assetId,sourceHash:row.sourceHash,origin:row.origin,taskId:row.taskId,basedOnResultId:row.basedOnResultId,
   requestId:row.requestId,profileId:row.profileId,fps:row.fps,frameCount:row.frameCount,createdAt:row.createdAt,
   options:row.options===null?null:decode(row.options),cuts:decode(row.cuts)};
  if(!sceneResultSchema.safeParse(value).success)invalid();
  // Detections belong to their own succeeded task; manual saves to a base of
  // the same source, profile and length (the insert trigger checked both).
  if(row.origin==='detected'&&!db.prepare("SELECT 1 FROM scene_tasks WHERE id=? AND projectId=? AND kind='detect' AND sourceAssetId=? AND state='succeeded' AND resultId=? AND json_extract(input,'$.sourceHash') IS ?").get(row.taskId,projectId,row.assetId,id,row.sourceHash))invalid();
  if(row.origin==='manual'&&(!db.prepare('SELECT 1 FROM scene_results WHERE id=? AND projectId=? AND assetId=? AND sourceHash=? AND profileId=? AND frameCount=? AND position<?').get(row.basedOnResultId,projectId,row.assetId,row.sourceHash,row.profileId,row.frameCount,row.position)||
   !db.prepare("SELECT 1 FROM scene_requests WHERE requestId=? AND projectId=? AND operation='scene.cuts.save' AND resultId=?").get(row.requestId,projectId,id)))invalid();
  return value as unknown as SceneResult;
 }
 function summary(projectId: string,id: string): SceneResultSummary {
  const {options:_options,cuts,...rest}=result(projectId,id),value={...rest,cutCount:cuts.length};
  if(!sceneResultSummarySchema.safeParse(value).success)invalid();return value;
 }
 function latestResultId(projectId: string,assetId: string): string | null {
  const row=db.prepare(`SELECT ${text('id',36)} FROM scene_results WHERE projectId=? AND assetId=? ORDER BY position DESC LIMIT 1`).get(projectId,assetId);
  if(!row)return null;if(typeof row.id!=='string')invalid();return row.id;
 }
 /** The immutable acceptance receipt is the task as it was queued. */
 function acceptance(row: SceneTaskRow,operation: string,ack: unknown): void {
  const requests=db.prepare(`SELECT ${requestColumns} FROM scene_requests WHERE requestId=? LIMIT 2`).all(row.requestId);if(requests.length!==1)invalid();const request=requests[0]!;
  if(request.projectId!==row.projectId||request.taskId!==row.id||request.operation!==operation||request.inputHash!==row.inputHash||request.canonicalInput!==row.input)invalid();
  if(request.response!==canonical(ack))invalid();
 }
 function task(projectId: string,id: string,graph?: MediaGraph): SceneTaskView {
  project(projectId);
  const rows=db.prepare(`SELECT ${taskColumns} FROM scene_tasks WHERE id=? LIMIT 2`).all(id);if(!rows.length)missing();if(rows.length!==1)invalid();
  const row=rows[0] as unknown as SceneTaskRow;
  if(row.id!==id||row.projectId!==projectId)missing();
  if(typeof row.revision!=='number'||row.revision<1||![0,1].includes(row.started))invalid();
  if(row.kind==='shots')return shotsTask(projectId,row,graph);
  if(row.kind!=='detect'||row.stagedReceipt!==null||row.outcome!==null)invalid();
  const input=parsed(sceneSchemas['scene.detect'],row.input) as SceneDetectInput,snapshot=parsed(sceneSnapshotSchema,row.snapshot);
  const exact=canonical(input);
  if(row.input!==exact||row.inputHash!==sha(exact)||input.projectId!==projectId||input.requestId!==row.requestId||input.sourceAssetId!==row.sourceAssetId||
   snapshot.projectId!==projectId||snapshot.taskId!==id||snapshot.source.assetId!==input.sourceAssetId||snapshot.source.sha256!==input.sourceHash)invalid();
  if(row.revision<(revisionFloor[row.state]??Number.MAX_SAFE_INTEGER)||row.state==='queued'&&row.updatedAt!==row.createdAt||Date.parse(row.updatedAt)<Date.parse(row.createdAt))invalid();
  let summaryValue=null;
  if(row.resultId!==null){
   const saved=summary(projectId,row.resultId);
   if(saved.origin!=='detected'||saved.taskId!==id||saved.assetId!==row.sourceAssetId)invalid();
   summaryValue={id:saved.id,frameCount:saved.frameCount,cutCount:saved.cutCount};
  }
  const dto={id,projectId,kind:'detect' as const,requestId:row.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,
   options:{mode:snapshot.options.mode,sensitivity:snapshot.options.sensitivity,minShotSeconds:snapshot.options.minShotSeconds},profileId:snapshot.profileId,fps:snapshot.fps,
   state:row.state,revision:row.revision,started:row.started===1,result:summaryValue,progress:null,errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt};
  if(!sceneDetectTaskResponseSchema.safeParse(dto).success)invalid();
  acceptance(row,'scene.detect',{...dto,state:'queued',revision:1,started:false,result:null,errorCode:null,updatedAt:row.createdAt});
  // Size and probe metadata may be refreshed; the frozen identity may not.
  const source=asset(projectId,input.sourceAssetId,graph);
  if(source.sha256!==snapshot.source.sha256||source.mimeType!==snapshot.source.mimeType||source.relativePath!==snapshot.source.relativePath)invalid();
  return {kind:'detect',row,input,snapshot:snapshot as SceneTaskSnapshot,dto:dto as SceneDetectTaskResponse};
 }
 function shotsTask(projectId: string,row: SceneTaskRow,graph?: MediaGraph): SceneShotsView {
  const id=row.id;
  if(row.resultId!==null)invalid();
  const input=parsed(sceneSchemas['scene.shots.create'],row.input) as SceneShotsInput,snapshot=parsed(sceneShotsSnapshotSchema,row.snapshot) as SceneShotsSnapshot;
  const receipt=row.stagedReceipt===null?null:parsed(sceneShotsReceiptSchema,row.stagedReceipt) as SceneShotsReceipt;
  const outcome=row.outcome===null?null:parsed(sceneShotsOutcomeSchema,row.outcome) as SceneShotsOutcome;
  const exact=canonical(input);
  if(row.input!==exact||row.inputHash!==sha(exact)||input.projectId!==projectId||input.requestId!==row.requestId||input.sourceAssetId!==row.sourceAssetId||
   snapshot.projectId!==projectId||snapshot.taskId!==id||snapshot.source.assetId!==input.sourceAssetId||snapshot.source.sha256!==input.sourceHash||
   snapshot.resultId!==input.resultId||snapshot.titlePrefix!==(input.titlePrefix??SCENE_SHOT_TITLE_PREFIX)||
   canonical(snapshot.segments.map(([segment])=>segment))!==canonical(input.segments)||input.position!==undefined&&canonical(snapshot.origin)!==canonical(input.position))invalid();
  if(row.revision<(shotsRevisionFloor[row.state]??Number.MAX_SAFE_INTEGER)||row.state==='queued'&&row.updatedAt!==row.createdAt||Date.parse(row.updatedAt)<Date.parse(row.createdAt))invalid();
  // Keyframes are staged before persisting and kept by every later state; a
  // running task interrupted before staging has none.
  const staged=['persisting','succeeded','undone','local_result_error'].includes(row.state);
  if(staged&&!receipt||receipt&&(!row.started||!staged&&row.state!=='interrupted'))invalid();
  const plan=sceneShotPlan(snapshot);
  if(receipt&&(receipt.projectId!==projectId||receipt.taskId!==id||receipt.inputHash!==row.inputHash||receipt.sourceAssetId!==input.sourceAssetId||receipt.sourceHash!==input.sourceHash||
   receipt.probe.width!==snapshot.source.width||receipt.probe.height!==snapshot.source.height||receipt.keyframes.length!==plan.length||
   receipt.keyframes.some((keyframe,index)=>keyframe.segment!==plan[index]!.segment||keyframe.sourceFrame!==plan[index]!.sourceFrame)))invalid();
  if(['succeeded','undone'].includes(row.state)!==(outcome!==null)||outcome&&(outcome.shotIds.length!==plan.length||!receipt))invalid();
  const shots=outcome&&receipt?plan.map((entry,index)=>({segment:entry.segment,shotId:outcome.shotIds[index]!,assetId:receipt.keyframes[index]!.assetId})):null;
  const dto={id,projectId,kind:'shots' as const,requestId:row.requestId,sourceAssetId:input.sourceAssetId,sourceHash:input.sourceHash,resultId:input.resultId,
   segments:[...input.segments],titlePrefix:snapshot.titlePrefix,aspectRatio:snapshot.aspectRatio,state:row.state,revision:row.revision,started:row.started===1,
   shots,progress:null,undo:null,errorCode:row.errorCode,createdAt:row.createdAt,updatedAt:row.updatedAt};
  if(!sceneShotsTaskResponseSchema.safeParse(dto).success)invalid();
  acceptance(row,'scene.shots.create',{...dto,state:'queued',revision:1,started:false,shots:null,errorCode:null,updatedAt:row.createdAt});
  const source=asset(projectId,input.sourceAssetId,graph);
  if(source.sha256!==snapshot.source.sha256||source.mimeType!==snapshot.source.mimeType||source.relativePath!==snapshot.source.relativePath)invalid();
  // A built storyboard's images were saved with it and are never removed.
  if(outcome&&receipt)for(const keyframe of receipt.keyframes){const saved=assetRow(projectId,keyframe.assetId);if(!saved||!sceneKeyframeAssetMatches(saved,keyframe,projectId))invalid();}
  return {kind:'shots',row,input,snapshot,receipt,outcome,dto:dto as SceneShotsTaskResponse};
 }
 /** Whether a built storyboard can still be undone, and why not: one reason
 * per shot, the first of missing, generated, connected, bound to a subject,
 * edited. Each relation is read once for the whole batch. */
 function undoState(view: SceneShotsView): SceneUndoState {
  const {outcome,receipt,snapshot}=view,projectId=view.row.projectId;if(!outcome||!receipt)invalid();
  const ids=JSON.stringify(outcome.shotIds),plan=sceneShotPlan(snapshot);
  const shots=new Map<string,Record<string, unknown>>();
  for(const row of db.prepare(`SELECT ${text('id',36)},${text('data',262144)} FROM shots WHERE projectId=? AND id IN (SELECT value FROM json_each(?))`).all(projectId,ids)){
   const value=decode(row.data);if(!isRecord(value)||value.id!==row.id||value.projectId!==projectId)invalid();shots.set(String(row.id),value);
  }
  const generated=new Set(db.prepare("SELECT json_extract(data,'$.shotId') AS id FROM jobs WHERE projectId=? AND json_valid(data) AND json_extract(data,'$.shotId') IN (SELECT value FROM json_each(?))").all(projectId,ids).map(row=>row.id));
  const connected=new Set(db.prepare("SELECT json_extract(data,'$.source') AS source,json_extract(data,'$.target') AS target FROM edges WHERE projectId=? AND json_valid(data) AND (json_extract(data,'$.source') IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.target') IN (SELECT value FROM json_each(?)))")
   .all(projectId,ids,ids).flatMap(row=>[row.source,row.target]));
  // Cleared bindings stay as tombstones that still reference the shot.
  const bound=new Set(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subject_bindings'").get()?
   db.prepare('SELECT shotId FROM subject_bindings WHERE projectId=? AND shotId IN (SELECT value FROM json_each(?))').all(projectId,ids).map(row=>row.shotId):[]);
  const blockers: SceneUndoBlocker[]=[];
  plan.forEach((entry,index)=>{
   const shotId=outcome.shotIds[index]!,shot=shots.get(shotId),segment=entry.segment;
   if(!shot){blockers.push({segment,shotId,reason:'MISSING'});return;}
   if(generated.has(shotId)){blockers.push({segment,shotId,reason:'GENERATED'});return;}
   if(connected.has(shotId)){blockers.push({segment,shotId,reason:'CONNECTED'});return;}
   if(bound.has(shotId)){blockers.push({segment,shotId,reason:'SUBJECT_BOUND'});return;}
   const created: Record<string, unknown>={title:entry.title,prompt:'',referenceAssetIds:[receipt.keyframes[index]!.assetId],aspectRatio:snapshot.aspectRatio,duration:entry.duration,parameters:{},selectedVersionId:null};
   const fields=SCENE_SHOT_CONTENT_FIELDS.filter(field=>canonical(shot[field]??null)!==canonical(created[field]??null));
   if(fields.length)blockers.push({segment,shotId,reason:'EDITED',fields:[...fields]});
  });
  return {available:!blockers.length,blockers};
 }
 function prior(operation: string,input: Record<string,unknown> & {projectId: string; requestId: string}): unknown {
  const row=db.prepare(`SELECT ${requestColumns} FROM scene_requests WHERE requestId=? LIMIT 1`).get(input.requestId);if(!row)return null;
  const exact=canonical(input);
  if(row.projectId!==input.projectId||row.operation!==operation||row.inputHash!==sha(exact)||row.canonicalInput!==exact)fail('SCENE_REQUEST_CONFLICT');
  const response=decode(row.response);
  if(!isSceneMutationResponse(operation,input,response)||!isRecord(response)||canonical(response)!==row.response)invalid();
  if(operation==='scene.cuts.save'){
   if(response.id!==row.resultId)invalid();
   const saved=summary(input.projectId,row.resultId as string);if(canonical(saved)!==row.response)invalid();
  }else{
   if(response.id!==row.taskId)invalid();
   const saved=task(input.projectId,row.taskId as string).dto;
   if(saved.kind!==response.kind||saved.revision<(response.revision as number)||saved.requestId!==response.requestId||saved.sourceAssetId!==response.sourceAssetId||saved.createdAt!==response.createdAt)invalid();
  }
  return response;
 }
 function requestGet(input: {projectId: string; requestId: string}) {
  project(input.projectId);const row=db.prepare(`SELECT ${requestColumns} FROM scene_requests WHERE requestId=? AND projectId=? LIMIT 1`).get(input.requestId,input.projectId);if(!row)return null;
  const operation=typeof row.operation==='string'?row.operation:'';
  const schema=Object.hasOwn(sceneSchemas,operation)?sceneSchemas[operation as keyof typeof sceneSchemas]:null;
  const original=schema?schema.safeParse(decode(row.canonicalInput)):null;
  const data: Record<string,unknown>|null=original?.success&&isRecord(original.data)?original.data:null;
  if(!data||data.projectId!==input.projectId||data.requestId!==input.requestId)invalid();
  const value={projectId:input.projectId,requestId:input.requestId,operation,response:prior(operation,data as Record<string,unknown> & {projectId: string; requestId: string})};
  if(!sceneRequestResponseSchema.safeParse(value).success)invalid();return value;
 }
 const sign=(value: string): string=>createHmac('sha256',secret).update(value).digest('base64url');
 function page(input: {projectId: string; sourceAssetId?: string; limit?: number; cursor?: string}) {
  project(input.projectId);const limit=input.limit??SCENE_LIMITS.pageSize,scope=['scene.task.list',input.projectId,input.sourceAssetId??null,limit,'createdAt-desc,id-desc'];let after: string[] | null=null;
  if(input.cursor)try{
   const [body,mac,...rest]=input.cursor.split('.');if(rest.length||!mac||mac.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(String(body)))))throw Error();
   const decoded: unknown=JSON.parse(Buffer.from(String(body),'base64url').toString('utf8'));
   if(!Array.isArray(decoded)||decoded.length!==6||canonical(decoded.slice(0,5))!==canonical(scope))throw Error();
   after=decoded[5] as string[];
   if(!Array.isArray(after)||after.length!==2||typeof after[0]!=='string'||after[0].length>40||!Number.isFinite(Date.parse(after[0]))||!sceneSchemas['scene.task.get'].shape.taskId.safeParse(after[1]).success)throw Error();
  }catch{throw new AppError('INVALID_CURSOR','Invalid or expired scene cursor.',400);}
  const filter=input.sourceAssetId?' AND sourceAssetId=?':'';
  const rows=db.prepare(`SELECT ${text('id',36)},${text('createdAt',40)} FROM scene_tasks WHERE projectId=?${filter}${after?' AND (createdAt<? OR (createdAt=? AND id<?))':''} ORDER BY createdAt DESC,id DESC LIMIT ?`)
   .all(input.projectId,...(input.sourceAssetId?[input.sourceAssetId]:[]),...(after?[after[0],after[0],after[1]]:[]),limit+1);
  const graph=createOwnedMediaGraphReader(db,input.projectId),selected=rows.slice(0,limit),items=selected.map(row=>task(input.projectId,row.id as string,graph).dto);
  let nextCursor: string | null=null;
  if(rows.length>limit){
   const last=selected.at(-1);if(!last)throw new AppError('INVALID_CURSOR','Invalid or expired scene cursor.',400);
   const body=Buffer.from(JSON.stringify([...scope,[last.createdAt,last.id]])).toString('base64url');nextCursor=`${body}.${sign(body)}`;
  }
  return {projectId:input.projectId,items,nextCursor};
 }
 function resultGet(input: {projectId: string; assetId: string}): SceneResultResponse {
  project(input.projectId);const source=asset(input.projectId,input.assetId),latest=latestResultId(input.projectId,input.assetId);
  if(latest===null)return {projectId:input.projectId,assetId:input.assetId,result:null,current:false,staleReason:null};
  const saved=result(input.projectId,latest);
  const staleReason=saved.sourceHash!==source.sha256?'SOURCE_CHANGED' as const:saved.profileId!==SCENE_DETECTION_PROFILE_ID?'PROFILE_CHANGED' as const:null;
  const value={projectId:input.projectId,assetId:input.assetId,result:saved,current:staleReason===null,staleReason};
  if(!sceneResultResponseSchema.safeParse(value).success)invalid();return value;
 }
 /** A built storyboard reports whether it can still be undone; pages do not. */
 function taskGet(input: {projectId: string; taskId: string}): unknown {
  const view=task(input.projectId,input.taskId);
  if(view.kind!=='shots'||view.row.state!=='succeeded')return view.dto;
  const value={...view.dto,undo:undoState(view)};if(!sceneShotsTaskResponseSchema.safeParse(value).success)invalid();return value;
 }
 const snapshotRead=<A>(read: (input: A)=>unknown)=>(input: A): unknown=>{const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');try{return read(input);}finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}};
 const reads: Record<string,(input: unknown)=>unknown>={
  'scene.request.get':(input: unknown)=>snapshotRead(requestGet)(input as {projectId: string; requestId: string}),
  'scene.task.get':(input: unknown)=>snapshotRead(taskGet)(input as {projectId: string; taskId: string}),
  'scene.task.list':(input: unknown)=>snapshotRead(page)(input as {projectId: string}),
  'scene.result.get':(input: unknown)=>snapshotRead(resultGet)(input as {projectId: string; assetId: string}),
 };
 const handlers: Readonly<Record<string,(input: unknown)=>unknown>>=Object.freeze(Object.fromEntries(Object.entries(reads).map(([operation,read])=>[operation,(input: unknown): unknown=>{
  try{
   if(!schemaPresent())fail('SCENE_SCHEMA_REQUIRED',503);
   const schema=sceneSchemas[operation as keyof typeof sceneSchemas];
   const checked=schema.safeParse(input);if(!checked.success)throw new AppError('VALIDATION_ERROR','Invalid scene operation input.',400);
   return read(checked.data);
  }catch(cause){throw scenePublicFailure(cause);}
 }])));
 return Object.freeze({handlers,schemaPresent,project,asset,task,result,summary,latestResultId,prior,undoState});
}

/** The cut frames a scene split may use: the asset's newest result, which must
 * be the one the caller saw and still match the source and scoring profile.
 * Errors carry the timeline proof codes; reads only, inside the edit transaction. */
export function readSceneSplitCuts(db: DatabaseSync,projectId: string,assetId: string,resultId: string): number[] {
 const history=createSceneHistoryReaders({db});
 try{
  if(!history.schemaPresent())fail('SCENE_SCHEMA_REQUIRED',503);
  const source=history.asset(projectId,assetId),latest=history.latestResultId(projectId,assetId);
  if(latest===null)fail('SCENE_NOT_FOUND',404);
  if(latest!==resultId)throw new AppError('SCENE_RESULT_CONFLICT',sceneServiceMessages.SCENE_RESULT_CONFLICT!,409,{latestResultId:latest});
  const saved=history.result(projectId,latest);
  if(saved.sourceHash!==source.sha256||saved.profileId!==SCENE_DETECTION_PROFILE_ID)fail('SCENE_RESULT_STALE');
  return saved.cuts.map(cut=>cut.frame);
 }catch(cause){
  if(cause instanceof AppError&&['SCENE_RESULT_CONFLICT','SCENE_RESULT_STALE','SCENE_NOT_FOUND','SCENE_SCHEMA_REQUIRED'].includes(cause.code))throw cause;
  throw scenePublicFailure(cause);
 }
}

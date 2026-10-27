import {randomUUID,randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {AppError,IMAGE_FIXED_OPTIONS,IMAGE_STATES,SUBJECT_VARIANT_LIMITS,SUBJECT_VARIANT_MUTATION_OPERATIONS,SUBJECT_VARIANT_SUBJECT_KINDS,SUBJECT_VARIANT_UNDO_BLOCKERS,
 canonicalSubjectVariantInput as canonical,imageEditOutputSize,imageEditProfile,imageEditSourceIssue,imageSchemas,isSubjectVariantMutationResponse,isSubjectVersionResponse,
 subjectVariantBatchSchema,subjectVariantImageRequestId,subjectVariantSchemas,subjectVariantSnapshotSchema} from '@mioon/contracts';
import type {SubjectVariantBatch,SubjectVariantBlocker,SubjectVariantItem,SubjectVariantSnapshot,SubjectVariantSpec} from '@mioon/contracts';
import {createSubjectRecoveryBoundary} from './subjects.ts';
import {setImageResultListener} from './images.ts';
import {subjectVariantImageName,subjectVariantPrompt} from './subject-variant-prompts.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {ownsStoreLock} from './db.ts';
import {isSubjectVersionHidden,subjectVariantSchemaPresent} from './subject-variant-visibility.ts';

export interface SubjectVariantStore {readonly db: DatabaseSync; tx<T>(callback: ()=>T): T}
export interface SubjectVariantService {readonly handlers: Readonly<Record<string,(input: unknown)=>unknown>>; readonly drain: ()=>Promise<void>}
type Row=Record<string,unknown>;
type MutationInput=Record<string,unknown>&{readonly projectId: string; readonly requestId: string};
interface CreateInput extends MutationInput {subjectId: string; sourceVersionId: string; kind: 'angle'|'light'; items: SubjectVariantSpec[]; providerId: 'mock'|'openai'; model: string}
interface BatchRequest extends MutationInput {batchId: string; expectedRevision: number}
interface RetryInput extends BatchRequest {position: number}
interface BatchRow {id: string; projectId: string; subjectId: string; sourceVersionId: string; kind: string; requestId: string; inputHash: string; input: string; snapshot: string; state: 'active'|'undone'; revision: number; createdAt: string; updatedAt: string}
interface ItemRow {batchId: string; projectId: string; position: number; attempt: number; imageRequestId: string; versionId: string|null; revision: number; updatedAt: string}
interface ImageTaskRow {id: string; state: string; dispatched: number; errorCode: string|null; versionId: string|null}
interface BatchView {row: BatchRow; snapshot: SubjectVariantSnapshot; items: ItemRow[]}

export const subjectVariantMessages: Readonly<Record<string,string>>=Object.freeze({
 SUBJECT_VARIANT_NOT_FOUND:'This angle or lighting batch is unavailable for this project.',
 SUBJECT_VARIANT_RECORD_INVALID:'The saved angle or lighting batch cannot be verified safely.',
 SUBJECT_VARIANT_REQUEST_CONFLICT:'This request ID was already used for a different subject variant operation or input.',
 SUBJECT_VARIANT_REVISION_CONFLICT:'The batch changed. Read it again before choosing an action.',
 SUBJECT_VARIANT_STATE_CONFLICT:'The batch does not allow this action.',
 SUBJECT_VARIANT_CAPACITY:'The retained subject variant capacity is full.',
 SUBJECT_VARIANT_SCHEMA_REQUIRED:'The subject variant schema is unavailable.',
 SUBJECT_VARIANT_KIND_UNSUPPORTED:'Angles and lighting are available for characters and products only.',
 SUBJECT_VARIANT_SOURCE_UNSUPPORTED:'This model cannot edit the chosen version. Choose another version.',
 SUBJECT_VARIANT_QUEUE_FULL:'The image queue cannot hold this whole batch now. Wait for queued images to finish.',
 SUBJECT_VARIANT_RETRY_UNAVAILABLE:'Only an image that failed or was cancelled before it was sent can be retried.',
 SUBJECT_VARIANT_UNDO_BLOCKED:'This batch can no longer be undone.',
 SUBJECT_VERSION_HIDDEN:'This version belongs to an undone batch and is hidden.',
});
const failure=(code: string,status=409,details?: Record<string,unknown>): AppError=>new AppError(code,subjectVariantMessages[code]??subjectVariantMessages.SUBJECT_VARIANT_RECORD_INVALID!,status,details);
function fail(code: string,status?: number): never {throw failure(code,status);}
function invalid(): never {return fail('SUBJECT_VARIANT_RECORD_INVALID');}
function missing(): never {return fail('SUBJECT_VARIANT_NOT_FOUND',404);}
const sha=(value: string): string=>createHash('sha256').update(value).digest('hex');
const now=(): string=>new Date().toISOString();
const isRecord=(value: unknown): value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decode=(text: unknown): unknown=>{try{return JSON.parse(String(text));}catch{return invalid();}};
const text=(name: string,max: number,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const integer=(name: string,max: number): string=>`CASE WHEN typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${max} THEN ${name} ELSE -1 END AS ${name}`;
const batchColumns=[text('id',36),text('projectId',36),text('subjectId',36),text('sourceVersionId',36),text('kind',8),text('requestId',800),text('inputHash',64),
 text('input',SUBJECT_VARIANT_LIMITS.inputBytes),text('snapshot',SUBJECT_VARIANT_LIMITS.snapshotBytes),text('state',8),integer('revision',Number.MAX_SAFE_INTEGER),text('createdAt',40),text('updatedAt',40)].join(',');
const itemColumns=[text('batchId',36),text('projectId',36),integer('position',SUBJECT_VARIANT_LIMITS.items),integer('attempt',SUBJECT_VARIANT_LIMITS.attempts),text('imageRequestId',120),
 text('versionId',36,true),integer('revision',Number.MAX_SAFE_INTEGER),text('updatedAt',40)].join(',');
const requestColumns=[text('requestId',800),text('operation',80),text('projectId',36),text('batchId',36),text('inputHash',64),
 text('canonicalInput',SUBJECT_VARIANT_LIMITS.inputBytes),text('response',SUBJECT_VARIANT_LIMITS.responseBytes)].join(',');
// Image states that are still moving, and the ones that ended without a result.
const RUNNING=new Set(['queued','dispatching','receiving','persisting','succeeded']);
const RETRYABLE=new Set(['failed','cancelled_before_dispatch']);
const EDIT_ORIGINS=new Set(['user-import','generated','synthetic-mock','extracted-frame']);

export function createSubjectVariantServices(store: SubjectVariantStore): SubjectVariantService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const {db,tx}=store,secret=randomBytes(32);
 const schemaPresent=(): boolean=>subjectVariantSchemaPresent(db);
 function owner(): void {if(!ownsStoreLock(store))fail('SUBJECT_VARIANT_STATE_CONFLICT',403);}
 function project(projectId: string): void {if(!db.prepare('SELECT 1 FROM projects WHERE id=? LIMIT 1').get(projectId))missing();}
 function batch(projectId: string,id: string): BatchView {
  const row=db.prepare(`SELECT ${batchColumns} FROM subject_variant_batches WHERE id=? AND projectId=? LIMIT 1`).get(id,projectId) as unknown as BatchRow|undefined;
  if(!row)missing();
  const value=row as BatchRow;
  if(value.id!==id||value.projectId!==projectId||!['angle','light'].includes(value.kind)||!['active','undone'].includes(value.state)||value.revision<1)invalid();
  const parsed=subjectVariantSnapshotSchema.safeParse(decode(value.snapshot)),input=decode(value.input);
  if(!parsed.success||!subjectVariantSchemas['subject.variants.create'].safeParse(input).success||canonical(input)!==value.input||sha(value.input)!==value.inputHash)invalid();
  const snapshot=parsed.data,request=input as CreateInput;
  if(snapshot.batchId!==id||snapshot.projectId!==projectId||snapshot.subjectId!==value.subjectId||snapshot.sourceVersionId!==value.sourceVersionId||snapshot.kind!==value.kind||
   request.requestId!==value.requestId||snapshot.providerId!==request.providerId||snapshot.model!==request.model||canonical(snapshot.items.map(item=>item.spec))!==canonical(request.items))invalid();
  const items=db.prepare(`SELECT ${itemColumns} FROM subject_variant_items WHERE batchId=? AND projectId=? ORDER BY position LIMIT 9`).all(id,projectId) as unknown as ItemRow[];
  if(items.length!==snapshot.items.length||items.some((item,index)=>item.position!==index+1||item.attempt<1||item.revision<1||item.imageRequestId!==subjectVariantImageRequestId(id,item.position,item.attempt)||
   item.versionId!==null&&(typeof item.versionId!=='string'||item.versionId.length!==36)))invalid();
  return {row:value,snapshot,items};
 }
 function imageInput(view: BatchView,item: ItemRow): Row {
  const plan=view.snapshot.items[item.position-1]!,source=view.snapshot.source;
  const value={projectId:view.row.projectId,name:plan.name,providerId:view.snapshot.providerId,model:view.snapshot.model,prompt:plan.prompt,
   options:{...IMAGE_FIXED_OPTIONS,size:view.snapshot.size},purpose:'edit',inputImage:{assetId:source.assetId,sha256:source.sha256},requestId:item.imageRequestId};
  if(!imageSchemas['image.generate'].safeParse(value).success)invalid();
  return value;
 }
 function imageTask(projectId: string,requestId: string): ImageTaskRow|null {
  const row=db.prepare(`SELECT ${text('id',36)},${text('state',40)},${integer('dispatched',1)},${text('errorCode',80,true)},${text('versionId',36,true)} FROM image_tasks WHERE requestId=? AND projectId=? LIMIT 1`).get(requestId,projectId) as unknown as ImageTaskRow|undefined;
  if(!row)return null;
  if(!(IMAGE_STATES as readonly string[]).includes(row.state)||![0,1].includes(row.dispatched))invalid();
  return row;
 }
 function status(view: BatchView,item: ItemRow,task: ImageTaskRow|null): SubjectVariantItem['status'] {
  if(view.row.state==='undone')return 'undone';
  if(item.versionId)return 'succeeded';
  if(!task)return 'pending';
  if(RUNNING.has(task.state))return 'running';
  return task.state==='failed'?'failed':task.state==='cancelled_before_dispatch'?'cancelled':task.state==='interrupted_before_dispatch'?'interrupted':task.state==='outcome_unknown'?'unknown':'recoverable';
 }
 function dto(view: BatchView,undo: SubjectVariantBatch['undo']=null): SubjectVariantBatch {
  const items=view.items.map(item=>{
   const task=imageTask(view.row.projectId,item.imageRequestId);
   return {position:item.position,spec:view.snapshot.items[item.position-1]!.spec,attempt:item.attempt,imageInput:imageInput(view,item),versionId:item.versionId,
    image:task?{taskId:task.id,state:task.state,dispatched:task.dispatched===1,errorCode:task.errorCode}:null,status:status(view,item,task)};
  });
  const value={id:view.row.id,projectId:view.row.projectId,subjectId:view.row.subjectId,sourceVersionId:view.row.sourceVersionId,kind:view.row.kind,requestId:view.row.requestId,
   providerId:view.snapshot.providerId,model:view.snapshot.model,size:view.snapshot.size,state:view.row.state,revision:view.row.revision,items,undo,createdAt:view.row.createdAt,updatedAt:view.row.updatedAt};
  const parsed=subjectVariantBatchSchema.safeParse(value);if(!parsed.success)invalid();
  return parsed.data;
 }
 /** Why this batch cannot be undone, in the contract's precedence order. */
 function blockers(view: BatchView): SubjectVariantBlocker[] {
  const found: SubjectVariantBlocker[]=[];
  for(const item of view.items){
   const task=imageTask(view.row.projectId,item.imageRequestId);
   if(!item.versionId&&task&&(RUNNING.has(task.state)||task.state==='interrupted_before_dispatch'))found.push({code:'IN_PROGRESS',position:item.position});
   else if(!item.versionId&&task&&['outcome_unknown','local_result_error'].includes(task.state))found.push({code:'UNKNOWN',position:item.position});
   if(!item.versionId)continue;
   const binding=db.prepare('SELECT shotId FROM subject_bindings WHERE subjectVersionId=? AND projectId=? ORDER BY id LIMIT 1').get(item.versionId,view.row.projectId) as {shotId?: unknown}|undefined;
   if(binding)found.push({code:'BOUND',position:item.position,...(typeof binding.shotId==='string'&&binding.shotId.length===36?{shotId:binding.shotId}:{})});
   if(db.prepare("SELECT 1 FROM jobs WHERE projectId=? AND CASE WHEN json_valid(data) THEN json_extract(data,'$.snapshot.subjectReference.subjectVersionId') IS ? ELSE 0 END LIMIT 1").get(view.row.projectId,item.versionId))found.push({code:'GENERATED',position:item.position});
   const derived=db.prepare("SELECT id FROM subject_variant_batches WHERE sourceVersionId=? AND projectId=? AND state='active' ORDER BY createdAt,id LIMIT 1").get(item.versionId,view.row.projectId) as {id?: unknown}|undefined;
   if(derived&&typeof derived.id==='string')found.push({code:'SOURCE',position:item.position,batchId:derived.id});
  }
  const order=SUBJECT_VARIANT_UNDO_BLOCKERS as readonly string[];
  return found.sort((a,b)=>order.indexOf(a.code)-order.indexOf(b.code)||a.position-b.position).slice(0,SUBJECT_VARIANT_LIMITS.blockers);
 }
 function undoState(view: BatchView): NonNullable<SubjectVariantBatch['undo']> {
  if(view.row.state!=='active')return {available:false,blockers:[]};
  const found=blockers(view);return {available:found.length===0,blockers:found};
 }
 function record(operation: string,input: MutationInput,response: SubjectVariantBatch,batchId: string): void {
  if(!isSubjectVariantMutationResponse(operation,input,response))invalid();
  const count=(where: string,args: SQLInputValue[],cap: number): number=>Number((db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM subject_variant_requests ${where} LIMIT ${cap+1})`).get(...args) as {n: number}).n);
  if(count('WHERE projectId=?',[input.projectId],SUBJECT_VARIANT_LIMITS.requestsPerProject)>=SUBJECT_VARIANT_LIMITS.requestsPerProject||count('',[],SUBJECT_VARIANT_LIMITS.requestsGlobal)>=SUBJECT_VARIANT_LIMITS.requestsGlobal)fail('SUBJECT_VARIANT_CAPACITY',507);
  db.prepare('INSERT INTO subject_variant_requests(requestId,operation,projectId,batchId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?,?)')
   .run(input.requestId,operation,input.projectId,batchId,sha(canonical(input)),canonical(input),canonical(response));
 }
 function prior(operation: string,input: MutationInput): SubjectVariantBatch|null {
  const row=db.prepare(`SELECT ${requestColumns} FROM subject_variant_requests WHERE requestId=? LIMIT 1`).get(input.requestId) as Row|undefined;
  if(!row)return null;
  const exact=canonical(input);
  if(row.projectId!==input.projectId||row.operation!==operation||row.inputHash!==sha(exact)||row.canonicalInput!==exact)fail('SUBJECT_VARIANT_REQUEST_CONFLICT');
  const response=decode(row.response);
  if(!isSubjectVariantMutationResponse(operation,input,response)||canonical(response)!==row.response||(response as SubjectVariantBatch).id!==row.batchId)invalid();
  const saved=batch(input.projectId,row.batchId as string),value=response as SubjectVariantBatch;
  if(saved.row.revision<value.revision||saved.row.requestId!==value.requestId||saved.row.subjectId!==value.subjectId||saved.row.createdAt!==value.createdAt)invalid();
  return value;
 }
 function sourceIssue(snapshotSource: Row,provenance: Row,profile: NonNullable<ReturnType<typeof imageEditProfile>>): string|null {
  const kind=provenance.kind,ids=[provenance.versionId,provenance.shotId,provenance.jobId];
  // The edit pipeline accepts imports, image results and captured frames, never
  // a video-generation output or an export.
  const origin=EDIT_ORIGINS.has(kind as string)&&ids.every(value=>value===null)&&(kind!=='user-import'||(provenance.imageSource===undefined&&provenance.frameSource===undefined))&&
   (!['generated','synthetic-mock'].includes(kind as string)||provenance.imageSource!==undefined)&&(kind!=='extracted-frame'||provenance.frameSource!==undefined);
  return origin?imageEditSourceIssue(profile,snapshotSource):'origin';
 }
 function create(input: CreateInput): SubjectVariantBatch {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('subject.variants.create',input);if(replay)return replay;
   const boundary=createSubjectRecoveryBoundary(db,{projectId:input.projectId});
   const subject=boundary.subject(input.subjectId) as Row&{kind: string; name: string};
   if(!(SUBJECT_VARIANT_SUBJECT_KINDS as readonly string[]).includes(subject.kind))fail('SUBJECT_VARIANT_KIND_UNSUPPORTED');
   const version=boundary.version(input.sourceVersionId,input.subjectId) as Row&{assetId: string; sha256: string; mimeType: string; width: number; height: number; number: number; provenance: Row};
   if(isSubjectVersionHidden(db,input.sourceVersionId))fail('SUBJECT_VERSION_HIDDEN');
   const asset=decode((db.prepare(`SELECT ${text('data',65536)} FROM assets WHERE id=? AND projectId=? LIMIT 1`).get(version.assetId,input.projectId) as {data?: unknown}|undefined)?.data) as Row;
   const profile=imageEditProfile(input.providerId,input.model);if(!profile)fail('SUBJECT_VARIANT_SOURCE_UNSUPPORTED');
   const source={assetId:version.assetId,sha256:version.sha256,mimeType:version.mimeType,width:version.width,height:version.height,byteLength:asset.sizeBytes,number:version.number};
   const issue=sourceIssue(source,version.provenance,profile!);
   if(issue)throw failure('SUBJECT_VARIANT_SOURCE_UNSUPPORTED',409,{reason:issue});
   const count=(table: string,where: string,args: SQLInputValue[],cap: number): number=>Number((db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} ${where} LIMIT ${cap+1})`).get(...args) as {n: number}).n);
   if(count('subject_variant_batches','WHERE projectId=?',[input.projectId],SUBJECT_VARIANT_LIMITS.batchesPerProject)>=SUBJECT_VARIANT_LIMITS.batchesPerProject||count('subject_variant_batches','',[],SUBJECT_VARIANT_LIMITS.batchesGlobal)>=SUBJECT_VARIANT_LIMITS.batchesGlobal)fail('SUBJECT_VARIANT_CAPACITY',507);
   // Best effort: the image queue must have room for every item right now.
   if(count('image_tasks',"WHERE projectId=? AND state IN ('queued','dispatching','receiving','persisting')",[input.projectId],SUBJECT_VARIANT_LIMITS.items)+input.items.length>SUBJECT_VARIANT_LIMITS.items)fail('SUBJECT_VARIANT_QUEUE_FULL');
   const id=randomUUID(),timestamp=now(),size=imageEditOutputSize(profile!,version.width,version.height);
   const snapshot={schemaVersion:1,projectId:input.projectId,batchId:id,subjectId:input.subjectId,subjectKind:subject.kind,subjectName:subject.name,sourceVersionId:input.sourceVersionId,source,
    kind:input.kind,providerId:input.providerId,model:input.model,size,
    items:input.items.map((spec,index)=>({position:index+1,spec,name:subjectVariantImageName(subject,spec),prompt:subjectVariantPrompt(subject,spec)}))};
   if(!subjectVariantSnapshotSchema.safeParse(snapshot).success)invalid();
   db.prepare("INSERT INTO subject_variant_batches(id,projectId,subjectId,sourceVersionId,kind,requestId,inputHash,input,snapshot,state,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'active',1,?,?)")
    .run(id,input.projectId,input.subjectId,input.sourceVersionId,input.kind,input.requestId,sha(canonical(input)),canonical(input),canonical(snapshot),timestamp,timestamp);
   const insert=db.prepare('INSERT INTO subject_variant_items(batchId,projectId,position,attempt,imageRequestId,versionId,revision,updatedAt) VALUES(?,?,?,1,?,NULL,1,?)');
   input.items.forEach((_,index)=>insert.run(id,input.projectId,index+1,subjectVariantImageRequestId(id,index+1,1),timestamp));
   const value=dto(batch(input.projectId,id));record('subject.variants.create',input,value,id);
   return value;
  });
 }
 function change(view: BatchView,state: 'active'|'undone',timestamp: string): void {
  if(view.row.revision>=Number.MAX_SAFE_INTEGER)fail('SUBJECT_VARIANT_CAPACITY',507);
  if(db.prepare('UPDATE subject_variant_batches SET state=?,revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(state,timestamp,view.row.id,view.row.projectId,view.row.revision).changes!==1)invalid();
 }
 function retry(input: RetryInput): SubjectVariantBatch {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('subject.variants.retry',input);if(replay)return replay;
   const view=batch(input.projectId,input.batchId);
   if(view.row.revision!==input.expectedRevision)fail('SUBJECT_VARIANT_REVISION_CONFLICT');
   if(view.row.state!=='active')fail('SUBJECT_VARIANT_STATE_CONFLICT');
   const item=view.items[input.position-1];if(!item)fail('SUBJECT_VARIANT_STATE_CONFLICT');
   const task=imageTask(input.projectId,item!.imageRequestId);
   if(item!.versionId||!task||!RETRYABLE.has(task.state))fail('SUBJECT_VARIANT_RETRY_UNAVAILABLE');
   if(item!.attempt>=SUBJECT_VARIANT_LIMITS.attempts)fail('SUBJECT_VARIANT_CAPACITY',507);
   const timestamp=now(),attempt=item!.attempt+1;
   if(db.prepare('UPDATE subject_variant_items SET attempt=?,imageRequestId=?,revision=revision+1,updatedAt=? WHERE batchId=? AND position=? AND revision=?')
    .run(attempt,subjectVariantImageRequestId(view.row.id,item!.position,attempt),timestamp,view.row.id,item!.position,item!.revision).changes!==1)invalid();
   change(view,'active',timestamp);
   const value=dto(batch(input.projectId,input.batchId));record('subject.variants.retry',input,value,view.row.id);
   return value;
  });
 }
 /** Hides the batch's versions. Versions, images and receipts are retained. */
 function undo(input: BatchRequest): SubjectVariantBatch {
  return tx(()=>{
   owner();project(input.projectId);const replay=prior('subject.variants.undo',input);if(replay)return replay;
   const view=batch(input.projectId,input.batchId);
   if(view.row.revision!==input.expectedRevision)fail('SUBJECT_VARIANT_REVISION_CONFLICT');
   if(view.row.state!=='active')fail('SUBJECT_VARIANT_STATE_CONFLICT');
   const state=undoState(view);
   if(!state.available)throw failure('SUBJECT_VARIANT_UNDO_BLOCKED',409,{blockers:state.blockers});
   change(view,'undone',now());
   const value=dto(batch(input.projectId,input.batchId));record('subject.variants.undo',input,value,view.row.id);
   return value;
  });
 }
 /** Adds a finished image as its item's subject version, inside the image
 * service's publishing transaction. Unrelated images and undone batches are left alone. */
 function link(result: {projectId: string; requestId: string; assetId: string}): void {
  if(!schemaPresent())return;
  const owned=db.prepare(`SELECT ${text('batchId',36)},${integer('position',SUBJECT_VARIANT_LIMITS.items)} FROM subject_variant_items WHERE imageRequestId=? AND projectId=? LIMIT 1`).get(result.requestId,result.projectId) as {batchId?: unknown; position?: unknown}|undefined;
  if(!owned)return;
  const view=batch(result.projectId,String(owned.batchId)),item=view.items[Number(owned.position)-1];
  if(!item||item.imageRequestId!==result.requestId||item.versionId)invalid();
  if(view.row.state!=='active')return;
  const task=db.prepare(`SELECT ${text('input',65536)} FROM image_tasks WHERE requestId=? AND projectId=? LIMIT 1`).get(result.requestId,result.projectId) as {input?: unknown}|undefined;
  if(!task||task.input!==canonical(imageInput(view,item!)))invalid();
  const boundary=createSubjectRecoveryBoundary(db,{projectId:result.projectId});
  const subject=boundary.subjectRow(view.row.subjectId) as Row&{revision: number},asset=boundary.asset(result.assetId) as Row;
  if(subject.revision>=Number.MAX_SAFE_INTEGER)fail('SUBJECT_VARIANT_CAPACITY',507);
  const timestamp=now(),versionId=randomUUID(),number=subject.revision+1,spec=view.snapshot.items[item!.position-1]!.spec;
  const value={id:versionId,projectId:result.projectId,subjectId:view.row.subjectId,number,...asset,createdAt:timestamp,variant:{...spec,batchId:view.row.id,sourceVersionId:view.row.sourceVersionId}};
  if(!isSubjectVersionResponse(value))invalid();
  db.prepare('INSERT INTO subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)').run(versionId,result.projectId,view.row.subjectId,number,result.assetId,JSON.stringify(value));
  if(db.prepare('UPDATE subjects SET revision=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(number,timestamp,view.row.subjectId,result.projectId,subject.revision).changes!==1)invalid();
  if(db.prepare('UPDATE subject_variant_items SET versionId=?,revision=revision+1,updatedAt=? WHERE batchId=? AND position=? AND revision=?').run(versionId,timestamp,view.row.id,item!.position,item!.revision).changes!==1)invalid();
 }
 // A result published while this service was not registered is linked on the
 // next start, from the image task's own receipt.
 function reconcile(): void {
  if(!schemaPresent()||!ownsStoreLock(store))return;
  const rows=db.prepare(`SELECT i.projectId AS projectId,i.imageRequestId AS requestId,v.assetId AS assetId FROM subject_variant_items i JOIN subject_variant_batches b ON b.id=i.batchId AND b.projectId=i.projectId
   JOIN image_tasks t ON t.requestId=i.imageRequestId AND t.projectId=i.projectId JOIN image_versions v ON v.id=t.versionId AND v.projectId=t.projectId
   WHERE i.versionId IS NULL AND b.state='active' AND t.state='succeeded' ORDER BY b.createdAt,i.batchId,i.position LIMIT 64`).all() as {projectId: string; requestId: string; assetId: string}[];
  for(const row of rows){try{tx(()=>link(row));}catch{console.error('Skipped an unlinked subject variant result.');}}
 }
 function list(input: {projectId: string; subjectId: string; limit?: number; cursor?: string}) {
  project(input.projectId);createSubjectRecoveryBoundary(db,{projectId:input.projectId}).subjectRow(input.subjectId);
  const limit=input.limit??SUBJECT_VARIANT_LIMITS.pageSize,scope=[input.projectId,input.subjectId,limit];
  const sign=(body: string): string=>createHmac('sha256',secret).update(body).digest('base64url');
  let after: [string,string]|null=null;
  if(input.cursor!==undefined){
   try{
    const [body,mac,...rest]=input.cursor.split('.');
    if(rest.length||!body||mac?.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(body))))throw Error();
    const value: unknown=JSON.parse(Buffer.from(body,'base64url').toString());
    if(!Array.isArray(value)||value.length!==4||canonical(value.slice(0,3))!==canonical(scope)||!Array.isArray(value[3])||value[3].length!==2||value[3].some(item=>typeof item!=='string'))throw Error();
    after=value[3] as [string,string];
   }catch{throw new AppError('INVALID_CURSOR','Invalid or expired subject variant cursor.',400);}
  }
  const rows=db.prepare(`SELECT ${text('id',36)},${text('createdAt',40)} FROM subject_variant_batches WHERE projectId=? AND subjectId=?${after?' AND (createdAt<? OR (createdAt=? AND id<?))':''} ORDER BY createdAt DESC,id DESC LIMIT ?`)
   .all(...[input.projectId,input.subjectId,...(after?[after[0],after[0],after[1]]:[]),limit+1] as SQLInputValue[]) as {id: string; createdAt: string}[];
  const selected=rows.slice(0,limit),last=selected.at(-1);
  const body=rows.length>limit&&last?Buffer.from(JSON.stringify([...scope,[last.createdAt,last.id]])).toString('base64url'):null;
  return {projectId:input.projectId,items:selected.map(row=>dto(batch(input.projectId,row.id))),nextCursor:body?`${body}.${sign(body)}`:null};
 }
 function snapshotRead<T>(read: ()=>T): T {
  const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{return read();}finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
 }
 const refusals=new Set(['SUBJECT_VARIANT_REVISION_CONFLICT','SUBJECT_VARIANT_STATE_CONFLICT','SUBJECT_VARIANT_KIND_UNSUPPORTED','SUBJECT_VARIANT_SOURCE_UNSUPPORTED',
  'SUBJECT_VARIANT_QUEUE_FULL','SUBJECT_VARIANT_RETRY_UNAVAILABLE','SUBJECT_VARIANT_UNDO_BLOCKED','SUBJECT_VERSION_HIDDEN','SUBJECT_VARIANT_CAPACITY']);
 /** An error label alone never proves nonacceptance: a fresh transaction must
 * find the project and no receipt for this exact request ID. */
 function proveRefusal(operation: string,input: MutationInput,cause: unknown): void {
  if(!(cause instanceof AppError)||!refusals.has(cause.code)||db.isTransaction)return;
  try{
   const proof=tx(()=>{project(input.projectId);return db.prepare('SELECT 1 FROM subject_variant_requests WHERE requestId=? LIMIT 1').get(input.requestId)?null
    :{status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:sha(canonical(input))};});
   if(proof)cause.details={...(isRecord(cause.details)?cause.details:{}),subjectVariantOutcome:proof};
  }catch{/* Unknown scope or storage state stays unknown. */}
 }
 const mutations: Record<string,(input: never)=>SubjectVariantBatch>={
  'subject.variants.create':(input: CreateInput)=>create(input),
  'subject.variants.retry':(input: RetryInput)=>retry(input),
  'subject.variants.undo':(input: BatchRequest)=>undo(input),
 };
 const handlers: Record<string,(input: unknown)=>unknown>={};
 const parse=(operation: keyof typeof subjectVariantSchemas,input: unknown): Row=>{
  if(!schemaPresent())fail('SUBJECT_VARIANT_SCHEMA_REQUIRED',503);
  const parsed=subjectVariantSchemas[operation].safeParse(input);if(!parsed.success)throw new AppError('VALIDATION_ERROR','Invalid subject variant input.',400);
  if(Buffer.byteLength(canonical(parsed.data))>SUBJECT_VARIANT_LIMITS.inputBytes)fail('SUBJECT_VARIANT_CAPACITY',507);
  return parsed.data as Row;
 };
 for(const operation of SUBJECT_VARIANT_MUTATION_OPERATIONS)handlers[operation]=(input: unknown)=>{
  const data=parse(operation,input) as MutationInput;
  try{return mutations[operation]!(data as never);}catch(cause){proveRefusal(operation,data,cause);throw cause;}
 };
 handlers['subject.variants.get']=(input: unknown)=>{const data=parse('subject.variants.get',input) as {projectId: string; batchId: string};
  return snapshotRead(()=>{project(data.projectId);const view=batch(data.projectId,data.batchId);return dto(view,undoState(view));});};
 handlers['subject.variants.list']=(input: unknown)=>{const data=parse('subject.variants.list',input) as {projectId: string; subjectId: string; limit?: number; cursor?: string};return snapshotRead(()=>list(data));};
 const removeListener=setImageResultListener(db,result=>link(result));
 reconcile();
 return Object.freeze({handlers:Object.freeze(handlers),drain:async()=>{removeListener();}});
}

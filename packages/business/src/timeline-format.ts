import {timelineRenderDeliveryFields} from '@mioon/contracts/timeline-delivery';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {AppError,timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET,isTimelineRecord,isTimelineRenderRecord,isEditTask,hasRequestNotAppliedProof,TIMELINE_MUTATION_OPERATIONS,TIMELINE_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';
import {createTimelineRecoveryBoundary,readTimelineReceipt,invalidTimeline,restoreTimelineEditableSnapshot} from './timeline-recovery.ts';
import {TIMELINE_RECEIPT_PROJECT_EXPRESSION} from './timeline-format-schema.ts';
import {canonicalFormatValue,formatRequestHash,readTimelineFormatProvenance} from './timeline-format-receipts.ts';
import {executingTimelineFormatTask} from './timeline-format-task-context.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {TimelineRecoveryBoundary,TimelineRecoveryInput} from './timeline-recovery.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

export interface TimelineFormatProject {id: string;revision: number}
export interface TimelineFormatOwner {project: TimelineFormatProject;timeline: TimelineRecord|null;boundary: TimelineRecoveryBoundary}
export interface TimelineFormatResponse {
 projectId: string;projectRevision: number;timelineId: string|null;timelineRevision: number;
 presetId: string;fps: number;width: number;height: number;eligible: boolean;blockedReasons: string[];
}
export interface TimelineFormatStateResult {project: TimelineFormatProject;timeline: TimelineRecord|null;boundary: TimelineRecoveryBoundary;response: TimelineFormatResponse}
interface TimelineFormatStateOptions {admission?: boolean;context?: TimelineFormatOwner;store?: {db: DatabaseSync;root?: string}}

const hash=(value: unknown): string=>createHash('sha256').update(canonicalFormatValue(value) as string).digest('hex');
const uuid=(value: unknown): value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest=(value: unknown): boolean=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value: unknown,min=0): boolean=>Number.isSafeInteger(value)&&(value as number)>=min;
const object=(value: unknown): boolean=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(column: string,bytes: number): string=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;
const parse=(text: unknown)=>{try{const value=JSON.parse(text as string);if(!object(value))invalidTimeline();return value;}catch{invalidTimeline();}};
const cap=4096;
const rows=<T=Record<string, unknown>>(db: DatabaseSync,sql: string,...args: SQLInputValue[]): T[]=>{
 const result: T[]=[];let bytes=0;
 for(const row of db.prepare(sql+` LIMIT ${cap+1}`).iterate(...args)){
  bytes+=Object.values(row).reduce<number>((sum,value)=>sum+(typeof value==='string'?Buffer.byteLength(value):8),0);
  if(result.length===cap||bytes>16*1024*1024)invalidTimeline();
  result.push(row as T);
 }
 return result;
};

// Authoritative metadata reads and admission share the same fail-closed predicate.
// Merely reading this boundary never ensures a timeline or repairs legacy rows.
export function readTimelineFormatOwner(db: DatabaseSync,input: TimelineRecoveryInput): TimelineFormatOwner{
 const boundary=createTimelineRecoveryBoundary(db,input),timeline=boundary.read({legacyMissingProject:true});
 const projectRow=db.prepare(`SELECT id,${bounded('data',16384)} AS data FROM projects WHERE id=?`).get(input.projectId);
 const project=parse(projectRow?.data);
 if(project.id!==input.projectId||projectRow!.id!==project.id||!integer(project.revision,1))invalidTimeline();
 return {project,timeline,boundary};
}
export function readTimelineFormatState(db: DatabaseSync,input: TimelineRecoveryInput,{admission=false,context=readTimelineFormatOwner(db,input),store}: TimelineFormatStateOptions={}): TimelineFormatStateResult{
 const {project,timeline,boundary}=context;
 const reasons: string[]=[];
 if(timeline&&(timeline.clips.length||timeline.durationFrames))reasons.push('CLIPS_PRESENT');
 const history=rows(db,`SELECT id,projectId,position,operation,createdAt,${bounded('beforeSnapshot',TIMELINE_RESPONSE_BYTES)} AS beforeSnapshot,${bounded('afterSnapshot',TIMELINE_RESPONSE_BYTES)} AS afterSnapshot FROM timeline_history WHERE projectId=? ORDER BY position`,input.projectId);
 const cursor=db.prepare('SELECT projectId,position FROM timeline_history_cursors WHERE projectId=?').get(input.projectId);
 if(cursor&&(!timeline||cursor.projectId!==input.projectId||!integer(cursor.position)||(cursor.position as number)>history.length)||history.length&&!cursor)invalidTimeline();
 for(const [index,entry] of history.entries()){
  if(!timeline||!uuid(entry.id)||entry.projectId!==input.projectId||entry.position!==index+1||!(TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(entry.operation as string)||['timeline.render','timeline.format.set','timeline.undo','timeline.redo'].includes(entry.operation as string)||typeof entry.createdAt!=='string'||entry.createdAt.length>64||!Number.isFinite(Date.parse(entry.createdAt)))invalidTimeline();
  for(const field of ['beforeSnapshot','afterSnapshot']){
   const saved=parse((entry as Record<string, unknown>)[field]);
   if(!isTimelineRecord(restoreTimelineEditableSnapshot(timeline!,saved),{projectId:input.projectId}))invalidTimeline();
  }
 }
 if(history.length||cursor)reasons.push('HISTORY_PRESENT');
 // Unscopable corrupt receipts cannot safely be declared unrelated to this project.
 for(const owner of rows(db,`SELECT DISTINCT (${TIMELINE_RECEIPT_PROJECT_EXPRESSION}) AS projectId FROM timeline_requests`)){
  if(!uuid(owner.projectId)||!db.prepare('SELECT 1 FROM projects WHERE id=?').get(owner.projectId))invalidTimeline();
 }
 let requestHistory=false;
 const receipts=rows(db,`SELECT requestId,${bounded('requestHash',64)} AS requestHash,${bounded('response',TIMELINE_RENDER_RESPONSE_BYTES)} AS response FROM timeline_requests WHERE (${TIMELINE_RECEIPT_PROJECT_EXPRESSION})=? ORDER BY requestId`,input.projectId);
 const receiptIds=new Set();
 for(const receipt of receipts){
  if(typeof receipt.requestId!=='string'||receipt.requestId.length<8||receipt.requestId.length>200||!digest(receipt.requestHash))invalidTimeline();
  receiptIds.add(receipt.requestId as string);
  const response=parse(receipt.response);
  const provenance=db.prepare(`SELECT projectId,${bounded('input',2048)} AS input FROM timeline_format_requests WHERE requestId=?`).get(receipt.requestId as string);
  if(provenance){
   const saved=parse(provenance.input) as Record<string,unknown>;
   readTimelineFormatProvenance(db,{...saved,requestId:receipt.requestId as string,projectId:input.projectId},receipt.requestHash as string);
   createTimelineRecoveryBoundary(db,saved as TimelineRecoveryInput).replay('timeline.format.set',receipt.response as string);
  }else{
   if(response.mode==='timeline'){
    if(!isTimelineRenderRecord(response,{projectId:input.projectId,requestId:receipt.requestId,expectedRevision:response.timelineRevision,purpose:response.purpose,...timelineRenderDeliveryFields(response.snapshot)}))invalidTimeline();
    if(!timeline||response.snapshot.timeline.id!==timeline.id||response.snapshot.timeline.revision>timeline.revision)invalidTimeline();
    boundary.sources(response.snapshot.timeline as TimelineRecord);
   }else{
    if(!isTimelineRecord(response,{projectId:input.projectId})||!timeline||response.id!==timeline.id||response.revision>timeline.revision)invalidTimeline();
    boundary.sources(response as TimelineRecord);
   }
   requestHistory=true;
  }
 }
 // Detect orphaned or cross-project provenance even if foreign keys were disabled.
 for(const row of rows(db,'SELECT requestId FROM timeline_format_requests WHERE projectId=? ORDER BY requestId',input.projectId))if(!receiptIds.has(row.requestId as string))invalidTimeline();
 if(requestHistory)reasons.push('REQUEST_HISTORY');
 let exportHistory=false;
 for(const row of rows(db,`SELECT id,projectId,${bounded('data',TIMELINE_RENDER_RESPONSE_BYTES)} AS data FROM exports WHERE projectId=? ORDER BY id`,input.projectId)){
  const value=parse(row.data);
  if(!uuid(row.id)||row.id!==value.id||row.projectId!==input.projectId||value.projectId!==input.projectId)invalidTimeline();
  if(value.mode==='timeline'){
   if(!isTimelineRenderRecord(value,{projectId:input.projectId,requestId:value.requestId,expectedRevision:value.timelineRevision,purpose:value.purpose,...(timelineRenderDeliveryFields(value.snapshot as never) as object)})||!timeline||value.snapshot.timeline.id!==timeline.id||value.snapshot.timeline.revision>timeline.revision)invalidTimeline();
   boundary.sources(value.snapshot.timeline as TimelineRecord);if(value.assetId!==null)boundary.asset(value.assetId as string);exportHistory=true;
  }else if(Object.hasOwn(value,'mode')||!Array.isArray(value.snapshot)||!Array.isArray(value.orderedVersionIds))invalidTimeline();
 }
 if(exportHistory)reasons.push('EXPORT_HISTORY');
 const restored=store&&store.db===db?getWorkspaceRestoreContext(store):null;
 const tasks=rows(db,`SELECT position,revision,acknowledged,bytes,${restored?'executionEpoch,':''}${Object.entries({id:36,projectId:36,operation:80,input:8192,requestId:800,digest:64,lane:32,origin:32,status:32,claim:36,claimInstance:36,receiptDigest:64,errorCode:80,createdAt:40,updatedAt:40}).map(([column,bytes])=>bounded(column,bytes)+' AS '+column).join(',')} FROM edit_tasks WHERE projectId=? AND (lane='timeline:mutation' OR operation LIKE 'timeline.%') ORDER BY position`,input.projectId);
 let pendingCount=0;
 for(const row of tasks){
  const saved=parse(row.input),task={id:row.id,projectId:row.projectId,operation:row.operation,input:saved,requestId:row.requestId,digest:row.digest,lane:row.lane,status:row.status,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,acknowledged:row.acknowledged===1,origin:row.origin,...(row.errorCode===null?{}:{errorCode:row.errorCode})};
  if(!isEditTask(task)||!integer(row.position,1)||row.bytes!==16384||![0,1].includes(row.acknowledged as number)||row.lane!=='timeline:mutation'||row.digest!==hash({operation:row.operation as string,input:saved})||
   (row.claim===null)!==(row.claimInstance===null)||row.claim!==null&&(!uuid(row.claim)||!uuid(row.claimInstance))||
   (row.status==='applied')!==(row.receiptDigest!==null)||row.receiptDigest!==null&&!digest(row.receiptDigest)||
   (row.status==='not_applied')!==(row.errorCode!==null)||row.status==='dispatching'&&row.claim===null||row.status==='prepared'&&(row.origin!=='new'||row.claim!==null))invalidTimeline();
  if(row.status==='not_applied'&&!hasRequestNotAppliedProof({code:row.errorCode,status:409,details:{mutationOutcome:'not_applied',operation:row.operation as string,projectId:input.projectId,requestId:row.requestId}},saved,{operation:row.operation as string}))invalidTimeline();
  const retained=readTimelineReceipt(db,saved as TimelineRecoveryInput,row.operation as string);
  if(row.status==='applied'&&!retained||row.status==='not_applied'&&retained)invalidTimeline();
  if(retained){
   if(retained.requestHash!==row.digest)invalidTimeline();
   const response=createTimelineRecoveryBoundary(db,saved as TimelineRecoveryInput).replay(row.operation as string,retained.response as string);
   if(row.receiptDigest!==null&&row.receiptDigest!==hash(response))invalidTimeline();
  }
  if(restored&&row.executionEpoch!==restored.workspaceOrigin){if(row.executionEpoch!=='captured')invalidTimeline();continue;}
  if(row.acknowledged===1)continue;
  if(++pendingCount>1)invalidTimeline();
  const executing=admission&&executingTimelineFormatTask(db);
  const own=executing&&executing.id===row.id&&executing.claim===row.claim&&executing.claimInstance===row.claimInstance&&row.status==='dispatching'&&
   row.operation==='timeline.format.set'&&row.projectId===input.projectId&&row.requestId===input.requestId&&canonicalFormatValue(saved)===canonicalFormatValue(input)&&row.digest===formatRequestHash(input);
  if(!own)reasons.push('PENDING_EDIT');
 }
 const preset=timelineOutputPreset(timeline??DEFAULT_TIMELINE_OUTPUT_PRESET)!;
 if(!preset)invalidTimeline();
 return {project,timeline,boundary,response:{projectId:input.projectId,projectRevision:project.revision,timelineId:timeline?.id??null,timelineRevision:timeline?.revision??0,presetId:preset.id,fps:preset.fps,width:preset.width,height:preset.height,eligible:reasons.length===0,blockedReasons:reasons}};
}
export function getTimelineFormat(db: DatabaseSync,input: TimelineRecoveryInput,options: TimelineFormatStateOptions={}): TimelineFormatResponse{
 if(db.isTransaction)return readTimelineFormatState(db,input,options).response;
 db.exec('BEGIN');try{const result=readTimelineFormatState(db,input,options).response;db.exec('COMMIT');return result;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function assertTimelineFormatEligible(state: TimelineFormatStateResult): void{
 if(!state.response.eligible)throw new AppError('TIMELINE_FORMAT_LOCKED','只有尚未编辑、导出或保留其他编辑请求的空白时间线可以修改输出规格',409,{blockedReasons:state.response.blockedReasons});
}

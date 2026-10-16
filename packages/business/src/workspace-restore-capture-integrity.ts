// Additional read-only rejection gate for already validated historical restores.
// This is not catalog admission or execution authority. Historical constructors
// and their captured bytes remain frozen; current 40/41 use their own boundary.
import type {DatabaseSync, SQLInputValue, SQLOutputValue} from 'node:sqlite';
import {createHash} from 'node:crypto';

type HistoricalRestoreVersion = 25 | 27 | 29 | 31 | 33 | 35 | 37 | 39;
interface Family {readonly table: string; readonly key: string; readonly project: string | null; readonly request: string | null; readonly operation: string | null; readonly namespace: string | null}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
function fail(code: string, message=code): never {throw Object.assign(new Error(message),{code});}
const quote=(name: string)=>`"${name.replaceAll('"','""')}"`;
const sqlString=(value: string)=>`'${value.replaceAll("'","''")}'`;

const annotationFamilies=Object.freeze([
 ['jobs','id','projectId',null,null,'job'],['exports','id','projectId',"CASE WHEN json_valid(data) THEN json_extract(data,'$.requestId') END",null,'export'],
 ['versions','id','projectId'],['job_events','id',null],
 ['timeline_requests','requestId',null,'requestId',null,'timeline'],['reference_requests','requestId',null,'requestId',null,'reference'],
 ['idempotency',"json_array(scope,requestId)",null,'requestId',null,'scope'],
 ['mutation_requests','requestId','projectId','requestId','operation','local-mutation'],['asset_range_requests','requestId','projectId','requestId','operation','local-mutation'],['asset_disposition_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['asset_annotations','assetId','projectId'],['asset_annotation_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['subject_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['agent_chat_threads','id','projectId'],['agent_chat_requests','requestId','projectId','requestId',null,'chat'],['agent_chat_runs','id','projectId','requestId'],
 ['agent_chat_events',"json_array(runId,seq)",null],['agent_chat_steps','id','projectId'],['agent_chat_quota','id',null],['agent_edit_proposals','id','projectId'],
 ['edit_tasks','id','projectId','requestId','operation','lane'],
 ['image_groups','id','projectId'],['image_tasks','id','projectId','requestId'],['image_versions','id','projectId'],['image_requests','requestId','projectId','requestId','operation','image'],
 ['image_reviews','id','projectId','requestId',null,'image.review'],['image_remote_runs','taskId','projectId'],['image_remote_observations','id','projectId','requestId',null,'image.remote'],
 ['project_lut_resources','id','projectId'],['lut_import_requests','requestId','projectId','requestId',null,'lut-import'],
 ['frame_tasks','id','projectId','requestId'],['frame_requests','requestId','projectId','requestId','operation','frame'],['waveform_cache','cacheKey','projectId']
].map(([table,key,project,request,operation,namespace])=>Object.freeze({table:table!,key:key!,project:project??null,request:request??null,operation:operation??null,namespace:namespace??null})) satisfies Family[]);
// Source comparisons establish identical descriptors across each inventory.
const lutFamilies=Object.freeze(annotationFamilies.filter(family=>!['asset_annotations','asset_annotation_requests'].includes(family.table)));
const baseFamilies=Object.freeze(lutFamilies.filter(family=>!['project_lut_resources','lut_import_requests'].includes(family.table)));
const profiles=Object.freeze({
 25:{sourceSchema:24,profile:'restored-local-v1',families:baseFamilies},
 27:{sourceSchema:26,profile:'restored-local-v2',families:baseFamilies},
 29:{sourceSchema:28,profile:'restored-local-v3',families:lutFamilies},
 31:{sourceSchema:30,profile:'restored-local-v4',families:lutFamilies},
 33:{sourceSchema:32,profile:'restored-local-v5',families:lutFamilies},
 35:{sourceSchema:34,profile:'restored-local-v6',families:lutFamilies},
 37:{sourceSchema:36,profile:'restored-local-v7',families:annotationFamilies},
 39:{sourceSchema:38,profile:'restored-local-v8',families:annotationFamilies},
} as const);
const identity=(family: Family,prefix='')=>{
 if(family.table==='idempotency')return `json_array(${prefix}scope,${prefix}requestId)`;
 if(family.table==='agent_chat_events')return `json_array(${prefix}runId,${prefix}seq)`;
 return `CAST(${prefix}${quote(family.key)} AS TEXT)`;
};
function columns(db: DatabaseSync,table: string): string[]{return db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row=>row.name as string);}
function rowDigest(db: DatabaseSync,table: string,rowid: SQLInputValue,fields: string[]){
 const digest=createHash('sha256');digest.update(String(rowid)+'\0');
 for(const column of fields){
  const cell=db.prepare(`SELECT typeof(${quote(column)}) AS type,length(CAST(${quote(column)} AS BLOB)) AS bytes FROM ${quote(table)} WHERE rowid=?`).get(rowid);
  if(!cell)fail('RESTORE_CAPTURE_CHANGED');digest.update(column+'\0'+cell.type+'\0'+String(cell.bytes)+'\0');
  const expression=cell.type==='real'?`CAST(printf('%!.26g',${quote(column)}) AS BLOB)`:`CAST(${quote(column)} AS BLOB)`;
  const read=db.prepare(`SELECT substr(${expression},?,1048576) AS value FROM ${quote(table)} WHERE rowid=?`);
  for(let offset=1;;offset+=1048576){const value=read.get(offset,rowid)!.value;if(value===null)break;if(!(value instanceof Uint8Array))fail('RESTORE_CAPTURE_CHANGED');if(!value.length)break;digest.update(value);}
 }
 return digest.digest('hex');
}
function capturedIdentityMetadata(db: DatabaseSync,family: Family,rowid: SQLInputValue,saved: Record<string,SQLOutputValue>){
 const bounded=(expression: string | null)=>expression?`CASE WHEN length(CAST(${expression} AS BLOB))<=2048 THEN ${expression} END`:'NULL';
 const ns=family.namespace?(['scope','lane'].includes(family.namespace)?family.namespace:sqlString(family.namespace)):null;
 const row=db.prepare(`SELECT ${bounded(identity(family))} AS id,${bounded(family.project)} AS projectId,${bounded(ns)} AS namespace,${bounded(family.request)} AS requestId,${bounded(family.operation)} AS operation FROM ${quote(family.table)} WHERE rowid=?`).get(rowid);
 if(!row)fail('RESTORE_CAPTURE_CHANGED');
 if(family.table==='exports'){
  const raw=db.prepare(`SELECT CASE WHEN length(CAST(json_extract(data,'$.mode') AS BLOB))<=64 THEN json_extract(data,'$.mode') END AS mode,json_type(data,'$.mode') AS modeType,json_type(data,'$.requestId') AS requestType FROM exports WHERE rowid=?`).get(rowid);
  if(!raw)fail('RESTORE_CAPTURE_CHANGED');
  if((raw.requestType!==null&&raw.requestType!=='null'&&raw.requestType!=='text')||raw.mode===null&&raw.modeType!==null&&raw.modeType!=='null'||row.requestId===null&&raw.requestType!==null&&raw.requestType!=='null'||raw.mode!==null&&(raw.mode!=='timeline'&&raw.mode!=='storyboard'))fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
  row.namespace=raw.mode==='timeline'?'timeline':'export';row.operation=raw.mode==='timeline'?'timeline.render':'export.create';
  {
   // Reopening uses the original captured key and existing receipt PK. It must
   // not reverse-scan an ever-growing live receipt table for each old export.
   if(typeof saved.requestId!=='string'||!saved.requestId.length||(saved.namespace!=='export'&&saved.namespace!=='timeline')||(row.requestId!==null&&row.requestId!==saved.requestId)||(raw.mode!==null&&row.namespace!==saved.namespace))fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
   const receipt=saved.namespace==='export'
    ?db.prepare("SELECT CASE WHEN length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS id FROM idempotency WHERE scope='export' AND requestId=?").get(saved.requestId)
    :db.prepare("SELECT CASE WHEN json_valid(response) THEN CASE WHEN length(CAST(json_extract(response,'$.id') AS BLOB))=36 THEN json_extract(response,'$.id') END END AS id,CASE WHEN json_valid(response) THEN CASE WHEN length(CAST(json_extract(response,'$.projectId') AS BLOB))=36 THEN json_extract(response,'$.projectId') END END AS projectId FROM timeline_requests WHERE requestId=?").get(saved.requestId);
   if(receipt&&(receipt.id!==row.id||(saved.namespace==='timeline'&&receipt.projectId!==row.projectId))||!receipt&&row.requestId===null)fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
   row.namespace=saved.namespace;row.requestId=saved.requestId;row.operation=row.namespace==='timeline'?'timeline.render':'export.create';
  }
  if(typeof row.requestId!=='string'||!row.requestId.length)fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
 }
 if(typeof row.id!=='string'||!row.id.length||Buffer.byteLength(row.id)>2048||(family.project&&(typeof row.projectId!=='string'||row.projectId.length!==36||!UUID.test(row.projectId)))||(family.request&&(typeof row.requestId!=='string'||!row.requestId.length))||(family.operation&&(typeof row.operation!=='string'||!row.operation.length)))fail('RESTORE_IDENTITY_INVALID',`Unbounded or invalid captured identity: ${family.table}`);
 return row;
}
/** Call only after the exact historical fixed validator has accepted its
 * catalog, metadata, bounds, archives, disabled families and execution epoch.
 * No SQL descriptors or tables are supplied by callers or imported metadata. */
export function validateHistoricalRestoreCapture(db: DatabaseSync, restoredVersion: HistoricalRestoreVersion): void {
 const expected=Object.hasOwn(profiles,restoredVersion)?profiles[restoredVersion]:undefined;
 if(!expected)fail('RESTORE_SCHEMA_UNSUPPORTED');
 const metadata=db.prepare("SELECT sourceSchema,CASE WHEN length(CAST(profile AS BLOB))<=40 THEN profile END AS profile FROM workspace_restoration LIMIT 2").all();
 if(metadata.length!==1||metadata[0]!.sourceSchema!==expected.sourceSchema||metadata[0]!.profile!==expected.profile)fail('RESTORE_METADATA_INVALID');
 for(const family of expected.families){
  const fields=columns(db,family.table).filter(column=>column!=='executionEpoch');
  const held=db.prepare(`SELECT h.*,t.rowid AS liveRowid FROM workspace_restore_holds h LEFT JOIN ${quote(family.table)} t ON t.rowid=h.capturedRowid WHERE h.kind=?`);
  held.setReadBigInts(true);
  for(const item of held.iterate(family.table)){
   if(typeof item.liveRowid!=='bigint'||item.liveRowid!==item.capturedRowid||typeof item.rowHash!=='string'||!HASH.test(item.rowHash)||rowDigest(db,family.table,item.liveRowid,fields)!==item.rowHash)fail('RESTORE_CAPTURE_CHANGED');
   const binding=capturedIdentityMetadata(db,family,item.liveRowid,item);
   for(const key of ['id','projectId','namespace','requestId','operation'] as const){
    if(binding[key]!==item[key])fail('RESTORE_CAPTURE_CHANGED');
   }
  }
 }
}

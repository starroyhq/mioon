import {randomUUID} from 'node:crypto';
import {taskEffectOrigin} from './agent/task-effects-v2.ts';
import type {AgentTaskJson} from '../../contracts/src/agent-tasks-v2.ts';
import {isProxy} from 'node:util/types';
import type {DatabaseSync} from 'node:sqlite';
import {LUT_RESOURCE_LIMITS,LUT_RESOURCE_PROFILE,lutImportInputSchema,lutListInputSchema,lutInspectInputSchema} from '../../contracts/src/lut-resources.ts';
import type {LutImportInput,LutImportResponse,LutListResponse,LutInspectResponse} from '../../contracts/src/lut-resources.ts';
import {lutResourceError,lutHash,lutInputHash,parseLutBytes,LUT_RESOURCE_COLUMNS,lutResourceFromRow,readLutResource} from './lut-resource-validation.ts';

export interface LutResourceRuntime {
  ownsLock():boolean;
  assertReadable():void;
  assertImportAllowed():void;
}
export type LutImportFaultPoint='beforeInsert'|'afterResourceInsert'|'afterReceiptInsert'|'beforeCommit'|'afterCommit';
export interface LutResourceOptions {
  runtime:LutResourceRuntime;
  signal?:AbortSignal;
  /** Trusted test-only interruption seam, never part of an RPC input. */
  fault?:(point:LutImportFaultPoint)=>void;
}
export function assertLutReadProfile(schemaVersion:number):void {
  if(schemaVersion!==29&&schemaVersion!==31&&schemaVersion!==33&&schemaVersion!==35&&schemaVersion!==37&&schemaVersion!==39&&schemaVersion!==41&&schemaVersion!==45&&schemaVersion!==49&&schemaVersion!==51)throw lutResourceError('RESTORE_OPERATION_UNAVAILABLE',409);
}
/** The verified restore-53 assembly is a separate generation. Preserve the
 * historical read gate above for callers bound to frozen restore profiles. */
export function assertAgentTaskLutReadProfile(schemaVersion:number):void {
  if(schemaVersion===53||schemaVersion===55)return;
  assertLutReadProfile(schemaVersion);
}
function input<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T {
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw lutResourceError('VALIDATION_ERROR',400);
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||
      !['string','number'].includes(typeof descriptor.value))throw lutResourceError('VALIDATION_ERROR',400);
  }
  const parsed=schema.safeParse(value);if(!parsed.success)throw lutResourceError('VALIDATION_ERROR',400);return parsed.data;
}
function decode(value:string):Buffer {
  if(value.length>LUT_RESOURCE_LIMITS.base64Characters)throw lutResourceError('LUT_SOURCE_TOO_LARGE',413);
  if(value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/u.test(value))throw lutResourceError('LUT_FORMAT_UNSUPPORTED',400);
  // Byte count is known from the encoded length before any allocation.
  const length=value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);
  if(length>LUT_RESOURCE_LIMITS.sourceBytes)throw lutResourceError('LUT_SOURCE_TOO_LARGE',413);
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length!==length||bytes.toString('base64')!==value)throw lutResourceError('LUT_FORMAT_UNSUPPORTED',400);
  return bytes;
}
function databaseBytes(db:DatabaseSync):number {
  const pages=db.prepare('PRAGMA main.page_count').get()?.page_count,size=db.prepare('PRAGMA main.page_size').get()?.page_size;
  if(typeof pages!=='number'||typeof size!=='number'||!Number.isSafeInteger(pages)||!Number.isSafeInteger(size)||pages<0||size<=0)throw lutResourceError();
  return pages*size;
}

/** All effects are one synchronous SQLite transaction under the existing
 * workspace lease. No paths, media registration, worker scheduling or renderer.
 * Bytes and exact receipt commit together; a lost response is recovered only by
 * explicitly replaying the same caller-owned request. */
export function createLutResourceServices(store:{db:DatabaseSync},{runtime,signal,fault=()=>{}}:LutResourceOptions){
  const {db}=store;
  const owned=():void=>{runtime.assertReadable();if(signal?.aborted||!runtime.ownsLock())throw lutResourceError('LUT_OWNER_REQUIRED',503);};
  const project=(projectId:string):void=>{
    const row=db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM main.projects WHERE id=?").get(projectId);
    if(!row)throw lutResourceError('LUT_NOT_FOUND',404);
    let value:unknown;try{if(typeof row.data!=='string')throw Error();value=JSON.parse(row.data);}catch{throw lutResourceError();}
    if(!value||typeof value!=='object'||!('id' in value)||value.id!==projectId||row.id!==projectId)throw lutResourceError();
  };
  const replay=(i:LutImportInput,digest:string):LutImportResponse|null=>{
    const row=db.prepare(`SELECT CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
      CASE WHEN length(CAST(inputHash AS BLOB))=64 THEN inputHash END AS inputHash,
      CASE WHEN length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS resourceId FROM main.lut_import_requests WHERE requestId=?`).get(i.requestId);
    if(!row)return null;
    if(row.projectId!==i.projectId||row.inputHash!==digest)throw lutResourceError('IDEMPOTENCY_CONFLICT',409);
    if(typeof row.resourceId!=='string')throw lutResourceError();
    const resource=readLutResource(db,i.projectId,row.resourceId,true);
    if(lutInputHash(i,resource.sha256,resource.sizeBytes)!==digest||resource.name!==i.name)throw lutResourceError();
    return {requestId:i.requestId,resource};
  };
  function importLut(value:unknown):LutImportResponse {
    owned();runtime.assertImportAllowed();
    // Explicit over-limit diagnostic precedes the generic shape validator.
    if(value&&typeof value==='object'&&!isProxy(value)){
      const field=Object.getOwnPropertyDescriptor(value,'dataBase64');
      if(field&&'value' in field&&typeof field.value==='string'&&field.value.length>LUT_RESOURCE_LIMITS.base64Characters)throw lutResourceError('LUT_SOURCE_TOO_LARGE',413);
    }
    const i=input(lutImportInputSchema,value);project(i.projectId);
    const bytes=decode(i.dataBase64),sha256=lutHash(bytes),digest=lutInputHash(i,sha256,bytes.length);
    const saved=replay(i,digest);if(saved)return saved;
    const parsed=parseLutBytes(bytes),metadata=JSON.stringify(parsed.metadata);
    owned();runtime.assertImportAllowed();
    if(db.isTransaction)throw lutResourceError('LUT_TRANSACTION_UNAVAILABLE',503);
    const origin=taskEffectOrigin();origin?.beforeEffect();
    db.exec('BEGIN IMMEDIATE');let committed=false,commitAttempted=false;
    try{
      owned();runtime.assertImportAllowed();project(i.projectId);
      const concurrent=replay(i,digest);
      if(concurrent){commitAttempted=true;db.exec('COMMIT');committed=true;return concurrent;}
      // Do not assume free pages will be reused. Reserve twice the input plus
      // index/receipt headroom; then inspect actual page_count before COMMIT.
      // Other future project activity can still outgrow backup's existing cap.
      if(databaseBytes(db)+2*bytes.length+LUT_RESOURCE_LIMITS.databaseReserveBytes>LUT_RESOURCE_LIMITS.databaseBytes)throw lutResourceError('LUT_CAPACITY',507);
      const counts=db.prepare(`SELECT count(*) AS count,COALESCE(SUM(sizeBytes),0) AS bytes,
        COALESCE(SUM(CASE WHEN projectId=? THEN 1 ELSE 0 END),0) AS projectCount,
        COALESCE(SUM(CASE WHEN projectId=? THEN sizeBytes ELSE 0 END),0) AS projectBytes FROM main.project_lut_resources`).get(i.projectId,i.projectId)!;
      if(Number(counts.count)>=LUT_RESOURCE_LIMITS.workspaceResources||Number(counts.projectCount)>=LUT_RESOURCE_LIMITS.projectResources||
        Number(counts.bytes)+bytes.length>LUT_RESOURCE_LIMITS.workspaceBytes||Number(counts.projectBytes)+bytes.length>LUT_RESOURCE_LIMITS.projectBytes||
        Number(db.prepare('SELECT count(*) AS count FROM main.lut_import_requests').get()?.count)>=LUT_RESOURCE_LIMITS.receipts)throw lutResourceError('LUT_CAPACITY',507);
      const id=randomUUID(),createdAt=new Date().toISOString();
      fault('beforeInsert');owned();runtime.assertImportAllowed();
      db.prepare('INSERT INTO main.project_lut_resources(id,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,i.projectId,i.name,sha256,bytes.length,LUT_RESOURCE_PROFILE,metadata,bytes,createdAt);
      fault('afterResourceInsert');owned();
      db.prepare('INSERT INTO main.lut_import_requests(requestId,projectId,inputHash,resourceId) VALUES(?,?,?,?)').run(i.requestId,i.projectId,digest,id);
      fault('afterReceiptInsert');owned();
      const response={requestId:i.requestId,resource:readLutResource(db,i.projectId,id,true)};
      if(databaseBytes(db)>LUT_RESOURCE_LIMITS.databaseBytes)throw lutResourceError('LUT_CAPACITY',507);
      fault('beforeCommit');owned();runtime.assertImportAllowed();
      if(origin){
        origin.beforeEffect();
        if(origin.importHandle){const updated=db.prepare("UPDATE agent_task_imports_v2 SET status='imported',resourceId=? WHERE id=? AND projectId=? AND status='importing'").run(id,origin.importHandle,i.projectId);if(updated.changes!==1)throw Object.assign(Error('Agent import identity changed'),{code:'AGENT_TASK_UNKNOWN_RESULT'});}
        const revision=Number(db.prepare("SELECT revision FROM agent_task_target_revisions_v2 WHERE projectId=? AND kind='lut' AND targetId=?").get(i.projectId,id)?.revision??0);
        const change={projectId:i.projectId,operation:origin.operation,targets:[{kind:'lut',id,revision,revisionBefore:0,revisionAfter:revision}],before:null,after:response.resource as unknown as AgentTaskJson,reversible:false,summary:'导入用户选择的Cube资源'};
        if(origin.recorded){if(!origin.appendChangesInside)throw Error('Agent import origin cannot record changes');origin.appendChangesInside([change]);}
        else{origin.recordInside(response as unknown as AgentTaskJson,[change]);origin.recorded=true;}
      }
      commitAttempted=true;db.exec('COMMIT');committed=true;fault('afterCommit');owned();return response;
    }catch(error){
      const active=db.isTransaction;if(active)db.exec('ROLLBACK');
      if(committed||commitAttempted&&!active)throw lutResourceError('LUT_IMPORT_UNCERTAIN',503);
      if(error instanceof Error&&'code' in error&&typeof error.code==='string'&&!error.code.startsWith('ERR_SQLITE'))throw error;
      throw lutResourceError('LUT_STORAGE_UNAVAILABLE',503);
    }
  }
  function listLuts(value:unknown):LutListResponse {
    owned();const i=input(lutListInputSchema,value);project(i.projectId);
    const rows=db.prepare(`SELECT ${LUT_RESOURCE_COLUMNS} FROM main.project_lut_resources WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(i.projectId,i.after??'',i.limit+1);
    const items=rows.slice(0,i.limit).map(lutResourceFromRow);owned();
    return {projectId:i.projectId,items,nextAfter:rows.length>i.limit?items.at(-1)!.id:null};
  }
  function inspectLut(value:unknown):LutInspectResponse {
    owned();const i=input(lutInspectInputSchema,value);project(i.projectId);
    const resource=readLutResource(db,i.projectId,i.lutId,true);owned();return {resource,integrity:'verified'};
  }
  return {handlers:{'lut.import':importLut,'lut.list':listLuts,'lut.inspect':inspectLut},readers:{'lut.list':listLuts,'lut.inspect':inspectLut}};
}

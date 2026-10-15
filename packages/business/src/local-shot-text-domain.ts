import {usesAssetAnnotationSchema} from './workspace-schema-dispatch.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {LocalShotTextUpdateInput} from '@mioon/contracts/local-shot-text';
import {LOCAL_SHOT_TEXT_LIMITS} from '@mioon/contracts/local-shot-text';
import {LocalShotTextError} from './local-shot-text.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
function invalid():never{throw new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');}
const bound=(name:string,size:number):string=>`CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size} THEN ${name} END AS ${name}`;
const identity=(name:string):string=>`CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB))=36 THEN ${name} END AS ${name}`;
type Table='projects'|'shots'|'assets'|'versions'|'jobs';
const rowLimits:Record<Table,number>={projects:16*1024,shots:1024*1024,assets:16*1024,versions:64*1024,jobs:128*1024};

export interface LocalShotTextDomainOptions {
  db:DatabaseSync;
  canonical(value:unknown):string;
  isRevisionConflict(error:unknown):boolean;
  validateAsset(projectId:string,asset:Record<string,unknown>):unknown;
  /** Existing createLocalMutationServices({readOnly:true}) scoped replay only. */
  replay(projectId:string,input:LocalShotTextUpdateInput):unknown;
  /** Existing services.updateShotInProject, with its in-transaction scope gate. */
  updateShotInProject(projectId:string,input:LocalShotTextUpdateInput):Promise<unknown>;
}

/** Bounds precede materialization and shared read-only replay. This is a private
 * ownership adapter, not another mutation implementation or receipt writer. */
export function createLocalShotTextDomain({db,canonical,replay,updateShotInProject,isRevisionConflict,validateAsset}:LocalShotTextDomainOptions){
  const proofs=new WeakMap<object,string>();
  const key=(projectId:string,input:LocalShotTextUpdateInput):string=>canonical({projectId,input});
  function snapshot<T>(fn:()=>T):T{
    const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
    try{const value=fn();if(!outer)db.exec('COMMIT');return value;}
    catch(error){if(!outer&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  function decode(raw:unknown):Record<string,unknown>{
    if(typeof raw!=='string')invalid();let value:unknown;try{value=JSON.parse(raw);}catch{invalid();}
    if(!object(value))invalid();return value;
  }
  function owned(table:Table,id:unknown,projectId:string,allowMissing=false):Record<string,unknown>|null{
    if(!uuid(id)||!uuid(projectId))invalid();
    const row:unknown=db.prepare(`SELECT ${identity('id')}${table==='projects'?'':','+identity('projectId')}${table==='versions'?','+identity('jobId'):''},${bound('data',rowLimits[table])} FROM ${table} WHERE id=? LIMIT 1`).get(id);
    if(row===undefined&&allowMissing)return null;
    if(!object(row)||row.id!==id||(table!=='projects'&&row.projectId!==projectId))invalid();
    const value=decode(row.data);
    if(value.id!==id||(table==='projects'?value.id!==projectId:value.projectId!==projectId)||(table==='versions'&&value.jobId!==row.jobId))invalid();
    return value;
  }
  function required(table:Table,id:unknown,projectId:string):Record<string,unknown>{const value=owned(table,id,projectId);if(!value)invalid();return value;}
  function relations(shot:Record<string,unknown>,projectId:string):void{
    if(!Array.isArray(shot.referenceAssetIds)||shot.referenceAssetIds.length>8)invalid();
    const asset=(assetId:unknown):Record<string,unknown>=>{const value=required('assets',assetId,projectId);validateAsset(projectId,value);return value;};
    for(const assetId of shot.referenceAssetIds)asset(assetId);
    if(Object.hasOwn(shot,'lastFrameAssetId')&&shot.lastFrameAssetId!==null){const value=asset(shot.lastFrameAssetId);if(!['image/png','image/jpeg','image/webp'].includes(String(value.mimeType)))invalid();}
    if(shot.selectedVersionId!==null&&shot.selectedVersionId!==undefined){
      const version=required('versions',shot.selectedVersionId,projectId);if(version.shotId!==shot.id)invalid();
      asset(version.assetId);const job=required('jobs',version.jobId,projectId);
      if(job.shotId!==shot.id||(job.versionId!==null&&job.versionId!==undefined&&job.versionId!==version.id))invalid();
    }
  }
  function shot(projectId:string,shotId:string):Record<string,unknown>|null{
    if(!owned('projects',projectId,projectId,true))return null;
    const value=owned('shots',shotId,projectId,true);if(!value)return null;
    if(typeof value.title!=='string'||typeof value.prompt!=='string'||!Number.isSafeInteger(value.revision)||Number(value.revision)<1)invalid();
    relations(value,projectId);return value;
  }
  function receipt(projectId:string,input:LocalShotTextUpdateInput):unknown|null{
    return snapshot(()=>{
      // Current ownership is mandatory even for a historical receipt. Foreign
      // relational owners fail before their JSON or retained response is decoded.
      if(!shot(projectId,input.shotId))invalid();
      const columns=[bound('operation',80),identity('projectId'),bound('canonicalInput',LOCAL_SHOT_TEXT_LIMITS.httpBytes),bound('response',LOCAL_SHOT_TEXT_LIMITS.shotResponseBytes)].join(',');
      const tables=['mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests',...usesAssetAnnotationSchema(db)?['asset_annotation_requests']:[]];
      const rows:unknown[]=db.prepare(tables.map(table=>`SELECT '${table}' AS receiptTable,${columns} FROM ${table} WHERE requestId=?`).join(' UNION ALL ')).all(...tables.map(()=>input.requestId));
      if(rows.length===0)return null;
      if(rows.length!==1)invalid();const row=rows[0];
      const {requestId:unused,...fields}=input;void unused;
      if(!object(row)||row.receiptTable!=='mutation_requests'||row.operation!=='shot.update'||row.projectId!==projectId||row.canonicalInput!==canonical(fields))invalid();
      const response=decode(row.response);
      if(response.id!==input.shotId||response.projectId!==projectId)invalid();relations(response,projectId);
      // The existing reader rechecks semantic and typed-media ownership in this
      // same snapshot, and never writes or treats absent replay as authorization.
      const result=replay(projectId,input);if(canonical(result)!==canonical(response))invalid();return result;
    });
  }
  return {
    readShot:(projectId:string,shotId:string):unknown|null=>snapshot(()=>shot(projectId,shotId)),
    readReceipt:receipt,
    async update(projectId:string,input:LocalShotTextUpdateInput):Promise<unknown>{
      try{return await updateShotInProject(projectId,input);}
      catch(error){
        // The narrow text edit can establish fresh rollback only through the
        // actual shared revision rejection. Missing/foreign/permission errors,
        // arbitrary 4xx responses and transport failures remain unresolved.
        if(isRevisionConflict(error)&&object(error)&&error.code==='REVISION_CONFLICT'&&error.status===409&&object(error.details)&&error.details.mutationOutcome==='not_applied'&&error.details.requestId===input.requestId&&error.details.entityId===input.shotId&&error.details.expectedRevision===input.expectedRevision&&Number.isSafeInteger(error.details.currentRevision)&&error.details.currentRevision!==input.expectedRevision&&!db.isTransaction&&receipt(projectId,input)===null)proofs.set(error,key(projectId,input));
        throw error;
      }
    },
    isNotApplied:(projectId:string,input:LocalShotTextUpdateInput,error:unknown):boolean=>object(error)&&proofs.get(error)===key(projectId,input),
  };
}

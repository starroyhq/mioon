// Synthetic SQLite-only qualification helpers. No provider, service, transport,
// media subprocess, network, or installed workspace is opened by this module.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {createWorkspaceRestoreProfileV27} from '../packages/business/src/workspace-restore-schema-v27.ts';
import {createWorkspaceRestoreProfileV29} from '../packages/business/src/workspace-restore-schema-v29.ts';
import {createWorkspaceRestoreProfileV31} from '../packages/business/src/workspace-restore-schema-v31.ts';
import {createWorkspaceRestoreProfileV33} from '../packages/business/src/workspace-restore-schema-v33.ts';
import {createWorkspaceRestoreProfileV35} from '../packages/business/src/workspace-restore-schema-v35.ts';
import {createWorkspaceRestoreProfileV37} from '../packages/business/src/workspace-restore-schema-v37.ts';
import {createWorkspaceRestoreProfileV39} from '../packages/business/src/workspace-restore-schema-v39.ts';
import {classifyWorkspaceSchema,detectWorkspaceRestoreEvidence,installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {createWorkspaceSchemaDispatch} from '../packages/business/src/workspace-schema-dispatch.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,insert,snapshot,quote} from './workspace-schema26-fixtures.mjs';
export {open,insert,snapshot,quote};
export const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const stamp='2026-10-16T00:00:00.000Z';
export const metadata=()=>({restorationId:id(901),workspaceOrigin:id(902),sourceBackupId:id(903),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const dispatch=createWorkspaceSchemaDispatch({initializeThrough24:initializeWorkspaceSchemaThrough24,detectRestoreEvidence:detectWorkspaceRestoreEvidence,classify:classifyWorkspaceSchema,install:installWorkspaceRestoreSchema,validate:validateWorkspaceRestoreSchema});
const initializers=[initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38];
const factories=[null,createWorkspaceRestoreProfileV27,createWorkspaceRestoreProfileV29,createWorkspaceRestoreProfileV31,createWorkspaceRestoreProfileV33,createWorkspaceRestoreProfileV35,createWorkspaceRestoreProfileV37,createWorkspaceRestoreProfileV39];
export const baseFamilies=['jobs','exports','versions','job_events','timeline_requests','reference_requests','idempotency','mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests','agent_chat_threads','agent_chat_requests','agent_chat_runs','agent_chat_events','agent_chat_steps','agent_chat_quota','agent_edit_proposals','edit_tasks','image_groups','image_tasks','image_versions','image_requests','image_reviews','image_remote_runs','image_remote_observations','frame_tasks','frame_requests','waveform_cache'];
export const pairs=[24,26,28,30,32,34,36,38].map((source,index)=>{
 const restored=source+1,raw=factories[index]?.(initializeWorkspaceSchemaThrough24);
 return {source,restored,profile:`restored-local-v${index+1}`,initializers:initializers.slice(0,index+1),
  install:raw?.[`installWorkspaceRestoreSchemaV${restored}`]??installWorkspaceRestoreSchema,
  validate:raw?.[`validateWorkspaceRestoreSchemaV${restored}`]??validateWorkspaceRestoreSchema,
  families:[...baseFamilies.slice(0,10),...(index>=6?['asset_annotations','asset_annotation_requests']:[]),...baseFamilies.slice(10,26),...(index>=2?['project_lut_resources','lut_import_requests']:[]),...baseFamilies.slice(26)],
  sourceFile:`workspace-restore-schema${index?`-v${restored}.ts`:'.ts'}`};
});
export function frozenInventory(pair){
 const source=readFileSync(new URL(`../packages/business/src/${pair.sourceFile}`,import.meta.url),'utf8');
 const block=source.slice(source.indexOf('const families'),source.indexOf('const familyMap'));
 return [...block.matchAll(/\['([a-z_]+)',/g)].map(match=>match[1]);
}
export function fresh(t,pair,{populated=false,mock=false,file=':memory:'}={}){
 const db=open(file);t.after(()=>{if(db.isOpen)db.close();});
 for(const init of pair.initializers)init(db);
 if(populated)seed(db,pair);else db.exec('DELETE FROM agent_chat_quota');
 if(mock){
  // Exact optional catalog from the frozen constructor, not a provider instance.
  const source=readFileSync(new URL(`../packages/business/src/${pair.sourceFile}`,import.meta.url),'utf8');
  const sql=source.match(/const MOCK_SCHEMA_SQL=`([\s\S]*?)`;/)?.[1];assert.ok(sql);db.exec(sql);
  insert(db,'mock_provider_tasks',{provider_job_id:'synthetic-job',request_id:'synthetic-request',snapshot_json:'{}',snapshot_hash:'c'.repeat(64),scenario:'retained-only',created_at_ms:1,ready_at_ms:2});
 }
 return db;
}
export const populatedBase=baseFamilies.slice(0,19);
export function expectedPopulated(pair){return [...populatedBase,...pair.families.filter(name=>!baseFamilies.includes(name))];}
export function seed(db,pair){
 const projectId=id(1),project={id:projectId,name:'Synthetic historical capture 界'};
 insert(db,'projects',{id:projectId,data:JSON.stringify(project)});
 insert(db,'assets',{id:id(2),projectId,data:JSON.stringify({id:id(2),projectId,mimeType:'video/mp4'})});
 insert(db,'jobs',{id:id(10),projectId,data:JSON.stringify({id:id(10),projectId,requestId:'retained-job',status:'interrupted'})});
 insert(db,'versions',{id:id(11),projectId,jobId:id(10),data:JSON.stringify({id:id(11),projectId,jobId:id(10),retained:true})});
 insert(db,'job_events',{id:3,jobId:id(10),event:Buffer.from([0,255,13,10]),createdAt:'retained'});
 insert(db,'exports',{id:id(12),projectId,data:JSON.stringify({id:id(12),projectId,mode:'storyboard',requestId:'retained-export',status:'interrupted'})});
 insert(db,'idempotency',{scope:'export',requestId:'retained-export',requestHash:'a'.repeat(64),resourceId:id(12)});
 insert(db,'timeline_requests',{rowid:9007199254740993n,requestId:'retained-timeline',requestHash:'a'.repeat(64),response:'{"note":"界\\u0000 raw"}'});
 insert(db,'reference_requests',{requestId:'retained-reference',requestHash:'a'.repeat(64),response:'{}'});
 for(const [table,operation] of [['mutation_requests','shot.create'],['asset_range_requests','asset.range.set'],['asset_disposition_requests','asset.disposition.set'],['subject_requests','subject.create']]){
  insert(db,table,{requestId:`retained-${table}`,operation,projectId,canonicalInput:JSON.stringify({projectId}),response:JSON.stringify({projectId})});
 }
 insert(db,'agent_chat_threads',{id:id(20),projectId,revision:0,nextPosition:2});
 insert(db,'agent_chat_requests',{requestId:'retained-chat',projectId,threadId:id(20),runId:id(21),fingerprint:'b'.repeat(64),acceptance:'{}',bytes:2});
 insert(db,'agent_chat_runs',{id:id(21),projectId,threadId:id(20),requestId:'retained-chat',position:1,status:'completed',data:'{}',bytes:2});
 insert(db,'agent_chat_events',{runId:id(21),seq:1,data:'{}',bytes:2});
 insert(db,'agent_chat_steps',{id:id(22),runId:id(21),projectId,position:1,kind:'model',status:'completed',data:'{}',bytes:2});
 insert(db,'agent_edit_proposals',{id:id(23),projectId,runId:id(21),shotId:id(24),digest:'b'.repeat(64),definition:'{}',status:'pending',approval:null,outcome:null,createdAt:stamp,updatedAt:stamp,bytes:2});
 insert(db,'edit_tasks',{position:17,id:id(30),projectId,operation:'timeline.undo',input:JSON.stringify({projectId,requestId:'retained-task',expectedRevision:1}),requestId:'retained-task',digest:'c'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,createdAt:stamp,updatedAt:stamp,bytes:16384});
 insert(db,'timeline_history',{id:id(31),projectId,position:1,operation:'timeline.undo',createdAt:stamp,beforeSnapshot:'{}',afterSnapshot:'{}'});
 insert(db,'timeline_history_cursors',{projectId,position:1});
 if(pair.families.includes('project_lut_resources')){
  const content=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'),hash=sha(content),name='retained.cube';
  insert(db,'project_lut_resources',{id:id(40),projectId,name,sha256:hash,sizeBytes:content.length,profile:'mioon-cube3d-normalized-tetrahedral-v1',metadata:JSON.stringify(parseCube3D(content.toString()).metadata),content,createdAt:stamp});
  insert(db,'lut_import_requests',{requestId:'retained-lut',projectId,inputHash:lutInputHash({projectId,requestId:'retained-lut',name},hash,content.length),resourceId:id(40)});
 }
 if(pair.families.includes('asset_annotations')){
  insert(db,'asset_annotations',{assetId:id(2),projectId,revision:1,tags:'["retained"]',note:'Retained note'});
  const fields={assetId:id(2),expectedRevision:0,note:'Retained note',projectId,tags:['retained']};
  insert(db,'asset_annotation_requests',{requestId:'retained-annotation',operation:'asset.annotation.set',projectId,canonicalInput:JSON.stringify(fields),response:JSON.stringify({id:id(2),assetId:id(2),projectId,revision:1,tags:['retained'],note:'Retained note'})});
 }
}
// All guard removal is limited to owned synthetic fixtures. Restore exact SQL
// before admitting anything. SAVEPOINT rollback also reinstates original data.
export function alter(db,tables,action){
 const guards=db.prepare(`SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (${tables.map(()=>'?').join(',')}) ORDER BY name`).all(...tables);
 const before=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 for(const guard of guards)db.exec(`DROP TRIGGER ${quote(guard.name)}`);
 try{action();}finally{for(const guard of guards)db.exec(guard.sql);}
 assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),before,'exact guard SQL restored before validation');
}
export function probe(db,action){db.exec('SAVEPOINT capture_integrity_probe');try{return action();}finally{db.exec('ROLLBACK TO capture_integrity_probe; RELEASE capture_integrity_probe');}}
export function readOnly(db,action,{code,full=true}={}){
 const before=full?snapshot(db):null,changes=db.prepare('SELECT total_changes() AS n').get().n,transaction=db.isTransaction;
 db.exec('PRAGMA query_only=ON');
 try{if(code)assert.throws(action,{code});else action();}finally{db.exec('PRAGMA query_only=OFF');}
 assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes,'validation performs no SQLite writes');
 assert.equal(db.isTransaction,transaction,'validation preserves transaction ownership');
 if(full)assert.deepEqual(snapshot(db),before,'validation preserves catalog, typed bytes and rowids');
}
// Independent one-shot SQL-byte oracle, deliberately not importing the new
// implementation or its chunk loop. Tests first compare it with hashes emitted
// by unchanged constructors; use only on bounded synthetic fixtures.
export function wholeRowDigest(db,table,rowid){
 const digest=createHash('sha256').update(String(rowid)+'\0');
 for(const {name} of db.prepare(`PRAGMA table_info(${quote(table)})`).all()){
  if(name==='executionEpoch')continue;
  const c=quote(name),cell=db.prepare(`SELECT typeof(${c}) AS type,length(CAST(${c} AS BLOB)) AS bytes,CASE WHEN typeof(${c})='real' THEN CAST(printf('%!.26g',${c}) AS BLOB) ELSE CAST(${c} AS BLOB) END AS content FROM ${quote(table)} WHERE rowid=?`).get(rowid);
  assert.ok(cell);digest.update(name+'\0'+cell.type+'\0'+String(cell.bytes)+'\0');if(cell.content!==null)digest.update(cell.content);
 }
 return digest.digest('hex');
}
export function refreshFixtureHash(db,table){
 const held=db.prepare('SELECT capturedRowid FROM workspace_restore_holds WHERE kind=?');held.setReadBigInts(true);
 for(const {capturedRowid} of held.all(table))db.prepare('UPDATE workspace_restore_holds SET rowHash=? WHERE kind=? AND capturedRowid=?').run(wholeRowDigest(db,table,capturedRowid),table,capturedRowid);
}

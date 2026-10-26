interface ImageSchemaObject {type: string; name: string; tbl_name: string; sql: string}
interface ImageSnapshot {objects: ImageSchemaObject[]; tables: string[]; rows: Record<string, Record<string, unknown>[]>; hashes: Record<string, string[]>}
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import {currentOrdinary48Delta} from './helpers/current-schema-delta.ts';
import {currentMarkerChain} from './helpers/current-schema-delta.ts';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {legacyDatabase,migrate,insert,imageFixture} from './images-fixture.mjs';
import {migrateImageSchema} from '../packages/business/src/image-schema.ts';
import {openStore} from '../packages/business/src/db.ts';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
const schema=(db: DatabaseSync)=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as unknown as ImageSchemaObject[];
const rows=(db: DatabaseSync,table: SQLOutputValue)=>db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
const digest=(value: unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function capture(db: DatabaseSync){const objects=schema(db),tables=objects.filter((r)=>r.type==='table').map(r=>r.name);return {objects,tables,rows:Object.fromEntries(tables.map(t=>[t,rows(db,t)])),hashes:Object.fromEntries(tables.map(t=>[t,rows(db,t).map(digest)]))};}
function assertOld(db: DatabaseSync,before: ImageSnapshot,{startupMigrations=false}={}){
 const objects=schema(db);if(startupMigrations)assertAgentEditTargetTrigger(objects);
 const retained=objects.filter(r=>before.objects.some((old: { name: SQLOutputValue; })=>old.name===r.name)).map(row=>{
  if(startupMigrations&&row.type==='table'&&row.name==='agent_edit_proposals')return normalizeAgentEditProposalObject(row);
  if(!startupMigrations||row.type!=='table'||row.name!=='edit_tasks')return row;
  let sql=row.sql;
  for(const operation of ['timeline.format.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply',...(db.prepare('SELECT 1 FROM schema_version WHERE version=44').get()?['timeline.clip.rippleRemove']:[])]){
   const token=`,'${operation}'`;assert.equal((sql)!.split(token).length,2,`only the explicit later operation ${operation} changes historical SQL`);sql=(sql)!.replace(token,'');
  }
  return Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql});
 });
 const current48=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=48').get());
 const reviewedBefore=before.objects.map((row: { name: string; })=>!current48||row.name==='edit_tasks'||currentOrdinary48Delta.objectSql[row.name]===undefined?row:Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql:currentOrdinary48Delta.objectSql[row.name]}));
 assert.deepEqual(retained,reviewedBefore);
 for(const table of before.tables){
  const actual=rows(db,table),expected=before.rows[table];
  const retainedRows=table==='schema_version'?actual.filter((v)=>(v.version as number)<=15):startupMigrations&&table==='agent_edit_proposals'?legacyAgentEditProposalRows(actual):actual;
  assert.deepEqual(retainedRows,expected,table);assert.deepEqual(retainedRows.map(digest),before.hashes[table],`${table} raw-row hashes`);
 }
}
function seed(db: DatabaseSync){
 const projectId=randomUUID(),assetId=randomUUID(),jobId=randomUUID(),shotId=randomUUID(),versionId=randomUUID(),timelineId=randomUUID();
 insert(db,'projects',{id:projectId,data:`{ "id": "${projectId}", "name":"旧项目 🌱", "revision":1 }`});
 for(const [table,id,extra] of [['assets',assetId,{}],['shots',shotId,{}],['jobs',jobId,{}],['versions',versionId,{jobId}],['nodes',randomUUID(),{}],['edges',randomUUID(),{}],['exports',randomUUID(),{}],['timelines',timelineId,{}]])insert(db,table,{id,projectId,...extra as object,data:`{ "id":"${id}", "projectId":"${projectId}", "legacy": [3, 2, 1] }`});
 insert(db,'job_events',{jobId,event:'legacy event',createdAt:'2026-01-01T00:00:00Z'});
 insert(db,'idempotency',{scope:'old',requestId:randomUUID(),requestHash:'legacy-byte-hash',resourceId:assetId});
 for(const table of ['timeline_requests','reference_requests'])insert(db,table,{requestId:randomUUID(),requestHash:'exact old hash',response:'{ "retained": "原始字节" }'});
 for(const [table,operation] of [['mutation_requests','shot.create'],['asset_range_requests','asset.range.set'],['asset_disposition_requests','asset.disposition.set']])insert(db,table,{requestId:randomUUID(),operation,projectId,canonicalInput:'{ "old": true }',response:'{ "unchanged": true }'});
 insert(db,'workspace_preferences',{projectId,revision:1,state:'{ "dock": "legacy" }'});insert(db,'asset_ranges',{assetId,projectId,revision:1,inFrame:0,outFrame:30});insert(db,'asset_dispositions',{assetId,projectId,revision:1,disposition:'favorite'});
 insert(db,'agent_chat_quota',{id:1,runs:0,bytes:0,reservedBytes:0});
 const requestId=randomUUID(),id=randomUUID(),input=JSON.stringify({projectId,requestId,trackId:randomUUID(),name:'Keep'});
 insert(db,'edit_tasks',{id,projectId,operation:'timeline.track.update',input,requestId,digest:'a'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,claim:null,claimInstance:null,receiptDigest:null,errorCode:null,createdAt:'2026-01-01',updatedAt:'2026-01-01',bytes:16384});
 db.prepare("UPDATE sqlite_sequence SET seq=7000 WHERE name='edit_tasks'").run();return {projectId,assetId};
}

test('independently frozen schema15 upgrades additively; every old row/schema/hash is unchanged across repeated migration',()=>{
 const db=legacyDatabase();try{seed(db);const before=capture(db);migrate(db);assertOld(db,before);
 const added=schema(db).filter(r=>!before.objects.some(old=>old.name===r.name));
 assert.deepEqual(added.filter((r)=>r.type==='table').map(r=>r.name),['image_groups','image_requests','image_tasks','image_versions']);
 assert.ok(added.every((r)=>r.tbl_name.startsWith('image_')||r.name==='reject_legacy_image_asset_owner'));assert.equal((db.prepare('SELECT MAX(version) v FROM schema_version').get())!.v,16);
 const after=capture(db);for(let i=0;i<3;i++)migrate(db);assert.deepEqual(capture(db),after);assertOld(db,before);
 }finally{db.close();}
});

test('schema16 failure rolls back every added object and preserves exact legacy bytes',()=>{
 const db=legacyDatabase();try{seed(db);db.exec("CREATE TRIGGER reject_image_migration_marker BEFORE INSERT ON schema_version WHEN NEW.version=16 BEGIN SELECT RAISE(ABORT,'injected16');END");const before=capture(db);assert.throws(()=>migrate(db),/injected16/);assert.deepEqual(capture(db),before);assert.throws(()=>migrateImageSchema(db),/requires a transaction/);}finally{db.close();}
});

test('new image identities resist updates, delete and INSERT OR REPLACE and dispatch fence never resets',t=>{
 const f=imageFixture(t),{db}=f;f.succeed();
 for(const table of ['image_groups','image_tasks','image_versions','image_requests']){
  assert.throws(()=>db.exec(`DELETE FROM ${table}`),/retained/);
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name).join(',');assert.throws(()=>db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`),/immutable|replaced|number must advance/);
 }
 assert.throws(()=>db.exec('UPDATE image_versions SET data=data'),/immutable/);assert.throws(()=>db.exec('UPDATE image_requests SET response=response'),/immutable/);
 assert.throws(()=>db.exec("UPDATE image_tasks SET state='queued',dispatched=0,revision=revision+1"),/immutable|transition/);
 assert.throws(()=>db.exec("UPDATE image_tasks SET snapshot='{}',revision=revision+1"),/immutable|transition/);
 assert.throws(()=>db.exec("UPDATE image_groups SET name='changed',revision=revision+1"),/immutable/);
 const frozen=rows(db,'image_requests');assert.equal(JSON.parse(frozen[0].response as string).state,'queued');assert.equal(JSON.parse(frozen[0].response as string).revision,1);
});

test('normal startup preserves schema15 rows through later migrations and the explicit format allowlist rebuild',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-image-migration-'));let db: DatabaseSync | null=legacyDatabase(path.join(root,'workbench.sqlite')),store;
 try{seed(db);const before=capture(db);db.close();db=null;store=(openStore(root) as unknown as TypedStore);assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...currentMarkerChain]);assertOld(store.db,before,{startupMigrations:true});const after=capture(store.db);store.close();store=(openStore(root) as unknown as TypedStore);assert.deepEqual(capture(store.db),after);}finally{db?.close();store?.close();rmSync(root,{recursive:true,force:true});}
});

test('interruption and unknown results keep fences and permit only explicit local-result recovery',t=>{
 const f=imageFixture(t),{db}=f;
 db.prepare("UPDATE image_tasks SET state='interrupted_before_dispatch',revision=2 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=3 WHERE id=?").run(f.taskId),/transition/);
 db.prepare("UPDATE image_tasks SET state='cancelled_before_dispatch',revision=3 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE image_tasks SET state='queued',revision=4 WHERE id=?").run(f.taskId),/transition/);
 const g=imageFixture(t),d=g.db;
 d.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(g.taskId);
 d.prepare("UPDATE image_tasks SET state='outcome_unknown',revision=3 WHERE id=?").run(g.taskId);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='queued',dispatched=0,revision=4 WHERE id=?").run(g.taskId),/immutable|transition/);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='persisting',revision=4 WHERE id=?").run(g.taskId),/CHECK constraint/);
 d.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=4 WHERE id=?").run(JSON.stringify(g.receipt),g.taskId);
 d.prepare("UPDATE image_tasks SET state='local_result_error',revision=5 WHERE id=?").run(g.taskId);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=6 WHERE id=?").run(JSON.stringify({...g.receipt,sha256:'b'.repeat(64)}),g.taskId),/immutable/);
 d.prepare("UPDATE image_tasks SET state='persisting',revision=6 WHERE id=?").run(g.taskId);
});

test('one unresolved task occupies its group and published head cannot be erased',t=>{
 const f=imageFixture(t),{db}=f,row=db.prepare('SELECT * FROM image_tasks').get(),id=randomUUID(),requestId=randomUUID();
 assert.throws(()=>insert(db,'image_tasks',{...row,id,requestId,input:JSON.stringify({...f.input,requestId}),snapshot:JSON.stringify({...f.snapshot,taskId:id})}),/UNIQUE constraint/);
 f.succeed();assert.throws(()=>db.exec('UPDATE image_groups SET headVersionId=NULL,revision=revision+1'),/head must advance/);
});

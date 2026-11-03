










import {reviewedCatalogAt} from './helpers/reviewed-schema-layers.ts';
import type {SQLInputValue} from 'node:sqlite';
interface SchemaObject {type:string;name:string;tbl_name:string;sql:string|null}

import test from 'node:test';


import assert from 'node:assert/strict';

import {DatabaseSync, type SQLOutputValue} from 'node:sqlite';

import {readFileSync} from 'node:fs';



import {randomUUID,createHash} from 'node:crypto';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.ts';
import {migrateFrameSchema} from '../packages/business/src/frame-schema.ts';
import {FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,FRAME_LIMITS,canonicalFrameInput as canonical} from '../packages/contracts/src/frame-extraction.ts';
const at='2026-10-11T00:00:00.000Z';
const hash=(value: unknown)=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const insert=(db: DatabaseSync,table: string,row: ArrayLike<unknown>|{ [s: string]: unknown; })=>{const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as SQLInputValue[]);};
function transaction(db: DatabaseSync,fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): unknown; }){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function database(t: test.TestContext|null,filename=':memory:'){
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
 db.exec(readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8'));
 transaction(db,()=>{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(19)');});
 t?.after(()=>db.close());return db;
}
function migrate(db: DatabaseSync){transaction(db,()=>{migrateFrameSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(20)');});}
function capture(db: DatabaseSync){
 const objects=reviewedCatalogAt(60,db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all() as unknown as SchemaObject[]),rows:Record<string,Record<string,SQLOutputValue>[]>={};
 for(const {name} of objects.filter((value)=>value.type==='table'))rows[name as string]=db.prepare(`SELECT rowid AS retainedRowid,* FROM "${name}" ORDER BY rowid`).all();
 return {objects,rows,hashes:Object.fromEntries(Object.entries(rows).map(([name,values])=>[name,values.map(hash)]))};
}


function accept(db: DatabaseSync,{projectId=randomUUID(),sourceAssetId=randomUUID()}={}){
 if(!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))insert(db,'projects',{id:projectId,data:canonical({id:projectId,name:'Frames'})});
 if(!db.prepare('SELECT 1 FROM assets WHERE id=?').get(sourceAssetId))insert(db,'assets',{id:sourceAssetId,projectId,data:canonical({id:sourceAssetId,projectId,mimeType:'video/mp4'})});
 const taskId=randomUUID(),requestId=randomUUID(),assetId=randomUUID(),sourceHash='a'.repeat(64);
 const input={projectId,sourceAssetId,sourceHash,sourceFrame:56,requestId},inputHash=hash(input);
 const snapshot={schemaVersion:1,projectId,taskId,source:{assetId:sourceAssetId,sha256:sourceHash,mimeType:'video/mp4',sizeBytes:12345,relativePath:`media/${sourceAssetId}.mp4`,duration:3,width:1920,height:1080},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const receipt={schemaVersion:1,projectId,taskId,inputHash,sourceAssetId,sourceHash,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:'b'.repeat(64),mimeType:'image/png',width:1024,height:576,byteLength:100,
 probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1920,height:1080,rotation:0,sarNumerator:1,sarDenominator:1}};
 const task={id:taskId,projectId,requestId,sourceAssetId,sourceHash,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 const row={id:taskId,projectId,requestId,inputHash,input:canonical(input),snapshot:canonical(snapshot),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at};
 const request={requestId,operation:'frame.extract',projectId,taskId,inputHash,canonicalInput:canonical(input),response:canonical(task)};
 transaction(db,()=>{insert(db,'frame_tasks',row);insert(db,'frame_requests',request);});
 const start=()=>db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=revision+1 WHERE id=?").run(taskId);
 const stage=(value=receipt)=>db.prepare("UPDATE frame_tasks SET state='persisting',stagedReceipt=?,revision=revision+1 WHERE id=?").run(canonical(value),taskId);
 const succeed=()=>transaction(db,()=>{
  insert(db,'assets',{id:assetId,projectId,data:canonical({id:assetId,projectId,sha256:receipt.sha256,mimeType:'image/png',provenance:'extracted-frame',relativePath:`media/${assetId}.png`,width:1024,height:576,sizeBytes:100})});
  db.prepare("UPDATE frame_tasks SET state='succeeded',assetId=?,revision=revision+1 WHERE id=?").run(assetId,taskId);
 });
 return {db,projectId,sourceAssetId,taskId,requestId,assetId,input,snapshot,receipt,task,row,request,start,stage,succeed};
}
function fixture(t: test.TestContext){const db=database(t);migrate(db);return accept(db);}

// Existing schema19 is established independently from frozen schema18 plus its
// unchanged migrations. The tested schema20 never rewrites that baseline.




test('frame task and original queued ACK commit together and resist mutation, replacement and deletion',t=>{
 const f=fixture(t),{db}=f;
 for(const table of ['frame_tasks','frame_requests']){
  assert.throws(()=>db.exec(`DELETE FROM ${table}`),/retained/);
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(value=>value.name).join(',');
  assert.throws(()=>db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`),/replaced/);
 }
 assert.throws(()=>db.exec('UPDATE frame_requests SET response=response'),/immutable/);
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET snapshot='{}',state='interrupted',revision=2 WHERE id=?").run(f.taskId),/immutable/);
 assert.throws(()=>transaction(db,()=>{
  const taskId=randomUUID(),requestId=randomUUID();insert(db,'frame_tasks',{...f.row,id:taskId,requestId,input:canonical({...f.input,requestId}),snapshot:canonical({...f.snapshot,taskId})});
 }),/FOREIGN KEY/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_tasks').get()!.n,1);
 f.start();f.stage();f.succeed();
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(f.requestId)!.response,canonical(f.task));
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='persisting',revision=revision+1 WHERE id=?").run(f.taskId),/transition/);
 assert.deepEqual((db.prepare('PRAGMA foreign_key_check').all() as unknown),[]);
});

test('start fence, interrupted cancellation and recovery never reopen decoding',t=>{
 const f=fixture(t),{db}=f;
 db.prepare("UPDATE frame_tasks SET state='interrupted',revision=2 WHERE id=?").run(f.taskId);
 assert.throws(()=>f.start(),/immutable|transition/);
 db.prepare("UPDATE frame_tasks SET state='cancelled_before_start',revision=3 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='queued',revision=4 WHERE id=?").run(f.taskId),/transition/);
 const g=accept(db);g.start();db.prepare("UPDATE frame_tasks SET state='interrupted',revision=3 WHERE id=?").run(g.taskId);
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='cancelled_before_start',revision=4 WHERE id=?").run(g.taskId),/transition|CHECK/);
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='running',revision=4 WHERE id=?").run(g.taskId),/transition/);
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='persisting',revision=4 WHERE id=?").run(g.taskId),/CHECK/);
 g.stage();db.prepare("UPDATE frame_tasks SET state='local_result_error',revision=revision+1 WHERE id=?").run(g.taskId);
 assert.throws(()=>g.stage({...g.receipt,sha256:'c'.repeat(64)}),/immutable/);
 g.stage();g.succeed();
});

test('queued admission and active transition caps do not block running-to-persisting or explicit recovery',t=>{
 const f=fixture(t),{db}=f,g=accept(db,{projectId:f.projectId});
 assert.throws(()=>accept(db,{projectId:f.projectId}),/queued task capacity/);
 f.start();assert.throws(()=>g.start(),/active task capacity/);f.stage();
 db.prepare("UPDATE frame_tasks SET state='local_result_error',revision=revision+1 WHERE id=?").run(f.taskId);
 g.start();assert.throws(()=>f.stage(),/active task capacity/);
 db.prepare("UPDATE frame_tasks SET state='interrupted',revision=revision+1 WHERE id=?").run(g.taskId);
 f.stage();f.succeed();
 for(let i=0;i<FRAME_LIMITS.queuedGlobal;i++)accept(db);
 assert.throws(()=>accept(db),/queued task capacity/);
});

test('staged frame ownership excludes legacy and image owners regardless of provenance and raw JSON size',t=>{
 for(const oversized of [false,true]){
  const f=fixture(t),{db}=f;f.start();
  const jobId=randomUUID();insert(db,'jobs',{id:jobId,projectId:f.projectId,data:'{}'});
  insert(db,'versions',{id:randomUUID(),projectId:f.projectId,jobId,data:canonical({assetId:f.assetId,padding:oversized?'x'.repeat(65537):''})});
  assert.throws(()=>f.stage(),/already has an owner/);
 }
 const f=fixture(t),{db}=f;f.start();f.stage();
 const jobId=randomUUID();insert(db,'jobs',{id:jobId,projectId:f.projectId,data:'{}'});
 assert.throws(()=>insert(db,'versions',{id:randomUUID(),projectId:f.projectId,jobId,data:canonical({assetId:f.assetId,provenance:'user-import'})}),/already has an owner/);
 assert.throws(()=>insert(db,'image_versions',{id:randomUUID(),projectId:f.projectId,groupId:randomUUID(),taskId:randomUUID(),number:1,assetId:f.assetId,data:'{}'}),/already has an owner/);
 f.succeed();
 assert.throws(()=>insert(db,'versions',{id:randomUUID(),projectId:f.projectId,jobId,data:canonical({assetId:f.assetId})}),/already has an owner/);
});

test('frame result attachment rejects cross-project publication and altered receipt identity',t=>{
 const f=fixture(t),{db}=f;f.start();
 for(const patch of [{projectId:randomUUID()},{taskId:randomUUID()},{sourceHash:'c'.repeat(64)},{inputHash:'c'.repeat(64)},{assetId:f.sourceAssetId},{width:1025},{byteLength:FRAME_LIMITS.resultBytes+1}])assert.throws(()=>f.stage({...f.receipt,...patch}),/CHECK/);
 f.stage();const otherProjectId=randomUUID();insert(db,'projects',{id:otherProjectId,data:'{}'});
 insert(db,'assets',{id:f.assetId,projectId:otherProjectId,data:canonical({id:f.assetId,projectId:otherProjectId})});
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='succeeded',assetId=?,revision=revision+1 WHERE id=?").run(f.assetId,f.taskId),/task project/);
});

test('control receipt budget is retained per task and exact acknowledgement bytes remain immutable',t=>{
 const f=fixture(t),{db}=f;f.start();f.stage();
 const recover=()=>transaction(db,()=>{
  db.prepare("UPDATE frame_tasks SET state='local_result_error',revision=revision+1 WHERE id=?").run(f.taskId);
  const old=db.prepare('SELECT revision FROM frame_tasks WHERE id=?').get(f.taskId)!.revision;
  f.stage();const requestId=randomUUID(),input={projectId:f.projectId,taskId:f.taskId,expectedRevision:old,requestId};
  const response={...f.task,state:'persisting',revision:(old as number)+1,started:true};
  insert(db,'frame_requests',{requestId,operation:'frame.task.recoverResult',projectId:f.projectId,taskId:f.taskId,inputHash:hash(input),canonicalInput:canonical(input),response:canonical(response)});
 });
 for(let i=1;i<FRAME_LIMITS.requestsPerTask;i++)recover();
 const before=capture(db);assert.throws(recover,/request capacity/);assert.deepEqual(capture(db),before);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_requests WHERE taskId=?').get(f.taskId)!.n,16);
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(f.requestId)!.response,canonical(f.task));
});


test('retained task cap never evicts old acknowledgements or consumes another task control reserve',t=>{
 const db=database(t);migrate(db);const projectId=randomUUID(),sourceAssetId=randomUUID();
 let first;
 for(let i=0;i<FRAME_LIMITS.tasksPerProject;i++){
  const f=accept(db,{projectId,sourceAssetId});first??=f;
  db.prepare("UPDATE frame_tasks SET state='cancelled_before_start',revision=2 WHERE id=?").run(f.taskId);
 }
 const before=capture(db);assert.throws(()=>accept(db,{projectId,sourceAssetId}),/retained task capacity/);assert.deepEqual(capture(db),before);
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(first!.requestId)!.response,canonical(first!.task));
 assert.ok(accept(db).taskId);
});




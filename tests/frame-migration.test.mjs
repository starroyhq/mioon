import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/db.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.mjs';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.mjs';
import {migrateFrameSchema} from '../packages/business/src/frame-schema.mjs';
import {FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,FRAME_LIMITS,canonicalFrameInput as canonical} from '../packages/contracts/src/frame-extraction.mjs';
const at='2026-10-11T00:00:00.000Z';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const insert=(db,table,row)=>{const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function database(t,filename=':memory:'){
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
 db.exec(readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8'));
 transaction(db,()=>{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(19)');});
 t?.after(()=>db.close());return db;
}
function migrate(db){transaction(db,()=>{migrateFrameSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(20)');});}
function capture(db){
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),rows={};
 for(const {name} of objects.filter(value=>value.type==='table'))rows[name]=db.prepare(`SELECT rowid AS retainedRowid,* FROM "${name}" ORDER BY rowid`).all();
 return {objects,rows,hashes:Object.fromEntries(Object.entries(rows).map(([name,values])=>[name,values.map(hash)]))};
}
function assertPreserved(db,before,{startupMigrations=false}={}){
 const after=capture(db);const retained=after.objects.filter(value=>before.objects.some(old=>old.name===value.name)).map(row=>{if(!startupMigrations||row.type!=='table'||row.name!=='edit_tasks')return row;let sql=row.sql;for(const operation of ['timeline.format.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']){const token=`,'${operation}'`;assert.equal(sql.split(token).length,2,`only the explicit later operation ${operation} changes historical SQL`);sql=sql.replace(token,'');}return Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql});});assert.deepEqual(retained,before.objects);
 for(const [name,rows] of Object.entries(before.rows)){
  const values=name==='schema_version'?after.rows[name].filter(value=>value.version<=19):after.rows[name];
  assert.deepEqual(values,rows,name);assert.deepEqual(values.map(hash),before.hashes[name],`${name} raw row hashes`);
 }
}
function seedLegacy(db){
 const projectId=randomUUID(),sourceAssetId=randomUUID(),jobId=randomUUID(),versionId=randomUUID();
 insert(db,'projects',{id:projectId,data:`{ "id":"${projectId}", "name": "旧项目 🌱", "revision":1 }`});
 insert(db,'assets',{id:sourceAssetId,projectId,data:`{ "id":"${sourceAssetId}", "projectId":"${projectId}", "legacy" : [3, 2, 1] }`});
 insert(db,'jobs',{id:jobId,projectId,data:'{ "legacy":true }'});
 insert(db,'versions',{id:versionId,projectId,jobId,data:`{ "id":"${versionId}", "assetId":"${sourceAssetId}", "legacy": "exact 白" }`});
 for(const table of ['timeline_requests','reference_requests'])insert(db,table,{requestId:randomUUID(),requestHash:'retained hash',response:'{ "exact bytes" : [3, 2, 1] }'});
 insert(db,'mutation_requests',{requestId:randomUUID(),operation:'shot.create',projectId,canonicalInput:'{ "old":true }',response:'{ "frozen":true }'});
 insert(db,'idempotency',{scope:'legacy',requestId:randomUUID(),requestHash:'retained',resourceId:sourceAssetId});
 const groupId=randomUUID(),taskId=randomUUID(),imageRequestId=randomUUID(),imageAssetId=randomUUID(),imageVersionId=randomUUID();
 const options={size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1};
 const imageInput={projectId,requestId:imageRequestId,name:'Preserved image',providerId:'mock',model:'mock-image-v1',prompt:'Exact prompt 白',options};
 const imageHash=hash(imageInput),imageSnapshot={schemaVersion:1,projectId,groupId,taskId,name:imageInput.name,providerId:imageInput.providerId,model:imageInput.model,prompt:imageInput.prompt,options};
 const imageReceipt={schemaVersion:1,projectId,groupId,taskId,inputHash:imageHash,assetId:imageAssetId,versionId:imageVersionId,sha256:'e'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:128,isMock:true};
 const imageTask={id:taskId,projectId,groupId,requestId:imageRequestId,name:imageInput.name,providerId:imageInput.providerId,model:imageInput.model,prompt:imageInput.prompt,options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at};
 transaction(db,()=>{
  insert(db,'image_groups',{id:groupId,projectId,name:imageInput.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});
  insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId:imageRequestId,inputHash:imageHash,input:canonical(imageInput),snapshot:canonical(imageSnapshot),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});
  insert(db,'image_requests',{requestId:imageRequestId,operation:'image.generate',projectId,inputHash:imageHash,canonicalInput:canonical(imageInput),response:canonical(imageTask)});
  db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
  db.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(imageReceipt,null,1),taskId);
  insert(db,'assets',{id:imageAssetId,projectId,data:canonical({id:imageAssetId,projectId,mimeType:'image/png',sha256:imageReceipt.sha256,width:1024,height:1024,sizeBytes:128,provenance:'synthetic-mock',relativePath:`media/${imageAssetId}.png`})});
  insert(db,'image_versions',{id:imageVersionId,projectId,groupId,taskId,number:1,assetId:imageAssetId,data:canonical({id:imageVersionId,projectId,groupId,taskId,number:1,assetId:imageAssetId,sha256:imageReceipt.sha256,mimeType:'image/png',width:1024,height:1024,byteLength:128,isMock:true,providerId:imageInput.providerId,model:imageInput.model,options,createdAt:at})});
  db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(imageVersionId,taskId);
  db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(imageVersionId,groupId);
 });
 return {projectId,sourceAssetId,imageAssetId};
}
function accept(db,{projectId=randomUUID(),sourceAssetId=randomUUID()}={}){
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
function fixture(t){const db=database(t);migrate(db);return accept(db);}

// Existing schema19 is established independently from frozen schema18 plus its
// unchanged migrations. The tested schema20 never rewrites that baseline.
test('schema20 adds exactly two tables and preserves every pre-existing row, rowid, receipt, index and trigger',t=>{
 const db=database(t);seedLegacy(db);const before=capture(db);migrate(db);assertPreserved(db,before);
 const added=capture(db).objects.filter(value=>!before.objects.some(old=>old.name===value.name));
 assert.deepEqual(added.filter(value=>value.type==='table').map(value=>value.name),['frame_requests','frame_tasks']);
 assert.ok(added.every(value=>value.tbl_name.startsWith('frame_')||['reject_legacy_frame_asset_owner','reject_image_frame_asset_owner'].includes(value.name)));
 assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,20);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 const after=capture(db),changes=db.prepare('SELECT total_changes() AS n').get().n;
 migrate(db);migrate(db);assert.deepEqual(capture(db),after);assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes);
});

test('schema20 marker failure rolls back all added objects and keeps raw legacy content',t=>{
 const db=database(t);seedLegacy(db);db.exec("CREATE TRIGGER refuse_schema20 BEFORE INSERT ON schema_version WHEN NEW.version=20 BEGIN SELECT RAISE(ABORT,'injected20');END");
 const before=capture(db);assert.throws(()=>migrate(db),/injected20/);assert.deepEqual(capture(db),before);
 assert.throws(()=>migrateFrameSchema(db),/requires a transaction/);
});

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
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_tasks').get().n,1);
 f.start();f.stage();f.succeed();
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(f.requestId).response,canonical(f.task));
 assert.throws(()=>db.prepare("UPDATE frame_tasks SET state='persisting',revision=revision+1 WHERE id=?").run(f.taskId),/transition/);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
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
  const old=db.prepare('SELECT revision FROM frame_tasks WHERE id=?').get(f.taskId).revision;
  f.stage();const requestId=randomUUID(),input={projectId:f.projectId,taskId:f.taskId,expectedRevision:old,requestId};
  const response={...f.task,state:'persisting',revision:old+1,started:true};
  insert(db,'frame_requests',{requestId,operation:'frame.task.recoverResult',projectId:f.projectId,taskId:f.taskId,inputHash:hash(input),canonicalInput:canonical(input),response:canonical(response)});
 });
 for(let i=1;i<FRAME_LIMITS.requestsPerTask;i++)recover();
 const before=capture(db);assert.throws(recover,/request capacity/);assert.deepEqual(capture(db),before);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_requests WHERE taskId=?').get(f.taskId).n,16);
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(f.requestId).response,canonical(f.task));
});


test('retained task cap never evicts old acknowledgements or consumes another task control reserve',t=>{
 const db=database(t);migrate(db);const projectId=randomUUID(),sourceAssetId=randomUUID();
 let first;
 for(let i=0;i<FRAME_LIMITS.tasksPerProject;i++){
  const f=accept(db,{projectId,sourceAssetId});first??=f;
  db.prepare("UPDATE frame_tasks SET state='cancelled_before_start',revision=2 WHERE id=?").run(f.taskId);
 }
 const before=capture(db);assert.throws(()=>accept(db,{projectId,sourceAssetId}),/retained task capacity/);assert.deepEqual(capture(db),before);
 assert.equal(db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(first.requestId).response,canonical(first.task));
 assert.ok(accept(db).taskId);
});


test('real fresh and independently frozen schema19 workspace startup produce identical frame invariants',t=>{
 const roots=['fresh','upgraded'].map(name=>mkdtempSync(path.join(tmpdir(),`mioon-frame-${name}-`)));
 t.after(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
 const file=path.join(roots[1],'workbench.sqlite');writeFileSync(file,'',{mode:0o600});
 const legacy=database(null,file);seedLegacy(legacy);
 // The frozen SQL fixture stores schema only. A genuinely started schema19
 // workspace already has this unchanged journal-bootstrap singleton.
 legacy.exec('INSERT INTO agent_chat_quota(id,runs,bytes,reservedBytes) VALUES(1,0,0,0)');
 const before=capture(legacy);legacy.close();
 const fresh=openStore(roots[0]),upgraded=openStore(roots[1]);
 try{
  assertPreserved(upgraded.db,before,{startupMigrations:true});
  const frameObjects=db=>capture(db).objects.filter(value=>value.tbl_name.startsWith('frame_')||['reject_legacy_frame_asset_owner','reject_image_frame_asset_owner'].includes(value.name));
  assert.deepEqual(frameObjects(upgraded.db),frameObjects(fresh.db));
  for(const store of [fresh,upgraded]){
   assert.equal(store.db.prepare('SELECT max(version) AS v FROM schema_version').get().v,22);
   assert.equal(store.db.prepare('SELECT count(*) AS n FROM frame_tasks').get().n,0);
   assert.equal(store.db.prepare('SELECT count(*) AS n FROM frame_requests').get().n,0);
   assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }
 }finally{fresh.close();upgraded.close();}
});

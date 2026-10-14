import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.mjs';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {canonicalImageInput as canonical} from '../packages/contracts/src/images.mjs';
import {COMFY_IMAGE_OPTIONS,COMFY_IMAGE_POLICY,DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.mjs';
import {buildComfyWorkflow,hashComfyWorkflow} from '../packages/business/src/comfy/workflow.mjs';
const fixtureSql=readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const options={size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1},at='2026-10-10T00:00:00.000Z';
const model='gpt-image-2.5-flare-2026-09-08',destination='https://api.openai.com/v1/images/generations';
const policy={maxPostAttempts:1,automaticRetry:false,price:'usage-based-unknown',promptStorage:'local-plaintext'};
const insert=(db,table,value)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
function database(file=':memory:'){const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureSql);return db;}
function snapshot(db){const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();const rows={};for(const {name} of objects.filter(value=>value.type==='table')){const query=db.prepare(`SELECT rowid AS retainedRowid,* FROM "${name}" ORDER BY rowid`);query.setReadBigInts(true);rows[name]=query.all();}return {objects,rows};}
function migrate(db){db.exec('BEGIN IMMEDIATE');try{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(19);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function sameOld(db,before){const after=snapshot(db),next=new Map(after.objects.map(value=>[value.name,value]));const agentTargets=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=24').get());if(agentTargets)assertAgentEditTargetTrigger(after.objects);for(const value of before.objects){if(value.name==='image_reviews')continue;if(value.name==='edit_tasks'&&db.prepare('SELECT 1 FROM schema_version WHERE version=21').get()){const current=next.get(value.name);let sql=current.sql;const operations=['timeline.format.set',...(db.prepare('SELECT 1 FROM schema_version WHERE version=22').get()?['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']:[]),...(db.prepare('SELECT 1 FROM schema_version WHERE version=26').get()?['timeline.loudness.apply']:[])];for(const operation of operations){const token=`,'${operation}'`;assert.equal(sql.split(token).length,2,operation);sql=sql.replace(token,'');}assert.deepEqual(Object.assign(Object.create(Object.getPrototypeOf(current)),current,{sql}),value);continue;}if(value.name==='image_task_state_transitions'){const current=next.get(value.name);assert.ok(current.sql.includes('image_remote_observations'));const restored=current.sql.replace(/\(OLD.state IN \('local_result_error','outcome_unknown'\) AND NEW.state='persisting'\) OR[\s\S]*?\)\)\)\n BEGIN/,"(OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting'))\n BEGIN");assert.equal(restored,value.sql);continue;}assert.deepEqual(agentTargets&&value.type==='table'&&value.name==='agent_edit_proposals'?normalizeAgentEditProposalObject(next.get(value.name)):next.get(value.name),value,value.name);}for(const [name,rows] of Object.entries(before.rows))assert.deepEqual(name==='schema_version'?after.rows[name].filter(row=>row.version<=18n):agentTargets&&name==='agent_edit_proposals'?legacyAgentEditProposalRows(after.rows[name]):after.rows[name],rows,name);}
function seed(db){
 insert(db,'agent_chat_quota',{id:1,runs:0,bytes:0,reservedBytes:0});
 const projectId=randomUUID();insert(db,'projects',{id:projectId,data:`{ "id": "${projectId}", "name": "原始项目", "revision": 1 }`});
 insert(db,'timeline_requests',{requestId:randomUUID(),requestHash:'retained-hash',response:'{ "old": "exact bytes 原始" }'});
 insert(db,'reference_requests',{requestId:randomUUID(),requestHash:'retained-reference',response:'{ "retained" : [3, 2, 1] }'});
 const records=[];
 for(const [index,state] of ['pending','rejected','approved','dispatched','pending','rejected','approved','dispatched'].entries()){
  const providerId=index<4?'openai':'openai-compatible', selectedModel=index<4?model:'vendor/model';
  const reviewId=randomUUID(),requestId=randomUUID(),groupId=randomUUID(),taskId=randomUUID();
  const input={projectId,requestId,name:'Keep original',providerId,model:selectedModel,prompt:'Exact prompt 白',options};
  const raw=canonical(input),intent=canonical(index<4?{schemaVersion:1,reviewId,input,settingsRevision:7,destination,policy}:{schemaVersion:2,reviewId,input,settingsRevision:7,destination:'https://images.example.test/v1/images/generations',policy,configuration:{enabled:true,providerId,connectionId:'custom',profileId:'openai-images-json-png-v1',baseUrl:'https://images.example.test/v1',model:selectedModel,options}});
  insert(db,'image_reviews',{rowid:(index+1)*13,id:reviewId,projectId,requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(intent),canonicalIntent:intent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});
  if(state==='rejected')db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=? WHERE id=?").run(at,reviewId);
  if(state==='approved'||state==='dispatched'){
   const snap=canonical({schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId,model:selectedModel,options});
   insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});
   insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash:hash(raw),input:raw,snapshot:snap,state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});
   db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=? WHERE id=?").run(taskId,at,reviewId);
   const ack={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId,model:selectedModel,options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at};
   insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash:hash(raw),canonicalInput:raw,response:JSON.stringify(ack)});
   if(state==='dispatched'){
    db.prepare("UPDATE image_reviews SET state='dispatched',revision=3,postAttempts=1,dispatchedAt=? WHERE id=?").run(at,reviewId);
    db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
    const assetId=randomUUID(),versionId=randomUUID(),receipt={schemaVersion:1,projectId,groupId,taskId,inputHash:hash(raw),assetId,versionId,sha256:'a'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:false};
    db.prepare("UPDATE image_tasks SET state='persisting',revision=3,stagedReceipt=? WHERE id=?").run(JSON.stringify(receipt),taskId);
    insert(db,'assets',{id:assetId,projectId,data:JSON.stringify({id:assetId,projectId,name:'Old.png',mimeType:'image/png',width:1024,height:1024,sizeBytes:512,sha256:receipt.sha256,relativePath:`media/${assetId}.png`,provenance:'generated',createdAt:at})});
    const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:receipt.sha256,mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:false,providerId,model:selectedModel,options,createdAt:at};
    insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
    db.prepare("UPDATE image_tasks SET state='succeeded',revision=4,versionId=? WHERE id=?").run(versionId,taskId);
    db.prepare('UPDATE image_groups SET revision=2,activeTaskId=NULL,headVersionId=? WHERE id=?').run(versionId,groupId);
   }
  }
  records.push({reviewId,taskId,input,state});
 }
 return {projectId,records};
}

function localFixture(db){
 const projectId=randomUUID(),taskId=randomUUID(),groupId=randomUUID(),reviewId=randomUUID(),requestId=randomUUID();
 insert(db,'projects',{id:projectId,data:JSON.stringify({id:projectId,name:'Comfy migration'})});
 const input={projectId,requestId,name:'Local image',providerId:'comfy-local',model:'model.safetensors',prompt:'One red tree',options:COMFY_IMAGE_OPTIONS};
 const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl:'http://127.0.0.1:8188',model:input.model};
 const seed=123,outputNonce=randomUUID(),graph=buildComfyWorkflow({prompt:input.prompt,checkpoint:input.model,seed,outputNonce});
 const execution={workflowId:'comfy-t2i-png-v1',workflowVersion:1,comfyVersion:'0.39.0',seed,promptId:randomUUID(),clientId:randomUUID(),outputNonce,filenamePrefix:`mioon_${outputNonce}`,graph,graphHash:hashComfyWorkflow(graph)};
 const intent={schemaVersion:3,reviewId,input,settingsRevision:1,destination:configuration.baseUrl+'/prompt',policy:COMFY_IMAGE_POLICY,configuration,execution};
 const raw=canonical(input),rawIntent=canonical(intent);
 insert(db,'image_reviews',{id:reviewId,projectId,requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(rawIntent),canonicalIntent:rawIntent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});
 insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});
 const snapshot=canonical({schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options});
 insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash:hash(raw),input:raw,snapshot,state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});
 db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=? WHERE id=?").run(taskId,at,reviewId);
 const {graph:_,...identity}=execution;
 const run={taskId,projectId,reviewId,...identity,baseUrl:configuration.baseUrl,rawGraph:canonical(graph),state:'prepared',revision:1,contentVerified:0,outputDescriptor:null,errorCode:null,createdAt:at,updatedAt:at,lastObservedAt:null};
 insert(db,'image_remote_runs',run);
 return {projectId,taskId,groupId,reviewId,requestId,input,intent,run};
}
function observe(db,f){
 db.prepare('UPDATE image_remote_runs SET revision=revision+1 WHERE taskId=?').run(f.taskId);
 const remoteRevision=db.prepare('SELECT revision FROM image_remote_runs WHERE taskId=?').get(f.taskId).revision;
 const requestId=randomUUID(),id=randomUUID(),input={projectId:f.projectId,taskId:f.taskId,expectedRevision:remoteRevision-1,requestId};
 const acknowledgement={id,projectId:f.projectId,taskId:f.taskId,requestId,state:'queued',revision:1,remoteRevision,createdAt:at};
 const row={requestId,id,projectId:f.projectId,taskId:f.taskId,inputHash:hash(canonical(input)),canonicalInput:canonical(input),response:canonical(acknowledgement),state:'queued',revision:1,remoteRevision,errorCode:null,createdAt:at,updatedAt:at};
 insert(db,'image_remote_observations',row);return row;
}

test('frozen independent schema18 upgrade retains every old row/rowid/raw string and all but the one narrowly extended trigger',()=>{
 const db=database();try{db.exec('BEGIN');seed(db);db.exec('COMMIT');const before=snapshot(db);migrate(db);sameOld(db,before);
 assert.equal(db.prepare('SELECT max(version) AS version FROM schema_version').get().version,19);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 const after=snapshot(db),changes=db.prepare('SELECT total_changes() AS n').get().n;migrate(db);assert.deepEqual(snapshot(db),after);assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes);
 }finally{db.close();}
});
test('copy/drop/remote-schema/marker interruptions roll the complete schema19 transaction back',()=>{
 for(const phase of ['copy','drop','remote','marker']){const db=database();try{db.exec('BEGIN');seed(db);db.exec('COMMIT');
 if(phase==='marker')db.exec("CREATE TRIGGER refuse_schema19 BEFORE INSERT ON schema_version WHEN NEW.version=19 BEGIN SELECT RAISE(ABORT,'synthetic-marker');END");
 const before=snapshot(db),adapter={get isTransaction(){return db.isTransaction;},prepare:sql=>db.prepare(sql),exec(sql){db.exec(sql);if(phase==='copy'&&sql.startsWith('INSERT INTO image_reviews_v19')||phase==='drop'&&sql.startsWith('DROP TABLE image_reviews;')||phase==='remote'&&sql.includes('CREATE TABLE IF NOT EXISTS image_remote_runs'))throw new Error('synthetic-interruption');}};
 db.exec('BEGIN IMMEDIATE');assert.throws(()=>{migrateComfyImageReviewSchema(adapter);migrateComfyImageSchema(adapter);db.exec('INSERT INTO schema_version VALUES(19)');},/synthetic/);db.exec('ROLLBACK');assert.deepEqual(snapshot(db),before);
 }finally{db.close();}}
});
test('schema19 admits bound local review/remote identity and keeps graph and journal immutable',()=>{
 const db=database();try{migrate(db);db.exec('BEGIN');const f=localFixture(db);db.exec('COMMIT');
 for(const sql of ["UPDATE image_remote_runs SET rawGraph='{}',revision=2",'UPDATE image_remote_runs SET seed=321,revision=2','DELETE FROM image_remote_runs','INSERT OR REPLACE INTO image_remote_runs SELECT * FROM image_remote_runs'])assert.throws(()=>db.exec(sql),/immutable|retained|replaced|bind/);
 assert.throws(()=>db.prepare('UPDATE image_remote_runs SET rawGraph=?,revision=2').run(JSON.stringify({blob:'x'.repeat(32768)})),/immutable|CHECK/);
 db.exec('BEGIN');const row=observe(db,f);db.exec('COMMIT');assert.throws(()=>db.exec("UPDATE image_remote_observations SET response='{}',revision=2,state='running'"),/immutable|CHECK/);
 assert.throws(()=>db.exec('DELETE FROM image_remote_observations'),/retained/);
 assert.throws(()=>insert(db,'image_remote_observations',{...row,id:randomUUID(),requestId:randomUUID()}),/CHECK|UNIQUE|retained/);
 assert.throws(()=>insert(db,'image_requests',{requestId:row.requestId,operation:'image.task.recoverResult',projectId:f.projectId,inputHash:row.inputHash,canonicalInput:row.canonicalInput,response:JSON.stringify({projectId:f.projectId})}),/already retained/);
 db.exec('BEGIN');assert.throws(()=>observe(db,f),/UNIQUE/);db.exec('ROLLBACK');
 const original=db.prepare('SELECT response FROM image_remote_observations').get().response;
 db.exec("UPDATE image_remote_observations SET state='running',revision=2; UPDATE image_remote_observations SET state='interrupted',revision=3,errorCode='COMFY_OBSERVATION_INTERRUPTED'");
 assert.equal(db.prepare('SELECT response FROM image_remote_observations').get().response,original);
 assert.throws(()=>db.exec("UPDATE image_remote_observations SET state='queued',revision=4"),/transition/);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
test('only a bound running observation of content-verified local failure can close an unknown image task',()=>{
 const db=database();try{migrate(db);db.exec('BEGIN');const f=localFixture(db);db.exec('COMMIT');
 db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(f.taskId);
 db.prepare("UPDATE image_tasks SET state='outcome_unknown',revision=3 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE image_tasks SET state='failed',revision=4 WHERE id=?").run(f.taskId),/transition/);
 db.exec('BEGIN');observe(db,f);db.exec('COMMIT');
 db.exec("UPDATE image_remote_observations SET state='running',revision=2");
 assert.throws(()=>db.exec("UPDATE image_remote_runs SET state='failed',revision=3"),/CHECK/);
 db.exec('BEGIN');db.exec("UPDATE image_remote_runs SET state='failed',contentVerified=1,revision=3");
 db.prepare("UPDATE image_tasks SET state='failed',revision=4,errorCode='COMFY_EXECUTION_FAILED' WHERE id=?").run(f.taskId);
 db.exec("UPDATE image_remote_observations SET state='finished',revision=3;COMMIT");
 assert.equal(db.prepare('SELECT state FROM image_tasks WHERE id=?').get(f.taskId).state,'failed');
 assert.throws(()=>db.exec("UPDATE image_remote_runs SET state='queued',contentVerified=0,revision=4"),/immutable|transition/);
 }finally{db.close();}
});
test('completed local result pins descriptor, hash and byte count before any later local recovery',()=>{
 const db=database();try{migrate(db);db.exec('BEGIN');const f=localFixture(db);db.exec('COMMIT');
 assert.throws(()=>db.exec("UPDATE image_remote_runs SET state='completed',contentVerified=1,revision=2"),/CHECK/);
 const descriptor=canonical({filename:`${f.run.filenamePrefix}_00001_.png`,subfolder:'',type:'output'});
 db.prepare("UPDATE image_remote_runs SET state='completed',contentVerified=1,outputDescriptor=?,resultSha256=?,resultBytes=1024,revision=2 WHERE taskId=?").run(descriptor,'a'.repeat(64),f.taskId);
 for(const sql of ["UPDATE image_remote_runs SET resultSha256='"+'b'.repeat(64)+"',revision=3",'UPDATE image_remote_runs SET resultBytes=1025,revision=3',"UPDATE image_remote_runs SET outputDescriptor='{}',revision=3","UPDATE image_remote_runs SET state='unavailable',contentVerified=0,outputDescriptor=NULL,resultSha256=NULL,resultBytes=NULL,revision=3"])
  assert.throws(()=>db.exec(sql),/immutable|transition/);
 db.exec('UPDATE image_remote_runs SET revision=3');assert.equal(db.prepare('SELECT resultSha256 FROM image_remote_runs').get().resultSha256,'a'.repeat(64));
 }finally{db.close();}
});
test('normal startup upgrades frozen schema18 once and restarts without rewriting retained bytes',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-comfy-migration-'));let db=database(path.join(root,'workbench.sqlite')),store;
 try{db.exec('BEGIN');seed(db);db.exec('COMMIT');const before=snapshot(db);db.close();db=null;store=openStore(root);sameOld(store.db,before);assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,i)=>i+1),26]);const after=snapshot(store.db);store.close();store=openStore(root);assert.deepEqual(snapshot(store.db),after);}
 finally{db?.close();store?.close();rmSync(root,{recursive:true,force:true});}
});
test('unsafe local settings fail preflight before SQLite or backend-owned files are created',()=>{
 for(const kind of ['symlink','oversize']){const root=mkdtempSync(path.join(tmpdir(),'mioon-comfy-preflight-'));
 try{const directory=path.join(root,'comfy-settings');mkdirSync(directory,{mode:0o700});
 if(kind==='symlink'){const target=path.join(root,'outside.json');writeFileSync(target,'{}',{mode:0o600});symlinkSync(target,path.join(directory,'settings.json'));}
 else writeFileSync(path.join(directory,'settings.json'),'x'.repeat(16385),{mode:0o600});
 assert.throws(()=>openStore(root));assert.equal(existsSync(path.join(root,'workbench.sqlite')),false);assert.equal(existsSync(path.join(root,'server.lock')),false);
 }finally{rmSync(root,{recursive:true,force:true});}}
});

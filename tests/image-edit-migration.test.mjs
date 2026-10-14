import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {normalizeImageReviewObject} from './image-edit-migration-preservation.mjs';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrateImageEditReviewSchema} from '../packages/business/src/images/review-schema.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {canonicalImageInput as canonical} from '../packages/contracts/src/images.mjs';
import {COMFY_IMAGE_OPTIONS,COMFY_IMAGE_POLICY,DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.mjs';
import {buildComfyWorkflow,hashComfyWorkflow} from '../packages/business/src/comfy/workflow.mjs';
const fixtureSql=readFileSync(new URL('./fixtures/image-edit-legacy-schema22.sql',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const options={size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1},at='2026-10-11T00:00:00.000Z';
const model='gpt-image-2.5-flare-2026-09-08',destination='https://api.openai.com/v1/images/generations';
const policy={maxPostAttempts:1,automaticRetry:false,price:'usage-based-unknown',promptStorage:'local-plaintext'};
const insert=(db,table,value)=>{const keys=Object.keys(value);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
function database(file=':memory:'){const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureSql);return db;}
function snapshot(db){const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),rows={},foreignKeys={};for(const {name} of objects.filter(value=>value.type==='table')){const query=db.prepare(`SELECT rowid AS retainedRowid,* FROM "${name}" ORDER BY rowid`);query.setReadBigInts(true);rows[name]=query.all();foreignKeys[name]=db.prepare(`PRAGMA foreign_key_list("${name}")`).all();}return {objects,rows,foreignKeys};}
function normalizeStartupTaskObject(row){
 const token=",'timeline.loudness.apply'";
 assert.equal(row.sql.split(token).length,2,'startup adds exactly one explicit loudness operation token');
 return Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql:row.sql.replace(token,'')});
}
function sameOld(db,before,{startupMigrations=false}={}){
 const after=snapshot(db),next=new Map(after.objects.map(value=>[value.name,value]));
 assert.equal(after.objects.length,before.objects.length+(startupMigrations?1:0));
 if(startupMigrations){
  const added=after.objects.filter(value=>!before.objects.some(old=>old.type===value.type&&old.name===value.name));
  assert.equal(added.length,1);assertAgentEditTargetTrigger(added);
 }
 for(const old of before.objects){
  const current=next.get(old.name);
  const normalized=old.name==='image_reviews'?normalizeImageReviewObject(current):startupMigrations&&old.type==='table'&&old.name==='agent_edit_proposals'?normalizeAgentEditProposalObject(current):startupMigrations&&old.type==='table'&&old.name==='edit_tasks'?normalizeStartupTaskObject(current):current;
  assert.deepEqual(normalized,old,old.name);
 }
 assert.deepEqual(after.foreignKeys,before.foreignKeys);
 for(const [name,rows] of Object.entries(before.rows)){
  const actual=name==='schema_version'?after.rows[name].filter(row=>row.version<=22n):startupMigrations&&name==='agent_edit_proposals'?legacyAgentEditProposalRows(after.rows[name]):after.rows[name];
  assert.deepEqual(actual,rows,name);
 }
}
function migrate(db,adapter=db){db.exec('PRAGMA foreign_keys=OFF');try{db.exec('BEGIN IMMEDIATE');migrateImageEditReviewSchema(adapter);db.exec('INSERT OR IGNORE INTO schema_version VALUES(23);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}}
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
  insert(db,'image_reviews',{rowid:index===0?9007199254741111n:(index+1)*13,id:reviewId,projectId,requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(intent),canonicalIntent:intent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});
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

function populate(db){db.exec('BEGIN');const old=seed(db),local=localFixture(db);observe(db,local);const jobId=randomUUID();insert(db,'jobs',{id:jobId,projectId:old.projectId,data:'{ "legacy" : "exact bytes" }'});insert(db,'job_events',{jobId,event:'retained',createdAt:at});db.exec('COMMIT');return {old,local};}
function editIntent(projectId){const sourceImage={assetId:randomUUID(),sha256:'a'.repeat(64),mimeType:'image/png',byteLength:512,width:320,height:180,name:'Original.png',origin:{kind:'user-import'}},input={projectId,requestId:randomUUID(),name:'Edit',providerId:'openai',model,prompt:'Make it blue',options,purpose:'edit',inputImage:{assetId:sourceImage.assetId,sha256:sourceImage.sha256}};return {schemaVersion:4,reviewId:randomUUID(),input,settingsRevision:1,destination:'https://api.openai.com/v1/images/edits',policy,sourceImage};}
function saveReview(db,intent){const input=canonical(intent.input),raw=canonical(intent);return insert(db,'image_reviews',{id:intent.reviewId,projectId:intent.input.projectId,requestId:intent.input.requestId,inputHash:hash(input),canonicalInput:input,intentHash:hash(raw),canonicalIntent:raw,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});}

test('schema23 changes only image_reviews CHECKs and preserves every row, rowid, raw receipt, trigger, index, FK and sequence',()=>{
 const db=database();try{populate(db);const before=snapshot(db);migrate(db);sameOld(db,before);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.ok(db.prepare("SELECT sql FROM sqlite_schema WHERE name='image_reviews'").get().sql.includes('image_review_intent_v23'));
 const after=snapshot(db);db.exec('BEGIN');migrateImageEditReviewSchema(db);db.exec('COMMIT');assert.deepEqual(snapshot(db),after);
 for(const statement of ['DELETE FROM image_reviews','UPDATE image_reviews SET revision=revision+1','INSERT OR REPLACE INTO image_reviews SELECT * FROM image_reviews'])assert.throws(()=>db.exec(statement),/retained|transition|replaced|pending/);
 }finally{db.close();}
});

test('schema23 copy, external-trigger drop, parent drop, trigger restore, FK check and marker failures roll back byte-exact',()=>{
 for(const phase of ['create','copy','external-trigger','drop','restore','foreign-key','marker']){const db=database();try{populate(db);if(phase==='marker')db.exec("CREATE TRIGGER refuse_schema23 BEFORE INSERT ON schema_version WHEN NEW.version=23 BEGIN SELECT RAISE(ABORT,'synthetic-marker');END");const before=snapshot(db);const adapter={get isTransaction(){return db.isTransaction;},prepare(sql){if(phase==='foreign-key'&&sql==='PRAGMA foreign_key_check')throw new Error('synthetic-foreign-key');return db.prepare(sql);},exec(sql){db.exec(sql);if(phase==='create'&&sql.startsWith('CREATE TABLE image_reviews_v23')||phase==='copy'&&sql.startsWith('INSERT INTO image_reviews_v23')||phase==='external-trigger'&&sql.startsWith('DROP TRIGGER')||phase==='drop'&&sql.startsWith('DROP TABLE image_reviews;')||phase==='restore'&&sql.includes('CREATE TRIGGER')&&sql.includes('immutable_image_review_identity'))throw new Error('synthetic-interruption');}};
 assert.throws(()=>migrate(db,adapter),/synthetic/);assert.deepEqual(snapshot(db),before,phase);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}}
});

test('schema23 admits only a bound official edit descriptor and rejects cross-branch, oversized and mutable source authority',()=>{
 const db=database();try{const {old}=populate(db);migrate(db);const valid=editIntent(old.projectId);saveReview(db,valid);
 const imageSource={imageGroupId:randomUUID(),imageTaskId:randomUUID(),imageVersionId:randomUUID()},frameSource={frameTaskId:randomUUID(),sourceAssetId:randomUUID(),sourceHash:'b'.repeat(64),sourceFrame:30,fps:30,profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1'};
 for(const origin of [{kind:'generated',imageSource},{kind:'synthetic-mock',imageSource},{kind:'extracted-frame',frameSource}]){const v=editIntent(old.projectId);v.sourceImage.origin=origin;saveReview(db,v);}
 for(const mutate of [v=>{v.schemaVersion=1;},v=>{v.destination=destination;},v=>{v.input.providerId='mock';},v=>{v.input.model='other';},v=>{delete v.input.purpose;},v=>{delete v.input.inputImage;},v=>{v.input.inputImage.mask='unsupported';},v=>{v.input.mask='unsupported';},v=>{delete v.sourceImage;},v=>{v.sourceImage.assetId=randomUUID();},v=>{v.sourceImage.sha256='b'.repeat(64);},v=>{v.sourceImage.byteLength=8388609;},v=>{v.sourceImage.width=1025;},v=>{v.sourceImage.height=1.5;},v=>{v.sourceImage.name='x'.repeat(201);},v=>{v.sourceImage.origin={};},v=>{v.sourceImage.origin={kind:'generated'};},v=>{v.sourceImage.origin={kind:'user-import',imageSource};},v=>{v.sourceImage.origin={kind:'extracted-frame',frameSource:{...frameSource,fps:60}};},v=>{v.sourceImage.path='/private';},v=>{v.policy.automaticRetry=true;},v=>{v.options={};}]){const changed=structuredClone(editIntent(old.projectId));mutate(changed);assert.throws(()=>saveReview(db,changed),/CHECK/,JSON.stringify(changed));}
 const changed=structuredClone(valid);changed.sourceImage.name='Changed.png';const raw=canonical(changed);assert.throws(()=>db.prepare('UPDATE image_reviews SET canonicalIntent=?,intentHash=?,revision=2 WHERE id=?').run(raw,hash(raw),valid.reviewId),/immutable/);
 }finally{db.close();}
});

test('fresh startup and frozen schema22 upgrade restore FK enforcement and restart without rewriting old bytes',()=>{
 for(const mode of ['fresh','upgrade']){const root=mkdtempSync(path.join(tmpdir(),'mioon-edit-migration-'));let db,store;try{let before;if(mode==='upgrade'){db=database(path.join(root,'workbench.sqlite'));populate(db);before=snapshot(db);db.close();db=null;}store=openStore(root);assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,index)=>index+1),26]);assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);if(before)sameOld(store.db,before,{startupMigrations:true});const after=snapshot(store.db);store.close();store=openStore(root);assert.deepEqual(snapshot(store.db),after);}finally{db?.close();store?.close();rmSync(root,{recursive:true,force:true});}}
});

test('startup marker failure preserves frozen database and enables a later successful retry',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-edit-failed-migration-'));let db=database(path.join(root,'workbench.sqlite')),store;
 try{populate(db);db.exec("CREATE TRIGGER refuse_schema23 BEFORE INSERT ON schema_version WHEN NEW.version=23 BEGIN SELECT RAISE(ABORT,'synthetic-marker');END");const before=snapshot(db);db.close();db=null;assert.throws(()=>openStore(root),/synthetic-marker/);db=new DatabaseSync(path.join(root,'workbench.sqlite'));assert.deepEqual(snapshot(db),before);db.exec('DROP TRIGGER refuse_schema23');db.close();db=null;store=openStore(root);assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.ok(store.db.prepare('SELECT 1 FROM schema_version WHERE version=23').get());}
 finally{db?.close();store?.close();rmSync(root,{recursive:true,force:true});}
});


test('schema23 rejects missing transaction, an unguarded rebuild and an actual broken foreign-key graph',()=>{
 const db=database();try{populate(db);assert.throws(()=>migrateImageEditReviewSchema(db),/transaction/);db.exec('BEGIN');assert.throws(()=>migrateImageEditReviewSchema(db),/isolated startup/);db.exec('ROLLBACK');
 db.exec('PRAGMA foreign_keys=OFF');insert(db,'assets',{id:randomUUID(),projectId:randomUUID(),data:'{}'});db.exec('PRAGMA foreign_keys=ON');const before=snapshot(db);assert.throws(()=>migrate(db),/foreign key verification/);assert.deepEqual(snapshot(db),before);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 }finally{db.close();}
});

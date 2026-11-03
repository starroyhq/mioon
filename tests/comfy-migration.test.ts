







import test from 'node:test';


import assert from 'node:assert/strict';

import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.ts';
import {openLegacyWorkspaceStore as openStore} from '../packages/business/src/db.ts';
import {canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {COMFY_IMAGE_OPTIONS,COMFY_IMAGE_POLICY,DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';
import {buildComfyWorkflow,hashComfyWorkflow} from '../packages/business/src/comfy/workflow.ts';
const fixtureSql=readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8');
const hash=(value: string)=>createHash('sha256').update(value).digest('hex');
const options={size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1},at='2026-10-10T00:00:00.000Z';
const model='gpt-image-2.5-flare-2026-09-08',destination='https://api.openai.com/v1/images/generations';
const policy={maxPostAttempts:1,automaticRetry:false,price:'usage-based-unknown',promptStorage:'local-plaintext'};
type SchemaObject = {type: string; name: string; tbl_name: string; sql: string};
type Snapshot = {objects: SchemaObject[]; rows: Record<string, unknown[]>};
const insert=(db: DatabaseSync,table: string,value: Record<string, unknown>)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value) as never[]);};
function database(file=':memory:'): DatabaseSync{const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureSql);return db;}

function migrate(db: DatabaseSync){db.exec('BEGIN IMMEDIATE');try{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(19);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}



function localFixture(db: DatabaseSync){
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
function observe(db: DatabaseSync,f: ReturnType<typeof localFixture>){
 db.prepare('UPDATE image_remote_runs SET revision=revision+1 WHERE taskId=?').run(f.taskId);
 const remoteRevision=(db.prepare('SELECT revision FROM image_remote_runs WHERE taskId=?').get(f.taskId) as {revision: number}).revision;
 const requestId=randomUUID(),id=randomUUID(),input={projectId:f.projectId,taskId:f.taskId,expectedRevision:remoteRevision-1,requestId};
 const acknowledgement={id,projectId:f.projectId,taskId:f.taskId,requestId,state:'queued',revision:1,remoteRevision,createdAt:at};
 const row={requestId,id,projectId:f.projectId,taskId:f.taskId,inputHash:hash(canonical(input)),canonicalInput:canonical(input),response:canonical(acknowledgement),state:'queued',revision:1,remoteRevision,errorCode:null,createdAt:at,updatedAt:at};
 insert(db,'image_remote_observations',row);return row;
}



test('schema19 admits bound local review/remote identity and keeps graph and journal immutable',()=>{
 const db=database();try{migrate(db);db.exec('BEGIN');const f=localFixture(db);db.exec('COMMIT');
 for(const sql of ["UPDATE image_remote_runs SET rawGraph='{}',revision=2",'UPDATE image_remote_runs SET seed=321,revision=2','DELETE FROM image_remote_runs','INSERT OR REPLACE INTO image_remote_runs SELECT * FROM image_remote_runs'])assert.throws(()=>db.exec(sql),/immutable|retained|replaced|bind/);
 assert.throws(()=>db.prepare('UPDATE image_remote_runs SET rawGraph=?,revision=2').run(JSON.stringify({blob:'x'.repeat(32768)})),/immutable|CHECK/);
 db.exec('BEGIN');const row=observe(db,f);db.exec('COMMIT');assert.throws(()=>db.exec("UPDATE image_remote_observations SET response='{}',revision=2,state='running'"),/immutable|CHECK/);
 assert.throws(()=>db.exec('DELETE FROM image_remote_observations'),/retained/);
 assert.throws(()=>insert(db,'image_remote_observations',{...row,id:randomUUID(),requestId:randomUUID()}),/CHECK|UNIQUE|retained/);
 assert.throws(()=>insert(db,'image_requests',{requestId:row.requestId,operation:'image.task.recoverResult',projectId:f.projectId,inputHash:row.inputHash,canonicalInput:row.canonicalInput,response:JSON.stringify({projectId:f.projectId})}),/already retained/);
 db.exec('BEGIN');assert.throws(()=>observe(db,f),/UNIQUE/);db.exec('ROLLBACK');
 const original=(db.prepare('SELECT response FROM image_remote_observations').get() as {response: string}).response;
 db.exec("UPDATE image_remote_observations SET state='running',revision=2; UPDATE image_remote_observations SET state='interrupted',revision=3,errorCode='COMFY_OBSERVATION_INTERRUPTED'");
 assert.equal((db.prepare('SELECT response FROM image_remote_observations').get() as {response: string}).response,original);
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
 assert.equal((db.prepare('SELECT state FROM image_tasks WHERE id=?').get(f.taskId) as {state: string}).state,'failed');
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
 db.exec('UPDATE image_remote_runs SET revision=3');assert.equal((db.prepare('SELECT resultSha256 FROM image_remote_runs').get() as {resultSha256: string}).resultSha256,'a'.repeat(64));
 }finally{db.close();}
});

test('unsafe local settings fail preflight before SQLite or backend-owned files are created',()=>{
 for(const kind of ['symlink','oversize']){const root=mkdtempSync(path.join(tmpdir(),'mioon-comfy-preflight-'));
 try{const directory=path.join(root,'comfy-settings');mkdirSync(directory,{mode:0o700});
 if(kind==='symlink'){const target=path.join(root,'outside.json');writeFileSync(target,'{}',{mode:0o600});symlinkSync(target,path.join(directory,'settings.json'));}
 else writeFileSync(path.join(directory,'settings.json'),'x'.repeat(16385),{mode:0o600});
 assert.throws(()=>openStore(root));assert.equal(existsSync(path.join(root,'workbench.sqlite')),false);assert.equal(existsSync(path.join(root,'server.lock')),false);
 }finally{rmSync(root,{recursive:true,force:true});}}
});

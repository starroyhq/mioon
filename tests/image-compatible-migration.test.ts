



















import test from 'node:test';



import assert from 'node:assert/strict';

import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';


import {randomUUID,createHash} from 'node:crypto';
import {migrateCustomImageReviewSchema} from '../packages/business/src/images/review-schema.ts';


const fixtureSql=readFileSync(new URL('./fixtures/images-legacy-schema17.sql',import.meta.url),'utf8');
interface CompatSchemaObject {type: string; name: string; tbl_name: string; sql: string; [key: string]: unknown}
interface CompatRow {[key: string]: unknown}
interface CompatSnapshot {objects: CompatSchemaObject[]; rows: Record<string, CompatRow[]>}
interface CompatIntentView {schemaVersion: number; configuration: {model: string; connectionId: string; profileId: string; enabled: boolean; [key: string]: unknown};
  destination: string; settingsRevision: number; [key: string]: unknown}
const canonical=(value: unknown): string=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const hash=(value: string)=>createHash('sha256').update(value).digest('hex');
const options={size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1},at='2026-10-10T00:00:00.000Z';
const model='gpt-image-2.5-flare-2026-09-08',destination='https://api.openai.com/v1/images/generations';
const policy={maxPostAttempts:1,automaticRetry:false,price:'usage-based-unknown',promptStorage:'local-plaintext'};
const insert=(db: DatabaseSync,table: string,value: CompatRow)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value) as import('node:sqlite').SQLInputValue[]);};
function database(file: string=':memory:'): DatabaseSync {const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureSql);return db;}

// Only the independently frozen52 catalog may be projected out of the legacy
// comparison. Check exact SQL, fields and initial rows before stripping it.


function seed(db: DatabaseSync) {
 insert(db,'agent_chat_quota',{id:1,runs:0,bytes:0,reservedBytes:0});
 const projectId=randomUUID();insert(db,'projects',{id:projectId,data:`{ "id": "${projectId}", "name": "原始项目", "revision": 1 }`});
 insert(db,'timeline_requests',{requestId:randomUUID(),requestHash:'retained-hash',response:'{ "old": "exact bytes 原始" }'});
 insert(db,'reference_requests',{requestId:randomUUID(),requestHash:'retained-reference',response:'{ "retained" : [3, 2, 1] }'});
 const records=[];
 for(const [index,state] of ['pending','rejected','approved','dispatched'].entries()){
  const reviewId=randomUUID(),requestId=randomUUID(),groupId=randomUUID(),taskId=randomUUID();
  const input={projectId,requestId,name:'Keep original',providerId:'openai',model,prompt:'Exact prompt 白',options};
  const raw=canonical(input),intent=canonical({schemaVersion:1,reviewId,input,settingsRevision:7,destination,policy});
  insert(db,'image_reviews',{rowid:(index+1)*13,id:reviewId,projectId,requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(intent),canonicalIntent:intent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});
  if(state==='rejected')db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=? WHERE id=?").run(at,reviewId);
  if(state==='approved'||state==='dispatched'){
   const snap=canonical({schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:'openai',model,options});
   insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});
   insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash:hash(raw),input:raw,snapshot:snap,state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});
   db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=? WHERE id=?").run(taskId,at,reviewId);
   const ack={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:'openai',model,options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at};
   insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash:hash(raw),canonicalInput:raw,response:JSON.stringify(ack)});
   if(state==='dispatched'){
    db.prepare("UPDATE image_reviews SET state='dispatched',revision=3,postAttempts=1,dispatchedAt=? WHERE id=?").run(at,reviewId);
    db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
    const assetId=randomUUID(),versionId=randomUUID(),receipt={schemaVersion:1,projectId,groupId,taskId,inputHash:hash(raw),assetId,versionId,sha256:'a'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:false};
    db.prepare("UPDATE image_tasks SET state='persisting',revision=3,stagedReceipt=? WHERE id=?").run(JSON.stringify(receipt),taskId);
    insert(db,'assets',{id:assetId,projectId,data:JSON.stringify({id:assetId,projectId,name:'Old.png',mimeType:'image/png',width:1024,height:1024,sizeBytes:512,sha256:receipt.sha256,relativePath:`media/${assetId}.png`,provenance:'generated',createdAt:at})});
    const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:receipt.sha256,mimeType:'image/png',width:1024,height:1024,byteLength:512,isMock:false,providerId:'openai',model,options,createdAt:at};
    insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
    db.prepare("UPDATE image_tasks SET state='succeeded',revision=4,versionId=? WHERE id=?").run(versionId,taskId);
    db.prepare('UPDATE image_groups SET revision=2,activeTaskId=NULL,headVersionId=? WHERE id=?').run(versionId,groupId);
   }
  }
  records.push({reviewId,taskId,input,state});
 }
 return {projectId,records};
}
function migrate(db: DatabaseSync): void {db.exec('BEGIN IMMEDIATE');try{migrateCustomImageReviewSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(18);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}





test('schema18 SQL permits exact custom v2 and rejects cross-branch or mismatched frozen authority',()=>{
 const db=database();try{db.exec('BEGIN');const f=seed(db);db.exec('COMMIT');migrate(db);const build=()=>{const reviewId=randomUUID(),input={projectId:f.projectId,requestId:randomUUID(),name:'Custom',providerId:'openai-compatible',model:'vendor/model',prompt:'Original',options};const configuration={enabled:true,providerId:'openai-compatible',connectionId:'custom',profileId:'openai-images-json-png-v1',baseUrl:'https://images.example.test/v1',model:input.model,options};return {schemaVersion:2,reviewId,input,settingsRevision:1,destination:configuration.baseUrl+'/images/generations',policy,configuration};};
 const save=(value: ReturnType<typeof build>)=>{const raw=canonical(value.input),intent=canonical(value);insert(db,'image_reviews',{id:value.reviewId,projectId:f.projectId,requestId:value.input.requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(intent),canonicalIntent:intent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});};save(build());
 for(const mutate of [(v: CompatIntentView)=>{v.schemaVersion=1;},(v: CompatIntentView)=>{(v.input as {providerId: string}).providerId='openai';},(v: CompatIntentView)=>{v.configuration.model='other';},(v: CompatIntentView)=>{v.configuration.connectionId='other';},(v: CompatIntentView)=>{v.configuration.profileId='other';},(v: CompatIntentView)=>{v.configuration.enabled=false;},(v: CompatIntentView)=>{v.destination='https://other.example.test/v1/images/generations';},(v: CompatIntentView)=>{delete (v as {configuration?: unknown}).configuration;},(v: CompatIntentView)=>{delete (v as {settingsRevision?: unknown}).settingsRevision;},(v: CompatIntentView)=>{v.settingsRevision=1.5;}]){const v=build();mutate(v);assert.throws(()=>save(v),/CHECK/);}
 }finally{db.close();}
});



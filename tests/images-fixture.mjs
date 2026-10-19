import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {migrateImageSchema} from '../packages/business/src/image-schema.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function legacyDatabase(file=':memory:'){
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('./fixtures/images-legacy-schema15.sql',import.meta.url),'utf8'));return db;
}
export function migrate(db){db.exec('BEGIN IMMEDIATE');try{migrateImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(16);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
export function insert(db,table,value){const keys=Object.keys(value);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>value[key]));}
export function imageFixture(t){
 const db=legacyDatabase();migrate(db);t?.after(()=>db.close());
 const projectId=randomUUID(),otherProjectId=randomUUID(),groupId=randomUUID(),taskId=randomUUID(),versionId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),timestamp='2026-10-10T00:00:00.000Z';
 for(const id of [projectId,otherProjectId])insert(db,'projects',{id,data:JSON.stringify({id,name:'Image test',description:'',revision:1})});
 const input={projectId,name:'Image group',prompt:'Mock deterministic image',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId},inputHash=createHash('sha256').update(canonical(input)).digest('hex');
 const snapshot={schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options};
 const receipt={schemaVersion:1,taskId,projectId,groupId,inputHash,assetId,versionId,sha256:'a'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:128,isMock:true};
 const task={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
 const asset={id:assetId,projectId,name:'Image.png',mimeType:receipt.mimeType,width:1024,height:1024,sizeBytes:128,sha256:receipt.sha256,relativePath:`media/${assetId}.png`,provenance:'synthetic-mock',createdAt:timestamp};
 const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:receipt.sha256,mimeType:receipt.mimeType,width:1024,height:1024,byteLength:128,isMock:true,providerId:input.providerId,model:input.model,options:input.options,createdAt:timestamp};
 db.exec('BEGIN');
 insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:timestamp,updatedAt:timestamp});
 insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash,input:canonical(input),snapshot:canonical(snapshot),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp});
 insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash,canonicalInput:canonical(input),response:JSON.stringify(task)});db.exec('COMMIT');
 function succeed(){
  db.exec('BEGIN');
  db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
  db.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(receipt),taskId);
  insert(db,'assets',{id:assetId,projectId,data:JSON.stringify(asset)});insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
  db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(versionId,taskId);
  db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(versionId,groupId);db.exec('COMMIT');
 }
 return {db,projectId,otherProjectId,groupId,taskId,versionId,assetId,requestId,timestamp,input,inputHash,snapshot,receipt,task,asset,version,succeed};
}

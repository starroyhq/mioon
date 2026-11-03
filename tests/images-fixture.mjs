import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {CROSS_FILE_RELATIONS} from '../packages/business/src/project-file/cross-file/relations.ts';
import {relationConstraintName} from '../packages/business/src/project-file/cross-file/install.ts';
import {schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function insert(db,table,value){const keys=Object.keys(value);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>value[key]));}
/** Explicit damage on the actual held connection. Native same-file keys and
 * the affected TEMP emulations must both be removed before injecting orphans;
 * the ownership readers, their bounds and their error expectations stay live.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly string[]} tables
 */
export function allowCorruptOwnerRows(db,tables){
 db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON');
 for(const relation of CROSS_FILE_RELATIONS.filter(relation=>tables.includes(relation.child.table)||tables.includes(relation.parent.table))){
  for(const event of ['child_insert','child_update','parent_delete','parent_update'])db.exec(`DROP TRIGGER IF EXISTS temp.${relationConstraintName(relation)}_${event}`);
 }
}
export function imageFixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-image-owner-')),store=openStore(root),foreignStore=openStore(join(root,'foreign'));
 let foreignBefore;
 const captureForeign=()=>({objects:schemaObjects(foreignStore.db),rows:schemaObjects(foreignStore.db).filter(row=>row.type==='table').map(({schema,name})=>({schema,name,rows:foreignStore.db.prepare(`SELECT * FROM ${schema}."${name.replaceAll('"','""')}" ORDER BY rowid`).all()}))});
 t.after(()=>{try{if(foreignBefore)assert.deepEqual(captureForeign(),foreignBefore,'foreign project keeps all three native catalogs and every row');}finally{foreignStore.close();store.close();rmSync(root,{recursive:true,force:true});}});
 for(const current of [store,foreignStore])insert(current.db,'projects',{id:current.projectId,data:JSON.stringify({id:current.projectId,name:'Image test',description:'',revision:1})});
 foreignBefore=captureForeign();
 return {...seedImageFixture(store.db,store.projectId,foreignStore.projectId),store,foreignStore};
}
/** @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectId
 * @param {string} otherProjectId
 */
function seedImageFixture(db,projectId,otherProjectId){
 const groupId=randomUUID(),taskId=randomUUID(),versionId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),timestamp='2026-10-10T00:00:00.000Z';
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

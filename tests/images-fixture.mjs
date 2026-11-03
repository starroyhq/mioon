import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrateImageSchema} from '../packages/business/src/image-schema.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {referenceTestAsset} from '../packages/business/src/project-file/test-asset-fixture.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {CROSS_FILE_RELATIONS} from '../packages/business/src/project-file/cross-file/relations.ts';
import {relationConstraintName} from '../packages/business/src/project-file/cross-file/install.ts';
import {schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {publishOutputFixture,markProjectOutputRegistered} from './helpers/project-output-fixture.ts';
import {assertPublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function legacyDatabase(file=':memory:'){
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('./fixtures/images-legacy-schema15.sql',import.meta.url),'utf8'));return db;
}
export function migrate(db){db.exec('BEGIN IMMEDIATE');try{migrateImageSchema(db);db.exec('INSERT OR IGNORE INTO schema_version VALUES(16);COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
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
export function legacyImageFixture(t){
 const db=legacyDatabase();migrate(db);t?.after(()=>db.close());
 const projectId=randomUUID(),otherProjectId=randomUUID();
 for(const id of [projectId,otherProjectId])insert(db,'projects',{id,data:JSON.stringify({id,name:'Image test',description:'',revision:1})});
 return seedImageFixture(db,projectId,otherProjectId);
}
export function imageFixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-image-owner-')),store=openStore(root),foreignStore=openStore(join(root,'foreign'));
 let foreignBefore;
 const captureForeign=()=>({objects:schemaObjects(foreignStore.db),rows:schemaObjects(foreignStore.db).filter(row=>row.type==='table').map(({schema,name})=>({schema,name,rows:foreignStore.db.prepare(`SELECT * FROM ${schema}."${name.replaceAll('"','""')}" ORDER BY rowid`).all()}))});
 t.after(()=>{try{if(foreignBefore)assert.deepEqual(captureForeign(),foreignBefore,'foreign project keeps all three native catalogs and every row');}finally{foreignStore.close();store.close();rmSync(root,{recursive:true,force:true});}});
 for(const current of [store,foreignStore])insert(current.db,'projects',{id:current.projectId,data:JSON.stringify({id:current.projectId,name:'Image test',description:'',revision:1})});
 foreignBefore=captureForeign();
 return {...seedImageFixture(store.db,store.projectId,foreignStore.projectId,root,store),store,foreignStore};
}
/** @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectId
 * @param {string} otherProjectId
 * @param {string} [root] Real project only; the explicit historical fixture keeps its original bytes.
 */
function seedImageFixture(db,projectId,otherProjectId,root,store){
 const groupId=randomUUID(),taskId=randomUUID(),versionId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),timestamp='2026-10-10T00:00:00.000Z';
 const input={projectId,name:'Image group',prompt:'Mock deterministic image',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId},inputHash=createHash('sha256').update(canonical(input)).digest('hex');
 const snapshot={schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options};
 const relativePath=`media/${assetId}.png`,bytes=root?png({width:1024,height:1024}):null;
 if(root&&bytes)writeFileSync(join(root,relativePath),bytes);
 const sha256=bytes?createHash('sha256').update(bytes).digest('hex'):'a'.repeat(64),byteLength=bytes?.length??128;
 const receipt={schemaVersion:1,taskId,projectId,groupId,inputHash,assetId,versionId,sha256,mimeType:'image/png',width:1024,height:1024,byteLength,isMock:true};
 const task={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};
 const metadata={id:assetId,projectId,name:'Image.png',mimeType:receipt.mimeType,width:1024,height:1024,sizeBytes:byteLength,sha256:receipt.sha256,relativePath,provenance:'synthetic-mock',createdAt:timestamp};
 // Raw SQL ownership fixtures bypass Store.put; register the already-written
 // file explicitly and keep the returned assertion object identical to storage.
 const {relativePath: _relativePath,...record}=metadata;
 const asset=root?{...record,reference:mediaReferenceSchema.parse(referenceTestAsset(root,metadata).reference),referenceRevision:1}:metadata;
 const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:receipt.sha256,mimeType:receipt.mimeType,width:1024,height:1024,byteLength,isMock:true,providerId:input.providerId,model:input.model,options:input.options,createdAt:timestamp};
 db.exec('BEGIN');
 insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:timestamp,updatedAt:timestamp});
 insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash,input:canonical(input),snapshot:canonical(snapshot),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp});
 insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash,canonicalInput:canonical(input),response:JSON.stringify(task)});db.exec('COMMIT');
 function finish(){
  db.exec('BEGIN');
  if(store)assertPublishedProjectOutput(store,asset.publication);
  db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
  db.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(receipt),taskId);
  insert(db,'assets',{id:assetId,projectId,data:JSON.stringify(asset)});insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
  db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(versionId,taskId);
  db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(versionId,groupId);db.exec('COMMIT');
 }
 function succeed(){
  if(!store)return finish();
  return publishOutputFixture(store,{assetId,owner:{kind:'image',id:taskId,requestId,inputHash},bytes,mimeType:'image/png'})
   .then(async published=>{Object.assign(asset,published);finish();await markProjectOutputRegistered(store,published.publication);});
 }
 return {db,projectId,otherProjectId,groupId,taskId,versionId,assetId,requestId,timestamp,input,inputHash,snapshot,receipt,task,asset,version,succeed};
}

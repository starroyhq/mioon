import test from 'node:test';
import {errorView} from './helpers/test-error.ts';
import {currentMarkerChain} from './helpers/current-schema-delta.ts';
import {currentOrdinary48Delta,currentOrdinary50Delta,reviewedObjectSql} from './helpers/current-schema-delta.ts';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrateCustomImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {openStore} from '../packages/business/src/db.ts';
import {validateImageTaskReview} from '../packages/business/src/images/reviews.ts';
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
const insert=(db: DatabaseSync,table: string,value: CompatRow)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
function database(file: string=':memory:'): DatabaseSync {const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');db.exec(fixtureSql);return db;}
function snapshot(db: DatabaseSync): CompatSnapshot {const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all() as unknown as CompatSchemaObject[];const rows: Record<string, CompatRow[]>={};for(const {name} of objects.filter(value=>value.type==='table')){const query=db.prepare(`SELECT rowid AS retainedRowid,* FROM "${name}" ORDER BY rowid`);query.setReadBigInts(true);rows[name]=query.all();}return {objects,rows};}
function sameOld(db: DatabaseSync,before: CompatSnapshot): void {const after=snapshot(db);const next=new Map(after.objects.map(value=>[value.name,value]));const agentTargets=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=24').get());if(agentTargets)assertAgentEditTargetTrigger(after.objects);for(const old of before.objects){if(old.name==='image_reviews')continue;if(old.name==='edit_tasks'&&db.prepare('SELECT 1 FROM schema_version WHERE version=21').get()){const current=next.get(old.name);let sql=current.sql;const operations=['timeline.format.set',...(db.prepare('SELECT 1 FROM schema_version WHERE version=22').get()?['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']:[]),...(db.prepare('SELECT 1 FROM schema_version WHERE version=26').get()?['timeline.loudness.apply']:[]),...(db.prepare('SELECT 1 FROM schema_version WHERE version=44').get()?['timeline.clip.rippleRemove']:[])];for(const operation of operations){const token=`,'${operation}'`;assert.equal(sql.split(token).length,2,operation);sql=sql.replace(token,'');}assert.deepEqual(Object.assign(Object.create(Object.getPrototypeOf(current)),current,{sql}),old);continue;}if(old.name==='image_task_state_transitions'&&db.prepare('SELECT 1 FROM schema_version WHERE version=19').get()){const current=next.get(old.name)!.sql;assert.ok(current.includes("OLD.state='outcome_unknown' AND NEW.state='failed' AND json_extract(OLD.input,'$.providerId')='comfy-local'"));assert.equal(current.replace(/\(OLD.state IN \('local_result_error','outcome_unknown'\) AND NEW.state='persisting'\) OR[\s\S]*?\)\)\)\n BEGIN/,"(OLD.state IN ('local_result_error','outcome_unknown') AND NEW.state='persisting'))\n BEGIN"),old.sql);continue;}const finalCurrent=agentTargets&&old.type==='table'&&old.name==='agent_edit_proposals'?normalizeAgentEditProposalObject(next.get(old.name)):next.get(old.name);const current48=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=48').get());assert.deepEqual(finalCurrent,!current48||currentOrdinary48Delta.objectSql[old.name]===undefined?old:Object.assign(Object.create(Object.getPrototypeOf(old)),old,{sql:reviewedObjectSql(old.name,old.sql)}));}const current50=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=50').get());const schema50Names=new Set(currentOrdinary50Delta.objects.map(value=>value.name));if(current50){const actual50=after.objects.filter(value=>schema50Names.has(value.name));assert.deepEqual(actual50.map(value=>({...value})),currentOrdinary50Delta.objects);for(const table of Object.keys(currentOrdinary50Delta.tables))assert.deepEqual(after.rows[table],[],table);}const additions=after.objects.filter(value=>!before.objects.some(old=>old.name===value.name)&&!(current50&&schema50Names.has(value.name)));const retainedAdditions=additions.filter(value=>!(agentTargets&&value.name==='immutable_agent_edit_target_v24'));if(db.prepare('SELECT 1 FROM schema_version WHERE version=19').get()){const frames=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=20').get()),formats=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=21').get());const current48TableNames=Object.keys(currentOrdinary48Delta.lifecycleTables).concat(['asset_annotations','asset_annotation_requests','lut_import_requests','project_lut_resources']);assert.deepEqual(additions.filter(value=>value.type==='table').map(value=>value.name).sort(),[...(frames?['frame_requests','frame_tasks']:[]),'image_remote_observations','image_remote_runs',...(formats?['timeline_format_requests']:[]),...current48TableNames].sort());const current48=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=48').get());const current48Tables=new Set(Object.keys(currentOrdinary48Delta.lifecycleTables).concat(['asset_annotations','asset_annotation_requests','lut_import_requests','project_lut_resources']));const current48Names=new Set(currentOrdinary48Delta.lifecycleObjects.map(object=>object.name));const unreviewed=retainedAdditions.filter(value=>!(value.tbl_name==='image_remote_runs'||value.tbl_name==='image_remote_observations'||['reject_image_request_cross_observation','reject_image_review_cross_observation'].includes(value.name)||formats&&(value.tbl_name==='timeline_format_requests'||value.name==='timeline_requests_project')||frames&&(value.tbl_name==='frame_requests'||value.tbl_name==='frame_tasks'||['reject_legacy_frame_asset_owner','reject_image_frame_asset_owner'].includes(value.name))||current48&&(current48Tables.has(value.tbl_name)||current48Tables.has(value.name)||current48Names.has(value.name)||/annotation|lut|project_deletion|project_mutation/.test(value.name)||/annotation|lut|project_deletion|project_mutation/.test(value.tbl_name))));assert.deepEqual(unreviewed.map(value=>[value.type,value.name,value.tbl_name]),[]);}else assert.deepEqual(additions,[]);for(const [name,rows] of Object.entries(before.rows))assert.deepEqual(name==='schema_version'?after.rows[name].filter(row=>row.version<=17n):agentTargets&&name==='agent_edit_proposals'?legacyAgentEditProposalRows(after.rows[name]):after.rows[name],rows,name);}
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

test('independent schema17 upgrades only image_reviews DDL and retains exact rowids, raw strings, histories and every SQL object',()=>{
 const db=database();try{db.exec('BEGIN');const f=seed(db);db.exec('COMMIT');const before=snapshot(db);migrate(db);sameOld(db,before);assert.equal(db.prepare('SELECT max(version) AS version FROM schema_version').get()!.version,18);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 for(const record of f.records.filter(v=>['approved','dispatched'].includes(v.state)))assert.equal(validateImageTaskReview(db,f.projectId,record.taskId,record.input).id,record.reviewId);
 const after=snapshot(db),changes=db.prepare('SELECT total_changes() AS n').get()!.n;migrate(db);assert.deepEqual(snapshot(db),after);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 for(const statement of ['DELETE FROM image_reviews','UPDATE image_reviews SET canonicalInput=canonicalInput,revision=revision+1','INSERT OR REPLACE INTO image_reviews SELECT * FROM image_reviews'])assert.throws(()=>db.exec(statement),/retained|transition|replaced|pending/);
 }finally{db.close();}
});

test('rebuild interruption and failed schema18 marker roll back full schema, rows, fences and sequence state',()=>{
 for(const phase of ['copy','drop','marker']){const db=database();try{db.exec('BEGIN');seed(db);db.exec('COMMIT');if(phase==='marker')db.exec("CREATE TRIGGER refuse_schema18 BEFORE INSERT ON schema_version WHEN NEW.version=18 BEGIN SELECT RAISE(ABORT,'synthetic-marker'); END");const before=snapshot(db);
 const adapter={get isTransaction(){return db.isTransaction;},prepare:sql=>db.prepare(sql),exec(sql){db.exec(sql);if((phase==='copy'&&sql.startsWith('INSERT INTO image_reviews_v18'))||(phase==='drop'&&sql.startsWith('DROP TABLE image_reviews;')))throw new Error('synthetic-interruption');}};
 db.exec('BEGIN IMMEDIATE');assert.throws(()=>{migrateCustomImageReviewSchema(adapter);db.exec('INSERT INTO schema_version VALUES(18)');},/synthetic/);db.exec('ROLLBACK');assert.deepEqual(snapshot(db),before);
 }finally{db.close();}}
});

test('schema18 SQL permits exact custom v2 and rejects cross-branch or mismatched frozen authority',()=>{
 const db=database();try{db.exec('BEGIN');const f=seed(db);db.exec('COMMIT');migrate(db);const build=()=>{const reviewId=randomUUID(),input={projectId:f.projectId,requestId:randomUUID(),name:'Custom',providerId:'openai-compatible',model:'vendor/model',prompt:'Original',options};const configuration={enabled:true,providerId:'openai-compatible',connectionId:'custom',profileId:'openai-images-json-png-v1',baseUrl:'https://images.example.test/v1',model:input.model,options};return {schemaVersion:2,reviewId,input,settingsRevision:1,destination:configuration.baseUrl+'/images/generations',policy,configuration};};
 const save=value=>{const raw=canonical(value.input),intent=canonical(value);insert(db,'image_reviews',{id:value.reviewId,projectId:f.projectId,requestId:value.input.requestId,inputHash:hash(raw),canonicalInput:raw,intentHash:hash(intent),canonicalIntent:intent,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:at,updatedAt:at,approvedAt:null,rejectedAt:null,dispatchedAt:null});};save(build());
 for(const mutate of [(v: CompatIntentView)=>{v.schemaVersion=1;},(v: CompatIntentView)=>{v.input.providerId='openai';},(v: CompatIntentView)=>{v.configuration.model='other';},(v: CompatIntentView)=>{v.configuration.connectionId='other';},(v: CompatIntentView)=>{v.configuration.profileId='other';},(v: CompatIntentView)=>{v.configuration.enabled=false;},(v: CompatIntentView)=>{v.destination='https://other.example.test/v1/images/generations';},(v: CompatIntentView)=>{delete v.configuration;},(v: CompatIntentView)=>{delete v.settingsRevision;},(v: CompatIntentView)=>{v.settingsRevision=1.5;}]){const v=build();mutate(v);assert.throws(()=>save(v),/CHECK/);}
 }finally{db.close();}
});

test('normal startup upgrades frozen schema17 once and preserves restart/replay bytes',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-custom-image-migration-'));let db=database(path.join(root,'workbench.sqlite')),store;try{db.exec('BEGIN');seed(db);db.exec('COMMIT');const before=snapshot(db);db.close();db=null;store=openStore(root);sameOld(store.db,before);assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...currentMarkerChain]);const after=snapshot(store.db);store.close();store=openStore(root);assert.deepEqual(snapshot(store.db),after);}finally{db?.close();store?.close();rmSync(root,{recursive:true,force:true});}
});

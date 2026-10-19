import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore,classifyCurrentWorkspaceSchema,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {initializeWorkspaceSchema44,validateWorkspaceSchema44} from '../packages/business/src/workspace-schema-v44.ts';
import {createWorkspaceRestoreProfileV41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {classifyWorkspaceSchemaV44V45} from '../packages/business/src/workspace-restore-schema-v45.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
const old=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
const objects=db=>db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
function source(t,file=':memory:'){const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
 for(const initialize of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38,initializeWorkspaceSchema40])initialize(db);
 t.after(()=>{if(db.isOpen)db.close();});return db;}
const sequence=db=>{const s=db.prepare("SELECT rowid,seq,typeof(seq) AS kind FROM sqlite_sequence WHERE name='edit_tasks'");s.setReadBigInts(true);return s.get();};

test('ordinary40 to44 preserves task bytes, positions, sequence and protections;42 is not a parent marker',t=>{
 const db=source(t),projectId=randomUUID();db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
 const input=' \n'+JSON.stringify({projectId,expectedRevision:1,requestId:'ripple-retained-task',clipId:randomUUID()},null,2)+'\n';
 db.prepare(`INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(?,?,'timeline.clip.remove',?,?,'${'a'.repeat(64)}','timeline:mutation','new','prepared',1,0,?,?,16384)`).run(randomUUID(),projectId,input,'ripple-retained-task','2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z');
 db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='edit_tasks'").run(9007199254740990n);
 const beforeRows=db.prepare('SELECT * FROM edit_tasks').all(),beforeSequence=sequence(db),beforeObjects=objects(db);
 assert.deepEqual(old.classifyWorkspaceSchemaV40V41(db),{schemaVersion:40,profile:'ordinary'});
 initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24);validateWorkspaceSchema44(db);
 assert.deepEqual(db.prepare('SELECT * FROM edit_tasks').all(),beforeRows);assert.deepEqual(sequence(db),beforeSequence);
 assert.deepEqual(objects(db).filter(o=>o.name!=='edit_tasks'),beforeObjects.filter(o=>o.name!=='edit_tasks'));
 assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:44,profile:'ordinary'});assert.equal(readCurrentWorkspaceRole(db),'ordinary-44');
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version=42').get(),undefined);
 assert.throws(()=>old.classifyWorkspaceSchemaV40V41(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>db.prepare('DELETE FROM edit_tasks').run(),/must be retained/);
});

test('unknown task dependencies or forged marker chains are refused without modifying source40',t=>{
 const db=source(t);db.exec('CREATE TRIGGER custom_task_guard BEFORE INSERT ON edit_tasks BEGIN SELECT RAISE(ABORT,\'unexpected guard execution\');END;');
 const before=objects(db),markers=db.prepare('SELECT version FROM schema_version ORDER BY version').all();
 assert.throws(()=>initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(objects(db),before);assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(),markers);assert.equal(db.isTransaction,false);
});

test('ordinary44 never adopts or advertises opacity evidence from40 or a forged current row',t=>{
 for(const migrated of [false,true]){
  const db=source(t);if(migrated)initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24);
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run('opacity-candidate-only','a'.repeat(64),'{"opacityEnvelope":null}');
  const before=objects(db),markers=db.prepare('SELECT version FROM schema_version ORDER BY version').all();
  assert.throws(()=>migrated?validateWorkspaceSchema44(db):initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(objects(db),before);assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(),markers);
 }
});

test('fresh44 backup verifies and restores to exact45, while historical40 still restores to41', {timeout:60000},async t=>{
 const base=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-ripple-backup-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const sourcePath=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');
 await mkdir(sourcePath,{mode:0o700});const original=source(t,path.join(sourcePath,'workbench.sqlite'));initializeWorkspaceSchema44(original,initializeWorkspaceSchemaThrough24);
 const projectId=randomUUID();original.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'Ripple backup',description:'',revision:1,createdAt:'2026-10-19T00:00:00.000Z',updatedAt:'2026-10-19T00:00:00.000Z'}));
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(original),{profileId:'mioon-clip-linear-attenuation-v1',editable:true});original.close();
 const created=await createWorkspaceBackup({source:sourcePath,destination:backup});assert.equal(created.databaseSchemaVersion,44);
 assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const restored=await restoreWorkspaceBackup({directory:backup,destination});assert.equal(restored.sourceSchema,44);assert.equal(restored.databaseSchemaVersion,45);assert.equal(restored.profile,'restored-local-v11');
 const store=openStore(destination);try{assert.equal(getWorkspaceRestoreContext(store).schemaVersion,45);assert.equal(classifyWorkspaceSchemaV44V45(store.db).schemaVersion,45);assert.equal(readTimelineVolumeEnvelopeCapability(store.db).editable,true);}finally{store.close();}
 const db=source(t),metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-19T00:00:00.000Z'};
 assert.equal(old.installWorkspaceRestoreSchemaV41(db,metadata).schemaVersion,41);assert.equal(old.validateWorkspaceRestoreSchemaV41(db).sourceSchema,40);
});

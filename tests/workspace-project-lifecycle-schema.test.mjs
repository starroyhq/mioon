import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,mkdirSync,rmSync} from 'node:fs';
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
import {initializeWorkspaceSchema44} from '../packages/business/src/workspace-schema-v44.ts';
import {initializeWorkspaceSchema48,validateWorkspaceSchema48} from '../packages/business/src/workspace-schema-v48.ts';
import {classifyWorkspaceSchemaV44V45} from '../packages/business/src/workspace-restore-schema-v45.ts';
import {classifyWorkspaceSchemaV48V49} from '../packages/business/src/workspace-restore-schema-v49.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
import {readTimelineAudioRoleCapability} from '../packages/business/src/timeline-audio-role-business.ts';
function source44(t){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');for(const init of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38,initializeWorkspaceSchema40])init(db);initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24);t.after(()=>db.close());return db;}
const catalog=db=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();

test('44→48 preserves existing rows and scope guards require exact row identity',t=>{
  const db=source44(t),projectId=randomUUID(),requestId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
  const raw=' \n'+JSON.stringify({id:randomUUID(),projectId,title:'Retained text'},null,2)+'\n';db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run(requestId,'shot.create',projectId,'{}',raw);
  const before=db.prepare('SELECT rowid,* FROM mutation_requests').all();assert.equal(classifyWorkspaceSchemaV44V45(db).schemaVersion,44);
  initializeWorkspaceSchema48(db,initializeWorkspaceSchemaThrough24);validateWorkspaceSchema48(db);assert.deepEqual(db.prepare('SELECT rowid,* FROM mutation_requests').all(),before);
  assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,48);assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version IN (42,46,47)').get(),undefined);
  assert.throws(()=>db.prepare('DELETE FROM mutation_requests').run(),/retained/);assert.throws(()=>classifyWorkspaceSchemaV44V45(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  const guard=db.prepare("SELECT sql FROM sqlite_schema WHERE name='retain_mutation_requests'").get().sql;assert.match(guard,/project_deletion_scope/);assert.match(guard,/OLD\.rowid/);
});

test('unknown source44 dependencies and forged current markers are refused without schema mutation',t=>{
  const db=source44(t);db.exec("CREATE TRIGGER custom_project_guard BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'unexpected');END;");const before=catalog(db);
  assert.throws(()=>initializeWorkspaceSchema48(db,initializeWorkspaceSchemaThrough24),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(catalog(db),before);assert.equal(db.isTransaction,false);
});

test('ordinary48 cannot adopt candidate opacity values even with its valid marker chain',t=>{
  const db=source44(t);initializeWorkspaceSchema48(db,initializeWorkspaceSchemaThrough24);
  db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),'{"opacityEnvelope":null}');
  assert.throws(()=>validateWorkspaceSchema48(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

test('source48 cold backup verifies and restores to fixed49 with previous timeline capabilities and no deletion authority',{timeout:60000},async t=>{
  const base=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-backup-')));t.after(()=>rmSync(base,{recursive:true,force:true}));const source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');mkdirSync(source,{mode:0o700});
  let store=openStore(source);const projectId=randomUUID();store.put('projects',{id:projectId,name:'Restored project',description:'',revision:1,createdAt:'2026-10-19T00:00:00.000Z',updatedAt:'2026-10-19T00:00:00.000Z'});store.close();
  const created=await createWorkspaceBackup({source,destination:backup});assert.equal(created.databaseSchemaVersion,48);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
  const restored=await restoreWorkspaceBackup({directory:backup,destination});assert.equal(restored.sourceSchema,48);assert.equal(restored.databaseSchemaVersion,49);assert.equal(restored.profile,'restored-local-v13');
  store=openStore(destination);try{
    assert.equal(getWorkspaceRestoreContext(store).schemaVersion,49);assert.equal(classifyWorkspaceSchemaV48V49(store.db).schemaVersion,49);assert.equal(readTimelineVolumeEnvelopeCapability(store.db).editable,true);assert.equal(readTimelineAudioRoleCapability(store.db).editable,true);
    assert.throws(()=>store.db.prepare('INSERT INTO project_deletion_scope VALUES(?,?)').run('projects',1),/RESTORE_OPERATION_UNAVAILABLE/);
    const services=createServices(store,new Map());await assert.rejects(services.call('project.delete',{requestId:randomUUID(),projectId,expectedRevision:1,confirmPermanentDeletion:true}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
    assert.ok(store.get('projects',projectId));
  }finally{store.close();}
});

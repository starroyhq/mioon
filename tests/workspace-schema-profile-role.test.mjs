import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {detectWorkspaceRestoreEvidence} from '../packages/business/src/workspace-restore-schema.mjs';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {inspectWorkspaceSchemaMarkerRole} from '../packages/business/src/workspace-schema-profile.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {withOrdinaryMigrationSource} from '../apps/desktop/scripts/migration-restore-guard.mjs';
import {restoreFixture,tree,logical,refreshDatabaseManifest} from './helpers/workspace-restore-offline-fixture.mjs';
function database(t, versions, ddl='CREATE TABLE schema_version(version INTEGER PRIMARY KEY)') {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(ddl);
  for(const version of versions)db.prepare('INSERT INTO schema_version VALUES(?)').run(version);
  return db;
}
test('ordinary known markers retain legacy missing-marker repair eligibility',t=>{
  for(const markers of [[],[1],[24],[1,3,24],Array.from({length:24},(_,i)=>i+1)]){
    const db=database(t,markers);assert.equal(detectWorkspaceRestoreEvidence(db),false);
  }
});
test('only explicit 25 is restored marker evidence, never an unknown future version',t=>{
  assert.equal(detectWorkspaceRestoreEvidence(database(t,[25])),true);
  for(const markers of [[26],[27],[1,24,26],[25,26],[26,27],[9007199254740991],[-1],[0]]){
    const db=database(t,markers),before=db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
    assert.deepEqual(db.prepare('SELECT * FROM schema_version ORDER BY version').all(),before);
  }
});
test('unknown marker table shape fails closed instead of bypassing version role checking',t=>{
  const db=database(t,[26],'CREATE TABLE schema_version(version TEXT PRIMARY KEY)');
  assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});
test('partial restoration objects remain evidence independently of marker ordering',t=>{
  for(const markers of [[],[1],[24],[26]]){
    const db=database(t,markers);db.exec('CREATE TABLE workspace_restoration_partial(value TEXT)');
    // It may reject an unknown marker before finding the partial object, but it
    // must never report ordinary startup eligibility.
    try{assert.equal(detectWorkspaceRestoreEvidence(db),true);}catch(error){assert.equal(error.code,'RESTORE_SCHEMA_UNSUPPORTED');}
  }
});
test('SQLite case-insensitive identifiers cannot bypass role or partial-restoration checking',t=>{
  for(const name of ['SCHEMA_VERSION','Schema_Version']){
    const db=database(t,[26],`CREATE TABLE ${name}(version INTEGER PRIMARY KEY)`);
    assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  }
  for(const sql of ['CREATE TABLE WORKSPACE_RESTORATION_PARTIAL(id TEXT)',
    'CREATE TABLE RESTORE_PARTIAL(id TEXT)', 'CREATE TABLE EDIT_TASKS(executionEpoch TEXT)']){
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(sql);
    assert.equal(detectWorkspaceRestoreEvidence(db),true);
  }
});
test('marker views and unreadably long marker DDL refuse instead of returning ordinary',t=>{
  for(const sql of ['CREATE VIEW schema_version AS SELECT 26 AS version',
    `CREATE TABLE schema_version(/*${'x'.repeat(131072)}*/version INTEGER PRIMARY KEY)`]){
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(sql);
    assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  }
});
test('unreadable edit-task DDL cannot hide a partial restoration epoch',t=>{
  const db=database(t,[1,24]);
  db.exec(`CREATE TABLE EDIT_TASKS(/*${'x'.repeat(131072)}*/executionEpoch TEXT)`);
  assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});
test('role checks main namespace, unaffected by a temporary marker shadow',t=>{
  const db=database(t,[26]);db.exec('CREATE TEMP TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO temp.schema_version VALUES(24)');
  assert.throws(()=>detectWorkspaceRestoreEvidence(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.throws(()=>getWorkspaceRestoreContext({db}),{code:'RESTORE_STORE_UNVERIFIED'});
});
test('finite exceptional-marker query bounds output without MAX or numeric role inference',t=>{
  const db=database(t,[...Array.from({length:24},(_,i)=>i+1),...Array.from({length:10000},(_,i)=>i+26)]);
  const calls=[];let rows;
  const reader={prepare(sql){calls.push(sql);const statement=db.prepare(sql);return {all(){rows=statement.all();return rows;},iterate(){return statement.iterate();}};}};
  assert.throws(()=>inspectWorkspaceSchemaMarkerRole(reader),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(calls.length,1);assert.equal(rows.length,2);assert.match(calls[0],/main\.schema_version/);assert.match(calls[0],/LIMIT 2$/);
  assert.doesNotMatch(calls[0],/MAX\(|version\s*>/i);
});
for(const version of [28,29])test(`unknown marker ${version} refuses startup/context/backup/migration/restore before downstream execution`,async t=>{
  const f=await restoreFixture(t,{stages:false});
  const sourceFile=path.join(f.source,'workbench.sqlite');
  let db=new DatabaseSync(sourceFile);db.exec(`INSERT INTO schema_version VALUES(${version})`);const before=logical(db);db.close();
  // Startup may perform its established WAL PRAGMAs. Assert logical records,
  // schema and lock cleanup, not byte-identical SQLite/WAL files after open.
  assert.throws(()=>openStore(f.source),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
  db=new DatabaseSync(sourceFile,{readOnly:true});
  try{assert.deepEqual(logical(db),before);assert.throws(()=>getWorkspaceRestoreContext({db}),{code:'RESTORE_STORE_UNVERIFIED'});}finally{db.close();}
  const sourceBefore=tree(f.source),destination=path.join(f.base,'must-not-be-created');
  await assert.rejects(createWorkspaceBackup({source:f.source,destination}),{code:'WORKSPACE_BACKUP_IO'});
  assert.equal(fs.existsSync(destination),false);assert.deepEqual(tree(f.source),sourceBefore);
  let consumed=false;
  await assert.rejects(withOrdinaryMigrationSource(sourceFile,()=>{consumed=true;}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(consumed,false);assert.deepEqual(tree(f.source),sourceBefore);
  const backupFile=path.join(f.backup,'payload/workbench.sqlite');db=new DatabaseSync(backupFile);
  try{db.exec(`INSERT INTO schema_version VALUES(${version})`);}finally{db.close();}
  refreshDatabaseManifest(f.backup);const backupBefore=tree(f.backup);
  await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:f.destination}),{code:'WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED'});
  assert.equal(fs.existsSync(f.destination),false);assert.deepEqual(tree(f.backup),backupBefore);assert.deepEqual(tree(f.source),sourceBefore);
});

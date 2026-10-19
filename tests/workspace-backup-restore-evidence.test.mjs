import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {hasWorkspaceBackupRestoreEvidence} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function tree(root){
 const visit=relative=>{
  const file=path.join(root,relative),stat=fs.lstatSync(file);
  return stat.isDirectory()?[[relative,stat.mode],...fs.readdirSync(file).sort().flatMap(name=>visit(path.join(relative,name)))]:[[relative,stat.mode,sha(fs.readFileSync(file))]];
 };return visit('');
}
function fixture(t,version,sql=''){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'capture-restore-evidence-')),source=path.join(root,'source'),destination=path.join(root,'backup');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o700});
 const file=path.join(source,'workbench.sqlite'),db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);
  if(version===26)initializeWorkspaceSchema26(db);
  db.exec(sql);
 }finally{db.close();}
 fs.chmodSync(file,0o600);return {root,source,destination,file};
}
const artifacts=[
 ['partial metadata table','CREATE TABLE workspace_restore_incomplete(id INTEGER PRIMARY KEY)'],
 ['case folded metadata','CREATE TABLE WORKSPACE_RESTORE_PARTIAL(id INTEGER PRIMARY KEY)'],
 ['restore guard','CREATE TABLE capture_audit(value TEXT);INSERT INTO capture_audit VALUES(\'untouched\');CREATE TRIGGER restore_partial_gate BEFORE INSERT ON schema_version BEGIN UPDATE capture_audit SET value=\'executed\';END;'],
 ['execution epoch',"ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT NOT NULL DEFAULT 'captured'"],
];
for(const version of [24,26])for(const [label,sql] of artifacts)test(`source${version} ${label} preserves explicit backup refusal before target creation`,async t=>{
 const f=fixture(t,version,sql),before=tree(f.source),siblings=fs.readdirSync(f.root).sort();
 const db=new DatabaseSync(f.file,{readOnly:true});
 try{
  assert.equal(hasWorkspaceBackupRestoreEvidence(db),true);
  // Causal boundary: ordinary26 plus artifacts is contradictory for startup,
  // but capture still owes the specific positive-evidence refusal diagnostic.
  if(version===26)assert.throws(()=>readCurrentWorkspaceRole(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 }finally{db.close();}
 await assert.rejects(createWorkspaceBackup({source:f.source,destination:f.destination}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
 assert.equal(fs.existsSync(f.destination),false);assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
 assert.deepEqual(tree(f.source),before);assert.deepEqual(fs.readdirSync(f.root).sort(),siblings);
});
for(const version of [24,26])test(`source${version} unknown marker without restore evidence is still rejected as unsupported`,async t=>{
 const f=fixture(t,version,'INSERT INTO schema_version VALUES(999)'),before=tree(f.source);
 const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(hasWorkspaceBackupRestoreEvidence(db),false);}finally{db.close();}
 await assert.rejects(createWorkspaceBackup({source:f.source,destination:f.destination}),{code:'WORKSPACE_BACKUP_IO'});
 assert.equal(fs.existsSync(f.destination),false);assert.deepEqual(tree(f.source),before);
});
for(const version of [24,26])test(`source${version} unrelated data remains a byte-exact verifiable cold archive`,async t=>{
 const f=fixture(t,version,"CREATE TABLE unrelated_private_note(id INTEGER PRIMARY KEY,note BLOB);INSERT INTO unrelated_private_note VALUES(1,X'00FF0D0A')"),before=tree(f.source),bytes=fs.readFileSync(f.file);
 const created=await createWorkspaceBackup({source:f.source,destination:f.destination});assert.equal(created.databaseSchemaVersion,version);
 assert.deepEqual(await verifyWorkspaceBackup({directory:f.destination}),created);
 assert.deepEqual(fs.readFileSync(path.join(f.destination,'payload/workbench.sqlite')),bytes);assert.deepEqual(tree(f.source),before);
});

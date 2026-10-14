// Causal pre-fix control. Runs the prior capture decision in an isolated module
// copy; production source is never modified. Its expected failure is recorded
// separately and this file is not part of the normal *.test.mjs test suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/db.mjs';

const sourceURL=new URL('../packages/business/src/workspace-backup.mjs',import.meta.url);
const priorURL=new URL(`.backup-capture-prior-${randomUUID()}.mjs`,sourceURL);
const current=fs.readFileSync(sourceURL,'utf8');
const decision='hasWorkspaceBackupRestoreEvidence(db)||detectWorkspaceRestoreEvidence(db)';
assert.equal(current.split(decision).length,2,'the causal control changes exactly one capture decision');
const prior=current.replace("import {hasWorkspaceBackupRestoreEvidence} from './workspace-backup-schema-versions.ts';\n",'').replace(decision,'detectWorkspaceRestoreEvidence(db)');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'restore-evidence-red-'));
try{
 fs.writeFileSync(priorURL,prior,{flag:'wx',mode:0o600});
 const {createWorkspaceBackup}=await import(priorURL.href);
 const source=path.join(root,'source'),destination=path.join(root,'backup');
 const store=openStore(source);assert.equal(store.db.prepare('SELECT max(version) AS n FROM schema_version').get().n,26);store.close();
 const file=path.join(source,'workbench.sqlite'),db=new DatabaseSync(file);
 try{db.exec('CREATE TABLE workspace_restore_incomplete(id INTEGER PRIMARY KEY)');}finally{db.close();}
 const bytes=fs.readFileSync(file);
 try{
  await assert.rejects(createWorkspaceBackup({source,destination}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
 }finally{
  assert.equal(fs.existsSync(destination),false);assert.deepEqual(fs.readFileSync(file),bytes);
 }
}finally{
 fs.rmSync(fileURLToPath(priorURL),{force:true});fs.rmSync(root,{recursive:true,force:true});
}

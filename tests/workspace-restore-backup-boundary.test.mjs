import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {installCurrentWorkspaceRestoreSchema, openStore} from '../packages/business/src/db.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-restore-capture-'));
 const source=path.join(base,'workspace'),destination=path.join(base,'backup');
 const store=openStore(source);store.close();
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return {base,source,destination,file:path.join(source,'workbench.sqlite')};
}
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),
 manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});

test('restored backup capture refuses before output creation and preserves the whole source',async t=>{
 const f=fixture(t),db=new DatabaseSync(f.file);
 try{installCurrentWorkspaceRestoreSchema(db,metadata());}finally{db.close();}
 const bytes=fs.readFileSync(f.file),mode=fs.statSync(f.file).mode,entries=fs.readdirSync(f.base).sort();
 await assert.rejects(createWorkspaceBackup({source:f.source,destination:f.destination}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
 assert.equal(fs.existsSync(f.destination),false);
 assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
 assert.equal(digest(fs.readFileSync(f.file)),digest(bytes));assert.equal(fs.statSync(f.file).mode,mode);
 assert.deepEqual(fs.readdirSync(f.base).sort(),entries,'private inspection siblings are removed without publishing a backup');
});

test('partial restore evidence cannot pass backup capture as an ordinary workspace',async t=>{
 const f=fixture(t),db=new DatabaseSync(f.file);
 try{db.exec('CREATE TABLE workspace_restore_incomplete(id INTEGER PRIMARY KEY);');}finally{db.close();}
 const bytes=fs.readFileSync(f.file);
 await assert.rejects(createWorkspaceBackup({source:f.source,destination:f.destination}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
 assert.equal(fs.existsSync(f.destination),false);assert.deepEqual(fs.readFileSync(f.file),bytes);
});

test('ordinary capture still retains unknown non-restoration data and creates a verifiable original backup',async t=>{
 const f=fixture(t),db=new DatabaseSync(f.file);
 try{db.exec("CREATE TABLE unrelated_private_note(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO unrelated_private_note VALUES(1,'synthetic retained note');");}finally{db.close();}
 const bytes=fs.readFileSync(f.file),created=await createWorkspaceBackup({source:f.source,destination:f.destination});
 assert.equal(created.databaseSchemaVersion,36);
 assert.deepEqual(await verifyWorkspaceBackup({directory:f.destination}),created);
 assert.deepEqual(fs.readFileSync(path.join(f.destination,'payload/workbench.sqlite')),bytes);
 assert.deepEqual(fs.readFileSync(f.file),bytes);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {openStore} from '../packages/business/src/db.mjs';
import {installWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';
import {withOrdinaryMigrationSource} from '../apps/desktop/scripts/migration-restore-guard.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-12T00:00:00.000Z'});
function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-restore-migration-'));
 const source=path.join(base,'source'),destination=path.join(base,'absent-parent','destination');
 const store=openStore(source),projectId=randomUUID();
 store.put('projects',{id:projectId,name:'迁移源',revision:1});store.close();
 fs.writeFileSync(path.join(source,'media','preserved.bin'),'unchanged synthetic source bytes');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return {base,source,destination,file:path.join(source,'workbench.sqlite')};
}
function snapshot(root){
 const walk=(file,relative)=>{const info=fs.lstatSync(file);return [[relative,{mode:info.mode,size:info.isFile()?info.size:null,hash:info.isFile()?hash(fs.readFileSync(file)):null}],...(info.isDirectory()?fs.readdirSync(file).sort().flatMap(name=>walk(path.join(file,name),path.join(relative,name))):[])];};
 return walk(root,'');
}
function mutate(file,fn){const db=new DatabaseSync(file);try{fn(db);}finally{db.close();}}

for(const [label,change] of [
 ['complete schema25',db=>installWorkspaceRestoreSchema(db,metadata())],
 ['partial metadata table',db=>db.exec('CREATE TABLE workspace_restoration(id TEXT)')],
 ['partial evidence table',db=>db.exec('CREATE TABLE workspace_restore_evidence(id TEXT)')],
 ['marker without other restored objects',db=>db.exec('INSERT INTO schema_version VALUES(25)')],
 ['guard without metadata',db=>db.exec("CREATE TRIGGER restore_incomplete BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'not executed'); END")],
 ['execution epoch without marker',db=>db.exec("ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT DEFAULT 'captured'")],
])test(`legacy migration rejects ${label} before creating destination or source SQL sidecars`,async t=>{
 const f=fixture(t);mutate(f.file,change);const before=snapshot(f.source),base=fs.readdirSync(f.base).sort();
 await assert.rejects(migrateData(f.source,f.destination),{code:'RESTORE_MIGRATION_UNAVAILABLE'});
 assert.deepEqual(snapshot(f.source),before);assert.deepEqual(fs.readdirSync(f.base).sort(),base);
 assert.equal(fs.existsSync(path.dirname(f.destination)),false);
});

test('ordinary legacy migration accepts readable owned roots and preserves bytes, modes, media and response fields',async t=>{
 const f=fixture(t);fs.chmodSync(f.source,0o755);fs.chmodSync(f.file,0o644);
 const before=snapshot(f.source),result=await migrateData(f.source,f.destination);
 assert.deepEqual(result,{ok:true,projects:1,assets:0,destination:f.destination,sourceUnchanged:true,copiedCredentials:false});
 assert.deepEqual(snapshot(f.source),before);
 assert.equal(fs.readFileSync(path.join(f.destination,'media','preserved.bin'),'utf8'),'unchanged synthetic source bytes');
 assert.equal(fs.statSync(f.destination).mode&0o777,0o700);
});

test('checked-copy callback receives only verified private bytes and source replacement fences subsequent work',async t=>{
 const f=fixture(t),original=fs.readFileSync(f.file);let candidate;
 await assert.rejects(withOrdinaryMigrationSource(f.file,async checked=>{
  candidate=checked.file;assert.notEqual(candidate,f.file);assert.equal(fs.statSync(candidate).mode&0o777,0o600);
  assert.deepEqual(fs.readFileSync(candidate),original);checked.check();
  const replacement=path.join(f.source,'replacement');fs.writeFileSync(replacement,original,{mode:0o600});fs.renameSync(replacement,f.file);
  assert.deepEqual(fs.readFileSync(candidate),original);
  checked.check();
 }),{code:'MIGRATION_SOURCE_CHANGED'});
 assert.equal(fs.existsSync(path.dirname(candidate)),false);assert.equal(fs.existsSync(f.destination),false);
});

test('checked-copy rejects a replacement inode and never removes that unrecognized temporary file',async t=>{
 const f=fixture(t);let candidate,privateDirectory;const originalSidecars=new Map();
 await assert.rejects(withOrdinaryMigrationSource(f.file,async checked=>{
  candidate=checked.file;privateDirectory=path.dirname(candidate);
  for(const name of fs.readdirSync(privateDirectory))if(name!==path.basename(candidate)){const file=path.join(privateDirectory,name);originalSidecars.set(file,fs.lstatSync(file));}
  const replacement=path.join(privateDirectory,'replacement');fs.writeFileSync(replacement,'independently replaced file',{mode:0o600});fs.renameSync(replacement,candidate);
  checked.check();
 }),{code:'MIGRATION_SOURCE_CHANGED'});
 assert.equal(fs.readFileSync(candidate,'utf8'),'independently replaced file','cleanup cannot unlink a replacement inode');
 // The synthetic fixture author now owns this exact recorded replacement.
 fs.unlinkSync(candidate);
 for(const name of fs.readdirSync(privateDirectory)){const file=path.join(privateDirectory,name),before=originalSidecars.get(file),after=fs.lstatSync(file);assert.ok(before);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);fs.unlinkSync(file);}
 fs.rmdirSync(privateDirectory);
});

test('restored eligibility refusal never invokes the ordinary migration consumer',async t=>{
 const f=fixture(t);mutate(f.file,db=>installWorkspaceRestoreSchema(db,metadata()));let calls=0;
 await assert.rejects(withOrdinaryMigrationSource(f.file,async()=>{calls++;}),{code:'RESTORE_MIGRATION_UNAVAILABLE'});
 assert.equal(calls,0);
});

for(const suffix of ['server.lock','-wal','-journal'])test(`checked-copy detects a newly active source ${suffix} before ordinary migration work`,async t=>{
 const f=fixture(t);let candidate;
 await assert.rejects(withOrdinaryMigrationSource(f.file,async checked=>{
  candidate=checked.file;const target=suffix==='server.lock'?path.join(f.source,suffix):f.file+suffix;
  fs.writeFileSync(target,'synthetic concurrent activity',{mode:0o600});checked.check();
 }),{code:'MIGRATION_SOURCE_CHANGED'});
 assert.equal(fs.existsSync(path.dirname(candidate)),false);assert.equal(fs.existsSync(f.destination),false);
});

test('checked-copy detects same-inode source content changes after eligibility read',async t=>{
 const f=fixture(t),original=fs.lstatSync(f.file);let candidate;
 await assert.rejects(withOrdinaryMigrationSource(f.file,async checked=>{
  candidate=checked.file;const fd=fs.openSync(f.file,'r+');try{fs.writeSync(fd,Buffer.from('different'),0,9,32);}finally{fs.closeSync(fd);}
  assert.equal(fs.lstatSync(f.file).ino,original.ino);checked.check();
 }),{code:'MIGRATION_SOURCE_CHANGED'});
 assert.equal(fs.existsSync(path.dirname(candidate)),false);assert.equal(fs.existsSync(f.destination),false);
});

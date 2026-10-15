import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function watchMarkerRows(t){
 const native=DatabaseSync.prototype.prepare,observed=[];
 t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
  const statement=Reflect.apply(native,this,[sql]);
  if(!/\bFROM\s+main\.schema_version\b/iu.test(sql))return statement;
  return new Proxy(statement,{get(target,key){
   if(key==='iterate')return function*(...args){
    for(const row of target.iterate(...args)){
     observed.push({type:typeof row.version,bytes:typeof row.version==='string'?Buffer.byteLength(row.version):row.version instanceof Uint8Array?row.version.byteLength:0});
     yield row;
    }
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 });return observed;
}
function refresh(backup){
 const file=path.join(backup,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 const database=fs.readFileSync(path.join(backup,'payload/workbench.sqlite')),entry=manifest.entries.find(value=>value.role==='database');
 entry.bytes=database.byteLength;entry.sha256=digest(database);
 const text=JSON.stringify(manifest);fs.writeFileSync(file,text);
 const completeFile=path.join(backup,'COMPLETE.json'),complete=JSON.parse(fs.readFileSync(completeFile,'utf8'));
 complete.manifestSha256=digest(text);complete.payloadBytes=manifest.entries.reduce((sum,value)=>sum+value.bytes,0);fs.writeFileSync(completeFile,JSON.stringify(complete));
}
for(const kind of ['text','blob'])test(`verify projects an imported oversized ${kind} marker to NULL before materializing rows`,async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'backup-marker-bounds-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),backup=path.join(root,'backup');fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o700});
 let db=new DatabaseSync(path.join(source,'workbench.sqlite'));
 try{db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);}finally{db.close();}
 fs.chmodSync(path.join(source,'workbench.sqlite'),0o600);await createWorkspaceBackup({source,destination:backup});
 db=new DatabaseSync(path.join(backup,'payload/workbench.sqlite'));
 try{
  db.exec('DROP TABLE schema_version;CREATE TABLE schema_version(version)');
  db.prepare('INSERT INTO schema_version VALUES(?)').run(kind==='text'?'x'.repeat(2*1024*1024):Buffer.alloc(2*1024*1024,255));
 }finally{db.close();}
 refresh(backup);
 const before=digest(fs.readFileSync(path.join(backup,'payload/workbench.sqlite'))),observed=watchMarkerRows(t);
 await assert.rejects(verifyWorkspaceBackup({directory:backup}),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
 assert.ok(observed.length>0,'the real verification path inspected the malformed marker');
 assert.equal(observed.every(value=>value.bytes===0),true,'no imported oversized cell crossed the SQLite/JS boundary');
 assert.equal(digest(fs.readFileSync(path.join(backup,'payload/workbench.sqlite'))),before);
});

test('bounded marker projection refuses unsafe integer values without JavaScript range conversion',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE schema_version(version);INSERT INTO schema_version VALUES(9007199254740993)');
 assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
});

test('ordinary24 unknown journal survives startup migration and cold36 archive while fixed37 restore refuses it',async t=>{
 const {openStore}=await import('../packages/business/src/db.mjs');
 const {restoreWorkspaceBackup}=await import('../packages/business/src/workspace-restore.mjs');
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'backup-custom-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),backup24=path.join(root,'backup24'),backup28=path.join(root,'backup28'),destination=path.join(root,'restore29');
 fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o700});
 const file=path.join(source,'workbench.sqlite');let db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF');initializeWorkspaceSchemaThrough24(db);
  db.exec('CREATE TABLE unknown_retained_journal(id TEXT PRIMARY KEY,data BLOB,n REAL)');
  db.prepare('INSERT INTO unknown_retained_journal(rowid,id,data,n) VALUES(?,?,?,?)').run(9007199254740993n,'opaque-history',Buffer.from([0,255,13,10]),123.25);
 }finally{db.close();}
 fs.chmodSync(file,0o600);
 const original24=fs.readFileSync(file);
 assert.equal((await createWorkspaceBackup({source,destination:backup24})).databaseSchemaVersion,24);
 assert.deepEqual(fs.readFileSync(path.join(backup24,'payload/workbench.sqlite')),original24);
 assert.equal((await verifyWorkspaceBackup({directory:backup24})).restoration,'not_tested');
 const store=openStore(source);
 try{
  assert.equal(store.db.prepare('SELECT max(version) AS n FROM schema_version').get().n,36);
  const read=store.db.prepare('SELECT rowid AS rowid,* FROM unknown_retained_journal');read.setReadBigInts(true);
  const actual=read.get();assert.equal(actual.rowid,9007199254740993n);assert.deepEqual(actual.data,new Uint8Array([0,255,13,10]));assert.equal(actual.n,123.25);
 }finally{store.close();}
 const original28=fs.readFileSync(file),created=await createWorkspaceBackup({source,destination:backup28});
 assert.equal(created.databaseSchemaVersion,36);assert.equal(created.integrity,'verified');assert.equal(created.restoration,'not_tested');
 assert.deepEqual(fs.readFileSync(path.join(backup28,'payload/workbench.sqlite')),original28);
 assert.deepEqual(await verifyWorkspaceBackup({directory:backup28}),created);
 await assert.rejects(restoreWorkspaceBackup({directory:backup28,destination}),{code:'WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED'});
 assert.equal(fs.existsSync(destination),false);
 assert.deepEqual(fs.readFileSync(file),original28);assert.deepEqual(fs.readFileSync(path.join(backup28,'payload/workbench.sqlite')),original28);
});

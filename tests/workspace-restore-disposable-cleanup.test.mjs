import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {withDisposableDatabase} from '../packages/business/src/workspace-backup.ts';
import {restoreFixture} from './helpers/workspace-restore-offline-fixture.ts';

function realWalFixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-real-wal-cleanup-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),parent=path.join(base,'inspection');
 fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(parent,{mode:0o700});
 const database=path.join(source,'workbench.sqlite'),writer=new DatabaseSync(database);
 try{writer.exec("PRAGMA journal_mode=WAL;CREATE TABLE evidence(note TEXT);INSERT INTO evidence VALUES('synthetic WAL close');PRAGMA wal_checkpoint(TRUNCATE);");}
 finally{writer.close();}
 fs.chmodSync(database,0o600);
 return {base,source,parent,database};
}

test('real read-only WAL close metadata changes are cleaned only for captured sidecar inodes',async t=>{
 const {source,parent,database}=realWalFixture(t);
 const sourceBefore=fs.readFileSync(database),nativeClose=DatabaseSync.prototype.close;
 const identities=[];let capturedClose=0;
 t.mock.method(DatabaseSync.prototype,'close',function(...args){
  const file=this.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
  if(typeof file!=='string'||!file.startsWith(parent+path.sep))return Reflect.apply(nativeClose,this,args);
  const before=new Map();capturedClose++;
  for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(file+suffix))before.set(suffix,fs.lstatSync(file+suffix));
  const result=Reflect.apply(nativeClose,this,args);
  for(const [suffix,info] of before){
   const after=fs.existsSync(file+suffix)?fs.lstatSync(file+suffix):null;
   identities.push({suffix,before:info,after});
  }
  t.diagnostic(`SQLite close sidecar observation: ${JSON.stringify(identities.map(({suffix,before,after})=>({suffix,removed:after===null,sameInode:after!==null&&before.dev===after.dev&&before.ino===after.ino,changedMetadata:after===null?[]:['size','mtimeMs','ctimeMs','mode','nlink'].filter(key=>before[key]!==after[key])})))}`);
  return result;
 });
 try{
  assert.equal(await withDisposableDatabase({database,databaseRoot:source,temporaryParent:parent,check:()=>{}},db=>{
   assert.equal(db.prepare('SELECT note FROM evidence').get().note,'synthetic WAL close');return 'inspected real WAL';
  }),'inspected real WAL');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.equal(capturedClose,1);
 assert.ok(identities.some(value=>value.suffix==='-shm'),'a real SQLite SHM was captured before close');
 // SQLite may remove its sidecars on some supported runtimes. Any survivor
 // must retain the captured inode; its mutable metadata is not ownership.
 for(const {before,after} of identities)if(after){assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);}
 assert.deepEqual(fs.readdirSync(parent),[]);
 assert.deepEqual(fs.readFileSync(database),sourceBefore);
 for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(database+suffix),false,'source sidecars are never created');
});

for(const fault of ['replacement','unknown-file'])test(`real WAL close never authorizes cleanup of a post-close ${fault}`,async t=>{
 const {source,parent,database}=realWalFixture(t),sourceBefore=fs.readFileSync(database),nativeClose=DatabaseSync.prototype.close;
 let changed,fired=0;
 t.mock.method(DatabaseSync.prototype,'close',function(...args){
  const file=this.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
  if(typeof file!=='string'||!file.startsWith(parent+path.sep))return Reflect.apply(nativeClose,this,args);
  assert.ok(fs.existsSync(file+'-shm'),'SQLite created a real sidecar before its connection closed');
  const before=fs.lstatSync(file+'-shm'),result=Reflect.apply(nativeClose,this,args);fired++;
  if(fault==='replacement'){
   const next=path.join(path.dirname(file),'replacement');fs.writeFileSync(next,'foreign post-close inode',{mode:0o600});
   fs.renameSync(next,file+'-shm');changed=file+'-shm';assert.notEqual(fs.lstatSync(changed).ino,before.ino);
  }else{changed=path.join(path.dirname(file),'unknown-after-close');fs.writeFileSync(changed,'foreign post-close inode',{mode:0o600});}
  return result;
 });
 try{
  await assert.rejects(withDisposableDatabase({database,databaseRoot:source,temporaryParent:parent,check:()=>{}},db=>db.prepare('SELECT note FROM evidence').get()),
   error=>fault==='replacement'?error.code==='WORKSPACE_BACKUP_CHANGED':error.code==='ENOTEMPTY');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.equal(fired,1);assert.equal(fs.readFileSync(changed,'utf8'),'foreign post-close inode');
 assert.deepEqual(fs.readFileSync(database),sourceBefore);
});

for(const replacement of [false,true])test(`disposable cleanup ${replacement?'preserves a replacement sidecar inode':'allows metadata evolution of its original sidecar inode'}`,async t=>{
 const f=await restoreFixture(t,{stages:false}),parent=path.join(f.base,'inspection');fs.mkdirSync(parent,{mode:0o700});
 let sidecar,identity,observed=false;
 const original=fs.lstatSync;
 // Create a harmless synthetic fixed sidecar just before first observation.
 // SQLite is not asked to interpret its contents or to execute source work.
 t.mock.method(fs,'lstatSync',function(file,...args){
  if(!observed&&typeof file==='string'&&file.startsWith(parent+path.sep)&&file.endsWith('/workbench.sqlite-journal')){
   observed=true;sidecar=file;fs.writeFileSync(file,'owned-sidecar',{mode:0o600});identity=original(file);
  }
  return original.call(this,file,...args);
 });syncBuiltinESMExports();
 let outcome;
 try{
  outcome=withDisposableDatabase({database:path.join(f.backup,'payload/workbench.sqlite'),databaseRoot:f.backup,temporaryParent:parent,check:()=>{}},async()=>{
   assert.ok(sidecar);assert.equal(fs.statSync(sidecar).ino,identity.ino);
   if(replacement){const next=path.join(parent,'replacement');fs.writeFileSync(next,'foreign-replacement-must-stay',{mode:0o600});fs.renameSync(next,sidecar);assert.notEqual(fs.statSync(sidecar).ino,identity.ino);}
   else fs.appendFileSync(sidecar,'-evolved-in-place');
   return 'inspected';
  });
  if(replacement){await assert.rejects(outcome,{code:'WORKSPACE_BACKUP_CHANGED'});assert.equal(fs.readFileSync(sidecar,'utf8'),'foreign-replacement-must-stay');assert.ok(fs.existsSync(path.dirname(sidecar)));}
  else {assert.equal(await outcome,'inspected');assert.equal(fs.existsSync(sidecar),false);assert.deepEqual(fs.readdirSync(parent),[]);}
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

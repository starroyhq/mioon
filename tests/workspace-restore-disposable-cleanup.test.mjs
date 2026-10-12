import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {withDisposableDatabase} from '../packages/business/src/workspace-backup.mjs';
import {restoreFixture} from './helpers/workspace-restore-offline-fixture.mjs';

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

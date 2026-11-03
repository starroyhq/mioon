import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {createNewDirectory,inspectFile,sameNode,sameFile,removeOwnedFile,streamFile,syncDirectory,writeBoundedFile} from '../packages/business/src/managed-file-io.ts';

// POSIX ownership/NOFOLLOW faults use the same platform boundary as the private
// storage tests; Windows owned-handle gates retain their dedicated acceptance.
const posix={skip:process.platform==='win32'};
function fixture(t:TestContext):string {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-managed-io-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function changedStats(info:fs.Stats,change:Partial<Pick<fs.Stats,'dev'|'ino'|'uid'|'size'|'mtimeMs'|'ctimeMs'>>):fs.Stats {
 return Object.assign(Object.create(Object.getPrototypeOf(info)) as fs.Stats,info,change);
}
function restoreMocks(t:TestContext):void {t.mock.restoreAll();syncBuiltinESMExports();}

test('managed mkdir refuses EEXIST without repairing permissions or existing contents',posix,t=>{
 const root=fixture(t),directory=path.join(root,'existing');fs.mkdirSync(directory,{mode:0o700});
 const sentinel=path.join(directory,'sentinel');fs.writeFileSync(sentinel,'original',{mode:0o600});
 for(const mode of [0o700,0o755]){
  fs.chmodSync(directory,mode);const before=fs.statSync(directory);
  assert.throws(()=>createNewDirectory(directory,root),{code:'WORKSPACE_BACKUP_DESTINATION_EXISTS'});
  assert.equal(fs.statSync(directory).mode&0o777,mode);
  assert.equal(sameNode(before,fs.statSync(directory)),true);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'original');
  assert.deepEqual(fs.readdirSync(directory),['sentinel']);
 }
 assert.deepEqual(fs.readdirSync(root),['existing']);
});

test('managed mkdir never recursively creates a missing parent',posix,t=>{
 const root=fixture(t),parent=path.join(root,'missing'),directory=path.join(parent,'leaf');
 const original=fs.mkdirSync;let mkdirs=0;
 t.mock.method(fs,'mkdirSync',(...args:Parameters<typeof fs.mkdirSync>)=>{mkdirs++;return original(...args);});syncBuiltinESMExports();
 try{
  assert.throws(()=>createNewDirectory(directory,root),{code:'STORAGE_PRIVATE_REQUIRED',reason:'MISSING'});
  assert.throws(()=>createNewDirectory(directory),{code:'STORAGE_PRIVATE_REQUIRED',reason:'MISSING'});
  assert.equal(mkdirs,0);
  assert.equal(fs.existsSync(parent),false);
  assert.deepEqual(fs.readdirSync(root),[]);
 }finally{restoreMocks(t);}
 const created=createNewDirectory(path.join(root,'leaf'),root);
 assert.equal(created.isDirectory(),true);assert.equal(created.mode&0o777,0o700);
});

test('managed inspection rejects links, wrong owners and byte overflow without modifying targets',posix,t=>{
 const root=fixture(t),target=path.join(root,'target'),symbolic=path.join(root,'symbolic'),hard=path.join(root,'hard');
 fs.writeFileSync(target,'unchanged',{mode:0o600});fs.symlinkSync(target,symbolic);
 assert.throws(()=>inspectFile(symbolic,root),{code:'STORAGE_PRIVATE_REQUIRED',reason:'SYMBOLIC_LINK'});
 assert.equal(fs.readlinkSync(symbolic),target);assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
 fs.linkSync(target,hard);
 assert.throws(()=>inspectFile(hard,root),{code:'STORAGE_PRIVATE_REQUIRED',reason:'HARD_LINK'});
 assert.equal(fs.lstatSync(hard).nlink,2);assert.equal(fs.readFileSync(target,'utf8'),'unchanged');fs.unlinkSync(hard);
 const original=fs.lstatSync;
 t.mock.method(fs,'lstatSync',(file:fs.PathLike)=>{const info=original(file);return String(file)===target?changedStats(info,{uid:process.getuid!()+1}):info;});syncBuiltinESMExports();
 try{assert.throws(()=>inspectFile(target,root),{code:'STORAGE_PRIVATE_REQUIRED',reason:'FOREIGN_OWNER'});}
 finally{restoreMocks(t);}
 assert.throws(()=>inspectFile(target,root,{maxBytes:8}),{code:'WORKSPACE_BACKUP_LIMIT'});
 assert.equal(inspectFile(target,root,{private:true,maxBytes:9})?.size,9);
 assert.equal(fs.readFileSync(target,'utf8'),'unchanged');assert.equal(fs.statSync(target).mode&0o777,0o600);
 assert.deepEqual(fs.readdirSync(root).sort(),['symbolic','target']);
});

test('managed file fences reject same-inode metadata reuse and preserve no-clobber bounded streams',posix,async t=>{
 const root=fixture(t),file=path.join(root,'value'),saved=path.join(root,'saved'),destination=path.join(root,'destination');
 const before=writeBoundedFile(file,root,Buffer.from('original'),64);
 assert.equal(sameNode(before,fs.statSync(file)),true);assert.equal(sameFile(before,fs.statSync(file)),true);
 fs.renameSync(file,saved);fs.writeFileSync(file,'replacement bytes',{mode:0o600});
 const replacement=fs.statSync(file),reused=changedStats(replacement,{dev:before.dev,ino:before.ino});
 // ext4 can reuse an unlinked inode. Force that identity rather than depend on
 // a newly created file obtaining a different number on this platform.
 assert.equal(sameNode(before,reused),true);assert.equal(sameFile(before,reused),false);
 const original=fs.lstatSync;
 t.mock.method(fs,'lstatSync',(name:fs.PathLike)=>String(name)===file?reused:original(name));syncBuiltinESMExports();
 try{
  assert.equal(removeOwnedFile(file,root,before),false);
  await assert.rejects(streamFile({file,root,destination,destinationRoot:root,expected:before}),{code:'WORKSPACE_BACKUP_CHANGED'});
  assert.equal(fs.existsSync(destination),false);assert.equal(fs.readFileSync(file,'utf8'),'replacement bytes');
 }finally{restoreMocks(t);}
 fs.writeFileSync(destination,'reserved',{mode:0o600});
 assert.throws(()=>writeBoundedFile(destination,root,Buffer.from('new'),64),{code:'EEXIST'});
 await assert.rejects(streamFile({file:saved,root,destination,destinationRoot:root}),{code:'EEXIST'});
 assert.equal(fs.readFileSync(destination,'utf8'),'reserved');assert.equal(fs.readFileSync(saved,'utf8'),'original');
 await assert.rejects(streamFile({file:saved,root,maxBytes:7}),{code:'WORKSPACE_BACKUP_LIMIT'});
 const copied=path.join(root,'copied'),open=fs.openSync,reads=fs.readSync;let nofollow=false,maxRead=0;
 t.mock.method(fs,'openSync',(name:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{
  if(String(name)===saved){assert.equal(typeof flags,'number');nofollow=typeof flags==='number'&&(flags&fs.constants.O_NOFOLLOW)!==0;}
  return open(name,flags,mode);
 });
 t.mock.method(fs,'readSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number)=>{maxRead=Math.max(maxRead,length);return reads(fd,buffer,offset,length,position);});syncBuiltinESMExports();
 try{
  const result=await streamFile({file:saved,root,destination:copied,destinationRoot:root});
  assert.equal(result.bytes,8);assert.equal(result.sha256,createHash('sha256').update('original').digest('hex'));
  assert.equal(nofollow,true);assert.ok(maxRead>0&&maxRead<=1024*1024);
  assert.equal(fs.readFileSync(copied,'utf8'),'original');
 }finally{restoreMocks(t);}
});

test('managed directory sync binds pre-open and post-sync identity and always closes failures',posix,t=>{
 const root=fixture(t),directory=path.join(root,'directory');createNewDirectory(directory,root);
 const sentinel=path.join(directory,'sentinel');fs.writeFileSync(sentinel,'original',{mode:0o600});
 for(const fault of ['none','opened-identity','post-identity','fsync'] as const){
  const open=fs.openSync,fstat=fs.fstatSync,lstat=fs.lstatSync,fsync=fs.fsyncSync,close=fs.closeSync;
  let descriptor:number|undefined,closed=0,synced=0;const injected=Object.assign(Error('synthetic directory flush failure'),{code:'EIO'});
  t.mock.method(fs,'openSync',(name:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{
   if(String(name)===directory){assert.equal(typeof flags,'number');assert.ok(typeof flags==='number'&&(flags&fs.constants.O_NOFOLLOW)!==0);}
   const fd=open(name,flags,mode);if(String(name)===directory)descriptor=fd;return fd;
  });
  t.mock.method(fs,'fstatSync',(fd:number)=>{const info=fstat(fd);return fd===descriptor&&fault==='opened-identity'?changedStats(info,{ino:info.ino+1}):info;});
  t.mock.method(fs,'lstatSync',(name:fs.PathLike)=>{const info=lstat(name);return String(name)===directory&&fault==='post-identity'&&synced>0?changedStats(info,{ino:info.ino+1}):info;});
  t.mock.method(fs,'fsyncSync',(fd:number)=>{synced++;if(fault==='fsync')throw injected;return fsync(fd);});
  t.mock.method(fs,'closeSync',(fd:number)=>{if(fd===descriptor)closed++;return close(fd);});syncBuiltinESMExports();
  try{
   if(fault==='none')assert.doesNotThrow(()=>syncDirectory(directory,root));
   else if(fault==='fsync')assert.throws(()=>syncDirectory(directory,root),error=>error===injected);
   else assert.throws(()=>syncDirectory(directory,root),{code:'WORKSPACE_BACKUP_CHANGED'});
   assert.equal(closed,1);assert.equal(synced,fault==='opened-identity'?0:1);
  }finally{restoreMocks(t);}
  assert.ok(descriptor!==undefined);assert.throws(()=>fs.fstatSync(descriptor!),{code:'EBADF'});
  assert.equal(fs.readFileSync(sentinel,'utf8'),'original');assert.deepEqual(fs.readdirSync(directory),['sentinel']);
 }
});

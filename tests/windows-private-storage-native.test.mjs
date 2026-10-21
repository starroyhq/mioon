import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {linkSync,symlinkSync,mkdirSync,rmSync,lstatSync,renameSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {getStoragePrivacyCapability,createPrivateTemporaryDirectory,ensurePrivateDirectory,validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic,removePrivateFile,privateStorageIdentity} from '../packages/contracts/src/private-storage.ts';

const windows=process.platform==='win32';
async function fixture(t){await initializeNodePrivateStorage();const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-native-private-');t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('native Windows protected creation, bounded read, atomic no-clobber, replacement and removal',{skip:!windows},async t=>{
 const root=await fixture(t);assert.equal(getStoragePrivacyCapability().backend,'windows-current-user-acl');
 const first=validatePrivateDirectory(root);assert.match(privateStorageIdentity(first),/^windows:[a-f0-9]{16}:[a-f0-9]{32}$/u);
 const file=path.join(root,'secret.json');writePrivateFileAtomic(file,'synthetic-one',{root,replace:false,maxBytes:64});assert.equal(readPrivateFile(file,{root,encoding:'utf8',maxBytes:64}),'synthetic-one');
 assert.equal(readPrivateFile(file,{root:root.toUpperCase(),encoding:'utf8',maxBytes:64}),'synthetic-one','Equivalent case-insensitive root spellings must resolve to the same native identity');
 const before=privateStorageIdentity(validateManagedFile(file,{root,private:true}));
 assert.throws(()=>writePrivateFileAtomic(file,'synthetic-two',{root,replace:false,maxBytes:64}),{reason:'ALREADY_EXISTS'});
 writePrivateFileAtomic(file,'synthetic-two',{root,maxBytes:64});assert.notEqual(privateStorageIdentity(validateManagedFile(file,{root,private:true})),before);
 assert.equal(readPrivateFile(file,{root,encoding:'utf8',maxBytes:64}),'synthetic-two');assert.throws(()=>readPrivateFile(file,{root,maxBytes:2}),{reason:'SIZE_LIMIT'});
 removePrivateFile(file,{root,maxBytes:64});assert.equal(readPrivateFile(file,{root,allowMissing:true}),null);
 const child=path.join(root,'nested','private');assert.ok(ensurePrivateDirectory(child,{create:true}));
});
test('native Windows rejects traversal aliases, streams, reparse points, hard links and foreign grants',{skip:!windows},async t=>{
 const root=await fixture(t),file=path.join(root,'source');writePrivateFileAtomic(file,'synthetic',{root,maxBytes:64});
 for(const invalid of ['\\\\server\\share\\secret','\\\\?\\C:\\secret',file+':stream',path.join(root,'CON'),root+'\\folder.'])assert.throws(()=>readPrivateFile(invalid,{root,allowMissing:true}));
 const hard=path.join(root,'hard');linkSync(file,hard);assert.throws(()=>validateManagedFile(file,{root}),{reason:'HARD_LINK'});rmSync(hard);
 const target=path.join(root,'target');mkdirSync(target);const junction=path.join(root,'junction');symlinkSync(target,junction,'junction');assert.throws(()=>validatePrivateDirectory(junction),{reason:'REPARSE_POINT'});
 const acl=spawnSync('icacls.exe',[file,'/grant','*S-1-1-0:(R)'],{encoding:'utf8'});assert.equal(acl.status,0,'Native ACL mutation prerequisite failed; do not count Windows ACL tests as passed');assert.throws(()=>readPrivateFile(file,{root,maxBytes:64}),{reason:'UNSAFE_ACL'});
});
test('native Windows accepts closed inherited ACLs on SQLite database and WAL files',{skip:!windows},async t=>{
 const root=await fixture(t),file=path.join(root,'workbench.sqlite'),db=new DatabaseSync(file);
 try{db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(1)');assert.ok(validateManagedFile(file,{root}));assert.ok(validateManagedFile(file+'-wal',{root}));assert.ok(validateManagedFile(file+'-shm',{root}));}finally{db.close();}
});
test('native Windows case-sensitive root prefixes cannot escape the declared full identity',{skip:!windows},async t=>{
 const parent=await fixture(t);
 const enabled=spawnSync('fsutil.exe',['file','setCaseSensitiveInfo',parent,'enable'],{encoding:'utf8'});
 assert.equal(enabled.status,0,'Native case-sensitive directory prerequisite failed; do not count root-boundary verification as passed');
 const upper=path.join(parent,'Work'),lower=path.join(parent,'work');
 ensurePrivateDirectory(upper,{create:true});ensurePrivateDirectory(lower,{create:true});
 assert.notEqual(privateStorageIdentity(validatePrivateDirectory(upper)),privateStorageIdentity(validatePrivateDirectory(lower)),'The fixture must contain two distinct native directory identities');
 const file=path.join(lower,'synthetic-secret');writePrivateFileAtomic(file,'lower-root-only',{root:lower,maxBytes:64});
 assert.equal(readPrivateFile(file,{root:lower,maxBytes:64,encoding:'utf8'}),'lower-root-only');
 assert.throws(()=>readPrivateFile(file,{root:upper,maxBytes:64}),{reason:'INVALID_PATH'});
 assert.throws(()=>writePrivateFileAtomic(file,'outside-upper-root',{root:upper,maxBytes:64}),{reason:'INVALID_PATH'});
 assert.throws(()=>removePrivateFile(file,{root:upper,maxBytes:64}),{reason:'INVALID_PATH'});
 assert.equal(readPrivateFile(file,{root:lower,maxBytes:64,encoding:'utf8'}),'lower-root-only');
});
test('native metadata callback retains real pinned handles and does not expose foreign CRT descriptors',{skip:!windows},async t=>{
 const root=await fixture(t),moved=root+'-unexpected-move';t.after(()=>rmSync(moved,{recursive:true,force:true}));
 const native=createRequire(import.meta.url)('../packages/node-host/build/Release/mioon_private_storage.node');
 let actual,calls=0;
 const info=native.inspect(root,{kind:'directory'},()=>{calls++;assert.throws(()=>renameSync(root,moved),error=>['EPERM','EACCES','EBUSY'].includes(error.code));actual=lstatSync(root);return actual;});
 assert.equal(calls,1);assert.equal(info.metadata,actual);assert.equal(info.metadata.isDirectory(),true);assert.equal(Object.hasOwn(info,'fd'),false);assert.equal(Object.hasOwn(info,'handle'),false);
 assert.throws(()=>native.inspect(root,{kind:'directory'},()=>{throw Error('SYNTHETIC_CALLBACK_ERROR_NEVER_EXPOSED');}),error=>error.reason==='IO_ERROR'&&!error.message.includes('SYNTHETIC_CALLBACK_ERROR_NEVER_EXPOSED'));
 assert.equal(validatePrivateDirectory(root).isDirectory(),true);
});

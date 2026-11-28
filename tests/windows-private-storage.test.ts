import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {privateStorageIdentity,samePrivateStorageIdentity,registerWindowsPrivateStorageBackend,getStoragePrivacyCapability} from '../packages/contracts/src/private-storage.ts';

const moduleUrl=new URL('../packages/contracts/src/private-storage.ts',import.meta.url).href;
test('POSIX bootstrap does not load a Windows binary or replace the storage backend',{skip:process.platform==='win32'},async()=>{
  const before=getStoragePrivacyCapability();await initializeNodePrivateStorage();await initializeNodePrivateStorage();assert.deepEqual(getStoragePrivacyCapability(),before);
  assert.equal(samePrivateStorageIdentity({dev:1n,ino:9007199254740993n},{dev:1n,ino:9007199254740992n}),false);
  assert.equal(privateStorageIdentity({dev:1n,ino:9007199254740993n}),'posix:1:9007199254740993');
  assert.throws(()=>registerWindowsPrivateStorageBackend({platform:'win32',apiVersion:1} as Parameters<typeof registerWindowsPrivateStorageBackend>[0]),{code:'STORAGE_PRIVACY_UNAVAILABLE'});
});
test('Windows full identities cannot fall back to truncated Node metadata (synthetic protocol, not ACL verification)',()=>{
 const script=`Object.defineProperty(process,'platform',{value:'win32'});const s=await import(${JSON.stringify(moduleUrl)});const a={dev:1,ino:2},b={dev:1,ino:2};try{s.privateStorageIdentity(a);process.exit(2)}catch(e){if(e.reason!=='FILE_IDENTITY_UNVERIFIED')throw e;}s.bindWindowsPrivateStorageIdentity(a,'0000000000000001','00000000000000000000000000000001');s.bindWindowsPrivateStorageIdentity(b,'0000000000000001','10000000000000000000000000000001');if(s.samePrivateStorageIdentity(a,b))process.exit(3);if(s.getStoragePrivacyCapability().available)process.exit(4);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env: testEnv(), encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('early-imported storage functions dispatch only after a complete one-time backend registration (synthetic protocol)',()=>{
 const script=`Object.defineProperty(process,'platform',{value:'win32'});const s=await import(${JSON.stringify(moduleUrl)});const early=s.ensurePrivateDirectory;let denied=false;try{early('/never-opened')}catch(e){denied=e.code==='STORAGE_PRIVACY_UNAVAILABLE';}if(!denied)process.exit(2);let calls=0;const backend={platform:'win32',apiVersion:1};for(const name of ['assertStoragePrivacyAvailable','ensurePrivateDirectory','validatePrivateDirectory','createPrivateTemporaryDirectory','validateManagedDirectory','validateManagedFile','readPrivateFile','writePrivateFileAtomic','removePrivateFile'])backend[name]=()=>{calls++;return null;};s.registerWindowsPrivateStorageBackend(backend);early('/never-opened');if(calls!==2||s.getStoragePrivacyCapability().backend!=='windows-current-user-acl')process.exit(3);try{s.registerWindowsPrivateStorageBackend(backend);process.exit(4)}catch(e){if(e.code!=='STORAGE_PRIVACY_UNAVAILABLE')throw e;}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env: testEnv(), encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('Windows adapter passes large metadata bounds to native inspection only (synthetic protocol)',()=>{
 const adapterUrl=new URL('../packages/node-host/src/windows-private-storage.ts',import.meta.url).href;
 const script=`
  import assert from 'node:assert/strict';
  Object.defineProperty(process,'platform',{value:'win32'});
  const storage=await import(${JSON.stringify(moduleUrl)});
  const {createWindowsPrivateStorageBackend}=await import(${JSON.stringify(adapterUrl)});
  const root='synthetic-root',file=root+'/artifact',bufferLimit=64*1024**2,streamLimit=8*1024**3;
  const volume='1'.repeat(16),fileId='2'.repeat(32),bounds=[];
  let size=bufferLimit+1,unexpectedCalls=0;
  const unexpected=()=>{unexpectedCalls++;throw Error('Unexpected native buffer operation');};
  storage.registerWindowsPrivateStorageBackend(createWindowsPrivateStorageBackend({
    apiVersion:1,assertAvailable(){},read:unexpected,write:unexpected,remove:unexpected,temporary:unexpected,
    inspect(target,options){
      assert.equal(target,file);
      assert.equal(options.root,root);
      assert.equal(options.kind,'file');
      assert.equal(options.private,true);
      bounds.push(options.maxBytes);
      if(size>options.maxBytes)throw Object.assign(Error(),{reason:'SIZE_LIMIT'});
      return {metadata:{size},volume,fileId};
    },
  }));
  const metadata=maxBytes=>storage.validateManagedFile(file,{root,private:true,maxBytes});
  const validated=metadata(size);
  assert.equal(validated.size,size);
  assert.equal(storage.privateStorageIdentity(validated),'windows:'+volume+':'+fileId);
  assert.throws(()=>metadata(bufferLimit),{reason:'SIZE_LIMIT'});
  for(const access of [
    ()=>storage.readPrivateFile(file,{root,maxBytes:size}),
    ()=>storage.writePrivateFileAtomic(file,'replacement',{root,maxBytes:size}),
    ()=>storage.removePrivateFile(file,{root,maxBytes:size}),
  ])assert.throws(access,{reason:'INVALID_LIMIT'});
  size=streamLimit;
  assert.equal(metadata(streamLimit).size,streamLimit);
  assert.throws(()=>metadata(streamLimit+1),{reason:'INVALID_LIMIT'});
  assert.deepEqual(bounds,[bufferLimit+1,bufferLimit,streamLimit]);
  assert.equal(unexpectedCalls,0);
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:testEnv(),encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
});
test('desktop dependency boundary has no native load in shared contracts/client',()=>{
 const contracts=readFileSync(fileURLToPath(new URL('../packages/contracts/src/private-storage.ts',import.meta.url)),'utf8');
 const client=readFileSync(fileURLToPath(new URL('../packages/client/src/connection.ts',import.meta.url)),'utf8');
 assert.doesNotMatch(contracts,/require\([^)]*\.node|from ['"][^'"]*node-host/u);assert.doesNotMatch(client,/from ['"][^'"]*node-host/u);
 const require=createRequire(import.meta.url);assert.ok(path.isAbsolute(require.resolve('@mioon/contracts/private-storage')));
});

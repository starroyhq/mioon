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
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('early-imported storage functions dispatch only after a complete one-time backend registration (synthetic protocol)',()=>{
 const script=`Object.defineProperty(process,'platform',{value:'win32'});const s=await import(${JSON.stringify(moduleUrl)});const early=s.ensurePrivateDirectory;let denied=false;try{early('/never-opened')}catch(e){denied=e.code==='STORAGE_PRIVACY_UNAVAILABLE';}if(!denied)process.exit(2);let calls=0;const backend={platform:'win32',apiVersion:1};for(const name of ['assertStoragePrivacyAvailable','ensurePrivateDirectory','validatePrivateDirectory','createPrivateTemporaryDirectory','validateManagedDirectory','validateManagedFile','readPrivateFile','writePrivateFileAtomic','removePrivateFile'])backend[name]=()=>{calls++;return null;};s.registerWindowsPrivateStorageBackend(backend);early('/never-opened');if(calls!==2||s.getStoragePrivacyCapability().backend!=='windows-current-user-acl')process.exit(3);try{s.registerWindowsPrivateStorageBackend(backend);process.exit(4)}catch(e){if(e.code!=='STORAGE_PRIVACY_UNAVAILABLE')throw e;}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('desktop dependency boundary has no native load in shared contracts/client',()=>{
 const contracts=readFileSync(fileURLToPath(new URL('../packages/contracts/src/private-storage.ts',import.meta.url)),'utf8');
 const client=readFileSync(fileURLToPath(new URL('../packages/client/src/connection.ts',import.meta.url)),'utf8');
 assert.doesNotMatch(contracts,/require\([^)]*\.node|from ['"][^'"]*node-host/u);assert.doesNotMatch(client,/from ['"][^'"]*node-host/u);
 const require=createRequire(import.meta.url);assert.ok(path.isAbsolute(require.resolve('@mioon/contracts/private-storage')));
});

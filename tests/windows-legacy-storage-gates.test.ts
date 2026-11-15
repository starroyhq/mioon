import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Windows manual drafts without a database owner refuse before storage effects (synthetic platform gate)',()=>{
 const storage=new URL('../packages/contracts/src/private-storage.ts',import.meta.url).href;
 const drafts=new URL('../packages/business/src/local-drafts.ts',import.meta.url).href;
 const root=path.join(tmpdir(),'mioon-legacy-never-created');
 const source=`
 import assert from 'node:assert/strict';
 const s=await import(${JSON.stringify(storage)});Object.defineProperty(process,'platform',{value:'win32'});
 let calls=0;const backend={apiVersion:1,platform:'win32',assertStoragePrivacyAvailable:()=>{}};
 for(const name of ['ensurePrivateDirectory','validatePrivateDirectory','createPrivateTemporaryDirectory','validateManagedDirectory','validateManagedFile','readPrivateFile','writePrivateFileAtomic','removePrivateFile'])backend[name]=()=>{calls++;throw Error('UNEXPECTED_STORAGE_ACCESS');};
 s.registerWindowsPrivateStorageBackend(backend);assert.equal(s.getStoragePrivacyCapability().available,true);
 const root=${JSON.stringify(root)};
 const {createLocalDrafts}=await import(${JSON.stringify(drafts)});
 const unavailable=()=>{calls++;throw Error('UNEXPECTED_DRAFT_ACCESS');};
 const store=createLocalDrafts({root,guards:{ownsLock:unavailable,readTimeline:unavailable,readClipAsset:unavailable},storage:{validatePrivateDirectory:unavailable,validateManagedFile:unavailable,readPrivateFile:unavailable,writePrivateFileAtomic:unavailable}});
 for(const name of ['get','list','put','discard','removeProject','assertProjectDeletable'])assert.throws(()=>store[name]({}),{code:'LOCAL_DRAFT_STORAGE_UNAVAILABLE'});
 assert.equal(calls,0);console.log('synthetic-gate-no-effects');
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env: testEnv(), encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'synthetic-gate-no-effects');
});

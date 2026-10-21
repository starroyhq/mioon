import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// This injected Windows capability exercises publication failure windows; it
// does not replace the separately opt-in native ACL/handle/CLI acceptance.
test('Windows publication preserves no-clobber and handles only exact owned markers after uncertain rename',()=>{
  const storage=new URL('../packages/contracts/src/private-storage.ts',import.meta.url).href;
  const backup=new URL('../packages/business/src/workspace-backup-storage.ts',import.meta.url).href;
  const restore=new URL('../packages/business/src/workspace-restore.ts',import.meta.url).href;
  const source=`
import assert from 'node:assert/strict';
const s=await import(${JSON.stringify(storage)});Object.defineProperty(process,'platform',{value:'win32'});
const files=new Map();let serial=0,mode='normal',syncs=0,removes=0;
const node=bytes=>({id:(++serial).toString(16).padStart(32,'0'),bytes:Buffer.from(bytes),mtime:serial,ctime:serial});
const info=value=>{if(!value)return null;const result={dev:0,ino:0,size:value.bytes.length,mtimeMs:value.mtime,ctimeMs:value.ctime,nlink:1,isFile:()=>true,isDirectory:()=>false};s.bindWindowsPrivateStorageIdentity(result,'0000000000000001',value.id);return result;};
const directory=()=>{const result={dev:0,ino:0,size:0,mtimeMs:1,ctimeMs:1,nlink:1,isFile:()=>false,isDirectory:()=>true};s.bindWindowsPrivateStorageIdentity(result,'0000000000000001','f'.repeat(32));return result;};
const managedFileIO={
 openFile(file,options){if(options.mode!=='create'||files.has(file))throw Error('UNEXPECTED_OPEN');const value=node('');files.set(file,value);return {metadata:()=>info(value),write:bytes=>{value.bytes=Buffer.concat([value.bytes,bytes]);},flush(){},close(){}};},
 createDirectoryNew:directory,openDirectory(){throw Error('UNEXPECTED_SCAN');},
 syncDirectory(){syncs++;if(mode==='flush-failure'&&syncs===1)throw Error('SYNTHETIC_FLUSH_FAILURE');},
 renameNoReplace(from,to,{expected}){const value=files.get(from);assert.equal(s.samePrivateStorageIdentity(expected,info(value)),true);if(files.has(to))throw Object.assign(Error('SYNTHETIC_EXISTS'),{reason:'ALREADY_EXISTS'});files.delete(from);files.set(to,value);value.ctime++;
  if(mode==='foreign-after-rename'){files.set(to,node('foreign marker'));throw Error('SYNTHETIC_AFTER_RENAME');}
  if(mode==='after-rename')throw Error('SYNTHETIC_AFTER_RENAME');return info(value);},
 removeOwnedFile(file,{expected}){assert.equal(s.samePrivateStorageIdentity(expected,info(files.get(file))),true);files.delete(file);removes++;},removeOwnedDirectory(){throw Error('UNEXPECTED_REMOVE_DIRECTORY');},
};
const backend={apiVersion:1,platform:'win32',managedFileIO,assertStoragePrivacyAvailable(){},ensurePrivateDirectory:directory,validatePrivateDirectory:directory,createPrivateTemporaryDirectory(){throw Error('UNEXPECTED_TEMP');},validateManagedDirectory:directory,validateManagedFile:file=>info(files.get(file)),readPrivateFile:file=>Buffer.from(files.get(file).bytes),writePrivateFileAtomic(){throw Error('UNEXPECTED_ATOMIC_WRITE');},removePrivateFile(){throw Error('UNEXPECTED_REMOVE');}};
s.registerWindowsPrivateStorageBackend(backend);const b=await import(${JSON.stringify(backup)}),r=await import(${JSON.stringify(restore)});
const root='/synthetic-backup',marker=root+'/COMPLETE.json',bytes=Buffer.from('{}');
function reset(next){files.clear();mode=next;syncs=0;removes=0;}
reset('after-rename');assert.throws(()=>b.publishMarker(marker,root,bytes,()=>{}),/SYNTHETIC_AFTER_RENAME/);assert.equal(files.size,0);assert.equal(removes,1);assert.equal(syncs,1);
reset('flush-failure');assert.throws(()=>b.publishMarker(marker,root,bytes,()=>{}),/SYNTHETIC_FLUSH_FAILURE/);assert.equal(files.size,0);assert.equal(removes,1);assert.equal(syncs,2);
reset('foreign-after-rename');assert.throws(()=>b.publishMarker(marker,root,bytes,()=>{}),{code:'WORKSPACE_BACKUP_PUBLICATION_UNCONFIRMED'});assert.equal(files.get(marker).bytes.toString(),'foreign marker');assert.equal(removes,0);assert.equal(files.size,1);
reset('normal');files.set(marker,node('existing marker'));assert.throws(()=>b.publishMarker(marker,root,bytes,()=>{}),{reason:'ALREADY_EXISTS'});assert.equal(files.get(marker).bytes.toString(),'existing marker');assert.equal(files.size,1);assert.equal(syncs,0);
reset('after-rename');const candidate=root+'/candidate.sqlite',final=root+'/workbench.sqlite';files.set(candidate,node('guarded database'));let attempts=0,published=0;const identity=info(files.get(candidate));
assert.throws(()=>r.publishOfflineWorkspaceCandidate(candidate,final,root,identity,()=>{},()=>attempts++,()=>published++),/SYNTHETIC_AFTER_RENAME/);assert.equal(attempts,1);assert.equal(published,0);assert.equal(files.get(final).bytes.toString(),'guarded database');assert.equal(removes,0);
console.log('publication-boundaries-preserved');
`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'publication-boundaries-preserved');
});

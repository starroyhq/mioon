import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,getWindowsManagedFileIO,validateManagedFile} from '../packages/contracts/src/private-storage.ts';
import {openStore,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {streamFile,createNewDirectory,sameFile,writeBoundedFile} from '../packages/business/src/workspace-backup-storage.ts';
import {exportWorkspaceBackupBundle,importWorkspaceBackupBundle} from '../packages/business/src/workspace-backup-bundle.ts';

const enabled=process.platform==='win32'&&process.env.MIOON_WINDOWS_BACKUP_TEST==='1';
const entry=new URL('../apps/cli/src/backup.ts',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function cli(args){
  const result=spawnSync(process.execPath,[fileURLToPath(entry),...args],{encoding:'utf8',timeout:120000,maxBuffer:256*1024});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1,result.stderr);
  const envelope=JSON.parse(lines[0]);return {...result,envelope};
}
function success(result){assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.envelope.ok,true);return result.envelope.data;}
function failure(result,code){assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(result.envelope.ok,false);assert.equal(result.envelope.error.code,code);}
async function fixture(t){
  await initializeNodePrivateStorage();const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-backup-native-');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'workspace'),store=openStore(source),projectId=randomUUID(),assetId=randomUUID(),relative=`media/${assetId}.mp4`;
  const chunk=Buffer.alloc(1024*1024,0x47),digest=createHash('sha256'),io=getWindowsManagedFileIO();
  store.put('projects',{id:projectId,name:'Synthetic Windows backup acceptance'});
  const handle=io.openFile(path.join(source,relative),{root:source,private:true,mode:'create'});
  try{for(let n=0;n<65;n++){handle.write(chunk);digest.update(chunk);}handle.flush();assert.equal(handle.metadata().size,65*chunk.length);}finally{handle.close();}
  const mediaHash=digest.digest('hex');
  store.put('assets',{id:assetId,projectId,relativePath:relative,mimeType:'video/mp4',sha256:mediaHash,sizeBytes:65*chunk.length});
  store.close();return {root,source,relative,mediaHash,dbHash:hash(readFileSync(path.join(source,'workbench.sqlite')))};
}

test('Windows native offline CLI create/verify/restore/status preserves source and streams over 64MiB',{skip:!enabled,timeout:240000},async t=>{
  const f=await fixture(t),parent=path.join(f.root,'ordinary-parent');
  // Ordinary safe ancestry may inherit its ACL. Only newly created backup and
  // restored roots require a protected DACL; parent durability still must flush.
  mkdirSync(parent);const backup=path.join(parent,'backup'),restored=path.join(parent,'restored');
  const created=success(cli(['create','--source',f.source,'--destination',backup]));
  assert.equal(created.databaseSchemaVersion,56);assert.ok(existsSync(path.join(backup,'COMPLETE.json')));
  const verified=success(cli(['verify','--directory',backup]));assert.equal(verified.backupId,created.backupId);
  const result=success(cli(['restore','--directory',backup,'--destination',restored]));
  assert.equal(result.sourceBackupId,created.backupId);
  const status=success(cli(['restore-status','--destination',restored,'--restoration-id',result.restorationId,'--backup-id',result.sourceBackupId,'--manifest-hash',result.manifestHash,'--source-db-hash',result.sourceDbHash]));
  assert.equal(status.restorationId,result.restorationId);
  const directoryStatus=success(cli(['restore-status','--directory',backup,'--destination',restored]));assert.equal(directoryStatus.restorationId,result.restorationId);
  assert.equal(hash(readFileSync(path.join(f.source,'workbench.sqlite'))),f.dbHash);
  for(const [root,file] of [[f.source,f.relative],[backup,`payload/${f.relative}`],[restored,f.relative]])assert.equal((await streamFile({file:path.join(root,file),root,private:true})).sha256,f.mediaHash);
  const db=new DatabaseSync(path.join(restored,'workbench.sqlite'),{readOnly:true});
  try{assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion,57);}finally{db.close();}
  const finalHash=hash(readFileSync(path.join(restored,'workbench.sqlite')));
  failure(cli(['create','--source',f.source,'--destination',backup]),'WORKSPACE_BACKUP_DESTINATION_EXISTS');
  failure(cli(['restore','--directory',backup,'--destination',restored]),'WORKSPACE_RESTORE_DESTINATION_EXISTS');
  assert.equal(hash(readFileSync(path.join(restored,'workbench.sqlite'))),finalHash);
  assert.equal(existsSync(path.join(f.source,'server.lock')),false);assert.equal(existsSync(path.join(restored,'server.lock')),false);
});

test('Windows native backup bundle uses bounded leases and cancellation never publishes COMPLETE',{skip:!enabled,timeout:240000},async t=>{
  const f=await fixture(t),backup=path.join(f.root,'backup'),imported=path.join(f.root,'imported');
  await createWorkspaceBackup({source:f.source,destination:backup});createNewDirectory(imported);
  let chunks=0;
  async function* transfer(){for await(const chunk of exportWorkspaceBackupBundle({directory:backup})){assert.ok(chunk.length<=1024*1024);chunks++;yield chunk;}}
  await importWorkspaceBackupBundle({source:transfer(),destination:imported});assert.ok(chunks>65);
  assert.equal((await streamFile({file:path.join(imported,'payload',f.relative),root:imported,private:true})).sha256,f.mediaHash);
  const controller=new AbortController(),cancelled=path.join(f.root,'cancelled');
  const operation=createWorkspaceBackup({source:f.source,destination:cancelled,signal:controller.signal});await yieldIO();controller.abort();
  await assert.rejects(operation,{code:'WORKSPACE_BACKUP_CANCELLED'});assert.equal(existsSync(path.join(cancelled,'COMPLETE.json')),false);
  assert.equal(hash(readFileSync(path.join(f.source,'workbench.sqlite'))),f.dbHash);assert.equal(existsSync(path.join(f.source,'server.lock')),false);
  const copyRoot=path.join(f.root,'copies');createNewDirectory(copyRoot);
  const target=path.join(copyRoot,'sentinel');writeBoundedFile(target,copyRoot,Buffer.from('preserved'),64);
  const before=validateManagedFile(target,{root:copyRoot,private:true});
  await assert.rejects(streamFile({file:path.join(f.source,f.relative),root:f.source,destination:target,destinationRoot:copyRoot,private:true}));
  assert.equal(readFileSync(target,'utf8'),'preserved');assert.equal(sameFile(before,validateManagedFile(target,{root:copyRoot,private:true})),true);
});

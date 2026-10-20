import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {TestContext} from 'node:test';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createWorkspaceBackupRuntime,resolveWorkspaceActivation} from '../packages/business/src/workspace-backup-runtime.ts';
import {verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {workspaceConfigurationSchemas} from '../packages/contracts/src/workspace-configuration.ts';
import {importWorkspaceBackupBundle} from '../packages/business/src/workspace-backup-bundle.ts';

const code=(expected:string)=>(error:unknown)=>(error as {code?:string})?.code===expected;
function fixture(t:TestContext,options:{isQuiescent?:()=>boolean;now?:()=>number}={}) {
  const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-settings-runtime-')),root=path.join(base,'workspace'),store=openStore(root);
  const configuration=createWorkspaceConfiguration({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'0',SYNTHETIC_PRIVATE_SECRET:'not-public'}}),runtime=createWorkspaceBackupRuntime({store,configuration,...options});
  t.after(async()=>{runtime.stop();await runtime.drain();store.close();fs.rmSync(base,{recursive:true,force:true});});
  return {base,root,store,configuration,runtime};
}

test('workspace settings persist revisioned live opt-in independently of process.env and reject stale writes',t=>{
  const f=fixture(t),before=process.env.MIOON_ENABLE_LIVE_PROVIDER,environment=f.configuration.environment();
  assert.equal(f.configuration.liveEnabled(),false);assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER,'0');
  assert.throws(()=>f.configuration.assertLiveEnabled(),code('LIVE_GENERATION_DISABLED'));
  const saved=f.configuration.set({expectedRevision:0,liveGeneration:true});assert.equal(saved.revision,1);
  assert.equal(f.configuration.liveEnabled(),true);assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER,'1');
  assert.equal(process.env.MIOON_ENABLE_LIVE_PROVIDER,before);
  assert.throws(()=>f.configuration.set({expectedRevision:0,liveGeneration:false}),code('WORKSPACE_SETTINGS_CONFLICT'));
  const reopened=createWorkspaceConfiguration({root:f.root,env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});assert.equal(reopened.liveEnabled(),true);
  reopened.set({expectedRevision:1,liveGeneration:false});assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER,'0');
  assert.throws(()=>f.configuration.assertLiveEnabled(),code('LIVE_GENERATION_DISABLED'));
  assert.doesNotMatch(JSON.stringify(saved),/not-public|SYNTHETIC_PRIVATE_SECRET/);
});

test('public settings and restore inputs never accept arbitrary filesystem paths or implicit confirmation',t=>{
  const f=fixture(t);
  assert.equal(workspaceConfigurationSchemas['workspace.settings.set'].safeParse({expectedRevision:0,backupDirectory:'/tmp/arbitrary'}).success,false);
  assert.equal(workspaceConfigurationSchemas['workspace.backup.restore.stage'].safeParse({requestId:randomUUID(),backupId:randomUUID()}).success,false);
  assert.throws(()=>f.configuration.set({expectedRevision:0,backupLocation:'selected'}),code('WORKSPACE_BACKUP_LOCATION_REQUIRED'));
  const selected=path.join(f.base,'chosen');fs.mkdirSync(selected,{mode:0o700});
  const saved=f.configuration.setBackupDirectory(selected);assert.equal(saved.backupDirectory,selected);assert.equal(saved.backupLocation,'selected');
  assert.throws(()=>f.configuration.setBackupDirectory(f.root));
  const link=path.join(f.base,'link');fs.symlinkSync(selected,link);assert.throws(()=>f.configuration.setBackupDirectory(link));
});

test('live SQLite backup preserves committed WAL data and managed media, keeps source open, and replays exact requests',async t=>{
  const f=fixture(t),projectId=randomUUID(),assetId=randomUUID(),bytes=Buffer.from('synthetic media snapshot');
  f.store.put('projects',{id:projectId,name:'Committed WAL project'});
  const relativePath=`media/${assetId}.png`;fs.writeFileSync(path.join(f.root,relativePath),bytes,{mode:0o600});
  f.store.put('assets',{id:assetId,projectId,relativePath,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  fs.writeFileSync(path.join(f.root,'access-token'),'SYNTHETIC_CREDENTIAL',{mode:0o600});
  const input={requestId:randomUUID()},entry=await f.runtime.create(input);
  assert.deepEqual(await f.runtime.create(input),entry);assert.equal(f.runtime.list().length,1);assert.equal(f.store.db.isOpen,true);
  const directory=path.join(f.configuration.get().backupDirectory,entry.id);await verifyWorkspaceBackup({directory});
  const db=new DatabaseSync(path.join(directory,'payload/workbench.sqlite'),{readOnly:true});
  try{assert.match(String(db.prepare('SELECT data FROM projects WHERE id=?').get(projectId)?.data),/Committed WAL project/);}finally{db.close();}
  assert.deepEqual(fs.readFileSync(path.join(directory,'payload',relativePath)),bytes);
  assert.equal(fs.existsSync(path.join(directory,'payload/access-token')),false);assert.equal(fs.existsSync(path.join(directory,'payload/workbench.sqlite-wal')),false);
  assert.deepEqual(f.store.get('projects',projectId),{id:projectId,name:'Committed WAL project'});
});

test('backup queue excludes concurrent mutations and rejects active or unaccounted task state',async t=>{
  const f=fixture(t),projectId=randomUUID();f.store.put('projects',{id:projectId,name:'Busy source'});
  const held=f.runtime.create({requestId:randomUUID()});assert.equal(f.runtime.isBusy(),true);
  assert.throws(()=>f.runtime.assertMutationAllowed(),code('WORKSPACE_BACKUP_BUSY'));
  await assert.rejects(f.runtime.create({requestId:randomUUID()}),code('WORKSPACE_BACKUP_BUSY'));await held;
  const jobId=randomUUID();f.store.put('jobs',{id:jobId,projectId,status:'submission_unknown'});
  await assert.rejects(f.runtime.create({requestId:randomUUID()}),code('WORKSPACE_BACKUP_BUSY'));assert.equal(f.runtime.list().length,1);
  assert.equal(f.runtime.getStatus().lastError,'WORKSPACE_BACKUP_BUSY');
});

test('a same-connection database mutation during online snapshot is rejected without rolling back the user edit',async t=>{
  const f=fixture(t),projectId=randomUUID();f.store.put('projects',{id:projectId,name:'Before'});
  const pending=f.runtime.create({requestId:randomUUID()});await Promise.resolve();f.store.put('projects',{id:projectId,name:'User edit during capture'});
  await assert.rejects(pending,code('WORKSPACE_BACKUP_CHANGED'));
  assert.equal(f.runtime.list().length,0);assert.deepEqual(f.store.get('projects',projectId),{id:projectId,name:'User edit during capture'});
});

test('read-only activity after maintenance admission does not invalidate a stable snapshot',async t=>{
  let checks=0;const f=fixture(t,{isQuiescent:()=>++checks===1});
  const entry=await f.runtime.create({requestId:randomUUID()});assert.equal(f.runtime.list()[0].id,entry.id);assert.equal(checks,1);
});

test('cancelled generation with a paid or remote submission remains a backup and restore blocker',async t=>{
 const f=fixture(t),projectId=randomUUID(),jobId=randomUUID();f.store.put('projects',{id:projectId,name:'Paid result pending'});
 const entry=await f.runtime.create({requestId:randomUUID()});
 for(const patch of [{providerJobId:'remote-original'},{submissionCount:1}]){
  f.store.put('jobs',{id:jobId,projectId,status:'cancelled',...patch});
  await assert.rejects(f.runtime.create({requestId:randomUUID()}),code('WORKSPACE_BACKUP_BUSY'));
  await assert.rejects(f.runtime.stageRestore({requestId:randomUUID(),backupId:entry.id,confirmation:'RESTORE_BACKUP'}),code('WORKSPACE_BACKUP_BUSY'));
 }
 assert.equal(f.runtime.getStatus().pendingRestore,null);assert.equal(f.runtime.list().length,1);
});

test('confirmed restore stages a separate guarded workspace and restart activation never overwrites original data',async t=>{
  const f=fixture(t),projectId=randomUUID();f.store.put('projects',{id:projectId,name:'Saved version'});
  const entry=await f.runtime.create({requestId:randomUUID()}),other=await f.runtime.create({requestId:randomUUID()});f.store.put('projects',{id:projectId,name:'Current original version'});
  const input={requestId:randomUUID(),backupId:entry.id,confirmation:'RESTORE_BACKUP' as const},staged=await f.runtime.stageRestore(input);
  assert.equal(staged.restartRequired,true);assert.deepEqual(await f.runtime.stageRestore(input),staged);
  await assert.rejects(f.runtime.stageRestore({...input,backupId:other.id}),code('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
  assert.equal(f.runtime.getStatus().pendingRestore?.backupId,entry.id);
  assert.deepEqual(f.store.get('projects',projectId),{id:projectId,name:'Current original version'});
  assert.throws(()=>f.runtime.assertMutationAllowed(),code('WORKSPACE_RESTORE_PENDING'));
  const activation=await resolveWorkspaceActivation(f.root);assert.notEqual(activation.root,f.root);assert.equal(activation.restored,true);
  // A second startup may activate the separate root while this original Store
  // is still open. It must never unlock mutations or capture on the old root.
  assert.throws(()=>f.runtime.assertMutationAllowed(),code('WORKSPACE_RESTORE_PENDING'));
  await assert.rejects(f.runtime.create({requestId:randomUUID()}),code('WORKSPACE_RESTORE_PENDING'));
  async function* noUpload(){throw Error('The original workspace must not read an upload after activation');}
  await assert.rejects(f.runtime.importBundle(noUpload(),{requestId:randomUUID()}),code('WORKSPACE_RESTORE_PENDING'));
  const restored=openStore(activation.root);
  try{assert.ok(getWorkspaceRestoreContext(restored));assert.deepEqual(restored.get('projects',projectId),{id:projectId,name:'Saved version'});}finally{restored.close();}
  assert.equal((await resolveWorkspaceActivation(f.root)).root,activation.root);
  assert.deepEqual(f.store.get('projects',projectId),{id:projectId,name:'Current original version'});
});

test('restore refuses unresolved work before creating an activation pointer',async t=>{
  const f=fixture(t),projectId=randomUUID();f.store.put('projects',{id:projectId,name:'Test'});
  const entry=await f.runtime.create({requestId:randomUUID()});f.store.put('jobs',{id:randomUUID(),projectId,status:'running'});
  await assert.rejects(f.runtime.stageRestore({requestId:randomUUID(),backupId:entry.id,confirmation:'RESTORE_BACKUP'}),code('WORKSPACE_BACKUP_BUSY'));
  assert.equal(f.runtime.getStatus().pendingRestore,null);assert.equal((await resolveWorkspaceActivation(f.root)).root,f.root);
});

test('automatic backup has a real persisted due time, only runs idle, and stop/drain prevents further scheduling',async t=>{
  let clock=Date.parse('2026-10-20T00:00:00Z'),idle=true;const f=fixture(t,{now:()=>clock,isQuiescent:()=>idle});
  f.configuration.set({expectedRevision:0,automaticBackup:true,backupIntervalHours:1});f.runtime.start();
  const due=f.runtime.getStatus().nextBackupAt;assert.equal(due,'2026-10-20T01:00:00.000Z');
  clock+=3600_001;idle=false;await f.runtime.tick();assert.equal(f.runtime.list().length,0);assert.equal(f.runtime.getStatus().nextBackupAt,due);
  idle=true;await f.runtime.tick();assert.equal(f.runtime.list().length,1);assert.equal(f.runtime.list()[0].trigger,'automatic');
  assert.ok(Date.parse(f.runtime.getStatus().nextBackupAt!)>clock);f.runtime.stop();await f.runtime.drain();clock+=7200_000;await f.runtime.tick();assert.equal(f.runtime.list().length,1);
});

test('bounded browser transfer keeps original format1 bytes and imports under a server-generated ID without accepting a path',async t=>{
  const f=fixture(t),entry=await f.runtime.create({requestId:randomUUID()}),chunks:Buffer[]=[];
  for await(const chunk of f.runtime.exportBundle(entry.id))chunks.push(Buffer.from(chunk));
  const bytes=Buffer.concat(chunks);
  async function* source(){let offset=0;while(offset<bytes.length){const width=offset<80?1:4093;yield bytes.subarray(offset,offset+width);offset+=width;}}
  const input={requestId:randomUUID()},imported=await f.runtime.importBundle(source(),input);
  assert.equal(imported.trigger,'import');assert.notEqual(imported.id,entry.id);assert.equal(imported.payloadBytes,entry.payloadBytes);
  assert.deepEqual(await f.runtime.importBundle(source(),input),imported);
  const first=path.join(f.configuration.get().backupDirectory,entry.id),second=path.join(f.configuration.get().backupDirectory,imported.id);
  assert.deepEqual(fs.readFileSync(path.join(first,'manifest.json')),fs.readFileSync(path.join(second,'manifest.json')));
  assert.deepEqual(fs.readFileSync(path.join(first,'payload/workbench.sqlite')),fs.readFileSync(path.join(second,'payload/workbench.sqlite')));
});

test('request keys replay only the original backup operation and trigger',async t=>{
  const f=fixture(t),manual={requestId:randomUUID()},entry=await f.runtime.create(manual),chunks:Buffer[]=[];
  for await(const chunk of f.runtime.exportBundle(entry.id))chunks.push(Buffer.from(chunk));
  async function* source(){yield* chunks;}
  await assert.rejects(f.runtime.importBundle(source(),manual),code('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.runtime.create(manual,'automatic'),code('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
  const importedInput={requestId:randomUUID()},imported=await f.runtime.importBundle(source(),importedInput);
  await assert.rejects(f.runtime.create(importedInput),code('WORKSPACE_BACKUP_IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await f.runtime.create(manual),entry);
  assert.deepEqual(await f.runtime.importBundle(source(),importedInput),imported);
  assert.equal(f.runtime.list().length,2);
});

test('backup uploads reject traversal, links/arbitrary names, oversized headers and trailing bytes',async t=>{
  const f=fixture(t),magic=Buffer.from('MIOON-BACKUP-BUNDLE-1\n');
  const header=(name:string,bytes:number)=>{const body=Buffer.from(JSON.stringify({path:name,bytes})),length=Buffer.alloc(4);length.writeUInt32BE(body.length);return Buffer.concat([length,body]);};
  for(const [index,body] of [Buffer.concat([magic,header('../escape',0)]),Buffer.concat([magic,header('payload/access-token',0)]),Buffer.concat([magic,header('/etc/passwd',0)]),Buffer.concat([magic,Buffer.from([0,0,8,0])])].entries()){
    const destination=path.join(f.base,`invalid-${index}`);fs.mkdirSync(destination,{mode:0o700});
    async function* source(){yield body;}
    await assert.rejects(importWorkspaceBackupBundle({source:source(),destination}),code('WORKSPACE_BACKUP_BUNDLE_INVALID'));
    assert.equal(fs.existsSync(path.join(f.base,'escape')),false);
  }
  const entry=await f.runtime.create({requestId:randomUUID()}),parts:Buffer[]=[];for await(const part of f.runtime.exportBundle(entry.id))parts.push(Buffer.from(part));
  async function* extra(){yield* parts;yield Buffer.from('trailing data');}
  await assert.rejects(f.runtime.importBundle(extra(),{requestId:randomUUID()}),code('WORKSPACE_BACKUP_BUNDLE_INVALID'));
  assert.equal(f.runtime.list().length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {restoreFixture,tree,runRestoreChild} from './helpers/workspace-restore-offline-fixture.ts';
import {validateWorkspaceStorage} from '../packages/business/src/db.ts';
import {validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.ts';
import type { WorkspaceBackupResult } from '@mioon/business/workspace-backup';
const crashPoints=['raw_copy','schema_ddl','identity','schema_commit','checkpoint','candidate_sync','media_sync','before_activation','between_link_unlink','after_activation','directory_sync','ack_loss'];
async function inject(t: unknown,f: Awaited<ReturnType<typeof restoreFixture>>,point: string){
 const file=path.join((f.base as unknown as Parameters<typeof path.join>[0]),`fault-${point}.ts`),helper=new URL('./helpers/workspace-restore-fault-preload.mjs',import.meta.url).href;
 fs.writeFileSync(file,`globalThis.__restoreFault=${JSON.stringify({point,destination:f.destination,backup:f.backup,payload:f.relativePath})};await import(${JSON.stringify(helper)});`,{mode:0o600});
 return (runRestoreChild(t,['restore','--directory',f.backup,'--destination',f.destination],{preload:file}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').ChildOutcome>);
}
for(const point of crashPoints)test(`offline restore crash at ${point} never publishes raw schema24 and preserves original bytes/modes`,async t=>{
 const f=await restoreFixture(t,{stages:false}),sourceBefore=tree(f.source),backupBefore=tree(f.backup),result=await inject(t,f,point);
 assert.equal(result.code,77,result.stdout+result.stderr);
 const runtime=path.join(f.destination,'workbench.sqlite'),activated=['between_link_unlink','after_activation','directory_sync','ack_loss'].includes(point);
 assert.equal(fs.existsSync(runtime),activated);
 if(activated){
  // The copied single-link file proves the legacy barrier without repairing a
  // crashed destination, removing its lock, or weakening storage link policy.
  const proof=path.join(f.base,'proof.sqlite');fs.copyFileSync(runtime,proof);const db=new DatabaseSync(proof);try{
   assert.equal((validateWorkspaceRestoreSchema(db) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata).schemaVersion,25);assert.throws(()=>db.exec('INSERT OR IGNORE INTO schema_version VALUES(1)'),/RESTORE_LEGACY_RUNTIME_BLOCKED/);
  }finally{db.close();}
  if(point==='between_link_unlink'){assert.equal(fs.statSync(runtime).nlink,2);assert.throws(()=>validateWorkspaceStorage(f.destination),{code:'STORAGE_PRIVATE_REQUIRED'});}
  else assert.equal(fs.statSync(runtime).nlink,1);
 }
 if(['ack_loss','between_link_unlink','before_activation'].includes(point)){
  const targetBefore=tree(f.destination),status=await (runRestoreChild(t,['restore-status','--directory',f.backup,'--destination',f.destination]) as Promise<import('./helpers/strict-workspace-boundary-types.ts').ChildOutcome>),body=JSON.parse((status.stdout as string));
  if(point==='ack_loss'){
   assert.equal(result.stdout,'','the restore identity was completely lost');assert.equal(status.code,0,status.stderr);assert.equal(body.data.publication,'observed_guarded');assert.equal(body.data.durability,'not_reconfirmed');assert.match(body.data.restorationId,/^[a-f0-9-]{36}$/);
  }else{assert.equal(status.code,1);assert.equal(body.error.code,'WORKSPACE_RESTORE_STATUS_UNAVAILABLE');}
  assert.deepEqual(tree(f.destination),targetBefore,'observation never repairs candidate, lock, links or final bytes');
 }
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
});

for(const point of ['directory_fsync_error','link_ack_error'] as const)test(`publication ${point} is precise unknown, keeps guarded output, and never claims rollback`,async t=>{
 const f=await restoreFixture(t,{stages:false}),sourceBefore=tree(f.source),backupBefore=tree(f.backup),result=await inject(t,f,point),body=JSON.parse((result.stdout as string));
 assert.equal(result.code,1);assert.equal(body.error.code,'WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED');assert.equal(body.error.details.publication.state,'unconfirmed');assert.ok(!result.stdout.includes('SYNTHETIC_PRIVATE_ERROR'));
 const runtime=path.join(f.destination,'workbench.sqlite');assert.equal(fs.existsSync(runtime),true);
 if(point==='directory_fsync_error'){
  const status=await (inspectWorkspaceRestorePublication({destination:f.destination,...body.error.details.publication}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreStatus>);assert.equal(status.publication,'observed_guarded');assert.equal(status.durability,'not_reconfirmed');
 }else{
  assert.equal(fs.statSync(runtime).nlink,2);await assert.rejects((inspectWorkspaceRestorePublication({destination:f.destination,...body.error.details.publication}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreStatus>),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
 }
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
});

for(const point of ['collision','cancel_before','cancel_after','replace_lock','replace_source','unknown_destination'] as const)test(`offline publication safely handles ${point}`,async t=>{
 const f=await restoreFixture(t,{stages:false}),sourceBefore=tree(f.source),backupBefore=tree(f.backup),result=await inject(t,f,point),body=JSON.parse((result.stdout as string)),runtime=path.join(f.destination,'workbench.sqlite');
 if(point==='cancel_after'||point==='replace_lock'){
  assert.equal(result.code,0,result.stdout+result.stderr);assert.equal(body.data.publication,'confirmed');assert.equal(fs.statSync(runtime).nlink,1);
  if(point==='replace_lock'){assert.deepEqual(body.data.warnings,['DESTINATION_LOCK_RELEASE_UNCONFIRMED']);assert.equal(fs.readFileSync(path.join(f.destination,'server.lock'),'utf8'),'unknown-lock-owner');}
 }else{
  const expected={collision:'DESTINATION_EXISTS',cancel_before:'CANCELLED',replace_source:'CHANGED',unknown_destination:'CHANGED'}[point];
  assert.equal(body.error.code,`WORKSPACE_RESTORE_${expected}`,result.stdout+result.stderr);assert.equal(result.code,point==='cancel_before'?143:1);
  if(point==='collision')assert.equal(fs.readFileSync(runtime,'utf8'),'RACE_WINNER');else assert.equal(fs.existsSync(runtime),false);
  if(point==='unknown_destination')assert.equal(fs.readFileSync(path.join(f.destination,'unknown-owner.txt'),'utf8'),'must-remain');
  assert.equal(fs.existsSync(f.destination),true,'partial target retained');
 }
 assert.deepEqual(tree(f.source),sourceBefore);if(point!=='replace_source')assert.deepEqual(tree(f.backup),backupBefore);
});

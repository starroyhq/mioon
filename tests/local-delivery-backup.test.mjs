/** Actual offline backup/restore boundary for the private delivery companion.
 * Reopens the established offline fixture through the current runtime; no hand-made restoration
 * marker, fake database, server, media worker or external provider is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {schemas,isTimelineMutationResponse,hasRequestNotAppliedProof,publicValue} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';
import {createLocalDelivery,LOCAL_DELIVERY_FILENAME} from '../packages/business/src/local-delivery.ts';
import {createTimelineRecoveryBoundary,readTimelineReceipt} from '../packages/business/src/timeline-recovery.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {restoreFixture,tree,logical} from './helpers/workspace-restore-offline-fixture.mjs';

const authority=value=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId});
const action=value=>({...authority(value),intentId:value.intent.intentId,expectedIntentRevision:value.intentRevision});
function deliveryFor(store,services){
 const calls={storage:0,ownsLock:0,readTimeline:0,readReceipt:0,render:0};
 const storage=Object.fromEntries(Object.entries({readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile}).map(([name,fn])=>[name,(...args)=>{calls.storage++;return fn(...args);}])) ;
 const delivery=createLocalDelivery({root:store.root,storage,guards:{
  isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),ownsLock:()=>{calls.ownsLock++;return ownsStoreLock(store);},
  readTimeline:projectId=>{calls.readTimeline++;return createTimelineRecoveryBoundary(store.db,{projectId}).read({sourceSemantics:false});},
  isRenderInput:value=>schemas['timeline.render'].safeParse(value).success,
  isRenderResponse:(input,value)=>isTimelineMutationResponse('timeline.render',input,value),
  isNotApplied:(input,error)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
  readReceipt:input=>{calls.readReceipt++;const saved=readTimelineReceipt(store.db,input,'timeline.render');if(!saved)return null;
   assert.equal(saved.requestHash,hash({operation:'timeline.render',input}));return publicValue(createTimelineRecoveryBoundary(store.db,input).replay('timeline.render',saved.response));},
  render:input=>{calls.render++;return services.call('timeline.render',input);},
 }});return {delivery,calls};
}

test('actual cold backup excludes delivery draft, immutable intent and atomic temp; actual restored profile cannot read or write them',{timeout:30000},async t=>{
 const f=await restoreFixture(t,{stages:false}),source=openStore(f.source),services=createServices(source,new Map());
 let prepared,putInput,prepareInput,project,timeline;
 try{
  project=await services.call('project.create',{name:'Synthetic local-only delivery backup boundary'});
  timeline=await services.call('timeline.get',{projectId:project.id});
  const {delivery,calls}=deliveryFor(source,services),empty=delivery.get({projectId:project.id}),before=logical(source.db);
  putInput={...authority(empty),expectedDraftRevision:0,draftId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,raw:{deliveryName:'EXCLUDED_LOCAL_DELIVERY_TITLE_界_🙂'}};
  const draft=delivery.put(putInput);
  prepareInput={...authority(draft),expectedIntentRevision:0,expectedIntentId:null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,
   draft:{draftId:draft.draft.draftId,revision:draft.draftRevision,raw:draft.draft.raw},
   input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',deliveryName:draft.draft.raw.deliveryName}};
  prepared=delivery.prepare(prepareInput);assert.equal(prepared.intent.outcome.status,'pending');assert.equal(calls.render,0);
  assert.deepEqual(logical(source.db),before,'Draft and preparation must not modify any business SQL record');
 }finally{await services.drain();source.close();}
 const sidecar=path.join(f.source,LOCAL_DELIVERY_FILENAME),bytes=fs.readFileSync(sidecar);
 assert.equal(JSON.parse(bytes).entries[0].intent.input.requestId,prepared.intent.input.requestId);
 assert.equal(fs.statSync(sidecar).mode&0o777,0o600);
 // Exact atomic companion spelling, containing only this fixture's own data.
 const temporary=`.${LOCAL_DELIVERY_FILENAME}.${randomBytes(16).toString('hex')}.tmp`;
 fs.writeFileSync(path.join(f.source,temporary),bytes,{mode:0o600,flag:'wx'});
 const sourceBefore=tree(f.source),originalBackupBefore=tree(f.backup),backup=path.join(f.base,'with-local-delivery-backup');
 const created=await createWorkspaceBackup({source:f.source,destination:backup});
 assert.equal(created.integrity,'verified');assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
 assert.ok(manifest.entries.some(entry=>entry.path==='payload/workbench.sqlite'));
 assert.equal(manifest.entries.some(entry=>entry.path.includes('local-delivery')),false);
 assert.equal(tree(backup).some(([relative])=>relative.includes('local-delivery')),false);
 assert.deepEqual(fs.readFileSync(path.join(backup,'payload/workbench.sqlite')),fs.readFileSync(path.join(f.source,'workbench.sqlite')));
 assert.deepEqual(tree(f.source),sourceBefore,'Backup and verify must preserve all source bytes and modes, including excluded files');
 assert.deepEqual(tree(f.backup),originalBackupBefore);
 const backupBefore=tree(backup),restored=await restoreWorkspaceBackup({directory:backup,destination:f.destination});
 assert.equal(restored.publication,'confirmed');assert.equal(restored.databaseSchemaVersion,27);
 assert.equal(fs.existsSync(path.join(f.destination,LOCAL_DELIVERY_FILENAME)),false);assert.equal(fs.existsSync(path.join(f.destination,temporary)),false);
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
 const restoredStore=openStore(f.destination),restoredServices=createServices(restoredStore,new Map());
 try{
  assert.equal(getWorkspaceRestoreContext(restoredStore).workspaceOrigin,restored.workspaceOrigin);
  const {delivery,calls}=deliveryFor(restoredStore,restoredServices),before=logical(restoredStore.db),destinationBefore=tree(f.destination);
  const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(delivery.get({projectId:project.id}),unsupported);
  // A restored companion is explicitly unsupported, not silently re-created or
  // dispatched. Retained ordinary-workspace authority cannot enable a write.
  assert.deepEqual(delivery.put(putInput),unsupported);
  assert.deepEqual(delivery.discard({...authority(prepared),expectedDraftRevision:prepared.draftRevision,draftId:prepared.draft.draftId}),unsupported);
  assert.deepEqual(delivery.prepare(prepareInput),unsupported);
  for(const method of ['execute','recover'])assert.deepEqual(await delivery[method](action(prepared)),{envelope:unsupported,response:null});
  assert.deepEqual(calls,{storage:0,ownsLock:0,readTimeline:0,readReceipt:0,render:0});
  assert.deepEqual(logical(restoredStore.db),before);assert.deepEqual(tree(f.destination),destinationBefore);
  assert.equal(fs.existsSync(path.join(f.destination,LOCAL_DELIVERY_FILENAME)),false);
  assert.equal(fs.readdirSync(f.destination).some(name=>name.includes('local-delivery')),false);
 }finally{await restoredServices.drain();restoredStore.close();}
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);assert.deepEqual(tree(f.backup),originalBackupBefore);
 assert.deepEqual(fs.readFileSync(sidecar),bytes);assert.equal(fs.statSync(sidecar).mode&0o777,0o600);assert.equal(fs.statSync(path.join(f.source,temporary)).mode&0o777,0o600);
});

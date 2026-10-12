/** Real offline create/verify/restore boundary for private shot text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {LOCAL_SHOT_TEXT_FILENAME} from '../packages/business/src/local-shot-text.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {restoreFixture,tree,logical} from './helpers/workspace-restore-offline-fixture.mjs';
import {shotTextForStore} from './fixtures/local-shot-text-process-worker.mjs';
const authority=value=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId,shotId:value.shotId});
const action=value=>({...authority(value),intentId:value.intent.intentId,expectedIntentRevision:value.intentRevision});
test('cold backup excludes shot draft, intent and atomic temp; restored profile rejects them before all I/O',{timeout:30000},async t=>{
 const f=await restoreFixture(t,{stages:false}),source=openStore(f.source),services=createServices(source,new Map());let prepared,putInput,prepareInput,project,shot;
 try{project=await services.call('project.create',{name:'Synthetic local-only shot backup'});shot=await services.call('shot.create',{projectId:project.id,title:'Saved original',prompt:'Original baseline'});
  const {local,calls}=shotTextForStore(source,services),empty=local.get({projectId:project.id,shotId:shot.id}),before=logical(source.db);
  putInput={...authority(empty),expectedDraftRevision:0,draftId:randomUUID(),baseRevision:shot.revision,baseText:{title:shot.title,prompt:shot.prompt},raw:{title:'EXCLUDED_LOCAL_SHOT_TITLE_界_🙂',prompt:'EXCLUDED_LOCAL_SHOT_PROMPT_界_🙂\nOriginal raw text'}};
  const draft=local.put(putInput);prepareInput={...authority(draft),expectedIntentRevision:0,expectedIntentId:null,intentId:randomUUID(),baseRevision:shot.revision,baseText:draft.draft.baseText,draft:{draftId:draft.draft.draftId,revision:draft.draftRevision,raw:draft.draft.raw},input:{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),patch:draft.draft.raw}};
  prepared=local.prepare(prepareInput);assert.equal(prepared.intent.outcome.status,'pending');assert.equal(calls.update,0);assert.deepEqual(logical(source.db),before);
 }finally{await services.drain();source.close();}
 const sidecar=path.join(f.source,LOCAL_SHOT_TEXT_FILENAME),bytes=fs.readFileSync(sidecar);assert.equal(JSON.parse(bytes).entries[0].intent.input.requestId,prepared.intent.input.requestId);assert.equal(fs.statSync(sidecar).mode&0o777,0o600);
 const temporary=`.${LOCAL_SHOT_TEXT_FILENAME}.${randomBytes(16).toString('hex')}.tmp`;fs.writeFileSync(path.join(f.source,temporary),bytes,{mode:0o600,flag:'wx'});
 const sourceBefore=tree(f.source),originalBackupBefore=tree(f.backup),backup=path.join(f.base,'with-local-shot-text-backup'),created=await createWorkspaceBackup({source:f.source,destination:backup});assert.equal(created.integrity,'verified');assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));assert.ok(manifest.entries.some(entry=>entry.path==='payload/workbench.sqlite'));assert.equal(manifest.entries.some(entry=>entry.path.includes('local-shot-text')),false);assert.equal(tree(backup).some(([relative])=>relative.includes('local-shot-text')),false);assert.deepEqual(fs.readFileSync(path.join(backup,'payload/workbench.sqlite')),fs.readFileSync(path.join(f.source,'workbench.sqlite')));assert.deepEqual(tree(f.source),sourceBefore,'Every source byte and mode must remain identical');assert.deepEqual(tree(f.backup),originalBackupBefore);
 const backupBefore=tree(backup),restored=await restoreWorkspaceBackup({directory:backup,destination:f.destination});assert.equal(restored.publication,'confirmed');assert.equal(restored.databaseSchemaVersion,25);assert.equal(fs.existsSync(path.join(f.destination,LOCAL_SHOT_TEXT_FILENAME)),false);assert.equal(fs.existsSync(path.join(f.destination,temporary)),false);assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
 const restoredStore=openStore(f.destination),restoredServices=createServices(restoredStore,new Map());try{assert.equal(getWorkspaceRestoreContext(restoredStore).workspaceOrigin,restored.workspaceOrigin);const {local,calls}=shotTextForStore(restoredStore,restoredServices),before=logical(restoredStore.db),destinationBefore=tree(f.destination),unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(local.get({projectId:project.id,shotId:shot.id}),unsupported);assert.deepEqual(local.put(putInput),unsupported);assert.deepEqual(local.discard({...authority(prepared),expectedDraftRevision:prepared.draftRevision,draftId:prepared.draft.draftId}),unsupported);assert.deepEqual(local.prepare(prepareInput),unsupported);for(const method of ['execute','recover'])assert.deepEqual(await local[method](action(prepared)),{envelope:unsupported,response:null});assert.deepEqual(calls,{storage:0,ownsLock:0,readShot:0,readReceipt:0,update:0});assert.deepEqual(logical(restoredStore.db),before);assert.deepEqual(tree(f.destination),destinationBefore);assert.equal(fs.readdirSync(f.destination).some(name=>name.includes('local-shot-text')),false);
 }finally{await restoredServices.drain();restoredStore.close();}
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);assert.deepEqual(tree(f.backup),originalBackupBefore);assert.deepEqual(fs.readFileSync(sidecar),bytes);assert.equal(fs.statSync(sidecar).mode&0o777,0o600);assert.equal(fs.statSync(path.join(f.source,temporary)).mode&0o777,0o600);
});

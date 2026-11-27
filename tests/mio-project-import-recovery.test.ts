import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {readMioProjectImportDependencies} from '../packages/business/src/agent/mio-project-import-dependencies.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {storeManualVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {applySequenceEditHistory, readSequenceEditHistory} from '../packages/business/src/sequence-edit.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {MIO_PROJECT_FILE_IMPORT_TOOL,MIO_PROJECT_FILE_IMPORT_OPERATION,mioProjectFileImportResultSchema} from '../packages/contracts/src/mio-project-import.ts';
import {protocols,object,fixture,plan,imports,receipts} from './helpers/mio-project-import-tools-fixture.ts';

for(const protocol of protocols)test(protocol+': a direct import creates exactly one atomic Change and replays only retained records',async t=>{
  const f=await fixture(t,protocol),importCall=plan(f,protocol),beforeSource=readFileSync(f.source),beforeStat=lstatSync(f.source,{bigint:true});
  const done=await f.settle((await f.send()).run.id);assert.equal(done.run.status,'completed');
  const step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);assert.equal(step.status,'completed');
  const result=mioProjectFileImportResultSchema.parse(step.result);assert.equal(result.registration,'created');assert.equal(imports(f).length,1);assert.equal(f.creations.length,1);
  const changes=done.changes.filter(change=>change.stepId===step.id);assert.equal(changes.length,1);assert.equal(changes[0]?.operation,MIO_PROJECT_FILE_IMPORT_OPERATION);assert.equal(changes[0]?.reversible,true);
  assert.deepEqual(changes[0]?.targets.map(target=>[target.kind,target.id]),[['asset',result.assetId]]);
  assert.ok(f.prepares.every(item=>item.requestId===step.id));assert.equal(f.executions.length,1);
  assert.deepEqual(readFileSync(f.source),beforeSource);assert.equal(lstatSync(f.source,{bigint:true}).mtimeNs,beforeStat.mtimeNs);
  assert.ok(!sourceTaskModelToolNames(protocol,{body:f.requests[0]!.body}).includes(MIO_PROJECT_FILE_IMPORT_TOOL));assert.ok(sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes(MIO_PROJECT_FILE_IMPORT_TOOL));
  assert.ok(!JSON.stringify(done).includes(f.root));for(const request of f.requests)assert.ok(!request.body.includes(f.root));
  const ids=done.steps.filter(item=>item.kind==='model').map(item=>item.id),sent=f.requests.map(request=>request.body),prepares=f.prepares.length,executions=f.executions.length;
  unlinkSync(f.source);await f.reopen();
  const records=createMioRecords(f.store),assembly=createMioAssembly(records),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  for(const [index,id]of ids.entries()){const saved=records.request(records.step(id).currentRequestId!);assert.equal(saved.originalBody,null);assert.equal(object(assembly.hydrate(saved)).body,sent[index]);}
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(f.prepares.length,prepares);assert.equal(f.executions.length,executions);
});

test('an already registered original request returns reused without claiming a creation or undo right',async t=>{
  const f=await fixture(t);f.reuseNext();const importCall=plan(f,'responses'),done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  assert.equal(step.status,'completed');assert.equal(mioProjectFileImportResultSchema.parse(step.result).registration,'reused');assert.equal(imports(f).length,1);assert.equal(f.creations.length,0);assert.equal(done.changes.length,0);
  const original=f.executions[0];assert.ok(original);const before=receipts(f),asset=structuredClone(imports(f)[0]);unlinkSync(f.source);
  const replay=await f.port.execute(original,{beforeEffect(){},recordCreatedInside(){assert.fail('Reusing a prior row cannot grant creation ownership');}});
  assert.equal(replay.disposition,'reused');assert.deepEqual(imports(f),[asset]);assert.deepEqual(receipts(f),before);assert.equal(f.runtime.get(f.projectId,done.run.id).changes.length,0);
});

test('unknown before effect is resolved only through the original step request and never blind retry',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failBeforeExecute();const done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);
  assert.equal(step.status,'unknown');assert.equal(done.run.pauseReason,'unknown_outcome');assert.equal(imports(f).length,0);
  await assert.rejects(f.action(done,'retry',{stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.executions.length,1);
  const current=f.runtime.get(f.projectId,done.run.id);await f.action(current,'resolve_unknown',{stepId:step.id,resolution:'discard'});const after=f.runtime.get(f.projectId,done.run.id);
  assert.equal(after.steps.find(item=>item.id===step.id)?.status,'failed');assert.equal(f.lookups.length,1);assert.deepEqual(f.lookups[0],f.executions[0]);assert.equal(imports(f).length,0);assert.equal(f.executions.length,1);
});

test('an unprovable original receipt remains unknown across reopening and cannot be discarded or retried',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failBeforeExecute();const done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);assert.equal(step.status,'unknown');
  const directory=path.join(f.store.tempDir,'asset-imports');mkdirSync(directory,{recursive:true,mode:0o700});const receipt=path.join(directory,createHash('sha256').update(step.id).digest('hex')+'.json');writeFileSync(receipt,'{"version":1}',{mode:0o600});
  const before=readFileSync(receipt);unlinkSync(f.source);await f.reopen();
  for(const resolution of ['discard','accept_result']){const current=f.runtime.get(f.projectId,done.run.id);await assert.rejects(f.action(current,'resolve_unknown',{stepId:step.id,resolution}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.runtime.get(f.projectId,done.run.id).steps.find(item=>item.id===step.id)?.status,'unknown');}
  await assert.rejects(f.action(f.runtime.get(f.projectId,done.run.id),'retry',{stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.executions.length,1);assert.equal(imports(f).length,0);assert.deepEqual(readFileSync(receipt),before);assert.ok(f.lookups.length>=1);assert.ok(f.lookups.every(proof=>JSON.stringify(proof)===JSON.stringify(f.executions[0])));
});

for(const outcome of ['applied','retired'] as const)test('an unknown '+outcome+' original registration is observed without recreating ownership after reopening',async t=>{
  const f=await fixture(t);f.reuseNext();f.failAfterExecute();const importCall=plan(f,'responses'),done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  assert.equal(step.status,'unknown');assert.equal(done.changes.length,0);assert.equal(f.creations.length,0);const asset=object(imports(f)[0]);assert.ok(typeof asset.id==='string');const assetId=asset.id;
  if(outcome==='retired')f.store.tx(()=>f.store.db.prepare('DELETE FROM assets WHERE id=?').run(assetId));
  const before=receipts(f);unlinkSync(f.source);await f.reopen();
  await f.action(f.runtime.get(f.projectId,done.run.id),'resolve_unknown',{stepId:step.id,resolution:'accept_result'});
  const resolved=f.runtime.get(f.projectId,done.run.id),saved=resolved.steps.find(item=>item.id===step.id);assert.ok(saved);
  if(outcome==='applied'){assert.equal(saved.status,'completed');const result=mioProjectFileImportResultSchema.parse(saved.result);assert.equal(result.registration,'reused');assert.equal(result.assetId,assetId);assert.equal(imports(f).length,1);}
  else{assert.equal(saved.status,'failed');assert.equal(saved.error?.code,'PROJECT_IMPORT_RETIRED');assert.equal(imports(f).length,0);}
  assert.equal(resolved.changes.length,0);assert.equal(f.executions.length,1);assert.equal(f.creations.length,0);assert.equal(f.lookups.length,1);assert.deepEqual(f.lookups[0],f.executions[0]);assert.deepEqual(receipts(f),before);assert.equal(existsSync(f.source),false);assert.ok(!JSON.stringify(resolved).includes(f.root));
});

test('a lost acknowledgement after atomic registration cannot duplicate the asset or Change',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failAfterExecute();const sent=await f.send();await f.runtime.drain();const done=f.runtime.get(f.projectId,sent.run.id),step=done.steps.find(item=>item.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL);assert.ok(step);
  assert.equal(step.status,'completed');assert.equal(imports(f).length,1);assert.equal(done.changes.filter(change=>change.stepId===step.id).length,1);assert.equal(f.creations.length,1);
  const before=receipts(f);await f.reopen();const reopened=f.runtime.get(f.projectId,sent.run.id);assert.equal(reopened.steps.find(item=>item.id===step.id)?.status,'completed');assert.equal(imports(f).length,1);assert.equal(reopened.changes.filter(change=>change.stepId===step.id).length,1);assert.deepEqual(receipts(f),before);
});

test('a journal failure rolls back asset registration and its unique Change together',async t=>{
  const f=await fixture(t);plan(f,'responses');f.failRecord();const sent=await f.send();await f.runtime.drain();
  assert.equal(imports(f).length,0);assert.equal(f.runtime.journal.snapshot(sent.run.id).changes.length,0);assert.equal(f.creations.length,1);
});

test('dedicated compensation removes only the untouched row and cannot revive its original request',async t=>{
  const f=await fixture(t);plan(f,'responses');const done=await f.settle((await f.send()).run.id),change=done.changes.find(item=>item.operation===MIO_PROJECT_FILE_IMPORT_OPERATION);assert.ok(change);
  const step=done.steps.find(item=>item.id===change.stepId);assert.ok(step);const original=f.executions[0];assert.ok(original);const before=receipts(f);
  const requestId=randomUUID();unlinkSync(f.source);await f.action(done,'undo_change',{changeId:change.id,requestId});const reverted=f.runtime.get(f.projectId,done.run.id);
  assert.equal(imports(f).length,0);assert.equal(reverted.changes.find(item=>item.id===change.id)?.status,'reverted');assert.deepEqual(receipts(f),before);assert.equal(existsSync(f.source),false);
  assert.equal(object(f.runtime.journal.lookupControl(requestId)?.result).state,'completed');
  await assert.rejects(f.port.execute(original,{beforeEffect(){},recordCreatedInside(){assert.fail('A retired request must not create an asset');}}));
  const lookup=await f.port.lookup(original,{beforeEffect(){}});assert.equal(lookup.outcome,'retired');lookup.assertCurrent();
  assert.equal(imports(f).length,0);assert.deepEqual(receipts(f),before);assert.equal(f.creations.length,1);
});

test('native import undo requires no live or restorable clip reference and retains the source file', async t => {
  const f = await fixture(t, 'responses', {targetFormat: FORMAT5_PROJECT_SCHEMA_VERSION});
  const createdAt = new Date().toISOString(), sequenceNodeId = randomUUID();
  const template = newTimelineRecord(f.projectId, {fps: 30, width: 1080, height: 1920}, () => createdAt);
  f.store.tx(() => {
    f.store.put('nodes', {id: sequenceNodeId, projectId: f.projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt});
    f.store.put('timelines', {...template, mainTrack: {trackId: template.tracks[0]!.id, sequenceNodeId}});
    f.store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,1,?)')
      .run(template.id, f.projectId, sequenceNodeId, JSON.stringify({version: 1, board: [], track: []}));
  });
  const edit = async (operation: string, action: Record<string, unknown>) => {
    const {envelope, planDigest} = object(await f.services.call(operation, {projectId: f.projectId, ...action}));
    const receipt = object(await f.services.call('sequence.action.commit', {projectId: f.projectId, envelope, expectedPlanDigest: planDigest}));
    assert.equal(receipt.status, 'applied');
  };
  await edit('sequence.board.edit', {kind: 'board-shot-append', name: 'Unrelated placeholder'});
  await edit('sequence.timeline.edit', {kind: 'track-add', trackKind: 'video', name: 'Overlay'});
  f.store.tx(() => {
    const beforeImport = captureProjectDocumentInside(f.store);
    storeManualVersionInside(f.store.db, f.projectId, 'Before import', beforeImport.evidence.contentSequence, encodeProjectDocument(beforeImport));
  });
  plan(f, 'responses');
  const done = await f.settle((await f.send()).run.id);
  const current = () => f.runtime.get(f.projectId, done.run.id);
  const change = () => current().changes.find(item => item.operation === MIO_PROJECT_FILE_IMPORT_OPERATION)!;
  const assetId = change().targets[0]!.id;
  const proof = () => readMioProjectImportDependencies(f.store, assetId);
  const timeline = () => readFormat5TimelineRecord(f.store.db, 'project')!;
  assert.deepEqual(proof(), {status: 'clear'});
  assert.equal(change().undoDisposition, 'undo');

  const overlay = timeline().tracks.find(item => item.name === 'Overlay');
  assert.ok(overlay);
  await edit('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: overlay.id, startFrame: 0});
  assert.ok(timeline().clips.some(item => item.assetId === assetId && item.trackId === overlay.id));
  assert.deepEqual(proof(), {status: 'referenced', source: 'project.timeline_clips.data'});
  await assert.rejects(f.action(current(), 'undo_change', {changeId: change().id}), {code: 'AGENT_TASK_TARGET_CHANGED'});

  const history = readSequenceEditHistory(f.store);
  assert.ok(history.undo);
  assert.equal(applySequenceEditHistory(f.store, 'undo', {projectId: f.projectId, origin: 'user',
    requestId: randomUUID(), actionId: history.undo.actionId,
    expected: {position: history.position, revision: history.revision}}).status, 'applied');
  assert.ok(!timeline().clips.some(item => item.assetId === assetId));
  assert.deepEqual(proof(), {status: 'referenced', source: 'main.editor_history_entries.afterPatch'});
  assert.equal(change().undoDisposition, 'blocked');
  await assert.rejects(f.action(current(), 'undo_change', {changeId: change().id}), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.ok(f.store.get('assets', assetId));

  // An unrelated edit discards that redo branch. Its receipt is retained,
  // but carries no restorable clip data.
  await edit('sequence.timeline.edit', {kind: 'track-update', trackId: overlay.id, patch: {name: 'Renamed overlay'}});
  assert.deepEqual(proof(), {status: 'clear'});
  await f.action(current(), 'undo_change', {changeId: change().id});
  assert.equal(change().status, 'reverted');
  assert.equal(f.store.get('assets', assetId), null);
  assert.deepEqual(readFileSync(f.source), f.sourceBytes);
});

for(const obstacle of ['claim','modified','consumer'] as const)test('compensation preserves an imported row with a later '+obstacle,async t=>{
  const f=await fixture(t);plan(f,'responses');const done=await f.settle((await f.send()).run.id),change=done.changes.find(item=>item.operation===MIO_PROJECT_FILE_IMPORT_OPERATION);assert.ok(change);const target=change.targets[0];assert.ok(target);
  if(obstacle==='claim')f.runtime.journal.claim({projectId:f.projectId,ownerId:'import-review-draft',targets:[{...target,revision:f.runtime.journal.targetRevision(f.projectId,'asset',target.id)}]});
  else if(obstacle==='modified'){const asset=f.store.get('assets',target.id);assert.ok(asset);f.store.put('assets',{...asset,name:'Later manual name'});}
  else await f.services.call('asset.annotation.set',{projectId:f.projectId,requestId:randomUUID(),assetId:target.id,expectedRevision:0,tags:['Keep'],note:'A manual consumer'});
  const asset=structuredClone(f.store.get('assets',target.id)),before=receipts(f),current=f.runtime.get(f.projectId,done.run.id);
  await assert.rejects(f.action(current,'undo_change',{changeId:change.id}));assert.deepEqual(f.store.get('assets',target.id),asset);assert.equal(f.runtime.get(f.projectId,done.run.id).changes.find(item=>item.id===change.id)?.status,'applied');assert.deepEqual(receipts(f),before);assert.deepEqual(readFileSync(f.source),f.sourceBytes);
});

import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import type {MioBeginRequest} from '../packages/business/src/agent/mio-records.ts';
import type {MioInputManifest} from '../packages/contracts/src/mio-records.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';

const at = '2026-11-02T05:00:00.000Z';
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
function setup(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-repository-'));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  store.put('projects', {id: store.projectId, name: 'Mio repository synthetic project'});
  const records = createMioRecords(store);
  const conversationId = randomUUID(), runId = randomUUID();
  let shared = '';
  store.tx(() => {
    shared = records.putBlob('{}', at);
    records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: hash('synthetic send'), stepLimit: 30, budget: 30, locale: 'zh-Hans', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
  });
  function manifest(entryIds: string[] = [], noteEntryIds: string[] = []): MioInputManifest {
    return {version: 1, entryIds, noteEntryIds, configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: null, parameters: {}, viewVersion: 1};
  }
  function model(protocol: MioBeginRequest['protocol'] = 'chat_completions', entryIds: string[] = []) {
    const stepId = randomUUID(), requestId = randomUUID();
    const input: MioBeginRequest = {id: requestId, stepId, assemblerVersion: 1, protocol, body: JSON.stringify({synthetic: true}), inputManifest: manifest(entryIds), assembledAt: at};
    store.tx(() => { records.createStep({id: stepId, runId, kind: 'model', createdAt: at}); records.beginRequest(input); });
    return {stepId, requestId, input};
  }
  return {root, store, records, runId, conversationId, shared, manifest, model};
}
const code = (expected: string) => (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;

test('Mio repository writes require the kernel transaction and reads never write', t => {
  const f = setup(t);
  assert.throws(() => f.records.putBlob('outside transaction', at), code('AGENT_TASK_TRANSACTION_REQUIRED'));
  assert.throws(() => f.records.appendEntry({id: randomUUID(), runId: f.runId, kind: 'user_message', createdAt: at, payload: {json: 'no transaction'}}), code('AGENT_TASK_TRANSACTION_REQUIRED'));
  const before = f.store.db.prepare('SELECT total_changes() AS count').get()?.count;
  f.records.conversation(f.conversationId); f.records.run(f.runId); f.records.blob(f.shared);
  f.records.entries(f.runId); f.records.steps(f.runId); f.records.events(f.runId); f.records.changes(f.runId);
  f.records.claims(); f.records.editOwner('synthetic-owner'); f.records.editReceipt('synthetic-edit-request');
  f.records.control('synthetic-control-request'); f.records.conversationPolicy(f.conversationId);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()?.count, before);
});

test('blob dedup uses original UTF-8 bytes, verifies stored hashes and preserves escaped JSON strings', t => {
  const f = setup(t), body = JSON.stringify({text: '你好\r\n', isolatedSurrogate: '\ud800'});
  const rowsBefore = Number(f.store.db.prepare('SELECT count(*) AS count FROM mio_blobs').get()?.count);
  let first = '';
  f.store.tx(() => {
    first = f.records.putBlob(body, at);
    assert.equal(f.records.putBlob(body, at), first);
    assert.equal(f.records.putBlob('{}', at), f.shared);
    assert.throws(() => f.records.putBlob('\ud800', at), code('AGENT_TASK_INVALID'));
  });
  assert.equal(first, hash(body)); assert.equal(f.records.blob(first), body);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) AS count FROM mio_blobs').get()?.count), rowsBefore + 1);
  f.store.tx(() => f.store.db.prepare('INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)').run('a'.repeat(64), 4, 'fake', at));
  assert.throws(() => f.records.blob('a'.repeat(64)), code('AGENT_TASK_STORAGE_CORRUPT'));
});

test('entries append once in order, JSON null is retained, and duplicate IDs cannot advance state', t => {
  const f = setup(t), one = randomUUID(), two = randomUUID();
  f.store.tx(() => {
    f.records.appendEntry({id: one, runId: f.runId, kind: 'user_message', createdAt: at, payload: {json: null}});
    const blobHash = f.records.putBlob(JSON.stringify({large: 'preserved'}), at);
    f.records.appendEntry({id: two, runId: f.runId, kind: 'note', createdAt: at, payload: {blobHash}});
  });
  assert.deepEqual(f.records.entries(f.runId).map(item => [item.id, item.sequence]), [[one, 1], [two, 2]]);
  assert.equal(f.records.payload(f.records.entry(one)), null);
  assert.deepEqual(f.records.payload(f.records.entry(two)), {large: 'preserved'});
  const events = f.records.events(f.runId), revision = f.records.run(f.runId).revision;
  f.store.tx(() => {
    assert.throws(() => f.records.appendEntry({id: one, runId: f.runId, kind: 'note', createdAt: at, payload: {json: 'duplicate'}}));
    assert.throws(() => f.store.db.prepare('UPDATE mio_entries SET payloadJson=? WHERE id=?').run('"changed"', one), /immutable/iu);
    assert.throws(() => f.store.db.prepare('DELETE FROM mio_entries WHERE id=?').run(one), /retained/iu);
  });
  assert.equal(f.records.run(f.runId).revision, revision);
  assert.deepEqual(f.records.events(f.runId), events);
});

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
  test(`successful ${protocol} requests atomically archive canonical output, clear bodies and retain source calls across reopen`, t => {
    const f = setup(t), userId = randomUUID();
    f.store.tx(() => f.records.appendEntry({id: userId, runId: f.runId, kind: 'user_message', createdAt: at, payload: {json: 'Synthetic request'}}));
    const model = f.model(protocol, [userId]), outputId = randomUUID();
    const providerOutput: AgentTaskJson = protocol === 'chat_completions'
      ? {role: 'assistant', content: 'Synthetic answer', reasoning_content: 'PRIVATE_THINKING', tool_calls: [{id: 'call_one', type: 'function', function: {name: 'mioon_project_inspect', arguments: '{ "value": 1 }'}}]}
      : protocol === 'responses'
        ? [{type: 'reasoning', encrypted_content: 'PRIVATE_ENCRYPTED_REASONING'}, {type: 'function_call', call_id: 'call_one', name: 'mioon_project_inspect', arguments: '{ "value": 1 }'}]
        : {role: 'assistant', content: [{type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE'}, {type: 'tool_use', id: 'call_one', name: 'mioon_project_inspect', input: {value: 1}}]};
    const output = {protocol, providerOutput};
    assert.equal(f.records.request(model.requestId).originalBody, model.input.body);
    f.store.tx(() => {
      f.records.markDispatched(model.requestId, at);
      f.records.updateStep(model.stepId, 'dispatch_started', {status: 'dispatch_started', partialText: 'PARTIAL_CHECKPOINT', updatedAt: at});
      f.records.completeModelRequest(model.requestId, {entryId: outputId, output, at});
    });
    const saved = f.records.request(model.requestId);
    assert.equal(saved.state, 'completed'); assert.equal(saved.originalBody, null);
    assert.equal(saved.bodySha256, hash(model.input.body)); assert.equal(saved.bodyBytes, Buffer.byteLength(model.input.body));
    assert.equal(f.records.step(model.stepId).partialText, null);
    assert.deepEqual(f.records.payload(f.records.entry(outputId)), output);
    assert.deepEqual(f.records.sourceCall(outputId, 0), {id: 'call_one', name: 'mioon_project_inspect', arguments: {value: 1}});
    assert.throws(() => f.records.sourceCall(outputId, 1), code('AGENT_TASK_INVALID'));
    const toolId = randomUUID();
    f.store.tx(() => {
      f.records.createStep({id: toolId, runId: f.runId, kind: 'tool', sourceEntryId: outputId, sourceCallIndex: 0, createdAt: at});
      assert.throws(() => f.records.createStep({id: randomUUID(), runId: f.runId, kind: 'tool', sourceEntryId: outputId, sourceCallIndex: 0, createdAt: at}), code('AGENT_TASK_REQUEST_CONFLICT'));
    });
    assert.deepEqual(Object.keys(f.records.events(f.runId)[0]!).sort(), ['createdAt', 'runId', 'sequence']);
    assert.ok(!JSON.stringify(f.records.events(f.runId)).includes('PRIVATE_'));
    f.store.close();
    const reopened = openStore(f.root); t.after(() => reopened.close());
    const records = createMioRecords(reopened);
    assert.equal(records.request(model.requestId).originalBody, null);
    assert.deepEqual(records.sourceCall(outputId, 0), {id: 'call_one', name: 'mioon_project_inspect', arguments: {value: 1}});
    assert.deepEqual(records.payload(records.entry(outputId)), output);
  });
}

test('request lifecycle rejects premature clear, bad completion and completed replays without losing the intent', t => {
  const f = setup(t), model = f.model(), outputId = randomUUID();
  f.store.tx(() => {
    assert.throws(() => f.store.db.prepare('UPDATE mio_requests SET originalBody=NULL WHERE id=?').run(model.requestId), /completion/iu);
    assert.throws(() => f.records.updateStep(model.stepId, 'intent', {status: 'dispatch_started', updatedAt: at}), code('AGENT_TASK_STATE_CONFLICT'));
    assert.throws(() => f.records.updateStep(model.stepId, 'intent', {status: 'completed', updatedAt: at}), code('AGENT_TASK_STATE_CONFLICT'));
    assert.throws(() => f.records.completeModelRequest(model.requestId, {entryId: outputId, output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'not dispatched'}}, at}), code('AGENT_TASK_STATE_CONFLICT'));
    f.records.markDispatched(model.requestId, at);
    assert.throws(() => f.records.updateStep(model.stepId, 'dispatch_started', {status: 'completed', updatedAt: at}), code('AGENT_TASK_STATE_CONFLICT'));
    assert.throws(() => f.records.completeModelRequest(model.requestId, {entryId: outputId, output: {protocol: 'responses', providerOutput: []}, at}), code('AGENT_TASK_INVALID'));
    assert.throws(() => f.records.completeModelRequest(model.requestId, {entryId: outputId, output: {protocol: 'chat_completions', providerOutput: {}}, at}), code('AGENT_TASK_STORAGE_CORRUPT'));
  });
  assert.equal(f.records.request(model.requestId).state, 'dispatch_started');
  assert.equal(f.records.request(model.requestId).originalBody, model.input.body);
  assert.equal(f.records.entries(f.runId).length, 0);
  f.store.tx(() => f.records.completeModelRequest(model.requestId, {entryId: outputId, output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'done'}}, at}));
  const before = f.records.events(f.runId).length;
  f.store.tx(() => assert.throws(() => f.records.completeModelRequest(model.requestId, {entryId: randomUUID(), output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'done'}}, at}), code('AGENT_TASK_STATE_CONFLICT')));
  f.store.tx(() => assert.throws(() => f.records.updateStep(model.stepId, 'completed', {status: 'intent', updatedAt: at}), code('AGENT_TASK_STATE_CONFLICT')));
  assert.equal(f.records.events(f.runId).length, before);
});

test('failed and unknown requests retain raw bodies and partial output, and never become unsent for reassembly', t => {
  for (const state of ['failed', 'unknown'] as const) {
    const f = setup(t), model = f.model();
    f.store.tx(() => {
      f.records.markDispatched(model.requestId, at);
      f.records.updateStep(model.stepId, 'dispatch_started', {status: 'dispatch_started', partialText: 'KNOWN_PARTIAL', updatedAt: at});
      f.records.failRequest(model.requestId, state, at);
    });
    assert.equal(f.records.request(model.requestId).state, state);
    assert.equal(f.records.request(model.requestId).originalBody, model.input.body);
    assert.equal(f.records.step(model.stepId).partialText, 'KNOWN_PARTIAL');
    f.store.tx(() => assert.throws(() => f.records.reassembleRequest(model.requestId, {...model.input, id: randomUUID(), assemblerVersion: 2}, randomUUID()), code('AGENT_TASK_STATE_CONFLICT')));
  }
});

test('only an undispatched intent can acquire an assembly version without adding a step or absorbing later notes', t => {
  const f = setup(t), noteId = randomUUID();
  f.store.tx(() => f.records.appendEntry({id: noteId, runId: f.runId, kind: 'note', payload: {json: 'Frozen note'}, createdAt: at}));
  const model = f.model('chat_completions', [noteId]);
  const manifest = f.manifest([noteId], [noteId]);
  // Start a distinct model with a note binding; the first intent remains untouched.
  const stepId = randomUUID(), requestId = randomUUID();
  const input: MioBeginRequest = {...model.input, stepId, id: requestId, inputManifest: manifest};
  f.store.tx(() => { f.records.createStep({id: stepId, runId: f.runId, kind: 'model', createdAt: at}); f.records.beginRequest(input); });
  const before = f.records.run(f.runId).stepsUsed, nextId = randomUUID(), laterId = randomUUID();
  f.store.tx(() => {
    f.records.appendEntry({id: laterId, runId: f.runId, kind: 'note', payload: {json: 'Later note'}, createdAt: at});
    assert.throws(() => f.records.reassembleRequest(requestId, {...input, id: nextId, assemblerVersion: 2, inputManifest: f.manifest([noteId, laterId], [noteId, laterId])}, randomUUID()), code('AGENT_TASK_REQUEST_CONFLICT'));
    f.records.reassembleRequest(requestId, {...input, id: nextId, assemblerVersion: 2, body: '{"synthetic":"upgraded"}'}, randomUUID());
  });
  assert.equal(f.records.run(f.runId).stepsUsed, before);
  assert.equal(f.records.request(requestId).state, 'superseded');
  assert.equal(f.records.request(requestId).bodySha256, hash(input.body));
  assert.equal(f.records.request(nextId).assemblyNumber, 2);
  assert.equal(f.records.request(nextId).previousRequestId, requestId);
  assert.deepEqual(f.records.request(nextId).inputManifest, manifest);
  assert.equal(f.records.step(stepId).currentRequestId, nextId);
  f.store.tx(() => {
    f.records.markDispatched(nextId, at);
    f.records.completeModelRequest(nextId, {entryId: randomUUID(), output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'done'}}, at});
  });
  assert.equal(f.records.request(requestId).originalBody, null, 'superseded unsent body is also released only after the replacement completes');
  assert.equal(f.records.request(nextId).originalBody, null);
});

test('compound calls roll back at their savepoint even when the outer transaction catches the failure', t => {
  const f = setup(t), model = f.model();
  const before = f.records.events(f.runId).length;
  f.store.tx(() => {
    assert.throws(() => f.records.reassembleRequest(model.requestId, {...model.input, id: randomUUID(), assemblerVersion: 2}, 'invalid-entry-id'), code('AGENT_TASK_INVALID'));
    assert.equal(f.records.request(model.requestId).state, 'intent');
    assert.equal(f.records.step(model.stepId).currentRequestId, model.requestId);
    assert.equal(Number(f.store.db.prepare('SELECT count(*) AS count FROM mio_requests WHERE stepId=?').get(model.stepId)?.count), 1);
  });
  assert.equal(f.records.events(f.runId).length, before);
  assert.equal(f.records.run(f.runId).stepsUsed, 1);
});

test('foreign project/run references are rejected before state or call identities can be rebound', t => {
  const one = setup(t), two = setup(t), model = one.model();
  assert.throws(() => one.records.run(two.runId), code('AGENT_TASK_NOT_FOUND'));
  assert.throws(() => one.records.conversation(two.conversationId), code('AGENT_TASK_NOT_FOUND'));
  one.store.tx(() => {
    assert.throws(() => one.records.createStep({id: randomUUID(), runId: two.runId, kind: 'model', createdAt: at}), code('AGENT_TASK_NOT_FOUND'));
    assert.throws(() => one.records.beginRequest({...model.input, id: randomUUID(), inputManifest: {...one.manifest(), configurationBlobHash: 'b'.repeat(64)}}), code('AGENT_TASK_REQUEST_CONFLICT'));
  });
  assert.equal(one.records.run(one.runId).stepsUsed, 1);
});

test('a forged output entry cannot authorize a tool before model completion', t => {
  const f = setup(t), entryId = randomUUID();
  f.store.tx(() => {
    f.records.appendEntry({id: entryId, runId: f.runId, kind: 'model_output', createdAt: at, payload: {json: {
      protocol: 'chat_completions', providerOutput: {role: 'assistant', content: null, tool_calls: [{id: 'not_completed', type: 'function', function: {name: 'mioon_project_inspect', arguments: '{}'}}]},
    }}});
    assert.throws(() => f.records.sourceCall(entryId, 0), code('AGENT_TASK_STATE_CONFLICT'));
    assert.throws(() => f.records.createStep({id: randomUUID(), runId: f.runId, kind: 'tool', sourceEntryId: entryId, sourceCallIndex: 0, createdAt: at}), code('AGENT_TASK_STATE_CONFLICT'));
  });
  assert.equal(f.records.run(f.runId).stepsUsed, 0);
});

test('controls, edit receipts, origins and conversation policy have exact idempotent identities', t => {
  const f = setup(t), model = f.model(), controlId = randomUUID(), editId = randomUUID(), jobId = randomUUID();
  f.store.tx(() => {
    const value = {requestId: controlId, runId: f.runId, digest: hash('control input'), data: {action: 'pause', result: 'applied'}};
    f.records.saveControl(value, at);
    const count = f.records.events(f.runId).length;
    f.records.saveControl(value, at);
    assert.equal(f.records.events(f.runId).length, count);
    assert.throws(() => f.records.saveControl({...value, data: {action: 'stop'}}, at), code('AGENT_TASK_REQUEST_CONFLICT'));
    f.records.setControlState(controlId, {phase: 'awaiting_resume'}, at);
    assert.deepEqual(f.records.controlState(controlId), {phase: 'awaiting_resume'});
    const edit = {requestId: editId, ownerId: 'synthetic-editor', digest: hash('edit'), data: {applied: true}};
    f.records.saveEditReceipt(edit); f.records.saveEditReceipt(edit);
    assert.throws(() => f.records.saveEditReceipt({...edit, digest: hash('different')}), code('AGENT_TASK_REQUEST_CONFLICT'));
    const origin = {kind: 'job' as const, jobId, runId: f.runId, stepId: model.stepId, requestId: randomUUID(), operation: 'generation.submit'};
    f.records.addOrigin(origin); f.records.addOrigin(origin);
    assert.throws(() => f.records.addOrigin({...origin, requestId: randomUUID()}), code('AGENT_TASK_REQUEST_CONFLICT'));
    const policy = {requestId: randomUUID(), conversationId: f.conversationId, expectedRevision: 0, modes: DEFAULT_AGENT_TASK_POLICY.modes, global: DEFAULT_AGENT_TASK_POLICY, at};
    const saved = f.records.setConversationPolicy(policy);
    assert.equal(saved.revision, 1);
    assert.deepEqual(f.records.setConversationPolicy(policy), saved);
    assert.throws(() => f.records.setConversationPolicy({...policy, modes: null}), code('AGENT_TASK_REQUEST_CONFLICT'));
    const cleared = f.records.setConversationPolicy({...policy, requestId: randomUUID(), expectedRevision: 1, modes: null});
    assert.equal(cleared.revision, 2); assert.equal(cleared.override, null);
  });
  assert.equal(f.records.origin('job', jobId)?.runId, f.runId);
  assert.equal(f.records.editReceipt(editId)?.ownerId, 'synthetic-editor');
});

test('claims and editor generations are scoped, monotonic, and remain independent of model steps', t => {
  const f = setup(t), claimId = randomUUID();
  f.store.tx(() => {
    f.records.saveEditOwner('synthetic-editor', 1, 5);
    assert.throws(() => f.records.saveEditOwner('synthetic-editor', 1, 4), code('AGENT_TASK_REVISION_CONFLICT'));
    f.records.saveEditOwner('synthetic-editor', 2, 0);
    f.records.saveClaim({id: claimId, ownerId: 'synthetic-editor', kind: 'project', targetId: f.store.projectId, revision: 1, state: 'active', createdAt: at, updatedAt: at});
    assert.throws(() => f.records.saveClaim({id: claimId, ownerId: 'another-editor', kind: 'project', targetId: f.store.projectId, revision: 2, state: 'uncertain', createdAt: at, updatedAt: at}), code('AGENT_TASK_REQUEST_CONFLICT'));
  });
  assert.equal(f.records.claims('synthetic-editor').length, 1);
  f.store.tx(() => f.records.removeClaim(claimId, 'another-editor'));
  assert.equal(f.records.claims().length, 1);
  f.store.tx(() => f.records.removeClaim(claimId, 'synthetic-editor'));
  assert.equal(f.records.claims().length, 0);
  assert.equal(f.records.run(f.runId).stepsUsed, 0);
});

test('run compare-and-swap preserves send replay identity and cannot reopen a terminal run', t => {
  const f = setup(t), initial = f.records.run(f.runId);
  f.store.tx(() => {
    const replay = f.records.createRun({...initial, id: randomUUID(), createdAt: at, updatedAt: at});
    assert.equal(replay.id, initial.id);
    assert.throws(() => f.records.updateRun(f.runId, initial.revision + 1, {status: 'paused', budget: 30, updatedAt: at}), code('AGENT_TASK_REVISION_CONFLICT'));
    const completed = f.records.updateRun(f.runId, initial.revision, {status: 'completed', budget: 30, updatedAt: at});
    assert.throws(() => f.records.updateRun(f.runId, completed.revision, {status: 'running', budget: 30, updatedAt: at}), code('AGENT_TASK_STATE_CONFLICT'));
  });
  assert.equal(f.records.run(f.runId).status, 'completed');
  assert.equal(Number(f.store.db.prepare('SELECT count(*) AS count FROM mio_runs').get()?.count), 1);
});

test('domain content and its change evidence share the outer transaction while import metadata remains typed', t => {
  const f = setup(t), model = f.model(), outputId = randomUUID(), toolId = randomUUID(), changeId = randomUUID(), importId = randomUUID();
  f.store.tx(() => {
    f.records.markDispatched(model.requestId, at);
    f.records.completeModelRequest(model.requestId, {entryId: outputId, output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: null, tool_calls: [{id: 'call_change', type: 'function', function: {name: 'mioon_project_rename', arguments: '{}'}}]}}, at});
    f.records.createStep({id: toolId, runId: f.runId, kind: 'tool', sourceEntryId: outputId, sourceCallIndex: 0, createdAt: at});
    f.records.addImport({id: importId, requestId: randomUUID(), name: 'selected.txt', mimeType: 'text/plain', relativePath: 'imports/selected.txt', sha256: hash('selected'), status: 'staged', assetId: null, resourceId: null, createdAt: at});
    f.records.updateImport(importId, {status: 'ready', assetId: null, resourceId: null});
  });
  const before = f.store.get('projects', f.store.projectId), events = f.records.events(f.runId).length;
  assert.throws(() => f.store.tx(() => {
    f.store.put('projects', {id: f.store.projectId, name: 'must roll back'});
    f.records.addChange({id: changeId, projectId: f.store.projectId, runId: f.runId, stepId: toolId, operation: 'project.rename', targets: [{kind: 'project', id: f.store.projectId, revision: 1}], before: {name: 'before'}, after: {name: 'after'}, reversible: true, status: 'applied', createdAt: at});
    throw new Error('abort-domain-and-change');
  }), /abort-domain-and-change/u);
  assert.deepEqual(f.store.get('projects', f.store.projectId), before);
  assert.deepEqual(f.records.changes(f.runId), []);
  assert.equal(f.records.events(f.runId).length, events);
  assert.equal(f.records.importRecord(importId).status, 'ready');
});

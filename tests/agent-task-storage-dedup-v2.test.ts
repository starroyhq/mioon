import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {validateAgentTaskModelRequestReferences} from '../packages/business/src/agent/task-model-requests-v2.ts';
import type {AgentTaskEvent, AgentTaskJson, AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

const format = 'mioon-model-request-ref/1';
const maxDecodedEventPageBytes = 8 * 1024 * 1024;
const json = (value: unknown): AgentTaskJson => JSON.parse(JSON.stringify(value)) as AgentTaskJson;
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-agent-storage-dedup-v2-'));
  let store = openStore(root), journal = createAgentTaskJournal(store);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = randomUUID(), foreignProjectId = randomUUID(), date = new Date().toISOString();
  for (const [id, name] of [[projectId, 'Storage source'], [foreignProjectId, 'Foreign storage source']]) {
    store.put('projects', {id, name, revision: 1, createdAt: date, updatedAt: date});
  }
  const run = journal.create({requestId: randomUUID(), projectId, text: 'Synthetic storage regression', configuration: {protocol: 'chat_completions'}}).run;
  function rawEvents(runId = run.id) {
    return store.db.prepare('SELECT runId,projectId,sequence,type,data FROM agent_task_events_v2 WHERE runId=? ORDER BY sequence').all(runId);
  }
  function insertEvent(data: AgentTaskJson, {runId = run.id, owner = projectId, type = 'step'}: {runId?: string; owner?: string; type?: string} = {}) {
    const sequence = Number(store.db.prepare('SELECT COALESCE(max(sequence),0)+1 AS n FROM agent_task_events_v2 WHERE runId=?').get(runId)!.n);
    const event: AgentTaskEvent = {runId, sequence, type, data, createdAt: date};
    store.db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(runId, owner, sequence, type, JSON.stringify(event));
    return event;
  }
  return {root, projectId, foreignProjectId, run,
    get store() {return store;}, get journal() {return journal;}, rawEvents, insertEvent,
    reopen() {store.close(); store = openStore(root); journal = createAgentTaskJournal(store);},
  };
}
function request(size = 1000): AgentTaskJson {
  const history = [{role: 'system', content: 'Mioon host response language v1: zh-Hant.'},
    {role: 'user', content: `Synthetic retained content 中文🙂 ${'x'.repeat(size)}`}];
  return {body: JSON.stringify({model: 'synthetic-model', stream: true, messages: history.slice(1)}), history};
}
function reference(step: AgentTaskStep, original: AgentTaskJson = step.request!) {
  const encoded = JSON.stringify(original);
  return {format, stepId: step.id, sha256: createHash('sha256').update(encoded).digest('hex'), bytes: Buffer.byteLength(encoded)};
}
function sourceEvents(events: AgentTaskEvent[], id: string) {
  return events.filter(event => event.type === 'step' && record(event.data).id === id);
}

test('new model events retain one immutable request source while mixed legacy inline evidence stays byte-for-byte unchanged', t => {
  const f = fixture(t), original = request(48 * 1024), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  const legacy = f.insertEvent(json(model)), legacyRow = f.rawEvents().find(row => row.sequence === legacy.sequence)!;
  const expected = reference(model, original);
  f.journal.markDispatch(f.run.id, model.id);
  for (let index = 0; index < 12; index++) f.journal.updateStep(f.run.id, model.id, {data: {checkpoint: index}});
  f.journal.completeStep(f.run.id, model.id, {result: {text: 'Synthetic finished', toolCalls: []}});
  const rows = f.rawEvents(), encoded = rows.filter(row => row.type === 'step' && row.sequence !== legacy.sequence);
  assert.ok(encoded.length >= 15);
  for (const row of encoded) {
    const value = record(JSON.parse(String(row.data)));
    assert.deepEqual(record(value.data).request, expected);
    assert.ok(!String(row.data).includes('Synthetic retained content'));
  }
  assert.deepEqual(f.rawEvents().find(row => row.sequence === legacy.sequence), legacyRow);
  const stored = f.store.db.prepare('SELECT data FROM agent_task_steps_v2 WHERE id=?').get(model.id)!;
  assert.deepEqual(record(JSON.parse(String(stored.data))).request, original);
  const savedRequestBytes = Buffer.byteLength(JSON.stringify(original));
  const compactEventBytes = encoded.reduce((sum, row) => sum + Buffer.byteLength(String(row.data)), 0);
  assert.ok(compactEventBytes < savedRequestBytes / 2, 'Repeated lifecycle events must not duplicate the full request');
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  assert.throws(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: false}));
  const events = sourceEvents(f.journal.events(f.run.id), model.id);
  assert.ok(events.every(event => JSON.stringify(record(event.data).request) === JSON.stringify(original)));
  assert.equal(record(events[0]!.data).status, 'intent');
  assert.equal(record(events[1]!.data).status, 'intent');
  assert.equal(record(events[2]!.data).status, 'dispatch_started');
  assert.equal(record(events.at(-1)!.data).status, 'completed');
  assert.equal(record(events[0]!.data).result, undefined);
  assert.deepEqual(record(events.at(-1)!.data).result, {text: 'Synthetic finished', toolCalls: []});
  assert.deepEqual(record(events.find(event => event.sequence === legacy.sequence)!.data), model);
});

test('request hydration has no aliases between events, steps or separate reads', t => {
  const f = fixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id); f.journal.completeStep(f.run.id, model.id, {result: {done: true}});
  const events = sourceEvents(f.journal.events(f.run.id), model.id), first = record(record(events[0]!.data).request), second = record(record(events[1]!.data).request);
  assert.notEqual(first, second);
  first.body = 'locally changed'; record((first.history as unknown[])[0]).content = 'locally changed';
  assert.deepEqual(second, original);
  assert.deepEqual(f.journal.step(model.id).request, original);
  assert.ok(sourceEvents(f.journal.events(f.run.id), model.id).every(event => JSON.stringify(record(event.data).request) === JSON.stringify(original)));
});

test('decoded event pages remain bounded, consecutive and complete while the sequence probe needs no hydration', t => {
  const f = fixture(t), original = request(180 * 1024), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id);
  for (let index = 0; index < 32; index++) f.journal.updateStep(f.run.id, model.id, {data: {checkpoint: index}});
  const raw = f.rawEvents(), expectedSequences = raw.map(row => Number(row.sequence)), seen: number[] = [];
  let after = 0, pages = 0;
  for (;;) {
    const page = f.journal.events(f.run.id, after); if (!page.length) break;
    pages++; assert.ok(page.length <= 2000);
    assert.ok(page.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= maxDecodedEventPageBytes);
    assert.equal(page[0]!.sequence, after + 1);
    for (const event of page) {seen.push(event.sequence); assert.ok(event.sequence > after); after = event.sequence;}
  }
  assert.ok(pages > 1, 'Full model requests must count against the decoded page bound');
  assert.deepEqual(seen, expectedSequences);
  assert.equal(f.journal.eventSequence(f.run.id, 0), after);
  assert.equal(f.journal.eventSequence(f.run.id, after), after);
  const invalid = f.insertEvent(json({...model, request: {...reference(model), sha256: 'f'.repeat(64)}}));
  assert.throws(() => f.journal.events(f.run.id, after));
  assert.equal(f.journal.eventSequence(f.run.id, after), invalid.sequence);
});

test('model requests accept exact same-value updates but reject changes or deletion at journal and database boundaries', t => {
  const f = fixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  assert.deepEqual(f.journal.updateStep(f.run.id, model.id, {request: structuredClone(original)}).request, original);
  for (const changed of [{...record(original), body: 'different body'}, {...record(original), history: []}, null, undefined]) {
    const before = f.journal.snapshot(f.run.id), raw = f.rawEvents();
    assert.throws(() => f.journal.updateStep(f.run.id, model.id, {request: changed as AgentTaskJson | undefined}));
    assert.deepEqual(f.journal.snapshot(f.run.id), before); assert.deepEqual(f.rawEvents(), raw);
  }
  const before = f.store.db.prepare('SELECT * FROM agent_task_steps_v2 WHERE id=?').get(model.id)!;
  assert.throws(() => f.store.db.prepare("UPDATE agent_task_steps_v2 SET data=json_set(data,'$.request.body','tampered') WHERE id=?").run(model.id));
  assert.throws(() => f.store.db.prepare("UPDATE agent_task_steps_v2 SET data=json_remove(data,'$.request') WHERE id=?").run(model.id));
  assert.throws(() => f.store.db.prepare('DELETE FROM agent_task_steps_v2 WHERE id=?').run(model.id));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_task_steps_v2 WHERE id=?').get(model.id), before);
  f.journal.markDispatch(f.run.id, model.id); f.journal.completeStep(f.run.id, model.id, {result: {done: true}});
  assert.equal(f.journal.step(model.id).status, 'completed');
});

test('malformed or wrongly bound model references fail closed without changing stored evidence', async t => {
  const f = fixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  const foreignRun = f.journal.create({projectId: f.foreignProjectId, requestId: randomUUID(), text: 'Foreign source', configuration: {}}).run;
  const foreignModel = f.journal.beginStep(foreignRun.id, {kind: 'model', request: original});
  const tool = f.journal.beginStep(f.run.id, {kind: 'tool', request: original});
  const emptyModel = f.journal.beginStep(f.run.id, {kind: 'model'}), good = reference(model);
  const missingId = randomUUID();
  const cases: Array<[string, AgentTaskJson, {owner?: string; type?: string}?]> = [
    ['source missing', json({...model, id: missingId, request: {...good, stepId: missingId}})],
    ['reference step differs from event step', json({...model, request: {...good, stepId: foreignModel.id}})],
    ['source belongs to another run and project', json({...model, id: foreignModel.id, request: reference(foreignModel)})],
    ['event SQL project differs', json({...model, request: good}), {owner: f.foreignProjectId}],
    ['event data run differs', json({...model, runId: foreignRun.id, request: good})],
    ['source is a tool', json({...tool, kind: 'model', request: reference(tool)})],
    ['source has no request', json({...emptyModel, request: {...good, stepId: emptyModel.id}})],
    ['wrong hash', json({...model, request: {...good, sha256: 'f'.repeat(64)}})],
    ['wrong byte length', json({...model, request: {...good, bytes: good.bytes + 1}})],
    ['non-numeric byte length', json({...model, request: {...good, bytes: String(good.bytes)}})],
    ['unknown reference version', json({...model, request: {...good, format: 'mioon-model-request-ref/2'}})],
    ['inline request mixed with reference', json({...model, request: {...good, ...record(original)}})],
    ['unknown reference field', json({...model, request: {...good, privateData: 'synthetic'}})],
  ];
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  for (const [name, data, options] of cases) await t.test(name, () => {
    const before = f.rawEvents(), rollback = new Error('Rollback only this synthetic invalid reference');
    assert.throws(() => f.store.tx(() => {
      const event = f.insertEvent(data, options);
      assert.throws(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
      assert.throws(() => f.journal.events(f.run.id, event.sequence - 1));
      throw rollback;
    }), error => error === rollback);
    assert.deepEqual(f.rawEvents(), before);
  });
});

test('lookalike payloads outside a model step request remain ordinary JSON', t => {
  const f = fixture(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: request()});
  const lookalike = reference(model), payloads = [
    {type: 'text', data: {kind: 'model', request: lookalike}},
    {type: 'step', data: {kind: 'tool', request: lookalike}},
    {type: 'step', data: {...model, result: {request: lookalike}}},
  ];
  for (const payload of payloads) {
    const event = f.insertEvent(json(payload.data), {type: payload.type});
    const found = f.journal.events(f.run.id, event.sequence - 1)[0]!;
    assert.deepEqual(found.data, payload.data);
  }
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
});

test('reopening and UNKNOWN recovery preserve the exact source and never create a replacement model intent', t => {
  const f = fixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id);
  const evidence = f.rawEvents(); f.reopen();
  assert.equal(f.journal.recover(), 1);
  const recovered = f.journal.snapshot(f.run.id);
  assert.equal(recovered.run.status, 'interrupted'); assert.equal(recovered.steps.length, 1);
  assert.equal(recovered.steps[0]!.status, 'unknown'); assert.deepEqual(recovered.steps[0]!.request, original);
  assert.deepEqual(f.rawEvents().slice(0, evidence.length), evidence);
  assert.throws(() => f.journal.resume(f.run.id, recovered.run.revision), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.journal.recover(), 0); assert.equal(f.journal.snapshot(f.run.id).steps.length, 1);
  const states = sourceEvents(f.journal.events(f.run.id), model.id).map(event => record(event.data).status);
  assert.deepEqual(states, ['intent', 'dispatch_started', 'unknown']);
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 0);
});

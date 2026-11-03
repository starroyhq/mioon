


import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/project-file/index.ts';

import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';

import {aggregateMioRunUsage, readMioRunUsage} from '../packages/business/src/agent/mio-run-usage.ts';
import {createTaskUsageCollector} from '../packages/business/src/agent/task-usage-v2.ts';
import {mioRunUsageSchema} from '../packages/contracts/src/mio-run-usage.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {MioModelOutput} from '../packages/contracts/src/mio-records.ts';

const at = '2026-11-02T05:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-run-usage-'));
  let store = openStore(root);
  store.put('projects', {id: store.projectId, name: 'Synthetic usage project'});
  let records = createMioRecords(store);
  const conversationId = randomUUID(), runId = randomUUID();
  let shared = '';
  store.tx(() => {
    shared = records.putBlob('{}', at);
    records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: digest('send'), stepLimit: 30, budget: 30, locale: 'zh-Hans', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
  });
  t.after(() => {store.close(); rmSync(root, {force: true, recursive: true});});
  function model(body = '{"PRIVATE_REQUEST":true}') {
    const stepId = randomUUID(), requestId = randomUUID();
    store.tx(() => {
      records.createStep({id: stepId, runId, kind: 'model', createdAt: at});
      records.beginRequest({id: requestId, stepId, assemblerVersion: 1, protocol: 'chat_completions', body, assembledAt: at,
        inputManifest: {version: 1, entryIds: [], noteEntryIds: [], configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: null, parameters: {}, viewVersion: 1}});
    });
    return {stepId, requestId};
  }
  return {root, runId, model, get store() {return store;}, get records() {return records;}, reopen() {store.close(); store = openStore(root); records = createMioRecords(store);}};
}
const output = (usage?: MioModelOutput['usage']): MioModelOutput => ({protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'PRIVATE_PROVIDER_OUTPUT'}, ...(usage ? {usage} : {})});
const read = (f: ReturnType<typeof fixture>) => readMioRunUsage(f.store, f.runId);

test('usage aggregation deduplicates request identities and distinguishes missing fields from explicit zero', () => {
  const runId = randomUUID();
  const observations = Object.freeze([
    Object.freeze({requestId: 'done', dispatched: true, outcome: 'completed' as const, usage: Object.freeze({inputTokens: 10, outputTokens: 0, cacheReadTokens: 2})}),
    Object.freeze({requestId: 'done', dispatched: true, outcome: 'completed' as const, usage: Object.freeze({inputTokens: 10, outputTokens: 0, cacheReadTokens: 2})}),
    Object.freeze({requestId: 'failed', dispatched: true, outcome: 'failed' as const}),
    Object.freeze({requestId: 'unknown', dispatched: true, outcome: 'unknown' as const}),
    Object.freeze({requestId: 'pending', dispatched: true, outcome: 'inflight' as const}),
    Object.freeze({requestId: 'intent', dispatched: false, outcome: 'inflight' as const}),
  ]);
  const value = aggregateMioRunUsage(runId, 7, observations);
  assert.equal(value.dispatchedModelSteps, 4);
  assert.deepEqual(value.modelOutcomes, {completed: 1, failed: 1, unknown: 1, inflight: 1});
  assert.deepEqual(value.knownTotals, {inputTokens: 10, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: null});
  assert.deepEqual(value.coverage.fields.inputTokens, {reportedSteps: 1, missingSteps: 3, complete: false, overflow: false});
  assert.deepEqual(value.coverage.fields.cacheWriteTokens, {reportedSteps: 0, missingSteps: 4, complete: false, overflow: false});
  assert.equal(value.cacheReadRate, null);
  assert.deepEqual(aggregateMioRunUsage(runId, 7, observations), value);
  assert.equal(mioRunUsageSchema.safeParse({...value, providerOutput: 'PRIVATE'}).success, false);
  assert.equal(mioRunUsageSchema.safeParse({...value, cacheReadRate: 0.2}).success, false);
  assert.equal(mioRunUsageSchema.safeParse({...value, knownTotals: {...value.knownTotals, cacheWriteTokens: 0}}).success, false);
});

test('full coverage computes read/input without adding cache breakdowns; invalid or overflowing usage stays passive', () => {
  const runId = randomUUID(), complete = (usage: unknown) => ({requestId: randomUUID(), dispatched: true, outcome: 'completed' as const, usage});
  const value = aggregateMioRunUsage(runId, 1, [complete({inputTokens: 100, outputTokens: 10, cacheReadTokens: 25, cacheWriteTokens: 5}), complete({inputTokens: 100, outputTokens: 0, cacheReadTokens: 75, cacheWriteTokens: 0})]);
  assert.deepEqual(value.knownTotals, {inputTokens: 200, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 5});
  assert.equal(value.cacheReadRate, 0.5);
  for (const usage of [{inputTokens: 0, cacheReadTokens: 0}, {inputTokens: 10, cacheReadTokens: 11}]) assert.equal(aggregateMioRunUsage(runId, 1, [complete(usage)]).cacheReadRate, null);
  const unknown = aggregateMioRunUsage(runId, 1, [complete({inputTokens: -1, outputTokens: Infinity, cacheReadTokens: '2', cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1})]);
  assert.deepEqual(unknown.knownTotals, {inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null});
  const overflow = aggregateMioRunUsage(runId, 1, [complete({inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0}), complete({inputTokens: 1, outputTokens: 0})]);
  assert.equal(overflow.knownTotals.inputTokens, null); assert.equal(overflow.knownTotals.outputTokens, 0);
  assert.deepEqual(overflow.coverage.fields.inputTokens, {reportedSteps: 2, missingSteps: 0, complete: false, overflow: true});
  assert.equal(overflow.cacheReadRate, null);
  const empty = aggregateMioRunUsage(runId, 1, []);
  assert.equal(empty.coverage.fields.inputTokens.complete, true); assert.equal(empty.knownTotals.inputTokens, null); assert.equal(empty.cacheReadRate, null);
});

test('three protocols retain normalized cumulative snapshots rather than summing SSE events', () => {
  for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
    const collector = createTaskUsageCollector(protocol);
    const snapshot = protocol === 'chat_completions' ? {prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 5}}
      : protocol === 'responses' ? {input_tokens: 20, output_tokens: 2, input_tokens_details: {cached_tokens: 5, cache_write_tokens: 3}}
      : {input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3};
    collector.observe(snapshot); collector.observe(snapshot);
    const value = aggregateMioRunUsage(randomUUID(), 1, [{requestId: 'one', dispatched: true, outcome: 'completed', usage: collector.usage()}]);
    assert.equal(value.knownTotals.inputTokens, 20); assert.equal(value.knownTotals.outputTokens, 2); assert.equal(value.cacheReadRate, 0.25);
  }
  const partial = createTaskUsageCollector('anthropic_messages'); partial.observe({input_tokens: 12, cache_read_input_tokens: 5});
  assert.equal(partial.usage()?.inputTokens, undefined);
});

test('canonical usage survives body cleanup/reopen, ignores stale projection, and every read is write-free', t => {
  const f = fixture(t), one = f.model(), two = f.model(), unknown = f.model(), inflight = f.model(); f.model();
  f.store.tx(() => {
    for (const model of [one, two, unknown, inflight]) f.records.markDispatched(model.requestId, at);
    f.records.completeModelRequest(one.requestId, {entryId: randomUUID(), output: output({inputTokens: 100, outputTokens: 0, cacheReadTokens: 20, cacheWriteTokens: 0}), at});
    f.records.failRequest(two.requestId, 'failed', at); f.records.failRequest(unknown.requestId, 'unknown', at);
  });
  assert.equal(f.records.request(one.requestId).originalBody, null);
  const value = read(f), {runId: _id, revision: _revision, ...summary} = value;
  assert.deepEqual(f.records.run(f.runId).usageSummary, summary);
  assert.deepEqual(value.modelOutcomes, {completed: 1, failed: 1, unknown: 1, inflight: 1});
  assert.equal(value.coverage.fields.inputTokens.missingSteps, 3); assert.equal(value.cacheReadRate, null);
  const beforeReplay = Number(f.store.db.prepare('SELECT total_changes() AS n').get()!.n);
  f.store.tx(() => assert.throws(() => f.records.completeModelRequest(one.requestId, {entryId: randomUUID(), output: output({inputTokens: 999}), at}), {code: 'AGENT_TASK_STATE_CONFLICT'}));
  assert.equal(Number(f.store.db.prepare('SELECT total_changes() AS n').get()!.n), beforeReplay);
  f.store.tx(() => f.store.db.prepare("UPDATE mio_runs SET usageSummary='{}' WHERE id=?").run(f.runId));
  const before = Number(f.store.db.prepare('SELECT total_changes() AS n').get()!.n);
  assert.deepEqual(read(f), value); assert.deepEqual(read(f), value);
  assert.equal(Number(f.store.db.prepare('SELECT total_changes() AS n').get()!.n), before);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  f.reopen(); assert.deepEqual(read(f), value);
  const other = fixture(t); assert.throws(() => readMioRunUsage(f.store, other.runId), {code: 'AGENT_TASK_NOT_FOUND'});
});

test('invalid passive measurements and cumulative overflow never fail canonical completion', t => {
  const f = fixture(t), one = f.model(), two = f.model();
  f.store.tx(() => {
    f.records.markDispatched(one.requestId, at); f.records.completeModelRequest(one.requestId, {entryId: randomUUID(), output: output({inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: -1, cacheReadTokens: 0, privateRaw: 'PRIVATE'} as unknown as NonNullable<MioModelOutput['usage']>), at});
    f.records.markDispatched(two.requestId, at); f.records.completeModelRequest(two.requestId, {entryId: randomUUID(), output: output({inputTokens: 1, cacheReadTokens: 0}), at});
  });
  assert.equal(f.records.request(two.requestId).state, 'completed'); assert.equal(f.records.request(two.requestId).originalBody, null);
  assert.equal(read(f).coverage.fields.inputTokens.overflow, true); assert.equal(read(f).knownTotals.inputTokens, null);
  const payload = f.records.payload(f.records.entry(f.records.step(one.stepId).resultEntryId!));
  assert.ok(!JSON.stringify(payload).includes('privateRaw')); assert.equal(read(f).knownTotals.outputTokens, null);
});

test('archival failure after raw-body release rolls back completion, usage projection, and output together', t => {
  const f = fixture(t), model = f.model();
  f.store.tx(() => f.records.markDispatched(model.requestId, at));
  const before = read(f), beforeStorage = readMioStorage(f.store.db), entries = f.records.entries(f.runId).length;
  f.store.db.exec(`CREATE TEMP TRIGGER reject_usage_output BEFORE INSERT ON mio_entries WHEN NEW.kind='model_output' BEGIN SELECT RAISE(ABORT,'injected output archival failure'); END`);
  f.store.tx(() => {
    assert.throws(() => f.records.completeModelRequest(model.requestId, {entryId: randomUUID(), output: output({inputTokens: 12}), at}), /injected output archival failure/u);
    assert.equal(f.records.request(model.requestId).state, 'dispatch_started');
    assert.equal(f.records.request(model.requestId).originalBody, '{"PRIVATE_REQUEST":true}');
    assert.equal(f.records.step(model.stepId).status, 'dispatch_started');
    assert.equal(f.records.step(model.stepId).resultEntryId, null); assert.equal(f.records.entries(f.runId).length, entries);
    assert.deepEqual(read(f), before);
    assert.deepEqual(readMioStorage(f.store.db), beforeStorage);
  });
  f.store.db.exec('DROP TRIGGER reject_usage_output');
  f.store.tx(() => f.records.completeModelRequest(model.requestId, {entryId: randomUUID(), output: output({inputTokens: 12}), at}));
  assert.equal(read(f).knownTotals.inputTokens, 12);
});

test('SIGKILL between raw-body release and output archival restores durable intent, partial output, and usage', {timeout: 60_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-archive-usage-kill-')), marker = path.join(root, 'ready');
  t.after(() => rmSync(root, {force: true, recursive: true}));
  const worker = fileURLToPath(new URL('./helpers/mio-usage-archive-worker.ts', import.meta.url));
  const child = spawn(process.execPath, [worker], {stdio: ['ignore', 'ignore', 'inherit'], env: {...process.env, MIO_USAGE_ROOT: root, MIO_USAGE_MARKER: marker}}), closed = once(child, 'close');
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    assert.equal(child.exitCode, null, 'Archive worker exited before its barrier'); assert.equal(child.signalCode, null);
    assert.ok(Date.now() < deadline, 'Archive barrier timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  child.kill('SIGKILL'); const [exitCode, signal] = await closed;
  assert.equal(exitCode, null); assert.equal(signal, 'SIGKILL');
  const {runId, stepId, requestId, beforeStorage} = JSON.parse(readFileSync(marker, 'utf8')) as {runId: string; stepId: string; requestId: string; beforeStorage: unknown};
  const store = openStore(root), records = createMioRecords(store); t.after(() => store.close());
  assert.equal(records.request(requestId).state, 'dispatch_started'); assert.equal(records.request(requestId).originalBody, '{"privateRequest":true}');
  assert.equal(records.step(stepId).status, 'dispatch_started'); assert.equal(records.step(stepId).partialText, 'DURABLE_PARTIAL');
  assert.equal(records.step(stepId).resultEntryId, null); assert.equal(records.entries(runId).length, 0);
  const usage = readMioRunUsage(store, runId), {runId: _runId, revision: _revision, ...summary} = usage;
  assert.equal(usage.modelOutcomes.inflight, 1); assert.equal(usage.knownTotals.inputTokens, null);
  assert.deepEqual(records.run(runId).usageSummary, summary);
  assert.deepEqual(readMioStorage(store.db), beforeStorage);
  assert.equal(store.db.prepare('PRAGMA main.foreign_key_check').all().length, 0);
});

test('canonical prevented dispatch is excluded until the same immutable request resumes', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-blocked-usage-')), store = openStore(root);
  t.after(() => {store.close(); rmSync(root, {force: true, recursive: true});});
  store.put('projects', {id: store.projectId, name: 'Blocked usage synthetic'});
  const records = createMioRecords(store), journal = createMioJournal(store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  const run = journal.create({projectId: store.projectId, requestId: randomUUID(), text: 'Hello', configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  const history = [{role: 'user', content: run.text}], body = JSON.stringify({model: 'synthetic', stream: true, messages: history});
  const model = journal.beginModelStep(run.id, {request: {body, history}, data: {baseline: []}}, []);
  const usage = () => readMioRunUsage(store, run.id);
  journal.markDispatch(run.id, model.id); const requestId = records.step(model.id).currentRequestId!, dispatchedAt = records.request(requestId).dispatchStartedAt;
  assert.equal(usage().modelOutcomes.inflight, 1);
  journal.dispatchPrevented(run.id, model.id, 'awaiting_approval'); assert.equal(usage().dispatchedModelSteps, 0);
  journal.updateStep(run.id, model.id, {status: 'intent'}); assert.equal(usage().dispatchedModelSteps, 0);
  journal.markDispatch(run.id, model.id); assert.equal(usage().modelOutcomes.inflight, 1);
  assert.equal(records.request(requestId).dispatchStartedAt, dispatchedAt);
});



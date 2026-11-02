import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../../packages/business/src/agent/mio-storage.ts';
import type {MioInputManifest, MioModelOutput} from '../../packages/contracts/src/mio-records.ts';
import type {AgentTaskJson} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {createMioTestFixture} from './mio-runtime-fixture.ts';
import {createPhysicalSampler, sha256} from './mio-storage-report.ts';

const at = '2026-01-01T00:00:00.000Z';
function maximumBody(): string {
  const value = {syntheticContextPayload: ''};
  value.syntheticContextPayload = 'x'.repeat(524288 - Buffer.byteLength(JSON.stringify(value)));
  const result = JSON.stringify(value); assert.equal(Buffer.byteLength(result), 524288); return result;
}
function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-mio-retention-report-'));
  const store = openStore(root), records = createMioRecords(store), physical = createPhysicalSampler(store);
  store.put('projects', {id: store.projectId, name: 'Synthetic Mio storage boundary project'});
  const conversationId = randomUUID(), runId = randomUUID(); let shared = '';
  store.tx(() => {
    shared = records.putBlob('{}', at);
    records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: sha256('synthetic maximum request storage boundary'), stepLimit: 30, budget: 30, locale: 'en', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
  });
  const manifest: MioInputManifest = {version: 1, entryIds: [], noteEntryIds: [], configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: null, parameters: {}, viewVersion: 1};
  const body = maximumBody();
  function request() {
    const stepId = randomUUID(), id = randomUUID();
    const input = {id, stepId, assemblerVersion: 1, protocol: 'chat_completions' as const, body, inputManifest: manifest, assembledAt: at};
    store.tx(() => {records.createStep({id: stepId, runId, kind: 'model', createdAt: at}); records.beginRequest(input); physical.sample();});
    physical.sample(); return input;
  }
  return {root, store, records, physical, request, close: () => {store.close(); rmSync(root, {recursive: true, force: true});}};
}

/** Repository boundary fixtures use the largest accepted raw body and the
 * journal's 256 KiB checkpoint bound. They are deliberately separate from the
 * real-runtime stress workload: this opaque storage fixture is not dispatched
 * or claimed to be a protocol-valid 512 KiB runtime assembly. */
export function collectMioRecoveryRetention() {
  const states = [];
  for (const state of ['intent', 'failed', 'unknown', 'upgraded'] as const) {
    const f = setup();
    try {
      const baseline = readMioStorage(f.store.db), request = f.request();
      let currentId: string = request.id;
      f.store.tx(() => {
        if (state === 'upgraded') currentId = f.records.reassembleRequest(request.id, {...request, id: randomUUID(), assemblerVersion: 2}, randomUUID()).id;
        else if (state !== 'intent') {
          f.records.markDispatched(request.id, at);
          f.records.updateStep(request.stepId, 'dispatch_started', {status: 'dispatch_started', updatedAt: at, partialText: JSON.stringify('x'.repeat(256 * 1024)), data: {partialEncoding: 'json'}});
          f.records.failRequest(request.id, state, at);
        }
        f.physical.sample();
      });
      f.physical.sample();
      const after = readMioStorage(f.store.db), rows = f.store.db.prepare('SELECT state,bodyBytes,length(CAST(originalBody AS BLOB)) AS retainedBodyBytes FROM mio_requests ORDER BY rowid').all();
      assert.equal(f.records.request(currentId).originalBody, request.body);
      const bodyBytes = rows.reduce((total, row) => total + Number(row.retainedBodyBytes), 0);
      assert.equal(bodyBytes, state === 'upgraded' ? 1048576 : 524288);
      states.push({state, requestBodyBytes: 524288, partialCheckpointLimitBytes: state === 'failed' || state === 'unknown' ? 262144 : 0,
        retainedBodyBytes: bodyBytes, retained: {bytes: after.usage.bytes - baseline.usage.bytes, rows: after.usage.rows - baseline.usage.rows}, after, physical: f.physical.report()});
    } finally {f.close();}
  }
  return {method: 'Real K1/MioRecords storage-boundary fixtures; maximum raw request=512KiB, journal checkpoint bound=256KiB (provider text limit remains128KiB), one-version upgrade retains two originals. No raw bodies emitted in artifacts.', states};
}

export async function collectMioQueueBound() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-mio-queue-report-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
  let calls = 0;
  const fixture = await createMioTestFixture(root, async function* (request) {
    request.beforeSubmit?.(); calls++; entered(); await gate;
    yield {type: 'done', output: {text: 'done', toolCalls: [], providerOutput: {role: 'assistant', content: 'done'}}};
  });
  try {
    const settings = await fixture.settings.get();
    await fixture.runtime.send(fixture.store.projectId, {requestId: randomUUID(), expectedSettingsRevision: settings.revision, text: 'Hold one synthetic model request.'});
    await ready;
    const outcomes = await Promise.all(Array.from({length: 8}, async () => {
      try {await fixture.runtime.send(fixture.store.projectId, {requestId: randomUUID(), expectedSettingsRevision: settings.revision, text: 'Concurrent queue probe.'}); return 'accepted';}
      catch (error) {assert.ok(error !== null && typeof error === 'object' && 'code' in error); return String(error.code);}
    }));
    const pendingRequests = Number(fixture.store.db.prepare("SELECT count(*) AS n FROM mio_requests WHERE state IN ('intent','dispatch_started')").get()!.n);
    assert.equal(pendingRequests, 1); assert.equal(calls, 1); assert.ok(outcomes.every(value => value === 'AGENT_TASK_BUSY'));
    return {method: 'Real MioRuntime: one held gateway plus eight concurrent same-project send calls.', attempted: 9, accepted: 1, refused: outcomes.length, refusalCodes: [...new Set(outcomes)], pendingRequests, beforeRelease: readMioStorage(fixture.store.db)};
  } finally {release(); await fixture.close(); rmSync(root, {recursive: true, force: true});}
}

export function collectMioNearFullArchive(options: {slack?: 0 | 1 | 1024; output?: 'text' | 'tool_only'} = {}) {
  const {slack = 1024, output: outputKind = 'text'} = options;
  assert.ok([0, 1, 1024].includes(slack));
  assert.ok(['text', 'tool_only'].includes(outputKind));
  const f = setup();
  try {
    const request = f.request();
    f.store.tx(() => f.records.markDispatched(request.id, at));
    const current = readMioStorage(f.store.db), targetBytes = current.limits.bytes - slack;
    let remaining = targetBytes - current.usage.bytes, fillerRows = 0;
    f.store.tx(() => {
      while (remaining > 88) {
        const size = Math.min(remaining - 88, 2097152 - 88);
        const prefix = `synthetic-near-full-${fillerRows}-`;
        assert.ok(size >= prefix.length);
        f.records.putBlob(prefix + 'z'.repeat(size - prefix.length), at);
        remaining -= size + 88; fillerRows++;
      }
      f.physical.sample();
    });
    const before = readMioStorage(f.store.db);
    assert.equal(before.remaining.bytes, slack);
    const providerOutput: AgentTaskJson = outputKind === 'text'
      ? {role: 'assistant', content: 'x'.repeat(128 * 1024)}
      : {role: 'assistant', content: null, tool_calls: [{id: 'synthetic_tool_only', type: 'function', function: {name: 'mioon_project_inspect', arguments: '{}'}}]};
    const output: MioModelOutput = {protocol: 'chat_completions', providerOutput};
    let insertFirstError: string | null = null;
    // Reproduce the former first INSERT under the same quota. This separate
    // transaction must roll back and keep the dispatch/raw evidence intact.
    const attemptedInsertFirst = outputKind === 'text' || slack <= 1;
    if (attemptedInsertFirst) {
      try {f.store.tx(() => f.records.appendEntry({id: randomUUID(), runId: f.records.step(request.stepId).runId, kind: 'model_output', createdAt: at, payload: {json: {protocol: output.protocol, providerOutput: output.providerOutput}}}));}
      catch (error) {insertFirstError = String(error instanceof Error ? error.message : error);}
      assert.equal(insertFirstError, 'AGENT_TASK_STORAGE_LIMIT');
    }
    assert.equal(readMioStorage(f.store.db).usage.bytes, before.usage.bytes);
    let errorCode: string | null = null;
    try {f.store.tx(() => f.records.completeModelRequest(request.id, {entryId: randomUUID(), output, at}));}
    catch (error) {errorCode = String(error instanceof Error ? error.message : error);}
    const after = readMioStorage(f.store.db), saved = f.records.request(request.id);
    f.physical.sample();
    return {method: 'Actual256MiB quota/DDL unchanged. Unique blobs fill to the selected slack; archive text or tool-only output while clearing512KiB original in one production savepoint.', slack, outputKind, fillerRows, outputPayloadBytes: Buffer.byteLength(JSON.stringify(output)), before, after,
      formerInsertFirst: {attempted: attemptedInsertFirst, errorCode: insertFirstError, rolledBack: attemptedInsertFirst}, outcome: {errorCode, state: saved.state, originalBodyCleared: saved.originalBody === null, partialText: f.records.step(request.stepId).partialText, netBytes: after.usage.bytes - before.usage.bytes}, physical: f.physical.report()};
  } finally {f.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {'near-full': {type: 'boolean', default: false}, output: {type: 'string'}}});
  const report = {version: 1, retention: collectMioRecoveryRetention(), queue: await collectMioQueueBound(), ...(values['near-full'] ? {nearFull: collectMioNearFullArchive()} : {})};
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json); else process.stdout.write(json);
}

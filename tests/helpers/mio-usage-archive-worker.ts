import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../../packages/business/src/agent/mio-storage.ts';

const root = process.env.MIO_USAGE_ROOT, marker = process.env.MIO_USAGE_MARKER;
if (!root || !marker) throw new Error('Missing usage archive worker paths');
const store = openStore(root), records = createMioRecords(store), at = '2026-11-02T05:00:00.000Z';
const conversationId = randomUUID(), runId = randomUUID(), stepId = randomUUID(), requestId = randomUUID();
store.put('projects', {id: store.projectId, name: 'Usage archive crash synthetic'});
store.tx(() => {
  const shared = records.putBlob('{}', at);
  records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
  records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: createHash('sha256').update('send').digest('hex'), stepLimit: 30, budget: 30, locale: 'zh-Hans', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
  records.createStep({id: stepId, runId, kind: 'model', createdAt: at});
  records.beginRequest({id: requestId, stepId, assemblerVersion: 1, protocol: 'chat_completions', body: '{"privateRequest":true}', assembledAt: at,
    inputManifest: {version: 1, entryIds: [], noteEntryIds: [], configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: null, parameters: {}, viewVersion: 1}});
  records.markDispatched(requestId, at);
  records.updateStep(stepId, 'dispatch_started', {status: 'dispatch_started', partialText: 'DURABLE_PARTIAL', updatedAt: at});
});
const beforeStorage = readMioStorage(store.db);
store.db.function('usage_archive_barrier', () => {
  assert.equal(records.request(requestId).originalBody, null);
  assert.equal(records.request(requestId).state, 'completed');
  assert.equal(records.step(stepId).status, 'completed');
  assert.equal(records.step(stepId).resultEntryId, null);
  assert.equal(records.entries(runId).length, 0);
  readMioStorage(store.db); // Uncommitted deltas also equal the full inventory.
  writeFileSync(marker, JSON.stringify({runId, stepId, requestId, beforeStorage}));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Parent must kill this archive barrier');
});
store.db.exec("CREATE TEMP TRIGGER usage_archive_barrier BEFORE INSERT ON mio_entries WHEN NEW.kind='model_output' BEGIN SELECT usage_archive_barrier(); END");
store.tx(() => records.completeModelRequest(requestId, {entryId: randomUUID(), output: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'Complete'}, usage: {inputTokens: 100, cacheReadTokens: 20}}, at}));
throw new Error('Worker did not reach archive barrier');

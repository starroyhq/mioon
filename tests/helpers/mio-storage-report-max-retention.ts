import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../../packages/business/src/agent/mio-storage.ts';
import type {MioInputManifest} from '../../packages/contracts/src/mio-records.ts';
import {createPhysicalSampler, mioMeasurementSources, sha256} from './mio-storage-report.ts';

const at = '2026-01-01T00:00:00.000Z';

/** Worst-byte storage envelopes, not a claim that the normal assembler emits
 * a padding parameter. These exercise real row/body/checkpoint bounds without
 * disabling any FK, immutability or quota trigger. The fixed E allowance must
 * not assume a small manifest or one-byte JSON escaping. */
export function collectMioMaximumRetention() {
  const sourcesBefore = mioMeasurementSources();
  const ownSha256 = sha256(readFileSync(new URL(import.meta.url), 'utf8'));
  const states = [];
  for (const state of ['intent', 'failed', 'unknown', 'upgraded'] as const) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-mio-maximum-retention-'));
    const store = openStore(root), records = createMioRecords(store), physical = createPhysicalSampler(store);
    try {
      store.put('projects', {id: store.projectId, name: 'Maximum-byte storage envelope'});
      const conversationId = randomUUID(), runId = randomUUID(); let shared = '';
      store.tx(() => {
        shared = records.putBlob('{}', at);
        records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
        records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: sha256('maximum-byte synthetic recovery envelope'), stepLimit: 30, budget: 30, locale: 'en', configurationBlobHash: shared, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
      });
      const bodyValue = {syntheticContextPayload: ''};
      bodyValue.syntheticContextPayload = 'x'.repeat(524288 - Buffer.byteLength(JSON.stringify(bodyValue)));
      const body = JSON.stringify(bodyValue);
      const manifest: MioInputManifest = {version: 1, entryIds: [], noteEntryIds: [], configurationBlobHash: shared, toolsBlobHash: shared, systemBlobHash: shared, baselineBlobHash: shared, rulesBlobHash: null, parameters: {padding: ''}, viewVersion: 1};
      const before = readMioStorage(store.db);
      // Reserve512B for every request scalar, dispatch/completion timestamps,
      // previous-request identity, and the longer assembly/state labels.
      const manifestBudget = before.limits.rowBytes - Buffer.byteLength(body) - 512;
      manifest.parameters = {padding: 'x'.repeat(manifestBudget - Buffer.byteLength(JSON.stringify(manifest)))};
      assert.equal(Buffer.byteLength(JSON.stringify(manifest)), manifestBudget);
      const stepId = randomUUID(), requestId = randomUUID();
      const request = {id: requestId, stepId, assemblerVersion: 1, protocol: 'chat_completions' as const, body, inputManifest: manifest, assembledAt: at};
      store.tx(() => {
        records.createStep({id: stepId, runId, kind: 'model', createdAt: at}); records.beginRequest(request);
        if (state === 'upgraded') records.reassembleRequest(requestId, {...request, id: randomUUID(), assemblerVersion: 2}, randomUUID());
        else if (state !== 'intent') {
          records.markDispatched(requestId, at);
          const partial = '\0'.repeat(256 * 1024);
          assert.equal(Buffer.byteLength(partial), 262144);
          records.updateStep(stepId, 'dispatch_started', {status: 'dispatch_started', updatedAt: at, partialText: JSON.stringify(partial), data: {partialEncoding: 'json'}});
          records.failRequest(requestId, state, at);
        }
        physical.sample();
      });
      physical.sample();
      const after = readMioStorage(store.db), requestTable = after.tables.find(table => table.name === 'mio_requests')!;
      const requestCount = state === 'upgraded' ? 2 : 1;
      assert.ok(requestTable.bytes / requestCount > before.limits.rowBytes - 512);
      assert.ok(requestTable.bytes / requestCount <= before.limits.rowBytes);
      const partial = records.step(stepId).partialText;
      const partialStoredBytes = partial === null ? 0 : Buffer.byteLength(partial);
      assert.equal(partialStoredBytes, state === 'failed' || state === 'unknown' ? 1572866 : 0);
      const bodies = Number(store.db.prepare('SELECT sum(length(CAST(originalBody AS BLOB))) AS n FROM mio_requests').get()!.n);
      assert.equal(bodies, requestCount * 524288);
      states.push({state, originalBodyBytes: bodies, manifestBytesPerRequest: manifestBudget, retainedRequestTableBytes: requestTable.bytes,
        decodedCheckpointBytes: partial === null ? 0 : 262144, storedCheckpointBytes: partialStoredBytes,
        wholeScenario: after.usage, increment: {bytes: after.usage.bytes - before.usage.bytes, rows: after.usage.rows - before.usage.rows}, after, physical: physical.report()});
    } finally {store.close(); rmSync(root, {recursive: true, force: true});}
  }
  assert.deepEqual(mioMeasurementSources(), sourcesBefore, 'Maximum-retention sources changed during measurement');
  return {version: 1, method: 'Real K1/MioRecords boundary envelopes:512KiB raw original plus manifest near2MiB total request-row limit; failed/unknown retain the256KiB decoded journal checkpoint using NUL bytes (JSON escaping makes1.5MiB stored). A one-version upgrade retains two bounded originals/manifests. These are allowed storage envelopes rather than protocol-valid real-runtime assemblies.', provenance: {sourcesBefore, sourcesAfter: mioMeasurementSources(), helperSha256: ownSha256}, states};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {output: {type: 'string'}}});
  const json = JSON.stringify(collectMioMaximumRetention(), null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json); else process.stdout.write(json);
}

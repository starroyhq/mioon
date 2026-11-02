import test from 'node:test';
import assert from 'node:assert/strict';
import {collectMioStorageReport} from './helpers/mio-storage-report.ts';
import {collectMioNearFullArchive, collectMioQueueBound, collectMioRecoveryRetention} from './helpers/mio-storage-report-recovery.ts';
import {collectMioMaximumRetention} from './helpers/mio-storage-report-max-retention.ts';

test('K1 stress report archives all thirty real runtime steps and reconstructs every captured wire vector from entries', {timeout: 600_000}, async () => {
  const report = await collectMioStorageReport({protocols: ['responses'], rounds: 1, independentProject: false, deltaIntervalMs: 0});
  const project = report.projects[0]!, round = project.rounds[0]!;
  assert.equal(report.runtime, 'K1/createMioRuntime');
  assert.equal(round.status, 'completed'); assert.equal(round.stepsUsed, 30);
  assert.equal(round.models.length, 15); assert.equal(round.tools.length, 15);
  assert.ok(round.tools.every(tool => tool.resultBytes === 20480));
  assert.equal(round.retained.tables.length, 18);
  assert.equal(round.retained.bytes, round.retained.tables.reduce((n, table) => n + table.bytes, 0));
  assert.equal(round.retained.rows, round.retained.tables.reduce((n, table) => n + (table.countedRows ? table.rows : 0), 0));
  assert.ok(round.requests.every(request => /^[a-f0-9]{64}$/u.test(request.sha256)));
  assert.equal(round.networkRequestBytes, round.requests.reduce((n, request) => n + request.bytes, 0));
  assert.equal(round.streaming.appendCalls, 60);
  assert.ok(project.physical.peak.journalBytes > 0);
});

test('maximum pending, failed, unknown and upgrade fixtures count retained originals and checkpoints', () => {
  const report = collectMioRecoveryRetention();
  for (const row of report.states) {
    assert.equal(row.retainedBodyBytes, row.state === 'upgraded' ? 1048576 : 524288);
    assert.ok(row.retained.bytes > row.retainedBodyBytes);
  }
  const failed = report.states.find(row => row.state === 'failed')!, unknown = report.states.find(row => row.state === 'unknown')!;
  assert.equal(failed.partialCheckpointLimitBytes, 262144); assert.equal(unknown.partialCheckpointLimitBytes, 262144);
});

test('same-project runtime refuses eight concurrent sends behind one held request', async () => {
  const report = await collectMioQueueBound();
  assert.equal(report.accepted, 1); assert.equal(report.refused, 8); assert.equal(report.pendingRequests, 1);
});

test('maximum-byte recovery envelopes include near-full request rows and JSON-expanded checkpoints', () => {
  const report = collectMioMaximumRetention();
  for (const state of report.states) {
    assert.equal(state.originalBodyBytes, state.state === 'upgraded' ? 1048576 : 524288);
    const requestCount = state.state === 'upgraded' ? 2 : 1;
    assert.ok(state.retainedRequestTableBytes / requestCount > 2097152 - 512);
    if (state.state === 'failed' || state.state === 'unknown') {
      assert.equal(state.decodedCheckpointBytes, 262144);
      assert.equal(state.storedCheckpointBytes, 1572866);
    }
  }
});

test('near-full archive succeeds when the completed output replaces a larger raw request', {timeout: 120_000}, () => {
  const report = collectMioNearFullArchive();
  assert.equal(report.before.remaining.bytes, 1024);
  assert.equal(report.formerInsertFirst.errorCode, 'AGENT_TASK_STORAGE_LIMIT');
  assert.equal(report.outcome.errorCode, null);
  assert.equal(report.outcome.state, 'completed'); assert.equal(report.outcome.originalBodyCleared, true);
  assert.ok(report.outcome.netBytes < 0);
});

test('zero and one byte of quota slack permit net-shrinking text and tool-only archival', {timeout: 120_000}, () => {
  for (const slack of [0, 1] as const) for (const output of ['text', 'tool_only'] as const) {
    const report = collectMioNearFullArchive({slack, output});
    assert.equal(report.before.remaining.bytes, slack);
    assert.equal(report.outcome.errorCode, null);
    assert.equal(report.outcome.state, 'completed');
    assert.equal(report.outcome.originalBodyCleared, true);
    assert.equal(report.outcome.partialText, null);
    assert.ok(report.outcome.netBytes < 0);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAgentTaskContextReport, contextReportScenario} from './helpers/agent-task-context-report.ts';

test('streaming measurements opt into an explicit simulated delta interval', () => {
  assert.equal(Object.hasOwn(contextReportScenario(), 'deltaIntervalMs'), false);
  assert.equal(contextReportScenario({deltaIntervalMs: 0}).deltaIntervalMs, 0);
  assert.equal(contextReportScenario({stress30Steps: true, deltaIntervalMs: 80}).deltaIntervalMs, 80);
  for (const deltaIntervalMs of [-1, 0.5, 60_001, Number.NaN]) assert.throws(() => contextReportScenario({deltaIntervalMs}), /deltaIntervalMs/u);
  assert.equal(contextReportScenario({deltaIntervalMs: 80, tailPauseMs: 0}).tailPauseMs, 0);
  assert.throws(() => contextReportScenario({tailPauseMs: 1000}), /tailPauseMs/u);
  for (const tailPauseMs of [-1, 0.5, 60_001, Number.NaN]) assert.throws(() => contextReportScenario({deltaIntervalMs: 80, tailPauseMs}), /tailPauseMs/u);
});

test('paced streaming reports record complete row rewrites and event inserts in three protocols', {timeout: 120_000}, async () => {
  const report = await collectAgentTaskContextReport({toolRounds: 1, replyBytes: 30 * 1024, deltaBytes: 3 * 1024, deltaIntervalMs: 80});
  for (const measured of report.protocols) {
    assert.equal(measured.run.status, 'completed');
    assert.equal(measured.run.stepsUsed, 3);
    assert.equal(measured.streaming!.clock, 'simulated');
    assert.equal(measured.streaming!.deltaIntervalMs, 80);
    assert.equal(measured.streaming!.appendCalls, 8);
    assert.equal(measured.run.textEvents, measured.streaming!.appendCalls);
    assert.equal(measured.streaming!.rowRewriteBytes, measured.modelSteps.reduce((sum, step) => sum + step.streaming!.rowRewriteBytes, 0));
    assert.equal(measured.streaming!.textEventBytes, measured.modelSteps.reduce((sum, step) => sum + step.streaming!.textEventBytes, 0));
    for (const step of measured.modelSteps) {
      const streaming = step.streaming!;
      assert.deepEqual(streaming.flushes.map(flush => flush.atMs), [240, 480, 720, 800]);
      assert.deepEqual(streaming.flushes.map(flush => flush.deltaBytes), [9 * 1024, 9 * 1024, 9 * 1024, 3 * 1024]);
      assert.deepEqual(streaming.flushes.map(flush => flush.textBytes), [9 * 1024, 18 * 1024, 27 * 1024, 30 * 1024]);
      assert.equal(step.textEvents, streaming.flushes.length);
      assert.equal(step.textBytes, 30 * 1024);
      assert.equal(streaming.rowRewriteBytes, streaming.flushes.reduce((sum, flush) => sum + flush.rowRewriteBytes, 0));
      for (const [index, flush] of streaming.flushes.entries()) {
        assert.ok(flush.rowRewriteBytes > flush.textBytes, 'Each measured rewrite includes the complete saved request and step, beyond only the streamed text');
        assert.ok(flush.textEventBytes > flush.deltaBytes, 'Each inserted event includes its envelope');
        if (index) assert.equal(flush.rowRewriteBytes - streaming.flushes[index - 1]!.rowRewriteBytes, flush.deltaBytes, 'Appending ASCII text enlarges the actual full data row by exactly that delta');
      }
    }
    const textTable = measured.retained.tables.find(table => table.name === 'agent_task_events_v2')!;
    assert.ok(textTable.bytes > measured.streaming!.textEventBytes, 'The event table also retains non-text events');
    assert.ok(measured.retained.quotaBytes > 0);
    assert.ok(measured.capacity.additionalEquivalentRuns !== null);
  }
});

test('slow paced deltas exercise time flushes without real waiting', {timeout: 120_000}, async () => {
  const report = await collectAgentTaskContextReport({protocols: ['responses'], toolRounds: 1, replyBytes: 9 * 1024, deltaBytes: 3 * 1024, deltaIntervalMs: 300});
  const measured = report.protocols[0]!;
  assert.equal(measured.run.status, 'completed');
  assert.equal(measured.streaming!.appendCalls, 6);
  for (const step of measured.modelSteps) {
    assert.deepEqual(step.streaming!.flushes.map(flush => flush.atMs), [300, 600, 900]);
    assert.deepEqual(step.streaming!.flushes.map(flush => flush.deltaBytes), [3 * 1024, 3 * 1024, 3 * 1024]);
  }
});

test('zero-time streaming measurements are repeatable and keep the clock restored', {timeout: 120_000}, async () => {
  const options = {protocols: ['responses'] as const, toolRounds: 1, replyBytes: 30 * 1024, deltaBytes: 3 * 1024, deltaIntervalMs: 0};
  const before = Date.now();
  const first = (await collectAgentTaskContextReport(options)).protocols[0]!;
  assert.ok(Date.now() >= before);
  const second = (await collectAgentTaskContextReport(options)).protocols[0]!;
  assert.deepEqual(first.requests, second.requests);
  assert.deepEqual(first.modelSteps, second.modelSteps);
  assert.deepEqual(first.retained, second.retained);
  assert.deepEqual(first.streaming, second.streaming);
  for (const step of first.modelSteps) assert.deepEqual(step.streaming!.flushes.map(flush => flush.atMs), [0, 0, 0, 0]);
});

test('streaming measurements observe small pending text during a tail pause before completion', {timeout: 120_000}, async () => {
  const report = await collectAgentTaskContextReport({toolRounds: 1, replyBytes: 2700, deltaBytes: 900, deltaIntervalMs: 200, tailPauseMs: 1000});
  assert.equal(report.scenario.tailPauseMs, 1000);
  for (const measured of report.protocols) {
    assert.equal(measured.run.status, 'completed');
    for (const step of measured.modelSteps) {
      assert.deepEqual(step.streaming!.beforeDone, {textBytes: 2700, textEvents: 3}, 'The idle tail is persisted by the scheduled deadline while the gateway is still open');
      assert.deepEqual(step.streaming!.flushes.map(flush => flush.atMs), [250, 500, 750]);
      assert.deepEqual(step.streaming!.flushes.map(flush => flush.deltaBytes), [900, 900, 900]);
      assert.equal(step.streaming!.flushes.length, step.textEvents, 'Finishing after a timed flush cannot append an empty text event');
      assert.equal(step.textBytes, 2700);
    }
    assert.equal(measured.streaming!.appendCalls, 6);
  }
});

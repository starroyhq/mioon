import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAgentTaskContextReport, contextReportScenario} from './helpers/agent-task-context-report.ts';

test('workload options preserve the original context report defaults', () => {
  assert.deepEqual(contextReportScenario(), {toolRounds: 14, replyBytes: 30 * 1024, deltaBytes: 3 * 1024, stepLimit: 30});
  assert.deepEqual(contextReportScenario({stress30Steps: false}), contextReportScenario());
  assert.deepEqual(contextReportScenario({toolRounds: 1, replyBytes: 16, deltaBytes: 8}), {toolRounds: 1, replyBytes: 16, deltaBytes: 8, stepLimit: 30});
  for (const options of [{toolRounds: 15}, {replyBytes: 0}, {deltaBytes: -1}]) assert.throws(() => contextReportScenario(options));
});

test('workload options select a fixed thirty-step observation stress case', () => {
  const scenario = contextReportScenario({stress30Steps: true});
  assert.deepEqual(scenario, {toolRounds: 14, replyBytes: 30 * 1024, deltaBytes: 3 * 1024, stepLimit: 30, stress30Steps: true, toolResultBytes: 20 * 1024, firstRoundToolCalls: 2});
  assert.equal(scenario.toolRounds + 1 + scenario.toolRounds - 1 + scenario.firstRoundToolCalls!, 30, 'Fifteen models and fifteen tools consume the unchanged thirty-step budget');
  for (const options of [{toolRounds: 14}, {replyBytes: 30 * 1024}, {deltaBytes: 3 * 1024}]) assert.throws(() => contextReportScenario({stress30Steps: true, ...options}), /fixed workload/u);
});

test('a small legacy context measurement keeps the old result shape and records actual retained rows', async () => {
  const report = await collectAgentTaskContextReport({protocols: ['responses'], toolRounds: 1, replyBytes: 16, deltaBytes: 8});
  assert.deepEqual(report.scenario, {toolRounds: 1, replyBytes: 16, deltaBytes: 8, stepLimit: 30});
  const measured = report.protocols[0]!;
  assert.equal(measured.run.status, 'completed');
  assert.equal(measured.run.stepsUsed, 3);
  assert.equal(measured.requests.length, 2);
  assert.equal(measured.modelSteps.length, 2);
  assert.ok(measured.retained.quotaBytes > 0);
  assert.ok(measured.retained.quotaRows > 0);
  assert.equal(Object.hasOwn(measured, 'toolSteps'), false);
  assert.equal(measured.tokenUsage, null);
});

test('the thirty-step stress measurement retains complete twenty-KiB tool results in the journal', {timeout: 120_000}, async () => {
  const report = await collectAgentTaskContextReport({protocols: ['responses'], stress30Steps: true});
  const measured = report.protocols[0]!;
  assert.equal(measured.run.status, 'completed');
  assert.equal(measured.run.reason, null);
  assert.equal(measured.run.stepsUsed, 30);
  assert.equal(measured.run.budget, 30);
  assert.equal(measured.requests.length, 15);
  assert.equal(measured.modelSteps.length, 15);
  assert.equal(measured.toolSteps?.length, 15);
  for (const tool of measured.toolSteps!) {
    assert.equal(tool.toolName, 'mioon_project_inspect');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.resultBytes, 20 * 1024);
    assert.ok(tool.storedDataBytes > tool.resultBytes);
  }
  assert.equal(measured.tokenUsage, null);
});

import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {buildTaskModelRequest, taskContinuation, TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {isTimelineMixLoudnessResponse, timelineMixLoudnessInputSchema} from '../packages/contracts/src/timeline-mix-loudness.ts';
import {isTimelineLoudnessApplicableReport, timelineLoudnessCandidateDigest} from '../packages/contracts/src/timeline-loudness-apply.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {mixLoudnessInput, readyMixLoudness, silentMixLoudness} from './fixtures/timeline-mix-loudness-fixtures.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-loudness-binding-v2-'));
  const store = openStore(root), services = createServices(store, new Map());
  let disposeTools = () => {};
  t.after(async () => {disposeTools(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const project = record(await services.call('project.create', {name: 'Synthetic loudness binding'}));
  const foreign = record(await services.call('project.create', {name: 'Foreign synthetic loudness binding'}));
  const projectId = String(project.id), foreignProjectId = String(foreign.id);
  const timeline = record(await services.call('timeline.get', {projectId}));
  const input = timelineMixLoudnessInputSchema.parse({...mixLoudnessInput, projectId,
    expectedRevision: timeline.revision, target: {integratedLufs: -24, truePeakCeilingDbtp: -1}});
  const {projectId: _hostProject, ...argumentsValue} = input;
  const report = readyMixLoudness(input);
  report.identity.timelineId = String(timeline.id);
  let response: unknown = report;
  const calls: Array<{operation: string; input: unknown}> = [];
  const localServices = {...services, async call(operation: string, value: unknown, context?: Parameters<typeof services.call>[2]) {
    if (operation === 'timeline.loudness.prepare' || operation === 'project.inspect') {
      calls.push({operation, input: structuredClone(value)});
      return response;
    }
    throw new Error(`Unexpected local operation: ${operation}`);
  }};
  const tools = createAgentTaskTools({store, services: localServices}), journal = createAgentTaskJournal(store);
  disposeTools = () => tools.dispose();
  const run = journal.create({projectId, requestId: randomUUID(), text: 'Synthetic loudness candidate binding', configuration: {}}).run;
  async function execute(operation = 'timeline.loudness.prepare', toolInput: Record<string, unknown> = argumentsValue) {
    const prepared = tools.prepare({projectId, operation, input: toolInput});
    const name = `mioon_${operation.replaceAll('.', '_')}`;
    const step = journal.beginStep(run.id, {kind: 'tool', tier: prepared.risk, targets: prepared.targets,
      toolCall: {id: randomUUID(), name, arguments: toolInput as AgentTaskJson}});
    journal.markDispatch(run.id, step.id);
    const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
      beforeEffect: () => journal.assertTargets(projectId, prepared.targets),
      recordInside: (result, changes) => journal.completeStepInside(run.id, step.id, {result, changes})});
    if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
    return {...outcome, stepId: step.id};
  }
  return {store, tools, journal, run, projectId, foreignProjectId, timeline, input, argumentsValue, report, calls,
    respond(value: unknown) {response = value;}, execute};
}

test('Mio receives the shared digest of its complete applicable report without changing the original report or permission', async t => {
  const f = await fixture(t), before = structuredClone(f.report), savedTimeline = structuredClone(f.timeline);
  assert.equal(isTimelineLoudnessApplicableReport(f.report), true);
  freeze(f.report);
  const outcome = await f.execute(), result = record(outcome.result);
  const {candidateDigest, ...returnedReport} = result;
  assert.equal(candidateDigest, await timelineLoudnessCandidateDigest(f.report));
  assert.deepEqual(returnedReport, before); assert.deepEqual(f.report, before);
  assert.equal(Object.hasOwn(f.report, 'candidateDigest'), false);
  assert.equal(isTimelineMixLoudnessResponse(f.report, f.input), true);
  assert.equal(result.applyAllowed, false); assert.equal(record(result.candidate).applyAllowed, false);
  assert.equal(candidateDigest, await timelineLoudnessCandidateDigest(returnedReport));
  assert.deepEqual(outcome.changes, []); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  assert.deepEqual(f.journal.step(outcome.stepId).result, outcome.result);
  assert.deepEqual(f.store.get('timelines', String(f.timeline.id)), savedTimeline);
  assert.equal(f.store.list('jobs', f.projectId).length, 0);
  assert.deepEqual(f.calls.map(call => call.operation), ['timeline.loudness.prepare']);
});

test('unavailable, unsafe and unchanged complete observations receive no actionable digest', async t => {
  const f = await fixture(t);
  const cases = [
    silentMixLoudness(f.input),
    readyMixLoudness({...f.input, target: {integratedLufs: -16, truePeakCeilingDbtp: -1}}),
    readyMixLoudness({...f.input, target: {integratedLufs: -20, truePeakCeilingDbtp: -1}}),
  ];
  for (const report of cases) {
    report.identity.timelineId = String(f.timeline.id);
    assert.equal(isTimelineMixLoudnessResponse(report), true);
    assert.equal(isTimelineLoudnessApplicableReport(report), false);
    f.respond(report);
    const input = {...f.argumentsValue, target: report.target};
    const outcome = await f.execute('timeline.loudness.prepare', input);
    assert.deepEqual(outcome.result, report); assert.deepEqual(outcome.changes, []);
    assert.equal(Object.hasOwn(record(outcome.result), 'candidateDigest'), false);
    assert.equal(record(outcome.result).applyAllowed, false);
  }
});

test('a malformed, forged or mismatched prepare report fails explicitly instead of producing a binding', async t => {
  const f = await fixture(t);
  const invalid = [
    null, '[truncated]', {...f.report, candidateDigest: `timeline-loudness-candidate-v1:${'f'.repeat(64)}`},
    {...f.report, applyAllowed: true}, {...f.report, approved: true},
    {...f.report, candidate: {...f.report.candidate, measurement: null}},
    {...f.report, candidate: {...f.report.candidate, applyAllowed: true}},
    {...f.report, checks: {...f.report.checks, passes: 1}},
    {...f.report, projectId: f.foreignProjectId},
    readyMixLoudness({...f.input, expectedRevision: f.input.expectedRevision + 1}),
    readyMixLoudness({...f.input, target: {integratedLufs: -25, truePeakCeilingDbtp: -2}}),
  ];
  for (const report of invalid) {
    f.respond(report);
    await assert.rejects(f.execute(), {code: 'AGENT_TASK_INVALID_TOOL_RESULT'});
  }
  assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  assert.equal(f.store.list('jobs', f.projectId).length, 0);
});

test('descriptor and report bounds reject getters and incomplete oversized data before projection', async t => {
  const f = await fixture(t); let getterCalls = 0;
  const accessor = {...f.report};
  Object.defineProperty(accessor, 'candidate', {enumerable: true, get() {getterCalls++; return f.report.candidate;}});
  const tooManySources = {...f.report, identity: {...f.report.identity, sources: Array.from({length: 201}, () => f.report.identity.sources[0])}};
  const incomplete = {...f.report, candidate: {...f.report.candidate, gains: '[truncated]'}};
  for (const report of [accessor, tooManySources, incomplete, {...f.report, checkedAt: 'x'.repeat(16001)}]) {
    f.respond(report); await assert.rejects(f.execute(), {code: 'AGENT_TASK_INVALID_TOOL_RESULT'});
  }
  assert.equal(getterCalls, 0);
});

test('the maximum complete source and gain arrays survive projection and both model protocols without partial bindings', async t => {
  const f = await fixture(t), report = structuredClone(f.report);
  const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  report.identity.sources = Array.from({length: 100}, (_, index) => ({assetId: id(index + 101), sha256: 'a'.repeat(64), sizeBytes: 1024}));
  report.candidate.gains = report.identity.sources.map((source, index) => ({clipId: id(index + 1), assetId: source.assetId,
    beforeGain: 1, afterGain: report.candidate.gainMultiplier!}));
  report.checks.bytesHashed = 2 * 100 * 1024;
  assert.equal(isTimelineMixLoudnessResponse(report, f.input), true);
  f.respond(report);
  const {result} = await f.execute(), value = record(result), {candidateDigest, ...returnedReport} = value;
  assert.deepEqual(returnedReport, report);
  assert.equal(candidateDigest, await timelineLoudnessCandidateDigest(returnedReport));
  assert.equal((record(value.identity).sources as unknown[]).length, 100);
  assert.equal((record(value.candidate).gains as unknown[]).length, 100);
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const call = {id: 'synthetic-call', name: 'mioon_timeline_loudness_prepare', arguments: f.argumentsValue as AgentTaskJson};
    const providerOutput: AgentTaskJson = protocol === 'chat_completions'
      ? {role: 'assistant', tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}]}
      : [{type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments)}];
    const history = taskContinuation(protocol, {text: '', toolCalls: [call], providerOutput}, [{callId: call.id, result}]);
    const serialized = protocol === 'chat_completions' ? record(history.at(-1)).content : record(history.at(-1)).output;
    assert.deepEqual(JSON.parse(String(serialized)), result);
    const body = JSON.parse(buildTaskModelRequest({...DEFAULT_AGENT_CONFIGURATION, protocol}, history, [], 4318));
    assert.ok(JSON.stringify(body).includes(String(candidateDigest)));
    assert.throws(() => buildTaskModelRequest({...DEFAULT_AGENT_CONFIGURATION, protocol},
      [...history, {role: 'user', content: 'x'.repeat(TASK_MODEL_LIMITS.historyBytes)}], [], 4318), {code: 'AGENT_CHAT_LIMIT'});
  }
});

test('other tool results are not augmented and the model cannot supply a prepare binding or project authority', async t => {
  const f = await fixture(t);
  const outcome = await f.execute('project.inspect', {});
  assert.deepEqual(outcome.result, f.report); assert.equal(Object.hasOwn(record(outcome.result), 'candidateDigest'), false);
  assert.throws(() => f.tools.prepare({projectId: f.projectId, operation: 'timeline.loudness.prepare', input: {
    ...f.argumentsValue, candidateDigest: `timeline-loudness-candidate-v1:${'f'.repeat(64)}`,
  }}), {code: 'VALIDATION_ERROR'});
  assert.throws(() => f.tools.prepare({projectId: f.projectId, operation: 'timeline.loudness.prepare', input: {
    ...f.argumentsValue, projectId: f.foreignProjectId,
  }}), {code: 'AGENT_TASK_INVALID_TOOL'});
  assert.deepEqual(f.calls.map(call => call.operation), ['project.inspect']);
  assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTimelineMutationResponse } from '@mioon/contracts';
import { createEditTaskClient, isDurableEditOperation } from '../apps/web/src/edit-task-client.ts';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.ts';
import { createTimelineLoudnessApplyController } from '../apps/web/src/timeline-loudness-apply-state.ts';
import { timelineMixLoudnessViewState } from '../apps/web/src/timeline-mix-loudness-state.ts';
import { submitTimelineLoudnessApply } from '../apps/web/src/timeline-loudness-apply-submit.ts';
import { timelineLoudnessCandidateDigest } from '@mioon/contracts/timeline-loudness-apply';
import { id, input, report, context as mixContext, projectId, timelineId, fixture } from './helpers/timeline-mix-loudness-ui-fixture.mjs';
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const durable = part('  async function run(', '  async function runSession(');
const mutate = part('  async function mutateTimeline(', '  async function selectClip(');
const apply = part('  const timelineLoudnessApply = useTimelineLoudnessApply(', '  const effectivePlayhead =');
const operation = 'timeline.loudness.apply', stamp = '2026-10-14T00:00:00.000Z';
async function intent() {
  const value = report(input());
  return { operation, scope: mixContext().scope, timelineId, sourceIdentity: mixContext().sourceIdentity, executionScope: mixContext().executionScope,
    input: { ...input(), requestId: 'one-original-apply-key', snapshotSha256: value.identity.snapshotSha256, candidateDigest: await timelineLoudnessCandidateDigest(value) } };
}
function result(exact) {
  const value = report(input()), gain = value.candidate.gains[0];
  const timeline = { id: timelineId, projectId, revision: exact.expectedRevision + 1, fps: 30, width: 720, height: 1280, durationFrames: 60,
    createdAt: stamp, updatedAt: stamp, tracks: [{ id: id(7), name: 'Audio', kind: 'audio', orderIndex: 0, muted: false, hidden: false }],
    clips: [{ id: gain.clipId, trackId: id(7), assetId: gain.assetId, name: 'Audio', startFrame: 0, sourceInFrame: 0, durationFrames: 60, gain: gain.afterGain, rect: { x: 0, y: 0, width: 720, height: 1280 } }] };
  return { operation, requestId: exact.requestId, timeline, application: { candidateDigest: exact.candidateDigest, snapshotSha256: exact.snapshotSha256,
    mixProfile: exact.mixProfile, measurementProfile: exact.measurementProfile, target: exact.target, beforeRevision: exact.expectedRevision, afterRevision: exact.expectedRevision + 1,
    gainMultiplier: value.candidate.gainMultiplier, gains: value.candidate.gains, original: value.original, candidate: value.candidate.measurement, meetsTarget: true, meetsTruePeak: true, marginDb: .5 } };
}
function server({ lose, invalidAck = false } = {}) {
  let task = null, instanceId = id(71), once = lose; const calls = [];
  const reply = data => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, body, method: options.method });
    if (path.startsWith('/api/tasks?')) return reply({ items: task && !task.acknowledged ? [task] : [], nextCursor: null, instanceId });
    if (path === '/api/tasks/prepare') {
      task = { id: id(70), projectId: body.projectId, operation: body.operation, input: structuredClone(body.input), requestId: body.input.requestId,
        digest: 'd'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp, acknowledged: false, origin: body.origin };
      if (once === 'prepare') { once = null; throw Error('Lost persisted prepare response'); }
      return reply({ task, instanceId });
    }
    if (path.endsWith('/execute')) {
      assert.equal(body.instanceId, instanceId); task = { ...task, status: 'applied', revision: task.revision + 2 };
      if (once === 'execute') { once = null; throw Error('Lost committed execute response'); }
      const ack = result(task.input); if (invalidAck) ack.requestId = 'wrong-request-key';
      return reply({ task, instanceId, result: ack });
    }
    if (path.endsWith('/acknowledge')) { task = { ...task, acknowledged: true, revision: task.revision + 1 }; return reply({ task, instanceId }); }
    if (path.startsWith(`/api/tasks/${id(70)}?`)) return reply({ task, instanceId });
    throw Error(`Unexpected request ${path}`);
  };
  return { fetcher, calls, get task() { return task; }, restart() { instanceId = id(72); } };
}
async function harness(wire, onBusy = () => {}) {
  const client = createEditTaskClient({ fetcher: wire.fetcher }), tasks = createEditTaskController({ client }); await tasks.load(projectId);
  const busy = new Set(), refreshed = [], recovered = [], notices = [];
  const currentProject = { current: projectId }, dataRef = { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4 }, timelineHistory: { revision: 4 } } };
  let options, keys = 0, epoch = 0;
  const env = {
    readTimelineLoudnessRecoveryScope: () => 'test-workspace-identity', nativeCloseRegistry: { current: undefined }, isDurableEditOperation, isTimelineMutationResponse, submitTimelineLoudnessApply, tasksRef: { current: tasks }, currentProject, dataRef,
    timelinePending: false, requestId: () => `unused-generated-key-${++keys}`, context: () => ({ projectId: currentProject.current, epoch }), isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === epoch,
    captureTaskWorkspaceIntent: () => () => true, readTaskRevealContext: () => ({}), pendingForProject: () => [], isMutationOperation: () => false,
    isBusy: key => busy.has(key), markBusy: (_projectId, key, value) => { if (value) busy.add(key); else busy.delete(key); onBusy(value); },
    requestCounter: { current: 0 }, setData: update => { dataRef.current = update(dataRef.current); }, refresh: async owner => { refreshed.push(owner); },
    notify: message => notices.push(message), openTasks: () => undefined, setAuth: () => undefined, readableError: error => error.message,
    runSession: () => { throw Error('Loudness must not use the legacy session path'); },
    timelineFormatRef: { current: null }, subtitlesRef: { current: null }, timelineLoudnessApplyRef: { current: { controller: { recovered: task => recovered.push(task) } } },
    useTimelineLoudnessApply: value => { options = value; return env.timelineLoudnessApplyRef.current; }, confirm: async () => true,
  };
  const actual = Function(...Object.keys(env), `${durable}\n${mutate}\n${apply}\nreturn {run, mutateTimeline, recoverTask};`)(...Object.values(env));
  return { ...actual, submit: options.submit, tasks, refreshed, recovered, notices, currentProject, keys: () => keys, navigate: () => { epoch++; } };
}
test('actual App callback routes scalar request through real task client prepare/execute/ACK; no direct RPC or gain array', async () => {
  const wire = server(), h = await harness(wire), exact = await intent();
  assert.equal((await h.submit(exact, () => true)).status, 'applied');
  assert.deepEqual(wire.calls.map(call => call.path.split('?')[0]), ['/api/tasks','/api/tasks/prepare',`/api/tasks/${id(70)}/execute`,`/api/tasks/${id(70)}/acknowledge`]);
  assert.deepEqual(wire.calls[1].body.input, exact.input); assert.equal(wire.calls[1].body.input.requestId, 'one-original-apply-key');
  assert.equal(Object.hasOwn(wire.calls[1].body.input, 'gains'), false); assert.equal(Object.hasOwn(wire.calls[2].body, 'input'), false);
  assert.equal(h.tasks.blocked(projectId), false); assert.deepEqual(h.refreshed, [projectId]);
});
for (const lose of ['prepare','execute']) test(`actual App unknown ${lose} survives controller/server restart and recovers original key without a new prepare`, async () => {
  const wire = server({ lose }), h = await harness(wire), exact = await intent();
  assert.equal((await h.submit(exact, () => true)).status, 'unknown'); assert.equal(h.tasks.blocked(projectId), true);
  assert.equal(wire.task.requestId, exact.input.requestId); assert.deepEqual(wire.task.input, exact.input);
  wire.restart(); const next = await harness(wire), saved = next.tasks.getState(projectId).items[0];
  assert.equal(saved.requestId, exact.input.requestId); assert.deepEqual(saved.input, exact.input);
  await next.recoverTask(saved); assert.equal(next.tasks.blocked(projectId), false); assert.equal(wire.task.acknowledged, true);
  assert.equal(wire.calls.filter(call => call.path === '/api/tasks/prepare').length, 1);
  assert.equal(wire.calls.filter(call => call.path.endsWith('/execute')).length, 1);
  assert.equal(next.recovered[0].requestId, exact.input.requestId);
});
test('late navigation after persisted prepare leaves original durable task recoverable without execute', async () => {
  const wire = server(), original = wire.fetcher; let allowed = true;
  wire.fetcher = async (...args) => { const value = await original(...args); if (args[0] === '/api/tasks/prepare') allowed = false; return value; };
  const h = await harness(wire), exact = await intent(); assert.equal((await h.submit(exact, () => allowed)).status, 'unknown');
  assert.equal(wire.task.status, 'prepared'); assert.equal(wire.calls.some(call => call.path.endsWith('/execute')), false);
  assert.deepEqual(h.tasks.getState(projectId).items[0].input, exact.input);
});
test('malformed application ACK cannot release durable lane or become UI success', async () => {
  const wire = server({ invalidAck: true }), h = await harness(wire), exact = await intent();
  assert.equal((await h.submit(exact, () => true)).status, 'unknown'); assert.equal(h.tasks.blocked(projectId), true);
  assert.equal(wire.calls.some(call => call.path.endsWith('/acknowledge')), false);
});
test('apply is nested in the existing delivery card and recovers through existing TaskCenter only', () => {
  assert.match(app, /<TimelineMixLoudness loudness=\{timelineMixLoudness\}[^>]*onRevokeApply/);
  assert.match(app, /apply=\{<TimelineLoudnessApply apply=\{timelineLoudnessApply\}/);
  assert.match(app, /timelineLoudnessApplyRef\.current\?\.controller\.recovered\(acknowledgedTask, loudnessRecoveryScope\)/);
  assert.doesNotMatch(apply, /rpc\(|exportSettings.*choose|localStorage|sessionStorage|gains/);
});

test('actual review and App durable path tolerate only their own validated prepared-task pending fence', async () => {
  const observation = fixture(); observation.edit(); await observation.ready();
  const wire = server(), h = await harness(wire, pending => observation.set({ pending }));
  const controller = createTimelineLoudnessApplyController({ getObservation: () => timelineMixLoudnessViewState(observation.state(), observation.live()),
    createRequestId: () => 'review-and-app-original-key', confirm: async () => true, submit: h.submit }); controller.attach();
  const outcome = await controller.review(observation.state()); assert.equal(outcome.status,'applied');
  assert.equal(wire.task.requestId,'review-and-app-original-key'); assert.equal(wire.task.acknowledged,true);
  assert.equal(wire.calls.filter(call=>call.path.endsWith('/execute')).length,1);
});

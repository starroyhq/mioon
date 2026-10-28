import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices, type JobRecord} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createTaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import type {AgentTaskControlInput} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, 'Synthetic recovery state did not settle');
    await delay(5);
  }
}

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
function response(calls: Array<{name: string; arguments: unknown}> = []): string {
  return frame({choices: [{index: 0, delta: {content: calls.length ? '' : '原任务处理完毕', ...(calls.length ? {
    tool_calls: calls.map((call, index) => ({index, id: `recovery-call-${index}`, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}})),
  } : {})}, finish_reason: null}]}) +
    frame({choices: [{index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop'}]}) + 'data: [DONE]\n\n';
}

/** All state belongs to a disposable workspace. Model requests pass through the
 * real SDK and pinned transport with synthetic HTTPS/DNS; provider methods are
 * local fixtures. No environment key, user connection or media decoder is used. */
async function fixture(t: TestContext, {lostSubmission = false, finalModelFailure = false, secondProposal = false} = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-agent-recovery-v2-'));
  let store = openStore(root), worker: Worker | undefined;
  const counters = {modelPosts: 0, submit: 0, poll: 0, reconcile: 0, generationTools: 0};
  const seenPollIds: string[] = [], seenReconcileIds: string[] = [], waitIds: string[] = [];
  let terminal = false, pollFailure = false, reconciled = false, failFinal = finalModelFailure;
  const providerTaskId = 'synthetic-original-task';
  const provider: Provider = {
    id: 'mock', capabilities: {models: ['recovery-motion'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], mock: true, configured: true, enabled: true, minPollIntervalMs: 60000},
    async submit(_snapshot, context) {
      assert.equal(typeof context.beforeSubmit, 'function'); context.beforeSubmit!(); counters.submit++;
      if (lostSubmission) throw Object.assign(new Error('Synthetic receipt was lost after acceptance'), {uncertain: true});
      return {providerJobId: providerTaskId};
    },
    async reconcile(requestId) { counters.reconcile++; seenReconcileIds.push(requestId); return reconciled ? {providerJobId: providerTaskId} : null; },
    async poll(id) {
      counters.poll++; seenPollIds.push(id); assert.equal(id, providerTaskId);
      if (pollFailure) { pollFailure = false; throw Object.assign(new Error('Synthetic offline connection loss'), {code: 'SYNTHETIC_POLL_OFFLINE'}); }
      return terminal ? {status: 'failed', error: {code: 'SYNTHETIC_TERMINAL', message: 'Original fixture task finished without media'}} : {status: 'running', progress: 0.25};
    },
    async download() { assert.fail('Recovery tests must not request media or a second generation'); },
  };
  const providers = new Map([['mock', provider]]);
  let services = createServices(store, providers);
  const projectId = String(record(await services.call('project.create', {name: 'Offline recovery'})).id);
  const shot = record(await services.call('shot.create', {projectId, title: 'One original request', prompt: 'A synthetic blue shape', duration: 4, aspectRatio: '9:16'}));
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: initial.revision, configuration: {...initial.configuration, protocol: 'chat_completions'}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_RECOVERY_ONLY'}});
  const authorizations = createTestAuthorizations(() => ({...store}), settings);
  await authorizeTestScope(authorizations, 'project_agent');
  const generationInput = {shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', model: 'recovery-motion'};
  const job = (): JobRecord => {
    const jobs = store.list('jobs', projectId); assert.equal(jobs.length, 1);
    return jobs[0] as JobRecord;
  };
  const dependencies = {
    lookup: async () => [{address: '8.8.8.8', family: 4}],
    httpsRequest(_options: unknown, respond: (incoming: unknown) => void) {
      const outgoing = Object.assign(new EventEmitter(), {
        setTimeout() {}, destroy() {}, end() {
          counters.modelPosts++;
          // The first real exchange loads video tools; the original recovery
          // script starts only after that completed model/tool round trip.
          const recoveryPost = counters.modelPosts - 1;
          if (recoveryPost === 3 && failFinal) { failFinal = false; outgoing.emit('error', new Error('Synthetic model connection loss')); return; }
          let calls: Array<{name: string; arguments: unknown}> = [];
          if (counters.modelPosts === 1) calls = [{name: 'mioon_tools_load', arguments: {groups: ['video']}}];
          else if (recoveryPost === 1 || recoveryPost === 3 && secondProposal) calls = [{name: 'mioon_generation_submit', arguments: generationInput}];
          else if (recoveryPost === 2) calls = [{name: 'mioon_task_wait', arguments: {kind: 'job', id: job().id}}];
          respond(Object.assign(Readable.from([Buffer.from(response(calls))]), {statusCode: 200, headers: {'content-type': 'text/event-stream'}}));
        },
      });
      queueMicrotask(() => {
        const socket = Object.assign(new EventEmitter(), {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
        outgoing.emit('socket', socket); socket.emit('secureConnect');
      });
      return outgoing;
    },
  } as unknown as AgentTransportDependencies;
  const gateway = createTaskGateway(dependencies);
  const makeTools = () => {
    const base = createAgentTaskTools({store, services});
    return {...base, async execute(...args: Parameters<typeof base.execute>) {
      if (args[0].operation === 'generation.submit') counters.generationTools++;
      if (args[0].operation === 'task.wait') waitIds.push(String(args[0].input.id));
      return base.execute(...args);
    }};
  };
  let tools = makeTools();
  const makeRuntime = () => createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
  let runtime = makeRuntime();
  t.after(async () => {
    await worker?.stop(); runtime.close(); await runtime.drain(); tools.dispose(); await services.drain(); await settings.close(); store.close(); await rm(root, {recursive: true, force: true});
  });
  const read = (runId: string) => runtime.get(projectId, runId);
  const action = (runId: string, action: AgentTaskControlInput['action'], extra: Record<string, unknown> = {}) => runtime.action(projectId, runId, {requestId: randomUUID(), runId, expectedRevision: read(runId).run.revision, action, ...extra});
  const stable = (runId: string) => until(() => read(runId), snapshot => ['awaiting_approval', 'paused', 'failed', 'completed', 'interrupted'].includes(snapshot.run.status));
  const assertOriginal = (jobId: string, requestId: string, snapshot: unknown) => {
    assert.equal(job().id, jobId); assert.equal(job().requestId, requestId); assert.deepEqual(job().snapshot, snapshot);
    assert.equal(job().submissionCount, 1); assert.equal(counters.submit, 1); assert.equal(counters.generationTools, 1);
    assert.ok(waitIds.every(id => id === jobId)); assert.ok(seenPollIds.every(id => id === providerTaskId)); assert.equal(runtime.policy().modes.paid, 'confirm');
  };
  return {
    counters, seenPollIds, seenReconcileIds, waitIds, job, read, action, stable, assertOriginal,
    get runtime() { return runtime; }, get store() { return store; }, get services() { return services; }, projectId,
    async accepted() {
      const sent = await runtime.send(projectId, {requestId: randomUUID(), text: 'Generate once, then wait on that exact job. Do not retry generation.', expectedSettingsRevision: (await settings.get()).revision});
      const pending = await stable(sent.run.id); await runtime.drain();
      assert.equal(pending.run.status, 'awaiting_approval'); assert.equal(store.list('jobs', projectId).length, 0); assert.equal(counters.submit, 0); assert.equal(counters.generationTools, 0);
      assert.equal(counters.modelPosts, 2); assert.equal(pending.run.stepsUsed, 4);
      assert.equal(pending.steps.filter(step => step.toolCall?.name === 'mioon_tools_load' && step.status === 'completed').length, 1);
      const step = pending.steps.find(step => step.status === 'awaiting_approval'); assert.ok(step); assert.equal(step.tier, 'paid');
      const control = {requestId: randomUUID(), runId: sent.run.id, expectedRevision: pending.run.revision, action: 'approve', stepId: step.id};
      await runtime.action(projectId, sent.run.id, control);
      await until(() => read(sent.run.id), snapshot => snapshot.steps.some(step => step.toolCall?.name === 'mioon_task_wait' && step.status === 'dispatch_started'));
      await runtime.action(projectId, sent.run.id, control); // Lost acknowledgement replay cannot consume another approval or create another job.
      worker = startWorker(store, services, providers); await worker.tick();
      await until(job, current => current.status === (lostSubmission ? 'submission_unknown' : 'running'));
      return {runId: sent.run.id, stepId: step.id, jobId: job().id, requestId: job().requestId, snapshot: structuredClone(job().snapshot)};
    },
    async pollNow({fail = false, finish = false, reconcile = false} = {}) {
      pollFailure = fail; terminal = finish; reconciled = reconcile;
      services.saveJob(job(), {nextPollAt: 0}); assert.ok(worker); await worker.tick();
    },
    async restart() {
      await worker?.stop(); worker = undefined;
      runtime.close(); await runtime.drain(); tools.dispose(); await services.drain(); store.close();
      store = openStore(root); services = createServices(store, providers); tools = makeTools(); runtime = makeRuntime();
    },
    async startWorker() { worker = startWorker(store, services, providers); await worker.tick(); },
  };
}

test('accepted job wait pauses and resumes without a second submit or approval consumption', async t => {
  const f = await fixture(t), original = await f.accepted();
  await f.action(original.runId, 'pause'); await f.runtime.drain();
  const paused = f.read(original.runId), modelPosts = f.counters.modelPosts;
  assert.equal(paused.run.status, 'paused'); assert.equal(paused.run.pauseReason, 'user');
  await f.pollNow({finish: true}); assert.equal(f.job().status, 'failed');
  assert.equal(f.counters.modelPosts, modelPosts);
  await f.action(original.runId, 'resume'); await f.runtime.drain();
  const done = f.read(original.runId); assert.equal(done.run.status, 'completed');
  const wait = done.steps.find(step => step.toolCall?.name === 'mioon_task_wait'); assert.equal(record(wait?.result).id, original.jobId); assert.equal(record(wait?.result).status, 'failed');
  assert.equal(done.steps.filter(step => step.toolCall?.name === 'mioon_generation_submit').length, 1);
  f.assertOriginal(original.jobId, original.requestId, original.snapshot);
});

test('database reopen retains an unknown wait until the original result is explicitly accepted, and a new paid proposal still needs review', async t => {
  const f = await fixture(t, {secondProposal: true}), original = await f.accepted(), modelPosts = f.counters.modelPosts;
  await f.restart();
  const interrupted = f.read(original.runId), wait = interrupted.steps.find(step => step.toolCall?.name === 'mioon_task_wait');
  assert.equal(interrupted.run.status, 'interrupted'); assert.equal(wait?.status, 'unknown');
  assert.equal(f.counters.modelPosts, modelPosts); assert.equal(f.counters.submit, 1);
  await assert.rejects(f.action(original.runId, 'resume'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await assert.rejects(f.action(original.runId, 'retry'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await assert.rejects(f.action(original.runId, 'resolve_unknown', {stepId: wait!.id, resolution: 'discard'}), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await assert.rejects(f.action(original.runId, 'resolve_unknown', {stepId: wait!.id, resolution: 'accept_result'}), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await f.startWorker(); await f.pollNow({finish: true});
  assert.equal(f.counters.modelPosts, modelPosts); assert.equal(f.job().status, 'failed');
  await f.action(original.runId, 'resolve_unknown', {stepId: wait!.id, resolution: 'accept_result'});
  await f.action(original.runId, 'resume'); await f.runtime.drain();
  const review = f.read(original.runId), next = review.steps.filter(step => step.toolCall?.name === 'mioon_generation_submit').at(-1);
  assert.equal(review.run.status, 'awaiting_approval'); assert.equal(next?.status, 'awaiting_approval'); assert.equal(next?.tier, 'paid'); assert.notEqual(next?.id, original.stepId);
  assert.equal(record(review.steps.find(step => step.id === wait!.id)?.result).id, original.jobId);
  f.assertOriginal(original.jobId, original.requestId, original.snapshot);
});

test('poll network failure resumes observation of the original provider task without restarting model inference or generation', async t => {
  const f = await fixture(t), original = await f.accepted(), modelPosts = f.counters.modelPosts;
  await f.pollNow({fail: true});
  assert.equal(f.job().status, 'running'); assert.equal(record(f.job().error).code, 'SYNTHETIC_POLL_OFFLINE');
  assert.equal(f.counters.modelPosts, modelPosts); assert.equal(f.read(original.runId).run.status, 'running');
  await f.pollNow(); assert.equal(f.job().status, 'running'); assert.equal(f.job().error, null);
  await f.pollNow({finish: true}); await f.runtime.drain();
  assert.equal(f.read(original.runId).run.status, 'completed'); assert.equal(f.counters.reconcile, 0); assert.ok(f.counters.poll >= 3);
  f.assertOriginal(original.jobId, original.requestId, original.snapshot);
});

test('unknown submission reconciles only its original request and cannot be replaced through wait recovery or retry', async t => {
  const f = await fixture(t, {lostSubmission: true}), original = await f.accepted(); await f.runtime.drain();
  const unknown = f.read(original.runId), wait = unknown.steps.find(step => step.toolCall?.name === 'mioon_task_wait');
  assert.equal(unknown.run.status, 'paused'); assert.equal(unknown.run.pauseReason, 'unknown_outcome'); assert.equal(wait?.status, 'unknown');
  await assert.rejects(f.action(original.runId, 'resume'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await assert.rejects(f.action(original.runId, 'retry'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await assert.rejects(f.action(original.runId, 'resolve_unknown', {stepId: wait!.id, resolution: 'accept_result'}), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  await f.pollNow(); assert.equal(f.job().status, 'submission_unknown'); assert.equal(f.counters.submit, 1);
  await f.pollNow({reconcile: true}); assert.equal(f.job().status, 'running');
  await f.pollNow({reconcile: true, finish: true}); assert.equal(f.job().status, 'failed');
  assert.ok(f.seenReconcileIds.length >= 2); assert.ok(f.seenReconcileIds.every(id => id === original.requestId));
  await f.action(original.runId, 'resolve_unknown', {stepId: wait!.id, resolution: 'accept_result'});
  await f.action(original.runId, 'resume'); await f.runtime.drain();
  assert.equal(f.read(original.runId).run.status, 'completed');
  f.assertOriginal(original.jobId, original.requestId, original.snapshot);
});

test('model connection failure after receiving the original job result retries inference explicitly without repeating generation', async t => {
  const f = await fixture(t, {finalModelFailure: true}), original = await f.accepted();
  await f.pollNow({finish: true}); await f.runtime.drain();
  const failed = f.read(original.runId), last = failed.steps.at(-1)!;
  assert.equal(failed.run.status, 'failed'); assert.equal(last.kind, 'model'); assert.equal(last.error?.code, 'AGENT_CHAT_CONNECT_FAILED'); assert.equal(f.counters.modelPosts, 4);
  const control = {requestId: randomUUID(), runId: original.runId, expectedRevision: failed.run.revision, action: 'retry', stepId: last.id};
  await f.runtime.action(f.projectId, original.runId, control); await f.runtime.drain();
  const done = f.read(original.runId); assert.equal(done.run.status, 'completed'); assert.equal(f.counters.modelPosts, 5);
  await f.runtime.action(f.projectId, original.runId, control); await f.runtime.drain(); assert.equal(f.counters.modelPosts, 5);
  assert.equal(done.steps.filter(step => step.toolCall?.name === 'mioon_generation_submit').length, 1);
  f.assertOriginal(original.jobId, original.requestId, original.snapshot);
});

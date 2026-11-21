import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';
import {putTestAgentConfiguration, testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {call, output} from './helpers/agent-task-runtime-fixture.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {createProviderRegistry, registerInputProfileWrapper} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

/** Real project journal + Mio job binding on a Format-5 board. The app policy
 * store is the real open app library; only the chat authorization reader is a
 * narrow test double because this test exercises the background target gate. */
async function fixture(t: test.TestContext) {
  const f = await createBoardUiWireFixture();
  const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await putTestAgentConfiguration(settings, {expectedRevision: initial.revision,
    configuration: {...DEFAULT_AGENT_CONFIGURATION, protocol: 'responses'},
    secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_LOCAL_TEST_ONLY'}});
  const authorizations = {assertAuthorized() {}, snapshot: () => ({scopes: ['project_agent'], revision: 1,
    currentTarget: null, authorizations: []})};
  const tools = createAgentTaskTools({store: f.store, services: f.services});
  let request = 0;
  const gateway = async function*() {
    request++;
    if (request === 1) {
      yield {type: 'done' as const, output: output('responses', [call(AGENT_TASK_TOOLS_LOAD_NAME,
        {names: ['mioon_sequence_timeline_edit']})])};
      return;
    }
    if (request === 2) {
      yield {type: 'done' as const, output: output('responses', [call('mioon_sequence_timeline_edit', {
        kind: 'generate', placement: {kind: 'main', beforeClipId: BOARD_IDS.clipB}, title: 'Mio 生成检查',
        providerId: 'mock', model: 'mock-motion-v1', region: 'local', prompt: 'Mio worker checks',
        aspectRatio: '9:16', duration: 2})])};
      return;
    }
    yield {type: 'done' as const, output: output('responses', [])};
  };
  const baseJournal=createMioProjectJournal(f.store,(f.library as never as {agentPolicy?: never}).agentPolicy);
  const journal=new Proxy(baseJournal,{get(target,property,receiver){const value:unknown=Reflect.get(target,property,receiver);if(typeof value!=='function')return value;return (...args:unknown[])=>{try{return Reflect.apply(value,target,args);}catch(error){console.error('JOURNAL FAIL',String(property),error);throw error;}};}});
  const runtime = createAgentTaskRuntime({store: f.store, agentSettings: settings,
    authorizations: authorizations as never, tools, gateway, selfPort: () => 4318,
    journal: journal as never,
    rules: {capture: () => undefined} as never});
  const policy = runtime.policy();
  runtime.updatePolicy({requestId: randomUUID(), expectedRevision: policy.revision, stepLimit: 30,
    modes: {...policy.modes, paid: 'confirm', local_reversible: 'confirm'}});
  t.after(async () => {runtime.close(); tools.dispose(); await settings.close(); await f.services.drain?.();
    f.store.close(); f.library.close();});
  return {f, settings, runtime};
}
async function send(f: Awaited<ReturnType<typeof fixture>>['f'], settings: Awaited<ReturnType<typeof fixture>>['settings']) {
  const run = await f.services ? undefined : undefined;
  return run;
}
async function begin(f: Awaited<ReturnType<typeof fixture>>['f'], settings: Awaited<ReturnType<typeof fixture>>['settings'],
  runtime: Awaited<ReturnType<typeof fixture>>['runtime']) {
  const jobsBefore=(f.store.list('jobs') as any[]).length;
  const sent = await runtime.send(f.projectId, {requestId: randomUUID(), text: '在剪辑里生成一个镜头',
    expectedSettingsRevision: testAgentExecution(await settings.get()).revision});
  await runtime.drain();
  const snapshot = runtime.get(f.projectId, sent.run.id);
  const step = snapshot.steps.find(item => item.toolCall?.name === 'mioon_sequence_timeline_edit');
  assert.ok(step, JSON.stringify({run:snapshot.run,steps:snapshot.steps}));
  assert.equal(step.tier, 'paid');
  assert.equal(step.status, 'awaiting_approval');
  assert.equal((f.store.list('jobs') as any[]).length, jobsBefore, 'no job exists before fee confirmation');
  return {sent, snapshot, step, jobsBefore};
}
async function approve(f: Awaited<ReturnType<typeof fixture>>['f'], runtime: Awaited<ReturnType<typeof fixture>>['runtime'],
  sent: {run: {id: string}}, snapshot: {run: {revision: number}}, step: {id: string}) {
  await runtime.action(f.projectId, sent.run.id, {requestId: randomUUID(),
    expectedRevision: snapshot.run.revision, action: 'approve', stepId: step.id});
  await runtime.drain();
  return runtime.get(f.projectId, sent.run.id);
}
async function syntheticProvider(f: Awaited<ReturnType<typeof fixture>>['f']) {
  const registry = createProviderRegistry({db: f.store.db, root: f.root, env: {}});
  for (const [id, provider] of registry) f.providers.set(id, provider);
  const video = join(f.root, 'checks.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:d=4:r=30',
    '-pix_fmt', 'yuv420p', '-y', video]);
  const base = registry.get('mock')!;
  f.providers.set('mock', registerInputProfileWrapper({id: 'mock', capabilities: base.capabilities,
    validate: base.validate?.bind(base), async submit() {return {providerJobId: `checks-${randomUUID()}`};},
    async reconcile() {return null;}, async poll() {return {status: 'succeeded', progress: 100};},
    async download(_id: string, destination: string) {copyFileSync(video, destination); return {};},
    async cancel() {return {};}}, base));
  return startWorker(f.store, f.services, f.providers as never);
}
async function runToSettled(f: Awaited<ReturnType<typeof fixture>>['f'], worker: Awaited<ReturnType<typeof syntheticProvider>>) {
  let job = (f.store.list('jobs') as any[]).find(item => typeof item.requestId === 'string' && item.requestId.startsWith('mio-'));
  for (let i = 0; i < 120 && job && !['succeeded', 'failed'].includes(job.status); i++) {
    await worker.tick();
    job = (f.store.list('jobs') as any[]).find(item => typeof item.requestId === 'string' && item.requestId.startsWith('mio-'));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return job;
}
function generated(f: Awaited<ReturnType<typeof fixture>>['f']) {
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  return timeline.clips.find((clip: any) => clip.sourceState === 'placeholder' && clip.sequenceSource?.nodeId === (timeline.clips.at(-1)?.sequenceSource?.nodeId));
}
async function placeholderShot(f: Awaited<ReturnType<typeof fixture>>['f']) {
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const clip = timeline.clips.find((item: any) => item.sourceState === 'placeholder' && item.sequenceSource?.nodeId && item.sequenceSource.nodeId !== BOARD_IDS.shotB);
  assert.ok(clip);
  return {clip, shotId: clip.sequenceSource.nodeId as string};
}

test('Format-5 Mio generation submits only after paid approval, adopts its generated targets and selects the shot', async t => {
  const {f, settings, runtime} = await fixture(t);
  const worker = await syntheticProvider(f);
  t.after(async () => {await worker.stop();});
  const {sent, snapshot, step, jobsBefore} = await begin(f, settings, runtime);
  assert.equal(step.targets?.some(target => target.kind === 'timeline_clip'), true);
  const afterApprove = await approve(f, runtime, sent, snapshot, step);
  assert.equal((f.store.list('jobs') as any[]).length, jobsBefore+1, 'approval creates exactly one job row');
  const placeholder = await placeholderShot(f);
  const job = await runToSettled(f, worker);
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const clip = timeline.clips.find((item: any) => item.id === placeholder.clip.id);
  assert.equal(clip.sourceState, 'ready');
  assert.equal(clip.versionId, job.versionId);
  assert.equal((f.store.get('shots', placeholder.shotId) as any).selectedVersionId, job.versionId);
  const history = await f.services.call('sequence.history.get', {projectId: f.projectId}) as any;
  assert.ok(history.position >= 1);
  assert.equal(afterApprove.steps.some(item => item.id === step.id && item.status === 'completed'), true);
});

test('stopping a Format-5 Mio generation before the provider result leaves the placeholder and records a background skip', async t => {
  const {f, settings, runtime} = await fixture(t);
  const worker = await syntheticProvider(f);
  t.after(async () => {await worker.stop();});
  const {sent, snapshot, step, jobsBefore} = await begin(f, settings, runtime);
  await approve(f, runtime, sent, snapshot, step);
  const current = runtime.get(f.projectId, sent.run.id);
  let stopped = false;
  try {const result=await runtime.action(f.projectId, sent.run.id, {requestId: randomUUID(),
    expectedRevision: current.run.revision, action: 'stop'});stopped=result.run.status==='stopped';} catch {stopped = false;}
  assert.equal(stopped, true, 'the running Mio task can be stopped before the provider result');
  const job = await runToSettled(f, worker);
  assert.ok(['cancelled', 'succeeded'].includes(job.status), JSON.stringify(job));
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const placeholder = timeline.clips.find((clip: any) => clip.sourceState === 'placeholder' && clip.sequenceSource?.nodeId && clip.sequenceSource.nodeId !== BOARD_IDS.shotB);
  assert.ok(placeholder, 'the placeholder is retained');
  assert.equal((f.store.get('shots', placeholder.sequenceSource.nodeId) as any).selectedVersionId, null);
});

test('a Format-5 Mio generation whose shot title changed in flight follows the Mio target conflict rule', async t => {
  const {f, settings, runtime} = await fixture(t);
  const worker = await syntheticProvider(f);
  t.after(async () => {await worker.stop();});
  const {sent, snapshot, step, jobsBefore} = await begin(f, settings, runtime);
  await approve(f, runtime, sent, snapshot, step);
  const placeholder = await placeholderShot(f);
  const shot = f.store.get('shots', placeholder.shotId) as any;
  f.store.put('shots', {...shot, title: '生成期间改过标题', revision: shot.revision + 1});
  const job = await runToSettled(f, worker);
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const timeline = f.store.get('timelines', BOARD_IDS.timeline) as any;
  assert.equal(timeline.clips.find((clip: any) => clip.id === placeholder.clip.id).sourceState, 'placeholder');
  assert.equal((f.store.get('shots', placeholder.shotId) as any).selectedVersionId, null);
});


test('denying the paid Mio generation card creates no job row', async t => {
  const {f, settings, runtime} = await fixture(t);
  const {sent, snapshot, step, jobsBefore} = await begin(f, settings, runtime);
  await runtime.action(f.projectId, sent.run.id, {requestId: randomUUID(), expectedRevision: snapshot.run.revision,
    action: 'deny', stepId: step.id});
  await runtime.drain();
  const after = runtime.get(f.projectId, sent.run.id);
  assert.equal((f.store.list('jobs') as any[]).length, jobsBefore);
  assert.equal(after.steps.find(item => item.id === step.id)?.status, 'rejected');
});

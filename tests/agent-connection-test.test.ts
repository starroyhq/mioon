import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_CONNECTION_TEST_TEXT, agentConnectionTestMatches, chooseAgentConnectionTestProject, createAgentConnectionTestSession } from '../apps/web/src/agent-connection-test.ts';
import type { AgentConnectionTestDependencies, AgentConnectionTestState } from '../apps/web/src/agent-connection-test.ts';
import type { AgentTaskProjectSnapshot } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskConnectionTest, AgentTaskSnapshot, AgentTaskStatus } from '../packages/contracts/src/agent-tasks-v2.ts';

const projectA = '00000000-0000-4000-8000-00000000000a', projectB = '00000000-0000-4000-8000-00000000000b', runId = '00000000-0000-4000-8000-0000000000aa';
const configuration = { presetId: 'deepseek', platformId: 'global', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'chat_completions' };
const at = '2026-10-26T01:02:03.000Z';
type Client = NonNullable<AgentConnectionTestDependencies['client']>;
type SendInput = Parameters<Client['send']>[1];

function project(projectId: string, { authorized = true, revision = 3 }: { authorized?: boolean; revision?: number } = {}): AgentTaskProjectSnapshot {
  return { version: 2, instanceId: 'instance', projectId, runs: [], policy: { revision: 1, stepLimit: 30, modes: { read_only: 'direct', local_reversible: 'direct', local_irreversible: 'direct', paid: 'confirm' } },
    settings: { revision, configuration } as unknown as AgentTaskProjectSnapshot['settings'], authorization: { revision: 7, scopes: authorized ? ['project_agent'] : [] } as unknown as AgentTaskProjectSnapshot['authorization'] };
}
function run(status: AgentTaskStatus, projectId = projectA): AgentTaskSnapshot {
  return { run: { id: runId, projectId, requestId: 'request-1', text: AGENT_CONNECTION_TEST_TEXT, status, revision: 1, stepLimit: 30, budget: 30, stepsUsed: 1, configuration, createdAt: at, updatedAt: at }, steps: [], changes: [] } as unknown as AgentTaskSnapshot;
}
const stored = (status: AgentTaskStatus, extra: Partial<AgentTaskConnectionTest> = {}): AgentTaskConnectionTest => ({ runId, projectId: projectA, status, createdAt: at, updatedAt: at, protocol: configuration.protocol, baseUrl: configuration.baseUrl, model: configuration.model, ...extra });

function harness({ snapshots = [project(projectA)], reads = [run('running'), run('completed')], send, lookup, latest = [null, stored('completed')], projects = [{ id: projectA, updatedAt: at }], recentOpened = {} }:
  { snapshots?: AgentTaskProjectSnapshot[]; reads?: AgentTaskSnapshot[]; send?: (input: SendInput) => Promise<AgentTaskSnapshot>; lookup?: Client['lookup']; latest?: (AgentTaskConnectionTest | null)[]; projects?: { id: string; updatedAt: string }[]; recentOpened?: Record<string, string> } = {}) {
  const calls = { list: [] as string[], send: [] as { projectId: string; input: SendInput }[], read: 0, lookup: 0, authorize: [] as AgentTaskProjectSnapshot[], latest: 0 }, states: AgentConnectionTestState[] = [];
  let clock = 0;
  const client: Client = {
    list: async projectId => { calls.list.push(projectId); return snapshots[Math.min(calls.list.length - 1, snapshots.length - 1)]!; },
    send: async (projectId, input) => { calls.send.push({ projectId, input }); return send ? send(input) : run('running', projectId); },
    read: async () => reads[Math.min(calls.read++, reads.length - 1)]!,
    lookup: async (...args) => { calls.lookup++; return lookup ? lookup(...args) : { found: false }; },
    authorize: async snapshot => { calls.authorize.push(snapshot); },
  };
  const session = createAgentConnectionTestSession({ client, latest: async () => latest[Math.min(calls.latest++, latest.length - 1)] ?? null, projects: async () => projects, recentOpened: async () => recentOpened,
    onChange: state => states.push(state), requestId: () => 'request-1', wait: async () => {}, now: () => (clock += 1000) });
  return { session, calls, states };
}

test('the test runs in the current project, else the most recently opened, else the most recently updated', () => {
  const projects = [{ id: projectA, updatedAt: '2026-10-20T00:00:00.000Z' }, { id: projectB, updatedAt: '2026-10-25T00:00:00.000Z' }];
  assert.equal(chooseAgentConnectionTestProject({ currentProjectId: projectA, recentOpened: { [projectB]: at }, projects }), projectA);
  assert.equal(chooseAgentConnectionTestProject({ currentProjectId: null, recentOpened: { [projectA]: at, [projectB]: '2026-10-01T00:00:00.000Z' }, projects }), projectA);
  assert.equal(chooseAgentConnectionTestProject({ currentProjectId: 'deleted', recentOpened: { deleted: at }, projects }), projectB);
  assert.equal(chooseAgentConnectionTestProject({ recentOpened: {}, projects: [] }), null);
});

test('a stored result describes the saved connection only when protocol, address and model all match', () => {
  assert.equal(agentConnectionTestMatches(stored('completed'), configuration), true);
  for (const change of [{ protocol: 'responses' }, { baseUrl: 'https://other.example.com' }, { model: 'other-model' }]) assert.equal(agentConnectionTestMatches(stored('completed'), { ...configuration, ...change }), false);
  assert.equal(agentConnectionTestMatches(null, configuration), false);
});

test('an authorized connection sends one text diagnostic, reads its run to the end and shows the stored result', async () => {
  const f = harness();
  await f.session.load(); assert.equal(f.session.getState().phase, 'idle'); assert.equal(f.session.getState().latest, null);
  assert.equal(await f.session.start({ settingsRevision: 3, locale: 'en' }), true);
  assert.deepEqual(f.calls.send, [{ projectId: projectA, input: { requestId: 'request-1', text: AGENT_CONNECTION_TEST_TEXT, expectedSettingsRevision: 3, locale: 'en', diagnostic: { profile: 'text' } } }]);
  assert.equal(f.calls.read, 2); assert.equal(f.calls.authorize.length, 0);
  assert.deepEqual(f.session.getState(), { phase: 'idle', latest: stored('completed'), review: null, error: null });
  assert.ok(f.states.some(state => state.phase === 'testing'));
});

test('an unauthorized connection is reviewed first: cancel sends nothing, confirm grants exactly the reviewed connection', async () => {
  const f = harness({ snapshots: [project(projectA, { authorized: false }), project(projectA, { authorized: false }), project(projectA)] });
  await f.session.load(); await f.session.start({ settingsRevision: 3 });
  assert.equal(f.session.getState().phase, 'review'); assert.deepEqual(f.session.getState().review, { projectId: projectA, destination: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' });
  assert.equal(f.session.cancel(), true); assert.equal(f.session.getState().phase, 'idle'); assert.equal(f.calls.send.length, 0); assert.equal(f.calls.authorize.length, 0);
  await f.session.start({ settingsRevision: 3 }); assert.equal(f.session.getState().phase, 'review');
  assert.equal(await f.session.confirm(), true);
  assert.equal(f.calls.authorize.length, 1); assert.equal(f.calls.authorize[0]!.projectId, projectA); assert.equal(f.calls.authorize[0]!.settings.revision, 3);
  assert.equal(f.calls.send.length, 1); assert.equal(f.session.getState().phase, 'idle');
});

test('a changed saved connection, a missing project or a definitive refusal never sends', async () => {
  const changed = harness({ snapshots: [project(projectA, { revision: 4 })] }); await changed.session.load();
  assert.equal(await changed.session.start({ settingsRevision: 3 }), false); assert.equal(changed.session.getState().error, 'AGENT_TASK_SETTINGS_CHANGED'); assert.equal(changed.calls.send.length, 0);
  const empty = harness({ projects: [] }); await empty.session.load();
  assert.equal(await empty.session.start({ settingsRevision: 3 }), false); assert.equal(empty.session.getState().error, 'AGENT_CONNECTION_TEST_NO_PROJECT'); assert.equal(empty.calls.list.length, 0);
  const busy = harness({ send: async () => { throw Object.assign(new Error('busy'), { code: 'AGENT_TASK_BUSY', definitive: true }); } }); await busy.session.load();
  await busy.session.start({ settingsRevision: 3 });
  assert.equal(busy.session.getState().error, 'AGENT_TASK_BUSY'); assert.equal(busy.calls.lookup, 0); assert.equal(busy.calls.send.length, 1); assert.equal(busy.session.getState().phase, 'idle');
});

test('an unconfirmed send reads its receipt once and follows the accepted run, never resending', async () => {
  const lost = () => Promise.reject(Object.assign(new Error('lost'), { code: 'NETWORK' }));
  const found = harness({ send: lost, lookup: async () => ({ found: true, snapshot: run('running') }) }); await found.session.load();
  await found.session.start({ settingsRevision: 3 });
  assert.equal(found.calls.send.length, 1); assert.equal(found.calls.lookup, 1); assert.equal(found.calls.read, 2); assert.equal(found.session.getState().error, null);
  const missing = harness({ send: lost }); await missing.session.load();
  await missing.session.start({ settingsRevision: 3 });
  assert.equal(missing.calls.send.length, 1); assert.equal(missing.calls.lookup, 1); assert.equal(missing.session.getState().error, 'NETWORK'); assert.equal(missing.session.getState().phase, 'idle');
});

test('a test still running elsewhere is followed on load, and a disposed session stops reading', async () => {
  const f = harness({ latest: [stored('running'), stored('completed')] });
  await f.session.load(); assert.equal(f.calls.read, 2); assert.equal(f.session.getState().latest?.status, 'completed');
  const reads: AgentTaskSnapshot[] = Array.from({ length: 10 }, () => run('running'));
  const g = harness({ reads, latest: [null] }); await g.session.load();
  const started = g.session.start({ settingsRevision: 3 }); g.session.dispose(); await started;
  assert.ok(g.calls.read <= 1); assert.equal(g.calls.send.length <= 1, true);
});

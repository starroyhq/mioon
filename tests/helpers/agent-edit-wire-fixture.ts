import {authorizeHttpSnapshot} from './agent-authorizations.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {startEditWireModel} from './agent-edit-wire-model.ts';
import {OwnedFixtureLifetime, inheritedTestCompileCache, startOwnedEditBackend, fixtureHttpRequest, fixtureLostAcknowledgement, until} from './agent-edit-wire-lifecycle.ts';
export {until};
export const EDIT_WIRE_TOKEN = 'synthetic-agent-edit-owned-backend-token';
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./agent-edit-wire-process.ts', import.meta.url));
export const chatRoute = (projectId: string): string => `/api/agent/chat/${projectId}`;
export const editRoute = (projectId: string, proposalId: string, action: string): string => `${chatRoute(projectId)}/edits${proposalId ? `/${proposalId}` : ''}${action ? `/${action}` : ''}`;
export const DOMAIN_TABLES = ['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','timeline_history','timeline_history_cursors','timeline_requests','reference_requests','idempotency','job_events'];
export const startEditBackend = (root: string, lifetime: OwnedFixtureLifetime) => startOwnedEditBackend(root, {repo: REPO, entry: CHILD, token: EDIT_WIRE_TOKEN, lifetime});
export function database<T>(root: string, action: (db: DatabaseSync)=>T, {writable = false}: {writable?: boolean} = {}): T {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  try { return action(db); } finally { db.close(); }
}
export const tableSnapshot = (root: string, tables: readonly string[] = DOMAIN_TABLES): unknown => database(root, (db: DatabaseSync) => Object.fromEntries(tables.map((table: string) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
export const savedShot = (root: string, id: string): unknown => database(root, (db: DatabaseSync) => JSON.parse((db.prepare('SELECT data FROM shots WHERE id=?').get(id) as {data: string}).data));
export const savedProposal = (root: string, id: string): unknown => database(root, (db: DatabaseSync) => db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(id));
export async function editWireFixture(t: unknown, protocol: unknown): Promise<Record<string, unknown>> {
  const lifetime = new OwnedFixtureLifetime(t as never);
  const root = await lifetime.acquire(() => mkdtemp(path.join(tmpdir(), 'mioon-edit-wire-')), value => rm(value, {recursive: true, force: true}));
  const model = await lifetime.acquire(() => startEditWireModel(), value => value.close());
  let current = await startEditBackend(root, lifetime);
  const f = {root, model, protocol, lifetime, testRuntimeEnvironment: inheritedTestCompileCache(), signal: lifetime.signal, deferCleanup: (dispose: ()=>unknown) => lifetime.deferCleanup(dispose), get process() { return current; },
    async restart({crash = false}: {crash?: boolean} = {}) {
      lifetime.assertActive();
      const before = current;
      const ended = await (crash ? before.crash() : before.close());
      if (crash) assert.equal(ended.signal, 'SIGKILL'); else if (ended.signal !== 'SIGKILL') assert.deepEqual(ended, {code: 0, signal: null}, before.output);
      lifetime.assertActive();
      const next = await startEditBackend(root, lifetime); lifetime.assertActive(); current = next;
      assert.notEqual(current.child.pid, before.child.pid); return current;
    },
    request(route: string, options?: Record<string, unknown>) { return fixtureHttpRequest(lifetime, current.url + route, EDIT_WIRE_TOKEN, options); },
    async data(route: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> { const result = await this.request(route, options) as {status: number; body: {ok?: boolean; data?: Record<string, unknown>}}; assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data ?? {}; },
    rpc(operation: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    async setup(): Promise<{project: {id: string}; shot: {id: string}}> {
      const project = await this.rpc('project.create', {name: 'UNSELECTED_PROJECT_NAME_MUST_NOT_REACH_MODEL'}) as {id: string};
      const shot = await this.rpc('shot.create', {projectId: project.id, title: 'Original saved title', prompt: 'Original saved prompt'}) as {id: string};
      return {project, shot};
    },
    async input(projectId: string, shot: {id: string; revision: number}, {message = 'Improve this selected saved shot', context = 'selected_shot_edit', consent: overrides, ...changes}: {message?: string; context?: string; consent?: Record<string, unknown>; [key: string]: unknown} = {}): Promise<Record<string, unknown>> {
      const snapshot = await this.data(chatRoute(projectId)) as {settings: {configuration: Record<string, unknown>; revision: number}; instanceId: string; revision: number; edit?: {available?: boolean; [key: string]: unknown}; [key: string]: unknown}, configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot(((route: string, options: {method: string; input: unknown}) => this.request(route, options)) as never, snapshot as never, context);
      const base = {destination: deriveAgentEndpoint(configuration as never), protocol: configuration.protocol, model: configuration.model, context};
      let consent: Record<string, unknown> = base;
      if (context === 'selected_shot_edit') {
        assert.equal(snapshot.edit?.available, true, JSON.stringify(snapshot.edit)); const {available, ...policy} = snapshot.edit ?? {};
        consent = {...base, projectId, ...policy, shotId: shot.id, expectedRevision: shot.revision};
      }
      return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
        expectedConversationRevision: snapshot.revision, message, consent: {...consent, ...overrides}, ...changes};
    },
    send(projectId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.data(`${chatRoute(projectId)}/runs`, {method: 'POST', input}); },
    lookup(projectId: string, requestId: string): Promise<Record<string, unknown>> { return this.data(`${chatRoute(projectId)}/requests/${requestId}`); },
    terminal(projectId: string, requestId: string): Promise<Record<string, unknown>> { return until(async () => { const result = await this.lookup(projectId, requestId) as {run?: {status?: unknown}}; return result.run?.status !== 'running' && (result as Record<string, unknown>); }, 'terminal Agent run', 10000, lifetime.signal) as Promise<Record<string, unknown>>; },
    proposals(projectId: string, query = ''): Promise<Record<string, unknown>> { return this.data(editRoute(projectId, '', '') + query); },
    proposal(projectId: string, id: string): Promise<Record<string, unknown>> { return this.data(editRoute(projectId, id, '')); },
    async action(projectId: string, proposal: {id: string; digest: string}, action: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const snapshot = await this.proposal(projectId, proposal.id) as {instanceId: unknown};
      return this.data(editRoute(projectId, proposal.id, action), {method: 'POST', input: {instanceId: snapshot.instanceId, digest: proposal.digest, ...overrides}});
    },
    async propose(projectId: string, shot: {id: string; revision: number}, plan: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      model.plan(plan); const input = await this.input(projectId, shot), sent = await this.send(projectId, input) as {run: {id: string}};
      const done = await this.terminal(projectId, String(input.requestId));
      const listed = await this.proposals(projectId, '?view=all') as {proposals: {runId: string}[]};
      const proposal = listed.proposals.find(item => item.runId === sent.run.id);
      return {input, sent, done, proposal};
    },
    lostAcknowledgement(route: string, input: unknown) { return fixtureLostAcknowledgement(lifetime, current.url + route, EDIT_WIRE_TOKEN, input); },
    async trace(): Promise<unknown[]> { try { return (await readFile(path.join(root, 'edit-fault-trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as unknown); } catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && (error as {code?: unknown}).code === 'ENOENT') return []; throw error; } },
  };
  const settings = await f.data('/api/agent/settings') as {revision: unknown};
  await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: settings.revision,
    configuration: {protocol, presetId: 'ollama', platformId: 'local', baseUrl: model.baseUrl, model: 'qwen3:8b'}, secret: {action: 'remove'}}});
  return f as unknown as Record<string, unknown>;
}

import {authorizeHttpSnapshot} from './agent-authorizations.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {startEditWireModel} from './agent-edit-wire-model.mjs';
import {OwnedFixtureLifetime, inheritedTestCompileCache, startOwnedEditBackend, fixtureHttpRequest, fixtureLostAcknowledgement, until} from './agent-edit-wire-lifecycle.ts';
export {until};
export const EDIT_WIRE_TOKEN = 'synthetic-agent-edit-owned-backend-token';
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./agent-edit-wire-process.mjs', import.meta.url));
export const chatRoute = projectId => `/api/agent/chat/${projectId}`;
export const editRoute = (projectId, proposalId, action) => `${chatRoute(projectId)}/edits${proposalId ? `/${proposalId}` : ''}${action ? `/${action}` : ''}`;
export const DOMAIN_TABLES = ['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','timeline_history','timeline_history_cursors','timeline_requests','reference_requests','idempotency','job_events'];
export const startEditBackend = (root, lifetime) => startOwnedEditBackend(root, {repo: REPO, entry: CHILD, token: EDIT_WIRE_TOKEN, lifetime});
export function database(root, action, {writable = false} = {}) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  try { return action(db); } finally { db.close(); }
}
export const tableSnapshot = (root, tables = DOMAIN_TABLES) => database(root, db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
export const savedShot = (root, id) => database(root, db => JSON.parse(db.prepare('SELECT data FROM shots WHERE id=?').get(id).data));
export const savedProposal = (root, id) => database(root, db => db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(id));
export async function editWireFixture(t, protocol) {
  const lifetime = new OwnedFixtureLifetime(t);
  const root = await lifetime.acquire(() => mkdtemp(path.join(tmpdir(), 'mioon-edit-wire-')), value => rm(value, {recursive: true, force: true}));
  const model = await lifetime.acquire(() => startEditWireModel(), value => value.close());
  let current = await startEditBackend(root, lifetime);
  const f = {root, model, protocol, lifetime, testRuntimeEnvironment: inheritedTestCompileCache(), signal: lifetime.signal, deferCleanup: dispose => lifetime.deferCleanup(dispose), get process() { return current; },
    async restart({crash = false} = {}) {
      lifetime.assertActive();
      const before = current;
      const ended = await (crash ? before.crash() : before.close());
      if (crash) assert.equal(ended.signal, 'SIGKILL'); else if (ended.signal !== 'SIGKILL') assert.deepEqual(ended, {code: 0, signal: null}, before.output);
      lifetime.assertActive();
      const next = await startEditBackend(root, lifetime); lifetime.assertActive(); current = next;
      assert.notEqual(current.child.pid, before.child.pid); return current;
    },
    request(route, options) { return fixtureHttpRequest(lifetime, current.url + route, EDIT_WIRE_TOKEN, options); },
    async data(route, options) { const result = await this.request(route, options); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data; },
    rpc(operation, input = {}) { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    async setup() {
      const project = await this.rpc('project.create', {name: 'UNSELECTED_PROJECT_NAME_MUST_NOT_REACH_MODEL'});
      const shot = await this.rpc('shot.create', {projectId: project.id, title: 'Original saved title', prompt: 'Original saved prompt'});
      return {project, shot};
    },
    async input(projectId, shot, {message = 'Improve this selected saved shot', context = 'selected_shot_edit', consent: overrides, ...changes} = {}) {
      const snapshot = await this.data(chatRoute(projectId)), configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot((...args)=>this.request(...args),snapshot,context);
      const base = {destination: deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model, context};
      let consent = base;
      if (context === 'selected_shot_edit') {
        assert.equal(snapshot.edit?.available, true, JSON.stringify(snapshot.edit)); const {available, ...policy} = snapshot.edit;
        consent = {...base, projectId, ...policy, shotId: shot.id, expectedRevision: shot.revision};
      }
      return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
        expectedConversationRevision: snapshot.revision, message, consent: {...consent, ...overrides}, ...changes};
    },
    send(projectId, input) { return this.data(`${chatRoute(projectId)}/runs`, {method: 'POST', input}); },
    lookup(projectId, requestId) { return this.data(`${chatRoute(projectId)}/requests/${requestId}`); },
    terminal(projectId, requestId) { return until(async () => { const result = await this.lookup(projectId, requestId); return result.run.status !== 'running' && result; }, 'terminal Agent run', 10000, lifetime.signal); },
    proposals(projectId, query = '') { return this.data(editRoute(projectId) + query); },
    proposal(projectId, id) { return this.data(editRoute(projectId, id)); },
    async action(projectId, proposal, action, overrides = {}) {
      const snapshot = await this.proposal(projectId, proposal.id);
      return this.data(editRoute(projectId, proposal.id, action), {method: 'POST', input: {instanceId: snapshot.instanceId, digest: proposal.digest, ...overrides}});
    },
    async propose(projectId, shot, plan = {}) {
      model.plan(plan); const input = await this.input(projectId, shot), sent = await this.send(projectId, input);
      const done = await this.terminal(projectId, input.requestId);
      const listed = await this.proposals(projectId, '?view=all');
      const proposal = listed.proposals.find(proposal => proposal.runId === sent.run.id);
      return {input, sent, done, proposal};
    },
    lostAcknowledgement(route, input) { return fixtureLostAcknowledgement(lifetime, current.url + route, EDIT_WIRE_TOKEN, input); },
    async trace() { try { return (await readFile(path.join(root, 'edit-fault-trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
  };
  const settings = await f.data('/api/agent/settings');
  await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: settings.revision,
    configuration: {protocol, presetId: 'ollama', platformId: 'local', baseUrl: model.baseUrl, model: 'qwen3:8b'}, secret: {action: 'remove'}}});
  return f;
}

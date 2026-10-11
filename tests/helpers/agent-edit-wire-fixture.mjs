import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {startEditWireModel} from './agent-edit-wire-model.mjs';
export const EDIT_WIRE_TOKEN = 'synthetic-agent-edit-owned-backend-token';
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./agent-edit-wire-process.mjs', import.meta.url));
export const chatRoute = projectId => `/api/agent/chat/${projectId}`;
export const editRoute = (projectId, proposalId, action) => `${chatRoute(projectId)}/edits${proposalId ? `/${proposalId}` : ''}${action ? `/${action}` : ''}`;
export const DOMAIN_TABLES = ['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','timeline_history','timeline_history_cursors','timeline_requests','reference_requests','idempotency','job_events'];
export async function until(check, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(15); }
  assert.fail(`Timed out: ${label}`);
}
function deadline(promise, label, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
export async function startEditBackend(root) {
  const child = spawn(process.execPath, [CHILD], {cwd: REPO, stdio: ['ignore','pipe','pipe','ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test'}});
  let output = '', readyResolve, readyReject;
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20000); });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject); });
  const replies = new Map(), ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', message => {
    if (message.type === 'ready') readyResolve(message);
    else if (message.type === 'error') readyReject(Error(message.message));
    else if (message.type === 'reply') replies.get(message.requestId)?.(message.data);
  });
  exited.then(result => readyReject(Error(`Owned backend exited: ${JSON.stringify(result)}\n${output}`)), readyReject);
  const running = () => child.exitCode === null && child.signalCode === null;
  const ask = async message => {
    const requestId = randomUUID();
    try { return await deadline(new Promise(resolve => { replies.set(requestId, resolve); child.send({...message, requestId}); }), 'owned backend IPC'); }
    finally { replies.delete(requestId); }
  };
  const instance = {child, exited, get output() { return output; },
    observe: () => ask({type: 'observe'}), arm: boundary => ask({type: 'arm', boundary}),
    async crash() { if (running()) assert.equal(child.kill('SIGKILL'), true); return deadline(exited, 'owned backend crash'); },
    async close() { if (running()) { child.send({type: 'close'}); try { return await deadline(exited, 'owned backend close'); } catch (error) { await this.crash(); throw error; } } return exited; },
  };
  try {
    child.send({type: 'start', dataDir: root, token: EDIT_WIRE_TOKEN});
    const result = await deadline(ready, 'owned backend readiness'); assert.equal(result.pid, child.pid);
    instance.url = result.url; assert.equal((await instance.observe()).acquisitions, 0); return instance;
  } catch (error) { await instance.crash(); throw Error(`${error.message}\n${output}`, {cause: error}); }
}
export function database(root, action, {writable = false} = {}) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  try { return action(db); } finally { db.close(); }
}
export const tableSnapshot = (root, tables = DOMAIN_TABLES) => database(root, db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
export const savedShot = (root, id) => database(root, db => JSON.parse(db.prepare('SELECT data FROM shots WHERE id=?').get(id).data));
export const savedProposal = (root, id) => database(root, db => db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(id));
export async function editWireFixture(t, protocol) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-wire-')), model = await startEditWireModel();
  let current;
  t.after(async () => { try { await current?.close(); } finally { await model.close(); await rm(root, {recursive: true, force: true}); } });
  current = await startEditBackend(root);
  const f = {root, model, protocol, get process() { return current; },
    async restart({crash = false} = {}) {
      const before = current;
      const ended = await (crash ? before.crash() : before.close());
      if (crash) assert.equal(ended.signal, 'SIGKILL'); else if (ended.signal !== 'SIGKILL') assert.deepEqual(ended, {code: 0, signal: null}, before.output);
      current = await startEditBackend(root); assert.notEqual(current.child.pid, before.child.pid); return current;
    },
    async request(route, {method = 'GET', input, raw, authenticated = true, headers = {}} = {}) {
      const response = await fetch(current.url + route, {method, signal: AbortSignal.timeout(12000),
        headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${EDIT_WIRE_TOKEN}`} : {}), ...headers},
        ...(raw !== undefined || input !== undefined ? {body: raw ?? JSON.stringify(input)} : {})});
      const text = await response.text();
      return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
    },
    async data(route, options) { const result = await this.request(route, options); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data; },
    rpc(operation, input = {}) { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    async setup() {
      const project = await this.rpc('project.create', {name: 'UNSELECTED_PROJECT_NAME_MUST_NOT_REACH_MODEL'});
      const shot = await this.rpc('shot.create', {projectId: project.id, title: 'Original saved title', prompt: 'Original saved prompt'});
      return {project, shot};
    },
    async input(projectId, shot, {message = 'Improve this selected saved shot', context = 'selected_shot_edit', consent: overrides, ...changes} = {}) {
      const snapshot = await this.data(chatRoute(projectId)), configuration = snapshot.settings.configuration;
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
    terminal(projectId, requestId) { return until(async () => { const result = await this.lookup(projectId, requestId); return result.run.status !== 'running' && result; }, 'terminal Agent run'); },
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
    async lostAcknowledgement(route, input) {
      return deadline(new Promise((resolve, reject) => {
        const request = http.request(current.url + route, {method: 'POST', headers: {authorization: `Bearer ${EDIT_WIRE_TOKEN}`, 'content-type': 'application/json'}}, response => {
          const status = response.statusCode; response.destroy(); resolve(status);
        }); request.once('error', reject); request.end(JSON.stringify(input));
      }), 'deliberately lost HTTP acknowledgement');
    },
    async trace() { try { return (await readFile(path.join(root, 'edit-fault-trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
  };
  const settings = await f.data('/api/agent/settings');
  await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: settings.revision,
    configuration: {protocol, presetId: 'ollama', platformId: 'local', baseUrl: model.baseUrl, model: 'qwen3:8b'}, secret: {action: 'remove'}}});
  return f;
}

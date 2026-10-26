import type {Failure} from './helpers/strict-agent-workspace-types.ts';
import {authorizeHttpSnapshot} from './helpers/agent-authorizations.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync, type SQLInputValue, type SQLOutputValue} from 'node:sqlite';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {responsesFixture, frameResponsesEvent} from './agent-responses-fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHILD = fileURLToPath(new URL('./helpers/agent-chat-crash-process.ts', import.meta.url));
const TOKEN = 'synthetic-durable-chat-subprocess-token';
const PREFIX = '已提交的回复 / committed partial';
const LATE = 'LATE_BYTES_MUST_NEVER_BE_COMMITTED';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DOMAIN_TABLES = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines',
  'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'reference_requests', 'idempotency', 'job_events'];
const JOURNAL_TABLES = ['agent_chat_threads', 'agent_chat_requests', 'agent_chat_runs', 'agent_chat_events', 'agent_chat_quota'];
const route = (projectId: unknown) => `/api/agent/chat/${projectId}`;
const deadline = <T>(promise: Promise<T>, ms: number|undefined, description: string) => {
  let timer: string|number|NodeJS.Timeout|undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${description}`)), ms);
  })]).finally(() => clearTimeout(timer));
};
async function until<T>(check: ()=>T|Promise<T>, description: string, ms = 10000): Promise<Exclude<Awaited<T>,false|0|''|null|undefined>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result as Exclude<Awaited<T>,false|0|''|null|undefined>;
    await delay(25);
  }
  assert.fail(`Timed out: ${description}`);
}

async function backend(dataDir: string) {
  // Deliberately do not inherit credentials, proxy settings, or Node injections.
  const child = spawn(process.execPath, [CHILD], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: dataDir, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test'},
  });
  let output = '', acquisitions = 0;
  const observations = new Map<string,(count:number)=>void>();
  for (const stream of [child.stdout, child.stderr] as const) stream!.setEncoding('utf8').on('data', chunk => { output = (output + chunk.toString()).slice(-32000); });
  const exited = new Promise<import('./helpers/strict-agent-workspace-types.ts').BackendExit>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({code, signal}));
    child.once('error', reject);
  });
  let readyResolve: (message:import('./helpers/strict-agent-workspace-types.ts').BackendMessage)=>void, readyReject!: (reason:Error)=>void;
  const ready = new Promise<import('./helpers/strict-agent-workspace-types.ts').BackendMessage>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', message => {
    if ((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).type === 'ready') readyResolve((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage));
    if ((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).type === 'error') readyReject(Error((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).message));
    if (typeof (message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).acquisitions === 'number') acquisitions = (message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).acquisitions;
    if ((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).type === 'observed') observations.get((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).requestId)?.((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).acquisitions);
  });
  exited.then(result => readyReject(Error(`Backend exited before readiness: ${JSON.stringify(result)}\n${output}`)), readyReject);
  const running = () => child.exitCode === null && child.signalCode === null;
  async function killOwned() {
    if (running()) {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid! > 0);
      assert.equal(child.kill('SIGKILL'), true, `Could not stop owned backend PID ${child.pid}`);
    }
    return deadline(exited, 10000, `owned backend PID ${child.pid} exit`);
  }
  const instance = {
    child, exited, get acquisitions() { return acquisitions; }, get output() { return output; },
    async observe() {
      const requestId = randomUUID();
      try {
        return await deadline(new Promise<number>(resolve => {
          observations.set(requestId, resolve);
          child.send({type: 'observe', requestId});
        }), 5000, 'credential-acquisition observation');
      } finally { observations.delete(requestId); }
    },
    crash: killOwned,
    async close() {
      if (!running()) return exited;
      child.send({type: 'close'});
      try { return await deadline(exited, 10000, 'graceful owned backend close'); }
      catch (error) { await killOwned(); throw error; }
    },
  } as unknown as import('./helpers/strict-agent-workspace-types.ts').BackendInstance;
  try {
    child.send({type: 'start', dataDir, token: TOKEN});
    const message = await deadline(ready, 15000, 'backend readiness');
    assert.equal((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).pid, child.pid);
    assert.equal((message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).acquisitions, 0, 'startup must never acquire credentials');
    instance.url = (message as import('./helpers/strict-agent-workspace-types.ts').BackendMessage).url;
    return instance;
  } catch (error) { await killOwned(); throw Error(`${(error as Failure).message}\n${output}`, {cause: error}); }
}

async function fixture(t: test.TestContext, protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol, {hold = false} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-chat-durable-crash-'));
  const captures: import('./helpers/strict-agent-workspace-types.ts').AgentHttpCapture[] = [], pending: { capture: { method: string|undefined; path: string|undefined; headers: http.IncomingHttpHeaders; body: unknown; closed: boolean; completed: boolean; lateAttempted: boolean; }; attemptLate(): void; }[] = [];
  let current!: import('./helpers/strict-agent-workspace-types.ts').BackendInstance, model!: http.Server<typeof http.IncomingMessage,typeof http.ServerResponse>;
  t.after(async () => {
    try { await current?.close(); }
    finally {
      if (model) { model.closeAllConnections(); await new Promise<void>(resolve => model.close((resolve as unknown as ()=>void))); }
      await rm(root, {recursive: true, force: true});
    }
  });
  model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const capture = {method: req.method, path: req.url, headers: req.headers,
      body: JSON.parse((Buffer.concat(chunks).toString() as string)), closed: false, completed: false, lateAttempted: false};
    captures.push(capture);
    res.on('error', () => {});
    res.once('close', () => { capture.closed = true; });
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const native = responsesFixture({id: `resp_durable_${captures.length}`});
    const delta = (text: string) => protocol === 'responses' ? frameResponsesEvent(native.delta(text)) :
      `data: ${JSON.stringify({choices: [{index: 0, delta: {role: 'assistant' as const, content: text}, finish_reason: null}]})}\n\n`;
    const terminal = () => protocol === 'responses' ? native.complete().map(frameResponsesEvent).join('') :
      `data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`;
    if (protocol === 'responses') for (const event of native.start()) res.write(frameResponsesEvent(event));
    res.write(delta(PREFIX));
    const controller = {
      capture,
      attemptLate() { capture.lateAttempted = true; res.write(delta(LATE)); res.end(terminal()); },
    };
    pending.push(controller);
    if (!hold) { capture.completed = true; res.end(terminal()); }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  current = await backend(root);
  const f = {
    root, captures, pending, get process() { return current; },
    async restart({crash = false} = {}) {
      const previous = current;
      const result = await (crash ? previous.crash!() : previous.close());
      if (crash) assert.equal(result.signal, 'SIGKILL');
      else assert.deepEqual(result, {code: 0, signal: null}, previous.output);
      current = await backend(root);
      assert.notEqual(current.child.pid, previous.child.pid);
      return current;
    },
    async request(suffix: string|{ method: string; input: unknown; }, {method = 'GET', input, authenticated = true, headers = {}}: import('./helpers/strict-agent-workspace-types.ts').HttpFixtureRequest = {}) {
      const response = await fetch(current.url + suffix, {method,
        headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${TOKEN}`} : {}), ...headers},
        ...(input === undefined ? {} : {body: JSON.stringify(input)}), signal: AbortSignal.timeout(10000)});
      return {status: response.status, body: await response.json()};
    },
    async data(suffix: string, options?: import('./helpers/strict-agent-workspace-types.ts').HttpFixtureRequest) {
      const result = await this.request(suffix, options);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true, JSON.stringify(result.body));
      return result.body.data;
    },
    async project(name = 'PRIVATE_PROJECT_MUST_NOT_REACH_MODEL') {
      return this.data('/api/rpc', {method: 'POST', input: {operation: 'project.create', input: {name}}});
    },
    async snapshot(projectId: unknown) { return this.data(route(projectId)); },
    async input(projectId: unknown, message = 'Synthetic typed text') {
      const snapshot = await this.snapshot(projectId);
      await authorizeHttpSnapshot((...args)=>this.request(...args),snapshot);
      return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
        expectedConversationRevision: snapshot.revision, message,
        consent: {destination: deriveAgentEndpoint(snapshot.settings.configuration), protocol: snapshot.settings.configuration.protocol,
          model: snapshot.settings.configuration.model, context: 'typed_chat_only'}};
    },
    async lookup(projectId: unknown, requestId: string) { return this.data(`${route(projectId)}/requests/${requestId}`); },
    async send(projectId: unknown, input: { requestId: `${string}-${string}-${string}-${string}-${string}`; instanceId: unknown; expectedSettingsRevision: unknown; expectedConversationRevision: unknown; message: string; consent: { destination: string; protocol: unknown; model: unknown; context: string; }; }) { return this.data(`${route(projectId)}/runs`, {method: 'POST', input}); },
    async terminal(projectId: unknown, requestId: string) {
      return until(async () => { const value = await this.lookup(projectId, requestId); return value.run.status !== 'running' && value; }, 'terminal run');
    },
    async stream(projectId: unknown, runId: unknown, epoch: unknown, after = 0) {
      const response = await fetch(`${current.url}${route(projectId)}/runs/${runId}/events?instanceId=${epoch}&after=${after}`,
        {headers: {authorization: `Bearer ${TOKEN}`}, signal: AbortSignal.timeout(15000)});
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /^text\/event-stream/u);
      return response;
    },
    async loseAcknowledgement(projectId: unknown, input: { requestId: `${string}-${string}-${string}-${string}-${string}`; instanceId: unknown; expectedSettingsRevision: unknown; expectedConversationRevision: unknown; message: string; consent: { destination: string; protocol: unknown; model: unknown; context: string; }; }) {
      // Send exactly once, then tear down the response before consuming any JSON
      // acknowledgement. Recovery must use the caller's pre-existing request ID.
      return deadline(new Promise((resolve, reject) => {
        const req = http.request(current.url + route(projectId) + '/runs', {
          method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        }, res => { const status = res.statusCode; res.destroy(); resolve(status); });
        req.once('error', reject);
        req.end(JSON.stringify(input));
      }), 10000, 'deliberately lost acknowledgement');
    },
  };
  const settings = await f.data('/api/agent/settings');
  await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: settings.revision,
    configuration: {protocol, presetId: 'ollama', platformId: 'local', baseUrl: `http://127.0.0.1:${(model.address() as import('node:net').AddressInfo)!.port}/v1`, model: 'qwen3:8b'},
    secret: {action: 'remove'}}});
  assert.equal(captures.length, 0);
  assert.equal(await current.observe(), 0);
  return f;
}

function journal(root: string, requestId: SQLInputValue) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  try {
    const receipt = db.prepare('SELECT * FROM agent_chat_requests WHERE requestId=?').get(requestId);
    const run = receipt && db.prepare('SELECT * FROM agent_chat_runs WHERE id=?').get(receipt.runId);
    const events = run ? db.prepare('SELECT seq,data FROM agent_chat_events WHERE runId=? ORDER BY seq').all(run.id) : [];
    return {receipt, acceptance: receipt && JSON.parse(((receipt.acceptance as string))), run, data: run && JSON.parse(((run.data as string))), events};
  } finally { db.close(); }
}
function tableSnapshot(root: string, tables: string[]) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  try { return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
function assertPrivateRecord(record: { receipt: Record<string,SQLOutputValue>|undefined; acceptance: unknown; run: Record<string,SQLOutputValue>|undefined; data: unknown; events: Record<string,SQLOutputValue>[]; }) {
  assert.equal(JSON.stringify(record).includes(TOKEN), false);
  for (const secretKey of ['apiKey', 'authorization', 'accessToken', 'encrypted', 'credential'] as const) {
    assert.equal(new RegExp(`"${secretKey}"\\s*:`, 'iu').test(JSON.stringify(record)), false, `journal must not persist ${secretKey}`);
  }
}
function assertWire(capture: import('./helpers/strict-agent-workspace-types.ts').AgentHttpCapture, protocol: string, userMessages: string[]) {
  assert.equal(capture.method, 'POST');
  assert.equal(capture.path, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
  assert.equal(capture.headers.authorization, undefined);
  assert.equal(capture.body.model, 'qwen3:8b');
  assert.equal(capture.body.stream, true);
  assert.equal(JSON.stringify(capture.body).includes('PRIVATE_PROJECT'), false);
  for (const key of ['tools', 'previous_response_id', 'conversation', 'background', 'metadata'] as const) assert.equal(capture.body[key], undefined);
  if (protocol === 'responses') {
    assert.equal(capture.body.messages, undefined);
    assert.equal(capture.body.store, false);
    assert.equal(capture.body.truncation, undefined, 'Ollama uses its dedicated supported field profile');
    assert.equal(capture.body.max_output_tokens, 2048);
    assert.deepEqual(capture.body.reasoning, {effort: 'none'});
    assert.match(capture.body.instructions, /no access to projects/u);
    assert.deepEqual(capture.body.input.filter((item) => item.role === 'user').map((item) => item.content), userMessages);
  } else {
    assert.match(capture.body.messages[0].content, /no access to projects/u);
    assert.deepEqual(capture.body.messages.filter((item) => item.role === 'user').map((item) => item.content), userMessages);
  }
}
function parseEvents(text: string) {
  const frames = text.split('\n\n');
  frames.pop(); // Ignore an incomplete trailing frame while a live SSE is held.
  return frames.filter((frame) => frame.includes('\ndata: ')).map((frame) => {
    const id = Number(/^id: (\d+)$/mu.exec(frame)?.[1]);
    const event = JSON.parse((/^data: (.*)$/mu.exec(frame)![1] as string));
    assert.equal(id, event.id);
    return event;
  });
}
function assertMonotonic(events: {id:number}[]) {
  assert.ok(events.length > 0);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].id > events[i - 1].id, 'event IDs must increase strictly');
}
async function assertOldEpochBlocked(f: Awaited<ReturnType<typeof fixture>>, projectId: unknown, input: { requestId?: `${string}-${string}-${string}-${string}-${string}`; instanceId: unknown; expectedSettingsRevision?: unknown; expectedConversationRevision?: unknown; message?: string; consent?: { destination: string; protocol: unknown; model: unknown; context: string; }; }, runId: unknown) {
  const base = route(projectId);
  for (const [suffix, options] of [
    ['/runs', {method: 'POST', input}],
    [`/runs/${runId}?instanceId=${input.instanceId}`, {}],
    [`/runs/${runId}/events?instanceId=${input.instanceId}&after=0`, {}],
    [`/runs/${runId}/stop`, {method: 'POST', input: {instanceId: input.instanceId}}],
  ] as const) {
    const response = await f.request(base + suffix, options);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'AGENT_CHAT_SESSION_EXPIRED');
  }
}

for (const protocol of ['chat_completions', 'responses'] as const) {
  test(`${protocol}: completed and lost-acknowledgement runs survive an actual backend restart without replaying inference`, {timeout: 60000}, async t => {
    const f = await fixture(t, protocol), project = await f.project(), foreign = await f.project('Other project');
    const domainBefore = tableSnapshot(f.root, DOMAIN_TABLES), emptyJournal = tableSnapshot(f.root, JOURNAL_TABLES);
    const initial = await f.snapshot(project.id);
    assert.equal(initial.persistence, 'local_database');
    assert.match(initial.threadId, UUID);
    assert.deepEqual(initial.runs, []);
    assert.deepEqual(tableSnapshot(f.root, JOURNAL_TABLES), emptyJournal, 'an empty read does not materialize a thread');
    const input = await f.input(project.id, 'Durable first user turn');
    assert.equal(await f.loseAcknowledgement(project.id, input), 200);
    const completed = await f.terminal(project.id, input.requestId);
    assert.equal(completed.run.status, 'completed');
    assert.equal(completed.run.assistantText, PREFIX);
    assert.equal(completed.run.requestId, input.requestId);
    const accepted = journal(f.root, input.requestId);
    assert.equal(accepted.receipt!.threadId, initial.threadId);
    assert.equal(accepted.acceptance.instanceId, initial.instanceId);
    assert.deepEqual(accepted.acceptance.configuration, completed.run.configuration);
    const capturedContext = protocol === 'responses' ?
      [{role: 'system' as const, content: f.captures[0].body.instructions}, ...f.captures[0].body.input] : f.captures[0].body.messages;
    assert.deepEqual(accepted.acceptance.messages, capturedContext, 'journal freezes the exact ordered gateway context');
    assertPrivateRecord(accepted);
    const replay = await f.send(project.id, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, completed.run.id);
    assert.equal(f.captures.length, 1);
    assertWire((((f.captures[0]!))), protocol, [input.message]);
    const ledger = tableSnapshot(f.root, JOURNAL_TABLES);

    await f.restart();
    const snapshot = await f.snapshot(project.id), recovered = await f.lookup(project.id, input.requestId);
    assert.notEqual(snapshot.instanceId, initial.instanceId);
    assert.equal(snapshot.threadId, initial.threadId);
    assert.equal(snapshot.persistence, 'local_database');
    assert.equal(recovered.instanceId, snapshot.instanceId);
    assert.equal(recovered.threadId, snapshot.threadId);
    assert.deepEqual(recovered.run, completed.run);
    assert.deepEqual(snapshot.runs, [completed.run]);
    assert.equal(snapshot.revision, completed.revision);
    await assertOldEpochBlocked(f, project.id, input, completed.run.id);
    const foreignLookup = await f.request(`${route(foreign.id)}/requests/${input.requestId}`);
    const missingLookup = await f.request(`${route(foreign.id)}/requests/${randomUUID()}`);
    assert.equal(foreignLookup.status, 404);
    assert.deepEqual(foreignLookup.body, missingLookup.body, 'foreign request existence must not leak');
    assert.equal((await f.request(`${route(project.id)}/requests/${input.requestId}`, {authenticated: false})).status, 401);
    assert.equal((await f.request(`${route(project.id)}/requests/${input.requestId}`, {headers: {origin: 'https://evil.example'}})).status, 403);
    const events = parseEvents(await (await f.stream(project.id, completed.run.id, snapshot.instanceId)).text());
    assertMonotonic(events);
    assert.ok(events.every((event: { instanceId: unknown; }) => event.instanceId === snapshot.instanceId));
    assert.equal(events.at(-1).run.status, 'completed');
    assert.equal(events.at(-1).id, completed.run.lastEventId);
    assert.deepEqual(journal(f.root, input.requestId), accepted, 'read-only recovery must leave durable records unchanged');
    assert.deepEqual(tableSnapshot(f.root, JOURNAL_TABLES), ledger, 'read-only recovery does not change any journal or quota row');
    assert.equal(await f.process.observe(), 0, 'restart, lookup, replay and denied stale sends must not acquire credentials');
    assert.equal(f.captures.length, 1);

    const nextInput = await f.input(project.id, 'Explicit second user turn');
    await f.send(project.id, nextInput);
    assert.equal((await f.terminal(project.id, nextInput.requestId)).run.status, 'completed');
    assert.equal(f.captures.length, 2);
    assertWire((((f.captures[1]!))), protocol, [input.message, nextInput.message]);
    assert.equal(await f.process.observe(), 1);
    assert.deepEqual(journal(f.root, input.requestId).acceptance, accepted.acceptance);
    assert.deepEqual(tableSnapshot(f.root, DOMAIN_TABLES), domainBefore, 'chat and restart do not change project/business records');
  });

  test(`${protocol}: forced owned-process crash preserves committed SSE prefix; stop/restart rejects late writes`, {timeout: 60000}, async t => {
    const f = await fixture(t, protocol, {hold: true}), project = await f.project();
    const initial = await f.snapshot(project.id), input = await f.input(project.id, 'Interrupt this explicitly accepted turn');
    const sent = await f.send(project.id, input);
    const partial = await until(async () => {
      const current = await f.lookup(project.id, input.requestId);
      return current.run.assistantText === PREFIX && current;
    }, 'public committed prefix');
    const committed = journal(f.root, input.requestId);
    assert.equal(committed.data.assistantText, PREFIX, 'prefix must be in SQLite before the forced crash');
    assert.equal(committed.data.status, 'running');
    assert.equal(committed.data.modelRequestState, 'dispatch_started');
    assert.equal(committed.data.lastEventId, partial.run.lastEventId);
    assertPrivateRecord(committed);
    const stream = await f.stream(project.id, sent.run.id, sent.instanceId);
    let streamText = '';
    const decoder = new TextDecoder();
    const streamEnded = (async () => {
      try { for await (const chunk of stream.body!) streamText += decoder.decode(chunk, {stream: true}); }
      catch (error) { return error; }
    })();
    await until(() => parseEvents(streamText).some((event: { text: string; run: { assistantText: string; }; }) => event.text === PREFIX || event.run?.assistantText === PREFIX), 'active SSE received committed prefix');
    const beforeEvents = parseEvents(streamText);
    assertMonotonic(beforeEvents);
    const beforeCursor = beforeEvents.at(-1).id;

    // Changing future settings cannot rewrite an already accepted request.
    const settings = await f.data('/api/agent/settings');
    await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: settings.revision,
      configuration: {...settings.configuration, model: 'future-settings-model'}, secret: {action: 'keep'}}});
    assert.deepEqual(journal(f.root, input.requestId).acceptance, committed.acceptance);
    await f.restart({crash: true});
    await deadline(streamEnded, 5000, 'SSE closes after owned process crash');
    await until(() => f.captures[0].closed, 'crash closed actual upstream socket');
    assert.equal(f.captures[0].completed, false);
    const snapshot = await f.snapshot(project.id), recovered = await f.lookup(project.id, input.requestId);
    assert.equal(snapshot.threadId, initial.threadId);
    assert.notEqual(snapshot.instanceId, initial.instanceId);
    assert.equal(recovered.run.id, sent.run.id);
    assert.equal(recovered.run.requestId, input.requestId);
    assert.equal(recovered.run.status, 'interrupted');
    assert.equal(recovered.run.assistantText, PREFIX);
    assert.equal(recovered.run.modelRequestId, committed.data.modelRequestId);
    assert.equal(recovered.run.modelRequestState, 'unknown', 'a crashed dispatch remains outcome-unknown, never resumable');
    assert.deepEqual(recovered.run.configuration, committed.acceptance.configuration);
    assert.ok(recovered.run.lastEventId > beforeCursor);
    const afterEvents = parseEvents(await (await f.stream(project.id, sent.run.id, snapshot.instanceId, beforeCursor)).text());
    assertMonotonic(afterEvents);
    assert.ok(afterEvents.every((event: { id: number; instanceId: unknown; }) => event.id > beforeCursor && event.instanceId === snapshot.instanceId));
    assert.equal(afterEvents.at(-1).run.status, 'interrupted');
    await assertOldEpochBlocked(f, project.id, input, sent.run.id);
    assert.deepEqual(journal(f.root, input.requestId).acceptance, committed.acceptance);
    assert.equal(await f.process.observe(), 0, 'crash recovery must not reacquire credentials');
    assert.equal(f.captures.length, 1, 'crash recovery must never redispatch inference');

    const changed = await f.data('/api/agent/settings');
    await f.data('/api/agent/settings', {method: 'PUT', input: {expectedRevision: changed.revision,
      configuration: committed.acceptance.configuration, secret: {action: 'keep'}}});
    const stopInput = await f.input(project.id, 'New explicit turn to stop');
    const stopRun = await f.send(project.id, stopInput);
    await until(async () => (await f.lookup(project.id, stopInput.requestId)).run.assistantText === PREFIX, 'stop prefix');
    const stopped = await f.data(`${route(project.id)}/runs/${stopRun.run.id}/stop`, {method: 'POST', input: {instanceId: snapshot.instanceId}});
    assert.equal(stopped.run.status, 'stopped');
    assert.equal(stopped.run.assistantText, PREFIX);
    f.pending[1].attemptLate();
    await until(() => f.captures[1].closed, 'Stop closes actual upstream socket');
    assert.equal(f.captures[1].lateAttempted, true);
    assert.deepEqual((await f.lookup(project.id, stopInput.requestId)).run, stopped.run);
    assert.deepEqual((await f.data(`${route(project.id)}/runs/${stopRun.run.id}/stop`, {method: 'POST', input: {instanceId: snapshot.instanceId}})).run, stopped.run);
    const stoppedJournal = journal(f.root, stopInput.requestId);
    assert.equal(stoppedJournal.data.assistantText, PREFIX);
    assertWire((((f.captures[1]!))), protocol, [stopInput.message]);
    await f.restart();
    assert.deepEqual((await f.lookup(project.id, stopInput.requestId)).run, stopped.run);
    assert.deepEqual(journal(f.root, stopInput.requestId), stoppedJournal, 'restart cannot append late bytes or another terminal event');
    assert.equal((await f.lookup(project.id, input.requestId)).run.status, 'interrupted');
    assert.equal(await f.process.observe(), 0);
    assert.equal(f.captures.length, 2);
  });
}

test('durable history keeps the latest 16 runs and read-only older pages/request lookup across process restart', {timeout: 60000}, async t => {
  const f = await fixture(t, 'chat_completions'), project = await f.project(), foreign = await f.project('Foreign history');
  const accepted: {input: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['input']>>;completed: import('./helpers/strict-agent-workspace-types.ts').RuntimeEnvelope}[] = [];
  for (let i = 0; i < 18; i++) {
    const input = await f.input(project.id, `History turn ${i}`);
    await f.send(project.id, input);
    accepted.push({input, completed: await f.terminal(project.id, input.requestId)});
  }
  const snapshot = await f.snapshot(project.id);
  assert.equal(snapshot.runs.length, 16);
  assert.deepEqual(snapshot.runs.map((run: { id: unknown; }) => run.id), accepted.slice(2).map(item => item.completed.run.id));
  assert.match(snapshot.historyCursor, UUID);
  const page = await f.data(`${route(project.id)}/history?before=${snapshot.historyCursor}`);
  assert.deepEqual(page.runs.map((run: { id: unknown; }) => run.id), accepted.slice(0, 2).map(item => item.completed.run.id));
  assert.equal(page.historyCursor, null);
  assert.equal((await f.request(`${route(foreign.id)}/history?before=${snapshot.historyCursor}`)).status, 404);
  assert.equal((await f.request(`${route(project.id)}/history?before=not-a-uuid`)).status, 400);
  assert.equal(f.captures.length, 18);
  const receipts = accepted.map(item => journal(f.root, item.input.requestId));
  await f.restart();
  const fresh = await f.snapshot(project.id);
  assert.equal(fresh.threadId, snapshot.threadId);
  assert.equal(fresh.historyCursor, snapshot.historyCursor);
  assert.deepEqual(fresh.runs, snapshot.runs);
  const older = await f.data(`${route(project.id)}/history?before=${fresh.historyCursor}`);
  assert.deepEqual(older.runs, page.runs);
  assert.equal(older.instanceId, fresh.instanceId);
  assert.equal(older.threadId, fresh.threadId);
  for (let i = 0; i < accepted.length; i++) {
    const item = accepted[i];
    assert.deepEqual((await f.lookup(project.id, item.input.requestId)).run, item.completed.run);
    assert.deepEqual(journal(f.root, item.input.requestId), receipts[i]);
  }
  await assertOldEpochBlocked(f, project.id, accepted[0].input, accepted[0].completed.run.id);
  assert.equal(await f.process.observe(), 0);
  assert.equal(f.captures.length, 18);
});

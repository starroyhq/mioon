import {deriveAgentEndpoint} from '@mioon/contracts';
import {responsesFixture, frameResponsesEvent} from './agent-responses-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {setImmediate as turn} from 'node:timers/promises';
import {createChatHttp} from '../apps/server/src/chat-http.mjs';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.mjs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.mjs';

const token = 'synthetic-agent-chat-http-token';
const SECRET = 'SYNTHETIC_CHAT_HTTP_KEY';
async function fixture(t, {gateway, modelServer = false, hold = false, protocol = 'chat_completions', responseFault} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-chat-http-')); let calls = 0, providerAborted = 0, captures = [], upstream;
  if (modelServer) {
    upstream = http.createServer(async (req, res) => {
      calls++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
      captures.push({path: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString())});
      res.writeHead(200, {'content-type': 'text/event-stream'});
      if (protocol === 'responses') {
        const fixture = responsesFixture();
        for (const event of fixture.start()) res.write(frameResponsesEvent(event));
        res.write(frameResponsesEvent(fixture.delta('本地模拟回复')));
        res.on('close', () => { providerAborted++; });
        if (!hold) {
          if (responseFault === 'truncated') res.end();
          else if (responseFault) {
            if (responseFault === 'tool') for (const event of fixture.seal()) res.write(frameResponsesEvent(event));
            res.end(frameResponsesEvent(fixture[responseFault]()));
          }
          else res.end(fixture.complete().map(frameResponsesEvent).join(''));
        }
        return;
      }
      res.write('data: ' + JSON.stringify({choices: [{index: 0, delta: {role: 'assistant', content: '本地模拟回复'}, finish_reason: null}]}) + '\n\n');
      res.on('close', () => { providerAborted++; });
      if (!hold) res.end('data: ' + JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  }
  const options = {dataDir: root, port: 0, token, ...(modelServer ? {} : {chatGateway: async function* (input) { calls++; captures.push(input); if (gateway) yield* gateway(input); else { yield {type: 'delta', text: 'Synthetic response'}; yield {type: 'done', finishReason: 'stop'}; } }})};
  let server = await startServer(options);
  t.after(async () => { await server.close(); if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); } await rm(root, {recursive: true, force: true}); });
  const f = {root, captures, get calls() { return calls; }, get providerAborted() { return providerAborted; }, get server() { return server; },
    async restart() { await server.close(); server = await startServer(options); },
    async request(route, {method = 'GET', input, raw, authenticated = true, headers = {}} = {}) {
      const response = await fetch(server.url + route, {method, headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers}, ...(input !== undefined || raw !== undefined ? {body: raw ?? JSON.stringify(input)} : {})});
      return {status: response.status, headers: response.headers, body: await response.json()};
    },
    async stream(route, signal) { return fetch(server.url + route, {headers: {authorization: `Bearer ${token}`}, signal}); },
    async rpc(operation, input = {}) { const r = await this.request('/api/rpc', {method: 'POST', input: {operation, input}}); assert.equal(r.status, 200); return r.body.data; },
    async sendInput(projectId, changes = {}) { const snap = (await this.request(`/api/agent/chat/${projectId}`)).body.data;
      return {requestId: randomUUID(), instanceId: snap.instanceId, expectedSettingsRevision: snap.settings.revision, expectedConversationRevision: snap.revision,
        message: 'Synthetic typed text', consent: {destination: deriveAgentEndpoint(snap.settings.configuration), protocol: snap.settings.configuration.protocol, model: snap.settings.configuration.model, context: 'typed_chat_only'}, ...changes}; },
  };
  const setting = (await f.request('/api/agent/settings')).body.data;
  await f.request('/api/agent/settings', {method: 'PUT', input: {expectedRevision: setting.revision,
    configuration: modelServer ? {protocol, presetId: 'ollama', platformId: 'local', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'qwen3:8b'} : setting.configuration,
    secret: modelServer ? {action: 'remove'} : {action: 'replace', storage: 'session', value: SECRET}}});
  return f;
}
const route = project => `/api/agent/chat/${project}`;
async function completed(f, project, sent) {
  for (let i = 0; i < 200; i++) { const r = await f.request(`${route(project)}/runs/${sent.run.id}?instanceId=${sent.instanceId}`); if (r.body.data.run.status !== 'running') return r.body.data; }
  assert.fail('Synthetic completion did not arrive');
}
async function files(directory) { return (await Promise.all((await readdir(directory, {withFileTypes: true})).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : readFile(path.join(directory, entry.name), 'utf8')))).flat().join('\n'); }
function inspect(root, writable = false) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  return {db, snapshot: () => Object.fromEntries(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','timeline_history','timeline_history_cursors','timeline_requests','reference_requests','idempotency','job_events'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))};
}

test('all chat/SSE/stop routes retain authentication, origin, exact methods, bounded bodies and closed field schemas', async t => {
  const f = await fixture(t), project = await f.rpc('project.create', {name: 'Chat authorization fixture'}), base = route(project.id), input = await f.sendInput(project.id);
  const noAuth = await f.request(base, {authenticated: false}); assert.equal(noAuth.status, 401);
  assert.equal((await f.request(base, {headers: {origin: 'https://evil.example.com'}})).status, 403);
  for (const [suffix, method] of [['', 'POST'], ['/runs', 'GET'], [`/runs/${randomUUID()}`, 'POST'], [`/runs/${randomUUID()}/events`, 'POST'], [`/runs/${randomUUID()}/stop`, 'GET']]) {
    assert.equal((await f.request(base + suffix, {method, ...(method === 'POST' ? {input: {}} : {})})).status, 405);
  }
  assert.equal((await f.request(base + '/runs', {method: 'POST', raw: '{'})).status, 400);
  assert.equal((await f.request(base + '/runs', {method: 'POST', input: {...input, extra: SECRET}})).status, 400);
  assert.equal((await f.request(base + '/runs', {method: 'POST', raw: JSON.stringify(input) + ' '.repeat(16 * 1024)})).status, 413);
  assert.equal((await f.request(base + '?extra=1')).status, 400);
  assert.equal((await f.request(base + '/secret')).status, 404);
  assert.equal((await f.request(base + '/runs', {method: 'POST', input, headers: {'content-type': 'text/plain'}})).status, 400);
  const sent = (await f.request(base + '/runs', {method: 'POST', input})).body.data;
  for (const suffix of [`/runs/${sent.run.id}?instanceId=${sent.instanceId}`, `/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`, `/runs/${sent.run.id}/stop`]) {
    const method = suffix.endsWith('stop') ? 'POST' : 'GET';
    assert.equal((await f.request(base + suffix, {method, authenticated: false, ...(method === 'POST' ? {input: {instanceId: sent.instanceId}} : {})})).status, 401);
    assert.equal((await f.request(base + suffix, {method, headers: {origin: 'null'}, ...(method === 'POST' ? {input: {instanceId: sent.instanceId}} : {})})).status, 403);
  }
  for (const after of ['-1', 'NaN', '9007199254740992', '1&after=2']) assert.equal((await f.request(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=${after}`)).status, 400);
});

test('public snapshots, cursor SSE replay and repeated POST expose no key, mutate no project rows, and never re-infer', async t => {
  const f = await fixture(t), project = await f.rpc('project.create', {name: 'PRIVATE_PROJECT_RECORD'}), base = route(project.id);
  const mutable = inspect(f.root, true); mutable.db.prepare('DELETE FROM timelines WHERE projectId=?').run(project.id); mutable.db.close();
  const view = inspect(f.root), before = view.snapshot(); view.db.close();
  const input = await f.sendInput(project.id), sent = (await f.request(base + '/runs', {method: 'POST', input})).body.data;
  const done = await completed(f, project.id, sent); assert.equal(done.run.status, 'completed');
  const stream = await f.stream(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`), text = await stream.text();
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/); assert.match(text, /event: terminal/); assert.equal(text.includes(SECRET), false);
  const same = await f.request(base + '/runs', {method: 'POST', input}); assert.equal(same.body.data.run.id, sent.run.id); assert.equal(same.body.data.replayed, true); assert.equal(f.calls, 1);
  const snapshot = await f.request(base); assert.equal(JSON.stringify(snapshot.body).includes(SECRET), false); assert.equal(snapshot.body.data.runs.length, 1);
  assert.equal(JSON.stringify(f.captures[0].messages).includes('PRIVATE_PROJECT_RECORD'), false);
  const after = inspect(f.root); assert.deepEqual(after.snapshot(), before); after.db.close();
  const stored = await files(f.root); assert.equal(stored.includes(SECRET), false); assert.equal(stored.includes(input.message), false); assert.equal(stored.includes('Synthetic response'), false);
  for (const operation of ['agent.chat.send', 'agent.chat.stop', 'agent.secret.acquire']) assert.equal((await f.request('/api/rpc', {method: 'POST', input: {operation, input: {}}})).body.error.code, 'UNKNOWN_OPERATION');
});

test('project authorization precedes run, stop, event and idempotent replay; restart fails old instance instead of recreating', async t => {
  const f = await fixture(t), one = await f.rpc('project.create', {name: 'One'}), two = await f.rpc('project.create', {name: 'Two'}), input = await f.sendInput(one.id);
  const sent = (await f.request(route(one.id) + '/runs', {method: 'POST', input})).body.data; await completed(f, one.id, sent);
  for (const suffix of [`/runs/${sent.run.id}?instanceId=${sent.instanceId}`, `/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`]) assert.equal((await f.request(route(two.id) + suffix)).status, 404);
  assert.equal((await f.request(`${route(two.id)}/runs/${sent.run.id}/stop`, {method: 'POST', input: {instanceId: sent.instanceId}})).status, 404);
  assert.equal((await f.request(route(two.id) + '/runs', {method: 'POST', input})).body.error.code, 'AGENT_CHAT_IDEMPOTENCY_CONFLICT');
  await f.restart(); const fresh = (await f.request(route(one.id))).body.data;
  assert.notEqual(fresh.instanceId, sent.instanceId); assert.deepEqual(fresh.runs, []);
  assert.equal((await f.request(route(one.id) + '/runs', {method: 'POST', input})).body.error.code, 'AGENT_CHAT_SESSION_EXPIRED'); assert.equal(f.calls, 1);
});

test('real localhost synthetic gateway uses one inference POST and reattachment never sends another request', async t => {
  const f = await fixture(t, {modelServer: true}), project = await f.rpc('project.create', {name: 'Synthetic real transport'}), base = route(project.id), input = await f.sendInput(project.id);
  const sent = (await f.request(base + '/runs', {method: 'POST', input})).body.data, done = await completed(f, project.id, sent);
  assert.equal(done.run.status, 'completed'); assert.equal(done.run.assistantText, '本地模拟回复'); assert.equal(f.calls, 1);
  assert.equal(f.captures[0].method, 'POST'); assert.equal(f.captures[0].path, '/v1/chat/completions'); assert.equal(f.captures[0].headers.authorization, undefined);
  assert.equal(f.captures[0].body.model, 'qwen3:8b'); assert.equal(f.captures[0].body.tools, undefined);
  for (let i = 0; i < 3; i++) await (await f.stream(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=${done.run.lastEventId}`)).text();
  assert.equal(f.calls, 1);
});

test('detaching SSE leaves single response alive, Stop aborts actual upstream, and shutdown closes live SSE before drain', async t => {
  const f = await fixture(t, {modelServer: true, hold: true}), project = await f.rpc('project.create', {name: 'Synthetic stop transport'}), base = route(project.id);
  const input = await f.sendInput(project.id), sent = (await f.request(base + '/runs', {method: 'POST', input})).body.data;
  const first = await f.stream(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`), reader = first.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal((await f.request(`${base}/runs/${sent.run.id}?instanceId=${sent.instanceId}`)).body.data.run.status, 'running');
  const stop = await f.request(`${base}/runs/${sent.run.id}/stop`, {method: 'POST', input: {instanceId: sent.instanceId}}); assert.equal(stop.body.data.run.status, 'stopped');
  const secondInput = await f.sendInput(project.id), second = (await f.request(base + '/runs', {method: 'POST', input: secondInput})).body.data;
  const secondStream = await f.stream(`${base}/runs/${second.run.id}/events?instanceId=${second.instanceId}&after=0`);
  const fullStream = secondStream.text(), started = Date.now(); await f.server.close(); const ended = await fullStream;
  assert.ok(Date.now() - started < 2000, 'shutdown must not await provider or SSE timeout'); assert.match(ended, /"status":"interrupted"/);
  assert.ok(f.calls <= 2); assert.ok(f.providerAborted >= 1);
});


test('saturated SSE response detaches locally without sending Stop or retrying inference', async () => {
  let detached = 0, sent = 0;
  const runtime = {subscribe(projectId, runId, instanceId, after, listener) {
    sent++;
    listener({id: 1, type: 'snapshot', projectId, runId, instanceId, revision: 1, run: {status: 'running'}});
    return () => { detached++; };
  }};
  const routeHandler = createChatHttp({runtime}), res = new EventEmitter();
  Object.assign(res, {headersSent: false, writableLength: 300 * 1024, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true; }, flushHeaders() {}, write() { assert.fail('Saturated subscriber must not queue another event'); },
    end() { this.writableEnded = true; }, destroy() { this.destroyed = true; }});
  const id = randomUUID();
  const handled = await routeHandler.handle({method: 'GET', headers: {}}, res, new URL(`http://localhost/api/agent/chat/project/runs/${id}/events?instanceId=${randomUUID()}&after=0`));
  assert.equal(handled, true); assert.equal(detached, 1); assert.equal(sent, 1); assert.equal(res.destroyed, true);
  routeHandler.close(); assert.equal(detached, 1);
});

test('shutdown during pending trusted acquisition is bounded and late credential cannot cause an inference', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-chat-acquire-shutdown-'));
  const engine = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  let release, signal, calls = 0;
  const settings = {get: options => engine.get(options), [AGENT_CREDENTIAL_ACQUIRE](expected, options) {
    signal = options.signal;
    return new Promise(resolve => { release = () => resolve({revision: expected.expectedRevision, configuration: expected.configuration, apiKey: SECRET}); });
  }};
  const server = await startServer({dataDir: root, port: 0, token, agentSettings: settings, chatGateway: async function* () { calls++; yield {type: 'done', finishReason: 'stop'}; }});
  t.after(async () => { await server.close(); await engine.close(); await rm(root, {recursive: true, force: true}); });
  const request = async (route, method = 'GET', body) => (await fetch(server.url + route, {method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})})).json();
  const project = (await request('/api/rpc', 'POST', {operation: 'project.create', input: {name: 'Synthetic pending acquire'}})).data;
  const snap = (await request(route(project.id))).data;
  const sent = (await request(route(project.id) + '/runs', 'POST', {requestId: randomUUID(), instanceId: snap.instanceId,
    expectedSettingsRevision: snap.settings.revision, expectedConversationRevision: snap.revision, message: 'Typed only',
    consent: {destination: deriveAgentEndpoint(snap.settings.configuration), protocol: snap.settings.configuration.protocol, model: snap.settings.configuration.model, context: 'typed_chat_only'}})).data;
  const stream = await fetch(server.url + `${route(project.id)}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`, {headers: {authorization: `Bearer ${token}`}});
  const streamText = stream.text(), started = Date.now(); await server.close();
  assert.ok(Date.now() - started < 2000); assert.equal(signal.aborted, true); assert.match(await streamText, /"status":"interrupted"/);
  release(); await turn(); await turn(); assert.equal(calls, 0);
});

test('actual Responses HTTP sends one fixed-path request, complete bounded context and no CC/stateful/tool fields', async t => {
  const f = await fixture(t, {modelServer: true, protocol: 'responses'}), project = await f.rpc('project.create', {name: 'PRIVATE_RESPONSE_PROJECT'}), base = route(project.id);
  for (let i = 0; i < 2; i++) {
    const input = await f.sendInput(project.id, {message: `Synthetic Responses turn ${i}`});
    const sent = (await f.request(base + '/runs', {method: 'POST', input})).body.data, done = await completed(f, project.id, sent);
    assert.equal(done.run.status, 'completed'); assert.equal(done.run.assistantText, '本地模拟回复');
    assert.equal(done.run.configuration.protocol, 'responses');
    assert.equal((await f.request(base + '/runs', {method: 'POST', input})).body.data.replayed, true);
    await (await f.stream(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`)).text();
  }
  assert.equal(f.calls, 2);
  const capture = f.captures.at(-1);
  assert.equal(capture.path, '/v1/responses'); assert.equal(capture.method, 'POST'); assert.equal(capture.body.stream, true); assert.equal(capture.body.store, false);
  assert.equal(capture.body.max_output_tokens, 2048); assert.deepEqual(capture.body.reasoning, {effort: 'none'});
  assert.deepEqual(capture.body.input.map(item => item.role), ['user', 'assistant', 'user']);
  assert.match(capture.body.instructions, /no access to projects/);
  for (const key of ['messages','tools','previous_response_id','conversation','background','metadata']) assert.equal(capture.body[key], undefined);
  assert.equal(JSON.stringify(capture.body).includes('PRIVATE_RESPONSE_PROJECT'), false);
  assert.equal(capture.headers.authorization, undefined);
});

test('actual Responses incomplete, failed, unknown, tools and EOF stay partial/failed with no CC fallback', async t => {
  for (const responseFault of ['incomplete', 'failure', 'unknown', 'tool', 'truncated']) {
    const f = await fixture(t, {modelServer: true, protocol: 'responses', responseFault}), project = await f.rpc('project.create', {name: 'Responses safe terminal fixture'});
    const sent = (await f.request(route(project.id) + '/runs', {method: 'POST', input: await f.sendInput(project.id)})).body.data;
    const ended = await completed(f, project.id, sent);
    assert.equal(ended.run.status, 'failed', responseFault); assert.equal(ended.run.assistantText, '本地模拟回复', responseFault);
    assert.equal(f.calls, 1); assert.equal(f.captures[0].path, '/v1/responses');
    assert.equal(JSON.stringify(ended).includes('Synthetic provider error'), false);
  }
});

test('actual Responses Stop and service shutdown abort upstream and close SSE without an additional round', async t => {
  const f = await fixture(t, {modelServer: true, hold: true, protocol: 'responses'}), project = await f.rpc('project.create', {name: 'Responses cancellation fixture'}), base = route(project.id);
  const sent = (await f.request(base + '/runs', {method: 'POST', input: await f.sendInput(project.id)})).body.data;
  const stream = await f.stream(`${base}/runs/${sent.run.id}/events?instanceId=${sent.instanceId}&after=0`), reader = stream.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal((await f.request(`${base}/runs/${sent.run.id}?instanceId=${sent.instanceId}`)).body.data.run.status, 'running');
  assert.equal((await f.request(`${base}/runs/${sent.run.id}/stop`, {method: 'POST', input: {instanceId: sent.instanceId}})).body.data.run.status, 'stopped');
  const next = (await f.request(base + '/runs', {method: 'POST', input: await f.sendInput(project.id)})).body.data;
  const active = await f.stream(`${base}/runs/${next.run.id}/events?instanceId=${next.instanceId}&after=0`), text = active.text();
  const started = Date.now(); await f.server.close(); assert.ok(Date.now() - started < 2000); assert.match(await text, /"status":"interrupted"/);
  assert.ok(f.calls <= 2); assert.ok(f.providerAborted >= 1); assert.ok(f.captures.every(call => call.path === '/v1/responses'));
});

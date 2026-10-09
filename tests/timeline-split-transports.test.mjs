import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient} from '../packages/client/src/index.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-split-transports-synthetic-token';
const operation = 'timeline.clip.split', toolName = 'timeline_clip_split';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const editable = timeline => ({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const request = (projectId, timeline, fields = {}) => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});

function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_)/.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAY_MAX_GENERATIONS: '0', ...extra};
}

async function cli(args, env = {}, expectedError) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), ...args], {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timeout); }
  assert.equal(signal, null, stderr);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI returns exactly one JSON envelope');
  const body = JSON.parse(stdout);
  assert.equal(body.ok, !expectedError, stdout + stderr);
  assert.ok(!stdout.includes(token)); assert.ok(!stderr.includes(token));
  if (expectedError) {
    assert.equal(body.error.code, expectedError, stdout);
    assert.equal(code, expectedError === 'VALIDATION_ERROR' ? 2 : expectedError.includes('CONFLICT') ? 3 : 6, stdout);
    assert.ok(stderr.trim()); return body.error;
  }
  assert.equal(code, 0, stdout + stderr); return body.data;
}

async function mcpFixture(t, env = {}) {
  const client = new Client({name: 'timeline-split-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(env), stderr: 'pipe'});
  transport.stderr?.resume();
  t.after(() => client.close()); await client.connect(transport);
  return {client, async call(name, input, expectedError) {
    const response = await client.callTool({name, arguments: input});
    const block = response.content.find(item => item.type === 'text'); assert.ok(block);
    const body = JSON.parse(block.text);
    assert.deepEqual(response.structuredContent, body);
    assert.equal(Boolean(response.isError), Boolean(expectedError), block.text);
    assert.equal(body.ok, !expectedError, block.text);
    if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; }
    return body.data;
  }};
}

test('split CLI and official MCP expose one strict offline schema and reject malformed requests without a backend', {timeout: 60000}, async t => {
  const mcp = await mcpFixture(t), definition = await cli(['schema', operation]);
  const tool = (await mcp.client.listTools()).tools.find(item => item.name === toolName);
  assert.ok(tool); assert.equal(definition.operation, operation); assert.equal(definition.toolName, toolName);
  assert.equal(definition.command, 'timeline clip split'); assert.equal(definition.requiresRequestId, true);
  assert.deepEqual(tool.inputSchema, definition.inputSchema);
  assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual([...tool.inputSchema.required].sort(), ['atFrame', 'clipId', 'expectedRevision', 'projectId', 'requestId']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [...tool.inputSchema.required].sort());
  assert.equal(tool.inputSchema.properties.atFrame.type, 'integer');
  assert.equal(tool.inputSchema.properties.atFrame.minimum, 0); assert.equal(tool.inputSchema.properties.atFrame.maximum, 18000);
  const clipSchema = tool.inputSchema.properties.clipId.$ref
    ? tool.inputSchema.properties.clipId.$ref.slice(2).split('/').reduce((value, key) => value[key], tool.inputSchema)
    : tool.inputSchema.properties.clipId;
  assert.equal(clipSchema.type, 'string'); assert.equal(clipSchema.format, 'uuid');
  assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.idempotentHint, true); assert.equal(tool.annotations.openWorldHint, false);
  const valid = {projectId: randomUUID(), clipId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), atFrame: 12};
  const invalid = [
    ...Object.keys(valid).map(field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field))),
    ...[-1, 18001, 1.5, '12'].map(atFrame => ({...valid, atFrame})),
    {...valid, rightClipId: randomUUID()}, {...valid, expectedRevision: 0}, {...valid, clipId: 'wrong'}, {...valid, requestId: 'short'},
  ];
  for (const input of invalid) {
    const fromCli = await cli(['timeline', 'clip', 'split', '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
    assert.deepEqual(await mcp.call(toolName, input, 'VALIDATION_ERROR'), fromCli);
  }
  await cli(['timeline', 'clip', 'split', '--input', JSON.stringify(valid), '--request-id', 'different-request'], {}, 'VALIDATION_ERROR');
});

async function backendFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-split-transports-'));
  // Only seed synthetic metadata before startup. All timeline writes use real transports.
  const store = openStore(root), services = createServices(store, new Map());
  const projectId = (await services.call('project.create', {name: 'Split transport parity'})).id, assetId = randomUUID();
  store.put('assets', {id: assetId, projectId, name: 'Synthetic video', mimeType: 'video/mp4', duration: 8, width: 720, height: 1280, sha256: 'a'.repeat(64), relativePath: `media/${assetId}.fixture`});
  store.close();
  let backend, url, port = 0;
  async function stop() {
    if (!backend || backend.exitCode !== null || backend.signalCode) return;
    const child = backend, ended = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  t.after(async () => { await stop(); await rm(root, {recursive: true, force: true}); });
  async function start() {
    let stdout = '', stderr = '', spawnError;
    backend = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.mjs')], {cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_TOKEN: token}), stdio: ['ignore', 'pipe', 'pipe']});
    backend.once('error', error => spawnError = error);
    backend.stdout.on('data', bytes => stdout += bytes); backend.stderr.on('data', bytes => stderr += bytes);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(backend.exitCode, null, stderr); assert.equal(backend.signalCode, null, stderr);
      const ready = /Mioon ready at (http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
      if (ready) { url = ready[1]; port = Number(ready[2]); assert.equal((await fetch(url + '/health')).status, 200); return; }
      await pause(25);
    }
    throw Error(`Backend did not start: ${stdout}\n${stderr}`);
  }
  await start();
  return {root, url, projectId, assetId, get pid() { return backend.pid; }, restart: async () => { await stop(); await start(); },
    async http(name, input, expectedError) {
      const response = await fetch(url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: name, input})});
      const body = await response.json();
      const status = !expectedError ? 200 : expectedError.includes('CONFLICT') ? 409 : expectedError === 'CLIP_NOT_FOUND' || expectedError === 'NOT_FOUND' ? 404 : 400;
      assert.equal(response.status, status, JSON.stringify(body)); assert.equal(body.ok, !expectedError, JSON.stringify(body));
      if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; } return body.data;
    },
    storage() {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
      finally { db.close(); }
    },
  };
}

test('split HTTP, CLI, MCP and shared client agree on durable results, errors, uncertain-response recovery and restart', {timeout: 90000}, async t => {
  const backend = await backendFixture(t), {projectId, assetId} = backend;
  const env = {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token}, mcp = await mcpFixture(t, env);
  const command = (name, input, error, flags = []) => cli([...name.split('.'), '--input', JSON.stringify(input), ...flags], env, error);
  const transports = [
    {name: 'HTTP', call: backend.http},
    {name: 'CLI', call: command},
    {name: 'MCP', call: (name, input, error) => mcp.call(name.replaceAll('.', '_'), input, error)},
  ];
  let timeline = await backend.http('timeline.get', {projectId});
  timeline = await backend.http('timeline.clip.add', request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId, startFrame: 20, sourceInFrame: 17, durationFrames: 80, gain: 0.5, rect: {x: 100, y: 200, width: 400, height: 600}, name: 'Trimmed transport clip'}));
  const initial = timeline, clipId = timeline.clips[0].id, saved = [];
  const firstInput = request(projectId, timeline, {clipId, atFrame: 50});
  const concurrent = await Promise.all(transports.map(({call}) => call(operation, firstInput)));
  concurrent.forEach(result => assert.deepEqual(result, concurrent[0]));
  timeline = concurrent[0]; saved.push({input: firstInput, response: timeline});
  assert.equal(timeline.revision, initial.revision + 1); assert.equal(timeline.clips.length, 2); assert.equal(timeline.durationFrames, initial.durationFrames);
  const firstRight = timeline.clips.find(clip => clip.id !== clipId);
  assert.equal(timeline.clips.find(clip => clip.id === clipId).durationFrames, 30);
  assert.equal(firstRight.startFrame, 50); assert.equal(firstRight.sourceInFrame, 47); assert.equal(firstRight.durationFrames, 50);
  const undo = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(undo), editable(initial));
  timeline = await mcp.call('timeline_redo', request(projectId, undo));
  assert.deepEqual(editable(timeline), editable(saved[0].response));

  const secondInput = request(projectId, timeline, {clipId: firstRight.id, atFrame: 80});
  const {requestId, ...withoutRequestId} = secondInput;
  timeline = await command(operation, withoutRequestId, undefined, ['--request-id', requestId]);
  saved.push({input: secondInput, response: timeline});
  const secondRight = timeline.clips.find(clip => !saved[0].response.clips.some(previous => previous.id === clip.id));
  const thirdInput = request(projectId, timeline, {clipId: secondRight.id, atFrame: 90});
  timeline = await mcp.call(toolName, thirdInput); saved.push({input: thirdInput, response: timeline});
  assert.equal(timeline.clips.length, 4);
  assert.equal((await backend.http('timeline.history.get', {projectId})).length, 4, 'one add and three splits produce four history entries');

  const cases = [
    [request(projectId, timeline, {clipId, atFrame: 20}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId, atFrame: 50}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId, atFrame: 19}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId: randomUUID(), atFrame: 30}), 'CLIP_NOT_FOUND'],
    [request(projectId, timeline, {clipId, atFrame: 30.5}), 'VALIDATION_ERROR'],
    [request(projectId, timeline, {clipId, atFrame: 30, extra: true}), 'VALIDATION_ERROR'],
    [{...firstInput, atFrame: 51}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, requestId: randomUUID()}, 'REVISION_CONFLICT'],
  ];
  const beforeErrors = backend.storage();
  for (const [input, code] of cases) {
    const errors = [];
    for (const {call} of transports) errors.push(await call(operation, input, code));
    errors.forEach(error => assert.deepEqual(error, errors[0], `${code} must have the same structured error on every transport`));
    if (code === 'REVISION_CONFLICT') assert.deepEqual(errors[0].details.current, timeline);
  }
  assert.deepEqual(backend.storage(), beforeErrors);

  let dropResponse = true, sent = 0, committed;
  const client = createClient({env, fetchImpl: async (...args) => {
    sent++; const response = await fetch(...args);
    if (dropResponse) { dropResponse = false; committed = (await response.json()).data; throw Error('Synthetic response lost after commit'); }
    return response;
  }});
  const uncertainInput = request(projectId, timeline, {clipId, atFrame: 35});
  await assert.rejects(client.rpc(operation, uncertainInput), error => error.code === 'BACKEND_UNAVAILABLE' && error.details.requestId === uncertainInput.requestId && error.details.submissionMayHaveSucceeded === true);
  assert.equal(sent, 1, 'shared client never automatically reissues an uncertain mutation');
  timeline = await backend.http('timeline.get', {projectId});
  assert.deepEqual(timeline, committed); assert.equal(timeline.revision, uncertainInput.expectedRevision + 1);
  assert.deepEqual(await client.rpc(operation, uncertainInput), committed);
  assert.equal(sent, 2); saved.push({input: uncertainInput, response: committed});
  const persisted = backend.storage(), pid = backend.pid;
  await backend.restart(); assert.notEqual(backend.pid, pid);
  for (const {name, call} of transports) {
    assert.deepEqual(await call('timeline.get', {projectId}), timeline, `${name} sees the same restarted timeline`);
    for (const record of saved) assert.deepEqual(await call(operation, record.input), record.response, `${name} replays old split responses exactly`);
    assert.deepEqual((await call('project.get', {projectId})).timeline, timeline);
  }
  assert.deepEqual(backend.storage(), persisted, 'replay after process restart cannot change timeline, journal, cursor or saved response bytes');
  assert.equal(persisted.timeline_requests.filter(row => row.requestId === firstInput.requestId).length, 1);
});

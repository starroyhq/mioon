import type {FixtureHistory, FixtureTimeline, FixtureHistoryEntry} from './helpers/strict-timeline-core-types.ts';
import type {TransportCall,EnvelopeTransportCall} from './helpers/strict-timeline-transport-types.ts';
import type {WireResult} from './helpers/strict-timeline-transport-types.ts';
import type {ServiceResponse} from './helpers/strict-service-responses.ts';

import type {CliResult,McpData,TestTool,SchemaNode} from './helpers/strict-timeline-transport-types.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertClientRecoveryError} from './recovery-transport-assertions.mjs';
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
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-history-transports-synthetic-token';
const operations = (['timeline.history.get', 'timeline.undo', 'timeline.redo'] as const);
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const toolName = (operation: string) => operation.replaceAll('.', '_');

function environment(extra: NodeJS.ProcessEnv = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|MIOON_)/.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

async function cli<const A extends readonly string[],E extends string|undefined=undefined>(args: A, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}, expectedError?: E):Promise<WireResult<CliResult<A>,E>> {
  const child = spawn(process.execPath, (([path.join(repo, 'apps/cli/src/index.ts'), ...args]) as unknown as Parameters<typeof spawn>[1]), {
    cwd: repo, env: environment(((env) as unknown as Parameters<typeof environment>[0])), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8').on('data', (bytes: string) => stdout += bytes);
  child.stderr.setEncoding('utf8').on('data', (bytes: string) => stderr += bytes);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); }
  finally { clearTimeout(timeout); }
  assert.equal((signal as unknown), null, `CLI did not finish: ${args.join(' ')}; ${stderr}`);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI stdout is exactly one JSON envelope');
  const body = JSON.parse(stdout);
  assert.equal(body.ok, !expectedError, stdout + stderr);
  assert.ok(!stdout.includes(token));
  assert.ok(!stderr.includes(token));
  if (expectedError) {
    assert.equal(body.error.code, expectedError, stdout);
    assert.equal(code, expectedError === 'VALIDATION_ERROR' ? 2 : expectedError === 'NOT_FOUND' || expectedError === 'TRACK_NOT_FOUND' ? 6 : 3, stdout);
    assert.ok(stderr.trim(), 'failed CLI command explains its error on stderr');
    return body.error;
  }
  assert.equal(code, 0, stdout + stderr);
  return body.data;
}

async function connectMcp(t: test.TestContext, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}) {
  const client = new Client({name: 'timeline-history-transport-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')],
    cwd: repo, env: environment(((env) as unknown as Parameters<typeof environment>[0])), stderr: 'pipe',
  });
  (transport.stderr as import('node:stream').Readable|null)?.resume();
  t.after(() => client.close());
  await client.connect(transport);
  async function call<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(name?: N, input: I = {} as I, expectedError?: E):Promise<WireResult<McpData<N,I>,E>> {
    const result = (await client.callTool((({name, arguments: input}) as unknown as Parameters<typeof client.callTool>[0])) as CallToolResult);
    const block = result.content.find((item) => item.type === 'text');
    assert.ok(block, `${name} returns a text envelope over official MCP stdio`);
    const body = JSON.parse(block.text);
    assert.deepEqual(result.structuredContent, body, 'MCP structured and text results agree');
    assert.equal(Boolean(result.isError), Boolean(expectedError), block.text);
    assert.equal(body.ok, !expectedError, block.text);
    if (expectedError) {
      assert.equal(body.error.code, expectedError, block.text);
      return body.error;
    }
    return body.data;
  }
  return {client, call};
}

function invalidInputs(operation: string, projectId: string = randomUUID()) {
  if (operation === 'timeline.history.get') return [{}, {projectId: 'not-a-uuid'}, {projectId, unexpected: true}];
  const valid = {projectId, expectedRevision: 1, requestId: randomUUID()};
  return [
    ...Object.keys(valid).map(key => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))),
    {...valid, unexpected: true},
    {...valid, projectId: 'not-a-uuid'},
    ...[0, -1, 1.25, '1'].map(expectedRevision => ({...valid, expectedRevision})),
    ...['', 'short', 'x'.repeat(201), 12345678].map(requestId => ({...valid, requestId})),
  ];
}

test('timeline history CLI and official MCP advertise identical strict schemas and require caller-owned request IDs offline', {timeout: 60_000}, async t => {
  const mcp = await connectMcp(t);
  const catalog = await cli(['schema']);
  assert.deepEqual(await mcp.call('mioon_schema'), catalog);
  const tools = ((await mcp.client.listTools() as {tools:TestTool[]})).tools;
  for (const operation of operations) {
    const definition = await cli(['schema', operation]);
    const tool = tools.find(item => item.name === toolName(operation));
    const mutation = operation !== 'timeline.history.get';
    assert.ok(tool, `${operation} is discoverable through tools/list`);
    assert.deepEqual(definition, catalog.operations.find((item) => item.operation === operation));
    assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
    assert.equal(definition.operation, operation);
    assert.equal(definition.command, operation.replaceAll('.', ' '));
    assert.equal(definition.toolName, tool.name);
    assert.equal(definition.requiresRequestId, mutation);
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual([...tool.inputSchema.required].sort(), mutation ? ['expectedRevision', 'projectId', 'requestId'] : ['projectId']);
    assert.deepEqual(Object.keys(((tool.inputSchema.properties) as unknown as Parameters<typeof Object.keys>[0])).sort(), [...tool.inputSchema.required].sort());
    assert.equal((tool.inputSchema.properties)!.projectId.format, 'uuid');
    assert.equal((tool.annotations)!.readOnlyHint, !mutation);
    assert.equal((tool.annotations)!.idempotentHint, true);
    assert.equal((tool.annotations)!.openWorldHint, false);
    if (mutation) {
      assert.equal((tool.inputSchema.properties)!.expectedRevision.type, 'integer');
      assert.equal((tool.inputSchema.properties)!.requestId.type, 'string');
      assert.equal((tool.inputSchema.properties)!.requestId.minLength, 8);
      assert.equal((tool.inputSchema.properties)!.requestId.maxLength, 200);
    }
    for (const input of invalidInputs(operation)) {
      const fromCli = await cli([...operation.split('.'), '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
      const fromMcp:import('./helpers/strict-timeline-audio-types.ts').Failure = await mcp.call(tool.name, input, 'VALIDATION_ERROR');
      assert.deepEqual(fromMcp, fromCli, `${operation} validates identically without any configured backend`);
    }
    if (mutation) {
      await cli([...operation.split('.'), '--input', JSON.stringify({projectId: randomUUID(), expectedRevision: 1, requestId: 'original-request'}), '--request-id', 'different-request'], {}, 'VALIDATION_ERROR');
    }
  }
});

async function backendFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-timeline-history-transports-'));
  let backend!: ChildProcessByStdio<null,Readable,Readable>, url!: string, port = 0;
  async function stop() {
    if (!backend || backend.exitCode !== null || backend.signalCode) return;
    const child = backend, end = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { await end; }
    finally { clearTimeout(timeout); }
  }
  t.after(async () => { await stop(); await rm(root, {recursive: true, force: true}); });
  async function start() {
    let stdout = '', stderr = '';
    backend = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.ts')], {
      cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_TOKEN: token}), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    backend.once('error', error => spawnError = error);
    backend.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes);
    backend.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal((backend.exitCode as unknown), null, stderr);
      assert.equal((backend.signalCode as unknown), null, stderr);
      const ready = /Mioon ready at (http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
      if (ready) {
        url = ready[1]; port = Number(ready[2]);
        assert.equal((await fetch(url + '/health')).status, 200);
        return backend.pid;
      }
      await pause(25);
    }
    throw Error(`Backend did not start: ${stdout}\n${stderr}`);
  }
  await start();
  async function http<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(operation?: N, input: I = {} as I, expectedError?: E, expectedStatus: unknown = 409):Promise<WireResult<ServiceResponse<N>,E>> {
    const response = await fetch(url + '/api/rpc', {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify({operation, input}),
    });
    const body = await response.json();
    assert.equal(response.status, expectedError ? expectedStatus : 200, JSON.stringify(body));
    assert.equal(body.ok, !expectedError, JSON.stringify(body));
    if (expectedError) {
      assert.equal(body.error.code, expectedError, JSON.stringify(body));
      return body.error;
    }
    return body.data;
  }
  function storage() {
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
    try {
      return Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row}))]));
    } finally { db.close(); }
  }
  return {http, storage, root, url, get pid() { return backend.pid; }, restart: async () => { await stop(); return start(); }};
}

function assertHistory(history:FixtureHistory,timeline:FixtureTimeline,cursor:number,length:number) {
  assert.deepEqual(Object.keys(history).sort(), ['projectId', 'timelineId', 'revision', 'cursor', 'length', 'canUndo', 'canRedo', 'undoEntry', 'redoEntry'].sort());
  assert.equal(history.projectId, timeline.projectId);
  assert.equal(history.timelineId, timeline.id);
  assert.equal(history.revision, timeline.revision);
  assert.equal(history.cursor, cursor);
  assert.equal(history.length, length);
  assert.equal(history.canUndo, cursor > 0);
  assert.equal(history.canRedo, cursor < length);
  for (const [name, present] of ([['undoEntry', cursor > 0], ['redoEntry', cursor < length]] as const)) {
    if (!present) { assert.equal((history[name] as unknown), null); continue; }
    assert.deepEqual(Object.keys(((history[name]) as unknown as Parameters<NonNullable<(typeof Object)["keys"]>>[0])).sort(), ['createdAt', 'id', 'operation']);
    assert.match((history[name])!.id, /^[0-9a-f-]{36}$/i);
    assert.ok(Number.isFinite(Date.parse((history[name])!.createdAt)));
  }
}

function editable(timeline?: { tracks: unknown; clips: unknown; durationFrames: unknown; }|undefined) {
  return {tracks: (timeline)!.tracks, clips: (timeline)!.clips, durationFrames: (timeline)!.durationFrames};
}

// Real child processes and loopback transports share a disposable SQLite store.
// This test never imports media, submits generation, or touches existing data.
test('timeline edit history round-trips HTTP, CLI and official MCP with durable replay, conflicts, branching and process restart', {timeout: 90_000}, async t => {
  const backend = await backendFixture(t);
  const env = {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token};
  const mcp = await connectMcp(t, env);
  const command = <O extends string,E extends string|undefined=undefined>(operation:O, input?:unknown, error?:E, flags: string[] = []) => (cli((([...operation.split('.'), '--input', JSON.stringify(input), ...flags]) as unknown as Parameters<NonNullable<typeof cli>>[0]), env, ((error) as unknown as Parameters<NonNullable<typeof cli>>[2])) as Promise<WireResult<ServiceResponse<O>,E>>);
  const transports = [
    {name: 'HTTP', call: (backend.http as TransportCall)},
    {name: 'CLI', call: (command as TransportCall)},
    {name: 'MCP', call: ((((operation?: unknown, input?: {}|undefined, error?: unknown) => (mcp.call(toolName(((operation) as unknown as Parameters<typeof toolName>[0])), input, ((error) as unknown as Parameters<NonNullable<(typeof mcp)["call"]>>[2])))) as TransportCall))},
  ];
  const {id: projectId} = await backend.http('project.create', {name: 'Durable history across three transports'});
  const query = {projectId};
  let current!:FixtureTimeline;
  const successful: ({ operation: string; input: { expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; kind?: string; name?: string; projectId: unknown; trackId?: unknown; patch?: { name: string; hidden: boolean; }; }; response: unknown; })[] = [];
  function remember<T>(operation: string, input: { expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; kind?: string; name?: string; projectId: unknown; trackId?: unknown; patch?: { name: string; hidden: boolean; }; }, response:T) {
    successful.push({operation, input, response});
    return response;
  }
  async function consistent(cursor: number, length: number) {
    const history = await backend.http('timeline.history.get', query);
    assertHistory(((history) as unknown as Parameters<NonNullable<typeof assertHistory>>[0]), ((current) as unknown as Parameters<typeof assertHistory>[1]), cursor, length);
    for (const {name, call} of transports.slice(1)) {
      assert.deepEqual(await call('timeline.history.get', ((query) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), history, `${name} sees exact history metadata`);
      const project = await call('project.get', ((query) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>));
      assert.deepEqual(project.timeline, current, `${name} project.get sees current timeline`);
      assert.deepEqual(project.timelineHistory, history, `${name} project.get includes coherent history`);
    }
    const project = await backend.http('project.get', query);
    assert.deepEqual(project.timeline, current);
    assert.deepEqual(project.timelineHistory, history);
    return history;
  }

  await t.test('history reads and empty undo/redo do not create a timeline or journal', async () => {
    const before = backend.storage();
    const empty = {projectId, timelineId: null, revision: null, cursor: 0, length: 0, canUndo: false, canRedo: false, undoEntry: null, redoEntry: null};
    for (const {call} of transports) {
      assert.deepEqual(await call('timeline.history.get', ((query) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), empty);
      for (const action of (['undo', 'redo'] as const)) {
        await call(`timeline.${action}`, {...query, expectedRevision: 1, requestId: randomUUID()}, `NOTHING_TO_${action.toUpperCase()}`);
      }
    }
    assert.deepEqual(backend.storage(), before, 'read-only history and failed empty traversal have zero persisted side effects');
    for (const operation of operations) {
      for (const input of invalidInputs(operation, ((projectId) as unknown as Parameters<NonNullable<typeof invalidInputs>>[1]))) await backend.http(operation, input, 'VALIDATION_ERROR', 400);
    }
    assert.deepEqual(backend.storage(), before, 'strict HTTP validation also leaves every history table untouched');
    current = await backend.http('timeline.get', query);
    assert.equal(current.revision, 1);
    await consistent(0, 0);
  });

  const baseline = current;
  let added!:FixtureTimeline, undone!:FixtureTimeline, redone!:FixtureTimeline, firstEntry!:FixtureHistoryEntry, editInput, undoInput!: { expectedRevision: unknown; requestId: unknown; projectId?: unknown; }, redoInput!: {}|undefined;
  await t.test('HTTP edit, CLI undo with explicit request-id flag, and official MCP redo preserve stable track IDs', async () => {
    editInput = {...query, expectedRevision: current.revision, requestId: randomUUID(), kind: 'video', name: 'HTTP-added overlay'};
    added = (current = remember('timeline.track.add', editInput, await backend.http('timeline.track.add', editInput)) as unknown as typeof added);
    assert.equal(current.revision, baseline.revision + 1);
    assert.equal(current.tracks.length, baseline.tracks.length + 1);
    firstEntry = ((await consistent(1, 1)).undoEntry as unknown as typeof firstEntry);
    assert.equal(firstEntry.operation, 'timeline.track.add');
    undoInput = {...query, expectedRevision: current.revision, requestId: randomUUID()};
    undone = current = (remember('timeline.undo', ((undoInput) as unknown as Parameters<typeof remember>[1]), await command('timeline.undo', {projectId, expectedRevision: undoInput.expectedRevision}, undefined, ['--request-id', undoInput.requestId as string])) as unknown as typeof current);
    assert.equal(current.revision, added.revision + 1);
    assert.equal(current.id, baseline.id);
    assert.equal(current.createdAt, baseline.createdAt);
    assert.deepEqual(editable(((current) as unknown as Parameters<typeof editable>[0])), editable(((baseline) as unknown as Parameters<typeof editable>[0])));
    assert.deepEqual((await consistent(0, 1)).redoEntry, firstEntry);
    redoInput = {...query, expectedRevision: current.revision, requestId: randomUUID()};
    redone = current = (remember('timeline.redo', ((redoInput) as unknown as Parameters<typeof remember>[1]), await mcp.call('timeline_redo', redoInput)) as unknown as typeof current);
    assert.equal(current.revision, undone.revision + 1);
    assert.deepEqual(editable(((current) as unknown as Parameters<typeof editable>[0])), editable(((added) as unknown as Parameters<typeof editable>[0])), 'redo restores the original track ID and order');
    assert.deepEqual((await consistent(1, 1)).undoEntry, firstEntry);
  });

  await t.test('exact successful replay wins over stale revisions and changed request data conflicts on every transport', async () => {
    const before = backend.storage();
    const expectedErrors = new Map();
    const rejectedInputs = new Map(['undo', 'redo'].map(action => [`timeline.${action}:REVISION_CONFLICT`, {...query, expectedRevision: 1, requestId: randomUUID()}]));
    rejectedInputs.set('timeline.redo:NOTHING_TO_REDO', {...query, expectedRevision: ((current.revision) as unknown as number), requestId: randomUUID()});
    async function identicalError(call: ((operation?: unknown,input?: {}|undefined,expectedError?: unknown,expectedStatus?: number) => Promise<unknown>)|((operation?: unknown,input?: unknown,error?: unknown,flags?: never[]) => Promise<unknown>), operation: string, input: { expectedRevision: number; requestId: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; }|undefined, code: string) {
      const error = await call(operation, input, code);
      const key = `${operation}:${code}`;
      if (expectedErrors.has(key)) assertClientRecoveryError(error, expectedErrors.get(key), {operation, input});
      else expectedErrors.set(key, error);
      if (code === 'REVISION_CONFLICT') {
        assert.equal(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.expectedRevision, (input)!.expectedRevision);
        assert.equal(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.currentRevision, current.revision);
        assert.deepEqual(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.current, current);
      }
    }
    for (const {name, call} of transports) {
      for (const saved of successful) assert.deepEqual(await call(saved.operation, saved.input), saved.response, `${name} replays the original ${saved.operation} response`);
      await call('timeline.undo', (({...undoInput, expectedRevision: current.revision}) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), 'IDEMPOTENCY_CONFLICT');
      await call('timeline.redo', (({...redoInput, expectedRevision: current.revision}) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), 'IDEMPOTENCY_CONFLICT');
      await call('timeline.redo', ((undoInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), 'IDEMPOTENCY_CONFLICT');
      for (const action of (['undo', 'redo'] as const)) {
        await identicalError(((call) as unknown as Parameters<typeof identicalError>[0]), `timeline.${action}`, rejectedInputs.get(`timeline.${action}:REVISION_CONFLICT`), 'REVISION_CONFLICT');
      }
      await identicalError(((call) as unknown as Parameters<typeof identicalError>[0]), 'timeline.redo', rejectedInputs.get('timeline.redo:NOTHING_TO_REDO'), 'NOTHING_TO_REDO');
    }
    assert.deepEqual(backend.storage(), before, 'replays and conflicts cannot modify cursor, journal, aggregate, or saved responses');
    await consistent(1, 1);
  });

  await t.test('simultaneous identical undo/redo requests across transports advance revision and cursor once', async () => {
    for (const [action, expectedCursor, snapshot] of ([['undo', 0, baseline], ['redo', 1, added]] as const)) {
      const input = {...query, expectedRevision: current.revision, requestId: randomUUID()};
      const results = await Promise.all(transports.map(({call}) => call(`timeline.${action}`, input)));
      for (const result of results) assert.deepEqual(result, results[0]);
      assert.equal(results[0].revision, current.revision + 1);
      assert.deepEqual(editable(((results[0]) as unknown as Parameters<NonNullable<typeof editable>>[0])), editable(((snapshot) as unknown as Parameters<typeof editable>[0])));
      current = (remember(`timeline.${action}`, input, results[0]) as unknown as typeof current);
      await consistent(((expectedCursor) as unknown as Parameters<typeof consistent>[0]), 1);
      const rows = backend.storage();
      assert.equal(rows.timeline_history.length, 1, 'undo/redo are cursor movement, not additional journal edits');
      assert.equal(rows.timeline_requests.filter(row => row.requestId === input.requestId).length, 1);
    }
  });

  await t.test('actual backend process restart preserves cursor and exact saved responses through existing clients', async () => {
    // Restart with an active redo branch, rather than only testing the head.
    const input = {...query, expectedRevision: current.revision, requestId: randomUUID()};
    current = (remember('timeline.undo', input, await command('timeline.undo', input)) as unknown as typeof current);
    const before = await consistent(0, 1), project = await backend.http('project.get', query), persisted = backend.storage();
    const previousPid = backend.pid;
    assert.notEqual(await backend.restart(), previousPid, 'restart launches a distinct HTTP backend process');
    assert.deepEqual(await backend.http('project.get', query), project);
    assert.deepEqual(await consistent(0, 1), before);
    for (const {name, call} of transports) {
      for (const saved of successful) assert.deepEqual(await call(saved.operation, saved.input), saved.response, `${name} saved ${saved.operation} result survives process restart`);
    }
    assert.deepEqual(backend.storage(), persisted, 'old successful replays must not move the restored cursor');
  });

  await t.test('rejected edits preserve redo while new edits replace the branch without invalidating old replay', async () => {
    const before = backend.storage();
    await mcp.call('timeline_track_update', {...query, expectedRevision: current.revision, requestId: randomUUID(), trackId: randomUUID(), patch: {name: 'Rejected branch'}}, 'TRACK_NOT_FOUND');
    assert.deepEqual(backend.storage(), before);
    assert.deepEqual((await consistent(0, 1)).redoEntry, firstEntry);
    const input = {...query, expectedRevision: current.revision, requestId: randomUUID(), trackId: current.tracks[0].id, patch: {name: 'Replacement branch', hidden: true}};
    current = (remember('timeline.track.update', input, await command('timeline.track.update', input)) as unknown as typeof current);
    assert.equal(current.revision, JSON.parse(((before.timelines[0].data) as unknown as Parameters<typeof JSON.parse>[0])).revision + 1);
    const history = await consistent(1, 1);
    assert.equal((history.undoEntry)!.operation, 'timeline.track.update');
    assert.notEqual((history.undoEntry)!.id, firstEntry.id);
    const branched = backend.storage();
    for (const {call} of transports) {
      await call('timeline.redo', {...query, expectedRevision: current.revision, requestId: randomUUID()}, 'NOTHING_TO_REDO');
      assert.deepEqual(await call('timeline.redo', ((redoInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), redone, 'replay remains exact even after its history branch was replaced');
    }
    assert.deepEqual(backend.storage(), branched, 'replaying abandoned redo cannot resurrect the abandoned branch');
    const project = await backend.http('project.get', query);
    for (const table of (['assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports'] as const)) assert.deepEqual((project[table] as unknown), []);
    for (const secret of ([backend.root, token, 'requestHash', 'beforeSnapshot', 'afterSnapshot'] as const)) assert.ok(!JSON.stringify(project).includes(secret));
  });
});

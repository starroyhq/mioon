import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {TransportCall,EnvelopeTransportCall} from './helpers/strict-timeline-transport-types.ts';
import type {WireResult} from './helpers/strict-timeline-transport-types.ts';
import type {ServiceResponse} from './helpers/strict-service-responses.ts';
import type {CliResult,McpData,TestTool,SchemaNode} from './helpers/strict-timeline-transport-types.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import type {TypedStore as FixtureStore, TypedServices as FixtureServices, TypedClient as FixtureClient} from './helpers/strict-service-responses.ts';
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
import {createClient} from '../packages/client/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-split-transports-synthetic-token';
const operation = 'timeline.clip.split', toolName = 'timeline_clip_split';
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const editable = (timeline: FixtureTimeline) => ({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const request = <P extends Record<string,unknown>=Record<never,never>>(projectId: string, timeline: { revision: number; }, fields: P = {} as P):P & {projectId:string;expectedRevision:number;requestId:string} => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});

function environment(extra: NodeJS.ProcessEnv = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_)/.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

async function cli<const A extends readonly string[],E extends string|undefined=undefined>(args: A, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}, expectedError?: E):Promise<WireResult<CliResult<A>,E>> {
  const child = spawn(process.execPath, (([path.join(repo, 'apps/cli/src/index.ts'), ...args]) as unknown as Parameters<typeof spawn>[1]), {cwd: repo, env: environment(((env) as unknown as Parameters<typeof environment>[0])), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (bytes: string) => stdout += bytes); child.stderr.setEncoding('utf8').on('data', (bytes: string) => stderr += bytes);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timeout); }
  assert.equal((signal as unknown), null, stderr);
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

async function mcpFixture(t: test.TestContext, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}) {
  const client = new Client({name: 'timeline-split-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(((env) as unknown as Parameters<typeof environment>[0])), stderr: 'pipe'});
  (transport.stderr as import('node:stream').Readable|null)?.resume();
  t.after(() => client.close()); await client.connect(transport);
  return {client, async call<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(name: N, input: I, expectedError?: E):Promise<WireResult<McpData<N,I>,E>> {
    const response = (await client.callTool({name, arguments: input}) as CallToolResult);
    const block = response.content.find((item) => item.type === 'text'); assert.ok(block);
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
  const tool = ((await mcp.client.listTools() as {tools:TestTool[]})).tools.find(item => item.name === toolName);
  assert.ok(tool); assert.equal(definition.operation, operation); assert.equal(definition.toolName, toolName);
  assert.equal(definition.command, 'timeline clip split'); assert.equal(definition.requiresRequestId, true);
  assert.deepEqual(tool.inputSchema, definition.inputSchema);
  assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual([...tool.inputSchema.required].sort(), ['atFrame', 'clipId', 'expectedRevision', 'projectId', 'requestId']);
  assert.deepEqual(Object.keys(((tool.inputSchema.properties) as unknown as Parameters<typeof Object.keys>[0])).sort(), [...tool.inputSchema.required].sort());
  assert.equal((tool.inputSchema.properties)!.atFrame.type, 'integer');
  assert.equal((tool.inputSchema.properties)!.atFrame.minimum, 0); assert.equal((tool.inputSchema.properties)!.atFrame.maximum, 18000);
  const clipSchema = tool.inputSchema.properties.clipId.$ref
    ? tool.inputSchema.properties.clipId.$ref!.slice(2).split('/').reduce<SchemaNode>((value,key)=>value[key] as SchemaNode,tool.inputSchema)
    : tool.inputSchema.properties.clipId;
  assert.equal(clipSchema.type, 'string'); assert.equal(clipSchema.format, 'uuid');
  assert.equal((tool.annotations)!.readOnlyHint, false); assert.equal((tool.annotations)!.idempotentHint, true); assert.equal((tool.annotations)!.openWorldHint, false);
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

async function backendFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-split-transports-'));
  // Only seed synthetic metadata before startup. All timeline writes use real transports.
  const store = (openStore(root) as FixtureStore), services = (createServices(store, new Map()) as FixtureServices);
  const projectId = (await services.call('project.create', {name: 'Split transport parity'})).id, assetId = randomUUID();
  store.put('assets', {id: assetId, projectId, name: 'Synthetic video', mimeType: 'video/mp4', duration: 8, width: 720, height: 1280, sha256: 'a'.repeat(64), relativePath: `media/${assetId}.fixture`});
  store.close();
  let backend!: ChildProcessByStdio<null,Readable,Readable>, url!: string, port = 0;
  async function stop() {
    if (!backend || backend.exitCode !== null || backend.signalCode) return;
    const child = backend, ended = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  t.after(async () => { await stop(); await rm(root, {recursive: true, force: true}); });
  async function start() {
    let stdout = '', stderr = '', spawnError;
    backend = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.ts')], {cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_TOKEN: token}), stdio: ['ignore', 'pipe', 'pipe']});
    backend.once('error', error => spawnError = error);
    backend.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes); backend.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal((backend.exitCode as unknown), null, stderr); assert.equal((backend.signalCode as unknown), null, stderr);
      const ready = /Mioon ready at (http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
      if (ready) { url = ready[1]; port = Number(ready[2]); assert.equal((await fetch(url + '/health')).status, 200); return; }
      await pause(25);
    }
    throw Error(`Backend did not start: ${stdout}\n${stderr}`);
  }
  await start();
  return {root, url, projectId, assetId, get pid() { return backend.pid; }, restart: async () => { await stop(); await start(); },
    async http(name: string, input: { projectId: unknown; expectedRevision?: unknown; requestId?: `${string}-${string}-${string}-${string}-${string}`; }, expectedError?: string|string[]|undefined) {
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
  const command = <O extends string,E extends string|undefined=undefined>(name:O, input?:unknown, error?:E, flags: string[] = []) => (cli((([...name.split('.'), '--input', JSON.stringify(input), ...flags]) as unknown as Parameters<NonNullable<typeof cli>>[0]), env, ((error) as unknown as Parameters<NonNullable<typeof cli>>[2])) as Promise<WireResult<ServiceResponse<O>,E>>);
  const transports = [
    {name: 'HTTP', call: (backend.http as TransportCall)},
    {name: 'CLI', call: (command as TransportCall)},
    {name: 'MCP', call: ((((name: string, input?: unknown, error?: unknown) => (mcp.call(name.replaceAll('.', '_'), ((input) as unknown as Parameters<NonNullable<(typeof mcp)["call"]>>[1]), ((error) as unknown as Parameters<NonNullable<(typeof mcp)["call"]>>[2])))) as TransportCall))},
  ];
  let timeline = await backend.http('timeline.get', {projectId});
  timeline = await backend.http('timeline.clip.add', ((request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId, startFrame: 20, sourceInFrame: 17, durationFrames: 80, gain: 0.5, rect: {x: 100, y: 200, width: 400, height: 600}, name: 'Trimmed transport clip'})) as unknown as Parameters<NonNullable<(typeof backend)["http"]>>[1]));
  const initial = timeline, clipId = timeline.clips[0].id, saved: { response: FixtureTimeline; }[]|{ input: { projectId: unknown; expectedRevision: unknown; requestId:string; }; response:FixtureTimeline; }[] = [];
  const firstInput = request(projectId, timeline, {clipId, atFrame: 50});
  const concurrent = await Promise.all(transports.map(({call}) => call(operation, ((firstInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>))));
  concurrent.forEach(result => assert.deepEqual(result, concurrent[0]));
  timeline = concurrent[0]; saved.push({input: firstInput, response: timeline});
  assert.equal(timeline.revision, initial.revision + 1); assert.equal(timeline.clips.length, 2); assert.equal(timeline.durationFrames, initial.durationFrames);
  const firstRight = timeline.clips.find((clip: { id: unknown; }) => clip.id !== clipId);
  assert.equal(timeline.clips.find((clip: { id: unknown; }) => clip.id === clipId).durationFrames, 30);
  assert.equal(firstRight.startFrame, 50); assert.equal(firstRight.sourceInFrame, 47); assert.equal(firstRight.durationFrames, 50);
  const undo = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(((undo) as unknown as Parameters<NonNullable<typeof editable>>[0])), editable(initial));
  timeline = await mcp.call('timeline_redo', request(projectId, ((undo) as unknown as Parameters<NonNullable<typeof request>>[1])));
  assert.deepEqual(editable(timeline), editable(((saved[0].response) as unknown as Parameters<typeof editable>[0])));

  const secondInput = request(projectId, timeline, {clipId: firstRight.id, atFrame: 80});
  const {requestId, ...withoutRequestId} = secondInput;
  timeline = await command(operation, withoutRequestId, undefined, ['--request-id', requestId]);
  saved.push({input: secondInput, response: timeline});
  const secondRight = timeline.clips.find((clip: { id: unknown; }) => !saved[0].response.clips.some((previous: { id: unknown; }) => previous.id === clip.id));
  const thirdInput = request(projectId, timeline, {clipId: secondRight.id, atFrame: 90});
  timeline = await mcp.call(toolName, thirdInput); saved.push({input: thirdInput, response: timeline});
  assert.equal(timeline.clips.length, 4);
  assert.equal((await backend.http('timeline.history.get', {projectId})).length, 4, 'one add and three splits produce four history entries');

  const cases = ([
    [request(projectId, timeline, {clipId, atFrame: 20}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId, atFrame: 50}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId, atFrame: 19}), 'SPLIT_BOUNDS'],
    [request(projectId, timeline, {clipId: randomUUID(), atFrame: 30}), 'CLIP_NOT_FOUND'],
    [request(projectId, timeline, {clipId, atFrame: 30.5}), 'VALIDATION_ERROR'],
    [request(projectId, timeline, {clipId, atFrame: 30, extra: true}), 'VALIDATION_ERROR'],
    [{...firstInput, atFrame: 51}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, requestId: randomUUID()}, 'REVISION_CONFLICT'],
  ] as const);
  const beforeErrors = backend.storage();
  for (const [input, code] of cases) {
    const errors: import('./helpers/strict-timeline-audio-types.ts').Failure[] = [];
    for (const {call} of transports) errors.push(await call(operation, ((((input) as unknown as Parameters<typeof call>[1])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), ((code) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>)));
    errors.slice(1).forEach(error => assertClientRecoveryError(error, errors[0], {operation, input}));
    if (code === 'REVISION_CONFLICT') assert.deepEqual(errors[0].details.current, timeline);
  }
  assert.deepEqual(backend.storage(), beforeErrors);

  let dropResponse = true, sent = 0, committed;
  const client = (createClient({env, fetchImpl: async (...args) => {
    sent++; const response = await fetch(...args);
    if (dropResponse) { dropResponse = false; committed = (await response.json()).data; throw Error('Synthetic response lost after commit'); }
    return response;
  }}) as FixtureClient);
  const uncertainInput = request(projectId, timeline, {clipId, atFrame: 35});
  await assert.rejects(client.rpc(operation, uncertainInput), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'BACKEND_UNAVAILABLE' && ((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.requestId === uncertainInput.requestId && ((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.submissionMayHaveSucceeded === true);
  assert.equal(sent, 1, 'shared client never automatically reissues an uncertain mutation');
  timeline = await backend.http('timeline.get', {projectId});
  assert.deepEqual(timeline, committed); assert.equal((timeline as unknown as FixtureTimeline).revision, uncertainInput.expectedRevision + 1);
  assert.deepEqual(await client.rpc(operation, uncertainInput), committed);
  assert.equal(sent, 2); saved.push({input: uncertainInput, response: ((committed) as unknown as FixtureTimeline)});
  const persisted = backend.storage(), pid = backend.pid;
  await backend.restart(); assert.notEqual(backend.pid, pid);
  for (const {name, call} of transports) {
    assert.deepEqual(await call('timeline.get', (((({projectId}) as unknown as Parameters<typeof call>[1])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), timeline, `${name} sees the same restarted timeline`);
    for (const record of saved as {input:unknown;response:unknown}[]) assert.deepEqual(await call(operation, record.input), record.response, `${name} replays old split responses exactly`);
    assert.deepEqual((await call('project.get', (((({projectId}) as unknown as Parameters<typeof call>[1])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>))).timeline, timeline);
  }
  assert.deepEqual(backend.storage(), persisted, 'replay after process restart cannot change timeline, journal, cursor or saved response bytes');
  assert.equal(persisted.timeline_requests.filter(row => row.requestId === firstInput.requestId).length, 1);
});

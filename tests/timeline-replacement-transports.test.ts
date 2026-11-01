import type {MediaShot} from './helpers/strict-service-responses.ts';
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
import {createServices} from '../packages/business/src/services.ts';
import {createServerProject, openProjectDatabase, projectDirFor, withoutForeignKeys} from './helpers/project-database.ts';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-replacement-transports-synthetic-token';
const operation = 'timeline.clip.replaceSource', toolName = 'timeline_clip_replaceSource';
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const editable = (timeline: FixtureTimeline) => ({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const request = <P extends Record<string,unknown>=Record<never,never>>(projectId: string, timeline: { revision: number; }, fields: P = {} as P):P & {projectId:string;expectedRevision:number;requestId:string} => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});

function environment(extra: NodeJS.ProcessEnv = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

async function cli<const A extends readonly string[],E extends string|undefined=undefined>(args: A, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}, expectedError?: E):Promise<WireResult<CliResult<A>,E>> {
  const child = spawn(process.execPath, (([path.join(repo, 'apps/cli/src/index.ts'), ...args]) as unknown as Parameters<typeof spawn>[1]), {cwd: repo, env: environment(((env) as unknown as Parameters<NonNullable<typeof environment>>[0])), stdio: ['ignore', 'pipe', 'pipe']});
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
    assert.equal(code, expectedError === 'VALIDATION_ERROR' ? 2 : errorStatus(expectedError) === 409 ? 3 : 6, stdout);
    assert.ok(stderr.trim()); return body.error;
  }
  assert.equal(code, 0, stdout + stderr); return body.data;
}

async function mcpFixture(t: test.TestContext, env: {MIOON_BASE_URL?: string; MIOON_TOKEN?: string;} = {}) {
  const client = new Client({name: 'timeline-replacement-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(((env) as unknown as Parameters<NonNullable<typeof environment>>[0])), stderr: 'pipe'});
  (transport.stderr as import('node:stream').Readable|null)?.resume();
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((client.getServerVersion())!.name, 'mioon');
  return {client, async call<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(name: N, input: I, expectedError?: E):Promise<WireResult<McpData<N,I>,E>> {
    const response = (await client.callTool({name, arguments: input}, undefined, {timeout: 10000}) as CallToolResult);
    const block = response.content.find((item) => item.type === 'text'); assert.ok(block);
    const body = JSON.parse(block.text);
    assert.deepEqual(response.structuredContent, body);
    assert.equal(Boolean(response.isError), Boolean(expectedError), block.text);
    assert.equal(body.ok, !expectedError, block.text);
    if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; }
    return body.data;
  }};
}

const errorStatus = (code: string|string[]) => ['SOURCE_UNCHANGED', 'INVALID_TIMELINE_SNAPSHOT'].includes(((code) as unknown as string)) || code?.includes('CONFLICT') ? 409 : ['TIMELINE_SOURCE_UNAVAILABLE', 'CLIP_NOT_FOUND', 'NOT_FOUND'].includes(((code) as unknown as string)) ? 404 : 400;
const resolveSchema = (root:SchemaNode,field:SchemaNode):SchemaNode=>field.$ref?resolveSchema(root,field.$ref.slice(2).split('/').reduce<SchemaNode>((node,key)=>node[key] as SchemaNode,root)):field;
const outsideTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports'];

// Discovery and malformed-input checks use the actual CLI and official SDK
// bridge, but no backend, provider, media bytes, probe or encoder.
test('replacement CLI and official MCP discover one strict schema with a required key and optional explicit version', {timeout: 60000}, async t => {
  const mcp = await mcpFixture(t), definition = await cli(['schema', operation]);
  const tool = ((await mcp.client.listTools() as {tools:TestTool[]})).tools.find(item => item.name === toolName);
  assert.ok(tool); assert.equal(definition.operation, operation); assert.equal(definition.toolName, toolName);
  assert.equal(definition.command, 'timeline clip replaceSource'); assert.equal(definition.requiresRequestId, true);
  assert.deepEqual(tool.inputSchema, definition.inputSchema);
  assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
  const schema = tool.inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ['assetId', 'clipId', 'expectedRevision', 'projectId', 'requestId']);
  assert.deepEqual(Object.keys(((schema.properties) as unknown as Parameters<typeof Object.keys>[0])).sort(), [...schema.required, 'versionId'].sort());
  for (const key of (['projectId', 'clipId', 'assetId', 'versionId'] as const)) {
    const field = resolveSchema(((schema) as unknown as Parameters<typeof resolveSchema>[0]), (schema.properties)![key]);
    assert.equal(field.type, 'string'); assert.equal(field.format, 'uuid');
  }
  const key = resolveSchema(((schema) as unknown as Parameters<typeof resolveSchema>[0]), (schema.properties)!.requestId);
  assert.equal(key.minLength, 8); assert.equal(key.maxLength, 200);
  assert.equal((schema.properties)!.expectedRevision.type, 'integer'); assert.equal((schema.properties)!.expectedRevision.exclusiveMinimum, 0);
  assert.deepEqual(tool.annotations, {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false});
  for (const [effect, value] of Object.entries({readOnly: false, idempotent: true, destructive: true, openWorld: false, databaseWrite: true, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false})) assert.equal(definition.effects[(effect as keyof (typeof definition)["effects"])], value, effect);
  const valid = {projectId: randomUUID(), clipId: randomUUID(), assetId: randomUUID(), expectedRevision: 1, requestId: randomUUID()};
  const invalid = [
    ...Object.keys(valid).map(field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field))),
    ...[0, -1, 1.5, '1'].map(expectedRevision => ({...valid, expectedRevision})),
    ...['', 'short', 'x'.repeat(201), 12345678].map(requestId => ({...valid, requestId})),
    ...['projectId', 'clipId', 'assetId', 'versionId'].map(field => ({...valid, [field]: 'not-a-uuid'})),
    {...valid, versionId: null}, {...valid, shotId: randomUUID()}, {...valid, patch: {assetId: randomUUID()}},
  ];
  for (const input of invalid) {
    const fromCli = await cli(['timeline', 'clip', 'replaceSource', '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
    assert.deepEqual(await mcp.call(toolName, input, 'VALIDATION_ERROR'), fromCli);
  }
  await cli(['timeline', 'clip', 'replaceSource', '--input', JSON.stringify(valid), '--request-id', 'different-request'], {}, 'VALIDATION_ERROR');
  const update = await cli(['schema', 'timeline.clip.update']);
  assert.equal(update.inputSchema.properties.patch.additionalProperties, false);
  for (const field of (['assetId', 'versionId', 'shotId', 'jobId'] as const)) {
    assert.ok(!Object.hasOwn(update.inputSchema.properties.patch.properties, field));
    const {assetId, ...fields} = valid, input = {...fields, patch: {[field]: randomUUID()}};
    const fromCli = await cli(['timeline', 'clip', 'update', '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
    assert.deepEqual(await mcp.call('timeline_clip_update', input, 'VALIDATION_ERROR'), fromCli);
  }
});

async function backendFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-replacement-transports-'));
  const created = createServerProject(root, {name: 'Replacement transport parity'}), projectId = created.projectId;
  let store = (created.store as unknown as FixtureStore), services = (createServices(store, new Map()) as FixtureServices);
  function asset(mimeType: string, extra: {provenance?: string; duration?: number; hasAudio?: boolean; projectId?: string;} = {}) {
    const id = randomUUID();
    return store.put('assets', {id, projectId, name: `Synthetic ${mimeType}`, mimeType, duration: mimeType.startsWith('image/') ? 0 : 8, width: 720, height: 1280, hasVideo: !mimeType.startsWith('audio/'), hasAudio: !mimeType.startsWith('image/'), provenance: 'user-import', sizeBytes: 128, sha256: 'a'.repeat(64), relativePath: `media/${id}.fixture`, url: `/media/${id}`, createdAt: '2026-10-10T00:00:00.000Z', ...extra});
  }
  const owned = {
    video: asset('video/mp4'), replacement: asset('video/webm'), generated: asset('video/mp4', {provenance: 'synthetic-mock'}),
    laterGenerated: asset('video/mp4', {provenance: 'synthetic-mock'}), short: asset('video/mp4', {duration: 2}),
    silent: asset('video/mp4', {hasAudio: false}), audio: asset('audio/wav'), otherAudio: asset('audio/mpeg'),
    image: asset('image/png'), otherImage: asset('image/jpeg'),
  };
  const shot = await services.call('shot.create', {projectId, title: 'Synthetic immutable versions'});
  function version(shot: MediaShot, asset: { id: unknown; projectId?: unknown; name?: string; mimeType?: unknown; duration?: number; width?: number; height?: number; hasVideo?: boolean; hasAudio?: boolean; provenance?: string; sizeBytes?: number; sha256: unknown; relativePath?: string; url: unknown; createdAt?: string; }, number: number) {
    const jobId = randomUUID(), id = randomUUID();
    store.put('jobs', {id: jobId, projectId: shot.projectId, shotId: shot.id, status: 'succeeded', providerId: 'mock', requestId: randomUUID(), revision: 1, submissionCount: 1, versionId: id});
    return store.put('versions', {id, projectId: shot.projectId, shotId: shot.id, jobId, number, providerId: 'mock', assetId: asset.id, sha256: asset.sha256, url: asset.url});
  }
  const generated = version(shot, owned.generated, 1), later = version(shot, owned.laterGenerated, 2);
  store.close();
  // Another registered project, with its asset, shot and version in a store of its own.
  const foreignProject = createServerProject(root, {name: 'Foreign synthetic scope'}), foreignProjectId = foreignProject.projectId;
  store = (foreignProject.store as unknown as FixtureStore); services = (createServices(store, new Map()) as FixtureServices);
  const assets = {...owned, foreign: asset('video/mp4', {projectId: foreignProjectId})};
  const foreignShot = await services.call('shot.create', {projectId: foreignProjectId, title: 'Foreign versions'});
  const versions = {generated, later, foreign: version(foreignShot, assets.foreign, 1)};
  // Synthetic metadata only; every timeline mutation below uses real transports.
  // Succeeded jobs cannot trigger provider work and no media files are needed.
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
    const deadline = Date.now() + 20000;
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
  // The backend process holds the project while it runs: the test opens it only after the process has exited.
  const stopped = async <T>(fn: (db: DatabaseSync) => T): Promise<T> => {
    await stop();
    const db = openProjectDatabase(projectDirFor(root, projectId));
    try { return fn(db); } finally { db.close(); }
  };
  const rows = (db: DatabaseSync, tables: readonly string[]) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return {root, url, projectId, foreignProjectId, assets, shot, versions, get pid() { return backend.pid; }, restart: async (editFixture?: (arg0: DatabaseSync) => void) => {
      if (editFixture) await stopped(editFixture); else await stop();
      await start();
    },
    async http(name: string, input: { projectId: unknown; expectedRevision?: unknown; requestId?:string; }, expectedError?: undefined) {
      const response = await fetch(url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: name, input})});
      const body = await response.json();
      assert.equal(response.status, expectedError ? errorStatus(expectedError) : 200, JSON.stringify(body));
      assert.equal(body.ok, !expectedError, JSON.stringify(body));
      if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; } return body.data;
    },
    // Timeline storage and the tables outside it, read between a stop and a start of the backend on the same port.
    async storage() {
      const state = await stopped(db => ({timeline: rows(db, ['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests']), outside: rows(db, outsideTables)}));
      await start();
      return state;
    },
  };
}

function assertReplacement(before: FixtureTimeline, after: FixtureTimeline, clipId: string, assetId: string, version?: { id: unknown; projectId?: unknown; shotId: unknown; jobId?: `${string}-${string}-${string}-${string}-${string}`; number?: unknown; providerId?: string; assetId?: unknown; sha256?: unknown; url?: unknown; }|undefined) {
  const original = before.clips.find(((clip) => clip.id === clipId)), expected = {...original, assetId};
  for (const field of (['versionId', 'shotId', 'jobId'] as const)) delete expected[field];
  if (version) Object.assign(expected, {versionId: version.id, shotId: version.shotId});
  assert.deepEqual((after)!.clips.find(((clip) => clip.id === clipId)), expected, 'every editable field and its exact presence are preserved');
  assert.deepEqual((after)!.clips.filter(((clip) => clip.id !== clipId)), before.clips.filter(((clip) => clip.id !== clipId)), 'neighbors and gaps never move');
  assert.deepEqual((after)!.tracks, before.tracks); assert.equal((after)!.durationFrames, before.durationFrames);
  assert.equal((after)!.revision, before.revision + 1); assert.equal((after)!.id, before.id);
}

test('replacement HTTP, CLI and official MCP preserve fixed sources, exact replay, history, errors and restart', {timeout: 120000}, async t => {
  const backend = await backendFixture(t), {projectId, assets, shot, versions} = backend;
  const env = {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token}, mcp = await mcpFixture(t, env);
  const command = <O extends string,E extends string|undefined=undefined>(name:O, input?:unknown, error?:E, flags: string[] = []) => (cli((([...name.split('.'), '--input', JSON.stringify(input), ...flags]) as unknown as Parameters<NonNullable<typeof cli>>[0]), env, ((error) as unknown as Parameters<NonNullable<typeof cli>>[2])) as Promise<WireResult<ServiceResponse<O>,E>>);
  const transports = [
    {name: 'HTTP', call: (backend.http as TransportCall)},
    {name: 'CLI', call: (command as TransportCall)},
    {name: 'MCP', call: ((((name: string, input?: unknown, error?: unknown) => (mcp.call(name.replaceAll('.', '_'), ((input) as unknown as Parameters<NonNullable<(typeof mcp)["call"]>>[1]), ((error) as unknown as Parameters<NonNullable<(typeof mcp)["call"]>>[2])))) as TransportCall))},
  ];
  let timeline = await backend.http('timeline.get', {projectId});
  timeline = await backend.http('timeline.clip.add', ((request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId: assets.video.id, startFrame: 20, sourceInFrame: 17, durationFrames: 80, gain: 0.5, rect: {x: 100, y: 200, width: 400, height: 600}, name: 'Trimmed fixed clip', fadeInFrames: 10, fadeOutFrames: 15})) as unknown as Parameters<NonNullable<(typeof backend)["http"]>>[1]));
  const clipId = timeline.clips[0].id;
  timeline = await command('timeline.clip.add', ((request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId: assets.image.id, startFrame: 120, durationFrames: 45, name: 'Unmoved image with omitted fades'})) as unknown as Parameters<NonNullable<typeof command>>[1]));
  const imageClipId = timeline.clips[1].id;
  timeline = await mcp.call('timeline_clip_add', request(projectId, timeline, {trackId: timeline.tracks[2].id, assetId: assets.audio.id, startFrame: 10, sourceInFrame: 20, durationFrames: 100, fadeInFrames: 0, gain: 0.75}));
  const audioClipId = timeline.clips[2].id, initial = timeline, saved: {input:{projectId:string;requestId:string}&Record<string,unknown>;response:FixtureTimeline}[] = [];
  const firstInput = request(projectId, timeline, {clipId, assetId: assets.replacement.id});
  let outside = (await backend.storage()).outside;
  const concurrent = await Promise.all(transports.map(({call}) => call(operation, ((firstInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>))));
  concurrent.forEach(result => assert.deepEqual(result, concurrent[0]));
  timeline = concurrent[0]; saved.push({input: firstInput, response: timeline});
  assertReplacement(initial, timeline, clipId, assets.replacement.id);
  assert.deepEqual((await backend.storage()).outside, outside);
  assert.equal((await backend.http('timeline.history.get', {projectId})).length, 4, 'three adds and one replacement; repeated calls add no history');
  const undo = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(((undo) as unknown as Parameters<NonNullable<typeof editable>>[0])), editable(initial));
  timeline = await mcp.call('timeline_redo', request(projectId, ((undo) as unknown as Parameters<NonNullable<typeof request>>[1])));
  assert.deepEqual(editable(timeline), editable(saved[0].response));

  // Exercise a distinct accepted replacement from each real transport.
  let before = timeline;
  const explicitInput = request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.generated.id});
  const {requestId, ...withoutRequestId} = explicitInput;
  timeline = await command(operation, withoutRequestId, undefined, ['--request-id', requestId]);
  assertReplacement(before, timeline, clipId, assets.generated.id, versions.generated);
  saved.push({input: explicitInput, response: timeline});
  assert.deepEqual((await backend.storage()).outside, outside);

  // Local canvas replay keys and timeline replay keys are separate namespaces.
  // Reusing this string for selection is allowed, but never repoints the clip.
  let selected = await command('version.select', {shotId: shot.id, versionId: versions.later.id, expectedRevision: shot.revision, requestId: firstInput.requestId});
  assert.deepEqual(await backend.http('timeline.get', {projectId}), timeline);
  assert.equal(timeline.clips.find((clip: { id: unknown; }) => clip.id === clipId).versionId, versions.generated.id);
  outside = (await backend.storage()).outside; before = timeline;
  const assetOnlyInput = request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id});
  timeline = await mcp.call(toolName, assetOnlyInput);
  assertReplacement(before, timeline, clipId, assets.laterGenerated.id);
  saved.push({input: assetOnlyInput, response: timeline});
  assert.deepEqual((await backend.storage()).outside, outside);
  selected = (await mcp.call('version_select', {shotId: shot.id, versionId: versions.generated.id, expectedRevision: selected.revision, requestId: randomUUID()}) as unknown as typeof selected);
  assert.deepEqual(await backend.http('timeline.get', {projectId}), timeline, 'later selection cannot move asset-only generated clips either');
  outside = (await backend.storage()).outside;

  for (const [call, id, asset] of ([[backend.http, imageClipId, assets.otherImage], [command, audioClipId, assets.otherAudio]] as const)) {
    before = timeline;
    const input = request(projectId, timeline, {clipId: id, assetId: asset.id});
    timeline = await (call as import('./helpers/strict-timeline-transport-types.ts').TransportCall)(operation, input); assertReplacement(before, timeline, id, asset.id);
    saved.push({input, response: timeline});
  }
  assert.deepEqual((await backend.storage()).outside, outside);
  const cases = ([
    [request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id}), 'SOURCE_UNCHANGED'],
    [request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id, versionId: versions.later.id}), 'SOURCE_UNCHANGED'],
    [request(projectId, timeline, {clipId, assetId: assets.short.id}), 'SOURCE_BOUNDS'],
    [request(projectId, timeline, {clipId, assetId: assets.image.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId: imageClipId, assetId: assets.video.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId: audioClipId, assetId: assets.video.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId, assetId: assets.silent.id}), 'FADE_AUDIO_UNSUPPORTED'],
    [request(projectId, timeline, {clipId, assetId: assets.foreign.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: randomUUID()}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.later.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.foreign.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId: randomUUID(), assetId: assets.video.id}), 'CLIP_NOT_FOUND'],
    [request(projectId, timeline, {clipId, assetId: assets.video.id, extra: true}), 'VALIDATION_ERROR'],
    [{...firstInput, assetId: assets.generated.id}, 'IDEMPOTENCY_CONFLICT'],
    [{...explicitInput, versionId: undefined}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, projectId: backend.foreignProjectId}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, requestId: randomUUID()}, 'REVISION_CONFLICT'],
  ] as const);
  const {timeline: beforeErrors, outside: outsideErrors} = await backend.storage();
  for (const [input, code] of cases) {
    const errors: import('./helpers/strict-timeline-audio-types.ts').Failure[] = [];
    for (const {call} of transports) errors.push(await call(operation, ((((input) as unknown as Parameters<typeof call>[1])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), ((code) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>)));
    errors.slice(1).forEach(error => assertClientRecoveryError(error, errors[0], {operation, input}));
    if (code === 'REVISION_CONFLICT') assert.deepEqual(errors[0].details.current, timeline);
    if (code === 'TIMELINE_SOURCE_UNAVAILABLE') assert.deepEqual(errors[0].details, {});
    if (['SOURCE_UNCHANGED', 'SOURCE_BOUNDS', 'INVALID_CLIP_TYPE', 'FADE_AUDIO_UNSUPPORTED', 'REVISION_CONFLICT'].includes(((code) as unknown as string))) {
      assert.equal(errors[0].details.mutationOutcome, 'not_applied');
      assert.equal(errors[0].details.requestId, input.requestId, 'fresh rejection proof is bound to the exact attempted key');
    }
    if (['TIMELINE_SOURCE_UNAVAILABLE', 'CLIP_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'VALIDATION_ERROR'].includes(((code) as unknown as string))) assert.ok(!Object.hasOwn(errors[0].details, 'mutationOutcome'), 'scope/receipt/schema errors are never fresh-key rollback proof');
  }
  for (const {call} of transports) {
    await call('timeline.clip.update', ((request(projectId, timeline, {clipId, patch: {assetId: assets.video.id}})) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), (((('VALIDATION_ERROR') as unknown as Parameters<typeof call>[2])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>));
    await call('timeline.undo', (({...firstInput, clipId: undefined, assetId: undefined}) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), (('IDEMPOTENCY_CONFLICT') as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>));
  }
  const afterErrors = await backend.storage();
  assert.deepEqual(afterErrors.timeline, beforeErrors);
  assert.deepEqual(afterErrors.outside, outsideErrors);

  let dropResponse = true, sent = 0, committed!:FixtureTimeline;
  const client = (createClient({env, fetchImpl: async (...args) => {
    sent++; const response = await fetch(...args);
    if (dropResponse) { dropResponse = false; committed = (await response.json()).data; throw Error('Synthetic replacement response lost after commit'); }
    return response;
  }}) as FixtureClient);
  const uncertainInput = request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.generated.id});
  before = timeline;
  await assert.rejects(client.rpc(operation, uncertainInput), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'BACKEND_UNAVAILABLE' && ((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.requestId === uncertainInput.requestId && ((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.submissionMayHaveSucceeded === true);
  assert.equal(sent, 1, 'uncertain replacement is never automatically reissued');
  timeline = await backend.http('timeline.get', {projectId}); assert.deepEqual(timeline, committed);
  assertReplacement(before, timeline, clipId, assets.generated.id, versions.generated);
  assert.deepEqual(await client.rpc(operation, uncertainInput), committed); assert.equal(sent, 2);
  saved.push({input: uncertainInput, response: committed});
  for (const {call} of transports) assert.deepEqual(await call(operation, ((uncertainInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), committed);
  const {timeline: persisted, outside: persistedOutside} = await backend.storage(), pid = backend.pid;
  await backend.restart(); assert.notEqual(backend.pid, pid);
  for (const {name, call} of transports) {
    assert.deepEqual(await call('timeline.get', (({projectId}) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>)), timeline, `${name} observes the same restarted timeline`);
    for (const record of saved as {input:{projectId:unknown;expectedRevision?:unknown;requestId?:string};response:unknown}[]) assert.deepEqual(await call(operation, record.input), record.response, `${name} replays each historical replacement exactly`);
    assert.deepEqual((await call('project.get', (({projectId}) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>))).timeline, timeline);
  }
  const replayed = await backend.storage();
  assert.deepEqual(replayed.timeline, persisted, 'restart/replay never rewrites timeline, history, cursor or immutable response bytes');
  assert.deepEqual(replayed.outside, persistedOutside, 'restart/replay cannot alter generation, versions, source assets or exports');
  for (const {input} of saved) assert.equal(persisted.timeline_requests.filter(row => row.requestId === input.requestId).length, 1);

  // A later definite 4xx is not proof that an earlier lost-ack mutation failed.
  // Corrupt only this disposable stopped fixture, never an active backend DB.
  const receipt = persisted.timeline_requests.find(row => row.requestId === uncertainInput.requestId);
  const installReceipt = (db:DatabaseSync, text:string) => {
    db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run((receipt)!.requestId);
    db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run((receipt)!.requestId, (receipt)!.requestHash, text);
  };
  await backend.restart((db?: unknown) => {
    const malformed = JSON.parse((((receipt)!.response) as unknown as Parameters<NonNullable<(typeof JSON)["parse"]>>[0]));
    malformed.clips.find((clip: { id: unknown; }) => clip.id === clipId).assetId = assets.video.id;
    installReceipt(db as DatabaseSync, JSON.stringify(malformed));
  });
  let deniedState = (await backend.storage()).timeline;
  let deniedBackendError;
  for (const {name, call} of transports) {
    const error = await call(operation, ((uncertainInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), (((('INVALID_TIMELINE_SNAPSHOT') as unknown as Parameters<typeof call>[2])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>));
    assert.ok(!Object.hasOwn((error as import('./helpers/strict-timeline-audio-types.ts').Failure).details, 'mutationOutcome'), 'corrupt prior receipt cannot produce not-applied proof');
    if (name === 'HTTP') deniedBackendError = error;
    else assertClientRecoveryError(error, deniedBackendError, {operation, input: uncertainInput});
  }
  assert.deepEqual((await backend.storage()).timeline, deniedState);
  await backend.restart((((db: { prepare: (arg0: string) => { (): unknown; new(): unknown; run: { (arg0: unknown,arg1: string): void; new(): unknown; }; }; }) => {
    installReceipt(db as unknown as DatabaseSync, (((receipt)!.response) as unknown as Parameters<NonNullable<typeof installReceipt>>[1]));
    // The asset is moved to the other project as a corrupt file would hold it.
    withoutForeignKeys(db as unknown as DatabaseSync, () => db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(backend.foreignProjectId, assets.generated.id));
  }) as unknown as Parameters<typeof backend.restart>[0]));
  const denied = await backend.storage();
  deniedState = denied.timeline;
  const deniedOutside = denied.outside;
  for (const {name, call} of transports) {
    const error = await call(operation, ((uncertainInput) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[1]>), (((('TIMELINE_SOURCE_UNAVAILABLE') as unknown as Parameters<typeof call>[2])) as unknown as StrictIntersection<Parameters<NonNullable<typeof call>>[2]>));
    if (name === 'HTTP') {
      assert.deepEqual((error as import('./helpers/strict-timeline-audio-types.ts').Failure).details, {}, 'ownership failure after a committed lost response cannot release its original request');
      deniedBackendError = error;
    } else assertClientRecoveryError(error, deniedBackendError, {operation, input: uncertainInput});
  }
  const afterDenied = await backend.storage();
  assert.deepEqual(afterDenied.timeline, deniedState);
  assert.deepEqual(afterDenied.outside, deniedOutside);
});

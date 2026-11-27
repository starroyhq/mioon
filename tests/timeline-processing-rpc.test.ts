import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {commitMioSequenceAction, previewMioSequenceAction} from '../packages/business/src/format5-mio-sequence.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createClient, operationDefinition} from '../packages/client/src/index.ts';
import {effectAnnotations} from '../packages/contracts/src/operation-effects.ts';
import {projectRpcPath, projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {timelineProcessingResponseSchemas, timelineProcessingSchemas} from '../packages/contracts/src/timeline-processing.ts';
import type {PreviewMedia} from '../packages/contracts/src/timeline-preview-media.ts';
import {parseTimelinePreviewMediaQuery, timelinePreviewMediaPath} from '../packages/contracts/src/timeline-preview-media.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {projectDatabasePath, projectDirFor} from './helpers/project-database.ts';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const token = 'synthetic-timeline-processing-rpc-token';
type Row = Record<string, unknown>;
type Envelope<T = unknown> = {ok: true; data: T} | {ok: false; error: {code: string}};

function data<T>(envelope: Envelope<T>): T {
  assert.equal(envelope.ok, true, envelope.ok ? undefined : envelope.error.code);
  return envelope.data;
}
function errorCode(envelope: Envelope): string {
  assert.equal(envelope.ok, false);
  return envelope.error.code;
}

test('the shared client preserves the wait deadline and admits only the requested task summary', async t => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const item = {taskId, clipId: randomUUID(), kind: 'reverse', status: 'running', progress: 25};
  const expected = {item, timedOut: true};
  let result: unknown = expected;
  const timeout = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const clientOptions = {
    env: {MIOON_BASE_URL: 'http://127.0.0.1:18000', MIOON_TOKEN: token},
    fetchImpl: (async (url: string | URL | Request) => {
      assert.equal(new URL(String(url)).pathname, projectRpcPath(projectId));
      return Response.json({ok: true, data: result});
    }) as typeof fetch,
  };
  const client = createClient(clientOptions);
  const input = {projectId, taskId};
  assert.deepEqual(await client.rpc('timeline.processing.wait', input), expected);
  assert.deepEqual(timeout.mock.calls.at(-1)?.arguments, [35_000]);
  assert.deepEqual(await client.rpc('timeline.processing.wait', {...input, timeoutMs: 60_000}), expected);
  assert.deepEqual(timeout.mock.calls.at(-1)?.arguments, [65_000]);
  await createClient({...clientOptions, requestTimeoutMs: 8_000}).rpc('timeline.processing.wait', input);
  assert.deepEqual(timeout.mock.calls.at(-1)?.arguments, [8_000]);
  await client.rpc('timeline.processing.wait', input, {timeoutMs: 9_000});
  assert.deepEqual(timeout.mock.calls.at(-1)?.arguments, [9_000]);

  result = {item: {...item, path: '/private/synthetic/proxy.mkv', dataBase64: 'c3ludGhldGlj'}, timedOut: true};
  await assert.rejects(client.rpc('timeline.processing.wait', input), {code: 'BACKEND_PROTOCOL_ERROR'});
  result = {taskId: randomUUID()};
  const requestId = randomUUID();
  await assert.rejects(client.rpc('timeline.processing.retry', {...input, requestId}), {
    code: 'BACKEND_PROTOCOL_ERROR',
    details: {operation: 'timeline.processing.retry', requestId, submissionMayHaveSucceeded: true,
      recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'},
  });
});

test('preview response accepts task identities and only authentic project media URLs', async () => {
  const projectId = randomUUID(), clipId = randomUUID(), assetId = randomUUID(), taskId = randomUUID();
  let output: unknown;
  const client = createClient({
    env: {MIOON_BASE_URL: 'http://127.0.0.1:18000', MIOON_TOKEN: token},
    fetchImpl: (async () => Response.json({ok: true, data: output})) as typeof fetch,
  });
  const read = () => client.rpc('timeline.preview.media', {projectId, clipId});
  output = {mode: 'proxy', status: 'running', taskId, progress: 42};
  assert.deepEqual(await read(), output);
  output = {mode: 'proxy', status: 'failed', taskId, reason: 'INTERPOLATION_UNAVAILABLE'};
  assert.deepEqual(await read(), output);
  const address = {projectId, clipId, taskId, assetId, digest: 'a'.repeat(64)};
  const validUrl = timelinePreviewMediaPath(address);
  assert.deepEqual(parseTimelinePreviewMediaQuery(new URL(validUrl, 'http://localhost').searchParams),
    {clipId, taskId, digest: address.digest});
  output = {mode: 'proxy', status: 'ready', url: validUrl, durationFrames: 60};
  assert.deepEqual(await read(), output);
  for (const url of [timelinePreviewMediaPath({...address, projectId: randomUUID()}),
    timelinePreviewMediaPath({...address, clipId: randomUUID()}), projectMediaPath(projectId, assetId),
    validUrl + '&taskId=' + taskId, validUrl + '&download=1', validUrl + '&preview=1',
    validUrl.replace(address.digest, 'z'.repeat(64)), '/private/tmp/synthetic.mp4', 'C:\\tmp\\synthetic.mp4',
    'https://example.invalid/media', validUrl + '&path=%2Fprivate%2Ftmp']) {
    output = {mode: 'proxy', status: 'ready', url, durationFrames: 60};
    await assert.rejects(read, {code: 'BACKEND_PROTOCOL_ERROR'});
  }
});

test('a development host with the format-6 switch off keeps format-5 reads and has no preview media capability', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-preview-off-'));
  const previousGate = process.env.MIOON_FORMAT6_DEV;
  delete process.env.MIOON_FORMAT6_DEV;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {await server?.close();} finally {
      if (previousGate !== undefined) process.env.MIOON_FORMAT6_DEV = previousGate;
      await rm(root, {recursive: true, force: true});
    }
  });
  server = await startServer({dataDir: path.join(root, 'app'), port: 0, token,
    localDraftChannel: 'development', projectFormatForTest: undefined});
  const client = createClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: token}});
  const {id: projectId} = await client.rpc<{id: string}>('project.create', {name: 'Ordinary project'});
  const project = await client.rpc<{projectFormatVersion: number; timeline: {capabilities: {speed: boolean}}}>('project.get', {projectId});
  assert.equal(project.projectFormatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  assert.equal(project.timeline.capabilities.speed, false);
  await assert.rejects(client.rpc('timeline.preview.media', {projectId, clipId: randomUUID()}),
    {code: 'UNKNOWN_OPERATION'});
});

test('CLI and MCP share processing discovery, task ownership and exact retry replay', {timeout: 90_000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-processing-rpc-'));
  const dataDir = path.join(root, 'app');
  const previousGate = process.env.MIOON_FORMAT6_DEV;
  process.env.MIOON_FORMAT6_DEV = '1';
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const mcp = new Client({name: 'processing-rpc-test', version: '1.0.0'});
  t.after(async () => {
    try {
      await mcp.close();
      await server?.close();
    } finally {
      if (previousGate === undefined) delete process.env.MIOON_FORMAT6_DEV;
      else process.env.MIOON_FORMAT6_DEV = previousGate;
      await rm(root, {recursive: true, force: true});
    }
  });
  const start = () => startServer({dataDir, port: 0, token, localDraftChannel: 'development', projectFormatForTest: undefined});
  server = await start();
  const env: Record<string, string> = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: token};
  const post = async <T>(route: string, operation: string, input: Row): Promise<Envelope<T>> => {
    const response = await fetch(env.MIOON_BASE_URL + route, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({operation, input})});
    return await response.json() as Envelope<T>;
  };
  const makeProject = async (name: string) =>
    data(await post<{id: string}>('/api/rpc', 'project.create', {name})).id;
  const projectId = await makeProject('Processing source');
  const otherProjectId = await makeProject('Foreign project');
  const rpc = <T>(operation: string, input: Row = {}) =>
    post<T>(projectRpcPath(projectId), operation, {projectId, ...input});
  const edit = async (operation: string, action: Row) => {
    const plan = data(await rpc<{envelope: unknown; planDigest: string}>(operation, action));
    const receipt = data(await rpc<{status: string}>('sequence.action.commit',
      {envelope: plan.envelope, expectedPlanDigest: plan.planDigest}));
    assert.equal(receipt.status, 'applied');
  };
  const cli = async <T>(operation: string, input: Row): Promise<Envelope<T>> => {
    const args = ['apps/cli/src/index.ts', ...operation.split('.'), '--input', JSON.stringify(input)];
    const result = await run(process.execPath, args, {cwd: repo, env, timeout: 15_000})
      .catch((error: unknown) => {
        if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') return {stdout: error.stdout};
        throw error;
      });
    return JSON.parse(result.stdout) as Envelope<T>;
  };
  const mcpCall = async <T>(operation: string, input: Row): Promise<Envelope<T>> => {
    const result = await mcp.callTool({name: operation.replaceAll('.', '_'), arguments: input}, undefined, {timeout: 15_000});
    const structured = result.structuredContent as unknown as Envelope<T>;
    assert.equal(Boolean(result.isError), !structured.ok);
    return structured;
  };
  const file = path.join(root, 'source.mp4');
  await run(env.MIOON_FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=red:size=64x64:rate=30', '-frames:v', '60',
    '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p10le', file], {env, timeout: 15_000});
  const {id: assetId} = data(await rpc<{id: string}>('asset.import', {name: 'source.mp4', mimeType: 'video/mp4',
    dataBase64: (await readFile(file)).toString('base64')}));
  await edit('sequence.board.edit', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  await edit('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
  const {timeline} = data(await rpc<{timeline: {capabilities: {speed: boolean}; clips: {id: string; assetId: string}[]}}>('project.get'));
  assert.equal(timeline.capabilities.speed, true);
  const clipId = timeline.clips.find(clip => clip.assetId === assetId)?.id;
  assert.ok(clipId);
  const previewInput = {projectId, clipId};
  const content = projectMediaPath(projectId, assetId);
  const pendingProxy = timelinePreviewMediaPath({...previewInput, assetId, taskId: randomUUID(), digest: 'a'.repeat(64)});
  const media = (url: string, method = 'GET', authenticated = true) => fetch(env.MIOON_BASE_URL + url, {method,
    headers: authenticated ? {authorization: 'Bearer ' + token} : {}});
  const original = await media(content, 'HEAD');
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'video/mp4');
  assert.equal((await media(pendingProxy, 'HEAD', false)).status, 401);
  for (const url of [pendingProxy, pendingProxy + '&download=1']) {
    const response = await media(url);
    assert.equal(response.status, 404);
    assert.equal(errorCode(await response.json() as Envelope), 'NOT_FOUND');
  }
  const native = {mode: 'native', rate: {numerator: 1, denominator: 1}};
  assert.deepEqual(data(await rpc<PreviewMedia>('timeline.preview.media', previewInput)), native);
  assert.equal(errorCode(await rpc('timeline.preview.media', {...previewInput, projectId: otherProjectId})), 'PROJECT_ID_MISMATCH');
  assert.equal(errorCode(await rpc('timeline.preview.media', {...previewInput, clipId: randomUUID()})), 'NOT_FOUND');
  assert.equal(errorCode(await rpc('timeline.preview.media', {...previewInput, requestId: randomUUID()})), 'VALIDATION_ERROR');
  const speedAction = (interpolation: 'optical' | 'blend' | 'off') => ({
    kind: 'clip-speed', clipId, setting: {speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}},
      direction: 'forward', pitchShift: false, interpolation},
  } as const);
  // Older projects can contain interpolation settings that new edits reject.
  // Seed them while the host is closed to exercise API behavior on existing data.
  const projectFile = projectDatabasePath(projectDirFor(dataDir, projectId));
  const persistLegacyInterpolation = async (interpolation: 'optical' | 'blend') => {
    await server?.close();
    server = undefined;
    const store = openProjectStore({projectFile, allowFormat6: true, locate: id => projectLocation(serverAppDirectories(dataDir), id)});
    try {
      const plan = previewMioSequenceAction(store, projectId, randomUUID(), speedAction(interpolation), {origin: 'user'});
      assert.equal(commitMioSequenceAction(store, plan).status, 'applied');
    } finally {
      store.close();
    }
    server = await start();
    env.MIOON_BASE_URL = server.url;
  };
  assert.equal(errorCode(await rpc('sequence.timeline.edit', speedAction('optical'))), 'UNSUPPORTED_FORMAT');

  await persistLegacyInterpolation('optical');
  const connect = new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd: repo, env, stderr: 'ignore'});
  await mcp.connect(connect);
  const tools = (await mcp.listTools()).tools;
  for (const operation of Object.keys(timelineProcessingSchemas)) {
    const definition = operationDefinition(operation);
    const tool = tools.find(candidate => candidate.name === definition.toolName);
    assert.ok(tool, operation);
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(definition.effects));
  }
  const halfSpeed = {mode: 'native', rate: {numerator: 1, denominator: 2}};
  assert.deepEqual(data(await cli<PreviewMedia>('timeline.preview.media', previewInput)), halfSpeed);
  assert.deepEqual(data(await mcpCall<PreviewMedia>('timeline.preview.media', previewInput)), halfSpeed);

  let taskId: string | undefined;
  const deadline = Date.now() + 10_000;
  do {
    const list = timelineProcessingResponseSchemas['timeline.processing.list'].parse(data(await rpc('timeline.processing.list')));
    taskId = list.items.find(item => item.clipId === clipId && item.kind === 'optical')?.taskId;
    if (!taskId) await delay(25);
  } while (!taskId && Date.now() < deadline);
  assert.ok(taskId);
  const task = {projectId, taskId};
  const expected = {taskId, clipId, kind: 'optical', status: 'failed', reason: 'UNSUPPORTED_FORMAT'};
  assert.deepEqual(data(await mcpCall('timeline.processing.wait', {...task, timeoutMs: 10_000})), {item: expected, timedOut: false});
  assert.deepEqual(data(await cli('timeline.processing.list', {projectId})), {items: [expected]});
  assert.deepEqual(data(await mcpCall('timeline.processing.inspect', task)), {item: expected});
  assert.deepEqual(data(await mcpCall('timeline.processing.wait', {...task, timeoutMs: 200})), {item: expected, timedOut: false});
  assert.equal(errorCode(await cli('timeline.processing.retry', task)), 'VALIDATION_ERROR');
  assert.equal(errorCode(await mcpCall('timeline.processing.wait', {...task, timeoutMs: 60_001})), 'VALIDATION_ERROR');
  const foreign = await mcpCall('timeline.processing.inspect', {...task, projectId: otherProjectId});
  assert.equal(errorCode(foreign), 'SPEED_PROCESSING_TASK_NOT_FOUND');

  const retry = {...task, requestId: randomUUID()};
  assert.deepEqual(data(await cli('timeline.processing.retry', retry)), {taskId});
  assert.deepEqual(data(await mcpCall('timeline.processing.retry', retry)), {taskId});
  await edit('sequence.timeline.edit', speedAction('off'));
  assert.deepEqual(data(await mcpCall('timeline.processing.retry', retry)), {taskId});
  assert.equal(errorCode(await cli('timeline.processing.retry', {...task, requestId: randomUUID()})), 'SPEED_PROCESSING_STALE');
  assert.deepEqual(data(await mcpCall('timeline.processing.cache.clear', {projectId})), {freedBytes: 0});
  const cache = timelineProcessingResponseSchemas['timeline.processing.cache.get'].parse(data(await cli('timeline.processing.cache.get', {projectId})));
  assert.equal(cache.usedBytes, 0);
  assert.equal(cache.limitBytes, 10 * 1024 ** 3);

  assert.equal(errorCode(await rpc('sequence.timeline.edit', speedAction('blend'))), 'UNSUPPORTED_FORMAT');
  await persistLegacyInterpolation('blend');
  assert.equal(errorCode(await rpc('timeline.preview.media', previewInput)), 'UNSUPPORTED_FORMAT');

  await edit('sequence.timeline.edit', {kind: 'clip-speed', clipId, setting: {
    speed: {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'custom', points: [
      {sourceFrame: 0, rate: {numerator: 1, denominator: 1}},
      {sourceFrame: 60, rate: {numerator: 2, denominator: 1}},
    ]},
    direction: 'forward', pitchShift: false, interpolation: 'off',
  }});
  const proxy = data(await rpc<PreviewMedia>('timeline.preview.media', previewInput));
  assert.equal(proxy.mode, 'proxy');
});

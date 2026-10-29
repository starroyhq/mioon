import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse} from './helpers/strict-service-responses.ts';
import type {CliResult,McpData,WireResult,TestTool,SchemaNode} from './helpers/strict-timeline-transport-types.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';

const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/v2-tests/mcp');
const token = 'timeline-mcp-regression-test-local-token';
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const port = ((server.address() as import('node:net').AddressInfo))!.port; await new Promise(resolve => server.close(resolve)); return port; }

test('timeline official SDK protocol exercises strict tools, shared HTTP state, exact replay and real backend restart', { timeout: 120_000 }, async t => {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-timeline-mcp-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const traffic: ({ direction: string; at: string; message: JSONRPCMessage; })[] = [], report = { startedAt: new Date().toISOString(), runtime: process.version, implementation: 'Official MCP SDK Client + StdioClientTransport', calls: [], http: [], processes: [], checks: [] };
  let backend!: ChildProcessByStdio<null,Readable,Readable>, client!: Client<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }>, transport!: StdioClientTransport, mcpStderr = '';
  async function start() {
    const record = { event: 'start', at: new Date().toISOString(), port, stdout: '', stderr: '' }; report.processes.push(((record) as unknown as Parameters<typeof report.processes.push>[0]));
    backend = spawn(process.execPath, ['server/index.ts'], { cwd: repo, env: { ...process.env, PORT: String(port), MIOON_DATA_DIR: root, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAYML_API_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    (record as typeof record & {pid:(number | undefined)}).pid = backend.pid; backend.stdout.setEncoding('utf8').on('data', bytes => record.stdout += bytes); backend.stderr.setEncoding('utf8').on('data', bytes => record.stderr += bytes); backend.on('exit', (code, signal) => Object.assign(record, { exitCode: code, signal }));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (backend.exitCode !== null) throw Error(record.stderr); try { if ((await fetch(base + '/health')).ok) return; } catch {} await pause(40); }
    throw Error(`Backend startup timed out: ${record.stderr}`);
  }
  async function stop() { if (!backend || backend.exitCode !== null || backend.signalCode) return; const child = backend, end = once(child, 'exit'); child.kill('SIGTERM'); await end; }
  t.after(async () => {
    if (client) await client.close().catch(() => {}); else if (transport) await transport.close().catch(() => {});
    await stop(); (report as typeof report & {finishedAt:(string)}).finishedAt = new Date().toISOString(); (report as typeof report & {mcpStderr:(string)}).mcpStderr = mcpStderr; (report as typeof report & {protocolMessageCount:(number)}).protocolMessageCount = traffic.length;
    await writeFile(path.join(evidence, 'protocol-traffic.jsonl'), traffic.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2)); await rm(root, { recursive: true, force: true });
  });
  await start();
  transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.ts'], cwd: repo, env: { ...process.env, MIOON_BASE_URL: base, MIOON_TOKEN: token }, stderr: 'pipe' });
  ((transport.stderr as import('node:stream').Readable|null))!.setEncoding('utf8').on('data', (bytes: string) => mcpStderr += bytes);
  const wire:import('@modelcontextprotocol/sdk/shared/transport.js').Transport = {
    onmessage: undefined, onerror: undefined, onclose: undefined,
    async start() { transport.onmessage = message => { traffic.push({ direction: 'server-to-client', at: new Date().toISOString(), message }); wire.onmessage?.(message); }; transport.onerror = error => wire.onerror?.(error); transport.onclose = () => wire.onclose?.(); await transport.start(); },
    send(message: JSONRPCMessage, options?: unknown) { traffic.push({ direction: 'client-to-server', at: new Date().toISOString(), message }); return (transport.send as (message:JSONRPCMessage,options?:unknown)=>Promise<void>)(message, options); },
    close() { return transport.close(); }, get sessionId() { return (transport as StdioClientTransport & {sessionId?:string}).sessionId; },
  };
  client = new Client({ name: 'timeline-v2-regression', version: '2.0.0' }, { capabilities: {} }); await client.connect(wire);
  const tools = ((await client.listTools() as {tools:TestTool[]})).tools; const names = tools.map(tool => tool.name);
  const requiredTools = ['timeline_get', 'timeline_track_add', 'timeline_track_update', 'timeline_clip_add', 'timeline_clip_update', 'timeline_clip_remove', 'timeline_seed', 'timeline_render'];
  for (const name of requiredTools) { assert.ok(names.includes(name), `Missing tool ${name}`); assert.equal((tools.find(tool => tool.name === name))!.inputSchema.additionalProperties, false, `${name} advertises strict schema`); }
  (report as typeof report & {toolNames:(string[])}).toolNames = names;
  async function call<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(name?: N, args: I = {} as I, expectedError?: E):Promise<WireResult<McpData<N,I>,E>> {
    const result = (await client.callTool((({ name, arguments: args }) as unknown as Parameters<typeof client.callTool>[0])) as CallToolResult); const block = result.content.find((item) => item.type === 'text'); assert.ok(block, name);
    const body = JSON.parse(block.text);
    report.calls.push((({ name, args: args.dataBase64 ? { ...args, dataBase64: `[${(args.dataBase64 as string).length} base64 characters]` } : args, result: body }) as unknown as Parameters<typeof report.calls.push>[0]));
    assert.equal(Boolean(result.isError), Boolean(expectedError), JSON.stringify(body)); assert.equal(body.ok, !expectedError, JSON.stringify(body));
    if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; } return body.data;
  }
  async function http<N extends string,I extends Record<string,unknown>=Record<string,never>,E extends string|undefined=undefined>(operation: N, input: I = {} as I):Promise<WireResult<ServiceResponse<N>,E>> {
    const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
    const body = await response.json(); report.http.push((({ operation, input, status: response.status, body }) as unknown as Parameters<typeof report.http.push>[0])); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); return body.data;
  }
  async function invalid(name: string, args: { projectId: unknown; extraneous?: boolean; expectedRevision?: unknown; requestId?: `${string}-${string}-${string}-${string}-${string}`; clipId?: unknown; patch?: { assetId: unknown; }|{ name: string; unexpected: boolean; }|{ rect: { x: number; y: number; width: number; height: number; rotation: number; }; }; trackId?: unknown; assetId?: unknown; startFrame?: number; durationFrames?: number; }) {
    let response;
    try { response = (await client.callTool({ name, arguments: args }) as CallToolResult); assert.equal(response.isError, true, `${name} must reject unknown/invalid fields rather than strip them`); }
    catch (error) { assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code, -32602); response = { code: (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code, message: (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message }; }
    report.checks.push((({ name: 'strict MCP rejection', tool: name, input: args, response }) as unknown as Parameters<typeof report.checks.push>[0]));
  }
  const p = await call('project_create', { name: 'Timeline MCP durable parity' }), projectId = p.id;
  let timeline = await call('timeline_get', { projectId }); assert.equal(timeline.revision, 1); assert.equal(timeline.clips.length, 0);
  assert.deepEqual((await call('project_get', { projectId })).timeline, timeline);
  const imageFile = path.join(root, 'green.png');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=1', '-frames:v', '1', '-threads', '1', imageFile]);
  const image = await call('asset_import', { projectId, name: 'local-green.png', mimeType: 'image/png', dataBase64: (await readFile(imageFile)).toString('base64') });
  const audioAssets: import('./helpers/strict-timeline-core-types.ts').FixtureAsset[] = [];
  for (const [extension, mimeType, codec] of ([['wav', 'audio/wav', 'pcm_s16le'], ['mp3', 'audio/mpeg', 'libmp3lame'], ['m4a', 'audio/mp4', 'aac']] as const)) {
    const file = path.join(root, `tone.${extension}`);
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=48000:duration=2', '-c:a', codec, '-threads', '1', file]);
    const asset = await call('asset_import', { projectId, name: `tone.${extension}`, mimeType, dataBase64: (await readFile(file)).toString('base64') });
    assert.equal(asset.mimeType, mimeType); assert.ok(asset.duration >= 2); assert.equal(asset.hasAudio, true); audioAssets.push(asset);
  }
  const history = [];
  async function mutate(name: string, fields: { kind?: string; name?: string; trackId?: unknown; patch?: { name: string; hidden: boolean; muted: boolean; }|{ trackId: unknown; startFrame: number; durationFrames: number; rect: { x: number; y: number; width: number; height: number; }; }; assetId?: unknown; startFrame?: number; durationFrames?: number; clipId?: unknown; sourceInFrame?: number; }) { const args = { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields }; const result = await call(name, args) as FixtureTimeline; assert.equal(result.revision, timeline.revision + 1); timeline = (result as unknown as typeof timeline); history.push({ name, args, result }); return result; }
  await mutate('timeline_track_add', { kind: 'video', name: 'MCP Overlay' });
  const addedTrack = timeline.tracks.at(-1), firstVideo = timeline.tracks.find((track) => track.kind === 'video'), audioTrack = timeline.tracks.find((track) => track.kind === 'audio');
  await mutate('timeline_track_update', { trackId: (addedTrack)!.id, patch: { name: 'SDK Overlay', hidden: false, muted: false } });
  await mutate('timeline_clip_add', { trackId: (firstVideo)!.id, assetId: image.id, startFrame: 0, durationFrames: 30 });
  const visualId = timeline.clips[0].id;
  await mutate('timeline_clip_update', { clipId: visualId, patch: { trackId: (addedTrack)!.id, startFrame: 7, durationFrames: 23, rect: { x: 100, y: 200, width: 400, height: 600 } } });
  for (const [index, asset] of audioAssets.entries()) await mutate('timeline_clip_add', { trackId: (audioTrack)!.id, assetId: asset.id, startFrame: index * 10, durationFrames: 10, sourceInFrame: index });
  const audioId = (timeline.clips.find((clip) => clip.assetId === audioAssets[0].id))!.id;
  await mutate('timeline_clip_remove', { clipId: audioId });
  const beforeInvalid = await call('timeline_get', { projectId });
  await invalid('timeline_get', { projectId, extraneous: true });
  await invalid('timeline_clip_update', { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: visualId, patch: { assetId: image.id } });
  await invalid('timeline_track_update', { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), trackId: (firstVideo)!.id, patch: { name: 'No write', unexpected: true } });
  await invalid('timeline_clip_add', { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), trackId: (firstVideo)!.id, assetId: image.id, startFrame: 1.1, durationFrames: 2 });
  await invalid('timeline_clip_update', { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), clipId: visualId, patch: { rect: { x: 0, y: 0, width: 100, height: 100, rotation: 90 } } });
  assert.deepEqual(await call('timeline_get', { projectId }), beforeInvalid);
  assert.deepEqual(await http('timeline.get', { projectId }), timeline, 'SDK writes must be visible via HTTP');
  assert.deepEqual(await http('project.get', { projectId }), await call('project_get', { projectId }), 'HTTP UI model is exactly MCP model');
  const duplicateArgs = { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), trackId: (addedTrack)!.id, patch: { name: 'One concurrent update' } };
  const responses = await Promise.all(Array.from({ length: 12 }, () => call('timeline_track_update', duplicateArgs)));
  for (const response of responses) assert.deepEqual(response, responses[0]); timeline = responses[0];
  assert.equal(timeline.revision, beforeInvalid.revision + 1);
  history.push({ name: 'timeline_track_update', args: duplicateArgs, result: timeline });
  await call('timeline_track_update', { ...duplicateArgs, patch: { name: 'Input conflict' } }, 'IDEMPOTENCY_CONFLICT');
  await call('timeline_track_add', { projectId, expectedRevision: duplicateArgs.expectedRevision, requestId: duplicateArgs.requestId, kind: 'video' }, 'IDEMPOTENCY_CONFLICT');
  await call('timeline_track_update', { ...duplicateArgs, requestId: randomUUID() }, 'REVISION_CONFLICT');
  const renderArgs = { projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'preview' };
  const queued = await call('timeline_render', renderArgs); assert.equal(queued.mode, 'timeline'); assert.equal(queued.timelineRevision, timeline.revision); assert.equal(queued.purpose, 'preview');
  assert.deepEqual(queued.snapshot.timeline, timeline);
  let rendered; const renderDeadline = Date.now() + 40_000;
  do { rendered = await call('export_get', { exportId: queued.id }); if (['succeeded', 'failed'].includes(rendered.status)) break; await pause(100); } while (Date.now() < renderDeadline);
  assert.equal(rendered.status, 'succeeded', JSON.stringify(rendered));
  assert.deepEqual(await call('timeline_render', renderArgs), queued, 'render replay remains the original queued response even after success');
  const firstPid = backend.pid; const preRestart = await call('project_get', { projectId });
  await stop(); await start(); assert.notEqual(backend.pid, firstPid, 'a new HTTP process actually started');
  assert.deepEqual(await call('project_get', { projectId }), preRestart, 'backend process restart preserves project, tracks, clips, imported media, and completed render');
  for (const item of history) assert.deepEqual(await call(item.name, item.args), item.result, `${item.name} exact original replay survives actual backend restart`);
  assert.deepEqual(await call('timeline_render', renderArgs), queued);
  assert.deepEqual(await http('timeline.get', { projectId }), timeline);
  const mediaResponse = await fetch(base + rendered.url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=0-31' } });
  assert.equal(mediaResponse.status, 206); assert.equal((await mediaResponse.arrayBuffer()).byteLength, 32);
  const publicState = JSON.stringify(await call('project_get', { projectId }));
  assert.ok(!publicState.includes(root)); assert.ok(!publicState.includes('relativePath')); assert.ok(!publicState.includes('requestHash')); assert.ok(!publicState.includes(token));
  // A real generated mock version proves timeline_seed works through the SDK,
  // not merely through injected store rows or a private service helper.
  const seededProject = await call('project_create', { name: 'SDK explicit seed' });
  const reference = await call('asset_import', { projectId: seededProject.id, name: 'seed.png', mimeType: 'image/png', dataBase64: (await readFile(imageFile)).toString('base64') });
  const shot = await call('shot_create', { projectId: seededProject.id, title: 'Explicitly seeded shot', referenceAssetIds: [reference.id], duration: 2 });
  const generated = await call('generation_submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock' });
  let generation; const jobDeadline = Date.now() + 40_000;
  do { generation = await call('job_get', { jobId: generated.id }); if (['succeeded', 'failed'].includes(generation.status)) break; await pause(100); } while (Date.now() < jobDeadline);
  assert.equal(generation.status, 'succeeded', JSON.stringify(generation));
  const empty = await call('timeline_get', { projectId: seededProject.id }); assert.equal(empty.clips.length, 0, 'generation must not silently populate the timeline');
  const seedArgs = { projectId: seededProject.id, expectedRevision: empty.revision, requestId: randomUUID() };
  const seeded = await call('timeline_seed', seedArgs); assert.equal(seeded.clips.length, 1); assert.equal(seeded.clips[0].durationFrames, 60);
  assert.deepEqual(await call('timeline_seed', seedArgs), seeded); assert.deepEqual((await http('project.get', { projectId: seededProject.id })).timeline, seeded);
  assert.ok(traffic.some(item => item.direction === 'client-to-server' && (item.message as {method?:string}).method === 'initialize'));
  assert.ok(traffic.some(item => item.direction === 'client-to-server' && (item.message as {method?:string}).method === 'notifications/initialized'));
  for (const name of requiredTools) assert.ok(traffic.some(item => item.direction === 'client-to-server' && (item.message as {method?:string}).method === 'tools/call' && (item.message as unknown as {params:{name:string}}).params.name === name), `${name} ran on actual wire`);
  (report as typeof report & {result:("passed")}).result = 'passed'; report.checks.push((({ name: 'durable SDK/HTTP parity, concurrency and every timeline tool', result: 'passed', projectId, timelineId: timeline.id, timelineRevision: timeline.revision, exactReplayCount: history.length + 1, syntheticAudioFormats: audioAssets.map(asset => asset.mimeType), renderId: rendered.id, seedTimelineId: seeded.id }) as unknown as Parameters<typeof report.checks.push>[0]));
  await writeFile(path.join(evidence, 'project-state.json'), JSON.stringify(preRestart, null, 2));
  t.diagnostic(`All 8 timeline tools called through actual official SDK wire; ${history.length + 1} saved responses replayed after backend restart`);
});

import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient, discoverSchema} from '@mioon/client';
import {operationEffect} from '@mioon/contracts';
import {AUDIO_PREVIEW_PROFILE} from '@mioon/contracts/timeline-audio-preview';
import {startServer} from '../apps/server/src/index.ts';
import {continuousAudioQuery, CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_PROFILE} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {onMediaProcess, hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {TIMELINE_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

const execute = promisify(execFile), operation = 'timeline.audioPreview.continuousPlan';
const repo = fileURLToPath(new URL('..', import.meta.url)), token = 'synthetic-continuous-audio-transport-token';
function wav(): Buffer {
  const frames = 9600, data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28);
  data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let index = 0; index < frames; index++) {data.writeInt16LE(8192, 44 + index * 4); data.writeInt16LE(-8192, 46 + index * 4);}
  return data;
}

interface LocalDefinition {inputSchema: {required: string[]; additionalProperties: unknown}; [key: string]: unknown}
interface TimelineWire {id: string; revision: number; tracks: Array<{id: string; kind: string}>}
interface PlanWire {schemaVersion?: number; profileId?: string; durationFrames?: number; planHash: string; [key: string]: unknown}
interface LegacyPlanWire {planHash: string; sources: Array<{clipId: string; sourceHash: string; pcmBytes: number; sampleFrames: number}>}
test('real HTTP RPC, CLI and official MCP expose the same strict read-only continuous plan and authenticated mixed PCM', {timeout: 60000}, async (t: TestContext) => {
  const root = await realpath(mkdtempPortable('mioon-continuous-wire-'));
  let backend: Awaited<ReturnType<typeof startServer>> | undefined, mcp: Client | undefined;
  t.after(async () => {await mcp?.close(); await backend?.close(); await rm(root, {recursive: true, force: true});});
  backend = await startServer({dataDir: root, port: 0, token, chatGateway: async function* () {throw Error('No model call permitted');}});
  const env = {...mediaEnvironment(), MIOON_BASE_URL: backend.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'};
  const client = createClient({env}), project = await client.rpc('project.create', {name: 'Synthetic continuous transport'}) as {id: string};
  let timeline = await client.rpc('timeline.get', {projectId: project.id}) as TimelineWire;
  const asset = await client.rpc('asset.import', {projectId: project.id, name: 'Controlled opposite channels.wav', mimeType: 'audio/wav', dataBase64: wav().toString('base64')}) as {id: string};
  timeline = await client.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio')!.id, assetId: asset.id, startFrame: 0, durationFrames: 3,
    sourceInFrame: 0, gain: 0.5, fadeInFrames: 1, fadeOutFrames: 1});
  const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, startFrame: 0};
  const events: Array<{kind?: string; type?: string}> = [], off = onMediaProcess((event: {kind?: string; type?: string}) => events.push(event)); t.after(off);
  const definition = discoverSchema({operation}) as unknown as LocalDefinition;
  assert.deepEqual(definition.inputSchema.required, ['projectId', 'timelineId', 'expectedRevision', 'startFrame']);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(operationEffect(operation).readOnly, true); assert.equal(operationEffect(operation).localProcess, false);
  for (const tools of [READ_TOOL_DEFINITIONS, EDIT_TOOL_DEFINITIONS, TIMELINE_EDIT_TOOL_DEFINITIONS, TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS])
    assert.ok(tools.every(tool => !/audioPreview|audio_preview|audition/i.test(tool.name)), 'No built-in Agent execution authority');
  const plan = await client.rpc(operation, input) as PlanWire;
  assert.equal(plan.schemaVersion, 2); assert.equal(plan.profileId, CONTINUOUS_AUDIO_PROFILE); assert.equal(plan.durationFrames, 3);
  const cli = await execute(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)],
    {cwd: repo, env, timeout: 15000, maxBuffer: 1024 * 1024});
  assert.deepEqual(JSON.parse(cli.stdout), {ok: true, data: plan});
  mcp = new Client({name: 'continuous-audio-test', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env, stderr: 'pipe'});
  let stderr = ''; (transport.stderr as unknown as {setEncoding(encoding: string): {on(event: string, listener: (chunk: string) => void): void}} | null)?.setEncoding('utf8').on('data', (value: string) => {stderr += value;});
  await mcp.connect(transport);
  const tool = (await mcp.listTools()).tools.find(value => value.name === 'timeline_audioPreview_continuousPlan');
  assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
  const result = await mcp.callTool({name: tool.name, arguments: input}, undefined, {timeout: 15000});
  assert.deepEqual(result.structuredContent, {ok: true, data: plan});
  assert.deepEqual(events, [], 'Planning/discovery do not probe or decode');
  assert.ok(!JSON.stringify(plan).includes(root)); assert.ok(!stderr.includes(token));
  const block = {...input, planHash: plan.planHash, sessionId: randomUUID(), generation: 3, sequence: 5, blockStartFrame: 0};
  const endpoint = `${backend.url}${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(block)}`;
  const denied = await fetch(endpoint); assert.equal(denied.status, 401); await denied.arrayBuffer();
  const response = await fetch(endpoint, {headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-mioon-audio-profile'), CONTINUOUS_AUDIO_PROFILE);
  const pcm = Buffer.from(await response.arrayBuffer()); assert.equal(pcm.length, 3 * 12800);
  for (let sample = 0; sample < 4800; sample++) {
    const fade = sample < 1600 ? sample / 1600 : sample >= 3200 ? (4800 - sample) / 1600 : 1;
    assert.ok(Math.abs(pcm.readFloatLE(sample * 8) - 0.125 * fade) < 2e-6);
    assert.ok(Math.abs(pcm.readFloatLE(sample * 8 + 4) + 0.125 * fade) < 2e-6);
  }
  assert.equal(events.filter((event: {kind?: string; type?: string}) => event.kind === 'ffmpeg' && event.type === 'started').length, 1);
  const legacyPlan = await client.rpc('timeline.audioPreview.plan', input) as LegacyPlanWire;
  const legacySource = legacyPlan.sources[0];
  const legacyInput = {...input, clipId: legacySource.clipId, sourceHash: legacySource.sourceHash, planHash: legacyPlan.planHash};
  const legacyEndpoint = `${backend.url}/api/timeline-audio-preview/pcm?${new URLSearchParams(legacyInput as unknown as Record<string, string>)}`;
  await t.test('the real service facade keeps V1 busy until the continuous session retires', async () => {
    const busy = await fetch(legacyEndpoint, {headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).error.code, 'AUDIO_PREVIEW_BUSY');
    assert.equal(events.filter((event: {kind?: string; type?: string}) => event.kind === 'ffmpeg' && event.type === 'started').length, 1,
      'Rejected legacy work must not start another decoder');
  });
  const deleted = await fetch(endpoint, {method: 'DELETE', headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).status, 'retired');
  await t.test('retirement reopens V1 with its original pre-gain and pre-fade PCM semantics', async () => {
    const legacy = await fetch(legacyEndpoint, {headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
    assert.equal(legacy.status, 200); assert.equal(legacy.headers.get('x-mioon-audio-profile'), AUDIO_PREVIEW_PROFILE);
    const raw = Buffer.from(await legacy.arrayBuffer()); assert.equal(raw.length, legacySource.pcmBytes);
    for (let sample = 0; sample < legacySource.sampleFrames; sample++) {
      assert.equal(raw.readFloatLE(sample * 8), 0.25);
      assert.equal(raw.readFloatLE(sample * 8 + 4), -0.25);
    }
    assert.equal(events.filter((event: {kind?: string; type?: string}) => event.kind === 'ffmpeg' && event.type === 'started').length, 2);
  });
  assert.equal(hasUnconfirmedMediaProcesses(), false);
});

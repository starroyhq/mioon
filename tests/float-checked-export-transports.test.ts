import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {TransportCall,EnvelopeTransportCall} from './helpers/strict-timeline-transport-types.ts';
import type {WireResult} from './helpers/strict-timeline-transport-types.ts';
import type {ServiceResponse} from './helpers/strict-service-responses.ts';
import type {CliResult,McpData,TestTool,SchemaNode} from './helpers/strict-timeline-transport-types.ts';
import type {TestCatalog as DiscoverySchemaResult} from './helpers/strict-timeline-transport-types.ts';
import type {TestOperationDefinition as OperationDefinition} from './helpers/strict-timeline-transport-types.ts';
import type {SelectedRangeFixtureFactory,SelectedRangeFixture} from './helpers/strict-timeline-selected-range-types.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {discoverSchema, effectAnnotations} from '@mioon/client';
import {isExportPreflightResponse, isTimelineMutationResponse, publicValue} from '@mioon/contracts';
import {hash} from '../packages/business/src/services.ts';
import {claimFloatTimelineExport, bindFloatTimelineMeasurement} from '../packages/business/src/timeline-float-outcome.ts';
import {createTimelineFloatAudioAccumulator} from '../packages/business/src/timeline-float-audio-check.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {selectedRangeFixture, TOKEN, RANGE, SETTINGS, bounded, authority, action} from './fixtures/selected-range-http-fixture.ts';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = (url?: string|undefined) => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  ...(url ? {MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN} : {})});
const safe = (value: string) => {assert.equal(JSON.stringify(value).includes(TOKEN), false); assert.equal(JSON.stringify(value).includes('Bearer '), false);};

function launchCli(t: { after: (arg0: () => Promise<void>) => void; }, url: string|undefined, args: string[]) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...args], {cwd: repo, env: ((env(url)) as unknown as NodeJS.ProcessEnv | undefined), stdio: ['ignore', 'pipe', 'pipe'], shell: false});
  let stdout = '', stderr = '', bytes = 0, failure!: Error;
  const ended = new Promise<{ code: number | null | undefined; signal: NodeJS.Signals | null | undefined; }>(resolve => child.once('close', (code?, signal?) => resolve({code, signal})));
  child.once('error', (error?) => {failure = (error as unknown as typeof failure);});
  // Two runtime streams, one audited registration site. Both are decoded
  // continuously before any listener sees Chinese or emoji output chunks.
  for (const [stream, append] of ([[child.stdout, (part: string) => {stdout += part;}], [child.stderr, (part: string) => {stderr += part;}]] as const)) {
    stream.setEncoding('utf8').on('data', (part: string|ArrayBufferLike|NodeJS.ArrayBufferView<ArrayBufferLike>) => {
      bytes += Buffer.byteLength(part);
      if (bytes > 4 * 1024 * 1024) {failure = Error('Bounded CLI output exceeded'); child.kill('SIGKILL'); return;}
      append(((part) as unknown as StrictIntersection<Parameters<NonNullable<typeof append>>[0]>));
    });
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(ended, 'Owned CLI cleanup');
  });
  return {child, async finish() {
    const outcome = await bounded(ended, 'Actual CLI result', 33_000); clearTimeout(timer);
    if (failure) throw failure;
    assert.equal((outcome.signal as unknown), null, stderr); safe(stdout); safe(stderr);
    assert.equal(stdout.trim().split('\n').length, 1, 'one actual CLI JSON envelope');
    const body = JSON.parse(stdout); assert.equal(outcome.code === 0, body.ok, stdout + stderr);
    return {body, ...outcome};
  }};
}
const cli = async (t: test.TestContext, url: string|undefined, args: string[]) => (await launchCli(t, url, args).finish()).body;
async function officialMcp(t: test.TestContext, url?: string|undefined) {
  const client = new Client({name: 'float-checked-official-sdk', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: ((env(url)) as unknown as Record<string, string> | undefined), stderr: 'pipe'});
  let stderr = '', overflow = false, closing;
  const close = () => closing ??= bounded(client.close(), 'Official MCP close', 8000);
  // SDK-owned stdout remains binary framed protocol data; only stderr is ours.
  (transport.stderr as import('node:stream').Readable|null)?.setEncoding('utf8').on('data', (part: string) => {
    stderr += part;
    if (Buffer.byteLength(stderr) > 64 * 1024) {overflow = true; void close().catch(() => {});}
  });
  t.after(async () => {await close(); assert.equal(overflow, false); safe(stderr); assert.equal((transport.pid as unknown), null);});
  await bounded(client.connect(transport), 'Official MCP initialization');
  return {client, async call(operation: string, input: {}, options: RequestOptions|undefined = {}) {
    const result = (await client.callTool({name: operation === 'mioon_schema' ? operation : operation.replaceAll('.', '_'), arguments: input}, undefined, {timeout: 15_000, ...options}) as CallToolResult);
    const blocks = result.content.filter((block) => block.type === 'text'); assert.equal(blocks.length, 1);
    const body = JSON.parse(blocks[0].text); assert.deepEqual(result.structuredContent, body); assert.equal(Boolean(result.isError), !body.ok);
    safe(body); return body;
  }};
}
async function transports(t: test.TestContext, f: SelectedRangeFixture) {
  const mcp = await officialMcp(t, ((f.url) as unknown as Parameters<typeof officialMcp>[1]));
  return {mcp, all: [{name: 'HTTP', call: ((((operation?: unknown, input?: unknown) => (f.rpc(((operation) as unknown as Parameters<NonNullable<(typeof f)["rpc"]>>[0]), input))) as EnvelopeTransportCall))},
    {name: 'CLI', call: (((<O extends string,E extends string|undefined=undefined>(operation:O, input?:unknown) => ((cli(t, ((f.url) as unknown as Parameters<typeof cli>[1]), [...operation.split('.'), '--input', JSON.stringify(input)]) as Promise<WireResult<ServiceResponse<O>,E>>))) as EnvelopeTransportCall))},
    {name: 'MCP', call: (mcp.call as EnvelopeTransportCall)}]};
}

const PROFILE = 'mp4_h264_float_checked_v2';
const settings = () => ({...structuredClone(SETTINGS), profileId: PROFILE});

test('float profile has identical complete offline CLI and official MCP discovery with no new Agent tool', {timeout: 45_000}, async t => {
  const catalog = (discoverSchema() as DiscoverySchemaResult), mcp = await officialMcp(t);
  assert.deepEqual((await cli(t, undefined, ['schema'])).data, catalog);
  assert.deepEqual((await mcp.call('mioon_schema', {})).data, catalog);
  const tools = ((await mcp.client.listTools() as {tools:TestTool[]})).tools;
  for (const operation of (['timeline.render', 'timeline.export.preflight', 'timeline.export.capabilities'] as const)) {
    const definition = (discoverSchema({operation}) as OperationDefinition), tool = tools.find(value => value.name === operation.replaceAll('.', '_'));
    assert.deepEqual((tool)!.inputSchema, definition.inputSchema);
    assert.deepEqual((tool)!.annotations, effectAnnotations(definition.effects));
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(JSON.stringify(definition.inputSchema).includes(PROFILE));
    for (const field of (['renderAttemptId', 'attemptId', 'audioCheck', 'measurement', 'output'] as const)) {
      assert.equal(Object.hasOwn(((definition.inputSchema.properties) as unknown as Parameters<NonNullable<(typeof Object)["hasOwn"]>>[0]), field), false, field);
    }
    assert.equal(definition.effects.paidGeneration, false);
    assert.deepEqual((await cli(t, undefined, ['schema', operation])).data, definition);
  }
  assert.equal(catalog.operations.some((value) => /float.*(?:submit|retry)|audioCheck|renderAttempt/.test(value.operation)), false);
});

test('actual HTTP CLI MCP reject caller report/attempt authority, extra audio controls and preview v2 before effects', {timeout: 90_000}, async t => {
  const f = await (selectedRangeFixture(t) as unknown as ReturnType<SelectedRangeFixtureFactory>), wire = await transports(t, f);
  const base = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportSettings: settings()};
  const before = await f.checkpoint();
  for (const transport of wire.all) {
    for (const patch of ([{audioCheck: {}}, {renderAttemptId: randomUUID()}, {attemptId: randomUUID()}, {measurement: {peakLinear: 0}},
      {snapshotSha256: 'a'.repeat(64)}, {output: {assetId: randomUUID(), sha256: 'b'.repeat(64)}},
      {exportSettings: {...settings(), limiter: true}}, {exportSettings: {...settings(), profileId: 'mp4_h264_float_checked_v3'}},
      {exportSettings: {...settings(), rateControl: {...settings().rateControl, gain: 0.5}}}] as const)) {
      for (const [operation, input] of ([['timeline.export.preflight', {...base, ...patch}],
        ['timeline.export.capabilities', {...base, ...patch}],
        ['timeline.render', {...base, requestId: randomUUID(), purpose: 'export', ...patch}]] as const)) {
        const result = await transport.call(((((operation) as unknown as Parameters<typeof transport.call>[0])) as unknown as StrictIntersection<Parameters<NonNullable<(typeof transport)["call"]>>[0]>), input);
        assert.equal(result.ok, false, `${transport.name} ${operation}`);
        assert.equal(result.error.code, 'VALIDATION_ERROR', JSON.stringify(result));
      }
    }
    const preview = await transport.call('timeline.render', {...base, requestId: randomUUID(), purpose: 'preview'});
    assert.equal(preview.error.code, 'VALIDATION_ERROR');
  }
  await f.unchanged(before); assert.deepEqual((f.media as unknown), []); assert.deepEqual((f.capabilityChecks as unknown), []);
});

test('actual transports bind v2 profile/name/range preflight and preserve original lost-ACK bytes after revision drift', {timeout: 120_000}, async t => {
  const f = await (selectedRangeFixture(t) as unknown as ReturnType<SelectedRangeFixtureFactory>), wire = await transports(t, f), accepted = [];
  for (const transport of wire.all) {
    const checkInput = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportSettings: settings(),
      deliveryName: `Float ${transport.name} 🎬`, exportRange: {...RANGE}};
    const before = await f.checkpoint(), checks = f.capabilityChecks.length;
    const report = await transport.call('timeline.export.preflight', checkInput);
    assert.equal(report.ok, true); assert.equal(report.data.status, 'ready');
    assert.equal(isExportPreflightResponse(report.data, checkInput), true);
    assert.equal((report.data.summary)!.delivery!.exportSettings.profileId, PROFILE);
    assert.equal(Object.hasOwn(report.data, 'audioCheck'), false, 'source ready is not an audio measurement');
    assert.equal(f.capabilityChecks.length, checks, 'source preflight does not prove the float encoder');
    await f.unchanged(before);
    const input = {...checkInput, requestId: randomUUID(), purpose: 'export', preflightSnapshotHash: report.data.snapshotHash};
    for (const patch of ([{exportSettings: {...settings(), profileId: 'mp4_h264_v1'}}, {deliveryName: 'Changed'}, {exportRange: {startFrame: 13, endFrame: 45}}] as const)) {
      const stale = await transport.call('timeline.render', {...input, ...patch});
      assert.equal(stale.ok, false); assert.equal(stale.error.code, 'PREFLIGHT_STALE');
    }
    await f.unchanged(before);
    f.lose('/api/rpc'); const submissions = f.submissions.length;
    if (transport.name === 'HTTP') await assert.rejects(transport.call('timeline.render', input));
    else assert.equal((await transport.call('timeline.render', input)).error.details.submissionMayHaveSucceeded, true);
    assert.equal(f.submissions.length, submissions + 1, 'no retry after the lost acknowledgement');
    const original = (f.observations.at(-1))!.body as import('./helpers/strict-timeline-transport-types.ts').RpcEnvelope<import('./helpers/strict-timeline-core-types.ts').FixtureExport>, receipt = f.receipt(input.requestId);
    assert.equal(original.ok, true); assert.equal(isTimelineMutationResponse('timeline.render', input, original.data), true);
    for (const field of (['renderAttemptId', 'audioCheck'] as const)) assert.equal(Object.hasOwn(original.data, field), false);
    assert.deepEqual(publicValue(JSON.parse((((receipt)!.response) as unknown as Parameters<NonNullable<(typeof JSON)["parse"]>>[0]))), original.data);
    assert.equal((receipt)!.requestHash, hash({operation: 'timeline.render', input}));
    assert.deepEqual(await transport.call('timeline.render', input), original);
    accepted.push({input, original, receipt});
  }
  await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(),
    clipId: f.timeline.clips[0].id, patch: {name: 'Later edit'}});
  await f.restart();
  const reopened = await transports(t, f), before = await f.checkpoint(), checks = f.capabilityChecks.length, media = f.media.length;
  for (const {input, original, receipt} of accepted) for (const transport of reopened.all) {
    assert.deepEqual(await transport.call('timeline.render', input), original);
    const conflict = await transport.call('timeline.render', {...input, exportSettings: {...settings(), profileId: 'mp4_h264_v1'}});
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await transport.call('timeline.render', {...input, requestId: randomUUID()})).error.code, 'REVISION_CONFLICT');
    assert.deepEqual(f.receipt(input.requestId), receipt);
  }
  assert.equal(f.capabilityChecks.length, checks); assert.equal(f.media.length, media); await f.unchanged(before); await f.assertNoWorker();
});

test('durable private delivery intent binds exact v2 input and blocks profile replacement across lost ACK and restart', {timeout: 60_000}, async t => {
  const f = await (selectedRangeFixture(t) as unknown as ReturnType<SelectedRangeFixtureFactory>), initial = await f.local();
  const saved = await f.local('/draft', {...authority(((initial) as unknown as Parameters<NonNullable<typeof authority>>[0])), expectedDraftRevision: initial.draftRevision, draftId: randomUUID(),
    timelineId: f.timeline.id, baseRevision: f.timeline.revision, raw: {deliveryName: 'Frozen float delivery 🎬'}});
  const prepare = f.prepare(saved, {exportSettings: settings()}), pending = await f.local('/prepare', prepare);
  assert.equal((pending.intent)!.outcome.status, 'pending'); assert.deepEqual((pending.intent)!.input, prepare.input);
  const bytes = await readFile(f.file), state = await f.checkpoint();
  const changed = {...f.prepare(pending, {exportSettings: structuredClone(SETTINGS)}), intentId: randomUUID()};
  const refusal = await f.request('/api/local-delivery/prepare', {method: 'POST', input: changed});
  assert.equal(refusal.status, 409); assert.deepEqual(await readFile(f.file), bytes); await f.unchanged(state);
  f.lose('/api/local-delivery/execute'); await assert.rejects(f.local('/execute', action(((pending) as unknown as Parameters<NonNullable<typeof action>>[0]))));
  const accepted = ((f.observations.at(-1))!.body as import('./helpers/strict-timeline-transport-types.ts').RpcEnvelope<import('./helpers/strict-timeline-selected-range-types.ts').DeliveryExecution>).data, receipt = f.receipt(prepare.input.requestId);
  assert.equal((accepted.response)!.snapshot.delivery!.exportSettings.profileId, PROFILE);
  assert.equal(f.dispatches.length, 1); assert.deepEqual(f.dispatches[0], prepare.input);
  await f.restart(); const reopened = await f.local();
  assert.deepEqual((reopened.intent)!.input, prepare.input); assert.equal((reopened.intent)!.intentId, (pending.intent)!.intentId);
  const recovered = await f.local('/recover', action(((reopened) as unknown as Parameters<NonNullable<typeof action>>[0])));
  assert.deepEqual(recovered.response, accepted.response); assert.deepEqual(f.receipt(prepare.input.requestId), receipt);
  assert.equal(f.dispatches.length, 1); assert.equal(f.store.list('exports').length, 1); await f.assertNoWorker();
});

test('HTTP CLI MCP expose one bounded terminal report while exact ACK remains queued; clients refuse tampered wire report', {timeout: 60_000}, async t => {
  const f = await (selectedRangeFixture(t) as unknown as ReturnType<SelectedRangeFixtureFactory>), input = {projectId: f.project.id, expectedRevision: f.timeline.revision,
    requestId: randomUUID(), purpose: 'export', exportSettings: settings(), exportRange: {...RANGE}};
  const accepted = await f.services.call('timeline.render', input), receipt = f.receipt(input.requestId);
  const claim = claimFloatTimelineExport(f.store.get('exports', accepted.id), new Date().toISOString());
  const accumulator = createTimelineFloatAudioAccumulator(RANGE.endFrame - RANGE.startFrame);
  const pcm = Buffer.alloc((RANGE.endFrame - RANGE.startFrame) * 1600 * 8);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(1.4, offset);
  accumulator.write(pcm);
  const failed = f.store.put('exports', {...claim, status: 'failed', audioCheck: bindFloatTimelineMeasurement(claim, accumulator.finish(), new Date().toISOString()),
    error: {code: 'EXPORT_AUDIO_OVER_RANGE', message: 'Lower the saved gains and request a new export.', retryable: false}});
  const wire = await transports(t, f), before = await f.checkpoint();
  for (const transport of wire.all) {
    const current = await transport.call('export.get', {exportId: accepted.id}) as import('./helpers/strict-timeline-transport-types.ts').RpcEnvelope<FixtureExport>;
    assert.equal(current.ok, true); assert.deepEqual(current.data, publicValue(failed));
    assert.equal((current.data.audioCheck)!.attemptId, current.data.renderAttemptId);
    assert.equal(((current.data.audioCheck)!.output as unknown), null); assert.ok((current.data.audioCheck)!.measurement!.peakLinear > 1);
    assert.deepEqual((await transport.call('timeline.render', input)).data, accepted);
  }
  let mutate = (value?: unknown) => value, submissions = 0;
  const proxy = http.createServer(async (request, response) => {
    try {
      const parts = []; let bytes = 0;
      for await (const part of request) {bytes += part.length; if (bytes > 32768) throw Error('Fixture request bound'); parts.push(part);}
      submissions++;
      const upstream = await fetch(f.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        body: Buffer.concat(parts), signal: AbortSignal.timeout(15_000)});
      const body = await upstream.json(); response.writeHead(upstream.status, {'content-type': 'application/json'});
      response.end(JSON.stringify(body.ok ? {ok: true, data: mutate(body.data)} : body));
    } catch {response.destroy();}
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve as ()=>void));
  t.after(async () => {proxy.closeAllConnections(); await bounded(new Promise(resolve => proxy.close(resolve)), 'Report proxy close');});
  const url = `http://127.0.0.1:${((proxy.address() as import('node:net').AddressInfo))!.port}`, mcp = await officialMcp(t, url);
  for (const call of ([<O extends string,E extends string|undefined=undefined>(operation:O, value?:unknown) => (cli(t, url, [...operation.split('.'), '--input', JSON.stringify(value)]) as Promise<WireResult<ServiceResponse<O>,E>>), mcp.call] as const)) {
    for (const mutation of ([(value: { audioCheck: unknown; }) => {delete value.audioCheck; return value;}, (value: { audioCheck: { attemptId: string; }; }) => {value.audioCheck.attemptId = randomUUID(); return value;},
(      value: { audioCheck: { measurement: { peakLinear: number; }; }; }) => {value.audioCheck.measurement.peakLinear = 0; return value;}, (value: { audioCheck: { path: string; }; }) => {value.audioCheck.path = '/private/forged'; return value;}] as const)) {
      mutate = (mutation as unknown as typeof mutate); const count = submissions;
      const result = await call('export.get', {exportId: accepted.id});
      assert.equal(result.ok, false); assert.equal(result.error.code, 'BACKEND_PROTOCOL_ERROR', JSON.stringify(result));
      assert.equal(submissions, count + 1, 'strict current-outcome refusal never retries');
    }
  }
  assert.deepEqual(f.receipt(input.requestId), receipt); await f.unchanged(before);
  assert.deepEqual((f.media as unknown), [], 'terminal row observation never starts media');
});

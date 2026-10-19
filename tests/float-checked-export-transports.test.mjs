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
import {selectedRangeFixture, TOKEN, RANGE, SETTINGS, bounded, authority, action} from './fixtures/selected-range-http-fixture.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = url => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  ...(url ? {MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN} : {})});
const safe = value => {assert.equal(JSON.stringify(value).includes(TOKEN), false); assert.equal(JSON.stringify(value).includes('Bearer '), false);};

function launchCli(t, url, args) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...args], {cwd: repo, env: env(url), stdio: ['ignore', 'pipe', 'pipe'], shell: false});
  let stdout = '', stderr = '', bytes = 0, failure;
  const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.once('error', error => {failure = error;});
  // Two runtime streams, one audited registration site. Both are decoded
  // continuously before any listener sees Chinese or emoji output chunks.
  for (const [stream, append] of [[child.stdout, part => {stdout += part;}], [child.stderr, part => {stderr += part;}]]) {
    stream.setEncoding('utf8').on('data', part => {
      bytes += Buffer.byteLength(part);
      if (bytes > 4 * 1024 * 1024) {failure = Error('Bounded CLI output exceeded'); child.kill('SIGKILL'); return;}
      append(part);
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
    assert.equal(outcome.signal, null, stderr); safe(stdout); safe(stderr);
    assert.equal(stdout.trim().split('\n').length, 1, 'one actual CLI JSON envelope');
    const body = JSON.parse(stdout); assert.equal(outcome.code === 0, body.ok, stdout + stderr);
    return {body, ...outcome};
  }};
}
const cli = async (t, url, args) => (await launchCli(t, url, args).finish()).body;
async function officialMcp(t, url) {
  const client = new Client({name: 'float-checked-official-sdk', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: env(url), stderr: 'pipe'});
  let stderr = '', overflow = false, closing;
  const close = () => closing ??= bounded(client.close(), 'Official MCP close', 8000);
  // SDK-owned stdout remains binary framed protocol data; only stderr is ours.
  transport.stderr?.setEncoding('utf8').on('data', part => {
    stderr += part;
    if (Buffer.byteLength(stderr) > 64 * 1024) {overflow = true; void close().catch(() => {});}
  });
  t.after(async () => {await close(); assert.equal(overflow, false); safe(stderr); assert.equal(transport.pid, null);});
  await bounded(client.connect(transport), 'Official MCP initialization');
  return {client, async call(operation, input, options = {}) {
    const result = await client.callTool({name: operation === 'mioon_schema' ? operation : operation.replaceAll('.', '_'), arguments: input}, undefined, {timeout: 15_000, ...options});
    const blocks = result.content.filter(block => block.type === 'text'); assert.equal(blocks.length, 1);
    const body = JSON.parse(blocks[0].text); assert.deepEqual(result.structuredContent, body); assert.equal(Boolean(result.isError), !body.ok);
    safe(body); return body;
  }};
}
async function transports(t, f) {
  const mcp = await officialMcp(t, f.url);
  return {mcp, all: [{name: 'HTTP', call: (operation, input) => f.rpc(operation, input)},
    {name: 'CLI', call: (operation, input) => cli(t, f.url, [...operation.split('.'), '--input', JSON.stringify(input)])},
    {name: 'MCP', call: mcp.call}]};
}

const PROFILE = 'mp4_h264_float_checked_v2';
const settings = () => ({...structuredClone(SETTINGS), profileId: PROFILE});

test('float profile has identical complete offline CLI and official MCP discovery with no new Agent tool', {timeout: 45_000}, async t => {
  const catalog = discoverSchema(), mcp = await officialMcp(t);
  assert.deepEqual((await cli(t, undefined, ['schema'])).data, catalog);
  assert.deepEqual((await mcp.call('mioon_schema', {})).data, catalog);
  const tools = (await mcp.client.listTools()).tools;
  for (const operation of ['timeline.render', 'timeline.export.preflight', 'timeline.export.capabilities']) {
    const definition = discoverSchema({operation}), tool = tools.find(value => value.name === operation.replaceAll('.', '_'));
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(definition.effects));
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(JSON.stringify(definition.inputSchema).includes(PROFILE));
    for (const field of ['renderAttemptId', 'attemptId', 'audioCheck', 'measurement', 'output']) {
      assert.equal(Object.hasOwn(definition.inputSchema.properties, field), false, field);
    }
    assert.equal(definition.effects.paidGeneration, false);
    assert.deepEqual((await cli(t, undefined, ['schema', operation])).data, definition);
  }
  assert.equal(catalog.operations.some(value => /float.*(?:submit|retry)|audioCheck|renderAttempt/.test(value.operation)), false);
});

test('actual HTTP CLI MCP reject caller report/attempt authority, extra audio controls and preview v2 before effects', {timeout: 90_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f);
  const base = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportSettings: settings()};
  const before = await f.checkpoint();
  for (const transport of wire.all) {
    for (const patch of [{audioCheck: {}}, {renderAttemptId: randomUUID()}, {attemptId: randomUUID()}, {measurement: {peakLinear: 0}},
      {snapshotSha256: 'a'.repeat(64)}, {output: {assetId: randomUUID(), sha256: 'b'.repeat(64)}},
      {exportSettings: {...settings(), limiter: true}}, {exportSettings: {...settings(), profileId: 'mp4_h264_float_checked_v3'}},
      {exportSettings: {...settings(), rateControl: {...settings().rateControl, gain: 0.5}}}]) {
      for (const [operation, input] of [['timeline.export.preflight', {...base, ...patch}],
        ['timeline.export.capabilities', {...base, ...patch}],
        ['timeline.render', {...base, requestId: randomUUID(), purpose: 'export', ...patch}]]) {
        const result = await transport.call(operation, input);
        assert.equal(result.ok, false, `${transport.name} ${operation}`);
        assert.equal(result.error.code, 'VALIDATION_ERROR', JSON.stringify(result));
      }
    }
    const preview = await transport.call('timeline.render', {...base, requestId: randomUUID(), purpose: 'preview'});
    assert.equal(preview.error.code, 'VALIDATION_ERROR');
  }
  await f.unchanged(before); assert.deepEqual(f.media, []); assert.deepEqual(f.capabilityChecks, []);
});

test('actual transports bind v2 profile/name/range preflight and preserve original lost-ACK bytes after revision drift', {timeout: 120_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f), accepted = [];
  for (const transport of wire.all) {
    const checkInput = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportSettings: settings(),
      deliveryName: `Float ${transport.name} 🎬`, exportRange: {...RANGE}};
    const before = await f.checkpoint(), checks = f.capabilityChecks.length;
    const report = await transport.call('timeline.export.preflight', checkInput);
    assert.equal(report.ok, true); assert.equal(report.data.status, 'ready');
    assert.equal(isExportPreflightResponse(report.data, checkInput), true);
    assert.equal(report.data.summary.delivery.exportSettings.profileId, PROFILE);
    assert.equal(Object.hasOwn(report.data, 'audioCheck'), false, 'source ready is not an audio measurement');
    assert.equal(f.capabilityChecks.length, checks, 'source preflight does not prove the float encoder');
    await f.unchanged(before);
    const input = {...checkInput, requestId: randomUUID(), purpose: 'export', preflightSnapshotHash: report.data.snapshotHash};
    for (const patch of [{exportSettings: {...settings(), profileId: 'mp4_h264_v1'}}, {deliveryName: 'Changed'}, {exportRange: {startFrame: 13, endFrame: 45}}]) {
      const stale = await transport.call('timeline.render', {...input, ...patch});
      assert.equal(stale.ok, false); assert.equal(stale.error.code, 'PREFLIGHT_STALE');
    }
    await f.unchanged(before);
    f.lose('/api/rpc'); const submissions = f.submissions.length;
    if (transport.name === 'HTTP') await assert.rejects(transport.call('timeline.render', input));
    else assert.equal((await transport.call('timeline.render', input)).error.details.submissionMayHaveSucceeded, true);
    assert.equal(f.submissions.length, submissions + 1, 'no retry after the lost acknowledgement');
    const original = f.observations.at(-1).body, receipt = f.receipt(input.requestId);
    assert.equal(original.ok, true); assert.equal(isTimelineMutationResponse('timeline.render', input, original.data), true);
    for (const field of ['renderAttemptId', 'audioCheck']) assert.equal(Object.hasOwn(original.data, field), false);
    assert.deepEqual(publicValue(JSON.parse(receipt.response)), original.data);
    assert.equal(receipt.requestHash, hash({operation: 'timeline.render', input}));
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
  const f = await selectedRangeFixture(t), initial = await f.local();
  const saved = await f.local('/draft', {...authority(initial), expectedDraftRevision: initial.draftRevision, draftId: randomUUID(),
    timelineId: f.timeline.id, baseRevision: f.timeline.revision, raw: {deliveryName: 'Frozen float delivery 🎬'}});
  const prepare = f.prepare(saved, {exportSettings: settings()}), pending = await f.local('/prepare', prepare);
  assert.equal(pending.intent.outcome.status, 'pending'); assert.deepEqual(pending.intent.input, prepare.input);
  const bytes = await readFile(f.file), state = await f.checkpoint();
  const changed = {...f.prepare(pending, {exportSettings: structuredClone(SETTINGS)}), intentId: randomUUID()};
  const refusal = await f.request('/api/local-delivery/prepare', {method: 'POST', input: changed});
  assert.equal(refusal.status, 409); assert.deepEqual(await readFile(f.file), bytes); await f.unchanged(state);
  f.lose('/api/local-delivery/execute'); await assert.rejects(f.local('/execute', action(pending)));
  const accepted = f.observations.at(-1).body.data, receipt = f.receipt(prepare.input.requestId);
  assert.equal(accepted.response.snapshot.delivery.exportSettings.profileId, PROFILE);
  assert.equal(f.dispatches.length, 1); assert.deepEqual(f.dispatches[0], prepare.input);
  await f.restart(); const reopened = await f.local();
  assert.deepEqual(reopened.intent.input, prepare.input); assert.equal(reopened.intent.intentId, pending.intent.intentId);
  const recovered = await f.local('/recover', action(reopened));
  assert.deepEqual(recovered.response, accepted.response); assert.deepEqual(f.receipt(prepare.input.requestId), receipt);
  assert.equal(f.dispatches.length, 1); assert.equal(f.store.list('exports').length, 1); await f.assertNoWorker();
});

test('HTTP CLI MCP expose one bounded terminal report while exact ACK remains queued; clients refuse tampered wire report', {timeout: 60_000}, async t => {
  const f = await selectedRangeFixture(t), input = {projectId: f.project.id, expectedRevision: f.timeline.revision,
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
    const current = await transport.call('export.get', {exportId: accepted.id});
    assert.equal(current.ok, true); assert.deepEqual(current.data, publicValue(failed));
    assert.equal(current.data.audioCheck.attemptId, current.data.renderAttemptId);
    assert.equal(current.data.audioCheck.output, null); assert.ok(current.data.audioCheck.measurement.peakLinear > 1);
    assert.deepEqual((await transport.call('timeline.render', input)).data, accepted);
  }
  let mutate = value => value, submissions = 0;
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
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {proxy.closeAllConnections(); await bounded(new Promise(resolve => proxy.close(resolve)), 'Report proxy close');});
  const url = `http://127.0.0.1:${proxy.address().port}`, mcp = await officialMcp(t, url);
  for (const call of [(operation, value) => cli(t, url, [...operation.split('.'), '--input', JSON.stringify(value)]), mcp.call]) {
    for (const mutation of [value => {delete value.audioCheck; return value;}, value => {value.audioCheck.attemptId = randomUUID(); return value;},
      value => {value.audioCheck.measurement.peakLinear = 0; return value;}, value => {value.audioCheck.path = '/private/forged'; return value;}]) {
      mutate = mutation; const count = submissions;
      const result = await call('export.get', {exportId: accepted.id});
      assert.equal(result.ok, false); assert.equal(result.error.code, 'BACKEND_PROTOCOL_ERROR', JSON.stringify(result));
      assert.equal(submissions, count + 1, 'strict current-outcome refusal never retries');
    }
  }
  assert.deepEqual(f.receipt(input.requestId), receipt); await f.unchanged(before);
  assert.deepEqual(f.media, [], 'terminal row observation never starts media');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {discoverSchema, effectAnnotations} from '@mioon/client';
import {isExportPreflightResponse, isTimelineMutationResponse, publicValue} from '@mioon/contracts';
import {hash} from '../packages/business/src/services.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {selectedRangeFixture, TOKEN, RANGE, SETTINGS, bounded} from './fixtures/selected-range-http-fixture.ts';

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
  const client = new Client({name: 'selected-range-official-sdk', version: '1.0.0'}, {capabilities: {}});
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

test('actual offline CLI and official MCP discover the same optional strict selected-range schema and unchanged operation effects', {timeout: 45_000}, async t => {
  const catalog = discoverSchema(), mcp = await officialMcp(t);
  assert.deepEqual((await cli(t, undefined, ['schema'])).data, catalog);
  assert.deepEqual((await mcp.call('mioon_schema', {})).data, catalog);
  const tools = (await mcp.client.listTools()).tools;
  for (const operation of ['timeline.render', 'timeline.export.preflight']) {
    const definition = discoverSchema({operation}), tool = tools.find(value => value.name === operation.replaceAll('.', '_'));
    assert.deepEqual(tool.inputSchema, definition.inputSchema); assert.deepEqual(tool.annotations, effectAnnotations(definition.effects));
    const schema = definition.inputSchema.properties.exportRange;
    assert.deepEqual(schema.required, ['startFrame', 'endFrame']); assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.startFrame.type, 'integer'); assert.equal(schema.properties.endFrame.type, 'integer');
    assert.equal(schema.properties.startFrame.minimum, 0); assert.equal(schema.properties.endFrame.maximum, 18000);
    assert.equal(definition.inputSchema.required.includes('exportRange'), false); assert.equal(definition.effects.paidGeneration, false);
    assert.deepEqual((await cli(t, undefined, ['schema', operation])).data, definition);
  }
  assert.equal(discoverSchema({operation: 'timeline.export.preflight'}).effects.readOnly, true);
  assert.equal(discoverSchema({operation: 'timeline.render'}).requiresRequestId, true);
  assert.equal(catalog.operations.some(value => /export.*cancel|timeline.*cancel/.test(value.operation)), false, 'no invented export cancellation operation');
});

test('real HTTP, CLI and official MCP preflight/render preserve exact range, full graph and immutable lost-ACK replay', {timeout: 120_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f), accepted = [];
  for (const [index, transport] of wire.all.entries()) {
    const checkInput = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportRange: {...RANGE}, ...(index === 1 ? {exportSettings: structuredClone(SETTINGS)} : {})};
    const beforeCheck = await f.checkpoint(), changes = f.store.db.prepare('SELECT total_changes() n').get().n;
    const checked = await transport.call('timeline.export.preflight', checkInput);
    assert.equal(checked.ok, true, JSON.stringify(checked)); assert.equal(checked.data.status, 'ready', JSON.stringify(checked));
    assert.equal(isExportPreflightResponse(checked.data, checkInput), true);
    assert.deepEqual(checked.data.summary.exportRange, RANGE); assert.equal(checked.data.summary.durationFrames, 120);
    assert.equal(checked.data.summary.clipCount, 2); assert.equal(checked.data.checks.totalAssets, 2); assert.equal(checked.data.checks.checkedAssets, 2);
    assert.equal(checked.data.checks.bytesHashed, f.sources.reduce((n, value) => n + value.sizeBytes, 0));
    await f.unchanged(beforeCheck); assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, changes, 'each transport preflight is read-only');
    const input = {...checkInput, requestId: randomUUID(), purpose: 'export', preflightSnapshotHash: checked.data.snapshotHash};
    f.lose('/api/rpc'); const start = f.submissions.length;
    if (transport.name === 'HTTP') await assert.rejects(transport.call('timeline.render', input));
    else {
      const lost = await transport.call('timeline.render', input); assert.equal(lost.ok, false); assert.equal(lost.error.details.submissionMayHaveSucceeded, true);
    }
    assert.equal(f.submissions.length, start + 1, 'lost ACK does not trigger automatic resubmission');
    assert.deepEqual(f.submissions.at(-1).input, input);
    const original = f.observations.at(-1).body; assert.equal(original.ok, true, JSON.stringify(original));
    assert.equal(isTimelineMutationResponse('timeline.render', input, original.data), true);
    assert.deepEqual(original.data.snapshot.exportRange, RANGE); assert.deepEqual(original.data.snapshot.timeline, f.timeline);
    assert.equal(original.data.snapshot.assets.length, 2, 'off-range source identity remains frozen');
    const receipt = f.receipt(input.requestId); assert.equal(receipt.requestHash, hash({operation: 'timeline.render', input}));
    assert.deepEqual(publicValue(JSON.parse(receipt.response)), original.data);
    assert.deepEqual(await transport.call('timeline.render', input), original);
    accepted.push({input, original, receipt, transport}); await f.assertNoWorker();
  }
  // A genuinely shorter current timeline must not revalidate old bounds before
  // immutable exact replay. The original complete graph remains in each ACK.
  let shorter = await f.services.call('timeline.clip.remove', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), clipId: f.timeline.clips[1].id});
  shorter = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: shorter.revision, requestId: randomUUID(), clipId: shorter.clips[0].id, patch: {durationFrames: 6}});
  assert.equal(shorter.durationFrames, 6);
  // Saved duration metadata changing after acceptance is also harmless to
  // replay, provided source identity and ownership are still the same.
  f.store.put('assets', {...f.sources[0], width: 18, height: 18});
  const beforeReplay = await f.checkpoint(), checks = f.capabilityChecks.length, media = f.media.length;
  for (const {input, original, receipt, transport} of accepted) {
    assert.deepEqual(await transport.call('timeline.render', input), original);
    const conflict = await transport.call('timeline.render', {...input, exportRange: {startFrame: 13, endFrame: 45}});
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    const omitted = {...input}; delete omitted.exportRange;
    assert.equal((await transport.call('timeline.render', omitted)).error.code, 'IDEMPOTENCY_CONFLICT');
    const stale = await transport.call('timeline.render', {...input, requestId: randomUUID()});
    assert.equal(stale.error.code, 'REVISION_CONFLICT');
    const staleCheck = await transport.call('timeline.export.preflight', {projectId: f.project.id, expectedRevision: input.expectedRevision, exportRange: RANGE});
    assert.equal(staleCheck.data.status, 'stale'); assert.equal(staleCheck.data.issues[0].code, 'PREFLIGHT_STALE');
    const bad = await transport.call('timeline.render', {...input, expectedRevision: shorter.revision, requestId: randomUUID()});
    assert.equal(bad.error.code, 'EXPORT_RANGE_BOUNDS');
    const blocked = await transport.call('timeline.export.preflight', {projectId: f.project.id, expectedRevision: shorter.revision, exportRange: RANGE});
    assert.equal(blocked.data.status, 'blocked'); assert.equal(blocked.data.issues[0].code, 'EXPORT_RANGE_BOUNDS'); assert.equal(blocked.data.snapshotHash, null);
    assert.deepEqual(f.receipt(input.requestId), receipt);
  }
  assert.equal(f.capabilityChecks.length, checks, 'replay, bounds and stale CAS do not probe capability');
  assert.equal(f.media.length, media, 'replay, bounds and stale preflight do not probe sources');
  await f.unchanged(beforeReplay); assert.equal(f.store.list('exports').length, 3); await f.assertNoWorker();
});

test('all transports reject invalid/preview ranges; omission retains legacy bytes and full-span is distinct', {timeout: 90_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f), base = {projectId: f.project.id, expectedRevision: f.timeline.revision}, originals = [];
  const before = await f.checkpoint();
  for (const transport of wire.all) {
    for (const exportRange of [null, {startFrame: 0}, {startFrame: -1, endFrame: 1}, {startFrame: 1, endFrame: 1},
      {startFrame: 1.5, endFrame: 2}, {startFrame: 0, endFrame: 18001}, {startFrame: 0, endFrame: 1, extra: true}]) {
      for (const [operation, input] of [['timeline.export.preflight', {...base, exportRange}],
        ['timeline.render', {...base, requestId: randomUUID(), purpose: 'export', exportRange}]]) {
        const result = await transport.call(operation, input); assert.equal(result.ok, false); assert.equal(result.error.code, 'VALIDATION_ERROR');
      }
    }
    assert.equal((await transport.call('timeline.render', {...base, requestId: randomUUID(), purpose: 'preview', exportRange: RANGE})).error.code, 'VALIDATION_ERROR');
  }
  await f.unchanged(before); assert.deepEqual(f.media, []);
  for (const transport of wire.all) {
    const check = await transport.call('timeline.export.preflight', base); assert.equal(check.data.status, 'ready');
    assert.equal(Object.hasOwn(check.data.summary, 'exportRange'), false);
    const input = {...base, requestId: randomUUID(), purpose: 'export'};
    const legacy = await transport.call('timeline.render', input); assert.equal(legacy.ok, true);
    assert.equal(Object.hasOwn(legacy.data.snapshot, 'exportRange'), false);
    const raw = f.receipt(input.requestId).response, savedInput = JSON.stringify(input);
    originals.push({input, legacy, raw});
    assert.equal(raw.includes('exportRange'), false); assert.equal(JSON.stringify(f.submissions.at(-1).input), savedInput);
    assert.deepEqual(await transport.call('timeline.render', input), legacy); assert.equal(f.receipt(input.requestId).response, raw);
    const full = {...input, exportRange: {startFrame: 0, endFrame: 120}};
    assert.equal((await transport.call('timeline.render', full)).error.code, 'IDEMPOTENCY_CONFLICT');
    const explicit = await transport.call('timeline.render', {...full, requestId: randomUUID()}); assert.equal(explicit.ok, true);
    assert.deepEqual(explicit.data.snapshot.exportRange, full.exportRange); assert.deepEqual(explicit.data.snapshot.timeline, legacy.data.snapshot.timeline);
    assert.equal(f.receipt(input.requestId).response, raw);
  }
  const persisted = await f.checkpoint(); await f.restart(); await f.unchanged(persisted);
  for (const {input, legacy, raw} of originals) {
    assert.deepEqual(await f.rpc('timeline.render', input), legacy);
    assert.equal(f.receipt(input.requestId).response, raw, 'recreation preserves old omitted-range receipt bytes');
  }
  await f.unchanged(persisted); await f.assertNoWorker();
});

test('actual CLI and official MCP reject removed or changed range acknowledgements and explicitly recover the original single export', {timeout: 60_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f);
  for (const transport of wire.all.filter(value => value.name !== 'HTTP')) {
    for (const kind of ['removed', 'changed']) {
      const input = {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), purpose: 'export', exportRange: {...RANGE}};
      const count = f.submissions.length, exports = f.store.list('exports').length;
      f.malformRange(kind);
      const result = await transport.call('timeline.render', input);
      assert.equal(result.ok, false); assert.equal(result.error.code, 'BACKEND_PROTOCOL_ERROR');
      assert.equal(result.error.details.submissionMayHaveSucceeded, true); assert.equal(result.error.details.requestId, input.requestId);
      assert.equal(f.submissions.length, count + 1, 'ACK validation never automatically resubmits');
      const original = f.observations.at(-1).body, receipt = f.receipt(input.requestId), before = await f.checkpoint();
      assert.equal(original.ok, true); assert.deepEqual(original.data.snapshot.exportRange, RANGE);
      assert.deepEqual(await transport.call('timeline.render', input), original);
      assert.equal(f.store.list('exports').length, exports + 1); assert.deepEqual(f.receipt(input.requestId), receipt);
      await f.unchanged(before); await f.assertNoWorker();
    }
  }
});

test('selected-range preflight still checks a missing off-range source across actual HTTP, CLI and MCP', {timeout: 45_000}, async t => {
  const f = await selectedRangeFixture(t), wire = await transports(t, f), source = path.join(f.root, f.sources[1].relativePath), bytes = await readFile(source);
  await unlink(source);
  try {
    const before = await f.checkpoint();
    for (const transport of wire.all) {
      const result = await transport.call('timeline.export.preflight', {projectId: f.project.id, expectedRevision: f.timeline.revision, exportRange: RANGE});
      assert.equal(result.ok, true); assert.equal(result.data.status, 'blocked'); assert.equal(result.data.checks.totalAssets, 2);
      assert.equal(result.data.issues[0].assetId, f.sources[1].id); assert.deepEqual(result.data.summary.exportRange, RANGE);
    }
    await f.unchanged(before); assert.equal(f.store.list('exports').length, 0);
  } finally {await writeFile(source, bytes, {mode: 0o600, flag: 'wx'});}
  await f.assertNoWorker();
});

test('HTTP abort, actual CLI Ctrl+C and official MCP cancellation revoke only the selected-range preflight observer', {timeout: 60_000}, async t => {
  const f = await selectedRangeFixture(t), mcp = await officialMcp(t, f.url), input = {projectId: f.project.id, expectedRevision: f.timeline.revision, exportRange: RANGE};
  for (const transport of ['HTTP', 'CLI', 'MCP']) {
    const before = await f.checkpoint(), gate = await f.armCancellation(), count = f.submissions.length;
    const controller = new AbortController(); let pending, child;
    if (transport === 'HTTP') pending = f.rpc('timeline.export.preflight', input, {signal: controller.signal});
    if (transport === 'MCP') pending = mcp.call('timeline.export.preflight', input, {signal: controller.signal});
    if (transport === 'CLI') {child = launchCli(t, f.url, ['timeline', 'export', 'preflight', '--input', JSON.stringify(input)]); pending = child.finish();}
    // Install the rejection handler before cancelling the exact owned request.
    const result = pending.then(value => ({value}), error => ({error}));
    await bounded(gate.entered, `${transport} entered controlled managed-source probe`);
    if (child) assert.equal(child.child.kill('SIGINT'), true); else controller.abort();
    const outcome = await bounded(result, `${transport} cancelled response`);
    if (child) {assert.equal(outcome.value.code, 130); assert.equal(outcome.value.body.error.code, 'INTERRUPTED');}
    else assert.ok(outcome.error, `${transport} must report cancellation`);
    await bounded(gate.aborted, `${transport} revoked backend observer`); await gate.clear();
    assert.equal(f.submissions.length, count + 1, 'cancel never retries the selected-range POST');
    assert.deepEqual(f.submissions.at(-1).input, input); await f.unchanged(before); await f.assertNoWorker();
  }
  const healthy = await f.rpc('timeline.export.preflight', input); assert.equal(healthy.data.status, 'ready');
  assert.equal(f.store.list('exports').length, 0); assert.deepEqual(f.dispatches, []); await f.assertNoWorker();
});

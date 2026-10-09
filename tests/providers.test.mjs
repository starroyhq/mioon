import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMockProvider } from '../packages/business/src/providers/mock.mjs';
import { createRunwayProvider } from '../packages/business/src/providers/runway.mjs';
const exec = promisify(execFile);
const ID = '12345678-1234-4123-8123-123456789abc';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const snapshot = (scenario = 'success', other = {}) => ({ prompt: 'A synthetic geometric shape moves slowly.', duration: 2, aspectRatio: '9:16', model: 'mock-motion-v1', parameters: { scenario, delayMs: 0 }, referenceAssets: [], ...other });
async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'video-providers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function mock(t, options = {}) {
  const root = await sandbox(t), db = new DatabaseSync(path.join(root, 'test.sqlite'));
  t.after(() => db.close());
  return { root, db, provider: createMockProvider({ root, db, ...options }) };
}
async function runway(t, responses = [], options = {}) {
  const root = await sandbox(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/m1cAAAAASUVORK5CYII=', 'base64');
  const file = path.join(root, 'synthetic.png'); await writeFile(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls = [], queue = [...responses];
  const env = { RUNWAYML_API_SECRET: 'offline-fixture-secret', MIOON_ENABLE_LIVE_PROVIDER: '1', RUNWAY_APPROVED_ASSET_SHA256: sha256, ...options.env };
  const fetchImpl = async (...args) => {
    calls.push(args);
    const response = queue.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response(...args);
    if (!response) throw new Error('Unexpected fetch in an OFFLINE contract test');
    return response;
  };
  const provider = createRunwayProvider({ root, fetchImpl, env, ...(options.now ? { now: options.now } : {}) });
  const input = { ...snapshot(), model: 'gen4_turbo', parameters: { seed: 12 }, referenceAssets: [{ id: 'synthetic-fixture', path: file, mimeType: 'image/png', sha256 }] };
  return { root, provider, input, calls, env, bytes, file, queue };
}

test('mock advertises simulated portrait 2/4/8 second outputs', async t => {
  const { provider } = await mock(t);
  assert.equal(provider.capabilities.mock, true);
  assert.deepEqual(provider.capabilities.durations, [2, 4, 8]);
  assert.equal(provider.capabilities.enabled, true);
});

test('accepted then response lost persists the remote record before throwing and reconciles after restart', async t => {
  const root = await sandbox(t), dbPath = path.join(root, 'durable.sqlite');
  let db = new DatabaseSync(dbPath);
  let provider = createMockProvider({ root, db });
  const context = { requestId: 'response-lost-1', jobId: randomUUID() };
  await assert.rejects(provider.submit(snapshot('accepted_then_response_lost'), context), e => e.uncertain === true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mock_provider_tasks').get().n, 1);
  db.close();
  db = new DatabaseSync(dbPath); t.after(() => db.close());
  provider = createMockProvider({ root, db });
  const recovered = await provider.reconcile(context.requestId);
  assert.ok(recovered.providerJobId);
  assert.equal((await provider.poll(recovered.providerJobId)).status, 'succeeded');
  assert.deepEqual(provider.stats(context.requestId), { submissionCount: 1, taskCount: 1, downloadAttempts: 0, pollCount: 1 });
});

test('mock audit counts duplicate submit attempts independently of one accepted task', async t => {
  const { provider } = await mock(t), context = { requestId: 'dedupe-audit' };
  const first = await provider.submit(snapshot(), context);
  assert.deepEqual(await provider.submit(snapshot(), context), first);
  assert.equal(provider.stats().submissionCount, 2);
  assert.equal(provider.stats().taskCount, 1);
  await assert.rejects(provider.submit(snapshot('failure'), context), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(provider.stats().submissionCount, 3);
});

test('unknown and rejected submission are distinct and reconciliation does not submit', async t => {
  const { provider } = await mock(t);
  await assert.rejects(provider.submit(snapshot('unknown'), { requestId: 'unknown' }), e => e.uncertain === true);
  await assert.rejects(provider.submit(snapshot('reject'), { requestId: 'reject' }), e => e.code === 'MOCK_SUBMISSION_REJECTED' && !e.uncertain);
  assert.equal(await provider.reconcile('unknown'), null);
  assert.equal(provider.stats().submissionCount, 2);
  assert.equal(provider.stats().taskCount, 0);
});

test('mock delay, failure, timeout and remote cancellation are deterministic', async t => {
  let clock = 1000;
  const { provider } = await mock(t, { now: () => clock });
  const delayed = await provider.submit(snapshot('delay', { parameters: { scenario: 'delay', delayMs: 1000 } }), { requestId: 'delay' });
  assert.equal((await provider.poll(delayed.providerJobId)).status, 'running');
  clock = 1500; assert.equal((await provider.poll(delayed.providerJobId)).progress, 0.5);
  clock = 2000; assert.equal((await provider.poll(delayed.providerJobId)).status, 'succeeded');
  const failed = await provider.submit(snapshot('failure'), { requestId: 'failure' });
  assert.equal((await provider.poll(failed.providerJobId)).status, 'failed');
  const timeout = await provider.submit(snapshot('timeout'), { requestId: 'timeout' });
  await assert.rejects(provider.poll(timeout.providerJobId), e => e.retryable === true && e.code === 'PROVIDER_POLL_TIMEOUT');
  assert.equal((await provider.cancel(timeout.providerJobId)).remoteCancelled, true);
  assert.equal((await provider.poll(timeout.providerJobId)).error.code, 'PROVIDER_CANCELLED');
  assert.equal((await provider.cancel(delayed.providerJobId)).remoteCancelled, false);
});

test('mock download failure is recoverable without another generation submit', async t => {
  const { provider, root } = await mock(t);
  const { providerJobId } = await provider.submit(snapshot('download_fail_once'), { requestId: 'download-retry' });
  const destination = path.join(root, 'retry.mp4');
  await assert.rejects(provider.download(providerJobId, destination), e => e.retryable === true);
  const result = await provider.download(providerJobId, destination);
  assert.equal(result.isMock, true);
  assert.equal(provider.stats().downloadAttempts, 2);
  assert.equal(provider.stats().submissionCount, 1);
});

test('mock produces playable 9:16 moving MP4s of all advertised durations with simulated labeling', async t => {
  const { provider, root } = await mock(t);
  for (const duration of [2, 4, 8]) {
    const { providerJobId } = await provider.submit(snapshot('success', { duration }), { requestId: `duration-${duration}` });
    const destination = path.join(root, `${duration}.mp4`);
    await provider.download(providerJobId, destination);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames:format=duration:format_tags=comment', '-of', 'json', destination]);
    const media = JSON.parse(stdout);
    assert.equal(media.streams[0].codec_name, 'h264');
    assert.equal(media.streams[0].width / media.streams[0].height, 9 / 16);
    assert.ok(Math.abs(Number(media.format.duration) - duration) < 0.05);
    assert.match(media.format.tags.comment, /SIMULATED MOCK/);
    const decoded = await exec('ffmpeg', ['-v', 'error', '-i', destination, '-f', 'framemd5', '-'], { maxBuffer: 1024 * 1024 });
    const frameHashes = decoded.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    assert.equal(frameHashes.length, 24 * duration);
    assert.ok(new Set(frameHashes).size > duration * 20, 'frames must actually move');
  }
});

test('mock rejects unsupported capabilities and unsafe output paths', async t => {
  const { provider, root } = await mock(t);
  await assert.rejects(provider.submit(snapshot('success', { duration: 5 }), { requestId: 'unsupported' }), { code: 'UNSUPPORTED_CAPABILITY' });
  const { providerJobId } = await provider.submit(snapshot(), { requestId: 'unsafe' });
  await assert.rejects(provider.download(providerJobId, path.join(root, '..', 'escape.mp4')), { code: 'UNSAFE_PATH' });
});

test('Runway is disabled by default and construction never fetches', async t => {
  const { provider, input, calls } = await runway(t, [], { env: { MIOON_ENABLE_LIVE_PROVIDER: '0' } });
  assert.equal(provider.capabilities.enabled, false);
  assert.equal(provider.capabilities.liveVerified, false);
  await assert.rejects(provider.submit(input), { code: 'PROVIDER_DISABLED' });
  await assert.rejects(provider.poll(ID), { code: 'PROVIDER_DISABLED' });
  assert.equal(calls.length, 0);
});

test('Runway sends exactly one documented POST with approved data URI, server auth, ratio and seed', async t => {
  const { provider, input, calls } = await runway(t, [json({ id: ID })]);
  assert.deepEqual(await provider.submit(input, { requestId: 'contract-test' }), { providerJobId: ID });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, 'https://api.dev.runwayml.com/v1/image_to_video');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-Runway-Version'], '2024-11-06');
  assert.equal(init.headers.Authorization, 'Bearer offline-fixture-secret');
  assert.equal(init.headers['Idempotency-Key'], undefined, 'no undocumented idempotency guarantee');
  const body = JSON.parse(init.body);
  assert.equal(body.ratio, '720:1280'); assert.equal(body.duration, 2); assert.equal(body.seed, 12);
  assert.match(body.promptImage, /^data:image\/png;base64,/);
  assert.equal(body.promptText, input.prompt);
  assert.equal(JSON.stringify(provider.capabilities).includes('offline-fixture-secret'), false);
});

for (const [name, response, uncertain] of [
  ['network error', new Error('credential=offline-fixture-secret'), true],
  ['HTTP 500', () => json({ secret: 'offline-fixture-secret' }, 500), true],
  ['HTTP 408', () => json({ secret: 'offline-fixture-secret' }, 408), true],
  ['HTTP 429', () => json({ secret: 'offline-fixture-secret' }, 429), false],
  ['HTTP 400', () => json({ secret: 'offline-fixture-secret' }, 400), false],
  ['unreadable success', () => new Response('not-json'), true],
  ['success missing task id', () => json({ accepted: true }), true],
]) test(`Runway ${name} never retries POST or leaks raw response`, async t => {
  const { provider, input, calls } = await runway(t, [response]);
  await assert.rejects(provider.submit(input), e => Boolean(e.uncertain) === uncertain && !e.message.includes('offline-fixture-secret'));
  assert.equal(calls.length, 1);
  assert.equal(await provider.reconcile('missing-request'), null);
  assert.equal(calls.length, 1);
});

test('Runway enforces asset approval, managed paths, checksums and encoded size before fetch', async t => {
  const { provider, input, calls, root, file } = await runway(t);
  const ref = input.referenceAssets[0];
  await assert.rejects(provider.submit({ ...input, referenceAssets: [{ ...ref, sha256: '0'.repeat(64) }] }), { code: 'REFERENCE_NOT_APPROVED' });
  await writeFile(file, Buffer.from('changed'));
  await assert.rejects(provider.submit(input), { code: 'INVALID_REFERENCE_TYPE' });
  const outside = await sandbox(t), outsideFile = path.join(outside, 'outside.png');
  await writeFile(outsideFile, 'outside');
  const link = path.join(root, 'linked.png'); await symlink(outsideFile, link);
  await assert.rejects(provider.submit({ ...input, referenceAssets: [{ ...ref, path: link }] }), { code: 'UNSAFE_REFERENCE_PATH' });
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024));
  await assert.rejects(provider.submit(input), { code: 'REFERENCE_TOO_LARGE' });
  assert.equal(calls.length, 0);
});

test('Runway rejects mutated valid image and arbitrary URLs without transmission', async t => {
  const { provider, input, calls, bytes, file } = await runway(t);
  const changed = Buffer.from(bytes); changed[20] ^= 1; await writeFile(file, changed);
  await assert.rejects(provider.submit(input), { code: 'REFERENCE_CHANGED' });
  await assert.rejects(provider.submit({ ...input, referenceAssets: [{ ...input.referenceAssets[0], path: 'https://example.com/secret.png' }] }), { code: 'REFERENCE_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('Runway capability and parameter validation runs before a paid POST', async t => {
  const { provider, input, calls } = await runway(t);
  for (const patch of [{ duration: 1 }, { duration: 2.5 }, { duration: 11 }, { aspectRatio: 'unknown' }, { model: 'other' }, { prompt: '' }, { prompt: 'x'.repeat(1001) }, { referenceAssets: [] }, { parameters: { webhook: 'evil' } }, { parameters: { seed: -1 } }]) await assert.rejects(provider.submit({ ...input, ...patch }));
  assert.equal(calls.length, 0);
  assert.deepEqual(provider.capabilities.durations, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Runway maps task states, clamps progress, caches five seconds, and sanitizes failure', async t => {
  let clock = 0;
  const statuses = ['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
  const { provider, calls } = await runway(t, statuses.map(status => () => json({ id: ID, status, progress: 2, failure: 'offline-fixture-secret' })), { now: () => clock });
  const expected = ['running', 'running', 'running', 'succeeded', 'failed', 'failed'];
  for (let i = 0; i < statuses.length; i++) {
    clock = i * 5001;
    const result = await provider.poll(ID);
    assert.equal(result.status, expected[i]);
    assert.equal(JSON.stringify(result).includes('offline-fixture-secret'), false);
    assert.deepEqual(await provider.poll(ID), result);
    assert.equal(calls.length, i + 1);
  }
});

test('Runway known task transient polling failure is retryable and malformed task IDs never fetch', async t => {
  const { provider, calls } = await runway(t, [new Error('network down'), json({ id: ID, status: 'RUNNING', progress: 0.2 })]);
  await assert.rejects(provider.poll('../../other'), { code: 'INVALID_PROVIDER_TASK_ID' });
  await assert.rejects(provider.poll(ID), e => e.retryable === true && !e.uncertain);
  assert.equal((await provider.poll(ID)).progress, 0.2);
  assert.equal(calls.length, 2);
});

test('Runway cancellation is truthful local-only and never uses destructive DELETE', async t => {
  const { provider, calls } = await runway(t);
  const cancelled = await provider.cancel(ID);
  assert.equal(cancelled.remoteCancelled, false);
  assert.equal(cancelled.scope, 'local');
  assert.equal(calls.length, 0);
});

test('Runway downloads a playable output to managed storage without forwarding auth or signed URLs', async t => {
  const m = await mock(t);
  const task = await m.provider.submit(snapshot(), { requestId: 'download-source' });
  const source = path.join(m.root, 'source.mp4'); await m.provider.download(task.providerJobId, source);
  const bytes = await readFile(source);
  const { provider, calls, root } = await runway(t, [json({ id: ID, status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=secret-signed-link'] }), new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } })]);
  const target = path.join(root, 'downloaded.mp4'), result = await provider.download(ID, target);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(calls[1][1].headers, undefined);
  assert.equal(calls[1][1].redirect, 'error');
  assert.equal(result.isMock, false);
  assert.equal(JSON.stringify(result).includes('secret-signed-link'), false);
});

for (const url of ['http://dnznrvs05pmza.cloudfront.net/output.mp4', 'https://localhost/output.mp4', 'https://169.254.169.254/output.mp4', 'https://dnznrvs05pmza.cloudfront.net.evil.test/output.mp4', 'https://user:pass@dnznrvs05pmza.cloudfront.net/output.mp4']) test(`Runway blocks unsafe output URL ${new URL(url).hostname}`, async t => {
  const { provider, root, calls } = await runway(t, [json({ id: ID, status: 'SUCCEEDED', output: [url] })]);
  await assert.rejects(provider.download(ID, path.join(root, 'out.mp4')), { code: 'UNAPPROVED_OUTPUT_HOST' });
  assert.equal(calls.length, 1);
});

test('Runway rejects malformed media and cleans partial files', async t => {
  const { provider, root } = await runway(t, [json({ id: ID, status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/output.mp4'] }), new Response('this is definitely not an mp4')]);
  await assert.rejects(provider.download(ID, path.join(root, 'invalid.mp4')), { code: 'INVALID_OUTPUT_MEDIA' });
  assert.equal((await readdir(root)).some(x => x.includes('.mp4')), false);
});

test('mock recoverable timeout and rejection/failure aliases use the same durable ledger', async t => {
  const { provider, db, root } = await mock(t);
  const { providerJobId } = await provider.submit(snapshot('poll_timeout_then_recover'), { requestId: 'recover-timeout' });
  await assert.rejects(provider.poll(providerJobId), { code: 'PROVIDER_POLL_TIMEOUT' });
  // A recreated provider sees persisted attempts rather than resetting the scenario.
  const resumed = createMockProvider({ db, root });
  await assert.rejects(resumed.poll(providerJobId), { code: 'PROVIDER_POLL_TIMEOUT' });
  assert.equal((await resumed.poll(providerJobId)).status, 'succeeded');
  assert.equal(resumed.stats('recover-timeout').submissionCount, 1);
  assert.equal(resumed.stats('recover-timeout').pollCount, 3);
  await assert.rejects(resumed.submit(snapshot('rejected_before_accept'), { requestId: 'alias-reject' }), { code: 'MOCK_SUBMISSION_REJECTED' });
  const failed = await resumed.submit(snapshot('terminal_failure'), { requestId: 'alias-failed' });
  assert.equal((await resumed.poll(failed.providerJobId)).status, 'failed');
});

test('Runway expired download is refreshed by task ID with no second POST', async t => {
  const { provider, root, calls } = await runway(t, [
    json({ id: ID, status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=expired'] }),
    new Response('', { status: 403 }),
    json({ id: ID, status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=fresh'] }),
    new Response(Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109])),
  ]);
  const target = path.join(root, 'refreshed.mp4');
  await assert.rejects(provider.download(ID, target), e => e.retryable === true);
  await provider.download(ID, target);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(([, init]) => init.method === 'POST').length, 0);
  assert.match(calls[3][0], /fresh/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunwayProvider } from '../packages/business/src/providers/runway.ts';
import { createPollCache } from '../packages/business/src/providers/live-common.ts';
import { openStore } from '../packages/business/src/db.ts';
import { createServices } from '../packages/business/src/services.ts';
import { startWorker } from '../packages/business/src/jobs.ts';
import { createRunwayUnknownFixture, syntheticPng } from './helpers/runway-unknown-fixture.ts';
import type { Provider } from '../packages/business/src/provider-registry.ts';
interface FixtureOptions { env?: Record<string, string | undefined>; now?: () => number }
interface Deferred<T> { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }
interface FailureView { code?: string; uncertain?: boolean; retryable?: boolean; message: string }
const failureOf = (value: unknown): FailureView => value as FailureView;

const ID = '12345678-1234-4123-8123-123456789abc';
const SECRET = 'PRIVATE-Q1-KEY-AND-BODY';
const JSON_LIMIT = 1024 * 1024, DOWNLOAD_LIMIT = 128 * 1024 * 1024;
const MP4_HEADER = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
const CDN = 'https://dnznrvs05pmza.cloudfront.net/output.mp4?signature=PRIVATE-SIGNED-URL';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const succeeded = () => json({ id: ID, status: 'SUCCEEDED', output: [CDN] });
const deferred = <T = unknown>(): Deferred<T> => { let resolve!: Deferred<T>['resolve'], reject!: Deferred<T>['reject']; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function sandbox(t: import('node:test').TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'runway-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: import('node:test').TestContext, responses: unknown[] = [], options: FixtureOptions = {}) {
  const root = await sandbox(t), file = path.join(root, 'reference.png');
  await writeFile(file, syntheticPng);
  const sha256 = createHash('sha256').update(syntheticPng).digest('hex'), calls: [RequestInfo | URL, (RequestInit | undefined)?][] = [], queue: unknown[] = [...responses];
  const env = { RUNWAYML_API_SECRET: SECRET, MIOON_ENABLE_LIVE_PROVIDER: '1', RUNWAY_APPROVED_ASSET_SHA256: sha256, ...options.env };
  const provider = createRunwayProvider({ root, env, now: options.now ?? Date.now, fetchImpl: async (...args: [RequestInfo | URL, RequestInit?]) => {
    calls.push(args);
    const next = queue.shift();
    if (typeof next === 'function') return (next as (...callArgs: [RequestInfo | URL, RequestInit?]) => Response)(...args);
    if (next instanceof Error) throw next;
    assert.ok(next, 'Network is forbidden; every response must be injected');
    return next as Response;
  } });
  const input = { model: 'gen4_turbo', prompt: 'Synthetic shape', duration: 2, aspectRatio: '9:16', parameters: {}, referenceAssets: [{ path: file, mimeType: 'image/png', sha256 }] };
  return { root, input, calls, queue, provider };
}
function safeFailure(error: unknown, code: string, uncertain: boolean): true {
  const failure = failureOf(error);
  assert.equal(failure.code, code); assert.equal(failure.uncertain, uncertain);
  assert.doesNotMatch(JSON.stringify({ ...failure, message: failure.message }), /PRIVATE-Q1|PRIVATE-SIGNED/);
  return true;
}
for (const status of [400, 401, 402, 403, 404, 405, 413, 415, 422, 429]) test(`Runway parity: POST ${status} is a definite rejection, exactly once`, async t => {
  const f = await fixture(t, [json({ error: SECRET }, status)]);
  await assert.rejects(f.provider.submit(f.input), e => safeFailure(e, `PROVIDER_HTTP_${status}`, false));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.[1]?.method, 'POST');
});
for (const status of [302, 408, 409, 410, 418, 425, 499, 500, 599]) test(`Runway parity: POST ${status} preserves unknown acceptance, exactly once`, async t => {
  const f = await fixture(t, [json({ error: SECRET }, status)]);
  await assert.rejects(f.provider.submit(f.input), (e: unknown) => safeFailure(e, 'SUBMISSION_UNKNOWN', true));
  assert.equal(await (f.provider.reconcile as (requestId?: string) => Promise<unknown>)('unknown-request'), null);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.[1]?.redirect, 'error');
});
for (const [name, response] of [
  ['fetch rejects redirect', new TypeError(`redirect error ${SECRET}`)],
  ['abort after dispatch', new DOMException(SECRET, 'AbortError')],
  ['malformed JSON', () => new Response(SECRET)],
  ['array', () => json([ID])], ['scalar', () => json(SECRET)], ['null', () => json(null)],
  ['missing ID', () => json({ accepted: true })], ['invalid ID', () => json({ id: SECRET })],
  ['array-coerced ID', () => json({ id: [ID] })], ['non-v4 UUID', () => json({ id: ID.replace('-4123-', '-3123-') })],
  ['empty response', () => new Response(null)],
]) test(`Runway parity: ${name} cannot become a safely retryable submission`, async t => {
  const f = await fixture(t, [response]);
  await assert.rejects(f.provider.submit(f.input), (e: unknown) => safeFailure(e, 'SUBMISSION_UNKNOWN', true));
  assert.equal(f.calls.length, 1);
});
for (const declared of [false, true]) test(`Runway parity: JSON above 1 MiB ${declared ? 'with' : 'without'} Content-Length cancels the stream`, async t => {
  let cancelled = 0, chunks = 0;
  const body = new ReadableStream({ pull(controller) { chunks++; controller.enqueue(Buffer.alloc(64 * 1024, 32)); }, cancel() { cancelled++; } });
  const f = await fixture(t, [new Response(body, { headers: declared ? { 'content-length': String(JSON_LIMIT + 1) } : {} })]);
  await assert.rejects(f.provider.submit(f.input), (e: unknown) => safeFailure(e, 'SUBMISSION_UNKNOWN', true));
  assert.equal(cancelled, 1); assert.equal(f.calls.length, 1);
  assert.ok(chunks <= (declared ? 1 : 18), 'reader must stop at the size bound');
});
test('Runway parity: exactly 1 MiB valid JSON remains accepted', async t => {
  const core = JSON.stringify({ id: ID }), f = await fixture(t, [new Response(core.padEnd(JSON_LIMIT, ' '))]);
  assert.deepEqual(await f.provider.submit(f.input), { providerJobId: ID }); assert.equal(f.calls.length, 1);
});
const retryableStatuses: [number, boolean][] = [[400, false], [401, false], [409, false], [408, true], [429, true], [500, true]];
for (const [status, retryable] of retryableStatuses) test(`Runway parity: GET ${status} preserves existing retryability and caches the error`, async t => {
  let now = 0; const f = await fixture(t, [json({ secret: SECRET }, status), json({ id: ID, status: 'RUNNING' })], { now: () => now });
  for (let i = 0; i < 2; i++) await assert.rejects(f.provider.poll(ID), (e: unknown) => safeFailure(e, `PROVIDER_HTTP_${status}`, false) && failureOf(e).retryable === retryable);
  assert.equal(f.calls.length, 1); now = 5000;
  assert.equal((await f.provider.poll(ID)).status, 'running'); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(([, init]) => init?.method === 'GET'));
});
test('Runway parity: malformed GET is cached, then retries the same ID only', async t => {
  let now = 0; const f = await fixture(t, [json({ id: ID, status: 'UNRECOGNIZED' }), json({ id: ID, status: 'PENDING' })], { now: () => now });
  for (let i = 0; i < 2; i++) await assert.rejects(f.provider.poll(ID), (e: unknown) => failureOf(e).code === 'INVALID_PROVIDER_RESPONSE' && failureOf(e).retryable === true);
  assert.equal(f.calls.length, 1); now = 5000;
  assert.equal((await f.provider.poll(ID)).status, 'running'); assert.equal(f.calls.length, 2);
  const badIds: unknown[] = [[ID], null, {}, '../other'];
  for (const badId of badIds) await assert.rejects(f.provider.poll(badId as string), { code: 'INVALID_PROVIDER_TASK_ID' });
  assert.equal(f.calls.length, 2);
});
for (const failure of [false, true]) test(`Runway parity: slow concurrent GET ${failure ? 'failure' : 'success'} stays deduplicated through settlement cooldown`, async t => {
  let now = 0; const gate = deferred(), dispatched = deferred<void>(), f = await fixture(t, [() => {dispatched.resolve();return gate.promise;}, json({ id: ID, status: 'RUNNING' })], { now: () => now });
  const first = f.provider.poll(ID); await dispatched.promise; assert.equal(f.calls.length, 1);
  now = 20000; const second = f.provider.poll(ID); await Promise.resolve(); assert.equal(f.calls.length, 1);
  const settled = Promise.allSettled([first, second]);
  if (failure) gate.reject(new Error(SECRET)); else gate.resolve(json({ id: ID, status: 'RUNNING' }));
  const results = await settled; assert.ok(results.every(value => value.status === (failure ? 'rejected' : 'fulfilled')));
  if (failure) { const reasons = results.map(value => value.status === 'rejected' ? value.reason : undefined); assert.equal(reasons[0], reasons[1]); await assert.rejects(f.provider.poll(ID), { code: 'PROVIDER_UNAVAILABLE' }); }
  else assert.equal((await f.provider.poll(ID)).status, 'running');
  assert.equal(f.calls.length, 1); now = 25000;
  assert.equal((await f.provider.poll(ID)).status, 'running'); assert.equal(f.calls.length, 2);
});
test('Shared cache: an invalidated in-flight entry cannot overwrite a newer result', async () => {
  const old = deferred<string>(), fresh = deferred<string>(); let calls = 0, now = 0;
  const cache = createPollCache({ now: () => now, interval: 5000, retrieve: () => (++calls === 1 ? old.promise : fresh.promise) as unknown as Promise<Record<string, unknown>> });
  const first = cache.get(ID); await Promise.resolve(); cache.invalidate(ID);
  const second = cache.get(ID); await Promise.resolve(); fresh.resolve('new'); assert.equal(await second, 'new');
  now = 1000; old.resolve('old'); assert.equal(await first, 'old'); assert.equal(await cache.get(ID), 'new'); assert.equal(calls, 2);
});
test('Runway parity: escaping symlink with nonexistent child creates nothing outside root', async t => {
  const f = await fixture(t, [succeeded()]), outside = await sandbox(t);
  await symlink(outside, path.join(f.root, 'escape'));
  await assert.rejects(f.provider.download(ID, path.join(f.root, 'escape', 'new-directory', 'out.mp4')), { code: 'UNSAFE_OUTPUT_PATH' });
  assert.deepEqual(await readdir(outside), []); assert.equal(f.calls.length, 1);
});
test('Runway parity: acquired response stream is cancelled when opening output fails', async t => {
  let cancelled = 0; const f = await fixture(t, [succeeded()]);
  const parent = path.join(f.root, 'output');
  f.queue.push(async () => {
    // Deterministically fail open inside managed storage, without permissions or
    // platform-specific filename-length assumptions.
    await rm(parent, { recursive: true }); await writeFile(parent, 'file instead of directory');
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  });
  await assert.rejects(f.provider.download(ID, path.join(parent, 'out.mp4')), { code: 'DOWNLOAD_FAILED', retryable: true });
  assert.equal(cancelled, 1); assert.equal(f.calls[1]?.[1]?.headers, undefined);
  assert.deepEqual((await readdir(f.root)).sort(), ['output', 'reference.png']);
});
for (const mode of ['declared-oversize', 'stream-oversize', 'stream-error', 'invalid-media', 'redirect']) test(`Runway parity: ${mode} cleans partial output, cancels when possible and refreshes only GET`, async t => {
  let cancelled = 0, chunks = 0;
  const f = await fixture(t, [succeeded()]);
  let response: Response | undefined, code: string | undefined;
  if (mode === 'declared-oversize') {
    response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(DOWNLOAD_LIMIT + 1) } }); code = 'OUTPUT_TOO_LARGE';
  } else if (mode === 'stream-oversize') {
    response = new Response(new ReadableStream({ pull(controller) { chunks++; controller.enqueue(chunks === 1 ? MP4_HEADER : Buffer.alloc(1024 * 1024)); }, cancel() { cancelled++; } })); code = 'OUTPUT_TOO_LARGE';
  } else if (mode === 'stream-error') {
    response = new Response(new ReadableStream({ pull(controller) { if (++chunks === 1) controller.enqueue(MP4_HEADER); else controller.error(new Error(SECRET)); } })); code = 'DOWNLOAD_FAILED';
  } else if (mode === 'invalid-media') { response = new Response(SECRET); code = 'INVALID_OUTPUT_MEDIA'; }
  else { response = new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }); code = 'UNSAFE_OUTPUT_REDIRECT'; }
  f.queue.push(response, succeeded(), new Response(MP4_HEADER));
  const destination = path.join(f.root, 'media', 'out.mp4');
  await assert.rejects(f.provider.download(ID, destination), (e: unknown) => failureOf(e).code === code && !failureOf(e).message.includes(SECRET));
  assert.deepEqual(await readdir(path.dirname(destination)), []);
  if (mode.includes('oversize')) assert.equal(cancelled, 1);
  if (mode === 'stream-oversize') assert.ok(chunks <= 130);
  await f.provider.download(ID, destination); assert.deepEqual(await readFile(destination), MP4_HEADER);
  assert.equal(f.calls.length, 4); assert.ok(f.calls.every(([, init]) => init?.method === 'GET'));
  for (const i of [1, 3]) { assert.equal(f.calls[i]?.[1]?.headers, undefined); assert.equal(f.calls[i]?.[1]?.redirect, 'error'); }
});
test('Runway parity: configured exact CDN allowlist is preserved without auth', async t => {
  const url = 'https://verified-runway.example/output.mp4', f = await fixture(t, [json({ id: ID, status: 'SUCCEEDED', output: [url] }), new Response(MP4_HEADER)], { env: { RUNWAY_OUTPUT_HOSTS: 'verified-runway.example' } });
  await f.provider.download(ID, path.join(f.root, 'out.mp4'));
  assert.equal(f.calls[1]?.[0], url); assert.equal(f.calls[1]?.[1]?.headers, undefined);
});
test('Runway parity: actual worker persists HTTP 409 unknown, refuses job.retry and never resubmits on reconciliation or restart', async t => {
  const root = await sandbox(t), fixture = await createRunwayUnknownFixture(root), store = openStore(root);
  let calls = 0, worker: ReturnType<typeof startWorker> | undefined;
  const provider = createRunwayProvider({ root, env: { RUNWAYML_API_SECRET: SECRET, MIOON_ENABLE_LIVE_PROVIDER: '1' }, fetchImpl: async () => { calls++; throw Error('No network during unknown reconciliation'); } });
  const providers = new Map([['runway', provider]]) as unknown as ReadonlyMap<string, Provider>, services = createServices(store, providers, {});
  t.after(async () => { await worker?.stop(); store.close(); });
  assert.equal((store.get('jobs', fixture.jobId) as {status: string}).status, 'submission_unknown');
  services.saveJob(store.get('jobs', fixture.jobId) as never, { nextPollAt: 0 });
  worker = startWorker(store, services, providers); await worker.stop();
  await assert.rejects(services.call('job.retry', { jobId: fixture.jobId, requestId: randomUUID() }), { code: 'UNSAFE_RETRY' });
  assert.equal(((await services.call('job.reconcile', { jobId: fixture.jobId })) as {status: string}).status, 'submission_unknown');
  assert.equal((store.get('jobs', fixture.jobId) as {submissionCount: number}).submissionCount, 1); assert.equal(store.list('jobs').length, 1);
  assert.equal(store.list('versions').length, 0); assert.equal(calls, 0); assert.equal(fixture.calls.length, 1);
});

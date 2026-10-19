import test, {type TestContext} from 'node:test';
import type {IncomingMessage, ServerResponse} from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CONTINUOUS_AUDIO_PROFILE, CONTINUOUS_AUDIO_HEADERS as H, CONTINUOUS_AUDIO_LIMITS as L,
  continuousAudioPlanDigestMaterial} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {createContinuousAudioPreviewClient, readContinuousAudioBlock} from '../apps/web/src/timeline-audio-continuous-client.ts';
import {stripSourceTypes} from './helpers/eval-source.ts';

interface Plan {schemaVersion: number; status: string; profileId: string; projectId: string; timelineId: string; timelineRevision: number; startFrame: number; durationFrames: number; blockFrames: number; sampleRate: number; channels: number; admittedBytes: number; snapshotHash: string; planHash: string; [key: string]: unknown}
interface BlockRequest {projectId: string; timelineId: string; expectedRevision: number; startFrame: number; planHash: string; sessionId: string; generation: number; sequence: number; blockStartFrame: number; [key: string]: unknown}
interface AudioBufferLike {length: number; numberOfChannels: number; sampleRate: number; getChannelData(channel: number): Float32Array}
interface Deferred<T = void> {promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void}
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 0};
const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T = void>(): Deferred<T> => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const makeClient = (options: unknown): ReturnType<typeof createContinuousAudioPreviewClient> => createContinuousAudioPreviewClient(options as never);
function manifest(): Plan {
  const plan: Plan = {schemaVersion: 2, status: 'planned', profileId: CONTINUOUS_AUDIO_PROFILE, projectId: input.projectId,
    timelineId: input.timelineId, timelineRevision: 1, startFrame: 0, durationFrames: 750, blockFrames: 60,
    sampleRate: 48000, channels: 2, admittedBytes: L.memoryBytes, snapshotHash: 'a'.repeat(64), planHash: '0'.repeat(64)};
  plan.planHash = createHash('sha256').update(continuousAudioPlanDigestMaterial(plan as never)).digest('hex'); return plan;
}
function audioContext(): {sampleRate: number; createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike} {
  return {sampleRate: 48000, createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike {
    const data = Array.from({length: channels}, () => new Float32Array(length));
    return {length, numberOfChannels: channels, sampleRate, getChannelData: (channel: number) => data[channel]};
  }};
}
function parseRequest(url: string): BlockRequest {
  const value = Object.fromEntries(new URL(url, 'http://fixture').searchParams);
  return {...value, expectedRevision: +value.expectedRevision, startFrame: +value.startFrame,
    generation: +value.generation, sequence: +value.sequence, blockStartFrame: +value.blockStartFrame} as BlockRequest;
}
function response(plan: Plan, req: BlockRequest, {body, headers = {}}: {body?: BodyInit; headers?: Record<string, string>} = {}): Response {
  const end = Math.min(req.blockStartFrame + 60, plan.durationFrames), samples = (end - req.blockStartFrame) * 1600;
  return new Response(body ?? new Uint8Array(samples * 8), {headers: {'Content-Type': 'application/octet-stream',
    'Content-Length': String(samples * 8), 'Cache-Control': 'no-store', [H.profile]: CONTINUOUS_AUDIO_PROFILE,
    [H.planHash]: plan.planHash, [H.session]: req.sessionId, [H.generation]: String(req.generation), [H.sequence]: String(req.sequence),
    [H.startFrame]: String(req.blockStartFrame), [H.endFrame]: String(end), [H.sampleFrames]: String(samples), ...headers}});
}

test('an initial unconfirmed reader cancellation rejects both preparation and the exact resource settlement', async () => {
  const plan = manifest(); let resources, deletes = 0;
  const client = makeClient({readPlan: async () => plan, fetcher: async (url: string, options: {method?: string; signal?: AbortSignal; headers?: Record<string, string>}) => {
    if (options.method === 'DELETE') { deletes++; return new Response(null, {status: 204}); }
    const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat32(0, NaN, true);
    return response(plan, parseRequest(url), {body: new ReadableStream({start(controller) { controller.enqueue(bytes); },
      cancel() { return Promise.reject(Error('Exact reader cancellation is unconfirmed')); }})});
  }});
  await assert.rejects(client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal,
    onResourceSettlement: (value: Promise<unknown>) => { resources = value; }}), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
  await assert.rejects(resources!, {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'}); assert.equal(deletes, 1);
});

test('invalid headers and bounded error bodies normalize failed cancellation to an unconfirmed resource proof', async () => {
  const plan = manifest(), req: BlockRequest = {...input, planHash: plan.planHash, sessionId: id(3), generation: 1, sequence: 1, blockStartFrame: 0};
  for (const mode of ['headers', 'error']) {
    const body = new ReadableStream({start(controller) {
      if (mode === 'error') controller.enqueue(new Uint8Array(new ArrayBuffer(2 * 1024 * 1024), 0, 8));
    }, cancel() { throw Error('Cancel failed'); }});
    const res = mode === 'headers' ? response(plan, req, {body, headers: {[H.session]: id(99)}})
      : new Response(body as never, {status: 409, headers: {'Content-Type': 'application/json'}});
    await assert.rejects(readContinuousAudioBlock(res, req as never, plan as never, audioContext() as never, new AbortController().signal),
      {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
  }
});

test('a locally cancelled response starts the retry in a new cursor generation after the server already advanced', async () => {
  const plan = manifest(), requests: BlockRequest[] = []; let serverGeneration = 1, serverNext = 0, cancelCalls = 0;
  const client = makeClient({readPlan: async () => plan, fetcher: async (url: string, options: {method?: string; signal?: AbortSignal; headers?: Record<string, string>}) => {
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    const req = parseRequest(url); requests.push(req);
    if (req.generation > serverGeneration) { serverGeneration = req.generation; serverNext = req.blockStartFrame; }
    assert.equal(req.blockStartFrame, serverNext, 'The retried cursor must explicitly reset the server generation');
    serverNext = Math.min(req.blockStartFrame + 60, plan.durationFrames);
    if (requests.length === 2) return response(plan, req, {body: new ReadableStream({cancel() { cancelCalls++; }})});
    return response(plan, req);
  }});
  const session = await client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal}); session.takeInitialBlock();
  const abort = new AbortController(), pending = session.loadBlock(60, abort.signal); await tick(); abort.abort();
  await assert.rejects(pending, {code: 'AUDIO_PREVIEW_CANCELLED'});
  assert.equal((await session.loadBlock(60, new AbortController().signal)).startFrame, 60);
  assert.ok(requests[2].generation > requests[1].generation); assert.equal(cancelCalls, 1); await session.dispose();
});

test('a cancellation before network dispatch leaves a sequence gap without reusing an old generation', async () => {
  const plan = manifest(), accepted: BlockRequest[] = []; let attempts = 0;
  const client = makeClient({readPlan: async () => plan, fetcher: async (url: string, options: {method?: string; signal?: AbortSignal; headers?: Record<string, string>}) => {
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    const req = parseRequest(url); attempts++;
    if (options.signal?.aborted) throw new DOMException('Request was never dispatched', 'AbortError');
    accepted.push(req); return response(plan, req);
  }});
  const session = await client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal}); session.takeInitialBlock();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.loadBlock(60, abort.signal), {code: 'AUDIO_PREVIEW_CANCELLED'});
  await session.loadBlock(60, new AbortController().signal);
  assert.equal(attempts, 3); assert.deepEqual(accepted.map(req => [req.generation, req.sequence]), [[1, 1], [2, 3]]);
  await session.dispose();
});

test('metadata timeout returns promptly while its ignored late acknowledgment retains the exact resource fence', async () => {
  const pending = deferred<Plan>(), plan = manifest(); let resources, settled = false, fetched = 0, signal;
  const client = makeClient({timeoutMs: 10, readPlan: async (_input: unknown, options: {signal: AbortSignal}) => { signal = options.signal; return pending.promise; },
    fetcher: async () => { fetched++; throw Error('Late metadata must not cause PCM acquisition'); }});
  await assert.rejects(client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal,
    onResourceSettlement: (value: Promise<unknown>) => { resources = value; value.then(() => { settled = true; }); }}), {code: 'AUDIO_PREVIEW_TIMEOUT'});
  assert.equal(signal!.aborted, true); assert.equal(settled, false); assert.equal(fetched, 0);
  pending.resolve(plan); await resources; assert.equal(settled, true); assert.equal(fetched, 0);
});

test('metadata cancellation rejects promptly, never reserves sound on a late reply, and settles only after that reply', async () => {
  const pending = deferred<Plan>(), abort = new AbortController(); let resources: Promise<unknown> | undefined, settled = false, effects = 0;
  const client = makeClient({readPlan: async () => pending.promise,
    fetcher: async () => { effects++; throw Error('Forbidden PCM fetch'); }});
  const work = client.prepare(input as never, {context: audioContext() as never, signal: abort.signal,
    reserveNative: async () => { effects++; throw Error('Forbidden native lease'); },
    onResourceSettlement: (value: Promise<unknown>) => { resources = value; value.then(() => { settled = true; }); }});
  abort.abort(); await assert.rejects(work, {code: 'AUDIO_PREVIEW_CANCELLED'}); assert.equal(settled, false);
  pending.resolve(manifest()); await resources; assert.equal(settled, true); assert.equal(effects, 0);
});

test('a timed out initial response with unconfirmed late body cancellation cannot release the resource fence', async () => {
  const pending = deferred<Response>(), plan = manifest(); let resources: Promise<unknown> | undefined, request: BlockRequest | undefined, gets = 0;
  const client = makeClient({timeoutMs: 10, readPlan: async () => plan, fetcher: async (url: string, options: {method?: string; signal?: AbortSignal; headers?: Record<string, string>}) => {
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    gets++; request = parseRequest(url); return pending.promise;
  }});
  const work = client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal,
    onResourceSettlement: (value: Promise<unknown>) => { resources = value; }});
  await assert.rejects(work, {code: 'AUDIO_PREVIEW_TIMEOUT'}); assert.equal(gets, 1);
  pending.resolve(response(plan, request!, {body: new ReadableStream({cancel() { throw Error('Late response retained'); }})}));
  await assert.rejects(resources!, {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
});

test('transferred initial PCM is collectable while its session remains open', () => {
  const script = `import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {CONTINUOUS_AUDIO_PROFILE,CONTINUOUS_AUDIO_HEADERS as H,CONTINUOUS_AUDIO_LIMITS as L,continuousAudioPlanDigestMaterial} from ${JSON.stringify(new URL('../packages/contracts/src/timeline-audio-continuous.ts', import.meta.url).href)};
    import {createContinuousAudioPreviewClient} from ${JSON.stringify(new URL('../apps/web/src/timeline-audio-continuous-client.ts', import.meta.url).href)};
    const id=${stripSourceTypes(id.toString(), {loader: 'ts'})}; const input=${JSON.stringify(input)};
    const manifest=${stripSourceTypes(manifest.toString(), {loader: 'ts'})},audioContext=${stripSourceTypes(audioContext.toString(), {loader: 'ts'})},response=${stripSourceTypes(response.toString(), {loader: 'ts'})},parseRequest=${stripSourceTypes(parseRequest.toString(), {loader: 'ts'})};
    const plan=manifest(),client=createContinuousAudioPreviewClient({readPlan:async()=>plan,fetcher:async(url,options)=>options.method==='DELETE'?new Response(null,{status:204}):response(plan,parseRequest(url))});
    const session=await client.prepare(input,{context:audioContext(),signal:new AbortController().signal});
    let block=session.takeInitialBlock();const weak=new WeakRef(block.buffer);block=null;
    await new Promise(setImmediate);
    for(let i=0;i<8;i++){global.gc();await new Promise(setImmediate);}
    assert.equal(weak.deref(),undefined,'No fulfilled client promise may retain a transferred PCM buffer');
    await session.dispose();`;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const mode of ['pcm', 'error']) {
  test(`${mode} cancellation asks the exact reader to release before Fetch can error its stream`, async () => {
    const plan = manifest(), order: string[] = []; let calls = 0, cancelled = false;
    const client = makeClient({readPlan: async () => plan, fetcher: async (url: string, options: {method?: string; signal?: AbortSignal; headers?: Record<string, string>}) => {
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      const req = parseRequest(url); if (++calls === 1) return response(plan, req);
      let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
      options.signal!.addEventListener('abort', () => {
        order.push('fetch-abort');
        if (!cancelled) producer!.error(new DOMException('Fetch invalidated the body', 'AbortError'));
      }, {once: true});
      const body = new ReadableStream({start(controller) {
        producer = controller;
        controller.enqueue(mode === 'pcm' ? new Uint8Array(8) : new TextEncoder().encode('{"ok":false,'));
      }, cancel() {cancelled = true; order.push('reader-cancel');}});
      return mode === 'pcm' ? response(plan, req, {body}) : new Response(body as never, {status: 409, headers: {'Content-Type': 'application/json'}});
    }});
    const session = await client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal}); session.takeInitialBlock();
    const abort = new AbortController(), pending = session.loadBlock(60, abort.signal); await tick(); abort.abort();
    await assert.rejects(pending, {code: 'AUDIO_PREVIEW_CANCELLED'});
    assert.deepEqual(order, ['reader-cancel', 'fetch-abort']); await session.dispose();
  });

  test(`real local HTTP slow ${mode} body cancellation confirms reader and server retirement without a false cleanup failure`, {timeout: 10000}, async (t: TestContext) => {
    const plan = manifest(), slowEntered = deferred(), slowClosed = deferred(); let gets = 0, deletes = 0;
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'DELETE') {
        deletes++; await slowClosed.promise; res.writeHead(204); res.end(); return;
      }
      const value = parseRequest(req.url as string); gets++;
      if (gets === 1) {
        res.writeHead(200, Object.fromEntries(response(plan, value).headers)); res.end(Buffer.alloc(60 * 12800)); return;
      }
      res.once('close', () => {slowClosed.resolve();});
      if (mode === 'pcm') {
        res.writeHead(200, Object.fromEntries(response(plan, value).headers)); res.write(Buffer.alloc(8));
      } else {
        res.writeHead(409, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.write('{"ok":false,');
      }
      slowEntered.resolve();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected a bound TCP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = makeClient({readPlan: async () => plan,
      fetcher: (url: string, options: RequestInit) => fetch(`${origin}${url}`, options)});
    const session = await client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal}); session.takeInitialBlock();
    const abort = new AbortController(), pending = session.loadBlock(60, abort.signal);
    await slowEntered.promise; await tick(); await tick(); abort.abort();
    await assert.rejects(pending, {code: 'AUDIO_PREVIEW_CANCELLED'});
    await session.dispose(); assert.equal(gets, 2); assert.equal(deletes, 1);
    await slowClosed.promise;
  });
}

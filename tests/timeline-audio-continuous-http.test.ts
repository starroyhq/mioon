import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTimelineAudioContinuousHttp} from '../apps/server/src/timeline-audio-continuous-http.ts';
import {continuousAudioQuery, CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_PROFILE,
  CONTINUOUS_AUDIO_HEADERS} from '../packages/contracts/src/timeline-audio-continuous.ts';

const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
interface BlockInput {projectId: string; timelineId: string; expectedRevision: number; startFrame: number; planHash: string; sessionId: string; generation: number; sequence: number; blockStartFrame: number}
interface Written {promise: Promise<void>; resolve: () => void}
class Request extends EventEmitter {
  method: string; url: string; headers: Record<string, string>;
  constructor(url: URL, method = 'GET') {super(); this.method = method; this.url = url.pathname + url.search; this.headers = {};}
}
class Response extends EventEmitter {
  destroyed = false; writableEnded = false; writableFinished = false; headersSent = false;
  headers: Record<string, string | number> = {}; written: Written; status?: number; body?: unknown;
  constructor() {super(); this.written = Promise.withResolvers<void>();}
  setHeader(name: string, value: string | number): void {this.headers[name.toLowerCase()] = value;}
  writeHead(status: number, headers: Record<string, string | number>): void {this.status = status; this.headersSent = true; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);}
  end(body?: unknown): void {this.body = body; this.writableEnded = true; this.written.resolve();}
  destroy(): this {this.destroyed = true; return this;}
  finish(): void {this.writableFinished = true; this.emit('finish');}
  close(): void {this.destroyed = true; this.emit('close');}
}
interface Fixture {input: BlockInput; url: URL; pcm: Buffer; state: {consuming: boolean; done: boolean; retired: boolean}; service: Record<string, unknown>}
function fixture(overrides: Record<string, unknown> = {}): Fixture {
  const input: BlockInput = {projectId: randomUUID(), timelineId: randomUUID(), expectedRevision: 1, startFrame: 0,
    planHash: 'a'.repeat(64), sessionId: randomUUID(), generation: 1, sequence: 1, blockStartFrame: 0};
  const url = new URL(`http://127.0.0.1${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(input)}`);
  const pcm = Buffer.alloc(60 * 12800), state = {consuming: false, done: false, retired: false};
  const service: Record<string, unknown> = {
    async consumeBlock(raw: unknown, options: {signal: AbortSignal; onResourceSettlement?: (value: Promise<void>) => void; consume: (value: unknown, context: unknown) => Promise<void>}) {
      assert.deepEqual(raw, input); const completion = Promise.withResolvers<void>(); options.onResourceSettlement?.(completion.promise);
      state.consuming = true;
      try {await options.consume({pcm}, {plan: {profileId: CONTINUOUS_AUDIO_PROFILE, planHash: input.planHash}, input,
        startFrame: 0, endFrame: 60, sampleFrames: 96000, signal: options.signal,
        beforeEffect() {if (options.signal.aborted) throw Object.assign(Error('cancelled'), {code: 'OPERATION_CANCELLED'});}});}
      finally {state.done = true; completion.resolve();}
    },
    async retireSession(raw: unknown) {assert.deepEqual(raw, input); state.retired = true;},
    ...overrides,
  };
  return {input, url, pcm, state, service};
}

test('continuous HTTP binds all response clocks/identities and retains Buffer through finish', async () => {
  const f = fixture(), req = new Request(f.url), res = new Response();
  const handler = createTimelineAudioContinuousHttp({service: f.service as never, assertAvailable() {}}), work = handler(req as never, res as never, f.url);
  await res.written.promise;
  assert.equal(res.body, f.pcm); assert.equal(f.state.done, false);
  const headers = CONTINUOUS_AUDIO_HEADERS as unknown as Record<string, string>;
  for (const [key, expected] of Object.entries({profile: CONTINUOUS_AUDIO_PROFILE, planHash: f.input.planHash, session: f.input.sessionId,
    generation: '1', sequence: '1', startFrame: '0', endFrame: '60', sampleFrames: '96000'}))
    assert.equal(res.headers[headers[key].toLowerCase()], expected);
  res.finish(); assert.equal(await work, true); assert.equal(f.state.done, true);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('destroy after cancellation waits observed transport close and native settlement', async () => {
  const f = fixture(), req = new Request(f.url), res = new Response(), controller = new AbortController();
  let resources: Promise<void> | undefined, finished = false;
  const handler = createTimelineAudioContinuousHttp({service: f.service as never, signal: controller.signal, assertAvailable() {}, nativeAdmission: {
    acceptContinuous(_req: unknown, _res: unknown, _url: unknown, input: unknown) {assert.deepEqual(input, f.input); return {signal: new AbortController().signal,
      onResourceSettlement(value: Promise<void>) {resources = value;}, finish() {finished = true;}};},
  } as never});
  const work = handler(req as never, res as never, f.url); await res.written.promise;
  let settled = false; resources!.then(() => {settled = true;}); controller.abort(); await tick();
  assert.equal(res.destroyed, true); assert.equal(f.state.done, false); assert.equal(settled, false); assert.equal(finished, false);
  res.close(); await work; assert.equal(settled, true); assert.equal(finished, true);
});

test('DELETE authenticates canonical request and awaits actual session retirement', async () => {
  const release = Promise.withResolvers<void>(), f = fixture({retireSession: async () => release.promise}), req = new Request(f.url, 'DELETE'), res = new Response();
  let settled = false;
  const handler = createTimelineAudioContinuousHttp({service: f.service as never, assertAvailable() {}, nativeAdmission: {
    acceptContinuous() {return {signal: new AbortController().signal, onResourceSettlement(value: Promise<void>) {value.then(() => {settled = true;});}, finish() {}};},
  } as never});
  const work = handler(req as never, res as never, f.url); await tick(); assert.equal(res.headersSent, false);
  release.resolve(); await work; assert.equal(settled, true); assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body as string).status, 'retired');
});

test('malformed/reordered/duplicate inputs and restored profiles reject before media service', async () => {
  let calls = 0; const f = fixture({consumeBlock: async () => {calls++;}});
  for (const search of [f.url.search + '&sequence=1', f.url.search.replace('generation=1', 'generation=01'), '?sequence=1&' + f.url.search.slice(1)]) {
    const url = new URL(f.url); url.search = search; const req = new Request(url), res = new Response();
    await createTimelineAudioContinuousHttp({service: f.service as never, assertAvailable() {}})(req as never, res as never, url);
    assert.equal(res.status, 400);
  }
  const req = new Request(f.url), res = new Response();
  await createTimelineAudioContinuousHttp({service: f.service as never, assertAvailable() {throw Object.assign(Error('restore'), {code: 'RESTORE_OPERATION_UNAVAILABLE', status: 403});}})(req as never, res as never, f.url);
  assert.equal(res.status, 403); assert.equal(calls, 0);
});

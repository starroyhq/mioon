import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTimelineAudioContinuousHttp} from '../apps/server/src/timeline-audio-continuous-http.ts';
import {continuousAudioQuery, CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_PROFILE,
  CONTINUOUS_AUDIO_HEADERS} from '../packages/contracts/src/timeline-audio-continuous.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Request extends EventEmitter {
  constructor(url, method = 'GET') {super(); this.method = method; this.url = url.pathname + url.search; this.headers = {};}
}
class Response extends EventEmitter {
  constructor() {super(); this.destroyed = false; this.writableEnded = false; this.writableFinished = false; this.headersSent = false; this.headers = {}; this.written = Promise.withResolvers();}
  setHeader(name, value) {this.headers[name.toLowerCase()] = value;}
  writeHead(status, headers) {this.status = status; this.headersSent = true; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);}
  end(body) {this.body = body; this.writableEnded = true; this.written.resolve();}
  destroy() {this.destroyed = true; return this;}
  finish() {this.writableFinished = true; this.emit('finish');}
  close() {this.destroyed = true; this.emit('close');}
}
function fixture(overrides = {}) {
  const input = {projectId: randomUUID(), timelineId: randomUUID(), expectedRevision: 1, startFrame: 0,
    planHash: 'a'.repeat(64), sessionId: randomUUID(), generation: 1, sequence: 1, blockStartFrame: 0};
  const url = new URL(`http://127.0.0.1${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(input)}`);
  const pcm = Buffer.alloc(60 * 12800), state = {consuming: false, done: false, retired: false};
  const service = {
    async consumeBlock(raw, options) {
      assert.deepEqual(raw, input); const completion = Promise.withResolvers(); options.onResourceSettlement?.(completion.promise);
      state.consuming = true;
      try {await options.consume({pcm}, {plan: {profileId: CONTINUOUS_AUDIO_PROFILE, planHash: input.planHash}, input,
        startFrame: 0, endFrame: 60, sampleFrames: 96000, signal: options.signal,
        beforeEffect() {if (options.signal.aborted) throw Object.assign(Error('cancelled'), {code: 'OPERATION_CANCELLED'});}});}
      finally {state.done = true; completion.resolve();}
    },
    async retireSession(raw) {assert.deepEqual(raw, input); state.retired = true;},
    ...overrides,
  };
  return {input, url, pcm, state, service};
}

test('continuous HTTP binds all response clocks/identities and retains Buffer through finish', async () => {
  const f = fixture(), req = new Request(f.url), res = new Response();
  const handler = createTimelineAudioContinuousHttp({service: f.service, assertAvailable() {}}), work = handler(req, res, f.url);
  await res.written.promise;
  assert.equal(res.body, f.pcm); assert.equal(f.state.done, false);
  for (const [key, expected] of Object.entries({profile: CONTINUOUS_AUDIO_PROFILE, planHash: f.input.planHash, session: f.input.sessionId,
    generation: '1', sequence: '1', startFrame: '0', endFrame: '60', sampleFrames: '96000'}))
    assert.equal(res.headers[CONTINUOUS_AUDIO_HEADERS[key].toLowerCase()], expected);
  res.finish(); assert.equal(await work, true); assert.equal(f.state.done, true);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('destroy after cancellation waits observed transport close and native settlement', async () => {
  const f = fixture(), req = new Request(f.url), res = new Response(), controller = new AbortController();
  let resources, finished = false;
  const handler = createTimelineAudioContinuousHttp({service: f.service, signal: controller.signal, assertAvailable() {}, nativeAdmission: {
    acceptContinuous(_req, _res, _url, input) {assert.deepEqual(input, f.input); return {signal: new AbortController().signal,
      onResourceSettlement(value) {resources = value;}, finish() {finished = true;}};},
  }});
  const work = handler(req, res, f.url); await res.written.promise;
  let settled = false; resources.then(() => {settled = true;}); controller.abort(); await tick();
  assert.equal(res.destroyed, true); assert.equal(f.state.done, false); assert.equal(settled, false); assert.equal(finished, false);
  res.close(); await work; assert.equal(settled, true); assert.equal(finished, true);
});

test('DELETE authenticates canonical request and awaits actual session retirement', async () => {
  const release = Promise.withResolvers(), f = fixture({retireSession: async () => release.promise}), req = new Request(f.url, 'DELETE'), res = new Response();
  let settled = false;
  const handler = createTimelineAudioContinuousHttp({service: f.service, assertAvailable() {}, nativeAdmission: {
    acceptContinuous() {return {signal: new AbortController().signal, onResourceSettlement(value) {value.then(() => {settled = true;});}, finish() {}};},
  }});
  const work = handler(req, res, f.url); await tick(); assert.equal(res.headersSent, false);
  release.resolve(); await work; assert.equal(settled, true); assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).status, 'retired');
});

test('malformed/reordered/duplicate inputs and restored profiles reject before media service', async () => {
  let calls = 0; const f = fixture({consumeBlock: async () => {calls++;}});
  for (const search of [f.url.search + '&sequence=1', f.url.search.replace('generation=1', 'generation=01'), '?sequence=1&' + f.url.search.slice(1)]) {
    const url = new URL(f.url); url.search = search; const req = new Request(url), res = new Response();
    await createTimelineAudioContinuousHttp({service: f.service, assertAvailable() {}})(req, res, url);
    assert.equal(res.status, 400);
  }
  const req = new Request(f.url), res = new Response();
  await createTimelineAudioContinuousHttp({service: f.service, assertAvailable() {throw Object.assign(Error('restore'), {code: 'RESTORE_OPERATION_UNAVAILABLE', status: 403});}})(req, res, f.url);
  assert.equal(res.status, 403); assert.equal(calls, 0);
});

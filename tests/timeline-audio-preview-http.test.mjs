import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineAudioPreviewHttp} from '../apps/server/src/timeline-audio-preview-http.ts';
import {createTimelineAudioPreviewServices} from '../packages/business/src/timeline-audio-preview.ts';
import {createTimelineAudioPreviewClient} from '../apps/web/src/timeline-audio-preview-client.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
async function bounded(promise, label, ms = 3000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);})]);}
  finally {clearTimeout(timer);}
}
class Request extends EventEmitter {
  constructor(url) {super(); this.method = 'GET'; this.url = url.pathname + url.search; this.headers = {};}
}
// A deliberate causal fake: destroy requests transport teardown, but does not
// pretend the transport has emitted close or released its retained Buffer.
class Response extends EventEmitter {
  constructor() {
    super(); this.destroyed = false; this.writableEnded = false; this.writableFinished = false; this.headersSent = false;
    this.headers = {}; this.heads = []; this.destroyCalls = 0; this.written = deferred();
  }
  setHeader(name, value) {this.headers[name.toLowerCase()] = value;}
  writeHead(status, headers) {this.statusCode = status; this.headersSent = true; this.heads.push(status); for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);}
  end(body) {this.body = body; this.writableEnded = true; this.written.resolve();}
  destroy() {this.destroyed = true; this.destroyCalls++; return this;}
  close() {this.destroyed = true; this.emit('close');}
  finish() {this.writableFinished = true; this.emit('finish');}
}
async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const projectId = randomUUID(), timelineId = randomUUID(), trackId = randomUUID(), assetId = randomUUID(), clipId = randomUUID();
  const input = {projectId, timelineId, expectedRevision: 1, startFrame: 0};
  const snapshot = {timeline: {id: timelineId, projectId, revision: 1, fps: 30, durationFrames: 2,
    tracks: [{id: trackId, kind: 'audio', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: clipId, trackId, assetId, startFrame: 0, durationFrames: 2, sourceInFrame: 0, gain: 1}]},
  assets: [{id: assetId, projectId, sha256: sha('synthetic source identity'), sizeBytes: 1024,
    mimeType: 'audio/wav', duration: 1, hasAudio: true, relativePath: 'synthetic.wav'}]};
  const identity = {dev: 1, ino: 2, size: 1024, mtimeMs: 3, ctimeMs: 4}, pcm = Buffer.alloc(2 * 1600 * 8);
  for (let sample = 0; sample < 3200; sample++) {pcm.writeFloatLE(0.25, sample * 8); pcm.writeFloatLE(-0.5, sample * 8 + 4);}
  let decodes = 0;
  const audio = createTimelineAudioPreviewServices({db, root: '/synthetic-owned-root'}, {runtime: {
    assertOrdinaryWorkspace() {}, ownsLock: () => true, readSavedTimeline: () => snapshot,
    validateSource: () => ({file: '/synthetic-owned-root/synthetic.wav', info: identity}),
    hash: async (_root, asset, options) => {
      options.beforeEffect(); options.onBytes(asset.sizeBytes);
      return {file: '/synthetic-owned-root/synthetic.wav', info: identity, sha256: asset.sha256, sizeBytes: asset.sizeBytes};
    },
    decode: async () => {decodes++; return {pcm, sampleRate: 48000, channels: 2, sampleFrames: 3200, source: {sizeBytes: 1024, durationSeconds: 1}};},
    terminate: async () => [], waitForClose: async () => [], boundedShutdown: work => bounded(work, 'Service drain'),
  }});
  // Real business admission/lifecycle, with synthetic source I/O only. Exact
  // FFmpeg and actual socket cancellation are covered in the transport suite.
  const responses = [];
  t.after(async () => {for (const response of responses) response.close(); await audio.drain(); db.close();});
  const plan = await audio.handlers['timeline.audioPreview.plan'](input);
  const sourceInput = {...input, clipId, sourceHash: plan.sources[0].sourceHash, planHash: plan.planHash};
  const url = new URL('http://127.0.0.1/api/timeline-audio-preview/pcm?' + new URLSearchParams(sourceInput));
  return {audio, snapshot, plan, input, sourceInput, pcm, get decodes() {return decodes;},
    start({signal, beforeTransportFence = () => {}} = {}) {
      const req = new Request(url), res = new Response(); responses.push(res);
      let consumerSettled = false, fences = 0, attemptSignal;
      const consumed = deferred();
      const service = {consumeSource(value, options) {
        return audio.consumeSource(value, {...options, consume: async (decoded, context) => {
          attemptSignal = context.signal;
          try {return await options.consume(decoded, {...context, beforeEffect: () => {beforeTransportFence(++fences); context.beforeEffect();}});}
          finally {consumerSettled = true; consumed.resolve();}
        }});
      }};
      const handler = createTimelineAudioPreviewHttp({service, signal, assertAvailable() {}});
      const work = handler(req, res, url);
      return {req, res, work, consumed: consumed.promise, get consumerSettled() {return consumerSettled;},
        get fences() {return fences;}, get attemptSignal() {return attemptSignal;}};
    },
    again: () => audio.consumeSource(sourceInput, {consume: async decoded => decoded.pcm.byteLength}),
  };
}

test('HTTP response cancellation initiates destroy but actual admission stays occupied until consumer close', {timeout: 10000}, async t => {
  const f = await fixture(t), abort = new AbortController(), call = f.start({signal: abort.signal});
  await bounded(call.res.written.promise, 'PCM response write');
  assert.equal(call.res.body, f.pcm, 'Response holds the exact bounded decoder Buffer without copy');
  assert.equal(call.consumerSettled, false); assert.equal(call.attemptSignal.aborted, false);
  abort.abort(); await tick();
  assert.ok(call.res.destroyCalls >= 1, 'Cancellation requests response destruction');
  assert.equal(call.attemptSignal.aborted, true); assert.equal(call.consumerSettled, false, 'destroy() alone does not establish consumer close');
  await assert.rejects(f.again(), {code: 'AUDIO_PREVIEW_BUSY'});
  assert.equal(f.decodes, 1, 'An aborted public observer cannot free the actual decoder/transport permit');
  call.res.close(); await bounded(call.consumed, 'Actual transport-close consumer settlement'); await bounded(call.work, 'HTTP adapter settlement'); await tick();
  assert.equal(call.consumerSettled, true); assert.equal(await f.again(), f.pcm.length); assert.equal(f.decodes, 2);
  for (const event of ['finish', 'close', 'error']) assert.equal(call.res.listenerCount(event), 0, event + ' listener cleanup');
  assert.equal(call.req.listenerCount('aborted'), 0);
});

test('response error also retains the consumer and permit until actual close rather than destroy return', {timeout: 10000}, async t => {
  const f = await fixture(t), call = f.start(); await bounded(call.res.written.promise, 'PCM write');
  call.res.emit('error', Error('synthetic response failure')); await tick();
  assert.ok(call.res.destroyCalls >= 1); assert.equal(call.consumerSettled, false);
  await assert.rejects(f.again(), {code: 'AUDIO_PREVIEW_BUSY'});
  call.res.close(); await bounded(call.work, 'Failed response settlement'); await bounded(call.consumed, 'Failed consumer settlement'); await tick();
  assert.equal(await f.again(), f.pcm.length); assert.deepEqual(call.res.heads, [200], 'Never sends a second JSON response after PCM headers');
});

test('the last synchronous saved-revision fence runs immediately before headers and revokes publication', {timeout: 10000}, async t => {
  const f = await fixture(t), call = f.start({beforeTransportFence: count => {if (count === 2) f.snapshot.timeline.revision++;}});
  await tick();
  assert.equal(call.fences, 2); assert.ok(call.res.destroyCalls >= 1);
  assert.deepEqual(call.res.heads, [], 'No PCM header is published after final revision revocation'); assert.equal(call.res.body, undefined);
  assert.equal(call.consumerSettled, false, 'Even synchronous final-fence rejection must retain the consumer until close');
  f.snapshot.timeline.revision = 1;
  await assert.rejects(f.again(), {code: 'AUDIO_PREVIEW_BUSY'});
  call.res.close(); await bounded(call.work, 'Revoked response settlement'); await bounded(call.consumed, 'Revoked consumer close'); await tick();
  assert.equal(await f.again(), f.pcm.length);
});

test('normal response completion releases admission only after finish and cleans request/response listeners', {timeout: 10000}, async t => {
  const f = await fixture(t), call = f.start(); await bounded(call.res.written.promise, 'PCM write');
  assert.equal(call.consumerSettled, false); await assert.rejects(f.again(), {code: 'AUDIO_PREVIEW_BUSY'});
  call.res.finish(); assert.equal(await bounded(call.work, 'Successful response'), true);
  assert.equal(call.consumerSettled, true); assert.equal(call.attemptSignal.aborted, true, 'Completed service attempt disposes its private signal'); assert.equal(call.fences, 3);
  assert.equal(call.res.destroyCalls, 0); assert.equal(await f.again(), f.pcm.length);
  for (const event of ['finish', 'close', 'error']) assert.equal(call.res.listenerCount(event), 0);
  assert.equal(call.req.listenerCount('aborted'), 0);
});

test('an interrupted partial HTTP PCM body never resolves a playable prepared interval', {timeout: 10000}, async t => {
  const f = await fixture(t), call = f.start(); await bounded(call.res.written.promise, 'PCM write');
  let streamController, playable = false, allocated = 0; const allocation = deferred();
  const body = new ReadableStream({start(controller) {streamController = controller; controller.enqueue(new Uint8Array(f.pcm.subarray(0, 137)));}});
  const context = {sampleRate: 48000, createBuffer(channels, length, sampleRate) {
    allocated++; allocation.resolve(); const data = [new Float32Array(length), new Float32Array(length)];
    return {sampleRate, length, numberOfChannels: channels, getChannelData: channel => data[channel]};
  }};
  const client = createTimelineAudioPreviewClient({readPlan: async () => f.plan, fetcher: async () => new globalThis.Response(body, {status: 200, headers: call.res.headers})});
  const work = client.prepare(f.input, {context, signal: new AbortController().signal}).then(value => {playable = true; return value;});
  const rejected = assert.rejects(work);
  await bounded(allocation.promise, 'Partial PCM buffer allocation'); assert.equal(allocated, 1); assert.equal(playable, false);
  call.res.close(); streamController.error(Error('Synthetic socket closed after 137 PCM bytes'));
  await rejected; await bounded(call.work, 'Partial transport closure'); await bounded(call.consumed, 'Partial consumer settlement');
  assert.equal(playable, false, 'An allocated/partially populated AudioBuffer is never a prepared result');
});

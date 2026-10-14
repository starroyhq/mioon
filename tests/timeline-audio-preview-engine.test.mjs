import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUDIO_PREVIEW_PROFILE, audioPreviewPlanSchema, audioPreviewPlanDigestMaterial } from '@mioon/contracts/timeline-audio-preview';
import { timelineCompositionSegments } from '@mioon/contracts/timeline-segments';
import { createTimelineAudioPreviewTransport, scheduleTimelineAudioPreviewGraph, AUDIO_PREVIEW_SCHEDULE_LEAD_SECONDS } from '../apps/web/src/timeline-audio-preview-engine.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = n => String(n).padStart(64, '0');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
function plan({ start = 10, end = 50, voices = [{}] } = {}) {
  const sourceMap = new Map(), aliases = new Map();
  const rows = voices.map((patch, index) => ({ clipId: id(index + 10), trackId: id(index + 30), sourceKey: key(index + 1), startFrame: 0, durationFrames: 60,
    sourceInFrame: 0, gain: 1, fadeInFrames: 20, fadeOutFrames: 20, ...patch }));
  const audibleEnd = Math.max(0, ...rows.map(voice => voice.startFrame + voice.durationFrames)), durationFrames = Math.max(end, audibleEnd);
  // A muted tail, when needed, supplies the saved timeline's real final edge.
  const clips = [...rows, ...(durationFrames > audibleEnd ? [{ startFrame: audibleEnd, durationFrames: durationFrames - audibleEnd, muted: true }] : [])];
  const segments = timelineCompositionSegments({ durationFrames, clips });
  rows.forEach((voice, index) => {
    voice.intersectionStartFrame = Math.max(start, voice.startFrame); voice.intersectionEndFrame = Math.min(end, voice.startFrame + voice.durationFrames);
    const decodeSegments = segments.filter(segment => segment.beginFrame >= voice.startFrame && segment.endFrame <= voice.startFrame + voice.durationFrames)
      .flatMap(segment => {
        const from = Math.max(start, segment.beginFrame), to = Math.min(end, segment.endFrame);
        return from < to ? [{ sourceInFrame: voice.sourceInFrame + segment.beginFrame - voice.startFrame, frameCount: segment.endFrame - segment.beginFrame,
          trimStartFrame: from - segment.beginFrame, outputFrames: to - from }] : [];
      });
    const alias = voice.sourceKey;
    if (!aliases.has(alias)) aliases.set(alias, { assetId: id(index + 100), sourceHash: key(index + 90) });
    const identity = { ...aliases.get(alias), sourceInFrame: voice.sourceInFrame + voice.intersectionStartFrame - voice.startFrame,
      durationFrames: voice.intersectionEndFrame - voice.intersectionStartFrame, profileId: AUDIO_PREVIEW_PROFILE, decodeSegments };
    const sourceKey = hash(canonical(identity)); voice.sourceKey = sourceKey;
    if (!sourceMap.has(sourceKey)) sourceMap.set(sourceKey, { sourceKey, ...identity, clipId: voice.clipId,
      sampleFrames: identity.durationFrames * 1600, pcmBytes: identity.durationFrames * 12800, sourceBytes: 1000 });
  });
  const sources = [...sourceMap.values()], retainedPcmBytes = sources.reduce((a, s) => a + s.pcmBytes, 0), largestSourcePcmBytes = Math.max(0, ...sources.map(s => s.pcmBytes));
  const result = audioPreviewPlanSchema.parse({ schemaVersion: 1, status: 'planned', profileId: AUDIO_PREVIEW_PROFILE, projectId: id(1), timelineId: id(2), timelineRevision: 1, planHash: key(99),
    range: { startFrame: start, endFrame: end, startSample: start * 1600, endSample: end * 1600, sampleFrames: (end - start) * 1600 }, sources, voices: rows,
    memory: { retainedPcmBytes, largestSourcePcmBytes, transportReserveBytes: 2 * 1024 * 1024, admittedBytes: 2 * retainedPcmBytes + 2 * largestSourcePcmBytes + 2 * 1024 * 1024, hashReadBytes: sources.length * 2000 },
    work: { decodedSourceFrames: sources.reduce((total, source) => total + source.decodeSegments.reduce((n, segment) => n + segment.frameCount + 1, 0), 0),
      decodeSegments: sources.reduce((total, source) => total + source.decodeSegments.length, 0) } });
  result.planHash = hash(audioPreviewPlanDigestMaterial(result)); return result;
}
class Buffer {
  constructor(channels, frames, sampleRate) { this.numberOfChannels = channels; this.length = frames; this.sampleRate = sampleRate; }
  getChannelData() { throw Error('Production graph must never acquire PCM channel arrays'); }
}
class Source {
  constructor(context) { this.context = context; this.buffer = null; this.onended = null; this.connections = []; this.starts = []; this.stops = []; this.disconnects = 0; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnects++; }
  start(...args) { if (this.context.failStart) throw Error('device scheduling failed'); this.starts.push(args); }
  stop(...args) { this.stops.push(args); }
  end() { this.onended?.(); }
}
class Gain {
  constructor() { this.events = []; this.connections = []; this.disconnects = 0; this.gain = {
    value: 1,
    setValueAtTime: (value, time) => this.events.push({ kind: 'set', value, time }),
    linearRampToValueAtTime: (value, time) => this.events.push({ kind: 'ramp', value, time }),
  }; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnects++; }
}
class Context {
  constructor({ sampleRate = 48000, state = 'running' } = {}) { this.sampleRate = sampleRate; this.state = state; this.currentTime = 7; this.destination = {}; this.sources = []; this.gains = []; this.createdBuffers = []; this.events = new Map(); this.resumeCalls = 0; this.closeCalls = 0; this.resumes = []; }
  createBuffer(channels, length, rate) { const b = new Buffer(channels, length, rate); this.createdBuffers.push(b); return b; }
  createBufferSource() { const n = new Source(this); this.sources.push(n); return n; }
  createGain() { if (this.failGain) throw Error('failed node creation'); const n = new Gain(); this.gains.push(n); return n; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
  event(type) { for (const fn of this.events.get(type) ?? []) fn(); }
  setState(state) { this.state = state; this.event('statechange'); }
  resume() { this.resumeCalls++; const wait = this.resumes.shift(); if (wait) return wait.promise; this.state = 'running'; return Promise.resolve(); }
  close() { this.closeCalls++; this.state = 'closed'; this.event('statechange'); return Promise.resolve(); }
}
function setup(config = {}) {
  const prepared = config.plan ?? plan(config), context = config.context ?? new Context();
  const buffers = new Map(prepared.sources.map(source => [source.sourceKey, new Buffer(2, source.sampleFrames, 48000)]));
  const frames = new Map(); let frameId = 0; const changes = [];
  const transport = createTimelineAudioPreviewTransport({ context, plan: prepared, buffers, onChange: state => changes.push(state),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: handle => frames.delete(handle) });
  return { context, buffers, plan: prepared, transport, frames, changes, tick: () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('strict plan and actual 48k stereo exact buffers required before graph allocation', () => {
  const p = plan(), context = new Context(); const valid = new Map(p.sources.map(source => [source.sourceKey, new Buffer(2, source.sampleFrames, 48000)]));
  for (const bad of [new Map(), new Map([[p.sources[0].sourceKey, new Buffer(1, p.sources[0].sampleFrames, 48000)]]), new Map([[p.sources[0].sourceKey, new Buffer(2, p.sources[0].sampleFrames - 1, 48000)]]), new Map([[p.sources[0].sourceKey, new Buffer(2, p.sources[0].sampleFrames, 44100)]])])
    assert.throws(() => createTimelineAudioPreviewTransport({ context, plan: p, buffers: bad }), /exact|stereo/);
  assert.throws(() => createTimelineAudioPreviewTransport({ context: new Context({ sampleRate: 44100 }), plan: p, buffers: valid }), /48000/);
  assert.throws(() => createTimelineAudioPreviewTransport({ context, plan: { ...p, extra: true }, buffers: valid }));
  assert.throws(() => createTimelineAudioPreviewTransport({ context, plan: { ...p, range: { ...p.range, endFrame: 611, endSample: 977600, sampleFrames: 961600 } }, buffers: valid }));
  assert.equal(context.sources.length, 0);
});

test('production graph uses exact single clock, clipped source offset, original envelope, half-open duration', () => {
  const f = setup(), cursor = 17 * 1600 + 317;
  assert.deepEqual(f.plan.sources[0].decodeSegments, [{ sourceInFrame: 0, frameCount: 60, trimStartFrame: 10, outputFrames: 40 }]);
  assert.deepEqual(f.plan.work, { decodedSourceFrames: 61, decodeSegments: 1 });
  const graph = scheduleTimelineAudioPreviewGraph({ ...f, cursorSample: cursor, originTime: 8 });
  const source = f.context.sources[0], events = f.context.gains[0].events;
  near(source.starts[0][0], 8); near(source.starts[0][1], (cursor - 16000) / 48000); near(source.starts[0][2], (80000 - cursor) / 48000);
  near(events[0].value, cursor / 32000); near(events[1].value, 1); near(events[1].time, 8 + (32000 - cursor) / 48000);
  near(events.at(-1).value, .5); // Prepared end cuts through original fade-out.
  assert.equal(source.connections[0], f.context.gains[0]); assert.equal(f.context.gains[0].connections[0], f.context.destination);
  assert.equal(graph.nodeCount, 2); near(graph.endTime, 8 + (80000 - cursor) / 48000);
  assert.deepEqual(f.context.createdBuffers.map(b => [b.numberOfChannels, b.length]), [[2, 1]]);
  graph.stop(); graph.stop(); assert.equal(source.disconnects, 1); assert.equal(source.buffer, null);
});

test('overlapping tracks retain additive gain and exact shared buffer, with no normalization', () => {
  const f = setup({ voices: [{ gain: 2, fadeInFrames: 0, fadeOutFrames: 0 }, { sourceKey: key(1), gain: 2, fadeInFrames: 0, fadeOutFrames: 0 }] });
  scheduleTimelineAudioPreviewGraph({ ...f, cursorSample: 16000, originTime: 8 });
  assert.equal(f.buffers.size, 1); assert.equal(f.context.sources[0].buffer, f.context.sources[1].buffer);
  assert.equal(f.context.gains.length, 2); assert.deepEqual(f.context.gains.map(g => g.events[0].value), [2, 2]);
  assert.deepEqual(f.context.sources.slice(0, 2).map(s => s.starts[0][0]), [8, 8]);
});

test('future voice onset and silent trailing interval use the same audio end sentinel', () => {
  const f = setup({ voices: [{ startFrame: 20, durationFrames: 10, fadeInFrames: 0, fadeOutFrames: 0 }] }); let ended = 0;
  const graph = scheduleTimelineAudioPreviewGraph({ ...f, cursorSample: 16000, originTime: 8, onEnded: () => ended++ });
  near(f.context.sources[0].starts[0][0], 8 + 1 / 3); near(f.context.sources[0].starts[0][2], 1 / 3);
  f.context.sources[0].end(); assert.equal(ended, 0);
  const sentinel = f.context.sources.at(-1); assert.equal(sentinel.loop, true); near(sentinel.stops[0][0], graph.endTime);
  sentinel.end(); sentinel.end(); assert.equal(ended, 1);
  const silent = setup({ voices: [] }); let emptyEnded = 0;
  scheduleTimelineAudioPreviewGraph({ ...silent, cursorSample: 16000, originTime: 8, onEnded: () => emptyEnded++ });
  assert.equal(silent.context.sources.length, 1); silent.context.sources[0].end(); assert.equal(emptyEnded, 1);
});

test('pause retains sample-precise cursor, resume never restarts the original fade', async () => {
  const f = setup(); assert.equal(await f.transport.play(), true);
  const anchor = 7 + AUDIO_PREVIEW_SCHEDULE_LEAD_SECONDS;
  f.context.currentTime = anchor + 1237 / 48000; f.transport.pause();
  assert.deepEqual(f.transport.getState(), { status: 'paused', frame: 10, sample: 17237, reason: null });
  assert.equal(f.context.sources[0].buffer, null); assert.equal(f.context.closeCalls, 0);
  f.context.currentTime = 8; assert.equal(await f.transport.play(), true);
  const resumed = f.context.sources[2]; near(resumed.starts[0][0], 8.02); near(resumed.starts[0][1], 1237 / 48000);
  near(f.context.gains[1].events[0].value, 17237 / 32000);
  f.transport.pause(); await f.transport.dispose(); assert.equal(f.context.closeCalls, 1);
});

test('seek revokes old nodes and old onended cannot end replacement playback', async () => {
  const f = setup(); await f.transport.play(); const staleEnd = f.context.sources.at(-1).onended;
  f.context.currentTime = 8; assert.equal(f.transport.seek(25), true); assert.equal(f.transport.getState().sample, 40000);
  staleEnd(); assert.equal(f.transport.getState().status, 'playing'); assert.equal(f.transport.getState().sample, 40000);
  near(f.context.sources[2].starts[0][1], .5); near(f.context.gains[1].events[0].value, 1);
  assert.equal(f.transport.seek(50), true); assert.equal(f.transport.getState().status, 'ended');
  assert.equal(await f.transport.play(), true); assert.equal(f.transport.getState().sample, 16000);
});

test('pending resume is fenced by pause, seek and newer play before asynchronous completion', async () => {
  const context = new Context({ state: 'suspended' }), old = deferred(), latest = deferred(); context.resumes.push(old, latest);
  const f = setup({ context }); const a = f.transport.play(); f.transport.pause(); f.transport.seek(30); const b = f.transport.play();
  context.state = 'running'; latest.resolve(); assert.equal(await b, true); assert.equal(context.sources.length, 2);
  old.resolve(); assert.equal(await a, false); assert.equal(context.sources.length, 2); assert.equal(f.transport.getState().sample, 48000);
});

test('terminal stop before resume closes once and late failures cannot revive or rewrite it', async () => {
  for (const reject of [false, true]) {
    const context = new Context({ state: 'suspended' }), wait = deferred(); context.resumes.push(wait); const f = setup({ context });
    const playing = f.transport.play(); f.transport.stop('revoked'); f.transport.stop('explicit-stop');
    if (reject) wait.reject(Error('late')); else wait.resolve();
    assert.equal(await playing, false); assert.equal(context.sources.length, 0); assert.equal(context.closeCalls, 1);
    assert.equal(f.transport.getState().reason, 'revoked'); assert.equal(await f.transport.play(), false);
    await f.transport.dispose(); await f.transport.dispose(); assert.equal(context.closeCalls, 1);
  }
});

for (const [event, expected] of [['suspended', 'context-suspended'], ['interrupted', 'context-suspended'], ['closed', 'context-closed'], ['error', 'audio-output-failed']]) test(`${event} stops explicitly and never resumes automatically`, async () => {
  const f = setup(); await f.transport.play(); const staleEnd = f.context.sources.at(-1).onended;
  if (event === 'error') f.context.event('error'); else f.context.setState(event);
  assert.equal(f.transport.getState().status, 'stopped'); assert.equal(f.transport.getState().reason, expected);
  const calls = f.context.resumeCalls; f.context.setState('running'); staleEnd(); f.tick();
  assert.equal(f.transport.getState().status, 'stopped'); assert.equal(f.context.resumeCalls, calls);
  for (const source of f.context.sources) { assert.equal(source.disconnects, 1); assert.equal(source.buffer, null); }
});

test('outside and invalid seek revoke the complete interval rather than clamping or extending it', async () => {
  for (const frame of [9, 51, NaN, 10.1]) {
    const f = setup(); await f.transport.play(); assert.equal(f.transport.seek(frame), false);
    assert.equal(f.transport.getState().reason, 'outside-prepared-interval'); assert.equal(f.context.closeCalls, 1);
  }
});

test('RAF reports a clock cursor only; end state belongs solely to the active audio sentinel', async () => {
  const f = setup(); await f.transport.play(); const staleFrame = [...f.frames.values()][0];
  f.context.currentTime = 20; f.tick(); assert.equal(f.transport.getState().sample, 80000); assert.equal(f.transport.getState().status, 'playing');
  f.context.sources.at(-1).end(); assert.equal(f.transport.getState().status, 'ended'); assert.equal(f.frames.size, 0);
  const count = f.changes.length; staleFrame(0); assert.equal(f.changes.length, count);
  assert.equal(f.context.resumeCalls, 1); assert.equal(f.context.closeCalls, 0);
});

test('pending pause before schedule lead leaves exact cursor at the first sample', async () => {
  const f = setup(); await f.transport.play(); f.context.currentTime += .001; f.transport.pause(); assert.equal(f.transport.getState().sample, 16000);
});

test('node creation and scheduling failure tear down every partial graph and stop terminally', async () => {
  for (const flag of ['failGain', 'failStart']) {
    const f = setup(); f.context[flag] = true; assert.equal(await f.transport.play(), false);
    assert.equal(f.transport.getState().reason, 'schedule-failed'); assert.equal(f.context.closeCalls, 1);
    for (const source of f.context.sources) assert.equal(source.disconnects, 1);
    for (const gain of f.context.gains) assert.equal(gain.disconnects, 1);
  }
});


test('already-running ready context suspension is terminal; initial suspended context awaits an explicit gesture', async () => {
  const ready = setup(); ready.context.setState('suspended');
  assert.equal(ready.transport.getState().reason, 'context-suspended'); assert.equal(ready.context.closeCalls, 1);
  const initial = setup({ context: new Context({ state: 'suspended' }) }); initial.context.event('statechange');
  assert.equal(initial.transport.getState().status, 'ready'); assert.equal(initial.context.resumeCalls, 0);
  assert.equal(await initial.transport.play(), true);
});

test('synchronous revocation from a starting display notification precedes even the resume call', async () => {
  const prepared = plan(), context = new Context({ state: 'suspended' });
  const buffers = new Map(prepared.sources.map(source => [source.sourceKey, new Buffer(2, source.sampleFrames, 48000)]));
  let transport; transport = createTimelineAudioPreviewTransport({ context, plan: prepared, buffers, onChange: state => { if (state.status === 'starting') transport.stop('revoked'); } });
  assert.equal(await transport.play(), false); assert.equal(context.resumeCalls, 0); assert.equal(context.closeCalls, 1);
});


test('context close failure remains observable and idempotent for the owner retirement fence', async () => {
  for (const mode of ['reject', 'throw', 'unconfirmed']) {
    const context = new Context(); context.close = () => {
      context.closeCalls++;
      if (mode === 'throw') throw Error('close failed');
      if (mode === 'reject') return Promise.reject(Error('close failed'));
      return Promise.resolve();
    };
    const f = setup({ context }); await f.transport.play(); f.transport.stop('revoked');
    await assert.rejects(f.transport.dispose(), /close failed|closure was not confirmed/);
    await assert.rejects(f.transport.dispose(), /close failed|closure was not confirmed/);
    assert.equal(context.closeCalls, 1); assert.equal(f.transport.getState().status, 'disposed');
    assert.equal(await f.transport.play(), false);
  }
});

test('dispose acknowledgement waits for exact asynchronous context closure', async () => {
  const context = new Context(), wait = deferred();
  context.close = () => { context.closeCalls++; return wait.promise; };
  const f = setup({ context }); await f.transport.play(); let confirmed = false;
  const closing = f.transport.dispose().then(() => { confirmed = true; });
  await Promise.resolve(); assert.equal(confirmed, false); assert.equal(context.closeCalls, 1);
  context.state = 'closed'; wait.resolve(); await closing; assert.equal(confirmed, true);
});


test('late canceled RAF cannot erase the replacement generation paint handle', async () => {
  const f = setup(); await f.transport.play(); const stale = [...f.frames.values()][0];
  f.transport.seek(20); assert.equal(f.frames.size, 1);
  stale(0); f.transport.pause(); assert.equal(f.frames.size, 0);
});


test('reentrant playing notification cannot report success for a revoked graph', async () => {
  const prepared = plan(), context = new Context();
  const buffers = new Map(prepared.sources.map(source => [source.sourceKey, new Buffer(2, source.sampleFrames, 48000)]));
  let transport; transport = createTimelineAudioPreviewTransport({ context, plan: prepared, buffers, onChange: state => { if (state.status === 'playing') transport.stop('revoked'); } });
  assert.equal(await transport.play(), false); assert.equal(transport.getState().reason, 'revoked');
  assert.equal(context.closeCalls, 1); for (const source of context.sources) assert.equal(source.disconnects, 1);
});


test('intrinsic gain matches original envelope before a fractional first automation boundary', () => {
  for (const [voice, cursor, expected] of [
    [{ gain: 2, fadeInFrames: 0, fadeOutFrames: 0 }, 16000, 2],
    [{ gain: .75, fadeInFrames: 20, fadeOutFrames: 20 }, 17237, .75 * 17237 / 32000],
  ]) {
    const f = setup({ voices: [voice] });
    scheduleTimelineAudioPreviewGraph({ ...f, cursorSample: cursor, originTime: 7.02 + Number.EPSILON });
    near(f.context.gains[0].gain.value, expected);
    near(f.context.gains[0].events[0].value, expected);
  }
});

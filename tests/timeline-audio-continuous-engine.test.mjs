import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinuousTimelineAudioTransport } from '../apps/web/src/timeline-audio-continuous-engine.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Buffer {
  constructor(channels, length, sampleRate) { this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate; }
  getChannelData() { throw Error('Already mixed PCM must never be reacquired or rewritten by the engine'); }
}
class Source {
  constructor(context) { this.context = context; this.buffer = null; this.onended = null; this.starts = []; this.stops = []; this.disconnected = false; this.ended = false; }
  connect() {}
  disconnect() { this.disconnected = true; }
  start(when, offset, duration) {
    if (this.context.failStart) throw Error('Failed source start');
    this.starts.push([when, offset, duration]); this.scheduledBuffer = this.buffer;
  }
  stop() { this.stops.push(this.context.currentTime); }
  end() { if (this.ended) return; this.ended = true; this.onended?.(); }
}
class Context {
  constructor(state = 'running') { this.state = state; this.sampleRate = 48000; this.currentTime = 3; this.destination = {}; this.sources = []; this.events = new Map(); this.resumes = []; this.closeCalls = 0; this.resumeCalls = 0; }
  createBufferSource() { const source = new Source(this); this.sources.push(source); return source; }
  createBuffer(channels, length, sampleRate) { return new Buffer(channels, length, sampleRate); }
  addEventListener(type, listener) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(listener); }
  removeEventListener(type, listener) { this.events.get(type)?.delete(listener); }
  event(type) { for (const listener of this.events.get(type) ?? []) listener(); }
  setState(state) { this.state = state; this.event('statechange'); }
  resume() { this.resumeCalls++; const pending = this.resumes.shift(); if (pending) return pending.promise; this.state = 'running'; return Promise.resolve(); }
  close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); }
}
function setup({ duration = 750, start = 0, load, reset, context = new Context(), onChange } = {}) {
  const loads = [], resets = [], changes = [], frames = new Map(); let frameId = 0;
  const block = frame => ({ startFrame: frame, endFrame: Math.min(frame + 60, duration), buffer: new Buffer(2, Math.min(60, duration - frame) * 1600, 48000) });
  const transport = createContinuousTimelineAudioTransport({ context,
    plan: { startFrame: start, durationFrames: duration, blockFrames: 60, sampleRate: 48000, channels: 2 }, initialBlock: block(start),
    loadBlock: (frame, signal) => { loads.push({ frame, signal }); return load ? load(frame, signal, block) : Promise.resolve(block(frame)); },
    onReset: async (frame, signal) => { resets.push({ frame, signal }); await reset?.(frame, signal); },
    onChange: state => { changes.push(state); onChange?.(state); },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: handle => frames.delete(handle),
  });
  return { transport, context, block, loads, resets, changes, frames, paint() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('continuous engine requires the exact fixed clock and a complete mixed initial block', () => {
  const context = new Context(), initialBlock = { startFrame: 0, endFrame: 60, buffer: new Buffer(2, 96000, 48000) };
  const options = { context, plan: { startFrame: 0, durationFrames: 100, blockFrames: 60, sampleRate: 48000, channels: 2 }, initialBlock, loadBlock: async () => initialBlock };
  for (const patch of [{ plan: { ...options.plan, blockFrames: 600 } }, { plan: { ...options.plan, durationFrames: 18001 } },
    { initialBlock: { ...initialBlock, endFrame: 59 } }, { initialBlock: { ...initialBlock, buffer: new Buffer(1, 96000, 48000) } },
    { initialBlock: { ...initialBlock, buffer: new Buffer(2, 96000, 44100) } }, { initialBlock: { ...initialBlock, buffer: new Buffer(2, 95999, 48000) } }]) {
    assert.throws(() => createContinuousTimelineAudioTransport({ ...options, ...patch }), { code: 'AUDIO_PREVIEW_INVALID_GRAPH' });
  }
  assert.equal(context.sources.length, 0);
});

test('mount prepares no extra data and next block is scheduled on the exact common sample clock', async () => {
  const f = setup({ start: 7 }); assert.equal(f.loads.length, 0); assert.equal(f.context.sources.length, 0);
  assert.equal(await f.transport.play(), true); await tick();
  assert.deepEqual(f.loads.map(load => load.frame), [67]);
  const [a, b] = f.context.sources; near(a.starts[0][0], 3.02); near(b.starts[0][0], 5.02);
  assert.deepEqual(a.starts[0].slice(1), [0, 2]); assert.deepEqual(b.starts[0].slice(1), [0, 2]);
  assert.equal(f.transport.getState().heldBytes, 3_072_000);
  f.context.currentTime = 5.02; a.end(); await tick();
  assert.equal(a.buffer, null); assert.equal(a.disconnected, true); assert.equal(f.transport.getState().status, 'playing');
  assert.deepEqual(f.loads.map(load => load.frame), [67, 127]); near(f.context.sources[2].starts[0][0], 7.02);
  assert.equal(f.transport.getState().underruns, 0); await f.transport.dispose();
});

for (const duration of [750, 3600, 18000]) {
  test(`continuous ${duration / 30}s playback crosses every boundary with bounded buffers and exact final samples`, async () => {
    const f = setup({ duration }); await f.transport.play(); await tick();
    const initialTime = f.context.sources[0].starts[0][0];
    for (let frame = 0, index = 0; frame < duration; frame += 60, index++) {
      const source = f.context.sources[index], [when, offset, seconds] = source.starts[0];
      near(when, initialTime + frame / 30); assert.equal(offset, 0); near(seconds, Math.min(60, duration - frame) / 30);
      assert.equal(source.scheduledBuffer.length, Math.min(60, duration - frame) * 1600);
      f.context.currentTime = when + seconds; source.end(); await tick();
      assert.equal(source.buffer, null);
      assert.ok(f.transport.getState().heldBytes <= 3_072_000);
    }
    const state = f.transport.getState(); assert.equal(state.status, 'ended'); assert.equal(state.sample, duration * 1600);
    assert.equal(state.heldBytes, 0); assert.equal(state.underruns, 0); assert.equal(state.peakHeldBytes, 3_072_000);
    assert.equal(f.context.sources.length, Math.ceil(duration / 60)); await f.transport.dispose();
  });
}

test('underrun waits at the exact consumed boundary and resumes without skipping a block', async () => {
  const wait = deferred(), f = setup({ load: async (frame, _signal, block) => { if (frame === 60) await wait.promise; return block(frame); } });
  await f.transport.play(); await tick(); const first = f.context.sources[0];
  f.context.currentTime = 5.02; first.end();
  assert.equal(f.transport.getState().status, 'buffering'); assert.equal(f.transport.getState().sample, 96000);
  f.context.currentTime = 9; f.paint(); assert.equal(f.transport.getState().sample, 96000);
  wait.resolve(); await tick();
  assert.equal(f.transport.getState().status, 'playing'); assert.equal(f.transport.getState().underruns, 1);
  assert.deepEqual(f.context.sources[1].starts[0], [9.02, 0, 2]); await f.transport.dispose();
});

test('a late load before a delayed end notification cannot schedule in the past or count a false completion', async () => {
  const wait = deferred(), f = setup({ load: async (frame, _signal, block) => { if (frame === 60) await wait.promise; return block(frame); } });
  await f.transport.play(); await tick(); const oldEnded = f.context.sources[0].onended;
  f.context.currentTime = 6; wait.resolve(); await tick();
  assert.equal(f.transport.getState().underruns, 1); assert.equal(f.transport.getState().status, 'playing');
  near(f.context.sources[1].starts[0][0], 6.02); oldEnded(); assert.equal(f.transport.getState().status, 'playing');
  await f.transport.dispose();
});

test('pause stops both scheduled blocks, preserves exact sample cursor and resumes without reacquiring mixed PCM', async () => {
  const f = setup(); await f.transport.play(); await tick();
  f.context.currentTime = 3.02 + 1.123456; const before = f.transport.getState().sample;
  f.transport.pause(); assert.equal(f.transport.getState().sample, before); assert.equal(f.frames.size, 0);
  assert.ok(f.context.sources.every(source => source.buffer === null && source.disconnected));
  f.context.currentTime = 20; await f.transport.play();
  const resumed = f.context.sources[2]; near(resumed.starts[0][1], before / 48000);
  assert.equal(f.loads.length, 1); assert.equal(f.transport.getState().sample, before); await f.transport.dispose();
});

test('buffered playing and paused seek use retained blocks, while a stale source cannot end the replacement graph', async () => {
  const f = setup(); await f.transport.play(); await tick(); const staleEnded = f.context.sources[0].onended;
  assert.equal(await f.transport.seek(80), true); assert.equal(f.transport.getState().status, 'playing');
  assert.equal(f.transport.getState().frame, 80); near(f.context.sources[2].starts[0][1], 20 / 30);
  staleEnded(); assert.equal(f.transport.getState().status, 'playing');
  await tick(); f.transport.pause(); const count = f.loads.length;
  assert.equal(await f.transport.seek(90), true); assert.equal(f.transport.getState().status, 'paused'); assert.equal(f.loads.length, count);
  await f.transport.dispose();
});

test('rapid unbuffered seeks await exact prior retirement and allow only the latest request to become audible', async () => {
  const wait = deferred(); let active = 0, peak = 0;
  const f = setup({ load: async (frame, _signal, block) => { active++; peak = Math.max(peak, active); if (frame === 60) await wait.promise; active--; return block(frame); } });
  await f.transport.play(); await tick();
  const a = f.transport.seek(300), b = f.transport.seek(400), c = f.transport.seek(500);
  assert.equal(f.loads[0].signal.aborted, true); await tick(); assert.deepEqual(f.loads.map(load => load.frame), [60]);
  wait.resolve(); assert.deepEqual(await Promise.all([a, b, c]), [false, false, true]); await tick();
  assert.equal(peak, 1); assert.equal(f.transport.getState().frame, 500); assert.equal(f.transport.getState().status, 'playing');
  assert.deepEqual(f.resets.map(reset => reset.frame), [500]);
  assert.deepEqual(f.loads.map(load => load.frame), [60, 500, 560]); await f.transport.dispose();
});

test('paused unbuffered seek stays paused and does not prefetch beyond its complete target block', async () => {
  const f = setup(); assert.equal(await f.transport.seek(321), true);
  assert.equal(f.transport.getState().status, 'paused'); assert.equal(f.transport.getState().frame, 321);
  assert.deepEqual(f.loads.map(load => load.frame), [321]); assert.equal(f.context.sources.length, 0);
  await f.transport.dispose();
});

test('pause aborts prefetch, and resume waits for its exact settlement before retrying the same sequence', async () => {
  const wait = deferred(); let calls = 0;
  const f = setup({ load: async (frame, _signal, block) => { if (++calls === 1) await wait.promise; return block(frame); } });
  await f.transport.play(); await tick(); f.transport.pause(); await f.transport.play(); await tick();
  assert.equal(f.loads.length, 1); assert.equal(f.loads[0].signal.aborted, true);
  wait.resolve(); await tick(); assert.deepEqual(f.loads.map(load => load.frame), [60, 60]);
  assert.equal(f.transport.getState().status, 'playing'); await f.transport.dispose();
});

test('late resume acknowledgments cannot revive a paused, stopped or replaced generation', async () => {
  for (const action of ['pause', 'stop', 'seek']) {
    const context = new Context('suspended'), wait = deferred(); context.resumes.push(wait); const f = setup({ context });
    const played = f.transport.play();
    if (action === 'seek') await f.transport.seek(300); else f.transport[action]();
    if (action !== 'stop') context.state = 'running'; wait.resolve(); assert.equal(await played, false);
    if (action !== 'seek') assert.equal(context.sources.length, 0);
    await f.transport.dispose();
  }
});

test('a seek replacing a pending initial resume can start the newest position independently', async () => {
  const context = new Context('suspended'), wait = deferred(); context.resumes.push(wait);
  const f = setup({ context }); const old = f.transport.play();
  assert.equal(await f.transport.seek(300), true); assert.equal(context.resumeCalls, 2);
  assert.equal(f.transport.getState().status, 'playing'); assert.equal(f.transport.getState().frame, 300);
  wait.resolve(); assert.equal(await old, false); assert.equal(f.transport.getState().frame, 300);
  await f.transport.dispose();
});

test('out-of-order delayed block end events still transfer ownership through the exact final end', async () => {
  const f = setup({ duration: 120 }); await f.transport.play(); await tick();
  f.context.currentTime = 7.02; f.context.sources[1].end();
  assert.equal(f.transport.getState().status, 'playing'); f.context.sources[0].end();
  assert.equal(f.transport.getState().status, 'ended'); assert.equal(f.transport.getState().sample, 192000);
  assert.equal(f.transport.getState().heldBytes, 0); await f.transport.dispose();
});

test('stop and dispose retain the retirement fence through an ignored cancellation and close the exact context once', async () => {
  const wait = deferred(), f = setup({ load: async (frame, _signal, block) => { await wait.promise; return block(frame); } });
  await f.transport.play(); await tick(); f.transport.stop(); let closed = false;
  const closing = f.transport.dispose().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(f.context.closeCalls, 1); assert.equal(f.transport.getState().heldBytes, 0);
  wait.resolve(); await closing; assert.equal(closed, true); assert.equal(f.context.sources.length, 1);
  assert.equal(await f.transport.play(), false); await f.transport.dispose(); assert.equal(f.context.closeCalls, 1);
});

test('an unconfirmed reader retirement remains a failed fence after the original request leaves the flight slot', async () => {
  const f = setup({load: async () => { throw Object.assign(new Error('Reader cancellation was not confirmed'), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'}); }});
  await f.transport.play(); await tick();
  assert.equal(f.transport.getState().status, 'stopped'); assert.equal(f.transport.getState().errorCode, 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED');
  await assert.rejects(f.transport.dispose(), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
  await assert.rejects(f.transport.dispose(), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'}); assert.equal(f.context.closeCalls, 1);
});

test('a failed or unconfirmed exact context close stays rejected across repeated disposal', async () => {
  for (const mode of ['throw', 'reject', 'unconfirmed']) {
    const f = setup(); f.context.close = () => { f.context.closeCalls++; if (mode === 'throw') throw Error('Close failed'); if (mode === 'reject') return Promise.reject(Error('Close failed')); return Promise.resolve(); };
    await f.transport.play(); await tick(); f.transport.stop();
    await assert.rejects(f.transport.dispose(), /Close failed|closure was not confirmed/);
    await assert.rejects(f.transport.dispose(), /Close failed|closure was not confirmed/); assert.equal(f.context.closeCalls, 1);
  }
});

test('50 pause/resume rounds do not accumulate retained buffers, listeners or active sources', async () => {
  const f = setup(); await f.transport.play(); await tick();
  for (let i = 0; i < 50; i++) { f.context.currentTime += 0.01; f.transport.pause(); assert.equal(f.frames.size, 0); await f.transport.play(); }
  assert.equal(f.transport.getState().heldBytes, 3_072_000); assert.equal(f.loads.length, 1);
  assert.equal(f.context.sources.filter(source => source.buffer !== null).length, 2);
  await f.transport.dispose(); assert.equal(f.context.events.get('statechange').size, 0);
});

test('RAF paints only and never drives a boundary or pretends that an exhausted block completed the timeline', async () => {
  const wait = deferred(), f = setup({ load: async (frame, _signal, block) => { await wait.promise; return block(frame); } });
  await f.transport.play(); await tick(); f.context.currentTime = 80; f.paint();
  assert.equal(f.transport.getState().status, 'playing'); assert.equal(f.transport.getState().sample, 96000);
  assert.equal(f.context.sources.length, 1); f.context.sources[0].end(); assert.equal(f.transport.getState().status, 'buffering');
  f.transport.stop(); wait.resolve(); await f.transport.dispose();
});

test('replay reloads the original start and only the real timeline end reports ended', async () => {
  const f = setup({ duration: 85, start: 20 }); await f.transport.play(); await tick();
  f.context.currentTime = 5.02; f.context.sources[0].end(); assert.equal(f.transport.getState().status, 'playing');
  f.context.currentTime = 5.02 + 5 / 30; f.context.sources[1].end(); assert.equal(f.transport.getState().status, 'ended');
  assert.equal(f.transport.getState().frame, 85); await f.transport.play();
  assert.deepEqual(f.resets.map(reset => reset.frame), [20]); assert.equal(f.transport.getState().frame, 20);
  await f.transport.dispose();
});

test('block failures, schedule failure, context suspension and output failure stop the whole sound owner', async () => {
  const bad = setup({ load: async (_frame, _signal, block) => ({ ...block(60), buffer: new Buffer(2, 1, 48000) }) });
  await bad.transport.play(); await tick(); assert.equal(bad.transport.getState().reason, 'load-failed'); assert.equal(bad.transport.getState().errorCode, 'AUDIO_PREVIEW_INVALID_GRAPH'); await bad.transport.dispose();
  const failed = setup(); failed.context.failStart = true; assert.equal(await failed.transport.play(), false); assert.equal(failed.transport.getState().reason, 'schedule-failed'); await failed.transport.dispose();
  for (const mode of ['suspended', 'error']) {
    const f = setup(); await f.transport.play(); await tick();
    if (mode === 'error') f.context.event('error'); else f.context.setState(mode);
    assert.equal(f.transport.getState().status, 'stopped'); assert.equal(f.transport.getState().heldBytes, 0); await f.transport.dispose();
  }
});

test('synchronous starting and playing observers can revoke before further work is admitted', async () => {
  for (const phase of ['starting', 'playing']) {
    let owned; const f = setup({ onChange: state => { if (state.status === phase) owned.stop('revoked'); } }); owned = f.transport;
    assert.equal(await owned.play(), false); assert.equal(f.loads.length, 0); assert.equal(f.context.resumeCalls, phase === 'starting' ? 0 : 1);
    assert.equal(owned.getState().status, 'stopped'); await owned.dispose();
  }
});

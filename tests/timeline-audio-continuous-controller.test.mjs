import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuousAudioPreviewController} from '../apps/web/src/timeline-audio-continuous-controller.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
function fixture({pendingPrepare, pendingResume, pendingClose, pendingResources, pendingSessionClose, failClose = false, overrides = {}, onChange} = {}) {
  let context = {scope: 'project:workspace:epoch-1', executionScope: 'editing:timeline', projectId: id(1), timelineId: id(2), revision: 1,
    durationFrames: 18000, sourceIdentity: 'saved-source-identity', connected: true, visible: true, restored: false, hasUnsavedDrafts: false, ...overrides};
  const calls = {prepare: [], contexts: [], transports: [], sessions: [], positions: [], beforePlay: 0, unauthorized: 0, changes: []};
  const controller = createContinuousAudioPreviewController({getContext: () => context,
    readPlan: async () => { throw Error('Legacy twenty-second plan must not be invoked'); },
    readContinuousPlan: async () => { throw Error('Injected preparation owns plan requests'); },
    getInvocation: () => ({expectedWorkspaceOrigin: 'pinned-workspace-origin'}),
    createContext: () => {
      const audio = {sampleRate: 48000, state: 'running', closes: 0, resumes: 0,
        resume() { this.resumes++; return Promise.resolve(); },
        close() { this.closes++; if (failClose) return Promise.reject(Error('Close failed')); if (pendingClose) return pendingClose.promise.then(() => { this.state = 'closed'; }); this.state = 'closed'; return Promise.resolve(); }};
      calls.contexts.push(audio); return audio;
    },
    prepareContinuous: async (input, options) => {
      calls.prepare.push({input, options}); if (pendingResources) options.onResourceSettlement?.(pendingResources.promise);
      if (pendingPrepare) await pendingPrepare.promise;
      let closed = null, first = true;
      const session = {plan: {schemaVersion: 2, status: 'planned', profileId: 'saved-timeline-audio-continuous-f32le-48k-stereo-v2',
        projectId: input.projectId, timelineId: input.timelineId, timelineRevision: input.expectedRevision,
        startFrame: input.startFrame, durationFrames: 18000, blockFrames: 60, sampleRate: 48000, channels: 2,
        admittedBytes: 96 * 1024 * 1024, snapshotHash: 'a'.repeat(64), planHash: 'b'.repeat(64)}, closes: 0, takes: 0,
        takeInitialBlock() { assert.equal(first, true); first = false; this.takes++; return {startFrame: input.startFrame, endFrame: Math.min(input.startFrame + 60, 18000), buffer: {}}; },
        loadBlock: async () => { throw Error('Fake transport owns loading'); }, reset: async () => {},
        dispose() { if (!closed) { this.closes++; closed = pendingSessionClose ? pendingSessionClose.promise : Promise.resolve(); } return closed; }};
      calls.sessions.push(session); return session;
    },
    createContinuousTransport: options => {
      let disposed = false, generation = 0;
      let state = {status: 'ready', frame: options.initialBlock.startFrame, sample: options.initialBlock.startFrame * 1600,
        reason: null, errorCode: '', underruns: 0, heldBytes: 1536000, peakHeldBytes: 1536000};
      const emit = patch => { state = {...state, ...patch}; options.onChange(state); };
      const transport = {seeks: [], plays: 0, pauses: 0, disposals: 0,
        async play() { const token = ++generation; this.plays++; emit({status: 'starting'}); if (pendingResume) await pendingResume.promise;
          if (disposed || token !== generation) return false; emit({status: 'playing'}); return true; },
        pause() { generation++; this.pauses++; emit({status: 'paused'}); },
        async seek(frame) { generation++; this.seeks.push(frame); emit({frame, sample: frame * 1600, status: frame === 18000 ? 'ended' : state.status}); return true; },
        stop() { generation++; emit({status: 'stopped'}); },
        dispose() { generation++; disposed = true; this.disposals++; return options.context.close(); },
        getState: () => state,
        tick(frame) { emit({frame, sample: frame * 1600, status: 'playing'}); },
        buffer(frame) { emit({frame, sample: frame * 1600, status: 'buffering', underruns: 1, heldBytes: 0}); },
        fail(code) { emit({status: 'stopped', errorCode: code, reason: 'load-failed'}); },
        get disposed() { return disposed; },
      };
      calls.transports.push(transport); return transport;
    }, onExplicitPosition: frame => calls.positions.push(frame), onBeforePlay: () => { calls.beforePlay++; },
    onUnauthorized: () => { calls.unauthorized++; }, onChange: state => { calls.changes.push(state); onChange?.(state); },
  });
  controller.attach(context);
  return {controller, calls, get context() { return context; }, setContext(patch) { context = {...context, ...patch}; controller.setContext(context); },
    changeWithoutEffect(patch) { context = {...context, ...patch}; }};
}

test('mount and draft or locale presentation refresh never allocate, fetch or autoplay a continuous session', async () => {
  const f = fixture(); f.controller.setContext({...f.context});
  const unsaved = {rawGain: '1.', rawFade: '', candidate: {gain: 2}, conflict: true}, before = structuredClone(unsaved);
  f.setContext({hasUnsavedDrafts: true}); f.controller.setContext({...f.context});
  assert.equal(f.calls.contexts.length, 0); assert.equal(f.calls.prepare.length, 0);
  await f.controller.prepare(234); assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.transports[0].plays, 0);
  assert.equal(f.calls.contexts[0].resumes, 1); assert.equal(f.calls.sessions[0].takes, 1);
  assert.deepEqual(f.calls.prepare[0].input, {projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 234});
  assert.equal(f.calls.prepare[0].options.expectedWorkspaceOrigin, 'pinned-workspace-origin');
  f.setContext({hasUnsavedDrafts: false}); f.setContext({hasUnsavedDrafts: true}); f.controller.setContext({...f.context});
  assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.contexts.length, 1); assert.deepEqual(unsaved, before);
  f.controller.dispose(); await tick();
});

test('continuous ticks and buffering remain ephemeral; each explicit seek and stop persists exactly once', async () => {
  const f = fixture(); await f.controller.prepare(30); await f.controller.play(); const transport = f.calls.transports[0];
  transport.tick(1200); transport.buffer(1260); assert.deepEqual(f.calls.positions, []);
  assert.equal(f.controller.getState().phase, 'buffering'); assert.equal(f.controller.getState().positionFrame, 1260);
  assert.equal(f.controller.getState().underruns, 1); assert.equal(f.controller.getState().heldPcmBytes, 0);
  for (const frame of [3000, 900, 17999, 20]) assert.equal(f.controller.seek(frame), true);
  assert.deepEqual(transport.seeks, [3000, 900, 17999, 20]); assert.deepEqual(f.calls.positions, transport.seeks);
  transport.tick(99); f.controller.stop(); assert.deepEqual(f.calls.positions, [3000, 900, 17999, 20, 99]);
  assert.equal(f.controller.getState().continuousPlan, null); await tick();
});

test('play pauses the separate media player and pause does not persist a tick or destroy prepared resources', async () => {
  const f = fixture(); await f.controller.prepare(0); assert.equal(await f.controller.play(), true); assert.equal(f.calls.beforePlay, 1);
  f.calls.transports[0].tick(222); f.controller.pause();
  assert.equal(f.controller.getState().phase, 'paused'); assert.equal(f.calls.contexts[0].closes, 0); assert.deepEqual(f.calls.positions, []);
  assert.equal(await f.controller.play(), true); assert.equal(f.calls.beforePlay, 2); f.controller.dispose(); await tick();
});

for (const [name, patch] of Object.entries({revision: {revision: 2}, source: {sourceIdentity: 'replacement'}, workspace: {scope: 'other-workspace'},
  project: {projectId: id(8)}, timeline: {timelineId: id(9)}, navigation: {executionScope: 'source'}, hidden: {visible: false},
  disconnect: {connected: false}, restored: {restored: true}})) {
  test(`${name} change synchronously revokes the saved snapshot and rejects late preparation`, async () => {
    const f = fixture(); await f.controller.prepare(0); await f.controller.play(); f.setContext(patch);
    assert.equal(f.calls.transports[0].disposed, true); assert.equal(f.controller.getState().continuousPlan, null);
    assert.deepEqual(f.calls.positions, []); assert.equal(await f.controller.play(), false); await tick();
    assert.equal(f.calls.sessions[0].closes, 1);
    const pending = deferred(), late = fixture({pendingPrepare: pending}); const preparation = late.controller.prepare(0);
    late.setContext(patch); assert.equal(late.calls.prepare[0].options.signal.aborted, true);
    pending.resolve(); assert.equal(await preparation, false); await tick();
    assert.equal(late.calls.transports.length, 0); assert.equal(late.calls.sessions[0].closes, 1); assert.deepEqual(late.calls.positions, []);
  });
}

test('retained controls recheck the latest binding before prepare, play, seek or position persistence', async () => {
  const f = fixture(); await f.controller.prepare(0); const stale = f.controller.getState();
  f.changeWithoutEffect({revision: 2});
  assert.equal(f.controller.seek(4000, stale), false); assert.equal(await f.controller.play(stale), false);
  assert.equal(await f.controller.prepare(3000, stale), false); assert.deepEqual(f.calls.positions, []);
  assert.equal(f.calls.transports[0].disposed, true); await tick();
});

test('pause, revoke and project changes reject late resume acknowledgments without reviving audio', async () => {
  for (const action of ['pause', 'revoke', 'project']) {
    const pending = deferred(), f = fixture({pendingResume: pending}); await f.controller.prepare(0); const play = f.controller.play();
    if (action === 'project') f.setContext({projectId: id(9)}); else f.controller[action]();
    pending.resolve(); assert.equal(await play, false); assert.notEqual(f.controller.getState().phase, 'playing');
    assert.deepEqual(f.calls.positions, []); f.controller.dispose(); await tick();
  }
});

test('cancel, unmount and A to B to A generation changes cannot publish an ignored late preparation', async () => {
  for (const action of ['cancel', 'dispose', 'aba']) {
    const pending = deferred(), f = fixture({pendingPrepare: pending}); const preparation = f.controller.prepare(0);
    if (action === 'aba') { f.setContext({scope: 'B'}); f.setContext({scope: 'project:workspace:epoch-1'}); }
    else f.controller[action]();
    pending.resolve(); assert.equal(await preparation, false); await tick();
    assert.equal(f.calls.transports.length, 0); assert.equal(f.calls.contexts[0].closes, 1); assert.deepEqual(f.calls.positions, []);
  }
});

test('a synchronous preparing observer revokes before any new context or request is allocated', async () => {
  let f; f = fixture({onChange: state => { if (state.phase === 'preparing') f.controller.revoke(); }});
  assert.equal(await f.controller.prepare(0), false); await tick();
  assert.equal(f.calls.contexts.length, 0); assert.equal(f.calls.prepare.length, 0);
  assert.equal(f.controller.getState().phase, 'cancelled');
});

test('initial playback seeks keep only the latest target and resume its original explicit play intent after exact retirement', async () => {
  const pending = deferred(), f = fixture({pendingPrepare: pending}); const original = f.controller.start(0);
  assert.equal(f.controller.seek(100), true); assert.equal(f.controller.seek(200), true);
  assert.deepEqual(f.calls.positions, [100, 200]); assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.controller.getState().phase, 'preparing'); assert.equal(f.controller.getState().positionFrame, 200);
  assert.equal(f.controller.getState().retirement, 'closing');
  pending.resolve(); assert.equal(await original, false); await tick();
  assert.deepEqual(f.calls.prepare.map(call => call.input.startFrame), [0, 200]);
  assert.equal(f.calls.contexts[0].closes, 1); assert.equal(f.calls.sessions[0].closes, 1);
  assert.equal(f.calls.transports.length, 1); assert.equal(f.calls.transports[0].plays, 1);
  assert.equal(f.calls.beforePlay, 1); assert.equal(f.controller.getState().phase, 'playing');
  assert.equal(f.controller.getState().positionFrame, 200); f.controller.dispose(); await tick();
});

test('queued seeks during explicit preparation preserve the absence of an autoplay intent', async () => {
  const pending = deferred(), f = fixture({pendingPrepare: pending}); const original = f.controller.prepare(0);
  f.controller.seek(100); f.controller.seek(200); pending.resolve(); assert.equal(await original, false); await tick();
  assert.deepEqual(f.calls.prepare.map(call => call.input.startFrame), [0, 200]);
  assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.transports[0].plays, 0);
  f.controller.dispose(); await tick();
});

for (const action of ['cancel', 'stop', 'revoke', 'dispose', 'revision']) {
  test(`${action} invalidates a queued initial seek so ignored late PCM cannot restart it`, async () => {
    const pending = deferred(), f = fixture({pendingPrepare: pending}); const original = f.controller.start(0);
    f.controller.seek(100); f.controller.seek(200);
    if (action === 'revision') f.setContext({revision: 2}); else f.controller[action]();
    pending.resolve(); assert.equal(await original, false); await tick();
    assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.transports.length, 0); assert.equal(f.calls.beforePlay, 0);
    assert.equal(f.calls.sessions[0].closes, 1); assert.notEqual(f.controller.getState().phase, 'playing');
    assert.deepEqual(f.calls.positions, action === 'stop' ? [100, 200, 200] : [100, 200]);
  });
}

test('an unconfirmed original retirement prevents every queued target from acquiring a replacement context', async () => {
  const pending = deferred(), f = fixture({pendingPrepare: pending, failClose: true}); const original = f.controller.start(0);
  f.controller.seek(100); f.controller.seek(200); pending.resolve(); assert.equal(await original, false); await tick();
  assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.transports.length, 0);
  assert.equal(f.controller.getState().retirement, 'failed'); assert.equal(f.controller.getState().phase, 'error');
});

test('new preparation remains blocked until context, original prepare and client resource retirement all settle', async () => {
  const close = deferred(), resources = deferred(), f = fixture({pendingClose: close, pendingResources: resources});
  await f.controller.prepare(0); f.controller.stop(); assert.equal(f.controller.getState().retirement, 'closing');
  assert.equal(await f.controller.prepare(300), false); close.resolve(); await tick(); assert.equal(f.controller.getState().retirement, 'closing');
  assert.equal(await f.controller.prepare(300), false); resources.resolve(); await tick(); assert.equal(f.controller.getState().retirement, 'none');
  assert.equal(await f.controller.prepare(300), true); assert.equal(f.calls.contexts.length, 2); f.controller.dispose(); await tick();
});

test('session disposal is part of the retirement fence even after the renderer context has closed', async () => {
  const close = deferred(), f = fixture({pendingSessionClose: close}); await f.controller.prepare(0); f.controller.stop(); await tick();
  assert.equal(f.calls.contexts[0].state, 'closed'); assert.equal(f.calls.sessions[0].closes, 1);
  assert.equal(f.controller.getState().retirement, 'closing'); assert.equal(await f.controller.prepare(300), false);
  close.resolve(); await tick(); assert.equal(f.controller.getState().retirement, 'none');
});

test('failed context retirement stays blocked across reattachment and cannot reopen a sound owner', async () => {
  const f = fixture({failClose: true}); await f.controller.prepare(0); f.controller.stop(); await tick();
  assert.equal(f.controller.getState().retirement, 'failed'); f.controller.attach(f.context);
  assert.equal(await f.controller.prepare(300), false); assert.equal(f.calls.contexts.length, 1);
});

test('context closure failure still cancels the backend session and keeps admission blocked', async () => {
  const f = fixture({failClose: true}); await f.controller.prepare(0); f.controller.stop(); await tick();
  assert.equal(f.calls.sessions[0].closes, 1); assert.equal(f.controller.getState().retirement, 'failed');
  assert.equal(await f.controller.prepare(300), false);
});

test('a context closed during deferred preparation cannot publish a ready session or construct a transport', async () => {
  const pending = deferred(), f = fixture({pendingPrepare: pending}); const preparation = f.controller.prepare(0);
  f.calls.contexts[0].state = 'closed'; pending.resolve();
  assert.equal(await preparation, false); assert.equal(f.calls.transports.length, 0); assert.equal(f.controller.getState().phase, 'error');
  await tick(); assert.equal(f.calls.sessions[0].closes, 1);
});

test('saved duration boundaries reject invalid seeks without persistence and accept the final stopped endpoint', async () => {
  const f = fixture(); await f.controller.prepare(0);
  for (const frame of [-1, 18001, 2.5, NaN]) assert.equal(f.controller.seek(frame), false);
  assert.deepEqual(f.calls.positions, []); assert.equal(f.controller.seek(18000), true);
  assert.equal(f.controller.getState().phase, 'ended'); assert.deepEqual(f.calls.positions, [18000]); f.controller.dispose(); await tick();
});

test('decoder failure and unauthorized status revoke the entire owner while preserving the explanatory cursor', async () => {
  for (const code of ['AUDIO_PREVIEW_SOURCE_CHANGED', 'UNAUTHORIZED']) {
    const f = fixture(); await f.controller.prepare(0); await f.controller.play(); f.calls.transports[0].tick(1234); f.calls.transports[0].fail(code);
    assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().positionFrame, 1234);
    assert.equal(f.controller.getState().continuousPlan, null); assert.equal(f.calls.transports[0].disposed, true);
    assert.deepEqual(f.calls.positions, []); assert.equal(f.calls.unauthorized, code === 'UNAUTHORIZED' ? 1 : 0); await tick();
  }
});

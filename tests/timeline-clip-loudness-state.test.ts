import test from 'node:test';
import assert from 'node:assert/strict';
import { context, input, report, id } from './helpers/timeline-clip-loudness-ui-fixture.ts';
import { fixture } from './helpers/strict-timeline-audio-types.ts';
import { timelineClipLoudnessAvailable, timelineClipLoudnessViewState } from '../apps/web/src/timeline-clip-loudness-state.ts';
import { savedClipLoudnessFields, clipLoudnessDraftContext } from '../apps/web/src/timeline-clip-loudness-context.ts';
import { TIMELINE_CLIP_LOUDNESS_LIMITS } from '@mioon/contracts/timeline-clip-loudness';

test('attach and context changes never analyze; explicit read sends exact saved selection only', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); f.set({ executionScope: '2' }); assert.equal(f.calls.length, 0);
  await f.ready(); assert.deepEqual(f.calls[0].input, input()); assert.equal(f.state().phase, 'ready');
  assert.equal(f.calls[0].options.expectedWorkspaceOrigin, id(7)); assert.equal(f.state().report!.applyAllowed, false);
  assert.ok(Object.isFrozen(f.state().report!.identity)); assert.equal('draft' in f.state(), false);
});
test('saved-only admission blocks invalid identity, dirty/conflict/pending/recovery, mute/zero/no-audio, and long clip', async () => {
  const patches = [{ scope: null }, { projectId: null }, { timelineId: null }, { revision: 0 }, { clipId: null }, { assetId: null }, { assetSha256: 'bad' },
    { trackId: null }, { durationFrames: 0 }, { durationFrames: TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames + 1 }, { gain: 0 }, { gain: NaN }, { gain: 3 },
    { muted: true }, { audioSupported: false }, { sourceIdentity: '' }, { connected: false }, { visible: false }, { restored: true }, { hasUnsavedDrafts: true }, { pending: true }];
  for (const patch of patches) { const f = fixture(patch); assert.equal(timelineClipLoudnessAvailable(f.state()), false, JSON.stringify(patch)); assert.equal(await f.prepare(), null); assert.equal(f.calls.length, 0); }
  assert.equal(timelineClipLoudnessAvailable(context({ durationFrames: TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames })), true);
  for (const patch of [{ dirty: true }, { conflict: true }, { submitting: true }, { candidate: {} }, { phase: 'loading' }, { phase: 'error' }, { businessPending: true }]) {
    const value = clipLoudnessDraftContext(context(), { dirty: false, conflict: false, submitting: false, candidate: null, phase: 'ready', businessPending: false, ...patch }, true);
    assert.equal(timelineClipLoudnessAvailable(value), false);
  }
});
test('every identity/execution/visibility change aborts and clears before late fulfillment or failure', async () => {
  const patches = [{ scope: 'workspace:other' }, { executionScope: 'selection:2' }, { projectId: id(8) }, { timelineId: id(9) }, { revision: 5 },
    { clipId: id(10) }, { assetId: id(11) }, { assetSha256: 'c'.repeat(64) }, { trackId: id(12) }, { sourceIdentity: 'new-graph' },
    { startFrame: 18 }, { sourceInFrame: 7 }, { durationFrames: 29 }, { gain: .5 }, { fadeInFrames: 2 }, { fadeOutFrames: 3 },
    { muted: true }, { audioSupported: false }, { visible: false }, { connected: false }, { restored: true }, { hasUnsavedDrafts: true }, { pending: true }];
  for (const patch of patches) for (const reject of [false, true]) {
    const f = fixture(), work = f.prepare(); f.set(patch); assert.equal(f.calls[0].options.signal.aborted, true);
    if (reject) f.reads[0].reject({ code: 'UNAUTHORIZED' }); else f.reads[0].resolve(report());
    await work; assert.equal(f.state().report, null); assert.notEqual(f.state().phase, 'ready'); assert.equal(f.auth.length, 0);
  }
});
test('A→B→A cannot restore an old report or reuse an old Analyze/Cancel callback', async () => {
  const f = fixture(), old = f.state(), work = f.prepare(); f.set({ clipId: id(9), executionScope: '2' }); f.set({ clipId: old.clipId, executionScope: '3' });
  assert.equal(await f.controller.prepare(old), null); const newer = f.prepare(); f.controller.cancel(old); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[0].resolve(report()); await work; assert.equal(f.state().report, null);
  f.reads[1].resolve(report()); await newer; assert.equal(f.state().phase, 'ready');
});
test('live context catches pre-effect changes; render suppresses ready response before layout effect', async () => {
  const f = fixture(); await f.ready(); const prior = f.state(); f.set({ sourceIdentity: 'new-source' }, false);
  assert.equal(timelineClipLoudnessViewState(prior, f.live()).report, null); assert.equal(await f.controller.prepare(prior), null);
  const g = fixture(), work = g.prepare(); g.set({ executionScope: 'next' }, false); g.reads[0].resolve(report()); await work; assert.equal(g.state().report, null);
});
test('cancel, collapse revoke, dispose and strict-mode reattach abort with no retry or restored report', async () => {
  for (const end of ['cancel', 'revoke', 'dispose'] as const) {
    const f = fixture(), work = f.prepare(); f.controller[end](f.state()); assert.equal(f.calls[0].options.signal.aborted, true);
    f.reads[0].resolve(report()); await work; assert.equal(f.state().report, null); assert.equal(f.calls.length, 1);
    f.controller.attach(context()); assert.equal(f.state().report, null); assert.equal(f.calls.length, 1);
  }
});
test('duplicates do not queue; exact clip ranges, gain/fades, track and asset must match current saved identity', async () => {
  const f = fixture(), work = f.prepare(); assert.equal(await f.prepare(), null); f.reads[0].resolve(report()); await work;
  for (const [key, value] of [['trackId', id(7)], ['assetId', id(8)], ['startFrame', 19], ['sourceInFrame', 7], ['gain', .8], ['fadeInFrames', 2], ['fadeOutFrames', 5]] as const) {
    const g = fixture(), valueReport = report(); (valueReport.identity as Record<string, string | number | boolean>)[key] = value; await g.ready(valueReport); assert.equal(g.state().phase, 'error', key); assert.equal(g.state().report, null);
  }
  for (const patch of [{ target: {} }, { applyAllowed: true }, { stage: 'preencode_float_mix' }, { clipId: id(8) }]) {
    const g = fixture(); await g.ready({ ...report(), ...patch }); assert.equal(g.state().errorCode, 'BACKEND_PROTOCOL_ERROR');
  }
});
test('saved public context preserves saved gain and probes audio/video despite false/unknown cached audio metadata', () => {
  const i = report().identity, clip = { id: input().clipId, ...i }, asset = { id: i.assetId, sha256: i.assetSha256, mimeType: 'audio/wav', hasAudio: true };
  const timeline = { id: input().timelineId, revision: 4, clips: [clip], tracks: [{ id: i.trackId, muted: false }] };
  const saved = savedClipLoudnessFields(timeline, [asset], clip.id); assert.equal(saved.gain, .75); assert.equal(saved.audioSupported, true); assert.equal(saved.muted, false);
  assert.equal(savedClipLoudnessFields(timeline, [asset, asset], clip.id).assetId, null);
  assert.equal(savedClipLoudnessFields({ ...timeline, clips: [clip, clip] }, [asset], clip.id).clipId, null);
  assert.equal(savedClipLoudnessFields({ ...timeline, tracks: [] }, [asset], clip.id).muted, true);
  for (const hasAudio of [false, undefined, true]) for (const mimeType of ['audio/wav', 'video/mp4']) assert.equal(savedClipLoudnessFields(timeline, [{ ...asset, mimeType, hasAudio }], clip.id).audioSupported, true);
  assert.equal(savedClipLoudnessFields(timeline, [{ ...asset, mimeType: 'image/png', hasAudio: false }], clip.id).audioSupported, false);
});

import assert from 'node:assert/strict';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_PROFILE } from '@mioon/contracts/timeline-mix-loudness';
import { createTimelineMixLoudnessController } from '../../apps/web/src/timeline-mix-loudness-state.ts';
export const id = n => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const projectId = id(1), timelineId = id(2), sourceId = id(3), clipId = id(4);
export const draft = { integratedLufs: '-24', truePeakCeilingDbtp: '-1' };
export function context(patch = {}) { return { scope: `${projectId}:1:normal`, executionScope: '0:0:editing', projectId, timelineId,
  revision: 4, durationFrames: 60, sourceIdentity: 'saved-sources-v1', connected: true, visible: true, restored: false,
  hasUnsavedDrafts: false, pending: false, ...patch }; }
export function measurement({ frames = 96000, integrated = -20, scale = 1, silence = false } = {}) {
  const samplePeakLinear = silence ? 0 : .5 * scale, truePeakLinear = silence ? 0 : .6 * scale;
  const blocks = frames < 19200 ? 0 : 1 + Math.floor((frames - 19200) / 4800), valid = !silence && blocks > 0;
  return { sampleRate: 48000, channels: 2, sampleFrames: frames, decodedDurationSeconds: frames / 48000,
    state: silence ? 'digital_silence' : valid ? 'valid' : 'too_short', integratedLufs: valid ? integrated : null,
    samplePeakLinear, samplePeakDbfs: silence ? null : 20 * Math.log10(samplePeakLinear),
    truePeakLinear, truePeakDbtp: silence ? null : 20 * Math.log10(truePeakLinear),
    gatingBlockCount: blocks, absoluteGatedBlockCount: valid ? blocks : 0, relativeGatedBlockCount: valid ? blocks : 0,
    relativeGateLufs: valid ? integrated - 10 : null };
}
export function report(input, captured = context(), { silence = false, outOfRange = false } = {}) {
  const original = measurement({ frames: captured.durationFrames * 1600, silence }), valid = original.state === 'valid';
  const requiredGainDb = valid ? input.target.integratedLufs - original.integratedLufs : null;
  const gainMultiplier = valid ? 10 ** (requiredGainDb / 20) : null;
  const candidate = !valid || outOfRange ? { status: 'unavailable', reason: valid ? 'GAIN_OUT_OF_RANGE' : 'NO_VALID_LOUDNESS',
    requiredGainDb, gainMultiplier, gains: [], measurement: null, meetsTarget: false, meetsTruePeak: false, marginDb: .5, applyAllowed: false }
    : { status: 'measured', reason: null, requiredGainDb, gainMultiplier,
      gains: [{ clipId, assetId: sourceId, beforeGain: .5, afterGain: .5 * gainMultiplier }],
      measurement: measurement({ frames: captured.durationFrames * 1600, integrated: input.target.integratedLufs, scale: gainMultiplier }),
      meetsTarget: true, meetsTruePeak: original.truePeakDbtp + requiredGainDb <= input.target.truePeakCeilingDbtp - .5, marginDb: .5, applyAllowed: false };
  const passes = candidate.status === 'measured' ? 2 : 1;
  return { ...input, status: 'ready', checkedAt: '2026-10-14T06:00:00.000Z', stage: 'preencode_float_mix', applyAllowed: false,
    identity: { timelineId: captured.timelineId, timelineRevision: input.expectedRevision, snapshotSha256: 'b'.repeat(64),
      range: { startFrame: 0, endFrame: captured.durationFrames, sampleFrames: captured.durationFrames * 1600 },
      sources: [{ assetId: sourceId, sha256: 'a'.repeat(64), sizeBytes: 128 }] }, original, candidate,
    checks: { bytesHashed: 256, pcmBytes: captured.durationFrames * 1600 * 8 * passes, decodeWorkFrames: captured.durationFrames * passes,
      segmentCount: 1, passes, audioFullyDecoded: true } };
}
export const input = (target = { integratedLufs: -24, truePeakCeilingDbtp: -1 }) => ({ projectId, expectedRevision: 4,
  mixProfile: TIMELINE_MIX_LOUDNESS_PROFILE, measurementProfile: EXPORT_LOUDNESS_PROFILE, target });
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function fixture(patch = {}, overrides = {}) {
  let live = context(patch); const calls = [], reads = [], changes = [], auth = [];
  const controller = createTimelineMixLoudnessController({ getContext: () => live, getInvocation: () => ({}),
    onChange: value => changes.push(value), onUnauthorized: () => auth.push(false),
    read(value, options) { calls.push({ input: value, options, context: structuredClone(live) }); const wait = deferred(); reads.push(wait); return wait.promise; }, ...overrides });
  controller.attach(live);
  const f = { controller, calls, reads, changes, auth, state: () => controller.getState(), live: () => live,
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    edit(value = draft) { return controller.setDraft(value, f.state()); }, prepare() { return controller.prepare(f.state()); }, cancel() { controller.cancel(f.state()); },
    async ready(value) { const wait = f.prepare(); assert.ok(reads.at(-1), 'Explicit populated target should start a read');
      reads.at(-1).resolve(value ?? report(calls.at(-1).input, calls.at(-1).context)); await wait; return f.state(); } };
  return f;
}

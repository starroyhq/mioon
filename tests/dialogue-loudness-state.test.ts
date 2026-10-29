import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';
import type { TimelineClipLoudnessInput } from '@mioon/contracts/timeline-clip-loudness';
import { readyClipLoudness, silentClipLoudness } from './fixtures/timeline-clip-loudness-fixtures.ts';
import { createDialogueLoudnessController, dialogueLoudnessGains, dialogueLoudnessRows, dialogueLoudnessStatusMessage } from '../apps/web/src/dialogue-loudness-state.ts';
import type { DialogueLoudnessContext, DialogueLoudnessReadOptions } from '../apps/web/src/dialogue-loudness-state.ts';

const id = (n: number): string => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), voice = id(3), music = id(4), muted = id(5);
const hash = (n: number): string => String(n).repeat(64).slice(0, 64);
const clip = (n: number, trackId: string, startFrame: number, extra: Record<string, unknown> = {}) =>
  ({ id: id(100 + n), name: `Line ${n}`, trackId, assetId: id(200 + n), startFrame, durationFrames: 60, gain: 1, audioRole: 'human', ...extra });
function context(patch: Partial<DialogueLoudnessContext> = {}): DialogueLoudnessContext {
  const clips = [clip(2, voice, 90), clip(1, voice, 0), clip(3, music, 0, { audioRole: 'music' }), clip(4, muted, 30),
    clip(5, voice, 200, { gain: 0 }), clip(6, voice, 300, { durationFrames: 1801 }), clip(7, voice, 2200, { assetId: id(999) })];
  return { scope: 'project:1:workspace', executionScope: '1:inspector', projectId, timelineId, revision: 9, sourceIdentity: 'saved-9',
    clips, tracks: [{ id: voice, name: 'Voice', orderIndex: 1, muted: false }, { id: music, name: 'Music', orderIndex: 2, muted: false }, { id: muted, name: 'Muted', orderIndex: 3, muted: true }],
    assetHashes: Object.fromEntries(clips.filter(item => item.assetId !== id(999)).map((item, index) => [item.assetId, hash(index + 1)])),
    connected: true, visible: true, restored: false, hasUnsavedDrafts: false, pending: false, ...patch };
}
/** A server-shaped reading of one clip at the given loudness and peak, scaled to the target. */
function measured(input: TimelineClipLoudnessInput, lufs: number, peakDbtp: number, gain = 1) {
  const value = readyClipLoudness(input as never) as ReturnType<typeof readyClipLoudness> & {candidate?: unknown};
  const target = input.target!, peakLinear = 10 ** (peakDbtp / 20);
  value.identity.gain = gain;
  Object.assign(value.measurement, { integratedLufs: lufs, relativeGateLufs: lufs - 10, truePeakLinear: peakLinear, truePeakDbtp: peakDbtp,
    samplePeakLinear: Math.fround(peakLinear * .9), samplePeakDbfs: 20 * Math.log10(Math.fround(peakLinear * .9)) });
  const requiredGainDb = target.integratedLufs - lufs, gainMultiplier = 10 ** (requiredGainDb / 20);
  const after = { ...value.measurement, integratedLufs: target.integratedLufs, relativeGateLufs: target.integratedLufs - 10,
    samplePeakLinear: Math.fround(value.measurement.samplePeakLinear * gainMultiplier), truePeakLinear: value.measurement.truePeakLinear * gainMultiplier };
  after.samplePeakDbfs = 20 * Math.log10(after.samplePeakLinear); after.truePeakDbtp = 20 * Math.log10(after.truePeakLinear);
  value.candidate = { status: 'measured', reason: null, beforeGain: gain, afterGain: gain * gainMultiplier, requiredGainDb, gainMultiplier,
    measurement: after, meetsTarget: true, meetsTruePeak: after.truePeakDbtp <= target.truePeakCeilingDbtp - .5, marginDb: .5, applyAllowed: false,
    measuredPcmBytes: value.checks.pcmBytes };
  assert.ok(isTimelineClipLoudnessResponse(value, input), 'the synthetic reading is a valid response');
  return value;
}
function silent(input: TimelineClipLoudnessInput) {
  const value = silentClipLoudness(input as never) as ReturnType<typeof silentClipLoudness> & {candidate?: unknown};
  value.identity.gain = 1;
  value.candidate = { status: 'unavailable', reason: 'NO_VALID_LOUDNESS', requiredGainDb: null, gainMultiplier: null, afterGain: null, measurement: null,
    measuredPcmBytes: 0, meetsTarget: false, meetsTruePeak: false, beforeGain: 1, marginDb: .5, applyAllowed: false };
  assert.ok(isTimelineClipLoudnessResponse(value, input), 'the synthetic silent reading is a valid response');
  return value;
}
interface Pending { input: TimelineClipLoudnessInput; options: DialogueLoudnessReadOptions; resolve(value: unknown): void; reject(error: unknown): void }
function harness(initial = context()) {
  let current = initial;
  const reads: Pending[] = [], applied: { gains: readonly { clipId: string; gain: number }[]; revision: number }[] = [];
  let applyResult: (value: boolean) => void = () => {};
  let unauthorized = 0;
  const controller = createDialogueLoudnessController({
    // Like the real RPC, an aborted read rejects as cancelled.
    read: (input, options) => new Promise((resolve, reject) => {
      reads.push({ input, options, resolve, reject });
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'OPERATION_CANCELLED' })), { once: true });
    }),
    apply: (gains, revision) => { applied.push({ gains, revision }); return new Promise(resolve => { applyResult = resolve; }); },
    getContext: () => current, onUnauthorized: () => { unauthorized++; },
  });
  controller.attach(current);
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { controller, reads, applied, state: () => controller.getState(), unauthorized: () => unauthorized,
    set(patch: Partial<DialogueLoudnessContext>) { current = { ...current, ...patch }; controller.setContext(current); },
    finishApply: (value: boolean) => applyResult(value), settle };
}

test('rows list saved human-voice clips in timeline order and name why some cannot be measured', () => {
  const rows = dialogueLoudnessRows(context());
  assert.deepEqual(rows.map(row => [row.name, row.status, row.skip ?? null]), [
    ['Line 1', 'waiting', null], ['Line 4', 'skipped', 'muted'], ['Line 2', 'waiting', null],
    ['Line 5', 'skipped', 'zeroGain'], ['Line 6', 'skipped', 'tooLong'], ['Line 7', 'skipped', 'noSource']]);
  assert.ok(rows.every(row => !row.selected), 'nothing is selected before measuring');
});

test('measuring reads each measurable clip in turn with the bound revision, source hash and target, and never writes', async () => {
  const h = harness();
  h.controller.setDraft({ integratedLufs: '-18', truePeakCeilingDbtp: '-2' }, h.state());
  const work = h.controller.analyze(h.state());
  await h.settle();
  assert.equal(h.state().phase, 'measuring'); assert.equal(h.reads.length, 1, 'one clip at a time');
  const first = h.reads[0].input;
  assert.deepEqual({ ...first }, { projectId, timelineId, expectedRevision: 9, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1',
    target: { integratedLufs: -18, truePeakCeilingDbtp: -2 }, clipId: id(101), expectedAssetSha256: context().assetHashes[id(201)] });
  assert.equal(dialogueLoudnessStatusMessage(h.state()), '正在测量第 1/2 段…');
  h.reads[0].resolve(measured(first, -24, -12)); await h.settle();
  assert.equal(h.reads.length, 2); assert.equal(h.reads[1].input.clipId, id(102));
  h.reads[1].resolve(measured(h.reads[1].input, -17.95, -6)); assert.equal(await work, true);
  const rows = new Map(h.state().rows.map(row => [row.clipId, row]));
  assert.equal(h.state().phase, 'ready');
  assert.equal(rows.get(id(101))!.selected, true, 'a 6 dB lift under the ceiling is kept');
  assert.ok(Math.abs(rows.get(id(101))!.afterGain! - 10 ** (6 / 20)) < 1e-9);
  assert.equal(rows.get(id(102))!.selected, false, 'a clip already within 0.1 LU is left alone');
  assert.deepEqual(dialogueLoudnessGains(h.state()).map(item => item.clipId), [id(101)]);
  assert.equal(h.applied.length, 0, 'measuring never applies');
});

test('a reading over the peak ceiling stays unchecked until the user keeps it, and silence is reported, not guessed', async () => {
  const h = harness(), work = h.controller.analyze(h.state());
  await h.settle(); h.reads[0].resolve(measured(h.reads[0].input, -20, -3)); await h.settle();
  h.reads[1].resolve(silent(h.reads[1].input)); await work;
  const [loud, quiet] = [h.state().rows.find(row => row.clipId === id(101))!, h.state().rows.find(row => row.clipId === id(102))!];
  assert.equal(loud.meetsTruePeak, false); assert.equal(loud.selected, false);
  assert.deepEqual([quiet.status, quiet.reason, quiet.integratedLufs], ['unavailable', 'NO_VALID_LOUDNESS', null]);
  assert.deepEqual(dialogueLoudnessGains(h.state()), []);
  assert.equal(h.controller.toggle(id(101), true, h.state()), true);
  assert.equal(h.controller.toggle(id(102), true, h.state()), false, 'an unmeasured clip cannot be kept');
  assert.deepEqual(dialogueLoudnessGains(h.state()).map(item => item.clipId), [id(101)]);
});

test('one failed clip is reported and the pass continues; an expired session stops it', async () => {
  const h = harness(), work = h.controller.analyze(h.state());
  await h.settle(); h.reads[0].reject(Object.assign(new Error('busy'), { code: 'TIMELINE_CLIP_LOUDNESS_BUSY' })); await h.settle();
  assert.equal(h.state().rows.find(row => row.clipId === id(101))!.status, 'failed');
  h.reads[1].resolve(measured(h.reads[1].input, -20, -10)); assert.equal(await work, true);
  const again = harness(), second = again.controller.analyze(again.state());
  await again.settle(); again.reads[0].reject(Object.assign(new Error('expired'), { code: 'UNAUTHORIZED' }));
  assert.equal(await second, false); assert.equal(again.state().phase, 'error'); assert.equal(again.unauthorized(), 1);
  assert.deepEqual(again.state().rows, []); assert.equal(again.reads.length, 1, 'no further clip is read');
});

test('stopping, a newer revision or a new target discard readings; a hidden panel never measures', async () => {
  const h = harness(), work = h.controller.analyze(h.state());
  await h.settle(); h.controller.cancel(h.state());
  assert.equal(h.reads[0].options.signal.aborted, true); assert.equal(await work, false);
  assert.deepEqual([h.state().phase, h.state().rows.length], ['cancelled', 0]);
  const ready = harness(), done = ready.controller.analyze(ready.state());
  await ready.settle(); ready.reads[0].resolve(measured(ready.reads[0].input, -20, -12)); await ready.settle();
  ready.reads[1].resolve(measured(ready.reads[1].input, -20, -12)); await done;
  ready.set({ revision: 10, sourceIdentity: 'saved-10' });
  assert.deepEqual([ready.state().phase, ready.state().rows.length], ['stale', 0]);
  const drafted = harness(), measuring = drafted.controller.analyze(drafted.state());
  await drafted.settle(); drafted.reads[0].resolve(measured(drafted.reads[0].input, -20, -12)); await drafted.settle();
  drafted.reads[1].resolve(measured(drafted.reads[1].input, -20, -12)); await measuring;
  drafted.controller.setDraft({ integratedLufs: '-20', truePeakCeilingDbtp: '-1' }, drafted.state());
  assert.deepEqual([drafted.state().phase, drafted.state().rows.length], ['idle', 0], 'readings belong to their target');
  const hidden = harness(context({ visible: false }));
  assert.equal(await hidden.controller.analyze(hidden.state()), false); assert.equal(hidden.reads.length, 0);
  const restored = harness(context({ restored: true }));
  assert.equal(await restored.controller.analyze(restored.state()), false); assert.equal(restored.reads.length, 0);
});

test('applying sends the kept gains once at the measured revision and survives the pending and revision changes it causes', async () => {
  const h = harness(), work = h.controller.analyze(h.state());
  await h.settle(); h.reads[0].resolve(measured(h.reads[0].input, -20, -12)); await h.settle();
  h.reads[1].resolve(measured(h.reads[1].input, -12, -20)); await work;
  const applying = h.controller.apply(h.state());
  assert.equal(h.state().phase, 'applying'); assert.equal(h.applied.length, 1); assert.equal(h.applied[0].revision, 9);
  // The default −14 LUFS target lifts the −20 clip by 6 dB and lowers the −12 clip by 2 dB.
  assert.deepEqual(h.applied[0].gains.map(item => [item.clipId, Number(item.gain.toFixed(4))]), [[id(101), 1.9953], [id(102), .7943]]);
  assert.equal(await h.controller.apply(h.state()), false, 'a second apply cannot start');
  h.set({ pending: true }); assert.equal(h.state().phase, 'applying');
  h.set({ pending: false, revision: 10, sourceIdentity: 'saved-10' }); assert.equal(h.state().phase, 'applying');
  h.finishApply(true); assert.equal(await applying, true);
  assert.deepEqual([h.state().phase, h.state().applied, h.state().rows.length], ['applied', 2, 0]);
  assert.equal(dialogueLoudnessStatusMessage(h.state()), '已调整 2 段对白的增益');
  const failed = harness(), measuring = failed.controller.analyze(failed.state());
  await failed.settle(); failed.reads[0].resolve(measured(failed.reads[0].input, -20, -12)); await failed.settle();
  failed.reads[1].resolve(measured(failed.reads[1].input, -20, -12)); await measuring;
  const attempt = failed.controller.apply(failed.state()); failed.finishApply(false);
  assert.equal(await attempt, false); assert.equal(failed.state().phase, 'ready', 'an unsaved apply keeps the readings');
  assert.equal(failed.state().rows.length, 6, 'all six human-voice rows remain');
});

test('an apply in flight survives closing the card, but its result never lands in another project', async () => {
  const measure = async (h: ReturnType<typeof harness>) => {
    const work = h.controller.analyze(h.state());
    await h.settle(); h.reads[0].resolve(measured(h.reads[0].input, -20, -12)); await h.settle();
    h.reads[1].resolve(measured(h.reads[1].input, -20, -12)); await work;
  };
  const closed = harness(); await measure(closed);
  const kept = closed.controller.apply(closed.state());
  closed.controller.revoke(); assert.equal(closed.state().phase, 'applying', 'closing the card does not abandon the edit');
  closed.finishApply(true); assert.equal(await kept, true); assert.equal(closed.state().phase, 'applied');
  const moved = harness(); await measure(moved);
  const late = moved.controller.apply(moved.state());
  moved.set({ projectId: id(9), scope: 'project:9:workspace' });
  assert.equal(moved.state().phase, 'idle');
  moved.finishApply(true); await late;
  assert.deepEqual([moved.state().phase, moved.state().applied], ['idle', 0], 'the other project shows no foreign result');
});

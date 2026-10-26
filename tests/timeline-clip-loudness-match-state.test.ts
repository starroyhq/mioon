import test from 'node:test';
import assert from 'node:assert/strict';
import { report } from './helpers/timeline-clip-loudness-ui-fixture.ts';
import { fixture } from './helpers/strict-timeline-audio-types.ts';
import { timelineClipLoudnessTarget, timelineClipLoudnessMatchable } from '../apps/web/src/timeline-clip-loudness-state.ts';
import { clipLoudnessDraftContext, stageClipLoudnessGain } from '../apps/web/src/timeline-clip-loudness-context.ts';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';

function measuredMatch(input: Parameters<typeof report>[0] & {target?: {integratedLufs: number; truePeakCeilingDbtp: number}}, originalLufs = -20, originalGain = .75) {
  const value = report(input), target = input.target!;
  value.identity.gain = originalGain;
  value.measurement.integratedLufs = originalLufs; value.measurement.relativeGateLufs = originalLufs - 10;
  const requiredGainDb = target.integratedLufs - value.measurement.integratedLufs, gainMultiplier = 10 ** (requiredGainDb / 20);
  const measurement = { ...value.measurement, integratedLufs: target.integratedLufs, relativeGateLufs: target.integratedLufs - 10,
    samplePeakLinear: Math.fround(value.measurement.samplePeakLinear * gainMultiplier), truePeakLinear: value.measurement.truePeakLinear * gainMultiplier };
  measurement.samplePeakDbfs = 20 * Math.log10(measurement.samplePeakLinear); measurement.truePeakDbtp = 20 * Math.log10(measurement.truePeakLinear);
  return { ...value, candidate: { status: 'measured', reason: null, beforeGain: value.identity.gain, afterGain: value.identity.gain * gainMultiplier,
    requiredGainDb, gainMultiplier, measurement, meetsTarget: true, meetsTruePeak: measurement.truePeakDbtp <= target.truePeakCeilingDbtp - .5,
    marginDb: .5, applyAllowed: false, measuredPcmBytes: value.checks.pcmBytes } };
}
function matching(overrides = {}) {
  const gains: number[] = [], f = fixture({}, { onMatchGain(gain) { gains.push(gain); return true; }, ...overrides });
  f.controller.editTarget(f.state(), 'integratedLufs', '-22');
  return { ...f, gains, async readyMatch() { const work = f.prepare(), value = measuredMatch(f.calls.at(-1)!.input); assert.ok(isTimelineClipLoudnessResponse(value, f.calls.at(-1)!.input)); f.reads.at(-1)!.resolve(value); await work; return f.state(); } };
}

test('matching sends explicit target, accepts a fully measured candidate and consumes it only once into a draft callback', async () => {
  const f = matching(); assert.equal(f.calls.length, 0); await f.readyMatch();
  assert.deepEqual(f.calls[0].input.target, { integratedLufs: -22, truePeakCeilingDbtp: -1 });
  const expected = f.state(); assert.equal(timelineClipLoudnessMatchable(expected), true);
  assert.equal(f.controller.match(expected), true); assert.equal(f.controller.match(expected), false);
  assert.equal(f.gains.length, 1); assert.equal(f.gains[0], .75 * 10 ** (-2 / 20)); assert.equal(f.state().report, null);
});

test('raw invalid target input, whitespace and IME never start analysis or normalize to zero', async () => {
  for (const [field, value] of [['integratedLufs', ''], ['integratedLufs', ' '], ['integratedLufs', '-61'], ['integratedLufs', '-4'],
    ['integratedLufs', '0x10'], ['integratedLufs', '-1e1'], ['truePeakCeilingDbtp', '-21'], ['truePeakCeilingDbtp', '1']] as const) {
    const f = matching(); f.controller.editTarget(f.state(), field, value);
    assert.equal(f.state().targetDraft![field], value); assert.equal(timelineClipLoudnessTarget(f.state()), null); assert.equal(await f.prepare(), null); assert.equal(f.calls.length, 0);
  }
  const f = matching(); f.controller.setTargetComposing(f.state(), true); assert.equal(await f.prepare(), null);
  f.controller.setTargetComposing(f.state(), false); assert.deepEqual(timelineClipLoudnessTarget(f.state()), { integratedLufs: -22, truePeakCeilingDbtp: -1 });
});

test('changing target aborts late measurement and A→B→A does not revive an old Analyze or Match callback', async () => {
  const f = matching(), before = f.state(), work = f.prepare(), oldInput = f.calls[0].input;
  f.controller.editTarget(f.state(), 'integratedLufs', '-23'); f.controller.editTarget(f.state(), 'integratedLufs', '-22');
  assert.equal(f.calls[0].options.signal.aborted, true); f.reads[0].resolve(measuredMatch(oldInput)); await work;
  assert.equal(f.state().report, null); assert.equal(await f.controller.prepare(before), null);
  await f.readyMatch(); const oldMatch = f.state();
  f.controller.editTarget(f.state(), 'truePeakCeilingDbtp', '-2'); f.controller.editTarget(f.state(), 'truePeakCeilingDbtp', '-1');
  assert.equal(f.controller.match(oldMatch), false); assert.equal(f.gains.length, 0);
});

test('hidden, switched, restored, composed and conflicted draft contexts reject retained Match callbacks before effects', async () => {
  for (const patch of [{ visible: false }, { executionScope: 'new-owner' }, { restored: true }, { hasUnsavedDrafts: true }, { pending: true }, { connected: false }]) {
    const f = matching(); await f.readyMatch(); const old = f.state(); f.set(patch, false);
    assert.equal(f.controller.match(old), false); assert.equal(f.gains.length, 0); assert.equal(f.state().report, null);
  }
  const f = matching(); await f.readyMatch(); const old = f.state(); f.controller.setTargetComposing(f.state(), true);
  assert.equal(f.controller.match(old), false); assert.equal(f.gains.length, 0);
});

test('matching is blocked when real candidate misses peak ceiling, misses target or requires no change', async () => {
  const peak = matching(); peak.controller.editTarget(peak.state(), 'truePeakCeilingDbtp', '-10'); await peak.readyMatch();
  assert.equal(peak.state().report!.candidate!.meetsTruePeak, false); assert.equal(peak.controller.match(peak.state()), false);
  const same = matching(); same.controller.editTarget(same.state(), 'integratedLufs', '-20'); await same.readyMatch();
  assert.equal(same.state().report!.candidate!.beforeGain, same.state().report!.candidate!.afterGain); assert.equal(same.controller.match(same.state()), false);
  const missed = matching(), work = missed.prepare(), value = measuredMatch(missed.calls[0].input);
  value.candidate.measurement.integratedLufs -= 1; value.candidate.measurement.relativeGateLufs -= 1; value.candidate.meetsTarget = false;
  missed.reads[0].resolve(value); await work; assert.equal(missed.state().phase, 'ready'); assert.equal(missed.controller.match(missed.state()), false);
});

test('float32 residue after saving a matched clip cannot create a repeated negligible gain edit', async () => {
  const f = matching(); f.controller.editTarget(f.state(), 'integratedLufs', '-26');
  const work = f.prepare(), value = measuredMatch(f.calls[0].input, -25.99999999);
  assert.notEqual(value.candidate.afterGain, value.candidate.beforeGain);
  assert.ok(value.candidate.requiredGainDb < 0 && Math.abs(value.candidate.requiredGainDb) < 1e-7);
  f.reads[0].resolve(value); await work; assert.equal(f.state().phase, 'ready');
  assert.equal(timelineClipLoudnessMatchable(f.state()), false); assert.equal(f.controller.match(f.state()), false); assert.deepEqual(f.gains, []);
});

test('an appreciable loudness change remains matchable for a legitimate tiny positive gain', async () => {
  const gains: number[] = [], f = fixture({ gain: 1e-30 }, { onMatchGain(gain) { gains.push(gain); return true; } });
  f.controller.editTarget(f.state(), 'integratedLufs', '-22');
  const work = f.prepare(), value = measuredMatch(f.calls[0].input, -20, 1e-30);
  f.reads[0].resolve(value); await work;
  assert.equal(f.state().phase, 'ready'); assert.equal(timelineClipLoudnessMatchable(f.state()), true);
  assert.equal(f.controller.match(f.state()), true); assert.equal(gains[0], 1e-30 * 10 ** (-2 / 20));
});

test('response with a different explicit target or unmeasured candidate cannot expose a matchable report', async () => {
  const f = matching(), work = f.prepare(), value = measuredMatch({ ...f.calls[0].input, target: { integratedLufs: -23, truePeakCeilingDbtp: -1 } });
  f.reads[0].resolve(value); await work; assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null);
});

test('the actual clip draft receives exact gain only; no implicit Save, new mutation or raw reset occurs', async t => {
  const f = matching(), base = f.live(), raw = { name: 'Saved clip', trackId: base.trackId, startFrame: base.startFrame, durationFrames: base.durationFrames,
    sourceInFrame: base.sourceInFrame, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: base.gain, fadeInFrames: base.fadeInFrames, fadeOutFrames: base.fadeOutFrames };
  const key = { projectId: base.projectId, timelineId: base.timelineId, clipId: base.clipId }, saved = { supported: true as const, workspaceScope: 'a'.repeat(64),
    instanceId: 'ca000000-0000-4000-8000-000000000099', key, revision: 0, targetStatus: 'matching' as const, draft: null };
  let writes = 0, saves = 0;
  const controller = createClipDraftController({ context: { ...key, scope: base.scope, connected: true, visible: true, busy: false, restored: false,
    timelineRevision: base.revision, source: { assetId: base.assetId, assetSha256: base.assetSha256 }, saved: raw }, delay: 100000,
    client: { async get() { return saved; }, async put(input) { writes++; return { ...saved, revision: input.expectedRevision + 1, draft: { baseRevision: input.baseRevision, source: input.source, raw: input.raw, updatedAt: '2026-10-20T00:00:00.000Z' } }; }, async remove() { throw Error('No deletion before Save'); } } });
  t.after(() => controller.dispose()); await controller.load();
  const gain = .75 * 10 ** (-2 / 20), context = () => clipLoudnessDraftContext(base, controller.getState(), true);
  assert.equal(stageClipLoudnessGain(controller, context(), gain), true);
  assert.deepEqual(controller.getState().raw, { ...raw, gain: String(gain) }); assert.equal(controller.getState().dirty, true); assert.equal(writes, 0); assert.equal(saves, 0);
  assert.equal(stageClipLoudnessGain(controller, context(), .2), false); await controller.flush(); assert.equal(writes, 1);
  await controller.save(async (_clipId, patch, revision) => { saves++; assert.equal(patch.gain, gain); assert.equal(revision, base.revision); return null; });
  assert.equal(saves, 1); assert.equal(controller.getState().dirty, true, 'An unknown Save result keeps the existing draft for reconciliation');
});

test('draft admission includes pending envelope composition and validates gain without clamping', () => {
  const f = matching(), draft = { dirty: false, conflict: false, submitting: false, candidate: null, phase: 'ready', businessPending: false, compositionPending: true };
  assert.equal(clipLoudnessDraftContext(f.live(), draft, true).pending, true);
  let edits = 0; const controller = { hasPendingComposition: () => false, isDiscarding: () => false, edit() { edits++; return true; } };
  for (const gain of [0, -1, 2.00001, NaN, Infinity]) assert.equal(stageClipLoudnessGain(controller as unknown as Parameters<typeof stageClipLoudnessGain>[0], f.live(), gain), false);
  assert.equal(edits, 0);
});

import assert from 'node:assert/strict';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_PROFILE } from '@mioon/contracts/timeline-mix-loudness';
import { createTimelineMixLoudnessController } from '../../apps/web/src/timeline-mix-loudness-state.ts';
export const id = (n: number): string => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const projectId = id(1), timelineId = id(2), sourceId = id(3), clipId = id(4);
export const draft = { integratedLufs: '-24', truePeakCeilingDbtp: '-1' };
export function context(patch: Record<string, unknown> = {}) { return { scope: `${projectId}:1:normal`, executionScope: '0:0:editing', projectId, timelineId,
  revision: 4, durationFrames: 60, sourceIdentity: 'saved-sources-v1', connected: true, visible: true, restored: false,
  hasUnsavedDrafts: false, pending: false, ...patch }; }
export interface MeasurementOptions {readonly frames?: number; readonly integrated?: number; readonly scale?: number; readonly silence?: boolean}
export function measurement({ frames = 96000, integrated = -20, scale = 1, silence = false }: MeasurementOptions = {}) {
  const samplePeakLinear = silence ? 0 : .5 * scale, truePeakLinear = silence ? 0 : .6 * scale;
  const blocks = frames < 19200 ? 0 : 1 + Math.floor((frames - 19200) / 4800), valid = !silence && blocks > 0;
  return { sampleRate: 48000, channels: 2, sampleFrames: frames, decodedDurationSeconds: frames / 48000,
    state: silence ? 'digital_silence' : valid ? 'valid' : 'too_short', integratedLufs: valid ? integrated : null,
    samplePeakLinear, samplePeakDbfs: silence ? null : 20 * Math.log10(samplePeakLinear),
    truePeakLinear, truePeakDbtp: silence ? null : 20 * Math.log10(truePeakLinear),
    gatingBlockCount: blocks, absoluteGatedBlockCount: valid ? blocks : 0, relativeGatedBlockCount: valid ? blocks : 0,
    relativeGateLufs: valid ? integrated - 10 : null };
}
export interface MixInput {readonly projectId: string; readonly expectedRevision: number; readonly mixProfile: string; readonly measurementProfile: string; readonly target: {readonly integratedLufs: number; readonly truePeakCeilingDbtp: number}}
export interface ReportOptions {readonly silence?: boolean; readonly outOfRange?: boolean}
export function report(input: MixInput, captured: Record<string, unknown> = context(), { silence = false, outOfRange = false }: ReportOptions = {}) {
  const frames = Number(captured.durationFrames) * 1600;
  const original = measurement({ frames, silence }), valid = original.state === 'valid';
  const requiredGainDb = valid ? input.target.integratedLufs - (original.integratedLufs as number) : null;
  const gainMultiplier = valid ? 10 ** ((requiredGainDb as number) / 20) : null;
  const candidate = !valid || outOfRange ? { status: 'unavailable', reason: valid ? 'GAIN_OUT_OF_RANGE' : 'NO_VALID_LOUDNESS',
    requiredGainDb, gainMultiplier, gains: [], measurement: null, meetsTarget: false, meetsTruePeak: false, marginDb: .5, applyAllowed: false }
    : { status: 'measured', reason: null, requiredGainDb, gainMultiplier,
      gains: [{ clipId, assetId: sourceId, beforeGain: .5, afterGain: .5 * (gainMultiplier as number) }],
      measurement: measurement({ frames, integrated: input.target.integratedLufs, scale: gainMultiplier as number }),
      meetsTarget: true, meetsTruePeak: (original.truePeakDbtp as number) + (requiredGainDb as number) <= input.target.truePeakCeilingDbtp - .5, marginDb: .5, applyAllowed: false };
  const passes = candidate.status === 'measured' ? 2 : 1;
  return { ...input, status: 'ready', checkedAt: '2026-10-14T06:00:00.000Z', stage: 'preencode_float_mix', applyAllowed: false,
    identity: { timelineId: captured.timelineId, timelineRevision: input.expectedRevision, snapshotSha256: 'b'.repeat(64),
      range: { startFrame: 0, endFrame: captured.durationFrames, sampleFrames: frames },
      sources: [{ assetId: sourceId, sha256: 'a'.repeat(64), sizeBytes: 128 }] }, original, candidate,
    checks: { bytesHashed: 256, pcmBytes: frames * 8 * passes, decodeWorkFrames: Number(captured.durationFrames) * passes,
      segmentCount: 1, passes, audioFullyDecoded: true } };
}
export const input = (target: {readonly integratedLufs: number; readonly truePeakCeilingDbtp: number} = { integratedLufs: -24, truePeakCeilingDbtp: -1 }) => ({ projectId, expectedRevision: 4,
  mixProfile: TIMELINE_MIX_LOUDNESS_PROFILE, measurementProfile: EXPORT_LOUDNESS_PROFILE, target });
interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
export const deferred = <T = unknown>(): Deferred<T> => { let resolve!: (value: T)=>void, reject!: (error: unknown)=>void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
type MixController = ReturnType<typeof createTimelineMixLoudnessController>
export function fixture(patch: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  let live = context(patch); const calls: {input: Record<string, unknown>; options: unknown; context: unknown}[] = [], reads: Deferred<unknown>[] = [], changes: unknown[] = [], auth: boolean[] = [];
  const controller: MixController = createTimelineMixLoudnessController({ getContext: () => live as never, getInvocation: () => ({}),
    onChange: (value: unknown) => changes.push(value), onUnauthorized: () => auth.push(false),
    read(value: Record<string, unknown>, options: unknown) { calls.push({ input: value, options, context: structuredClone(live) }); const wait = deferred(); reads.push(wait); return wait.promise; }, ...overrides } as never);
  controller.attach(live as never);
  const f = { controller, calls, reads, changes, auth, state: () => controller.getState(), live: () => live,
    set(patch: Record<string, unknown>, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live as never); },
    edit(value: Record<string, unknown> = draft) { return controller.setDraft(value as never, f.state() as never); }, prepare() { return controller.prepare(f.state() as never); }, cancel() { controller.cancel(f.state() as never); },
    async ready(value: unknown) { const wait = f.prepare(); assert.ok(reads.at(-1), 'Explicit populated target should start a read');
      reads.at(-1)?.resolve(value ?? report(calls.at(-1)?.input as never, calls.at(-1)?.context as never)); await wait; return f.state(); } };
  return f;
}

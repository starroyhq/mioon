import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { EXPORT_LOUDNESS_PROFILE, exportLoudnessReason, exportLoudnessSuggestion } from '@mioon/contracts/export-loudness';
import { createExportLoudnessController } from '../../apps/web/src/export-loudness-state.ts';
import { projectId, checkedAt, context } from './export-sample-peak-ui-fixture.ts';
export { projectId, checkedAt, context, row, asset, id, hash } from './export-sample-peak-ui-fixture.ts';

export type ExportLoudnessReasonCode = Parameters<typeof exportLoudnessReason>[0];
export interface LoudnessFile {readonly outputFrames: number; readonly exportId: string; readonly artifact: {readonly sha256: string; readonly sizeBytes: number}}
export function report(file: LoudnessFile, target: Record<string, unknown>|undefined, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const sampleFrames = file.outputFrames * 1600, blocks = sampleFrames < 19200 ? 0 : 1 + Math.floor((sampleFrames - 19200) / 4800);
  const measurement = { sampleRate: 48000 as const, channels: 2 as const, sampleFrames, decodedDurationSeconds: sampleFrames / 48000,
    state: (blocks ? 'valid' : 'too_short') as 'valid'|'too_short', integratedLufs: blocks ? -20 : null,
    samplePeakLinear: 0.5, samplePeakDbfs: 20 * Math.log10(0.5), truePeakLinear: 0.6, truePeakDbtp: 20 * Math.log10(0.6),
    gatingBlockCount: blocks, absoluteGatedBlockCount: blocks, relativeGatedBlockCount: blocks, relativeGateLufs: blocks ? -30 : null, ...patch } as never;
  return { projectId, exportId: file.exportId, expectedArtifactSha256: file.artifact.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE,
    ...(target ? { target } : {}), checkedAt, stage: 'decoded-export-file', status: 'ready', artifact: { ...structuredClone(file.artifact), snapshotSha256: 'd'.repeat(64) },
    measurement, suggestion: exportLoudnessSuggestion(measurement, target as never), reason: null,
    checks: { bytesHashed: 2 * file.artifact.sizeBytes, audioFullyDecoded: true } };
}
export function unready(file: LoudnessFile, status = 'incomplete', code: ExportLoudnessReasonCode = 'BUSY', target?: Record<string, unknown>): Record<string, unknown> {
  return { projectId, exportId: file.exportId, expectedArtifactSha256: file.artifact.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE,
    ...(target ? { target } : {}), checkedAt, stage: 'decoded-export-file', status, artifact: null, measurement: null, suggestion: null,
    reason: exportLoudnessReason(code), checks: { bytesHashed: 0, audioFullyDecoded: false } };
}
interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
const deferred = <T = unknown>(): Deferred<T> => { let resolve!: (value: T)=>void, reject!: (error: unknown)=>void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function fixture(patch: Record<string, unknown> = {}) {
  let live = context(patch); const calls: {input: unknown; options: unknown; }[] = [], reads: Deferred<unknown>[] = [], auth: boolean[] = [], changes: unknown[] = [];
  const controller = createExportLoudnessController({ isRenderRecord: isTimelineRenderRecord, getContext: () => live as never, getInvocation: () => ({}),
    onChange: (state: unknown) => changes.push(state), onUnauthorized: () => auth.push(false), read(input: unknown, options: unknown) { calls.push({ input, options }); const pending = deferred(); reads.push(pending); return pending.promise; } } as never);
  controller.setContext(live as never);
  const stateOf=(): {targets: Record<string, unknown>[]; scope?: unknown; draftVersion?: unknown; targetKey?: unknown}=>controller.getState() as never;
  const f = { controller, calls, reads, auth, changes, state: () => controller.getState(), target: (index = 0) => stateOf().targets[index],
    set(patch: Record<string, unknown>, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live as never); },
    edit(draft: unknown, index = 0) { return controller.setDraft(f.target(index) as never, stateOf().scope as never, draft as never, stateOf().draftVersion as never); },
    measure(index = 0) { return controller.measure(f.target(index) as never, stateOf().scope as never, stateOf().draftVersion as never); },
    cancel() { controller.cancel(stateOf().targets.find((t: Record<string, unknown>) => t.key === stateOf().targetKey) as never, stateOf().scope as never, stateOf().draftVersion as never); },
    async ready(value: unknown, index = 0) { const target = f.target(index), waiting = f.measure(index); assert.ok(reads.at(-1)); reads.at(-1)?.resolve(value ?? report(target as never, (calls.at(-1)?.input as {target?: Record<string, unknown>}|undefined)?.target)); await waiting; return f.state(); } };
  return f;
}

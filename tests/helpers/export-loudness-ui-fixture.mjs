import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { EXPORT_LOUDNESS_PROFILE, exportLoudnessReason, exportLoudnessSuggestion } from '@mioon/contracts/export-loudness';
import { createExportLoudnessController } from '../../apps/web/src/export-loudness-state.ts';
import { projectId, checkedAt, context } from './export-sample-peak-ui-fixture.mjs';
export { projectId, checkedAt, context, row, asset, id, hash } from './export-sample-peak-ui-fixture.mjs';

export function report(file, target, patch = {}) {
  const sampleFrames = file.outputFrames * 1600, blocks = sampleFrames < 19200 ? 0 : 1 + Math.floor((sampleFrames - 19200) / 4800);
  const measurement = { sampleRate: 48000, channels: 2, sampleFrames, decodedDurationSeconds: sampleFrames / 48000,
    state: blocks ? 'valid' : 'too_short', integratedLufs: blocks ? -20 : null,
    samplePeakLinear: 0.5, samplePeakDbfs: 20 * Math.log10(0.5), truePeakLinear: 0.6, truePeakDbtp: 20 * Math.log10(0.6),
    gatingBlockCount: blocks, absoluteGatedBlockCount: blocks, relativeGatedBlockCount: blocks, relativeGateLufs: blocks ? -30 : null, ...patch };
  return { projectId, exportId: file.exportId, expectedArtifactSha256: file.artifact.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE,
    ...(target ? { target } : {}), checkedAt, stage: 'decoded-export-file', status: 'ready', artifact: { ...structuredClone(file.artifact), snapshotSha256: 'd'.repeat(64) },
    measurement, suggestion: exportLoudnessSuggestion(measurement, target), reason: null,
    checks: { bytesHashed: 2 * file.artifact.sizeBytes, audioFullyDecoded: true } };
}
export function unready(file, status = 'incomplete', code = 'BUSY', target) {
  return { projectId, exportId: file.exportId, expectedArtifactSha256: file.artifact.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE,
    ...(target ? { target } : {}), checkedAt, stage: 'decoded-export-file', status, artifact: null, measurement: null, suggestion: null,
    reason: exportLoudnessReason(code), checks: { bytesHashed: 0, audioFullyDecoded: false } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function fixture(patch = {}) {
  let live = context(patch); const calls = [], reads = [], auth = [], changes = [];
  const controller = createExportLoudnessController({ isRenderRecord: isTimelineRenderRecord, getContext: () => live, getInvocation: () => ({}),
    onChange: state => changes.push(state), onUnauthorized: () => auth.push(false), read(input, options) { calls.push({ input, options }); const pending = deferred(); reads.push(pending); return pending.promise; } });
  controller.setContext(live);
  const f = { controller, calls, reads, auth, changes, state: () => controller.getState(), target: (index = 0) => controller.getState().targets[index],
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    edit(draft, index = 0) { return controller.setDraft(f.target(index), f.state().scope, draft, f.state().draftVersion); },
    measure(index = 0) { return controller.measure(f.target(index), f.state().scope, f.state().draftVersion); },
    cancel() { controller.cancel(f.state().targets.find(t => t.key === f.state().targetKey), f.state().scope, f.state().draftVersion); },
    async ready(value, index = 0) { const target = f.target(index), waiting = f.measure(index); assert.ok(reads.at(-1)); reads.at(-1).resolve(value ?? report(target, calls.at(-1).input.target)); await waiting; return f.state(); } };
  return f;
}

import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { EXPORT_SAMPLE_PEAK_ALGORITHM, exportSamplePeakReason } from '@mioon/contracts/export-sample-peak';
import { createExportSamplePeakController } from '../../apps/web/src/export-sample-peak-state.ts';

export const id = n => `bf000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const projectId = id(1), hash = 'a'.repeat(64), checkedAt = '2026-10-13T04:20:00.000Z';
export function row(n = 10, fields = {}) {
  const timeline = { id: id(2), projectId, revision: 4, width: 720, height: 1280, fps: 30, durationFrames: 60, createdAt: checkedAt, updatedAt: checkedAt,
    tracks: [{ id: id(3), name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
    clips: [{ id: id(4), trackId: id(3), assetId: id(5), name: 'Historical image', startFrame: 0, durationFrames: 60, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 }] };
  return { id: id(n), projectId, assetId: id(n + 100), mode: 'timeline', purpose: 'export', status: 'succeeded', error: null,
    timelineRevision: 4, requestId: `original-request-${n}`, url: `/media/${id(n + 100)}`, createdAt: checkedAt, updatedAt: checkedAt,
    snapshot: { timeline, assets: [{ id: id(5), sha256: hash, mimeType: 'image/png' }], ...fields } };
}
export function asset(item) { return { id: item.assetId, projectId, url: item.url, mimeType: 'video/mp4', provenance: 'export', sha256: hash, sizeBytes: 128 }; }
export function context(patch = {}) { const items = [row(), row(11, { deliveryName: '冻结的成片 <v1>', exportRange: { startFrame: 15, endFrame: 45 } })]; return { scope: `${projectId}:1:normal`, projectId, executionScope: '0:0:editing', connected: true, visible: true, restored: false, exports: items, assets: items.map(asset), ...patch }; }
export function report(target, peak = 0.5, right = 0.25) {
  const amplitude = value => ({ peakLinear: value, peakDbfs: value === 0 ? null : 20 * Math.log10(value), silent: value === 0 });
  return { projectId, exportId: target.exportId, algorithm: EXPORT_SAMPLE_PEAK_ALGORITHM, checkedAt, status: 'ready', artifact: structuredClone(target.artifact),
    measurement: { sampleRate: 48000, channels: 2, sampleFrames: target.outputFrames * 1600, decodedDurationSeconds: target.outputFrames / 30,
      ...amplitude(Math.max(peak, right)), overFullScale: Math.max(peak, right) > 1, channelPeaks: [{ channel: 0, label: 'left', ...amplitude(peak) }, { channel: 1, label: 'right', ...amplitude(right) }] },
    reason: Math.max(peak, right) > 1 ? exportSamplePeakReason('OVER_FULL_SCALE') : null, checks: { bytesHashed: 256, audioFullyDecoded: true } };
}
export function unready(target, status = 'incomplete', code = 'BUSY') { return { projectId, exportId: target.exportId, algorithm: EXPORT_SAMPLE_PEAK_ALGORITHM, checkedAt, status, artifact: null, measurement: null, reason: exportSamplePeakReason(code), checks: { bytesHashed: 0, audioFullyDecoded: false } }; }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function fixture(patch = {}) {
  let live = context(patch); const calls = [], reads = [], auth = [], changes = [];
  const controller = createExportSamplePeakController({ isRenderRecord: isTimelineRenderRecord, getContext: () => live, getInvocation: () => ({}),
    onChange: state => changes.push(state), onUnauthorized: () => auth.push(false), read(input, options) { calls.push({ input, options }); const pending = deferred(); reads.push(pending); return pending.promise; } });
  controller.setContext(live);
  const f = { controller, calls, reads, auth, changes, state: () => controller.getState(), target: (index = 0) => controller.getState().targets[index],
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    check(index = 0) { return controller.check(f.target(index), f.state().scope); },
    async ready(value, index = 0) { const target = f.target(index), waiting = f.check(index); assert.ok(reads.at(-1)); reads.at(-1).resolve(value ?? report(target)); await waiting; return f.state(); } };
  return f;
}


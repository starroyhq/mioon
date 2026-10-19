import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { isExportPreviewRange, suggestedExportPreviewRange, exportPreviewContextKey, exportPreviewResult } from '../apps/web/src/export-preview-state.ts';
import { row, id, projectId } from './helpers/export-sample-peak-ui-fixture.ts';

function fixture() {
  const record = row(10, { exportRange: { startFrame: 0, endFrame: 30 } });
  const input = { projectId, requestId: record.requestId, expectedRevision: 4, purpose: 'export', exportRange: { startFrame: 0, endFrame: 30 } };
  assert.ok(isTimelineRenderRecord(record, input));
  const attempt = { scope: 'project:epoch', timelineId: id(2), input, exportId: record.id, contextKey: 'frozen', submitting: false, receipt: record };
  const context = { scope: attempt.scope, contextKey: 'frozen', connected: true, isRenderRecord: isTimelineRenderRecord };
  return { record, attempt, context, result: (records = [record], patch = {}) => exportPreviewResult(attempt, records, { ...context, ...patch }) };
}
test('range is explicitly bounded to 1–300 integer frames inside saved duration', () => {
  for (const length of [1, 300]) assert.ok(isExportPreviewRange({ startFrame: 12, endFrame: 12 + length }, 600));
  for (const range of [null, {}, { startFrame: 0, endFrame: 301 }, { startFrame: -1, endFrame: 30 }, { startFrame: 30, endFrame: 30 }, { startFrame: 0.5, endFrame: 2 }, { startFrame: 0, endFrame: 601 }]) assert.equal(isExportPreviewRange(range, 600), false);
  assert.deepEqual(suggestedExportPreviewRange(600, 580), { startFrame: 580, endFrame: 600 });
  assert.deepEqual(suggestedExportPreviewRange(600, 90, { startFrame: 20, endFrame: 40 }), { startFrame: 20, endFrame: 40 });
  assert.equal(suggestedExportPreviewRange(0), null);
});
test('exact request/export/asset produces only dedicated preview URL, never a supplied row URL', () => {
  const f = fixture();
  assert.equal(f.result().url, `/media/${f.record.assetId}?preview=1&exportId=${f.record.id}`);
  assert.equal(f.result([row(11), f.record]).record.id, f.record.id);
  for (const patch of [{ id: id(99) }, { projectId: id(99) }, { url: 'https://attacker.invalid/video' }, { assetId: id(99) }, { timelineRevision: 5 }]) {
    assert.equal(f.result([{ ...f.record, ...patch }]).url, null);
  }
  const wrongTimeline = structuredClone(f.record); wrongTimeline.snapshot.timeline.id = id(99);
  assert.equal(f.result([wrongTimeline]).url, null);
});
test('duplicate or conflicting exact requests fail closed even with known export ID', () => {
  const f = fixture();
  assert.equal(f.result([f.record, f.record]).phase, 'unavailable');
  assert.equal(f.result([f.record, { ...f.record, id: id(11) }]).url, null);
});
test('owner, stale, connection and held boundaries remove playback without changing request', () => {
  const f = fixture(), before = structuredClone(f.attempt);
  for (const patch of [{ scope: 'project:next-epoch' }, { contextKey: 'changed' }, { connected: false }, { heldExportIds: [f.record.id] }]) assert.equal(f.result(undefined, patch).url, null);
  assert.deepEqual(f.attempt, before);
  assert.equal(f.result(undefined, { contextKey: 'changed' }).stale, true);
});
test('in-flight, uncertain, running and failure states never manufacture playable files', () => {
  const f = fixture(); f.attempt.receipt = null; f.attempt.exportId = null; f.attempt.submitting = true;
  assert.equal(f.result([]).phase, 'submitting'); f.attempt.submitting = false;
  assert.equal(f.result([]).phase, 'unknown');
  for (const status of ['queued', 'running']) {
    const result = f.result([{ ...f.record, status, assetId: null, url: null }]);
    assert.equal(result.phase, status); assert.equal(result.url, null);
  }
  assert.equal(f.result([f.record]).record.id, f.record.id, 'late exact receipt can be observed without resubmitting');
});
test('staleness binds settings/range versions, saved timeline and referenced source identity, not unrelated assets', () => {
  const f = fixture(), timeline = f.record.snapshot.timeline;
  const context = { scope: 'workspace:project:epoch', projectId, timelineId: timeline.id, revision: 4, exportSettings: {}, settingsVersion: 1, exportRange: f.attempt.input.exportRange, rangeVersion: 1 };
  const assets = [{ id: id(5), sha256: 'a' }], key = exportPreviewContextKey(context, timeline, assets);
  for (const patch of [{ scope: 'different-workspace' }, { settingsVersion: 2 }, { rangeVersion: 2 }, { revision: 5 }, { exportSettings: { changed: true } }]) assert.notEqual(exportPreviewContextKey({ ...context, ...patch }, timeline, assets), key);
  assert.notEqual(exportPreviewContextKey(context, timeline, [{ id: id(5), sha256: 'b' }]), key);
  assert.notEqual(exportPreviewContextKey(context, { ...timeline, width: 1280 }, assets), key);
  assert.equal(exportPreviewContextKey(context, timeline, [...assets, { id: id(99), sha256: 'unrelated' }]), key);
});

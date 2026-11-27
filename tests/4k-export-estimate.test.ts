import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  hasRequestNotAppliedProof, isExportPreflightResponse, operationEffect,
  TIMELINE_EXPORT_DEFAULT_SETTINGS, timelineExportEstimateResponseSchema,
} from '@mioon/contracts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {OUTPUT_ARTIFACT_MAX_BYTES} from '../packages/contracts/src/output-artifact.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../packages/contracts/src/project-output-publication.ts';
import type {TimelineExportEstimateResponse} from '../packages/contracts/src/timeline-export-estimate.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {readTimelineHeaderStorage} from '../packages/business/src/project-file/timeline-storage.ts';
import {createServices} from '../packages/business/src/services.ts';
import {estimateTimelineExportRow} from '../packages/business/src/timeline-export-estimate.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const bitrate = {mode: 'bitrate', targetKbps: 4000} as const;
const exportSettings = {profileId: 'mp4_h264_v1', resolution: 'short_2160', rateControl: bitrate} as const;
const alwaysFits = () => true;

async function fixture(t: test.TestContext, {availableBytes, memoryAllows}: {
  availableBytes?: () => number | null;
  memoryAllows?: (requiredBytes: number) => boolean;
} = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-4k-estimate-'));
  const store = openStore(root, 4);
  let probes = 0;
  const services = createServices(store, new Map(), {exportOptions: {
    availableBytes, memoryAllows: memoryAllows ?? alwaysFits,
    inspect: async () => {probes++;return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};},
  }});
  t.after(async () => {await services.drain();store.close();rmSync(root, {recursive: true, force: true});});
  const project = await services.call('project.create', {name: 'Synthetic 4K estimate'}) as {id: string};
  const projectId = project.id;
  const initial = await services.call('timeline.get', {projectId}) as {revision: number; tracks: {id: string}[]};
  const bytes = png(), assetId = randomUUID(), relativePath = `media/${assetId}.png`;
  writeFileSync(join(root, relativePath), bytes);
  store.put('assets', {id: assetId, projectId, name: 'Synthetic pixels', mimeType: 'image/png', relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
    width: 16, height: 16, duration: 0, hasAudio: false, createdAt: new Date().toISOString()});
  const timeline = await services.call('timeline.clip.add', {projectId, expectedRevision: initial.revision,
    requestId: randomUUID(), trackId: initial.tracks[0]!.id, assetId, startFrame: 0, durationFrames: 90,
  }) as {id: string; revision: number; clips: {id: string}[]};
  const binding = {projectId, expectedRevision: timeline.revision};
  const estimateInput = {...binding, profileId: exportSettings.profileId, rateControl: bitrate};
  const snapshot = () => ({
    timeline: readTimelineHeaderStorage(store.db, projectId),
    renders: store.db.prepare('SELECT count(*) AS count FROM exports').get()?.count,
    receipts: store.db.prepare('SELECT count(*) AS count FROM timeline_requests').get()?.count,
  });
  return {root, store, services, binding, estimateInput, clipId: timeline.clips[0]!.id, snapshot, get probes() {return probes;}};
}

test('estimate is a version-bound read of all five tiers and an optional exact export range', async t => {
  const f = await fixture(t, {availableBytes: () => 2 ** 40});
  const before = f.snapshot();
  const result = await f.services.call('timeline.export.estimate', f.estimateInput) as TimelineExportEstimateResponse;
  assert.ok(timelineExportEstimateResponseSchema.safeParse(result).success);
  assert.deepEqual(result.estimates.map(({resolution}) => resolution), ['native', 'short_360', 'short_720', 'short_1080', 'short_2160']);
  assert.equal(result.availableBytes, 2 ** 40);
  const full = result.estimates.at(-1)!;
  assert.deepEqual([full.width, full.height], [2160, 3840]);
  assert.equal(full.estimatedBytes, Math.ceil((16_000 + 128) * 1000 / 8 * 3 * 1.01));
  assert.ok(full.estimatedSeconds > 0);
  assert.deepEqual(full.issues, []);

  const rangeResult = await f.services.call('timeline.export.estimate', {...f.estimateInput,
    profileId: 'mp4_h264_float_checked_v2', exportRange: {startFrame: 30, endFrame: 60},
  }) as TimelineExportEstimateResponse;
  assert.equal(rangeResult.estimates.at(-1)!.estimatedBytes, Math.ceil(full.estimatedBytes / 3));
  assert.ok(rangeResult.estimates.at(-1)!.estimatedSeconds < full.estimatedSeconds);
  await assert.rejects(f.services.call('timeline.export.estimate', {...f.estimateInput,
    exportRange: {startFrame: 30, endFrame: 91}}), {code: 'EXPORT_RANGE_BOUNDS'});
  await assert.rejects(f.services.call('timeline.export.estimate', {...f.estimateInput,
    expectedRevision: f.binding.expectedRevision + 1}), {code: 'REVISION_CONFLICT'});
  await assert.rejects(f.services.call('timeline.export.estimate', {...f.estimateInput,
    destination: '/app-private'}), {code: 'VALIDATION_ERROR'});
  assert.equal(f.probes, 0);
  assert.equal(operationEffect('timeline.export.estimate').readOnly, true);
  assert.equal(operationEffect('timeline.export.estimate').localProcess, false);
  assert.deepEqual(f.snapshot(), before);
});

test('resource blocks agree across estimates, preflight and direct admission without probing or queuing', async t => {
  let availableBytes = 1;
  let withinMemoryBudget = true;
  const f = await fixture(t, {availableBytes: () => availableBytes, memoryAllows: () => withinMemoryBudget});
  const before = f.snapshot();
  const estimate = await f.services.call('timeline.export.estimate', f.estimateInput) as TimelineExportEstimateResponse;
  const expected = estimate.estimates.at(-1)!.issues[0]!;
  assert.equal(expected.code, 'EXPORT_DISK_SPACE_INSUFFICIENT');
  assert.deepEqual(expected.details, {estimatedBytes: estimate.estimates.at(-1)!.estimatedBytes, availableBytes});
  const preflightInput = {...f.binding, exportSettings};
  const preflight = await f.services.call('timeline.export.preflight', preflightInput) as {status: string;issues: unknown[];checks: {checkedAssets: number}};
  assert.ok(isExportPreflightResponse(preflight, preflightInput));
  assert.equal(preflight.status, 'blocked');
  assert.deepEqual(preflight.issues, [expected]);
  assert.equal(preflight.checks.checkedAssets, 0);
  const request = {...preflightInput, requestId: randomUUID(), purpose: 'export'};
  await assert.rejects(f.services.call('timeline.render', request), (error: unknown) => {
    const failure = error as {code: string;details: Record<string, unknown>};
    return failure.code === expected.code && hasRequestNotAppliedProof(error, request, {operation: 'timeline.render'}) &&
      failure.details.estimatedBytes === estimate.estimates.at(-1)!.estimatedBytes && failure.details.availableBytes === availableBytes;
  });
  assert.equal(f.probes, 0);
  assert.deepEqual(f.snapshot(), before);
  availableBytes = 2 ** 40;
  withinMemoryBudget = false;
  const lowMemory = await f.services.call('timeline.export.preflight', preflightInput) as {status: string;issues: {code: string}[]};
  assert.equal(lowMemory.status, 'blocked');
  assert.equal(lowMemory.issues[0]?.code, 'EXPORT_4K_MEMORY_INSUFFICIENT');
  assert.deepEqual(f.snapshot(), before);
  withinMemoryBudget = true;
  const accepted = await f.services.call('timeline.render', request);
  assert.equal(f.probes, 1);
  availableBytes = 0;
  assert.deepEqual(await f.services.call('timeline.render', request), accepted);
  assert.equal(f.probes, 1, 'an exact accepted receipt wins over current disk space');
});

test('a saved transform beyond the 4K raster bound blocks preflight before a process can start', async t => {
  const f = await fixture(t, {availableBytes: () => 2 ** 40});
  const {timeline} = await f.services.call('timeline.clip.setTransform', {
    ...f.binding, requestId: randomUUID(), clipId: f.clipId, transform: {
      profileId: CLIP_TRANSFORM_PROFILE, crop: {left: 0, right: 0, top: 0, bottom: 0},
      rotation: 45, keyframes: [{frame: 0, x: 0, y: 0, scale: 8}],
    },
  }) as {timeline: {revision: number}};
  const expectedRevision = timeline.revision;
  const estimate = await f.services.call('timeline.export.estimate', {...f.estimateInput, expectedRevision}) as TimelineExportEstimateResponse;
  const raster = estimate.estimates.at(-1)!.issues[0]!;
  assert.equal(raster.code, 'EXPORT_4K_RASTER_UNSUPPORTED');
  assert.deepEqual(estimate.estimates.find(row => row.resolution === 'short_1080')?.issues, []);
  const preflightInput = {projectId: f.binding.projectId, expectedRevision, exportSettings};
  const preflight = await f.services.call('timeline.export.preflight', preflightInput) as {status: string;issues: unknown[]};
  assert.ok(isExportPreflightResponse(preflight, preflightInput));
  assert.equal(preflight.status, 'blocked');
  assert.deepEqual(preflight.issues, [raster]);
  await assert.rejects(f.services.call('timeline.render', {...preflightInput, requestId: randomUUID(), purpose: 'export'}),
    {code: 'EXPORT_4K_RASTER_UNSUPPORTED'});
  assert.equal(f.probes, 0);
});

test('future FPS and the artifact size cap have separate details and do not affect other tiers', () => {
  const basis = {id: randomUUID(), revision: 1, width: 1920, height: 1080, fps: 30, durationFrames: 90};
  for (const fps of [24, 25, 30]) {
    assert.deepEqual(estimateTimelineExportRow({...basis, fps}, exportSettings, fps, null, alwaysFits).issues, []);
  }
  const at60 = estimateTimelineExportRow({...basis, fps: 60}, exportSettings, 60, null, alwaysFits);
  assert.equal(at60.issues[0]?.code, 'EXPORT_4K_FPS_UNSUPPORTED');
  assert.deepEqual(at60.issues[0]?.details, {fps: 60, maxFps: 30});
  assert.deepEqual(estimateTimelineExportRow({...basis, fps: 60}, TIMELINE_EXPORT_DEFAULT_SETTINGS, 60, null, alwaysFits).issues, []);
  // Reach the cap independently of the current ten-minute timeline editor.
  const long = estimateTimelineExportRow(basis, {...exportSettings, rateControl: {mode: 'bitrate', targetKbps: 8000}},
    60 * 60 * basis.fps, 2 ** 40, alwaysFits);
  assert.ok(long.estimatedBytes > OUTPUT_ARTIFACT_MAX_BYTES);
  assert.equal(long.issues[0]?.code, 'EXPORT_OUTPUT_TOO_LARGE');
  assert.deepEqual(long.issues[0]?.details, {estimatedBytes: long.estimatedBytes, maxBytes: OUTPUT_ARTIFACT_MAX_BYTES});
});

test('preflight reports the 8 GiB cap before probing media', async t => {
  const f = await fixture(t, {availableBytes: () => 2 ** 40});
  // A saved duration beyond the editor limit makes the cap reachable in this
  // synthetic fixture without encoding hours of footage.
  f.store.db.prepare("UPDATE project.timelines SET data=json_set(data,'$.durationFrames',?) WHERE projectId=?")
    .run(60 * 60 * 30, f.binding.projectId);
  const input = {...f.binding, exportSettings: {...exportSettings, rateControl: {mode: 'bitrate', targetKbps: 8000}}};
  const report = await f.services.call('timeline.export.preflight', input) as {
    status: string; issues: {code: string; details: {estimatedBytes: number; maxBytes: number}}[];
    checks: {checkedAssets: number};
  };
  assert.ok(isExportPreflightResponse(report, input));
  assert.equal(report.status, 'blocked');
  const issue = report.issues[0]!;
  assert.equal(issue.code, 'EXPORT_OUTPUT_TOO_LARGE');
  assert.equal(issue.details.maxBytes, OUTPUT_ARTIFACT_MAX_BYTES);
  assert.ok(issue.details.estimatedBytes > issue.details.maxBytes);
  assert.equal(report.checks.checkedAssets, 0);
  assert.equal(f.probes, 0);
});

test('space lookup does not create the export folder or follow a substituted symlink', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  const outputFolder = join(f.store.projectDir, PROJECT_OUTPUT_FOLDERS.exports);
  assert.equal(existsSync(outputFolder), false);
  const valid = await f.services.call('timeline.export.estimate', f.estimateInput) as TimelineExportEstimateResponse;
  assert.ok(valid.availableBytes === null || valid.availableBytes >= 0);
  assert.equal(existsSync(outputFolder), false);
  symlinkSync(f.store.tempDir, outputFolder, 'dir');
  await assert.rejects(f.services.call('timeline.export.estimate', f.estimateInput),
    (error: unknown) => (error as {code: string}).code === 'PROJECT_UNAVAILABLE' && !String(error).includes(f.root));
});

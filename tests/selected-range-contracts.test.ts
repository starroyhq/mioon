import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  parse, schemas, isTimelineMutationResponse, isTimelineRenderRecord, isTimelineExportSnapshot,
  isExportPreflightResponse, exportPreflightResponseSchema, resolveTimelineExportDelivery,
  TIMELINE_EXPORT_DEFAULT_SETTINGS, hasRequestNotAppliedProof, DURABLE_EDIT_OPERATIONS,
} from '@mioon/contracts';
import {
  timelineExportRangeSchema, isTimelineExportRangeInput, timelineExportRangeFields,
  isTimelineExportRangeWithinDuration, isTimelineExportRangeSnapshot, timelineExportOutputFrames,
} from '@mioon/contracts/timeline-export-range';
import {
  timelineRenderDeliveryFields, hasTimelineDeliveryIdentity, TIMELINE_DELIVERY_RECEIPT_SQL,
} from '@mioon/contracts/timeline-delivery';
import {createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import {discoverSchema} from '@mioon/client';
import {assertOperationInputBranches} from './helpers/catalog-input-branches.ts';

const clone = <T>(value: T): T => structuredClone(value);
const stamp = '2026-10-13T00:00:00.000Z';
const selection = () => ({startFrame: 7, endFrame: 19});
function fixture(extra: { readonly deliveryName?: undefined; exportSettings?: undefined; readonly exportRange?: undefined; }|{ deliveryName?: string; exportSettings?: undefined; readonly exportRange?: undefined; }|{ exportSettings?: Readonly<{ profileId: "mp4_h264_v1"; resolution: "native"; rateControl: Readonly<{ mode: "crf"; quality: "standard"; }>; }>; readonly deliveryName?: undefined; readonly exportRange?: undefined; }|{ exportRange?: { startFrame: number; endFrame: number; }; readonly deliveryName?: undefined; exportSettings?: undefined; }|{ deliveryName?: string; exportSettings?: Readonly<{ profileId: "mp4_h264_v1"; resolution: "native"; rateControl: Readonly<{ mode: "crf"; quality: "standard"; }>; }>; exportRange?: { startFrame: number; endFrame: number; }; }|{ exportRange?: { startFrame: number; endFrame: number; }; deliveryName?: string; exportSettings?: undefined; }|{ exportRange?: { startFrame: number; endFrame: number; }; exportSettings?: Readonly<{ profileId: "mp4_h264_v1"; resolution: "native"; rateControl: Readonly<{ mode: "crf"; quality: "standard"; }>; }>; deliveryName?: undefined; }|undefined = {}) {
  const projectId = randomUUID(), trackId = randomUUID(), assetId = randomUUID();
  const input = {projectId, expectedRevision: 4, requestId: randomUUID(), purpose: 'export', ...extra};
  const timeline = {id: randomUUID(), projectId, revision: 4, fps: 30, width: 720, height: 1280,
    tracks: [{id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: randomUUID(), trackId, assetId, name: 'Image', startFrame: 0, durationFrames: 60,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}],
    durationFrames: 60, createdAt: stamp, updatedAt: stamp};
  const snapshot = {timeline,
    ...(Object.hasOwn(input, 'deliveryName') ? {deliveryName: input.deliveryName} : {}),
    ...(Object.hasOwn(input, 'exportSettings') ? {delivery: resolveTimelineExportDelivery(timeline, input.exportSettings)} : {}),
    ...(Object.hasOwn(input, 'exportRange') ? {exportRange: clone(input.exportRange)} : {}),
    assets: [{id: assetId, sha256: 'a'.repeat(64), mimeType: 'image/png', duration: 0, width: 720, height: 1280, hasAudio: false}]};
  const response = {id: randomUUID(), projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose,
    timelineRevision: 4, snapshot, status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
  return {input, timeline, snapshot, response};
}
function report(f: ReturnType<typeof fixture>) {
  return {projectId: f.input.projectId, timelineId: f.timeline.id, timelineRevision: 4, expectedRevision: 4,
    snapshotHash: 'b'.repeat(64), checkedAt: stamp, status: 'ready',
    summary: {fps: 30, width: 720, height: 1280, durationFrames: 60, trackCount: 1, clipCount: 1, assetCount: 1,
      visualClipCount: 1, audibleClipCount: 0, mutedTrackCount: 0, hiddenVideoTrackCount: 0,
      ...(Object.hasOwn(f.snapshot, 'exportRange') ? {exportRange: clone(f.snapshot.exportRange)} : {}),
      ...(Object.hasOwn(f.snapshot, 'deliveryName') ? {deliveryName: f.snapshot.deliveryName} : {}),
      ...(Object.hasOwn(f.snapshot, 'delivery') ? {delivery: clone(f.snapshot.delivery)} : {})},
    checks: {totalAssets: 1, checkedAssets: 1, bytesHashed: 123, fullDecode: false}, issues: []};
}

const badRanges = [undefined, null, [], {}, 7, '7:19', {startFrame: 1}, {endFrame: 2},
  {startFrame: 0, endFrame: 0}, {startFrame: 4, endFrame: 3}, {startFrame: -1, endFrame: 2},
  {startFrame: 18000, endFrame: 18001}, {startFrame: 0, endFrame: 18001},
  {startFrame: 0.5, endFrame: 2}, {startFrame: 0, endFrame: 1.5},
  {startFrame: '0', endFrame: 2}, {startFrame: 0, endFrame: '2'},
  {startFrame: NaN, endFrame: 2}, {startFrame: 0, endFrame: Infinity},
  {startFrame: 0, endFrame: Number.MAX_SAFE_INTEGER + 1},
  {...selection(), fps: 30}, {...selection(), purpose: 'export'}, {...selection(), durationFrames: 12},
  {...selection(), startFrame: undefined}, {...selection(), endFrame: undefined}];

test('range syntax is strict, integer, nonempty, export-only and preserves legacy omission', () => {
  const {input} = fixture(), legacyBytes = JSON.stringify(input);
  assert.equal(JSON.stringify(parse('timeline.render', input)), legacyBytes);
  assert.equal(Object.hasOwn(parse('timeline.render', input), 'exportRange'), false);
  assert.deepEqual(timelineExportRangeFields(input), {});
  assert.equal(isTimelineExportRangeInput(input, 'preview'), true);
  for (const exportRange of [{startFrame: 0, endFrame: 1}, selection(), {startFrame: 17999, endFrame: 18000}, {startFrame: 0, endFrame: 18000}]) {
    assert.deepEqual(timelineExportRangeSchema.parse(exportRange), exportRange);
    assert.deepEqual(parse('timeline.render', {...input, exportRange}), {...input, exportRange});
    assert.deepEqual(parse('timeline.export.preflight', {projectId: input.projectId, expectedRevision: 4, exportRange}),
      {projectId: input.projectId, expectedRevision: 4, exportRange});
    const fields = timelineExportRangeFields({exportRange});
    assert.deepEqual(fields, {exportRange}); assert.notEqual(fields.exportRange, exportRange);
    assert.equal(isTimelineExportRangeInput({exportRange}, 'export'), true);
    assert.throws(() => parse('timeline.render', {...input, exportRange, purpose: 'preview'}), {code: 'VALIDATION_ERROR'});
  }
  for (const exportRange of badRanges) {
    assert.equal(isTimelineExportRangeInput({exportRange}), false);
    assert.throws(() => timelineExportRangeFields({exportRange}), {code: 'INVALID_TIMELINE_SNAPSHOT'});
    assert.throws(() => parse('timeline.render', {...input, exportRange}), {code: 'VALIDATION_ERROR'});
    assert.throws(() => parse('timeline.export.preflight', {projectId: input.projectId, expectedRevision: 4, exportRange}), {code: 'VALIDATION_ERROR'});
  }
  for (const value of [undefined, null, [], 1]) assert.equal(isTimelineExportRangeInput(value), false);
  assert.equal(JSON.stringify(input), legacyBytes);
});

test('frozen range validates its own full composition and binds exact caller presence/value', () => {
  for (const extra of [{}, {deliveryName: 'Named'}, {exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS},
    {deliveryName: 'Named', exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS}]) {
    const f = fixture({...extra, exportRange: selection()}), bytes = JSON.stringify(f);
    assert.ok(isTimelineMutationResponse('timeline.render', f.input, f.response));
    assert.ok(isTimelineRenderRecord(f.response, f.input));
    assert.ok(isTimelineExportSnapshot(f.snapshot));
    assert.ok(isTimelineExportRangeSnapshot(f.snapshot, {purpose: 'export', input: f.input}));
    assert.equal(timelineExportOutputFrames(f.snapshot), 12);
    assert.equal(f.snapshot.timeline.durationFrames, 60);
    const omitted = {...f.input}; delete omitted.exportRange;
    assert.equal(isTimelineRenderRecord(f.response, omitted), false);
    assert.equal(isTimelineRenderRecord(f.response, {...f.input, exportRange: {startFrame: 8, endFrame: 20}}), false);
    assert.equal(isTimelineRenderRecord(f.response, {...f.input, exportRange: undefined}), false);
    assert.equal(isTimelineExportRangeSnapshot(f.snapshot, {purpose: 'preview'}), false);
    assert.equal(isTimelineExportRangeSnapshot(f.snapshot, {input: undefined}), false);
    for (const mutate of [r => {delete r.snapshot.exportRange;}, r => {r.snapshot.exportRange = undefined;},
r => {r.snapshot.exportRange!.endFrame = 61;}, r => {r.snapshot.exportRange!.startFrame = 19;},
r => {r.snapshot.exportRange!.extra = 1;}, r => {r.snapshot.timeline.fps = 60;}] as ((r: {snapshot: {exportRange?: {startFrame?: number; endFrame?: number; extra?: number}; timeline: {fps: number}}}) => void)[]) {
      const bad = clone(f.response); mutate(bad);
      assert.equal(isTimelineRenderRecord(bad, f.input), false);
    }
    assert.equal(JSON.stringify(f), bytes);
  }
  const legacy = fixture(), before = JSON.stringify(legacy.response);
  assert.ok(isTimelineRenderRecord(legacy.response, legacy.input));
  assert.equal(timelineExportOutputFrames(legacy.snapshot), 60);
  assert.deepEqual(timelineRenderDeliveryFields(legacy.snapshot), {});
  assert.equal(JSON.stringify(legacy.response), before);
  assert.equal(isTimelineExportRangeSnapshot(legacy.snapshot, {input: {...legacy.input, exportRange: {startFrame: 0, endFrame: 60}}}), false);
  const full = fixture({exportRange: {startFrame: 0, endFrame: 60}});
  assert.equal(timelineExportOutputFrames(full.snapshot), 60);
  assert.ok(Object.hasOwn(full.snapshot, 'exportRange'));
});

test('syntax projection never checks the current timeline, while output length requires a valid frozen clock', () => {
  const value = {exportRange: selection()}, before = JSON.stringify(value);
  assert.deepEqual(timelineExportRangeFields(value), value);
  assert.equal(isTimelineExportRangeWithinDuration(value, 19), true);
  for (const duration of [18, 0, -1, 19.5, '19', NaN, Infinity, 18001, undefined]) {
    assert.equal(isTimelineExportRangeWithinDuration(value, duration), false);
  }
  assert.equal(isTimelineExportRangeWithinDuration({}, undefined), true);
  assert.equal(isTimelineExportRangeWithinDuration({exportRange: undefined}, 60), false);
  for (const snapshot of [null, {}, {timeline: {}}, {timeline: {fps: 60, durationFrames: 60}},
    {timeline: {fps: 30, durationFrames: 0}}, {timeline: {fps: 30, durationFrames: 18001}},
    {timeline: {fps: 30, durationFrames: 18}, ...value}]) {
    assert.throws(() => timelineExportOutputFrames(snapshot), {code: 'INVALID_TIMELINE_SNAPSHOT'});
  }
  assert.equal(JSON.stringify(value), before);
});

test('preflight summaries retain full duration while exact range participates in every non-null binding', () => {
  const f = fixture({exportRange: selection(), deliveryName: 'Named', exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS});
  const value = report(f), before = JSON.stringify(value);
  assert.ok(isExportPreflightResponse(value, f.input));
  assert.equal(value.summary.durationFrames, 60);
  for (const status of ['ready', 'blocked', 'incomplete', 'stale']) {
    const candidate = {...value, status};
    assert.ok(isExportPreflightResponse(candidate, f.input));
    const omitted = {...f.input}; delete omitted.exportRange;
    assert.equal(isExportPreflightResponse(candidate, omitted), false);
    assert.equal(isExportPreflightResponse(candidate, {...f.input, exportRange: {startFrame: 7, endFrame: 20}}), false);
    assert.equal(isExportPreflightResponse(candidate, {...f.input, exportRange: undefined}), false);
  }
  for (const exportRange of [...badRanges, {startFrame: 0, endFrame: 61}]) {
    assert.equal(exportPreflightResponseSchema.safeParse({...value, summary: {...value.summary, exportRange}}).success, false);
  }
  const withoutRange = clone(value); delete (withoutRange)!.summary.exportRange;
  assert.equal(isExportPreflightResponse(withoutRange, f.input), false);
  const stale = {...value, status: 'stale', timelineRevision: 5, summary: null, snapshotHash: null,
    issues: [{code: 'PREFLIGHT_STALE', severity: 'error', message: 'The saved revision changed.'}]};
  assert.ok(isExportPreflightResponse(stale, f.input));
  const blocked = {...value, status: 'blocked', summary: null, snapshotHash: null,
    issues: [{code: 'EXPORT_RANGE_BOUNDS', severity: 'error', message: 'The selected range exceeds the saved timeline.'}]};
  assert.ok(isExportPreflightResponse(blocked, f.input));
  assert.equal(JSON.stringify(value), before);
  const old = fixture(), oldReport = report(old), oldBytes = JSON.stringify(oldReport);
  assert.ok(isExportPreflightResponse(oldReport, old.input));
  assert.equal(JSON.stringify(oldReport), oldBytes);
  assert.equal(Object.hasOwn(oldReport.summary, 'exportRange'), false);
});

test('receipt reconstruction and bounded SQL distinguish range-only records including removed current fields', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const extra of [{}, {deliveryName: 'Name'}, {exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS},
      {exportRange: selection()}, {deliveryName: 'Name', exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS, exportRange: selection()}]) {
      const f = fixture(extra), before = JSON.stringify(f.snapshot);
      assert.deepEqual(timelineRenderDeliveryFields(f.snapshot), extra);
      assert.equal(hasTimelineDeliveryIdentity(f.response), Object.keys(extra).length > 0);
      const found = db.prepare(`SELECT ${TIMELINE_DELIVERY_RECEIPT_SQL} AS retained FROM (SELECT ? AS response)`).get(JSON.stringify(f.response));
      assert.equal((found)!.retained !== null, Object.keys(extra).length > 0);
      const current = clone(f.response); delete (current)!.snapshot.exportRange;
      if (Object.keys(extra).length === 1 && extra.exportRange) {
        assert.equal(hasTimelineDeliveryIdentity(current), false);
        assert.equal((found)!.retained, 'object', 'original receipt still activates strict worker identity validation');
      }
      assert.equal(JSON.stringify(f.snapshot), before);
    }
    assert.equal(hasTimelineDeliveryIdentity({snapshot: {exportRange: undefined}}), true);
    for (const exportRange of badRanges) assert.throws(() => timelineRenderDeliveryFields({exportRange}), {code: 'INVALID_TIMELINE_SNAPSHOT'});
  } finally { db.close(); }
});

test('local delivery version1 keeps exact ranged input identity and property order without expanding title drafts', () => {
  const local = createLocalDeliverySchemas(value => schemas['timeline.render'].safeParse(value).success);
  const f = fixture({exportRange: selection()}), input = {exportRange: {endFrame: 19, startFrame: 7},
    requestId: f.input.requestId, purpose: 'export', expectedRevision: 4, projectId: f.input.projectId};
  const intentId = randomUUID(), workspaceScope = 'a'.repeat(64), instanceId = randomUUID();
  const prepare = {workspaceScope, instanceId, projectId: input.projectId, expectedIntentRevision: 0,
    expectedIntentId: null, intentId, timelineId: f.timeline.id, baseRevision: 4, draft: null, input};
  const bytes = JSON.stringify(input), parsed = local.prepare.parse(prepare);
  assert.equal(parsed.input, input); assert.equal(JSON.stringify(parsed.input), bytes);
  const intent = {intentId, timelineId: f.timeline.id, baseRevision: 4, draft: null, input, createdAt: stamp, outcome: {status: 'pending'}};
  const slot = {projectId: input.projectId, draftRevision: 0, draft: null, intentRevision: 1, intent};
  const disk = {version: 1, workspaceScope, entries: [slot]};
  assert.equal(JSON.stringify((local.disk.parse(disk).entries[0].intent)!.input), bytes);
  assert.equal(local.disk.parse(disk).version, 1);
  for (const exportRange of badRanges) assert.equal(local.prepare.safeParse({...prepare, input: {...input, exportRange}}).success, false);
  for (const key of ['deliveryName', 'exportSettings', 'preflightSnapshotHash']) assert.equal(Object.hasOwn(parsed.input, key), false);
  const legacy = {...input}; delete (legacy as {exportRange?: unknown}).exportRange;
  assert.equal(JSON.stringify(local.prepare.parse({...prepare, input: legacy}).input), JSON.stringify(legacy));
  assert.equal(local.prepare.safeParse({...prepare, draft: {draftId: randomUUID(), revision: 1,
    raw: {deliveryName: '', exportRange: selection()}}}).success, false);
});

test('only strict fresh range-bounds or capability rejection proofs release the exact export key', () => {
  const f = fixture({exportRange: selection()}), error = {code: 'EXPORT_RANGE_BOUNDS', status: 409,
    details: {mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: f.input.projectId, requestId: f.input.requestId}};
  assert.ok(hasRequestNotAppliedProof(error, f.input, {operation: 'timeline.render'}));
  assert.ok(hasRequestNotAppliedProof({...error, status: undefined, definitive: true}, f.input, {operation: 'timeline.render'}));
  for (const patch of [{operation: undefined}, {operation: 'timeline.clip.add'}, {projectId: randomUUID()},
    {projectId: undefined}, {requestId: randomUUID()}, {mutationOutcome: 'unknown'}]) {
    assert.equal(hasRequestNotAppliedProof({...error, details: {...error.details, ...patch}}, f.input, {operation: 'timeline.render'}), false);
  }
  for (const status of [undefined, 200, 401, 403, 500, 409.5]) {
    assert.equal(hasRequestNotAppliedProof({...error, status}, f.input, {operation: 'timeline.render'}), false);
  }
  const omitted = {...f.input}; delete omitted.exportRange;
  for (const input of [omitted, {...f.input, purpose: 'preview'}, {...f.input, exportRange: undefined},
    {...f.input, extra: true}, {...f.input, exportSettings: {}}, {...f.input, deliveryName: ''},
    {...f.input, preflightSnapshotHash: 'bad'}, {...f.input, expectedRevision: 0}]) {
    assert.equal(hasRequestNotAppliedProof(error, input, {operation: 'timeline.render'}), false);
  }
  assert.equal(hasRequestNotAppliedProof(error, f.input), false);
  const revisionConflict = {...error, code: 'REVISION_CONFLICT'};
  assert.ok(hasRequestNotAppliedProof(revisionConflict, f.input, {operation: 'timeline.render'}));
  for (const key of ['operation', 'projectId', 'requestId']) {
    const missing = clone(revisionConflict); delete ((missing)!.details as Record<string, unknown>)[key];
    assert.equal(hasRequestNotAppliedProof(missing, f.input, {operation: 'timeline.render'}), false);
    const incorrect = clone(revisionConflict); ((incorrect)!.details as Record<string, unknown>)[key] = randomUUID();
    assert.equal(hasRequestNotAppliedProof(incorrect, f.input, {operation: 'timeline.render'}), false);
  }
  const legacyProof = {...revisionConflict, details: {mutationOutcome: 'not_applied', requestId: f.input.requestId}};
  assert.ok(hasRequestNotAppliedProof(legacyProof, omitted, {operation: 'timeline.render'}), 'old omitted-range proof details remain compatible');
  assert.equal(hasRequestNotAppliedProof(legacyProof, f.input, {operation: 'timeline.render'}), false);
  for (const input of [{...f.input, exportRange: undefined}, {...f.input, purpose: 'preview'},
    {...f.input, extra: true}, {...f.input, exportSettings: {}}, {...f.input, deliveryName: ''}]) {
    assert.equal(hasRequestNotAppliedProof(revisionConflict, input, {operation: 'timeline.render'}), false);
  }
  assert.equal(hasRequestNotAppliedProof(revisionConflict, f.input, {operation: 'timeline.clip.update'}), false);
  const withSettings = {...f.input, exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS};
  const capability = {...error, code: 'EXPORT_CAPABILITY_UNSUPPORTED'};
  assert.ok(hasRequestNotAppliedProof(capability, withSettings, {operation: 'timeline.render'}));
  assert.equal(hasRequestNotAppliedProof(capability, {...withSettings, exportRange: undefined}, {operation: 'timeline.render'}), false);
});

test('global discovery stays exhaustive and range belongs only to the two existing operations', () => {
  const catalog = discoverSchema({}) as Extract<ReturnType<typeof discoverSchema>,{operations: unknown}>;
  assert.deepEqual(catalog.operations.map(row => row.operation).sort(), Object.keys(schemas).sort());
  for (const row of catalog.operations) {
    const audited = assertOperationInputBranches(row);
    for (const branch of audited.branches) {
      const acceptsRange = ['timeline.render', 'timeline.export.preflight'].includes(row.operation);
      assert.equal(Object.hasOwn(branch.properties, 'exportRange'), acceptsRange, row.operation);
      assert.equal(branch.required.includes('exportRange'), false, row.operation);
      if (acceptsRange) {
        assert.equal((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}).additionalProperties, false);
        assert.deepEqual((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}).required, ['startFrame', 'endFrame']);
        assert.equal(Object.hasOwn((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}), 'default'), false);
        assert.deepEqual(Object.keys((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}).properties), ['startFrame', 'endFrame']);
        assert.match((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}).properties.startFrame.description, /Included start frame.*30fps/);
        assert.match((branch.properties.exportRange as {additionalProperties: boolean; required: string[]; properties: {startFrame: {description: string}; endFrame: {description: string}}}).properties.endFrame.description, /Excluded end frame.*30fps.*current saved timeline duration/);
      }
    }
  }
  assert.equal(DURABLE_EDIT_OPERATIONS.includes('timeline.render'), false);
  assert.equal(Object.keys(schemas).some(name => name.includes('exportRange')), false);
  const f = fixture();
  assert.throws(() => parse('timeline.export.capabilities', {projectId: f.input.projectId, expectedRevision: 4,
    exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS, exportRange: selection()}), {code: 'VALIDATION_ERROR'});
  assert.throws(() => parse('export.create', {projectId: f.input.projectId, requestId: f.input.requestId,
    exportRange: selection()}), {code: 'VALIDATION_ERROR'});
});

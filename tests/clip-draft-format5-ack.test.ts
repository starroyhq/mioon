import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditUiWireFixture, WIRE_IDS} from './helpers/edit-ui-wire-fixture.ts';
import {createClipDraftController, clipDraftRaw} from '../apps/web/src/clip-draft-state.ts';
import {clipGainDbText} from '../apps/web/src/clip-audio-state.ts';
import {isTimelineRecord} from '@mioon/contracts';
import {isFormat5Timeline} from '@mioon/contracts/project-format5';

test('format-5 clip draft acknowledgement validates the board projection instead of rejecting its real clip fields', async t => {
  const fixture = await createEditUiWireFixture();
  t.after(() => fixture.store.close());
  const timeline = fixture.store.get('timelines', WIRE_IDS.timeline) as Record<string, unknown>;
  assert.equal(isTimelineRecord(timeline, {projectId: WIRE_IDS.project, format: 5}), false, 'legacy validator rejects format-5 sourceState/sequenceSource/mainTrack');
  assert.equal(isFormat5Timeline(timeline, {projectId: WIRE_IDS.project}), true);
  assert.equal(isFormat5Timeline(timeline, {projectId: WIRE_IDS.project}), true);
  const legacy = {id: WIRE_IDS.timeline, projectId: WIRE_IDS.project, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 30, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    tracks: [{id: '90000000-0000-4000-8000-000000000060', name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: '90000000-0000-4000-8000-000000000030', trackId: '90000000-0000-4000-8000-000000000060',
      assetId: WIRE_IDS.assetA, name: 'Legacy clip', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}]};
  assert.equal(isTimelineRecord(legacy, {projectId: WIRE_IDS.project}), true);
  assert.equal(isTimelineRecord(legacy, {projectId: WIRE_IDS.project}), true, 'format 4 keeps the legacy validator');
});

test('an exact matched gain survives draft, request, saved projection and confirmation without rounding', async t => {
  const fixture = await createEditUiWireFixture();
  t.after(() => fixture.store.close());
  const timeline = fixture.store.get('timelines', WIRE_IDS.timeline) as Record<string, unknown>;
  const clips = timeline.clips as Record<string, unknown>[];
  const clip = clips.find(item => item.id === WIRE_IDS.clipA)!;
  const saved = clipDraftRaw(clip);
  const key = {projectId: WIRE_IDS.project, timelineId: WIRE_IDS.timeline, clipId: WIRE_IDS.clipA};
  const record = {supported: true as const, workspaceScope: 'a'.repeat(64), instanceId: 'ca000000-0000-4000-8000-000000000099', key, revision: 0, targetStatus: 'matching' as const, draft: null};
  const controller = createClipDraftController({
    context: {...key, scope: 'clip', connected: true, visible: true, busy: false, timelineRevision: Number(timeline.revision),
      source: {assetId: WIRE_IDS.assetA, assetSha256: 'a'.repeat(64), versionId: WIRE_IDS.versionA, shotId: WIRE_IDS.shotA}, saved}, delay: 100000,
    validateTimeline: value => value !== null && isFormat5Timeline(value, {projectId: WIRE_IDS.project}),
    client: {async get() { return record; }, async put(input: any) { return {...record, revision: input.expectedRevision + 1, draft: {baseRevision: input.baseRevision, source: input.source, raw: input.raw, updatedAt: '2026-01-01T00:00:00.000Z'}}; }, async remove(input: any) { return {...record, revision: input.expectedRevision + 1, draft: null}; }} as never,
  });
  t.after(() => controller.dispose());
  await controller.load();
  const exact = 0.6937987750363404;
  assert.equal(controller.edit('gain', String(exact)), true);
  assert.equal(controller.getState().raw.gain, String(exact));
  assert.equal(clipGainDbText(exact), '-3.18', 'display rounding is presentation only');
  let requestGain: unknown;
  const result = await controller.save(async (_clipId, patch) => {
    requestGain = patch.gain;
    return {...timeline, revision: Number(timeline.revision) + 1,
      clips: clips.map(item => item.id === WIRE_IDS.clipA ? {...item, gain: exact} : item)};
  });
  assert.equal(requestGain, exact);
  assert.ok(result);
  assert.equal(controller.getState().dirty, false);
  assert.equal(controller.getState().conflict, false);
  assert.equal(controller.getState().raw.gain, exact);
});

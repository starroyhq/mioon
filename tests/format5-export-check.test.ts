import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';

/** WT-1-05: a saved Format-5 timeline whose native rows are not a legacy
 * TimelineRecord must still reach the export capability/preflight boundary.
 * The old boundary read the native clip rows through the Format-3/4 recovery
 * validator, so `mainTrack`/`sequenceSource` made every clean project report
 * INVALID_TIMELINE_SNAPSHOT before any export could start. */
test('format-5 capability check accepts a saved timeline and blocks placeholders by code', async () => {
  const f = await createBoardUiWireFixture();
  const projectId = f.projectId;
  const settings = {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}};
  const before: any = await f.services.call('timeline.export.capabilities',
    {projectId, expectedRevision: 1, exportSettings: settings});
  assert.equal(before.status, 'blocked');
  assert.equal(before.issues[0]?.code, 'PLACEHOLDER_CLIP', 'a placeholder is still a product blocker');

  // Put the shot's selected version on the main track through the real
  // sequence write path; no native rows are patched by the test.
  const preview: any = await f.services.call('sequence.preview', {projectId, requestId: `export-check-${randomUUID()}`,
    intents: [{side: 'board', operation: {kind: 'board-version', nodeId: BOARD_IDS.shotB,
      version: {id: BOARD_IDS.versionB, sourceFrames: 120}}}]});
  await f.services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const current = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const available: any = await f.services.call('timeline.export.capabilities',
    {projectId, expectedRevision: current.revision, exportSettings: settings});
  assert.equal(available.status, 'available', JSON.stringify(available));
  assert.equal(available.timelineId, current.id);
  assert.equal(available.issues.length, 0);

  const preflight: any = await f.services.call('timeline.export.preflight',
    {projectId, expectedRevision: current.revision, exportSettings: settings});
  assert.equal(preflight.timelineId, current.id);
  assert.notEqual(preflight.issues[0]?.code, 'INVALID_TIMELINE_SNAPSHOT',
    'the Format-5 native rows are no longer fed to the Format-3/4 validator');
  f.store.close();
  f.library.close();
});

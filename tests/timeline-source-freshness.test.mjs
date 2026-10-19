import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staleClipSources, staleSourceSentence } from '../apps/web/src/timeline-source-freshness.ts';
import { clipSelectedVersionCandidate } from '../apps/web/src/clip-source-replacement.js';

const clip = (id, shotId, versionId) => ({ id, shotId, versionId });
const seeded = (id, assetId) => ({ id, assetId });
const shots = [{ id: 's1', title: '01 · 建立场景', selectedVersionId: 'v2' }, { id: 's2', title: '02 · 展开故事', selectedVersionId: 'w1' }, { id: 's3', title: '03', selectedVersionId: null }];
const versions = [{ id: 'v1', assetId: 'A1', shotId: 's1', number: 1 }, { id: 'v2', assetId: 'A2', shotId: 's1', number: 2 }, { id: 'w1', assetId: 'B1', shotId: 's2', number: 1 }];

test('only clips frozen on a version their shot no longer selects are reported', () => {
  const stale = staleClipSources([clip('a', 's1', 'v1'), clip('b', 's1', 'v2'), clip('c', 's2', 'w1'), clip('d', 's3', 'x'), { id: 'e' }, clip('f', 'gone', 'v1')], shots, versions);
  assert.deepEqual([...stale.keys()], ['a']);
  assert.deepEqual(stale.get('a'), { clipId: 'a', shotId: 's1', shotTitle: '01 · 建立场景', versionId: 'v1', versionNumber: 1, selectedVersionId: 'v2', selectedVersionNumber: 2 });
  assert.equal(staleSourceSentence(stale.get('a')), '镜头「01 · 建立场景」已改选 V2，此片段仍是 V1');
  // Seeded and library clips carry only the asset; the version is found through it.
  const bySeed = staleClipSources([seeded('p', 'A1'), seeded('q', 'A2'), seeded('r', 'B1'), seeded('s', 'unrelated'), { id: 't' }], shots, versions);
  assert.deepEqual([...bySeed.keys()], ['p']); assert.equal(bySeed.get('p').versionNumber, 1); assert.equal(bySeed.get('p').selectedVersionNumber, 2);
  assert.equal(staleClipSources([], shots, versions).size, 0); assert.equal(staleClipSources([clip('a', 's1', 'v1')], [], versions).size, 0);
});

function context(over = {}) {
  const asset = (id, duration = 2) => ({ id, projectId: 'p', mimeType: 'video/mp4', duration, hasAudio: false, hasVideo: true });
  return { scope: 'p:1', projectId: 'p', clipId: 'a', connected: true,
    timeline: { id: 't', projectId: 'p', revision: 3, clips: [{ id: 'a', assetId: 'A1', sourceInFrame: 0, durationFrames: 45, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 }] },
    assets: [asset('A1'), asset('A2')], shots: shots.map(shot => ({ ...shot, projectId: 'p' })), versions: [{ id: 'v1', projectId: 'p', assetId: 'A1', shotId: 's1', number: 1 }, { id: 'v2', projectId: 'p', assetId: 'A2', shotId: 's1', number: 2 }],
    ...over };
}

test('the selected version is offered as a candidate only when it can replace the clip source', () => {
  const ok = clipSelectedVersionCandidate(context());
  assert.equal(ok?.key, 'version:v2'); assert.equal(ok.version.number, 2);
  // Already on the selected version, or no provenance: nothing to offer.
  assert.equal(clipSelectedVersionCandidate(context({ shots: [{ ...shots[0], projectId: 'p', selectedVersionId: 'v1' }] })), null);
  const unknownAsset = context(); unknownAsset.timeline.clips[0].assetId = 'A3'; unknownAsset.assets.push({ ...unknownAsset.assets[0], id: 'A3' }); assert.equal(clipSelectedVersionCandidate(unknownAsset), null);
  // A selected version that is too short for the clip's range stays unavailable instead of being trimmed.
  assert.equal(clipSelectedVersionCandidate(context({ assets: [{ ...context().assets[0] }, { ...context().assets[1], duration: 1 }] })), null);
});

test('the timeline marks stale clips and the inspector offers the pre-filled review', () => {
  const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
  assert.match(read('Timeline.jsx'), /\$\{stale \? 'source-stale' : ''\}[\s\S]*?clip-stale-mark/);
  assert.match(read('TimelineInspector.jsx'), /data-testid="clip-source-stale-note"/);
  assert.match(read('ClipSourceReplacement.jsx'), /data-testid="review-selected-version-replacement"[^>]*onClick=\{\(\) => \{ if \(controller\.begin\(\) && controller\.choose\(suggested\.key\)\) controller\.review\(\); \}\}/);
  assert.match(read('App.jsx'), /staleClipSources\(timeline\?\.clips \?\? \[\], data\.shots, data\.versions\)/);
});

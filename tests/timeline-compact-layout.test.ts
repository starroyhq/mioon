import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPACT_TRACK_PX, compactTimelineScrollTop, compactTimelineViewportHeight} from '../apps/web/src/timeline-compact-layout.ts';
import {TIMELINE_RULER_PX} from '../apps/web/src/timeline-view-geometry.ts';

test('minimum timeline height exposes only whole lanes without losing the horizontal scrollbar', () => {
  for (const scrollbar of [0, 11, 15]) {
    for (let available = 80; available <= 150; available++) {
      const height = compactTimelineViewportHeight(available, scrollbar);
      assert.ok(height <= available);
      assert.equal((height - scrollbar - TIMELINE_RULER_PX) % COMPACT_TRACK_PX, 0);
      assert.ok(available - height < COMPACT_TRACK_PX);
    }
  }
  assert.equal(compactTimelineViewportHeight(105), 80, 'Two complete lanes fit below the ruler');
  assert.equal(compactTimelineViewportHeight(105, 15), 95, 'The native scrollbar has its own space');
});

test('settled compact scroll offsets align rows and the last track remains reachable', () => {
  for (const raw of [0, 1, 13, 14, 27, 40, 55, 56, 101]) {
    const aligned = compactTimelineScrollTop(raw);
    assert.equal(aligned % COMPACT_TRACK_PX, 0);
    assert.ok(Math.abs(aligned - raw) <= COMPACT_TRACK_PX / 2);
  }
  const totalTracks = 5, visibleTracks = 2;
  const maximumScrollTop = totalTracks * COMPACT_TRACK_PX + TIMELINE_RULER_PX - compactTimelineViewportHeight(105);
  assert.equal(compactTimelineScrollTop(maximumScrollTop), (totalTracks - visibleTracks) * COMPACT_TRACK_PX);
  assert.equal(compactTimelineScrollTop(-50), 0);
  assert.equal(compactTimelineScrollTop(NaN), 0);
  assert.equal(compactTimelineViewportHeight(NaN), 0);
});

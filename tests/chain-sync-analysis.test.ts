import assert from 'node:assert/strict';
import test from 'node:test';
import { compareChainSync, planTrackAnchors } from '../packages/contracts/src/chain-sync-analysis.ts';
import type {
  AnchorTrackSegment,
  ChainSyncBaseline,
  ChainSyncBoardEntry,
  TrackAnchoredItem,
} from '../packages/contracts/src/chain-sync-analysis.ts';

const clip = (id: string, startFrame: number, durationFrames = 10): AnchorTrackSegment =>
  Object.freeze({ id, startFrame, durationFrames });
const item = (id: string, startFrame: number, anchorClipId?: string | null): TrackAnchoredItem =>
  Object.freeze({ id, startFrame, ...(anchorClipId !== undefined ? { anchorClipId } : {}) });
const entry = (nodeId: string, versionId: string | null = 'v1'): ChainSyncBoardEntry =>
  Object.freeze({ nodeId, versionId });
const baseline = (entries: readonly ChainSyncBoardEntry[]): ChainSyncBaseline => ({ board: entries, track: entries });

test('anchors have no effects in an empty timeline and explicit detachment never reattaches', () => {
  assert.deepEqual(planTrackAnchors([], [], []), []);
  const saved = [item('Detached', 1, null), item('Pending', 2)];
  assert.deepEqual(planTrackAnchors([], [clip('first', 0)], saved), saved);
  assert.deepEqual(planTrackAnchors([clip('first', 0)], [clip('first', 10)], [saved[0]!]), [saved[0]]);
});

test('anchors follow clip identity and offsets through reorder, insertion and trimming', () => {
  const before = Object.freeze([clip('a', 0), clip('b', 10), clip('c', 20)]);
  const after = Object.freeze([clip('b', 0, 7), clip('added', 7, 3), clip('a', 10, 12), clip('c', 22)]);
  const saved = Object.freeze([
    item('subtitle', 3), item('overlay', 10), item('music', 19, 'b'),
    item('effect', 24), item('Detached', 1, null), item('tail', 30),
  ]);
  const original = JSON.stringify({ before, after, saved });
  const expected = [
    item('Detached', 1, null), item('effect', 26, 'c'), item('music', 9, 'b'),
    item('overlay', 0, 'b'), item('subtitle', 13, 'a'), item('tail', 30),
  ];
  assert.deepEqual(planTrackAnchors(before, after, saved), expected);
  assert.deepEqual(planTrackAnchors(before.toReversed(), after.toReversed(), saved.toReversed()), expected);
  assert.equal(JSON.stringify({ before, after, saved }), original);
});

test('deleting an anchor leaves its contents at the old frame and marks them detached', () => {
  const before = [clip('a', 0), clip('b', 10), clip('c', 20)];
  const after = [clip('a', 0), clip('c', 10)];
  const planned = planTrackAnchors(before, after, [item('lost', 15, 'b'), item('follow', 22), item('stale', 7, 'missing')]);
  assert.deepEqual(planned, [item('follow', 12, 'c'), item('lost', 15, null), item('stale', 7, null)]);
  assert.deepEqual(planTrackAnchors(after, [clip('c', 0), clip('a', 10)], planned),
    [item('follow', 2, 'c'), item('lost', 15, null), item('stale', 7, null)]);
});

test('splitting gives boundary and later anchors to the right part, with its own offset', () => {
  const before = [clip('whole', 0, 20)];
  const after = [clip('right', 0), clip('whole', 10)];
  const splits = [Object.freeze({ clipId: 'whole', rightClipId: 'right', atFrame: 10 })];
  const saved = [item('BeforeCut', 9), item('AtCut', 10, 'whole'), item('AfterCut', 14, 'whole')];
  assert.deepEqual(planTrackAnchors(before, after, saved, splits), [
    item('AfterCut', 4, 'right'), item('AtCut', 0, 'right'), item('BeforeCut', 19, 'whole'),
  ]);
  assert.deepEqual(planTrackAnchors(before, after.slice(1), saved, splits), [
    item('AfterCut', 14, null), item('AtCut', 10, null), item('BeforeCut', 19, 'whole'),
  ]);
});

test('the comparison is empty for agreement, including legal splits and version locks', () => {
  assert.deepEqual(compareChainSync(baseline([]), [], []), []);
  const previous = [entry('a'), entry('b', null)];
  const board = [entry('b', null), entry('a', 'v2')];
  const track = [entry('b', null), { ...entry('a'), locked: true }, entry('a', 'v2')];
  assert.deepEqual(compareChainSync(baseline(previous), board, track), []);
  assert.deepEqual(compareChainSync(baseline(previous), board, [entry('b', null), entry('a', 'v2'), entry('a')]),
    [{ nodeId: 'a', change: 'both' }]);
});

test('each current mismatch is attributed against its own side of the baseline', () => {
  const previousBoard = [entry('A'), entry('b'), entry('c'), entry('é')];
  const previousTrack = [entry('A', 'v0'), entry('b'), entry('c'), entry('é')];
  const board = [entry('A'), entry('b', 'v2'), entry('c'), entry('é', 'v3')];
  const track = [entry('A', 'v0'), entry('b'), entry('c', 'v2'), entry('é', 'v2')];
  assert.deepEqual(compareChainSync({ board: previousBoard, track: previousTrack }, board, track), [
    { nodeId: 'A', change: 'unchanged' },
    { nodeId: 'b', change: 'board_only' },
    { nodeId: 'c', change: 'track_only' },
    { nodeId: 'é', change: 'both' },
  ]);
});

test('membership differences do not make unchanged neighbors look reordered', () => {
  const previous = [entry('a'), entry('b'), entry('c')];
  const board = [entry('b'), entry('x'), entry('c')];
  assert.deepEqual(compareChainSync(baseline(previous), board, previous), [
    { nodeId: 'a', change: 'board_only' }, { nodeId: 'x', change: 'board_only' },
  ]);
  assert.deepEqual(compareChainSync(baseline(previous), previous, board), [
    { nodeId: 'a', change: 'track_only' }, { nodeId: 'x', change: 'track_only' },
  ]);
});

test('relative reorder identifies every crossed node and flags non-adjacent duplicates', () => {
  const previous = [entry('a'), entry('b'), entry('c'), entry('d')];
  const reversedPrefix = [entry('c'), entry('b'), entry('a'), entry('d')];
  assert.deepEqual(compareChainSync(baseline(previous), reversedPrefix, previous),
    ['a', 'b', 'c'].map(nodeId => ({ nodeId, change: 'board_only' })));
  const splitApart = [entry('a'), entry('b'), entry('a'), entry('c'), entry('d')];
  assert.deepEqual(compareChainSync(baseline(previous), previous, splitApart), [{ nodeId: 'a', change: 'track_only' }]);
});

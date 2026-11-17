import assert from 'node:assert/strict';
import test from 'node:test';
import {isDeepStrictEqual} from 'node:util';
import {classifyChainConnection, deriveFilmChains, planBoardSequenceEdit} from '../packages/contracts/src/board-sequence.ts';
import type {ChainNode, SequenceEdge} from '../packages/contracts/src/board-sequence.ts';
import {compareChainSync, planTrackAnchors} from '../packages/contracts/src/chain-sync-analysis.ts';
import {planChainMainTrack, planChainSync} from '../packages/contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncState} from '../packages/contracts/src/chain-sync-algorithm.ts';

type Operation = Parameters<typeof planChainSync>[1];
type Success = Extract<ReturnType<typeof planChainSync>, {ok: true}>;
type Change<T> = Readonly<{before: T | null; after: T | null}>;
const film = 'film';
const duration = 40;
const shot = (index: number): string => `shot-${String(index).padStart(3, '0')}`;
const clip = (index: number): string => `clip-${String(index).padStart(3, '0')}`;
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const byId = <T extends {id: string}>(a: T, b: T): number => compareId(a.id, b.id);
const edge = (fromId: string, toId: string): SequenceEdge => ({fromId, toId});
const selected = {id: 'v1', sourceFrames: 100};
const mainClip = (id: string, nodeId: string, startFrame: number): ChainSyncClip => ({
  id, nodeId, versionId: selected.id, versionLocked: false, startFrame, durationFrames: duration, sourceInFrame: 5,
});
const media = (nodeId: string): ChainSyncMedia => ({nodeId, selectedVersion: selected, durationFrames: duration});
const graphEdges = (ids: readonly string[], root: string = film): SequenceEdge[] =>
  ids.map((id, index) => edge(index === 0 ? root : ids[index - 1]!, id));

function fixture(count: number, anchorOffsets: readonly number[] = [3, 22]): ChainSyncState {
  const shotIds = Array.from({length: count}, (_, index) => shot(index));
  const nodes: ChainNode[] = [{id: film, kind: 'film'}, ...shotIds.map(id => ({id, kind: 'shot' as const})), {id: 'loose', kind: 'shot'}];
  return {
    board: {nodes, edges: graphEdges(shotIds)},
    filmId: film,
    media: [...shotIds.map(media), {nodeId: 'loose', selectedVersion: null, durationFrames: duration}],
    clips: shotIds.map((nodeId, index) => mainClip(clip(index), nodeId, index * duration)),
    anchored: shotIds.flatMap((_nodeId, index) => anchorOffsets.map((offset, part) => ({
      id: `overlay-${index}-${part}`, startFrame: index * duration + offset, anchorClipId: clip(index),
    }))),
  };
}

function reverseInput(state: ChainSyncState): ChainSyncState {
  return {
    ...state,
    board: {nodes: [...state.board.nodes].reverse(), edges: [...state.board.edges].reverse()},
    media: [...state.media].reverse(),
    clips: [...state.clips].reverse(),
    anchored: [...state.anchored].reverse(),
  };
}

function applyChanges<T>(rows: readonly T[], changes: readonly Change<T>[], key: (row: T) => string): T[] {
  const byKey = new Map(rows.map(row => [key(row), row]));
  for (const {before, after} of changes) {
    assert.ok(before !== null || after !== null, 'each change names a row');
    if (before === null) assert.equal(byKey.has(key(after!)), false, 'an insertion names a fresh row');
    else {
      assert.deepEqual(byKey.get(key(before)), before, 'the before value matches storage');
      byKey.delete(key(before));
    }
    if (after !== null) byKey.set(key(after), after);
  }
  return [...byKey.values()];
}

function patchBoardRows<T>(rows: readonly T[], changes: readonly Change<T>[], undo: boolean): T[] {
  const patched = [...rows];
  for (const change of changes) {
    const [before, after] = undo ? [change.after, change.before] : [change.before, change.after];
    if (before !== null) {
      const at = patched.findIndex(row => isDeepStrictEqual(row, before));
      assert.ok(at >= 0, 'each occurrence needs a matching earlier board row');
      patched.splice(at, 1);
    }
    if (after !== null) patched.push(after);
  }
  return patched;
}

function patchState(state: ChainSyncState, changes: Success['changes'], undo: boolean): ChainSyncState {
  const update = <T>(rows: readonly T[], delta: readonly Change<T>[], key: (row: T) => string): T[] =>
    applyChanges(rows, undo ? delta.map(({before, after}) => ({before: after, after: before})) : delta, key);
  return {
    board: {
      nodes: patchBoardRows(state.board.nodes, changes.nodes, undo),
      edges: patchBoardRows(state.board.edges, changes.edges, undo),
    },
    filmId: state.filmId,
    media: patchBoardRows(state.media, changes.media, undo),
    clips: update(state.clips, changes.clips, row => row.id),
    anchored: update(state.anchored, changes.anchored, row => row.id),
  };
}

function orderedLike(state: ChainSyncState, reference: ChainSyncState): ChainSyncState {
  const order = <T>(rows: readonly T[], wanted: readonly T[], key: (row: T) => string): T[] => {
    assert.equal(rows.length, wanted.length);
    const byKey = new Map(rows.map(row => [key(row), row]));
    return wanted.map(row => {
      const current = byKey.get(key(row));
      assert.ok(current, 'undo reconstructs every original key');
      return current;
    });
  };
  const boardOrder = <T>(rows: readonly T[], wanted: readonly T[]): T[] => {
    assert.equal(rows.length, wanted.length);
    const remaining = [...rows];
    return wanted.map(row => {
      const at = remaining.findIndex(candidate => isDeepStrictEqual(candidate, row));
      assert.ok(at >= 0, 'undo reconstructs each original board row, including duplicates');
      return remaining.splice(at, 1)[0]!;
    });
  };
  return {
    board: {
      nodes: boardOrder(state.board.nodes, reference.board.nodes),
      edges: boardOrder(state.board.edges, reference.board.edges),
    },
    filmId: state.filmId,
    media: boardOrder(state.media, reference.media),
    clips: order(state.clips, reference.clips, row => row.id),
    anchored: order(state.anchored, reference.anchored, row => row.id),
  };
}

function planAndRoundTrip(state: ChainSyncState, operation: Operation): Success {
  const original = JSON.stringify(state);
  const result = planChainSync(state, operation);
  assert.ok(result.ok, result.ok ? undefined : result.code);
  assert.deepEqual(planChainSync(reverseInput(state), operation), result, 'input enumeration does not affect a plan');
  const applied = patchState(state, result.changes, false);
  assert.deepEqual(orderedLike(applied, result.after), result.after, 'the plan patch accounts for both sides');
  const undone = patchState(applied, result.changes, true);
  // Storage retains the original row ordering along with its one-step undo record.
  assert.equal(JSON.stringify(orderedLike(undone, state)), original, 'discarding the operation restores the exact bytes');
  assert.equal(JSON.stringify(state), original, 'planning leaves the source state untouched');
  let nextFrame = 0;
  for (const part of [...applied.clips].sort((a, b) => a.startFrame - b.startFrame || byId(a, b))) {
    assert.equal(part.startFrame, nextFrame, 'main track starts at zero and packs all following parts');
    nextFrame += part.durationFrames;
  }
  return result;
}

function members(state: ChainSyncState, filmId: string = state.filmId): readonly string[] | undefined {
  const graph = deriveFilmChains(state.board);
  assert.deepEqual(graph.issues, []);
  return graph.chains.find(chain => chain.filmId === filmId)?.nodeIds;
}

test('a film without clips is a no-op, and the first clip can join its chain', () => {
  const state = fixture(0);
  const noChange = planAndRoundTrip(state, {kind: 'sync-board'});
  assert.deepEqual(members(noChange.after), []);
  assert.ok(Object.values(noChange.changes).every(changes => changes.length === 0));
  const result = planAndRoundTrip(state, {
    kind: 'board', edit: {kind: 'connect', fromId: film, toId: 'loose'},
    newClipIds: {loose: 'first'},
  });
  assert.deepEqual(members(result.after), ['loose']);
  assert.deepEqual(result.after.clips.map(row => [row.id, row.startFrame, row.durationFrames]), [['first', 0, duration]]);
});

test('board insertion before the first clip packs a placeholder and moves the overlays once', () => {
  const state = fixture(3);
  const result = planAndRoundTrip(state, {
    kind: 'board',
    edit: {kind: 'insert', nodeId: 'loose', fromId: film, toId: shot(0)},
    newClipIds: {loose: 'placeholder'},
  });
  assert.deepEqual(members(result.after), ['loose', shot(0), shot(1), shot(2)]);
  const placeholder = result.after.clips[0]!;
  assert.deepEqual([placeholder.id, placeholder.nodeId, placeholder.versionId, placeholder.startFrame, placeholder.durationFrames], ['placeholder', 'loose', null, 0, duration]);
  assert.equal(result.after.anchored.find(item => item.id === 'overlay-0-0')?.startFrame, duration + 3);
});

test('inserting a linked node on another edge in its own sequence reorders existing clips', () => {
  const state = fixture(4);
  const result = planAndRoundTrip(state, {kind: 'board', edit: {
    kind: 'insert', nodeId: shot(3), fromId: shot(0), toId: shot(1),
  }});
  assert.deepEqual(members(result.after), [shot(0), shot(3), shot(1), shot(2)]);
  assert.deepEqual(result.after.clips.map(row => row.id), [clip(0), clip(3), clip(1), clip(2)]);
  assert.deepEqual(result.after.clips[1], {...state.clips[3], startFrame: duration});
  assert.equal(result.after.anchored.find(item => item.id === 'overlay-3-0')?.startFrame, duration + 3);
  assert.deepEqual(result.changes.nodes, []);
  assert.deepEqual(result.changes.media, []);

  const otherFilm: ChainNode = {id: 'other-film', kind: 'film'};
  const otherShot: ChainNode = {id: 'other-shot', kind: 'shot'};
  const otherSequence = {...state, board: {
    nodes: [...state.board.nodes, otherFilm, otherShot],
    edges: [...state.board.edges, edge(otherFilm.id, otherShot.id)],
  }};
  const refused = planChainSync(otherSequence, {kind: 'board', edit: {
    kind: 'insert', nodeId: otherShot.id, fromId: shot(0), toId: shot(1),
  }});
  assert.ok(!refused.ok);
  assert.equal(refused.code, 'NODE_ALREADY_LINKED');
});

test('board deletion reattaches the surviving chain and detaches deleted-clip overlays in place', () => {
  const state = fixture(4);
  for (const index of [0, 1, 3]) {
    const result = planAndRoundTrip(state, {kind: 'board', edit: {kind: 'delete', nodeId: shot(index)}});
    assert.deepEqual(members(result.after), [0, 1, 2, 3].filter(value => value !== index).map(shot));
    assert.equal(result.after.board.nodes.some(node => node.id === shot(index)), false);
    assert.deepEqual(result.after.anchored.find(item => item.id === `overlay-${index}-0`), {
      id: `overlay-${index}-0`, startFrame: index * duration + 3, anchorClipId: null,
    });
  }
});

test('disconnect and reconnect leave unrelated films and detached sequences intact', () => {
  const state = fixture(3);
  const otherFilm = 'other-film';
  const original: ChainSyncState = {...state, board: {
    nodes: [...state.board.nodes, {id: otherFilm, kind: 'film'}, {id: 'other-shot', kind: 'shot'},
      {id: 'detached-1', kind: 'image'}, {id: 'detached-2', kind: 'video'}],
    edges: [...state.board.edges, edge(otherFilm, 'other-shot'), edge('detached-1', 'detached-2')],
  }, media: [...state.media, media('other-shot')]};
  const wrongFilm = {ok: false, code: 'FILM_SCOPE_MISMATCH', id: otherFilm};
  assert.deepEqual(planChainSync(original, {kind: 'board', edit: {
    kind: 'disconnect', fromId: otherFilm, toId: 'other-shot',
  }}), wrongFilm);
  assert.deepEqual(planChainSync(original, {kind: 'board-version', nodeId: 'other-shot', version: {id: 'v2', sourceFrames: 90}}), wrongFilm);
  const disconnected = planAndRoundTrip(original, {kind: 'board', edit: {kind: 'disconnect', fromId: shot(0), toId: shot(1)}}).after;
  assert.deepEqual(members(disconnected), [shot(0)]);
  assert.deepEqual(members(disconnected, otherFilm), ['other-shot']);
  assert.deepEqual(deriveFilmChains(disconnected.board).detachedNodeIds,
    ['detached-1', 'detached-2', 'loose', shot(1), shot(2)].sort(compareId));
  const reconnected = planAndRoundTrip(disconnected, {
    kind: 'board', edit: {kind: 'connect', fromId: shot(0), toId: shot(1)},
    newClipIds: {[shot(1)]: clip(1), [shot(2)]: clip(2)},
  }).after;
  assert.deepEqual(members(reconnected), [shot(0), shot(1), shot(2)]);
  assert.deepEqual(members(reconnected, otherFilm), ['other-shot']);
  assert.equal(reconnected.anchored.find(item => item.id === 'overlay-1-0')?.anchorClipId, null, 'the explicit unbound marker survives a later addition');
});

test('track generation adds a new node at the edit point and track removal leaves it detached', () => {
  const state = fixture(2);
  const generated = {...mainClip('new-clip', 'new-shot', 0), versionId: null, sourceInFrame: 0};
  const added = planAndRoundTrip(state, {
    kind: 'track',
    edit: {kind: 'add', clip: generated, beforeClipId: clip(1), media: {nodeId: generated.nodeId, selectedVersion: null, durationFrames: duration}, nodeKind: 'shot'},
  }).after;
  assert.deepEqual(members(added), [shot(0), generated.nodeId, shot(1)]);
  assert.equal(added.clips.find(item => item.id === generated.id)?.startFrame, duration);
  const removed = planAndRoundTrip(added, {kind: 'track', edit: {kind: 'remove', clipId: generated.id}}).after;
  assert.deepEqual(members(removed), [shot(0), shot(1)]);
  assert.ok(deriveFilmChains(removed.board).detachedNodeIds.includes(generated.nodeId));
});

test('a cut stays one chain member, and moving one part out requires confirmation and a fresh node ID', () => {
  const state = fixture(3);
  const split = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'split', clipId: clip(0), offsetFrames: 20, rightClipId: 'right'}}).after;
  assert.deepEqual(members(split), [shot(0), shot(1), shot(2)]);
  const [left, right] = split.clips;
  assert.equal(left?.id, clip(0));
  assert.equal(right?.id, 'right');
  assert.ok(left?.splitGroupId);
  assert.equal(right.splitGroupId, left.splitGroupId);
  assert.equal(right.sourceInFrame, 25);
  assert.equal(split.anchored.find(item => item.id === 'overlay-0-1')?.anchorClipId, 'right');
  const separate: Operation = {kind: 'track', edit: {kind: 'move', clipId: 'right', beforeClipId: null}};
  const refused = planChainSync(split, separate);
  assert.deepEqual(refused, {ok: false, code: 'COPY_NODE_REQUIRED', nodeId: shot(0), clipId: 'right'});
  assert.deepEqual(planChainSync(reverseInput(split), separate), refused);
  const adjacent = planAndRoundTrip(split, {kind: 'track', edit: {kind: 'move', clipId: 'right', beforeClipId: clip(0)}}).after;
  assert.deepEqual(members(adjacent), [shot(0), shot(1), shot(2)]);
  assert.deepEqual(adjacent.clips.slice(0, 2).map(item => item.id), ['right', clip(0)]);
  const copy = planAndRoundTrip(split, {
    kind: 'track', edit: {kind: 'move', clipId: 'right', beforeClipId: null, copyNodeId: 'copy-shot'},
  });
  assert.deepEqual(copy.copiedNode, {fromNodeId: shot(0), toNodeId: 'copy-shot'});
  const copied = copy.after;
  assert.deepEqual(members(copied), [shot(0), shot(1), shot(2), 'copy-shot']);
  assert.equal(copied.clips.at(-1)?.nodeId, 'copy-shot');
  assert.equal(copied.anchored.find(item => item.id === 'overlay-0-1')?.startFrame, copied.clips.at(-1)!.startFrame + 2);
  const removedPart = planAndRoundTrip(split, {kind: 'track', edit: {kind: 'remove', clipId: 'right'}}).after;
  assert.deepEqual(members(removedPart), [shot(0), shot(1), shot(2)]);
  assert.equal(removedPart.anchored.find(item => item.id === 'overlay-0-1')?.anchorClipId, null);
});

test('moving a whole clip to another track detaches its node and carries a planned transfer', () => {
  const state = fixture(3);
  const result = planAndRoundTrip(state, {kind: 'track', edit: {
    kind: 'move-off-track', clipId: clip(1), trackId: 'overlay-track', startFrame: 4,
  }});
  assert.deepEqual(members(result.after), [shot(0), shot(2)]);
  assert.ok(deriveFilmChains(result.after.board).detachedNodeIds.includes(shot(1)));
  assert.equal(result.copiedNode, undefined);
  assert.deepEqual(result.transfer, {trackId: 'overlay-track', clip: mainClip(clip(1), shot(1), 4)});
  assert.deepEqual(result.after.anchored.find(item => item.id === clip(1)), {
    id: clip(1), startFrame: 4, anchorClipId: clip(0),
  });
  assert.deepEqual(result.after.anchored.find(item => item.id === 'overlay-1-0'), {
    id: 'overlay-1-0', startFrame: duration + 3, anchorClipId: null,
  });
});

test('moving one split part off main needs a fresh copy node and leaves the other part in the film', () => {
  const state = fixture(3);
  const split = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'split', clipId: clip(0), offsetFrames: 20, rightClipId: 'right'}}).after;
  const edit = {kind: 'move-off-track', clipId: 'right', trackId: 'overlay-track', startFrame: 4} as const;
  assert.deepEqual(planChainSync(split, {kind: 'track', edit}), {
    ok: false, code: 'COPY_NODE_REQUIRED', nodeId: shot(0), clipId: 'right',
  });
  const result = planAndRoundTrip(split, {kind: 'track', edit: {...edit, copyNodeId: 'copy-shot'}});
  assert.deepEqual(members(result.after), [shot(0), shot(1), shot(2)]);
  assert.ok(deriveFilmChains(result.after.board).detachedNodeIds.includes('copy-shot'));
  assert.deepEqual(result.copiedNode, {fromNodeId: shot(0), toNodeId: 'copy-shot'});
  assert.ok(result.transfer);
  assert.equal(result.transfer.trackId, 'overlay-track');
  assert.deepEqual(result.transfer.clip, {...mainClip('right', 'copy-shot', 4), durationFrames: 20, sourceInFrame: 25});
  assert.deepEqual(result.after.anchored.find(item => item.id === 'overlay-0-1'), {
    id: 'overlay-0-1', startFrame: 22, anchorClipId: null,
  });
});

test('track move and trim ripple to following anchors without changing their saved durations', () => {
  const state = fixture(3);
  const moved = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'move', clipId: clip(2), beforeClipId: clip(0)}}).after;
  assert.deepEqual(members(moved), [shot(2), shot(0), shot(1)]);
  assert.equal(moved.anchored.find(item => item.id === 'overlay-2-0')?.startFrame, 3);
  const trimmed = planAndRoundTrip(moved, {kind: 'track', edit: {kind: 'trim', clipId: clip(2), durationFrames: 24, sourceInFrame: 6}}).after;
  assert.deepEqual(members(trimmed), [shot(2), shot(0), shot(1)]);
  assert.equal(trimmed.anchored.find(item => item.id === 'overlay-0-0')?.startFrame, 27);
  assert.equal(trimmed.clips.find(item => item.id === clip(0))?.durationFrames, duration);
});

test('board version refresh preserves edits, skips locks and short sources, and leaves an unauthorised duplicate visible as a failure', () => {
  const base = fixture(3);
  const state: ChainSyncState = {
    ...base,
    media: base.media.map(row => row.nodeId === shot(0) ? {...row, selectedVersion: {id: 'v2', sourceFrames: 100}}
      : row.nodeId === shot(1) ? {...row, selectedVersion: {id: 'v2', sourceFrames: 30}}
        : row.nodeId === shot(2) ? {...row, selectedVersion: {id: 'v2', sourceFrames: 100}} : row),
    clips: base.clips.map(row => row.id === clip(2) ? {...row, versionLocked: true} : row),
  };
  const result = planAndRoundTrip(state, {kind: 'sync-board'});
  assert.deepEqual(result.after.clips.map(row => [row.versionId, row.sourceInFrame, row.durationFrames]), [
    ['v2', 5, duration], ['v1', 5, duration], ['v1', 5, duration],
  ]);
  assert.deepEqual(result.warnings, [{
    code: 'SOURCE_TOO_SHORT', clipId: clip(1), nodeId: shot(1), versionId: 'v2', shortByFrames: 15,
  }]);

  const duplicate = {
    ...base, clips: [...base.clips, mainClip('dup', shot(0), duration * 3)],
  };
  const refused = planChainSync(duplicate, {kind: 'sync-board'});
  assert.ok(!refused.ok);
  assert.equal(refused.code, 'DUPLICATE_TRACK_NODE');
});

test('track selects a shared version and locks a per-clip version without rewriting the board selection', () => {
  const state = fixture(1);
  const version = {id: 'v2', sourceFrames: 60};
  const shared = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'version', clipId: clip(0), version, locked: false}}).after;
  assert.deepEqual(shared.media.find(row => row.nodeId === shot(0))?.selectedVersion, version);
  assert.equal(shared.clips[0]?.versionId, 'v2');
  const locked = planAndRoundTrip(shared, {kind: 'track', edit: {
    kind: 'version', clipId: clip(0), version: {id: 'v3', sourceFrames: 75}, locked: true,
  }}).after;
  assert.deepEqual(locked.media.find(row => row.nodeId === shot(0))?.selectedVersion, version);
  assert.deepEqual([locked.clips[0]?.versionId, locked.clips[0]?.versionLocked], ['v3', true]);
});

function withPlaceholder(state: ChainSyncState, nodeId: string): ChainSyncState {
  return {...state,
    media: state.media.map(row => row.nodeId === nodeId ? {...row, selectedVersion: null} : row),
    clips: state.clips.map(row => row.nodeId === nodeId ? {...row, versionId: null, sourceInFrame: 0} : row),
  };
}

for (const sourceFrames of [duration - 1, duration, duration + 30]) {
  test(`a first source of ${sourceFrames} frames replaces the estimate and can be undone exactly`, () => {
    const state = withPlaceholder(fixture(3), shot(1));
    const version = {id: 'first-video', sourceFrames};
    const result = planAndRoundTrip(state, {kind: 'board-version', nodeId: shot(1), version});
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.after.media.find(row => row.nodeId === shot(1))?.selectedVersion, version);
    assert.deepEqual(result.after.clips, [
      state.clips[0],
      {...state.clips[1], versionId: version.id, sourceInFrame: 0, durationFrames: sourceFrames},
      {...state.clips[2], startFrame: duration + sourceFrames},
    ]);
    assert.deepEqual(result.after.anchored.find(row => row.id === 'overlay-2-1'),
      {id: 'overlay-2-1', startFrame: duration + sourceFrames + 22, anchorClipId: clip(2)});
    assert.equal(result.after.anchored.find(row => row.id === 'overlay-1-0')?.startFrame, duration + 3);
  });
}

test('sync-board and both track version modes fill a placeholder and ripple from the real length', () => {
  const state = withPlaceholder(fixture(2), shot(0));
  const version = {id: 'first-video', sourceFrames: 25};
  const selectedOnBoard = {...state,
    media: state.media.map(row => row.nodeId === shot(0) ? {...row, selectedVersion: version} : row),
  };
  const synced = planAndRoundTrip(selectedOnBoard, {kind: 'sync-board'});
  assert.deepEqual(synced.changes.media, []);
  const shared = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'version', clipId: clip(0), version, locked: false}});
  const locked = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'version', clipId: clip(0), version, locked: true}});
  assert.deepEqual(locked.changes.media, []);
  assert.deepEqual(shared.after, synced.after);
  for (const [result, versionLocked] of [[synced, false], [shared, false], [locked, true]] as const) {
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.after.clips[0],
      {...state.clips[0], durationFrames: 25, versionId: version.id, versionLocked});
    assert.equal(result.after.clips[1]?.startFrame, 25);
    assert.equal(result.after.anchored.find(row => row.id === 'overlay-1-0')?.startFrame, 28);
  }
});

test('untimed images use the display duration and a split placeholder uses the full source once', () => {
  const state = withPlaceholder(fixture(2), shot(0));
  const image = {...state,
    board: {...state.board, nodes: state.board.nodes.map(node =>
      node.id === shot(0) ? {...node, kind: 'image' as const} : node)},
    media: state.media.map(row => row.nodeId === shot(0) ? {...row, durationFrames: 31} : row),
  };
  const still = planAndRoundTrip(image, {kind: 'board-version', nodeId: shot(0), version: {id: 'still', sourceFrames: null}});
  assert.deepEqual(still.after.clips[0], {...state.clips[0], versionId: 'still', durationFrames: 31});
  assert.equal(still.after.clips[1]?.startFrame, 31);

  const cut = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'split', clipId: clip(0), offsetFrames: 16, rightClipId: 'right'}});
  const version = {id: 'first-video', sourceFrames: 60};
  const shared = planAndRoundTrip(cut.after, {kind: 'board-version', nodeId: shot(0), version});
  assert.deepEqual(shared.after.clips.map(row => [row.id, row.versionId, row.startFrame, row.durationFrames, row.sourceInFrame]),
    [[clip(0), version.id, 0, 16, 0], ['right', version.id, 16, 44, 16], [clip(1), selected.id, 60, 40, 5]]);
  assert.equal(shared.after.anchored.find(row => row.id === 'overlay-1-0')?.startFrame, 63);

  const short = {id: 'short-video', sourceFrames: 15};
  const shortened = planAndRoundTrip(cut.after, {kind: 'track', edit: {kind: 'version', clipId: clip(0), version: short, locked: false}});
  assert.deepEqual(shortened.warnings, []);
  assert.deepEqual(shortened.after.clips.map(row => [row.id, row.versionId, row.startFrame, row.durationFrames]),
    [[clip(0), short.id, 0, 15], [clip(1), selected.id, 15, 40]]);
  assert.deepEqual(shortened.after.anchored.find(row => row.id === 'overlay-0-1'),
    {id: 'overlay-0-1', startFrame: 22, anchorClipId: null});
});

test('repairing the active board removes raw duplicate edges and leaves the track for explicit reconciliation', () => {
  const base = fixture(3);
  const extra = edge(shot(0), 'loose');
  const broken = {...base, board: {...base.board, edges: [...base.board.edges, extra, extra, edge('loose', shot(2))]}};
  const blocked = planChainSync(broken, {kind: 'sync-board'});
  assert.ok(!blocked.ok && 'issues' in blocked);
  assert.deepEqual(blocked.issues.map(row => row.code), ['DUPLICATE_EDGE', 'MULTIPLE_PREDECESSORS', 'MULTIPLE_SUCCESSORS']);
  const disconnect = planAndRoundTrip(broken, {kind: 'board', edit: {kind: 'disconnect', ...extra}});
  assert.deepEqual(disconnect.issues.map(row => row.code), ['MULTIPLE_PREDECESSORS']);
  assert.deepEqual(disconnect.changes.edges, [{before: extra, after: null}, {before: extra, after: null}]);
  assert.deepEqual(disconnect.changes.clips, []);
  assert.deepEqual(disconnect.changes.anchored, []);
  const repaired = planAndRoundTrip(disconnect.after, {kind: 'board', edit: {kind: 'disconnect', fromId: 'loose', toId: shot(2)}});
  assert.deepEqual(repaired.issues, []);
  assert.deepEqual(repaired.changes.clips, []);
  const synced = planAndRoundTrip(repaired.after, {kind: 'sync-board'});
  assert.deepEqual(synced.after.clips, base.clips);
  assert.deepEqual(synced.after.anchored, base.anchored);
});

test('a partial repair returns remaining errors and healthy components can still be edited', () => {
  const base = fixture(3);
  const wrongKind = {id: 'bad', kind: 'text' as const};
  const duplicateMedia = [media('bad'), {...media('bad'), durationFrames: 23}];
  const broken = {...base, media: [...base.media, ...duplicateMedia], board: {
    nodes: [...base.board.nodes, {id: 'bad', kind: 'shot' as const}, wrongKind],
    edges: [...base.board.edges, edge(shot(0), 'missing'), edge(shot(1), 'bad')],
  }};
  const deletion = planAndRoundTrip(broken, {kind: 'board', edit: {kind: 'delete', nodeId: 'bad'}});
  assert.deepEqual(deletion.issues.map(row => row.code), ['MISSING_NODE']);
  assert.equal(deletion.changes.nodes.length, 2);
  assert.deepEqual(deletion.changes.media.map(row => row.before), [...duplicateMedia].reverse());
  assert.deepEqual(deletion.changes.clips, []);
  const refused = planChainSync(deletion.after, {kind: 'sync-board'});
  assert.ok(!refused.ok && 'issues' in refused);
  assert.equal(refused.code, 'MISSING_NODE');

  const detached = {...base, board: {
    nodes: [...base.board.nodes, {id: 'bad', kind: 'shot' as const}, wrongKind], edges: base.board.edges,
  }};
  const connected = planAndRoundTrip(detached, {kind: 'board',
    edit: {kind: 'connect', fromId: shot(2), toId: 'loose'}, newClipIds: {loose: 'new'}});
  assert.deepEqual(connected.issues.map(row => row.code), ['DUPLICATE_NODE']);
  const moved = planAndRoundTrip(connected.after, {kind: 'track', edit: {kind: 'move', clipId: clip(2), beforeClipId: null}});
  assert.deepEqual(moved.issues, connected.issues);
  assert.deepEqual(moved.changes.nodes, []);
  assert.equal(moved.after.board.nodes.filter(row => row.id === 'bad').length, 2);
});

test('split copies cannot reuse an ID reserved by a dangling edge', () => {
  const base = fixture(3);
  const state = {...base, board: {...base.board, edges: [...base.board.edges, edge('loose', 'missing')]}};
  const split = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'split', clipId: clip(1), offsetFrames: 20, rightClipId: 'right'}});
  for (const edit of [
    {kind: 'move', beforeClipId: null}, {kind: 'move-off-track', trackId: 'overlay', startFrame: 4},
  ] as const) {
    assert.deepEqual(planChainSync(split.after, {kind: 'track', edit: {...edit, clipId: 'right', copyNodeId: 'missing'}}),
      {ok: false, code: 'NODE_ALREADY_LINKED', id: 'missing'});
  }
});

test('dropping on an endpoint or moving a whole node inside another split is an explicit refusal', () => {
  const state = fixture(3);
  const endpoint = planChainSync(state, {kind: 'board', edit: {kind: 'insert', nodeId: shot(0), fromId: shot(0), toId: shot(1)}});
  assert.ok(!endpoint.ok);
  assert.equal(endpoint.code, 'NODE_ALREADY_LINKED');

  const split = planAndRoundTrip(state, {kind: 'track', edit: {kind: 'split', clipId: clip(1), offsetFrames: 20, rightClipId: 'right'}});
  const original = JSON.stringify(split.after);
  assert.deepEqual(planChainSync(split.after, {kind: 'track', edit: {kind: 'move', clipId: clip(2), beforeClipId: 'right'}}),
    {ok: false, code: 'INSERT_BETWEEN_SPLIT_PARTS', id: clip(2)});
  assert.equal(JSON.stringify(split.after), original);
});

test('changing a board version includes the selected source and followed clip in one reversible plan', () => {
  const state = fixture(2);
  const version = {id: 'v2', sourceFrames: 90};
  const result = planAndRoundTrip(state, {kind: 'board-version', nodeId: shot(0), version});
  assert.deepEqual(result.after.media.find(row => row.nodeId === shot(0))?.selectedVersion, version);
  assert.deepEqual(result.after.clips[0], {...state.clips[0], versionId: 'v2'});
  assert.equal(result.changes.media.length, 1);
  assert.equal(result.changes.clips.length, 1);
  assert.deepEqual(result.changes.edges, []);
  assert.deepEqual(result.changes.anchored, []);
});

test('invalid trim frames and occupied split IDs cannot create either side of a transaction', () => {
  const state = fixture(2);
  const original = JSON.stringify(state);
  for (const durationFrames of [0, -2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(planChainSync(state, {kind: 'track', edit: {kind: 'trim', clipId: clip(0), durationFrames}}),
      {ok: false, code: 'INVALID_CLIP_FRAMES', id: clip(0)});
  }
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'split', clipId: clip(0), offsetFrames: 20, rightClipId: clip(1),
  }}), {ok: false, code: 'DUPLICATE_CLIP', id: clip(1)});
  assert.equal(JSON.stringify(state), original);
});

test('main and other-track items cannot share an identity', () => {
  const state = fixture(2);
  const duplicate = {
    ...state, anchored: [...state.anchored, {id: clip(0), startFrame: 0}],
  };
  assert.deepEqual(planChainSync(duplicate, {kind: 'sync-board'}),
    {ok: false, code: 'INVALID_ANCHOR', id: clip(0)});

  const usedId = state.anchored[0]!.id;
  const original = JSON.stringify(state);
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'split', clipId: clip(0), offsetFrames: 20, rightClipId: usedId,
  }}), {ok: false, code: 'DUPLICATE_CLIP', id: usedId});
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'add', clip: {...mainClip(usedId, 'loose', 0), versionId: null, sourceInFrame: 0}, beforeClipId: null,
  }}), {ok: false, code: 'DUPLICATE_CLIP', id: usedId});
  assert.deepEqual(planChainSync(state, {kind: 'board', edit: {
    kind: 'connect', fromId: shot(1), toId: 'loose',
  }, newClipIds: {loose: usedId}}), {ok: false, code: 'DUPLICATE_CLIP', id: usedId});
  assert.equal(JSON.stringify(state), original);
});

test('split, trim and add reject source ranges beyond the selected asset', () => {
  const state = fixture(2);
  const original = JSON.stringify(state);
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'split', clipId: clip(0), offsetFrames: 20, rightClipId: 'right', rightSourceInFrame: 81,
  }}), {ok: false, code: 'SOURCE_BOUNDS', id: 'right'});
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'trim', clipId: clip(0), durationFrames: 40, sourceInFrame: 61,
  }}), {ok: false, code: 'SOURCE_BOUNDS', id: clip(0)});
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'add', clip: {...mainClip('extra', 'loose', 0), sourceInFrame: 61}, beforeClipId: null, media: media('loose'),
  }}), {ok: false, code: 'SOURCE_BOUNDS', id: 'extra'});
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'add', clip: {...mainClip('extra', 'loose', 0), versionId: 'different'}, beforeClipId: null, media: media('loose'),
  }}), {ok: false, code: 'INVALID_CLIP_VERSION', id: 'extra'});
  assert.equal(JSON.stringify(state), original);
});

test('two records of the same clip ID with conflicting versions give one deterministic refusal', () => {
  const base = fixture(2);
  const state = {...base, clips: [...base.clips, {...base.clips[0]!, versionId: ''}]};
  const failure = {ok: false, code: 'DUPLICATE_CLIP', id: clip(0)};
  assert.deepEqual(planChainSync(state, {kind: 'sync-board'}), failure);
  assert.deepEqual(planChainSync(reverseInput(state), {kind: 'sync-board'}), failure);
});

test('a ripple that would move an anchored item beyond the frame range refuses the entire edit', () => {
  const base = fixture(2);
  const state: ChainSyncState = {
    ...base, anchored: [{id: 'far-overlay', startFrame: Number.MAX_SAFE_INTEGER, anchorClipId: clip(0)}],
  };
  const original = JSON.stringify(state);
  assert.deepEqual(planChainSync(state, {kind: 'track', edit: {
    kind: 'move', clipId: clip(0), beforeClipId: null,
  }}), {ok: false, code: 'INVALID_ANCHOR', id: 'far-overlay'});
  assert.equal(JSON.stringify(state), original);
});

test('SA planning and analysis timings for a 500-shot, 500-clip, 1000-overlay workload', t => {
  const state = fixture(500);
  const first = shot(0);
  const middle = shot(250);
  const last = shot(499);
  const filmEdge = {fromId: film, toId: first};
  const split = planChainSync(state, {kind: 'track', edit: {kind: 'split', clipId: clip(250), offsetFrames: 20, rightClipId: 'right'}});
  assert.ok(split.ok);
  const reordered = {...state, board: {...state.board, edges: graphEdges([...members(state)!].reverse())}};
  const nodesById = new Map(state.board.nodes.map(node => [node.id, node]));
  const reorderedChain = members(reordered)!.map(nodeId => nodesById.get(nodeId)!);
  const boardProjection = members(state)!.map(nodeId => ({nodeId, versionId: selected.id}));
  const trackProjection = state.clips.map(row => ({nodeId: row.nodeId, versionId: row.versionId}));
  const baseline = {board: boardProjection, track: trackProjection};
  const timings: Record<string, number> = {};
  const warmups = 5;
  const samples = 11;
  const measure = (name: string, operation: () => unknown, repetitions = 1) => {
    for (let index = 0; index < warmups; index++) operation();
    const all = Array.from({length: samples}, () => {
      const start = performance.now();
      for (let repetition = 0; repetition < repetitions; repetition++) operation();
      return (performance.now() - start) / repetitions;
    }).sort((a, b) => a - b);
    timings[name] = Number(all[Math.floor(samples / 2)]!.toFixed(6));
  };
  const timePlan = (name: string, source: ChainSyncState, operation: Operation, expected = true) => {
    assert.equal(planChainSync(source, operation).ok, expected, name);
    measure(name, () => planChainSync(source, operation));
  };

  measure('connection_sequence', () => classifyChainConnection('shot', 'video'), 250);
  measure('connection_reference', () => classifyChainConnection('image', 'shot', 'reference'), 250);
  measure('connection_refused', () => classifyChainConnection('text', 'shot'), 250);
  measure('derive_chains', () => deriveFilmChains(state.board));
  measure('board_edges_only', () => planBoardSequenceEdit(state.board, {kind: 'insert', nodeId: 'loose', ...filmEdge}));
  timePlan('board_connect', state, {kind: 'board', edit: {kind: 'connect', fromId: last, toId: 'loose'}, newClipIds: {loose: 'extra'}});
  timePlan('board_connect_refused', state, {kind: 'board', edit: {kind: 'connect', fromId: last, toId: first}}, false);
  timePlan('board_insert_first', state, {kind: 'board', edit: {kind: 'insert', nodeId: 'loose', ...filmEdge}, newClipIds: {loose: 'extra'}});
  timePlan('board_reinsert_linked', state, {kind: 'board', edit: {kind: 'insert', nodeId: last, fromId: shot(249), toId: middle}});
  timePlan('board_delete_first', state, {kind: 'board', edit: {kind: 'delete', nodeId: first}});
  timePlan('board_delete_middle', state, {kind: 'board', edit: {kind: 'delete', nodeId: middle}});
  timePlan('board_delete_last', state, {kind: 'board', edit: {kind: 'delete', nodeId: last}});
  timePlan('board_disconnect', state, {kind: 'board', edit: {kind: 'disconnect', fromId: shot(249), toId: middle}});
  measure('main_track_projection', () => planChainMainTrack(reorderedChain, state.media, state.clips));
  timePlan('board_reorder_track', reordered, {kind: 'sync-board'});
  const refreshed = {...state, media: state.media.map(row => ({
    ...row, selectedVersion: row.nodeId === 'loose' ? null : {id: 'v2', sourceFrames: 100},
  }))};
  timePlan('board_refresh_versions', refreshed, {kind: 'sync-board'});
  timePlan('board_select_version', state, {kind: 'board-version', nodeId: middle, version: {id: 'v2', sourceFrames: 80}});
  timePlan('board_materialize_placeholder', withPlaceholder(state, middle),
    {kind: 'board-version', nodeId: middle, version: {id: 'first-video', sourceFrames: 79}});
  const badEdge = edge(middle, 'loose');
  const damaged = {...state, board: {...state.board, edges: [...state.board.edges, badEdge, badEdge]}};
  timePlan('board_repair_duplicate_edge', damaged, {kind: 'board', edit: {kind: 'disconnect', ...badEdge}});
  timePlan('track_move', state, {kind: 'track', edit: {kind: 'move', clipId: clip(400), beforeClipId: clip(20)}});
  timePlan('track_remove', state, {kind: 'track', edit: {kind: 'remove', clipId: clip(250)}});
  const added = {...mainClip('extra', 'loose', 0), versionId: null, sourceInFrame: 0};
  timePlan('track_add', state, {kind: 'track', edit: {kind: 'add', clip: added, beforeClipId: clip(250)}});
  timePlan('track_split', state, {kind: 'track', edit: {kind: 'split', clipId: clip(250), offsetFrames: 20, rightClipId: 'right'}});
  timePlan('track_insert_between_split_parts_refused', split.after,
    {kind: 'track', edit: {kind: 'move', clipId: clip(400), beforeClipId: 'right'}}, false);
  timePlan('track_split_move_requires_copy', split.after, {kind: 'track', edit: {kind: 'move', clipId: 'right', beforeClipId: null}}, false);
  timePlan('track_split_copy_move', split.after, {kind: 'track', edit: {kind: 'move', clipId: 'right', beforeClipId: null, copyNodeId: 'copy-shot'}});
  timePlan('track_move_off_main', state, {kind: 'track', edit: {kind: 'move-off-track', clipId: clip(250), trackId: 'overlay-track', startFrame: 4}});
  const offMain = {kind: 'move-off-track', clipId: 'right', trackId: 'overlay-track', startFrame: 4} as const;
  timePlan('track_split_move_off_main_requires_copy', split.after, {kind: 'track', edit: offMain}, false);
  timePlan('track_split_copy_move_off_main', split.after, {kind: 'track', edit: {...offMain, copyNodeId: 'copy-shot'}});
  timePlan('track_trim', state, {kind: 'track', edit: {kind: 'trim', clipId: clip(250), durationFrames: 30}});
  timePlan('track_version', state, {kind: 'track', edit: {kind: 'version', clipId: clip(250), version: {id: 'v2', sourceFrames: 80}, locked: false}});
  measure('anchors', () => planTrackAnchors(state.clips, split.after.clips, state.anchored, [{clipId: clip(250), rightClipId: 'right', atFrame: duration * 250 + 20}]));
  measure('three_way_equal', () => compareChainSync(baseline, boardProjection, trackProjection));
  const changedProjection = [...boardProjection].reverse();
  measure('three_way_reordered', () => compareChainSync(baseline, changedProjection, trackProjection));

  t.diagnostic(`SA_SYNC_SAMPLE ${JSON.stringify({
    platform: process.platform, arch: process.arch, shots: 500, clips: 500, overlays: state.anchored.length,
    splitMoveClips: split.after.clips.length, warmups, samples, statistic: 'medianMs', timings,
  })}`);
});

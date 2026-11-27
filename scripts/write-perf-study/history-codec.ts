/** Analysis-only encodings of persisted format-5 history. No product readers or writers use these. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SequenceEditStateDelta} from '../../packages/contracts/src/sequence-edit.ts';
import type {Format5SyncBaseline} from '../../packages/contracts/src/project-format5.ts';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRow;
type JsonRow = {[key: string]: JsonValue};
type Side = 0 | 1; // 0: before; 1: after.
type Pair<T> = readonly [T, T];
type Collection = 'board' | 'clips' | 'cues';
const collections: readonly Collection[] = ['board', 'clips', 'cues'];

type Slot = [] | [JsonValue];
type Field = readonly [path: readonly string[], before: Slot, after: Slot];
type RowPatch = {id: string; fields: Field[]} | {rows: Pair<JsonRow | null>};
type RangeShift = {lane: string; boundary: Pair<readonly [first: string, last: string]>;
  count: number; shift: number; digests: Pair<string>};
type ArrayDelta = {runs: ReadonlyArray<readonly [before: number, after: number, count: number]>;
  literal: Pair<ReadonlyArray<readonly [index: number, row: JsonRow]>>;
  lengths: Pair<number>; digests: Pair<string>};
type BaselineDelta = {board: ArrayDelta; track: ArrayDelta};
type Frozen = Pair<SequenceEditStateDelta>;
export type LiveTimedRows = {clips: readonly {id: string; trackId: string; startFrame: number}[];
  cues: readonly {id: string; startFrame: number}[]};

export const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key]!) ]));
}
function digest(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const asRows = (data: unknown) => data as readonly JsonRow[];
const rowKey = (row: JsonRow): string => typeof row.kind === 'string' && row.data ? row.kind + ':' + row.id : String(row.id);
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function indexRows(rows: readonly JsonRow[]): Map<string, JsonRow> {
  const result = new Map(rows.map(row => [rowKey(row), row]));
  assert.equal(result.size, rows.length, 'each typed row ID must be unique in a direction');
  return result;
}
function digestRows(rows: Map<string, JsonRow>): string {
  return digest([...rows].sort(([left], [right]) => compareText(left, right)));
}
function object(value: JsonValue | undefined): value is JsonRow {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const field = (row: JsonRow, key: string): Slot => Object.hasOwn(row, key) ? [row[key]!] : [];
function diffFields(before: JsonRow, after: JsonRow, parent: readonly string[] = []): Field[] {
  const changes: Field[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = field(before, key), next = field(after, key);
    if (isDeepStrictEqual(previous, next)) continue;
    const at = [...parent, key];
    const [oldValue] = previous, [newValue] = next;
    if (object(oldValue) && object(newValue)) changes.push(...diffFields(oldValue, newValue, at));
    else changes.push([at, previous, next]);
  }
  return changes;
}
function translateRow(row: JsonRow, fields: readonly Field[], from: Side): JsonRow {
  const next = structuredClone(row);
  for (const [at, before, after] of fields) {
    assert.ok(at.length > 0 && !at.some(key => ['__proto__', 'constructor', 'prototype'].includes(key)));
    let current = next;
    for (const key of at.slice(0, -1)) {
      const nested = current[key];
      assert.ok(object(nested));
      current = nested;
    }
    const key = at.at(-1)!;
    assert.deepEqual(field(current, key), from === 0 ? before : after, 'compare exact type and field presence');
    const destination = from === 0 ? after : before;
    if (destination.length === 0) delete current[key];
    else current[key] = structuredClone(destination[0]);
  }
  return next;
}
function rowPatch(before: JsonRow | null, after: JsonRow | null): RowPatch {
  const full: RowPatch = {rows: [before, after]};
  if (!before || !after) return full;
  const compact: RowPatch = {id: rowKey(before), fields: diffFields(before, after)};
  return utf8(compact) < utf8(full) ? compact : full;
}
function decodeRows(patches: RowPatch[], from: Side, current: Map<string, JsonRow>): JsonRow[] {
  const output: JsonRow[] = [];
  for (const patch of patches) {
    if ('fields' in patch) output.push(translateRow(current.get(patch.id)!, patch.fields, from));
    else {
      const [original, destination] = from === 0 ? patch.rows : [patch.rows[1], patch.rows[0]];
      if (original) assert.deepEqual(current.get(rowKey(original)), original);
      if (destination) output.push(destination);
    }
  }
  return output;
}

const isTimed = (name: Collection): name is 'clips' | 'cues' => name === 'clips' || name === 'cues';
const laneOf = (row: JsonRow) => String(row.trackId ?? 'subtitles');
function laneOrder(rows: readonly JsonRow[]): Map<string, JsonRow[]> {
  const lanes = new Map<string, JsonRow[]>();
  for (const row of rows) {
    const lane = laneOf(row);
    const group = lanes.get(lane) ?? [];
    group.push(row);
    lanes.set(lane, group);
  }
  for (const lane of lanes.values()) lane.sort((a, b) => Number(a.startFrame) - Number(b.startFrame) ||
    compareText(rowKey(a), rowKey(b)));
  return lanes;
}
function changedByShift(before: JsonRow, after: JsonRow | undefined): number | null {
  if (!after || !Number.isSafeInteger(before.startFrame) || !Number.isSafeInteger(after.startFrame) ||
      (before.trackId ?? null) !== (after.trackId ?? null)) return null;
  const shift = Number(after.startFrame) - Number(before.startFrame);
  return shift !== 0 && isDeepStrictEqual({...before, startFrame: after.startFrame}, after) ? shift : null;
}
function computeRanges(rows: Pair<Map<string, JsonRow>>, order: Pair<Map<string, JsonRow[]>>): {
  shifts: RangeShift[]; excluded: Set<string>;
} {
  const shifts: RangeShift[] = [], excluded = new Set<string>();
  for (const [lane, before] of order[0]) {
    const after = order[1].get(lane) ?? [];
    const indexes = new Map(after.map((row, index) => [rowKey(row), index]));
    let start = 0;
    while (start < before.length) {
      const first = before[start]!;
      const key = rowKey(first), offset = indexes.get(key), old = rows[0].get(key);
      const shift = old && isDeepStrictEqual(old, first) ? changedByShift(first, rows[1].get(key)) : null;
      if (offset === undefined || shift === null || !isDeepStrictEqual(rows[1].get(key), after[offset])) {
        ++start;
        continue;
      }
      let count = 1;
      while (start + count < before.length && offset + count < after.length) {
        const previous = before[start + count]!, next = after[offset + count]!, id = rowKey(previous);
        if (id !== rowKey(next) || changedByShift(previous, next) !== shift ||
            !isDeepStrictEqual(rows[0].get(id), previous) || !isDeepStrictEqual(rows[1].get(id), next)) break;
        ++count;
      }
      const oldRange = before.slice(start, start + count), newRange = after.slice(offset, offset + count);
      const boundary = [key, rowKey(oldRange.at(-1)!)] as const;
      const range: RangeShift = {lane, boundary: [boundary, boundary], count, shift,
        digests: [digest(oldRange), digest(newRange)]};
      const ordinary = oldRange.map((row, index) => rowPatch(row, newRange[index]!));
      if (count >= 3 && utf8(range) < utf8(ordinary)) {
        shifts.push(range);
        for (const row of oldRange) excluded.add(rowKey(row));
      }
      start += count;
    }
  }
  return {shifts, excluded};
}
function expandRange(range: RangeShift, from: Side, order: Pair<Map<string, JsonRow[]>>): JsonRow[] {
  const lane = order[from].get(range.lane) ?? [];
  const [first, last] = range.boundary[from];
  const index = lane.findIndex(row => rowKey(row) === first);
  assert.ok(index >= 0);
  const current = lane.slice(index, index + range.count);
  assert.equal(current.length, range.count);
  assert.equal(rowKey(current.at(-1)!), last);
  assert.equal(digest(current), range.digests[from], 'entire exact range must match before applying a shift');
  const result = current.map(row => ({...row, startFrame: Number(row.startFrame) + (from === 0 ? range.shift : -range.shift)}));
  assert.equal(digest(result), range.digests[from === 0 ? 1 : 0], 'the shifted rows must match the frozen evidence');
  return result;
}
function encodeArray(before: readonly JsonRow[], after: readonly JsonRow[], idField: 'nodeId' | 'clipId'): ArrayDelta {
  const indexes = new Map(before.map((row, index) => [row[idField], index]));
  assert.equal(indexes.size, before.length);
  assert.equal(new Set(after.map(row => row[idField])).size, after.length);
  const runs: Array<[number, number, number]> = [];
  const used = new Set<number>();
  const newLiteral: Array<[number, JsonRow]> = [];
  for (let next = 0; next < after.length; next++) {
    const row = after[next]!, previous = indexes.get(row[idField]);
    if (previous === undefined || !isDeepStrictEqual(row, before[previous])) {
      newLiteral.push([next, row]);
      continue;
    }
    const last = runs.at(-1);
    if (last && last[0] + last[2] === previous && last[1] + last[2] === next) ++last[2];
    else runs.push([previous, next, 1]);
    used.add(previous);
  }
  const oldLiteral = before.flatMap((row, index): Array<[number, JsonRow]> => used.has(index) ? [] : [[index, row]]);
  return {runs, literal: [oldLiteral, newLiteral], lengths: [before.length, after.length],
    digests: [digest([...before]), digest([...after])]};
}
function decodeArray(delta: ArrayDelta, from: Side, source: readonly JsonRow[]): JsonRow[] {
  const to = from === 0 ? 1 : 0;
  assert.equal(source.length, delta.lengths[from]);
  assert.equal(digest([...source]), delta.digests[from]);
  const result = new Map<number, JsonRow>(delta.literal[to]);
  for (const run of delta.runs) {
    for (let i = 0; i < run[2]; ++i) {
      const index = run[to] + i;
      assert.equal(result.has(index), false, 'overlapping sequence splice');
      result.set(index, source[run[from] + i]!);
    }
  }
  assert.equal(result.size, delta.lengths[to]);
  const ordered = Array.from({length: delta.lengths[to]}, (_, index) => {
    const row = result.get(index);
    assert.ok(row);
    return row;
  });
  assert.equal(digest(ordered), delta.digests[to]);
  return ordered;
}
function baselinePair(patch: Frozen): BaselineDelta | null {
  const before = patch[0].timeline.baseline, after = patch[1].timeline.baseline;
  if (before.kind !== 'set' || after.kind !== 'set' || before.value.version !== after.value.version) return null;
  const compact = {board: encodeArray(asRows(before.value.board), asRows(after.value.board), 'nodeId'),
    track: encodeArray(asRows(before.value.track), asRows(after.value.track), 'clipId')};
  if (utf8(compact) >= utf8([before, after])) return null;
  for (const from of [0, 1] as const) {
    const source: Format5SyncBaseline = from === 0 ? before.value : after.value;
    const target: Format5SyncBaseline = from === 0 ? after.value : before.value;
    assert.deepEqual(decodeArray(compact.board, from, asRows(source.board)), target.board);
    assert.deepEqual(decodeArray(compact.track, from, asRows(source.track)), target.track);
  }
  return compact;
}
function payload(delta: SequenceEditStateDelta, compactBaseline: BaselineDelta | null) {
  const {clips: _clips, cues: _cues, baseline, ...timeline} = delta.timeline;
  return {boardRemovals: delta.board.removals, timeline, ...(compactBaseline ? {} : {baseline})};
}

export function analyzeHistory(patch: Frozen, live: Pair<LiveTimedRows>): {
  fieldBytes: number; fieldRangeBytes: number; rangeBaselineBytes: number; rangeRows: number;
  baselineStoredBytes: number; baselineCompactBytes: number | null; rangeCount: number;
} {
  const contents = [{board: asRows(patch[0].board.writes), clips: asRows(patch[0].timeline.clips), cues: asRows(patch[0].timeline.cues)},
    {board: asRows(patch[1].board.writes), clips: asRows(patch[1].timeline.clips), cues: asRows(patch[1].timeline.cues)}] as const;
  const fields: Partial<Record<Collection, unknown>> = {}, ranges: Partial<Record<Collection, unknown>> = {};
  let rangeRows = 0, rangeCount = 0;
  for (const name of collections) {
    const rows = [indexRows(contents[0][name]), indexRows(contents[1][name])] as const;
    const order = isTimed(name) ? [laneOrder(asRows(live[0][name])), laneOrder(asRows(live[1][name]))] as const : null;
    const compact = order ? computeRanges(rows, order) : {shifts: [], excluded: new Set<string>()};
    const keys = [...new Set([...rows[0].keys(), ...rows[1].keys()])].sort(compareText);
    const rowDigests = [digestRows(rows[0]), digestRows(rows[1])] as const;
    const entries = keys.map(key => ({key, patch: rowPatch(rows[0].get(key) ?? null, rows[1].get(key) ?? null)}));
    const fieldOnly = entries.map(entry => entry.patch);
    const residual = entries.filter(entry => !compact.excluded.has(entry.key)).map(entry => entry.patch);
    for (const from of [0, 1] as const) {
      const to = from === 0 ? 1 : 0;
      assert.equal(digestRows(rows[from]), rowDigests[from]);
      const compare = (candidate: JsonRow[]) => {
        const actual = indexRows(candidate);
        assert.equal(digestRows(actual), rowDigests[to]);
        assert.deepEqual(actual, rows[to]);
      };
      compare(decodeRows(fieldOnly, from, rows[from]));
      if (order) compare([...decodeRows(residual, from, rows[from]),
        ...compact.shifts.flatMap(shift => expandRange(shift, from, order))]);
    }
    fields[name] = {rowDigests, patches: fieldOnly};
    ranges[name] = {rowDigests, patches: residual, ...(compact.shifts.length > 0 ? {shifts: compact.shifts} : {})};
    rangeRows += compact.excluded.size;
    rangeCount += compact.shifts.length;
  }
  const baseline = baselinePair(patch);
  return {fieldBytes: utf8({version: 1, data: fields, residual: patch.map(side => payload(side, null))}),
    fieldRangeBytes: utf8({version: 1, data: ranges, residual: patch.map(side => payload(side, null))}),
    rangeBaselineBytes: utf8({version: 1, data: ranges, residual: patch.map(side => payload(side, baseline)),
      ...(baseline ? {baseline} : {})}),
    rangeRows, baselineStoredBytes: patch.reduce((total, side) => total + utf8(side.timeline.baseline), 0),
    baselineCompactBytes: baseline ? utf8(baseline) : null, rangeCount};
}

/** A copied location in one saved timeline revision. Never a live selection. */
export interface TimelineAssetUse {
  readonly projectId: string;
  readonly timelineId: string;
  readonly timelineRevision: number;
  readonly assetId: string;
  readonly clipId: string;
  readonly trackId: string;
  readonly clipName: string;
  readonly trackName: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  /** Local comparison token only; never a displayed value or service authority. */
  readonly sourceIdentity: string;
}

type UsesByAssetId = Readonly<Record<string, readonly TimelineAssetUse[]>>;
export type UsageSnapshot = Readonly<{
  status: 'ready'; projectId: string; timelineId: string; timelineRevision: number; usesByAssetId: UsesByAssetId;
}> | Readonly<{
  status: 'unknown'; projectId: string; timelineId: null; timelineRevision: null; usesByAssetId: UsesByAssetId;
}>;

export interface TimelineAssetUsageInput {
  readonly projectId: string;
  readonly assets: unknown;
  readonly timeline: unknown;
  readonly ready: boolean;
}

// Current saved-timeline structural limits, from timeline-replacement.mjs and
// timeline-inputs.mjs. This projection deliberately does not validate render
// settings, codec support, source availability, geometry relationships,
// subtitles or drafts. Extra source metadata only fences navigation identity.
const MAX_TRACKS = 12;
const MAX_CLIPS = 100;
const MAX_FRAMES = 18000;
const EMPTY_USES: readonly TimelineAssetUse[] = Object.freeze([]);
const EMPTY_INDEX: UsesByAssetId = Object.freeze({});
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const read = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

interface Track { readonly id: string; readonly name: string; readonly orderIndex: number; readonly saved: Record<string, unknown>; readonly uses: TimelineAssetUse[] }
const sameOptionalOwner = (value: Record<string, unknown>, projectId: string, timelineId: string): boolean =>
  (!Object.hasOwn(value, 'projectId') || read(value, 'projectId') === projectId) &&
  (!Object.hasOwn(value, 'timelineId') || read(value, 'timelineId') === timelineId);

type IdentityValue = string | number | boolean | readonly number[];
type IdentityEntry = readonly [string, 0] | readonly [string, 1, IdentityValue];
type IdentityReader = (value: unknown) => IdentityValue | null;
function optionalIdentity(entries: IdentityEntry[], value: Record<string, unknown>, field: string, reader: IdentityReader): boolean {
  if (!Object.hasOwn(value, field)) { entries.push([field, 0]); return true; }
  const checked = reader(read(value, field));
  if (checked === null) return false;
  entries.push([field, 1, checked]); return true;
}
const finiteNonnegative: IdentityReader = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const safeNonnegative: IdentityReader = value => integer(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
const booleanIdentity: IdentityReader = value => typeof value === 'boolean' ? value : null;
const uuidIdentity: IdentityReader = value => uuid(value) ? value : null;
function rectIdentity(value: unknown): IdentityValue | null {
  if (!object(value) || Object.keys(value).length !== 4) return null;
  const x = read(value, 'x'), y = read(value, 'y'), width = read(value, 'width'), height = read(value, 'height');
  return integer(x, 0, Number.MAX_SAFE_INTEGER) && integer(y, 0, Number.MAX_SAFE_INTEGER) &&
    integer(width, 2, Number.MAX_SAFE_INTEGER) && integer(height, 2, Number.MAX_SAFE_INTEGER) ? [x, y, width, height] : null;
}

/** Fixed fields and bounded primitive values only. Explicit absence is distinct
 * from every supplied value. No paths, bytes, arbitrary objects or JSON hooks
 * enter this token, and it never claims a fresh or authorized business record. */
function sourceIdentity(asset: Record<string, unknown>, clip: Record<string, unknown>, track: Track): string | null {
  const source: IdentityEntry[] = [], savedClip: IdentityEntry[] = [], savedTrack: IdentityEntry[] = [];
  if (!optionalIdentity(source, asset, 'sha256', value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null) ||
      !optionalIdentity(source, asset, 'mimeType', value => text(value, 200) ? value : null) ||
      !optionalIdentity(source, asset, 'name', value => text(value, 200) ? value : null)) return null;
  for (const field of ['width', 'height', 'sizeBytes']) if (!optionalIdentity(source, asset, field, safeNonnegative)) return null;
  if (!optionalIdentity(source, asset, 'duration', finiteNonnegative)) return null;
  for (const field of ['hasAudio', 'hasVideo']) if (!optionalIdentity(source, asset, field, booleanIdentity)) return null;
  for (const field of ['versionId', 'shotId', 'jobId']) if (!optionalIdentity(savedClip, clip, field, uuidIdentity)) return null;
  if (!optionalIdentity(savedClip, clip, 'name', value => text(value, 200) ? value : null) ||
      !optionalIdentity(savedClip, clip, 'rect', rectIdentity) ||
      !optionalIdentity(savedClip, clip, 'gain', value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2 ? value : null)) return null;
  for (const field of ['fadeInFrames', 'fadeOutFrames']) if (!optionalIdentity(savedClip, clip, field, value => integer(value, 0, MAX_FRAMES) ? value : null)) return null;
  if (!optionalIdentity(savedTrack, track.saved, 'kind', value => value === 'video' || value === 'audio' ? value : null)) return null;
  for (const field of ['hidden', 'muted']) if (!optionalIdentity(savedTrack, track.saved, field, booleanIdentity)) return null;
  return JSON.stringify([source, savedClip, [track.orderIndex, savedTrack]]);
}

/** Pure, narrow projection of the caller's saved snapshot. `ready` must describe
 * the complete project load; this function cannot establish transport freshness.
 * Missing/foreign/unresolved data is unknown, never evidence of zero use.
 * project.get has no asset-count cap: work is linear in the already-loaded
 * assets, reading two identity fields per row, plus at most 12 tracks/100 clips.
 * Only referenced assets receive the bounded source-identity projection; no
 * historical/draft/selected-version source is read. */
export function deriveTimelineAssetUsage({ projectId, assets, timeline, ready }: TimelineAssetUsageInput): UsageSnapshot {
  const unknown = (): UsageSnapshot => Object.freeze({ status: 'unknown', projectId, timelineId: null, timelineRevision: null, usesByAssetId: EMPTY_INDEX });
  if (ready !== true || !uuid(projectId) || !array(assets) || !object(timeline)) return unknown();
  const timelineId = read(timeline, 'id'), timelineRevision = read(timeline, 'revision');
  const tracks = read(timeline, 'tracks'), clips = read(timeline, 'clips'), durationFrames = read(timeline, 'durationFrames');
  if (!uuid(timelineId) || read(timeline, 'projectId') !== projectId || !integer(timelineRevision, 1, Number.MAX_SAFE_INTEGER) ||
      !array(tracks) || tracks.length < 1 || tracks.length > MAX_TRACKS || !array(clips) || clips.length > MAX_CLIPS ||
      !integer(durationFrames, 0, MAX_FRAMES)) return unknown();

  const assetIds = new Set<string>();
  const assetsById = new Map<string, Record<string, unknown>>();
  for (const asset of assets) {
    if (!object(asset)) return unknown();
    const assetId = read(asset, 'id');
    if (!uuid(assetId) || read(asset, 'projectId') !== projectId || assetIds.has(assetId)) return unknown();
    assetIds.add(assetId);
    assetsById.set(assetId, asset);
  }
  const tracksById = new Map<string, Track>();
  for (const track of tracks) {
    if (!object(track)) return unknown();
    const id = read(track, 'id'), name = read(track, 'name'), orderIndex = read(track, 'orderIndex');
    if (!uuid(id) || tracksById.has(id) || !text(name, 150) || !integer(orderIndex, 0, MAX_TRACKS - 1) ||
        !sameOptionalOwner(track, projectId, timelineId)) return unknown();
    tracksById.set(id, { id, name, orderIndex, saved: track, uses: [] });
  }

  const clipIds = new Set<string>();
  let observedDuration = 0;
  for (const clip of clips) {
    if (!object(clip)) return unknown();
    const clipId = read(clip, 'id'), assetId = read(clip, 'assetId'), trackId = read(clip, 'trackId');
    const name = read(clip, 'name'), startFrame = read(clip, 'startFrame'), duration = read(clip, 'durationFrames'), sourceInFrame = read(clip, 'sourceInFrame');
    if (!uuid(clipId) || clipIds.has(clipId) || !uuid(assetId) || !assetIds.has(assetId) || !uuid(trackId) ||
        (Object.hasOwn(clip, 'name') && !text(name, 200)) ||
        !integer(startFrame, 0, MAX_FRAMES) || !integer(duration, 1, MAX_FRAMES) || startFrame + duration > MAX_FRAMES ||
        !integer(sourceInFrame, 0, Number.MAX_SAFE_INTEGER - MAX_FRAMES) || !sameOptionalOwner(clip, projectId, timelineId)) return unknown();
    const track = tracksById.get(trackId);
    const source = assetsById.get(assetId);
    if (!track || !source) return unknown();
    const identity = sourceIdentity(source, clip, track);
    if (identity === null) return unknown();
    clipIds.add(clipId);
    observedDuration = Math.max(observedDuration, startFrame + duration);
    // Name text is preserved verbatim and rendered by React as text. Legacy
    // missing names receive a label without modifying the saved record.
    track.uses.push(Object.freeze({ projectId, timelineId, timelineRevision, assetId, clipId, trackId,
      clipName: typeof name === 'string' ? name : '未命名片段', trackName: track.name, startFrame, durationFrames: duration, sourceInFrame, sourceIdentity: identity }));
  }
  if (observedDuration !== durationFrames) return unknown();

  const usesByAssetId: Record<string, readonly TimelineAssetUse[]> = {};
  const mutableUses = new Map<string, TimelineAssetUse[]>();
  for (const assetId of assetIds) usesByAssetId[assetId] = EMPTY_USES;
  const orderedTracks = [...tracksById.values()].sort((left, right) => left.orderIndex - right.orderIndex || compareId(left.id, right.id));
  for (const track of orderedTracks) {
    track.uses.sort((left, right) => left.startFrame - right.startFrame || compareId(left.clipId, right.clipId));
    let previousEnd = 0;
    for (const use of track.uses) {
      if (use.startFrame < previousEnd) return unknown();
      previousEnd = use.startFrame + use.durationFrames;
      const existing = mutableUses.get(use.assetId);
      if (existing) existing.push(use); else mutableUses.set(use.assetId, [use]);
    }
  }
  for (const [assetId, uses] of mutableUses) usesByAssetId[assetId] = Object.freeze(uses);
  return Object.freeze({ status: 'ready', projectId, timelineId, timelineRevision, usesByAssetId: Object.freeze(usesByAssetId) });
}

function sameUse(left: TimelineAssetUse, right: TimelineAssetUse): boolean {
  return left.projectId === right.projectId && left.timelineId === right.timelineId && left.timelineRevision === right.timelineRevision &&
    left.assetId === right.assetId && left.clipId === right.clipId && left.trackId === right.trackId &&
    left.clipName === right.clipName && left.trackName === right.trackName && left.startFrame === right.startFrame &&
    left.durationFrames === right.durationFrames && left.sourceInFrame === right.sourceInFrame && left.sourceIdentity === right.sourceIdentity;
}

/** Preserve UI ownership across a semantically identical saved-project poll.
 * Every displayed location and source fence participates; raw source objects
 * are neither retained nor serialized. Changed or newly unknown data wins. */
export function retainTimelineAssetUsage(previous: UsageSnapshot | null, next: UsageSnapshot): UsageSnapshot {
  if (previous === null || previous.status !== next.status || previous.projectId !== next.projectId ||
      previous.timelineId !== next.timelineId || previous.timelineRevision !== next.timelineRevision) return next;
  if (previous === next) return previous;
  const assetIds = Object.keys(previous.usesByAssetId);
  if (assetIds.length !== Object.keys(next.usesByAssetId).length) return next;
  for (const assetId of assetIds) {
    if (!Object.hasOwn(next.usesByAssetId, assetId)) return next;
    const before = previous.usesByAssetId[assetId], after = next.usesByAssetId[assetId];
    if (before.length !== after.length || !before.every((use, index) => {
      const candidate = after[index];
      return candidate !== undefined && sameUse(use, candidate);
    })) return next;
  }
  return previous;
}

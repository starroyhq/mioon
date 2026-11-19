/** Bounded format-5 sequence inspection for Mio/MT (read-only).
 *
 * One snapshot id binds the page cursor. The chain order comes from the saved
 * main-track groups; board-selected versions are separate evidence from the
 * version actually applied to a clip. No write, plan or media access happens
 * here.
 */
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {SequenceInspectionDiff, SequenceInspectionPage, SequenceInspectionSegment} from '../../contracts/src/sequence-inspection.ts';

type Row = Record<string, any>;
const format5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const badCursor = (): never => {throw new AppError('INVALID_CURSOR', '游标无效或快照已变化。', 400);};
const invalid = (): never => {throw new AppError('VALIDATION_ERROR', '检查参数无效。', 400);};

export function createSequenceInspectionService(store: ProjectStore): {handlers: Readonly<Record<string, (input: unknown) => unknown>>; drain: () => Promise<void>} {
  const secret = randomBytes(32);
  const sign = (text: string): string => createHmac('sha256', secret).update(text).digest('base64url');
  function read(input: unknown): SequenceInspectionPage {
    if (!format5(store)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
    const args = (input ?? {}) as Row;
    if (args.projectId !== store.projectId) invalid();
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid();
    let after = 0;
    let cursorSnapshot = null as string | null;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || args.cursor.length > 512) badCursor();
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(args.cursor);
      if (!match) badCursor();
      const body = match![1]!, signature = match![2]!;
      const expected = sign(body);
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) badCursor();
      let decoded: unknown;
      try {decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));} catch {badCursor();}
      const parsed = decoded as unknown[];
      if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 1 || typeof parsed[1] !== 'string' || !Number.isSafeInteger(parsed[2]) || (parsed[2] as number) < 1) badCursor();
      cursorSnapshot = parsed[1] as string;
      after = parsed[2] as number;
    }
    const timeline = readFormat5TimelineRecord(store.db, 'project');
    if (!timeline) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
    const sync = store.db.prepare('SELECT revision,baseline FROM project.sequence_sync_state').get() as Row | undefined;
    if (!sync) throw new AppError('PROJECT_INVALID', '时间线没有绑定顺序根。', 422, {database: 'project', reason: 'metadata'});
    const content = readProjectContentStamp(store.db).contentSequence;
    const mainTrackId = timeline.mainTrack.trackId;
    const mainClips = timeline.clips.filter(clip => clip.trackId === mainTrackId)
      .slice().sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
    const nodes = new Map((store.db.prepare('SELECT id,data FROM project.nodes').all() as Row[])
      .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
    const shots = new Map((store.db.prepare('SELECT id,data FROM project.shots').all() as Row[])
      .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
    const versions = new Map((store.db.prepare('SELECT id,data FROM project.versions').all() as Row[])
      .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
    const groups = new Map<string, typeof mainClips>();
    for (const clip of mainClips) {
      const key = String((clip as Row).sequenceSource?.segmentGroupId ?? '');
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), clip]);
    }
    const chain = [...groups.values()];
    const chainNodeIds = chain.map(group => String((group[0] as Row).sequenceSource?.nodeId ?? ''));
    const freeNodeIds = [...nodes.keys()].filter(nodeId => nodeId !== timeline.mainTrack.sequenceNodeId && !chainNodeIds.includes(nodeId)
      && !shots.has(nodeId)).sort();
    const snapshotId = hash({contentRevision: content, timelineRevision: timeline.revision,
      syncRevision: Number(sync.revision), chain: chain.map(group => group.map(clip => [clip.id, clip.startFrame, clip.durationFrames, (clip as Row).versionId]))});
    if (cursorSnapshot !== null && cursorSnapshot !== snapshotId) badCursor();
    const baseline = (typeof sync.baseline === 'string' ? JSON.parse(sync.baseline) : sync.baseline ?? {}) as Row;
    const boardBaseline = new Map<string, Row>((Array.isArray(baseline.board) ? baseline.board : [])
      .map((entry: Row) => [String(entry.nodeId), entry]));
    const clipBaseline = new Map<string, Row>((Array.isArray(baseline.track) ? baseline.track : [])
      .map((entry: Row) => [String(entry.clipId), entry]));
    const differences: SequenceInspectionDiff[] = [];
    const segments: SequenceInspectionSegment[] = [];
    chain.forEach((group, index) => {
      const first = group[0] as Row;
      const source = first.sequenceSource ?? {};
      const nodeId = String(source.nodeId);
      const shot = shots.get(nodeId);
      const kind: SequenceInspectionSegment['kind'] = shots.has(nodeId) ? 'shot'
        : (nodes.get(nodeId)?.type === 'image' ? 'image' : nodes.get(nodeId)?.type === 'text' ? 'text' : 'video');
      const selected = typeof shot?.selectedVersionId === 'string' ? shot.selectedVersionId : null;
      const base = boardBaseline.get(nodeId);
      if (base && (base.selectedVersionId ?? null) !== selected) differences.push({kind: 'board', id: nodeId, reason: 'selected_version_changed'});
      const clips = group.map(clip => {
        const applied = typeof clip.versionId === 'string' ? clip.versionId : null;
        const version = applied ? versions.get(applied) : undefined;
        const clipBase = clipBaseline.get(clip.id);
        if (!clipBase) differences.push({kind: 'track', id: clip.id, reason: 'new_clip'});
        else if ((clipBase.appliedVersionId ?? null) !== applied) differences.push({kind: 'track', id: clip.id, reason: 'applied_version_changed'});
        const anchor = (clip as Row).anchor;
        return {id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
          sourceInFrame: clip.sourceInFrame, sourceState: (clip as Row).sourceState === 'placeholder' ? 'placeholder' as const : 'ready' as const,
          ...(source.versionMode === 'locked' ? {versionMode: 'locked' as const} : source.versionMode === 'follow' ? {versionMode: 'follow' as const} : {}),
          appliedVersionId: applied, boardVersionId: selected,
          ...(anchor ? {anchor: {clipId: String(anchor.clipId), offsetFrames: Number(anchor.offsetFrames)}} : {}),
          ...(version ? {} : {})};
      });
      const inSync = !differences.some(diff => diff.id === nodeId || clips.some(clip => diff.id === clip.id));
      segments.push({nodeId, kind, order: index, groupIds: [...new Set(group.map(clip => String((clip as Row).sequenceSource?.segmentGroupId)))],
        clipIds: group.map(clip => clip.id), startFrame: first.startFrame,
        durationFrames: group.reduce((sum, clip) => sum + clip.durationFrames, 0), clips, inSync});
    });
    const filtered = segments.filter(segment => segment.order >= after);
    const items = filtered.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = last && chain.length > last.order + 1
      ? `${Buffer.from(JSON.stringify([1, snapshotId, last.order + 1])).toString('base64url')}.${sign(Buffer.from(JSON.stringify([1, snapshotId, last.order + 1])).toString('base64url'))}`
      : null;
    return {projectId: store.projectId, rootNodeId: timeline.mainTrack.sequenceNodeId, snapshotId, contentRevision: content,
      timelineRevision: timeline.revision, syncRevision: Number(sync.revision), total: chain.length, items,
      differences: differences.slice(0, 200), freeNodeIds: freeNodeIds.slice(0, 200), nextCursor};
  }
  return {handlers: Object.freeze({'sequence.inspect': (input: unknown) => read(input)}), drain: async () => {}};
}

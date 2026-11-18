/** Real format-5 chain fixtures for the CS board transaction tests. */
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {format5SyncBaselineSchema} from '../../packages/contracts/src/project-format5.ts';
import type {Format5Clip, Format5SyncBaseline, Format5Timeline} from '../../packages/contracts/src/project-format5.ts';
import {sourceFrameCount} from '../../packages/contracts/src/source-range.ts';

type Row = Record<string, unknown>;
const at = '2026-01-01T00:00:00.000Z';
const uuid = (): string => randomUUID();
const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Format-5 world
// ---------------------------------------------------------------------------

export interface VersionFixture {
  readonly versionId: string;
  readonly assetId: string;
  readonly sha256: string;
  readonly durationSeconds: number;
  /** Owner shot for a version that is not the owner's selected version. */
  readonly shotId?: string;
}
export interface ChainWorld {
  readonly store: ProjectStore;
  readonly projectId: string;
  readonly rootId: string;
  readonly timelineId: string;
  readonly mainTrackId: string;
  readonly shots: Map<string, Row>;
  readonly nodes: Map<string, Row>;
  readonly versions: Map<string, Row>;
  readonly assets: Map<string, Row>;
  readonly timeline: Format5Timeline;
  readonly baseline: Format5SyncBaseline;
}
export interface ChainWorldSpec {
  readonly shots: readonly {readonly id: string; readonly title?: string; readonly versionId?: string | null}[];
  readonly versions?: readonly VersionFixture[];
  readonly nodes?: readonly {readonly id: string; readonly type: string; readonly name?: string; readonly assetId?: string | null}[];
  readonly clips: readonly {readonly nodeId: string; readonly clipId: string; readonly startFrame: number;
    readonly durationFrames: number; readonly versionId?: string | null; readonly locked?: boolean; readonly splitGroupId?: string}[];
  readonly edges: readonly {readonly id: string; readonly fromId: string; readonly toId: string}[];
  readonly archived?: readonly {readonly table: 'shots' | 'nodes'; readonly id: string}[];
  readonly rootId?: string;
  readonly timelineId?: string;
  readonly mainTrackId?: string;
}

function clipRecord(world: {readonly shots: ReadonlyMap<string, Row>; readonly nodes: ReadonlyMap<string, Row>;
  readonly versions: ReadonlyMap<string, Row>; readonly assets: ReadonlyMap<string, Row>}, mainTrackId: string,
  clip: ChainWorldSpec['clips'][number]): Format5Clip {
  const shot = world.shots.get(clip.nodeId);
  const node = world.nodes.get(clip.nodeId);
  const segmentGroupId = clip.splitGroupId ?? clip.clipId;
  const base: Format5Clip = {id: clip.clipId, trackId: mainTrackId,
    name: typeof shot?.title === 'string' ? shot.title : 'Clip',
    startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
    sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: 'follow'}};
  if (shot) {
    const versionId = typeof clip.versionId === 'string' ? clip.versionId : typeof shot.selectedVersionId === 'string' ? shot.selectedVersionId : null;
    if (versionId === null) return base;
    const version = world.versions.get(versionId);
    if (!version || typeof version.assetId !== 'string') throw new TypeError('Fixture version is missing');
    return {...base, assetId: version.assetId, versionId, jobId: typeof version.jobId === 'string' ? version.jobId : null,
      shotId: clip.nodeId, sourceState: 'ready',
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: clip.locked ? 'locked' : 'follow'}};
  }
  if (!node) throw new TypeError(`Fixture node ${clip.nodeId} is missing`);
  const assetId = typeof node.assetId === 'string' ? node.assetId : null;
  if (assetId === null) return base;
  const asset = world.assets.get(assetId);
  void sourceFrameCount(asset?.duration);
  return {...base, assetId, sourceState: 'ready',
    sequenceSource: {kind: 'media', nodeId: clip.nodeId, segmentGroupId}};
}

function baselineFrom(timeline: Format5Timeline, shots: ReadonlyMap<string, Row>, nodes: ReadonlyMap<string, Row>,
  mainTrackId: string, shotVersions: ReadonlyMap<string, string | null> = new Map()): Format5SyncBaseline {
  const chain: string[] = [];
  for (const clip of timeline.clips) {
    if (clip.trackId !== mainTrackId) continue;
    const nodeId = clip.sequenceSource?.nodeId;
    if (typeof nodeId === 'string' && chain.at(-1) !== nodeId) chain.push(nodeId);
  }
  const board = chain.map(nodeId => {
    const shot = shots.get(nodeId);
    if (shot) {
      const selected = shotVersions.has(nodeId) ? shotVersions.get(nodeId) : shot.selectedVersionId;
      return {nodeId, kind: 'shot' as const, selectedVersionId: typeof selected === 'string' ? selected : null};
    }
    const node = nodes.get(nodeId);
    const assetId = typeof node?.assetId === 'string' ? node.assetId : '00000000-0000-4000-8000-000000000000';
    return {nodeId, kind: 'media' as const, assetId};
  });
  const track = timeline.clips.filter(clip => clip.trackId === mainTrackId).map(clip => {
    const source = clip.sequenceSource!;
    if (source.kind === 'shot') return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id,
      kind: 'shot' as const, versionMode: source.versionMode, appliedVersionId: clip.versionId ?? null};
    return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id, kind: 'media' as const,
      assetId: clip.assetId ?? '00000000-0000-4000-8000-000000000000'};
  });
  const parsed = format5SyncBaselineSchema.safeParse({version: 1 as const, board, track});
  if (!parsed.success) throw new TypeError(`Invalid fixture baseline: ${parsed.error.message}`);
  return parsed.data;
}

export function createChainWorld(t: test.TestContext, spec: ChainWorldSpec): ChainWorld {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-sequence-edit-'));
  const projectId = uuid(), rootId = spec.rootId ?? uuid(), timelineId = spec.timelineId ?? uuid(), mainTrackId = spec.mainTrackId ?? uuid();
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const shots = new Map<string, Row>(), nodes = new Map<string, Row>(), versions = new Map<string, Row>(), assets = new Map<string, Row>();
  for (const fixture of spec.versions ?? []) {
    assets.set(fixture.assetId, {id: fixture.assetId, projectId, mimeType: 'video/mp4', duration: fixture.durationSeconds,
      sha256: fixture.sha256, name: 'source.mp4'});
    versions.set(fixture.versionId, {id: fixture.versionId, projectId, shotId: fixture.shotId ?? '', jobId: uuid(),
      assetId: fixture.assetId, sha256: fixture.sha256, number: 1, createdAt: at});
  }
  for (const shot of spec.shots) {
    const version = typeof shot.versionId === 'string' ? versions.get(shot.versionId) : undefined;
    shots.set(shot.id, {id: shot.id, projectId, title: shot.title ?? 'Shot', orderIndex: 0, duration: 2,
      selectedVersionId: typeof shot.versionId === 'string' ? shot.versionId : null, createdAt: at, updatedAt: at});
    if (version) version.shotId = shot.id;
  }
  for (const node of spec.nodes ?? []) {
    nodes.set(node.id, {id: node.id, projectId, type: node.type, name: node.name ?? 'Node', position: {x: 0, y: 0},
      ...(node.assetId !== undefined ? {assetId: node.assetId} : {}), createdAt: at});
  }
  const timelineBase = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 0, createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
    tracks: [{id: mainTrackId, name: 'V1', kind: 'video' as const, orderIndex: 0, hidden: false, muted: false}]};
  const clipWorld = {projectId, shots, nodes, versions, assets};
  const clips = spec.clips.map(clip => clipRecord(clipWorld, mainTrackId, clip));
  const durationFrames = clips.reduce((maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames), 0);
  const timeline: Format5Timeline = {...timelineBase, durationFrames, clips};
  const archived = new Set((spec.archived ?? []).map(item => `${item.table}:${item.id}`));
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic chain', revision: 1, createdAt: at, updatedAt: at});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    for (const row of nodes.values()) store.put('nodes', row);
    for (const row of versions.values()) store.put('versions', row);
    for (const row of assets.values()) store.put('assets', row);
    for (const row of shots.values()) store.put('shots', row);
    for (const row of shots.values()) if (archived.has(`shots:${row.id}`))
      store.db.prepare('UPDATE project.shots SET archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=?')
        .run(at, uuid(), 'user-delete', String(row.id));
    for (const row of nodes.values()) if (archived.has(`nodes:${row.id}`))
      store.db.prepare('UPDATE project.nodes SET archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=?')
        .run(at, uuid(), 'user-delete', String(row.id));
    for (const edge of spec.edges) store.put('edges', {id: edge.id, projectId, source: edge.fromId, target: edge.toId, kind: 'sequence', createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baselineFrom(timeline, shots, nodes, mainTrackId)));
  });
  const baseline = baselineFrom(timeline, shots, nodes, mainTrackId);
  return {store, projectId, rootId, timelineId, mainTrackId, shots, nodes, versions, assets, timeline, baseline};
}

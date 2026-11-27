/** Format-5 persisted rows -> the UI-B1 presentation projection.
 *
 * This module is intentionally read-only and React-free: the workbench, the
 * real-RPC headless fixture and the projection tests all build the same board
 * from `project.get` rows. No command, history or write path lives here.
 */
import {deriveFilmChains} from '../../../../packages/contracts/src/board-sequence.ts';
import type {ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';
import {layoutCanvas} from '../../../../packages/contracts/src/canvas-tidy-layout.ts';
import type {CanvasLayoutNode, CanvasLayoutShot} from '../../../../packages/contracts/src/canvas-tidy-layout.ts';
import type {SequenceEditIntent, SubjectBindingOperation, SubjectCardOperation, SubjectEditOperation} from '../../../../packages/contracts/src/sequence-edit.ts';
import {projectBoardUi} from './projection.ts';
import type {BoardGenerationStatus, BoardUiNode, BoardUiProjection} from './projection.ts';
import type {BoardUiEdge} from './BoardUiStatic.tsx';
import type {BoardPortId} from './connection-ports.ts';

type Row = Record<string, any>;
export interface BoardLiveSubject {
  readonly id: string; readonly name: string; readonly kind: 'character' | 'product' | 'location' | 'look';
  readonly headVersionId: string; readonly headAssetId: string;
}
export interface BoardLiveInput {
  readonly shots: readonly Row[];
  readonly nodes: readonly Row[];
  readonly edges: readonly Row[];
  readonly versions?: readonly Row[];
  readonly assets?: readonly Row[];
  readonly jobs?: readonly Row[];
  /** Saved timeline clips; supplies a chain node's length when no applied version explains it. */
  readonly clips?: readonly Row[];
  readonly subjects?: readonly BoardLiveSubject[];
  /** Project frame ratio, used only for the film-root card. */
  readonly frameAspect?: string | null;
  /** Readable media thumbnail for one asset, or null when the media is absent. */
  readonly thumbnailFor?: (assetId: string) => string | null;
  /** Localized fallback name for unnamed board nodes. */
  readonly unnamedLabel?: string;
}
export interface BoardLive {
  readonly nodes: readonly BoardUiNode[];
  readonly edges: readonly BoardUiEdge[];
  readonly positions: Readonly<Record<string, {readonly x: number; readonly y: number}>>;
  readonly projection: BoardUiProjection;
}

const ACTIVE_JOB = new Set(['queued', 'submitting', 'running', 'downloading']);
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const point = (value: unknown): {x: number; y: number} | null => {
  const row = record(value);
  return row && Number.isFinite(row.x) && Number.isFinite(row.y) ? {x: Number(row.x), y: Number(row.y)} : null;
};
const NODE_KINDS: Readonly<Record<string, BoardUiNode['kind'] | undefined>> = {
  sequence_root: 'film', subject_card: 'subject', image: 'image', video: 'video', audio: 'audio', text: 'text', previs: 'previs',
};

/** Shot duration follows the applied version's source length; a selected but
 * unreadable version still reports the shot's declared duration. */
export function shotDurationFrames(shot: Row, versions: readonly Row[], assets: readonly Row[],
  clipFrames: number | null = null): number | null {
  // The board film chain is synced to the timeline: the applied clip's trimmed
  // length wins over the version's original asset length. Only a shot without a
  // timeline clip falls back to the immutable version, then the declared shot.
  if (clipFrames !== null) return clipFrames;
  const selected = text(shot.selectedVersionId) ? versions.find(version => version.id === shot.selectedVersionId) : undefined;
  const asset = selected && text(selected.assetId) ? assets.find(item => item.id === selected.assetId) : undefined;
  if (asset && Number.isFinite(asset.duration) && Number(asset.duration) > 0) return Math.round(Number(asset.duration) * 30);
  if (Number.isFinite(shot.duration) && Number(shot.duration) > 0) return Math.round(Number(shot.duration) * 30);
  return null;
}
function shotJobsNewestFirst(shotId: unknown, jobs: readonly Row[]): Row[] {
  return jobs
    .filter(job => job.shotId === shotId)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
}
export function shotStatus(shot: Row, versions: readonly Row[], jobs: readonly Row[]): BoardGenerationStatus {
  const shotJobs = shotJobsNewestFirst(shot.id, jobs);
  if (shotJobs.some(job => ACTIVE_JOB.has(String(job.status)))) return 'generating';
  const selected = text(shot.selectedVersionId) ? versions.find(version => version.id === shot.selectedVersionId) : undefined;
  const latest = shotJobs[0];
  if (latest?.status === 'failed' && (!selected || !selected.createdAt || !latest.createdAt || String(latest.createdAt) >= String(selected.createdAt))) {
    return 'failed';
  }
  return selected ? 'ready' : 'pending';
}

const DEFAULT_BOARD_CARD_SIZES: Readonly<Record<BoardUiNode['kind'], {readonly width: number; readonly height: number}>> = {
  film: {width: 148, height: 64},
  shot: {width: 240, height: 205},
  image: {width: 180, height: 172},
  video: {width: 180, height: 172},
  previs: {width: 180, height: 172},
  subject: {width: 160, height: 140},
  audio: {width: 160, height: 140},
  text: {width: 200, height: 100},
};

/** Plan one deterministic tidy pass across the live format-5 board. Film roots
 * and chain members lead the story row while references gather above their
 * linked shots and floating items stay grouped below. */
export function computeBoardTidyMoves(
  board: BoardLive,
  measuredSizes?: Readonly<Record<string, {readonly width: number; readonly height: number}>>,
  selectedIds?: ReadonlySet<string>,
): readonly {readonly nodeId: string; readonly x: number; readonly y: number}[] {
  const chainOrder = new Map<string, number>();
  let cursor = 0;
  for (const film of board.projection.films) {
    chainOrder.set(film.id, cursor++);
    for (const item of film.items) {
      if (!chainOrder.has(item.nodeId)) chainOrder.set(item.nodeId, cursor++);
    }
  }
  const shots: CanvasLayoutShot[] = [];
  const nodes: CanvasLayoutNode[] = [];
  board.nodes.forEach((item, index) => {
    const position = board.positions[item.id] ?? {x: (index % 4) * 290, y: Math.floor(index / 4) * 280};
    const measured = measuredSizes?.[item.id];
    const fallback = DEFAULT_BOARD_CARD_SIZES[item.kind];
    const width = measured && Number.isFinite(measured.width) && measured.width > 0 ? measured.width : fallback.width;
    const height = measured && Number.isFinite(measured.height) && measured.height > 0 ? measured.height : fallback.height;
    const order = chainOrder.get(item.id);
    if (order !== undefined) shots.push({id: item.id, orderIndex: order, position, width, height});
    else if (item.kind === 'shot') shots.push({id: item.id, orderIndex: cursor++, position, width, height});
    else nodes.push({id: item.id, type: item.kind, position, width, height});
  });
  const result = layoutCanvas({
    shots,
    nodes,
    edges: board.edges.map(edge => ({source: edge.sourceId, target: edge.targetId, kind: edge.kind, role: edge.role})),
    ...(selectedIds?.size ? {selectedIds} : {}),
  });
  if (result.status !== 'moved') return [];
  return result.moves.map(move => ({nodeId: move.id, x: Math.round(move.position.x), y: Math.round(move.position.y)}));
}

/** Build the same UI-B1 cards/edges the static fixture uses, from persisted rows. */
export function projectLiveBoard(input: BoardLiveInput): BoardLive {
  const versions = input.versions ?? [], assets = input.assets ?? [], jobs = input.jobs ?? [], clips = input.clips ?? [];
  const subjectRows = new Map((input.subjects ?? []).map(subject => [subject.id, subject]));
  const clipDuration = (nodeId: string): number | null => {
    let frames = 0;
    for (const clip of clips) {
      const source = record(clip.sequenceSource);
      if (source?.nodeId !== nodeId || !Number.isFinite(clip.durationFrames) || Number(clip.durationFrames) <= 0) continue;
      frames += Number(clip.durationFrames);
    }
    return frames > 0 ? frames : null;
  };
  const assetThumb = (assetId: unknown): string | null => typeof assetId === 'string' && input.thumbnailFor
    ? input.thumbnailFor(assetId) : null;
  const assetThumbKind = (assetId: unknown): 'image' | 'video' | undefined => {
    const asset = typeof assetId === 'string' ? assets.find(item => item.id === assetId) : undefined;
    return typeof asset?.mimeType === 'string' && asset.mimeType.startsWith('video/') ? 'video' : asset ? 'image' : undefined;
  };
  const nodes: BoardUiNode[] = [];
  const positions: Record<string, {x: number; y: number}> = {};
  const seen = new Set<string>();
  for (const shot of input.shots) {
    const id = text(shot.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const selected = text(shot.selectedVersionId) ? versions.find(version => version.id === shot.selectedVersionId) : undefined;
    const shotVersions = versions.filter(version => version.shotId === id);
    const activeJob = shotJobsNewestFirst(id, jobs).find(job => ACTIVE_JOB.has(String(job.status)));
    const progress = activeJob && activeJob.progress !== undefined && activeJob.progress !== null && Number.isFinite(Number(activeJob.progress))
      ? Math.max(0, Math.min(100, Math.round(Number(activeJob.progress)))) : null;
    nodes.push({id, kind: 'shot', name: text(shot.title) ?? 'Shot',
      aspectRatio: text(shot.aspectRatio), durationFrames: shotDurationFrames(shot, versions, assets, clipDuration(id)),
      status: shotStatus(shot, versions, jobs), versionCount: shotVersions.length,
      ...(progress !== null ? {generationProgress: progress} : {}),
      thumbnailUrl: assetThumb(selected?.assetId),
      thumbnailKind: assetThumbKind(selected?.assetId)});
    const position = point(shot.position);
    if (position) positions[id] = position;
  }
  for (const node of input.nodes) {
    const id = text(node.id);
    const kind = text(node.type) ? NODE_KINDS[String(node.type)] : undefined;
    if (!id || !kind || seen.has(id)) continue;
    seen.add(id);
    const subject = kind === 'subject' && text(node.subjectId) ? subjectRows.get(String(node.subjectId)) : undefined;
    const unnamed = input.unnamedLabel ?? 'Untitled';
    const name = subject?.name ?? (kind === 'text' ? text(node.text) : null) ?? text(node.name) ?? text(node.label) ?? text(node.text)
      ?? unnamed;
    nodes.push({id, kind, name,
      ...(kind === 'film' ? {aspectRatio: input.frameAspect ?? null} : {}),
      ...(kind === 'shot' ? {} : {durationFrames: clipDuration(id)}),
      ...(kind === 'subject' && subject ? {subjectId: subject.id, subjectKind: subject.kind} : {}),
      thumbnailUrl: kind === 'subject' ? assetThumb(subject?.headAssetId) :
        kind === 'image' || kind === 'video' || kind === 'previs' ? assetThumb(node.assetId) : null,
      thumbnailKind: kind === 'subject' ? 'image' :
        kind === 'image' || kind === 'video' || kind === 'previs' ? assetThumbKind(node.assetId) : undefined});
    const position = point(node.position);
    if (position) positions[id] = position;
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges: BoardUiEdge[] = [];
  for (const edge of input.edges) {
    const sourceId = text(edge.source), targetId = text(edge.target);
    if (!sourceId || !targetId || !byId.has(sourceId) || !byId.has(targetId)) continue;
    const id = text(edge.id) ?? `${edge.kind}:${sourceId}>${targetId}`;
    if (edge.kind === 'sequence') edges.push({id, kind: 'sequence', sourceId, targetId});
    else if (edge.kind === 'reference') edges.push({id, kind: 'reference', sourceId, targetId,
      ...(text(edge.role) ? {role: String(edge.role) as ChainReferenceRole} : {}),
      ...(text(edge.sourceAssetId) ? {sourceAssetId: String(edge.sourceAssetId)} : {}),
      ...(text(edge.subjectBindingId) ? {subjectBindingId: String(edge.subjectBindingId)} : {}),
      ...(text(edge.sourceHandle) ? {sourcePort: String(edge.sourceHandle) as BoardPortId} : {}),
      ...(text(edge.targetHandle) ? {targetPort: String(edge.targetHandle) as BoardPortId} : {})});
  }
  const derivation = deriveFilmChains({nodes: nodes.map(node => ({id: node.id, kind: node.kind})),
    edges: edges.filter(edge => edge.kind === 'sequence').map(edge => ({fromId: edge.sourceId, toId: edge.targetId}))});
  const projection = projectBoardUi(derivation, nodes,
    edges.filter(edge => edge.kind === 'reference').map(edge => ({sourceId: edge.sourceId, targetId: edge.targetId})));
  return {nodes, edges, positions, projection};
}

// ---------------------------------------------------------------------------
// Command identity helpers (UI-B2 supplies ids; the service preview allocates
// any clip/edge identities the plan needs and returns them in the envelope).
// ---------------------------------------------------------------------------

export const boardConnectIntent = (fromId: string, toId: string): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId, toId}}});
export const boardDisconnectIntent = (fromId: string, toId: string): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId, toId}}});
export const boardInsertIntent = (fromId: string, toId: string, nodeId: string): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board', edit: {kind: 'insert', fromId, toId, nodeId}}});
export const boardDeleteIntent = (nodeId: string): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board', edit: {kind: 'delete', nodeId}}});
export const boardVersionIntent = (nodeId: string, versionId: string | null): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board-version', nodeId, version: versionId === null ? null : {id: versionId, sourceFrames: null}}});
export const boardLayoutIntent = (moves: readonly {readonly nodeId: string; readonly x: number; readonly y: number}[]): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.layout.move', moves: moves.map(move => ({nodeId: move.nodeId, x: move.x, y: move.y}))}});
export const boardRootCreateIntent = (nodeId: string, name: string, position: {x: number; y: number}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.root.create', nodeId, name, position: {x: position.x, y: position.y}}});
export const boardShotAppendIntent = (nodeId: string, name: string, position?: {x: number; y: number}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.shot.append', nodeId, name,
    ...(position ? {position: {x: position.x, y: position.y}} : {})}});
export const boardRestoreIntent = (items: readonly {readonly kind: 'shot' | 'node'; readonly id: string}[]): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.restore', items: items.map(item => ({kind: item.kind, id: item.id}))}});
export const boardDuplicateIntent = (items: readonly {readonly kind: 'shot' | 'node'; readonly id: string}[],
  viewport: {x: number; y: number; width: number; height: number}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.duplicate', items: items.map(item => ({kind: item.kind, id: item.id})),
    viewport: {...viewport}}});
export const boardNodeCreateIntent = (nodeId: string, type: 'image' | 'video' | 'audio' | 'text', name: string,
  position: {x: number; y: number}, fields: {assetId?: string; text?: string} = {}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.node.create', nodeId, nodeType: type, name, position: {...position},
    ...(fields.assetId === undefined ? {} : {assetId: fields.assetId}),
    ...(fields.text === undefined ? {} : {text: fields.text})}});
export const boardShotUpdateIntent = (shotId: string, expectedRevision: number,
  patch: {title?: string; prompt?: string; duration?: number; aspectRatio?: string;
    position?: {x: number; y: number}}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.shot.update', shotId, expectedRevision, patch: {...patch}}});
export const boardNodeUpdateIntent = (nodeId: string, expectedRevision: number,
  patch: {name?: string; text?: string; position?: {x: number; y: number}}): SequenceEditIntent =>
  ({side: 'board', operation: {kind: 'board.node.update', nodeId, expectedRevision, patch: {...patch}}});
export const boardNodeKey = (id: string): string => id;


// ---------------------------------------------------------------------------
// SB-b subject-card and binding intents
// ---------------------------------------------------------------------------
export const subjectCardCreateOperation = (nodeId: string, subjectId: string, position: {x: number; y: number}): SubjectCardOperation =>
  ({kind: 'subject.card.create', nodeId, subjectId, position: {x: position.x, y: position.y}});
export const subjectCardDeleteOperation = (nodeId: string): SubjectCardOperation =>
  ({kind: 'subject.card.delete', nodeId});

export interface SubjectBindable {
  readonly bindingId: string; readonly shotId: string; readonly subjectId: string; readonly role: 'subject' | 'style';
  readonly bindingMode: 'follow' | 'locked' | 'detached'; readonly subjectVersionId: string | null;
}
export const subjectBindingCreateOperation = (bindingId: string, shotId: string, subjectId: string,
  role: 'subject' | 'style'): SubjectEditOperation => ({kind: 'subject-binding',
    edit: {kind: 'create', bindingId, shotId, subjectId, role}});
export const subjectBindingModeOperation = (bindingId: string, mode: 'follow' | 'locked',
  subjectVersionId: string | null): SubjectEditOperation => ({kind: 'subject-binding',
    edit: {kind: 'set-mode', bindingId, bindingMode: mode, subjectVersionId}});
export const subjectBindingDetachOperation = (bindingId: string): SubjectEditOperation =>
  ({kind: 'subject-binding', edit: {kind: 'detach', bindingId}});
export const subjectBindingRestoreOperation = (bindingId: string, mode: 'follow' | 'locked',
  subjectVersionId: string | null): SubjectEditOperation => ({kind: 'subject-binding',
    edit: {kind: 'restore', bindingId, bindingMode: mode, subjectVersionId}});
export type {SubjectBindingOperation, SubjectCardOperation, SubjectEditOperation};

import {sourceFrameCount} from '../../../contracts/src/source-range.ts';
import {clipTransitionFits} from '../../../contracts/src/timeline-clip-transition.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '../../../contracts/src/timeline-subtitle-profile.ts';
import {assertFormat5Timeline, format5SyncBaselineSchema} from '../../../contracts/src/project-format5.ts';
import type {Format5Anchor, Format5SequenceSource} from '../../../contracts/src/project-format5.ts';
import {validateFormat5SequenceGraph} from './format5-sequence-mapping.ts';

/** The caller reads these rows on the locked source connection. Archive
 * identities stay separate because archive columns are absent from row JSON. */
export interface Format5LegacyShot extends Record<string, unknown> {
  id: string; projectId: string; orderIndex: number; duration: number;
  selectedVersionId: string | null; title?: string;
}
export interface Format5LegacyNode extends Record<string, unknown> {
  id: string; projectId: string; type: string; assetId?: string | null;
}
export interface Format5LegacyEdge extends Record<string, unknown> {
  id: string; projectId: string; source: string; target: string;
  kind?: string; role?: string; sourceAssetId?: string;
}
export interface Format5LegacyVersion extends Record<string, unknown> {
  id: string; projectId: string; shotId: string; assetId: string; sha256: string; jobId?: string;
}
export interface Format5ConversionAsset extends Record<string, unknown> {
  id: string; projectId: string; mimeType: string; sha256: string | null;
  duration?: number | null;
}
export interface Format5LegacyClip extends Record<string, unknown> {
  id: string; trackId: string; assetId: string; startFrame: number; durationFrames: number; sourceInFrame: number;
  rect: {x: number; y: number; width: number; height: number}; gain: number;
  shotId?: string; versionId?: string; jobId?: string;
}
export interface Format5ConversionCue extends Record<string, unknown> {
  id: string; text: string; startFrame: number; durationFrames: number;
}
export interface Format5ConversionTrack extends Record<string, unknown> {
  id: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean;
}
export interface Format5LegacyTimeline extends Record<string, unknown> {
  id: string; projectId: string; revision: number; width: number; height: number; fps: number;
  tracks: readonly Format5ConversionTrack[]; clips: readonly Format5LegacyClip[]; durationFrames: number;
  subtitles?: {profileId?: string; basisPresetId?: string; cues: readonly Format5ConversionCue[]};
}
export interface Format5LegacyBinding extends Record<string, unknown> {
  id: string; projectId: string; shotId: string; subjectId: string; subjectVersionId: string | null;
}
export interface Format5ProvenVersion {
  readonly versionId: string; readonly projectId: string; readonly shotId: string;
  readonly assetId: string; readonly sha256: string; readonly jobId?: string;
}
export interface Format5ConversionInput {
  readonly sourceFormat: 3 | 4;
  readonly projectId: string;
  readonly hasProject: boolean;
  readonly shots: readonly Format5LegacyShot[];
  readonly nodes: readonly Format5LegacyNode[];
  readonly edges: readonly Format5LegacyEdge[];
  readonly versions: readonly Format5LegacyVersion[];
  readonly assets: readonly Format5ConversionAsset[];
  readonly subjectBindings: readonly Format5LegacyBinding[];
  readonly timeline: Format5LegacyTimeline | null;
  /** A project with no timeline uses its saved output geometry. */
  readonly emptyTimeline?: Format5LegacyTimeline;
  readonly archivedShotIds?: readonly string[];
  readonly archivedNodeIds?: readonly string[];
  readonly archivedEdgeIds?: readonly string[];
  /** Produced by the existing ownership reader, including portable publication
   * evidence when the source has no local generation history. */
  readonly provenVersions: readonly Format5ProvenVersion[];
}
export interface Format5ConversionAllocation {
  readonly sequenceRootId: string;
  readonly createdAt: string;
  readonly nodeIds: readonly string[];
  readonly clipIds: readonly string[];
  readonly segmentGroupIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly anchorConflictPolicy: 'reject' | 'detach';
}
export interface Format5ConvertedClip extends Omit<Format5LegacyClip, 'assetId' | 'versionId' | 'jobId'> {
  id: string; trackId: string; assetId: string | null; startFrame: number; durationFrames: number; sourceInFrame: number;
  rect: {x: number; y: number; width: number; height: number}; gain: number;
  versionId?: string | null; jobId?: string | null; shotId?: string; transitionIn?: unknown;
  sourceState: 'ready' | 'placeholder'; sequenceSource?: Format5SequenceSource; anchor?: Format5Anchor;
}
export interface Format5ConvertedTimeline extends Omit<Format5LegacyTimeline, 'clips' | 'subtitles'> {
  id: string; projectId: string; revision: number; width: number; height: number; fps: number;
  tracks: readonly Format5ConversionTrack[]; durationFrames: number;
  mainTrack: {trackId: string; sequenceNodeId: string};
  clips: Format5ConvertedClip[];
  subtitles?: {profileId: string; basisPresetId?: string; cues: (Format5ConversionCue & {anchor: Format5Anchor})[]};
}
export interface Format5ConversionSummary {
  readonly reorderedClips: number; readonly lockedClips: number; readonly placeholderClips: number;
  readonly mediaCards: number; readonly removedDecorativeEdges: number; readonly removedTransitions: number;
  readonly compactedGapFrames: number; readonly detachedAnchors: number; readonly durationDeltaFrames: number;
  readonly ambiguousSourceClips: readonly string[];
}
export interface Format5ConversionPlan {
  readonly nodes: readonly Format5LegacyNode[];
  readonly edges: readonly Format5LegacyEdge[];
  readonly removedEdgeIds: readonly string[];
  readonly timeline: Format5ConvertedTimeline | null;
  readonly subjectBindings: readonly (Format5LegacyBinding & {bindingMode: 'locked' | 'detached'})[];
  readonly syncState: {timelineId: string; sequenceNodeId: string; revision: number; baseline: unknown} | null;
  readonly summary: Format5ConversionSummary;
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const position = (a: {startFrame: number; id: string}, b: {startFrame: number; id: string}) => a.startFrame - b.startFrame || compareId(a.id, b.id);
const natural = (value: number) => Number.isSafeInteger(value) && value >= 0;
function fail(code: string, ids: readonly string[] = []): never {
  throw Object.assign(new Error('The saved project cannot be converted to format 5.'), {code, ids: [...new Set(ids)].sort(compareId)});
}
function index<T extends {id: string; projectId: string}>(rows: readonly T[], projectId: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!uuid(row.id) || row.projectId !== projectId || result.has(row.id)) fail('FORMAT5_CONVERSION_INVALID', [row.id]);
    result.set(row.id, row);
  }
  return result;
}
function emptySummary(): Format5ConversionSummary {
  return {reorderedClips: 0, lockedClips: 0, placeholderClips: 0, mediaCards: 0, removedDecorativeEdges: 0,
    removedTransitions: 0, compactedGapFrames: 0, detachedAnchors: 0, durationDeltaFrames: 0, ambiguousSourceClips: []};
}
function pool(values: readonly string[], reserved: Set<string>) {
  let cursor = 0;
  return () => {
    const value = values[cursor++];
    if (!uuid(value) || reserved.has(value)) fail('FORMAT5_CONVERSION_ID_REQUIRED');
    reserved.add(value);
    return value;
  };
}
function withReadySource(clip: Format5LegacyClip): Format5ConvertedClip {
  return {...structuredClone(clip), name: typeof clip.name === 'string' && clip.name ? clip.name : '片段', sourceState: 'ready'};
}

interface SourceOwner {shot: Format5LegacyShot; version: Format5LegacyVersion}
interface ClipGroup {clips: Format5LegacyClip[]; owner: SourceOwner | null; nodeId: string; segmentGroupId: string; media: boolean}

/** Pure, deterministic conversion. All IDs and timestamps are supplied before
 * planning, and no row in input is modified. The opening transaction applies the
 * plan and validates the final graph before publishing either version number. */
export function planFormat5Conversion(input: Format5ConversionInput, allocation: Format5ConversionAllocation): Format5ConversionPlan {
  if (!uuid(input.projectId) || ![3, 4].includes(input.sourceFormat) || !['reject', 'detach'].includes(allocation.anchorConflictPolicy)) fail('FORMAT5_CONVERSION_INVALID');
  const shots = index(input.shots, input.projectId), nodes = index(input.nodes, input.projectId), edges = index(input.edges, input.projectId);
  const versions = index(input.versions, input.projectId), assets = index(input.assets, input.projectId);
  index(input.subjectBindings, input.projectId);
  if (!input.hasProject) {
    if (shots.size || nodes.size || edges.size || versions.size || assets.size || input.subjectBindings.length || input.timeline) fail('FORMAT5_CONVERSION_INVALID');
    return {nodes: [], edges: [], removedEdgeIds: [], timeline: null, subjectBindings: [], syncState: null, summary: emptySummary()};
  }
  const timelineSource = input.timeline ?? input.emptyTimeline;
  if (!timelineSource || timelineSource.projectId !== input.projectId || timelineSource.fps !== 30 || !timelineSource.tracks.length) fail('FORMAT5_CONVERSION_TIMELINE_REQUIRED');
  const original = timelineSource;
  const mainTrack = [...original.tracks].filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex || compareId(a.id, b.id))[0];
  if (!mainTrack) fail('FORMAT5_CONVERSION_TIMELINE_REQUIRED');
  const archivedShots = new Set(input.archivedShotIds), archivedNodes = new Set(input.archivedNodeIds), archivedEdges = new Set(input.archivedEdgeIds);
  const activeShots = [...shots.values()].filter(shot => !archivedShots.has(shot.id)).sort((a, b) => a.orderIndex - b.orderIndex || compareId(a.id, b.id));
  const trackIds = new Set(original.tracks.map(track => track.id));
  if (trackIds.size !== original.tracks.length) fail('FORMAT5_CONVERSION_INVALID');
  const trackKinds = new Map(original.tracks.map(track => [track.id, track.kind]));
  const clipIds = new Set<string>();
  for (const clip of original.clips) {
    const asset = assets.get(clip.assetId);
    if (!uuid(clip.id) || clipIds.has(clip.id) || !trackIds.has(clip.trackId) || !asset || !natural(clip.startFrame) ||
      !natural(clip.durationFrames) || clip.durationFrames === 0 || !natural(clip.sourceInFrame)) fail('FORMAT5_CONVERSION_INVALID', [clip.id]);
    const image = asset.mimeType.startsWith('image/'), video = asset.mimeType.startsWith('video/'), audio = asset.mimeType.startsWith('audio/');
    if ((trackKinds.get(clip.trackId) === 'video' ? !image && !video : !audio) ||
        (image ? clip.sourceInFrame !== 0 : clip.sourceInFrame + clip.durationFrames > (sourceFrameCount(asset.duration) ?? 0)))
      fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [clip.id]);
    clipIds.add(clip.id);
  }
  const reserved = new Set([input.projectId, original.id, ...shots.keys(), ...nodes.keys(), ...edges.keys(), ...versions.keys(), ...assets.keys(), ...clipIds, ...trackIds,
    ...(original.subtitles?.cues.map(cue => cue.id) ?? [])]);
  if (!uuid(allocation.sequenceRootId) || reserved.has(allocation.sequenceRootId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(allocation.createdAt)) fail('FORMAT5_CONVERSION_ID_REQUIRED');
  reserved.add(allocation.sequenceRootId);
  const nextNode = pool(allocation.nodeIds, reserved), nextClip = pool(allocation.clipIds, reserved), nextGroup = pool(allocation.segmentGroupIds, reserved), nextEdge = pool(allocation.edgeIds, reserved);
  const proofs = new Map<string, Format5ProvenVersion>();
  for (const proof of input.provenVersions) {
    const version = versions.get(proof.versionId), asset = assets.get(proof.assetId);
    if (!version || !asset || proof.projectId !== input.projectId || version.shotId !== proof.shotId || version.assetId !== proof.assetId ||
      !/^[a-f0-9]{64}$/u.test(proof.sha256) || version.sha256 !== proof.sha256 || asset.sha256 !== proof.sha256 || !shots.has(proof.shotId) ||
      version.jobId !== proof.jobId || proofs.has(proof.versionId)) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [proof.versionId]);
    proofs.set(proof.versionId, proof);
  }
  for (const shot of activeShots) {
    if (!natural(shot.orderIndex) || !Number.isSafeInteger(shot.duration) || shot.duration < 1 || shot.duration > 20 ||
        shot.selectedVersionId !== null && (!uuid(shot.selectedVersionId) || versions.get(shot.selectedVersionId)?.shotId !== shot.id || !proofs.has(shot.selectedVersionId)))
      fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [shot.id]);
  }
  const byAsset = new Map<string, Format5LegacyVersion[]>();
  for (const version of versions.values()) {
    const found = byAsset.get(version.assetId) ?? [];
    found.push(version); byAsset.set(version.assetId, found);
  }
  const ambiguous: string[] = [];
  function owner(clip: Format5LegacyClip): SourceOwner | null {
    let candidates = byAsset.get(clip.assetId) ?? [];
    if (clip.versionId !== undefined) candidates = candidates.filter(version => version.id === clip.versionId);
    if (clip.shotId !== undefined) candidates = candidates.filter(version => version.shotId === clip.shotId);
    if (clip.jobId !== undefined) candidates = candidates.filter(version => version.jobId === clip.jobId);
    if (candidates.length !== 1) {
      if (clip.versionId !== undefined || clip.shotId !== undefined || clip.jobId !== undefined) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [clip.id]);
      if (candidates.length > 1) ambiguous.push(clip.id);
      return null;
    }
    const version = candidates[0]!;
    if (!proofs.has(version.id)) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [clip.id, version.id]);
    return {shot: shots.get(version.shotId)!, version};
  }
  const oldMain = [...original.clips].filter(clip => clip.trackId === mainTrack.id).sort(position);
  const groups: ClipGroup[] = [];
  for (const clip of oldMain) {
    const found = owner(clip), previous = groups.at(-1), tail = previous?.clips.at(-1), asset = assets.get(clip.assetId)!;
    if (found && previous?.owner?.version.id === found.version.id && tail && asset.mimeType.startsWith('video/') &&
      tail.startFrame + tail.durationFrames === clip.startFrame && tail.sourceInFrame + tail.durationFrames === clip.sourceInFrame) previous.clips.push(clip);
    else groups.push({clips: [clip], owner: found, nodeId: '', segmentGroupId: '', media: false});
  }
  const convertedNodes: Format5LegacyNode[] = [...input.nodes].sort((a, b) => compareId(a.id, b.id)).map(node => structuredClone(node));
  convertedNodes.push({id: allocation.sequenceRootId, projectId: input.projectId, type: 'sequence_root', name: '成片',
    position: {x: -320, y: 0}, createdAt: allocation.createdAt, revision: 1});
  const mappedShots = new Map<string, ClipGroup>();
  for (const group of groups) {
    const shot = group.owner?.shot;
    group.segmentGroupId = nextGroup();
    if (shot && !archivedShots.has(shot.id) && !mappedShots.has(shot.id)) {
      group.nodeId = shot.id; mappedShots.set(shot.id, group);
    } else {
      group.nodeId = nextNode(); group.media = true;
      const asset = assets.get(group.clips[0]!.assetId)!;
      if (!asset.mimeType.startsWith('video/') && !asset.mimeType.startsWith('image/')) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [asset.id]);
      convertedNodes.push({id: group.nodeId, projectId: input.projectId, type: asset.mimeType.startsWith('video/') ? 'video' : 'image',
        assetId: asset.id, label: typeof group.clips[0]!.name === 'string' ? group.clips[0]!.name : '', text: '',
        position: {x: 320, y: convertedNodes.length * 240}, revision: 1, createdAt: allocation.createdAt});
    }
  }
  const mediaBeforeShot = new Map<string | null, ClipGroup[]>();
  for (let at = 0; at < groups.length; at++) {
    const group = groups[at]!;
    if (!group.media) continue;
    const following = groups.slice(at + 1).find(next => !next.media)?.nodeId ?? null;
    const list = mediaBeforeShot.get(following) ?? []; list.push(group); mediaBeforeShot.set(following, list);
  }
  const orderedGroups: ClipGroup[] = [];
  for (const shot of activeShots) {
    orderedGroups.push(...(mediaBeforeShot.get(shot.id) ?? []));
    let group = mappedShots.get(shot.id);
    if (!group) {
      const version = shot.selectedVersionId === null ? null : versions.get(shot.selectedVersionId);
      if (shot.selectedVersionId !== null && (!version || version.shotId !== shot.id || !proofs.has(version.id))) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [shot.id]);
      const asset = version ? assets.get(version.assetId) : undefined;
      if (version && (!asset || !asset.mimeType.startsWith('video/') && !asset.mimeType.startsWith('image/'))) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [shot.id]);
      const frames = asset && !asset.mimeType.startsWith('image/') ? sourceFrameCount(asset.duration) : shot.duration * original.fps;
      if (!natural(frames ?? -1) || frames === 0) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [shot.id]);
      const clip: Format5LegacyClip = {id: nextClip(), trackId: mainTrack.id, assetId: asset?.id ?? '', name: shot.title || '镜头',
        startFrame: 0, durationFrames: frames!, sourceInFrame: 0, rect: {x: 0, y: 0, width: original.width, height: original.height}, gain: 1};
      if (version) {clip.versionId = version.id; clip.shotId = shot.id; if (version.jobId !== undefined) clip.jobId = version.jobId;}
      group = {clips: [clip], owner: version ? {shot, version} : null, nodeId: shot.id, segmentGroupId: nextGroup(), media: false};
    }
    orderedGroups.push(group);
  }
  orderedGroups.push(...(mediaBeforeShot.get(null) ?? []));
  let cursor = 0, lockedClips = 0, placeholders = 0;
  const newMain: Format5ConvertedClip[] = [];
  for (const group of orderedGroups) {
    for (const clip of group.clips) {
      const shot = shots.get(group.nodeId), versionMode = group.owner && shot && shot.selectedVersionId !== group.owner.version.id ? 'locked' : 'follow';
      const sequenceSource: Format5SequenceSource = group.media ? {kind: 'media', nodeId: group.nodeId, segmentGroupId: group.segmentGroupId}
        : {kind: 'shot', nodeId: group.nodeId, segmentGroupId: group.segmentGroupId, versionMode};
      const converted: Format5ConvertedClip = {...withReadySource(clip), startFrame: cursor, sequenceSource};
      if (!clip.assetId) {
        converted.assetId = null; converted.versionId = null; converted.jobId = null; converted.sourceState = 'placeholder'; placeholders++;
      } else if (!group.media && group.owner) {
        converted.versionId = group.owner.version.id; converted.shotId = group.owner.shot.id;
        if (group.owner.version.jobId !== undefined) converted.jobId = group.owner.version.jobId;
        if (versionMode === 'locked') lockedClips++;
      }
      newMain.push(converted); cursor += converted.durationFrames;
    }
  }
  const newById = new Map(newMain.map(clip => [clip.id, clip]));
  function anchorAt(frame: number): Format5Anchor {
    const clip = oldMain.find(item => item.startFrame <= frame && frame < item.startFrame + item.durationFrames);
    return clip && newById.has(clip.id) ? {clipId: clip.id, offsetFrames: frame - clip.startFrame} : null;
  }
  const other = original.clips.filter(clip => clip.trackId !== mainTrack.id).map<Format5ConvertedClip>(clip => {
    const anchor = anchorAt(clip.startFrame), target = anchor ? newById.get(anchor.clipId) : undefined;
    return {...withReadySource(clip), anchor, startFrame: target && anchor ? target.startFrame + anchor.offsetFrames : clip.startFrame};
  });
  const cues = original.subtitles?.cues.map(cue => {
    const anchor = anchorAt(cue.startFrame), target = anchor ? newById.get(anchor.clipId) : undefined;
    return {...structuredClone(cue), anchor, startFrame: target && anchor ? target.startFrame + anchor.offsetFrames : cue.startFrame};
  });
  const oldItems = new Map<string, {startFrame: number}>();
  for (const item of [...original.clips, ...(original.subtitles?.cues ?? [])]) oldItems.set(item.id, item);
  const detached = new Set<string>();
  let clips: Format5ConvertedClip[] = [...newMain, ...other];
  const duration = () => Math.max(0, ...clips.map(clip => clip.startFrame + clip.durationFrames));
  function conflicts(): string[] {
    const result = new Set<string>();
    for (const track of original.tracks) {
      const ordered = clips.filter(clip => clip.trackId === track.id).sort(position);
      for (let at = 1; at < ordered.length; at++) if (ordered[at]!.startFrame < ordered[at - 1]!.startFrame + ordered[at - 1]!.durationFrames) {
        result.add(ordered[at]!.id); result.add(ordered[at - 1]!.id);
      }
    }
    const orderedCues = [...(cues ?? [])].sort(position);
    for (const cue of orderedCues) if (cue.startFrame < 0 || cue.startFrame + cue.durationFrames > duration()) result.add(cue.id);
    for (let at = 1; at < orderedCues.length; at++) if (orderedCues[at]!.startFrame < orderedCues[at - 1]!.startFrame + orderedCues[at - 1]!.durationFrames) {
      result.add(orderedCues[at]!.id); result.add(orderedCues[at - 1]!.id);
    }
    return [...result].sort(compareId);
  }
  let affected = conflicts();
  while (affected.length) {
    if (allocation.anchorConflictPolicy === 'reject') fail('FORMAT5_CONVERSION_ANCHOR_CONFLICT', affected);
    let changed = false;
    for (const item of [...other, ...(cues ?? [])]) if (affected.includes(item.id) && item.anchor) {
      item.startFrame = oldItems.get(item.id)!.startFrame; item.anchor = null; detached.add(item.id); changed = true;
    }
    if (!changed) fail('FORMAT5_CONVERSION_ANCHOR_CONFLICT', affected);
    clips = [...newMain, ...other]; affected = conflicts();
  }
  const oldPredecessors = new Map<string, string>();
  for (const track of original.tracks) {
    const ordered = original.clips.filter(clip => clip.trackId === track.id).sort(position);
    for (let at = 1; at < ordered.length; at++) if (ordered[at - 1]!.startFrame + ordered[at - 1]!.durationFrames === ordered[at]!.startFrame) oldPredecessors.set(ordered[at]!.id, ordered[at - 1]!.id);
  }
  let removedTransitions = 0;
  for (const clip of clips) if (clip.transitionIn != null) {
    const previous = clips.find(item => item.trackId === clip.trackId && item.startFrame + item.durationFrames === clip.startFrame);
    if (!previous || previous.id !== oldPredecessors.get(clip.id)) {delete clip.transitionIn; removedTransitions++;}
  }
  const realClips = clips.filter((clip): clip is Format5ConvertedClip & {assetId: string} => clip.assetId !== null);
  for (const clip of realClips.sort(position)) if (clip.transitionIn != null && !clipTransitionFits(realClips, clip, (clip.transitionIn as {durationFrames: number}).durationFrames, assetId => {
    const asset = assets.get(assetId); return asset ? {image: asset.mimeType.startsWith('image/'), frames: sourceFrameCount(asset.duration) ?? 0} : null;
  })) {delete clip.transitionIn; removedTransitions++;}
  const removedEdgeIds: string[] = [];
  const convertedEdges: Format5LegacyEdge[] = [];
  for (const edge of [...edges.values()].sort((a, b) => compareId(a.id, b.id))) {
    if (archivedEdges.has(edge.id)) {convertedEdges.push(structuredClone(edge)); continue;}
    if (edge.kind !== 'reference') {
      if (edge.kind !== undefined && !['decor', 'decorative'].includes(edge.kind)) fail('FORMAT5_CONVERSION_INVALID', [edge.id]);
      removedEdgeIds.push(edge.id); continue;
    }
    const node = nodes.get(edge.source), shot = shots.get(edge.target), assetId = edge.sourceAssetId ?? node?.assetId;
    if (!node || !shot || !assetId || !assets.has(assetId) || node.assetId !== undefined && node.assetId !== assetId) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [edge.id]);
    if (edge.role === 'first_frame' && (!Array.isArray(shot.referenceAssetIds) || shot.referenceAssetIds[0] !== assetId)) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [edge.id]);
    const {kind: _kind, ...kept} = structuredClone(edge);
    convertedEdges.push({...kept, kind: 'reference', sourceAssetId: assetId});
  }
  const materialNodeByAsset = new Map<string, string>();
  for (const node of [...convertedNodes].sort((a, b) => compareId(a.id, b.id))) if (!archivedNodes.has(node.id) && node.assetId && node.type === 'image') materialNodeByAsset.set(node.assetId, materialNodeByAsset.get(node.assetId) ?? node.id);
  function addReference(shot: Format5LegacyShot, assetId: string, role: string, orderIndex: number) {
    const asset = assets.get(assetId);
    if (!asset || !asset.mimeType.startsWith('image/')) fail('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE', [shot.id, assetId]);
    const prior = convertedEdges.find(edge => edge.target === shot.id && edge.kind === 'reference' && edge.role === role && edge.sourceAssetId === assetId);
    if (prior) return;
    let source = materialNodeByAsset.get(assetId);
    if (!source) {
      source = nextNode(); materialNodeByAsset.set(assetId, source);
      convertedNodes.push({id: source, projectId: input.projectId, type: 'image', assetId, label: '', text: '',
        position: {x: 640, y: convertedNodes.length * 240}, revision: 1, createdAt: allocation.createdAt});
    }
    convertedEdges.push({id: nextEdge(), projectId: input.projectId, source, target: shot.id, kind: 'reference', role, sourceAssetId: assetId, orderIndex, createdAt: allocation.createdAt});
  }
  for (const shot of activeShots) {
    const references = shot.referenceAssetIds ?? [];
    if (!Array.isArray(references) || references.some(assetId => typeof assetId !== 'string')) fail('FORMAT5_CONVERSION_INVALID', [shot.id]);
    for (let at = 0; at < references.length; at++) addReference(shot, references[at] as string, at === 0 ? 'first_frame' : 'reference_image', at);
    if (shot.lastFrameAssetId != null) {
      if (typeof shot.lastFrameAssetId !== 'string') fail('FORMAT5_CONVERSION_INVALID', [shot.id]);
      addReference(shot, shot.lastFrameAssetId, 'last_frame', 0);
    }
  }
  const nodeOrder = orderedGroups.map(group => group.nodeId);
  for (let at = 0; at < nodeOrder.length; at++) convertedEdges.push({id: nextEdge(), projectId: input.projectId,
    source: at === 0 ? allocation.sequenceRootId : nodeOrder[at - 1]!, target: nodeOrder[at]!, kind: 'sequence', createdAt: allocation.createdAt});
  const {subtitles: _subtitles, ...timelineFields} = structuredClone(original);
  const timeline: Format5ConvertedTimeline = {...timelineFields, mainTrack: {trackId: mainTrack.id, sequenceNodeId: allocation.sequenceRootId},
    clips, durationFrames: duration(), ...(cues ? {subtitles: {...original.subtitles!,
      profileId: original.subtitles?.profileId === undefined ? TIMELINE_SUBTITLE_PROFILE_ID : original.subtitles.profileId, cues}} : {})};
  if (input.timeline) {
    if (!Number.isSafeInteger(original.revision) || original.revision >= Number.MAX_SAFE_INTEGER) fail('FORMAT5_CONVERSION_INVALID', [original.id]);
    timeline.revision = original.revision + 1;
    timeline.updatedAt = allocation.createdAt;
  }
  assertFormat5Timeline(timeline, {projectId: input.projectId});
  validateFormat5SequenceGraph({projectId: input.projectId,
    shots: activeShots, nodes: convertedNodes.filter(node => !archivedNodes.has(node.id)),
    edges: convertedEdges.filter(edge => !archivedEdges.has(edge.id) && !archivedShots.has(edge.target) && !archivedNodes.has(edge.source)), assets: input.assets, timeline});
  const board = orderedGroups.map(group => group.media
    ? {nodeId: group.nodeId, kind: 'media', assetId: group.clips[0]!.assetId}
    : {nodeId: group.nodeId, kind: 'shot', selectedVersionId: shots.get(group.nodeId)!.selectedVersionId});
  const track = newMain.map(clip => clip.sequenceSource!.kind === 'media'
    ? {nodeId: clip.sequenceSource!.nodeId, segmentGroupId: clip.sequenceSource!.segmentGroupId, clipId: clip.id, kind: 'media', assetId: clip.assetId}
    : {nodeId: clip.sequenceSource!.nodeId, segmentGroupId: clip.sequenceSource!.segmentGroupId, clipId: clip.id, kind: 'shot',
      versionMode: clip.sequenceSource!.versionMode, appliedVersionId: clip.versionId ?? null});
  const oldOrder = oldMain.map(clip => clip.id), newOrder = newMain.map(clip => clip.id);
  let priorEnd = 0, gaps = 0;
  for (const clip of oldMain) {gaps += Math.max(0, clip.startFrame - priorEnd); priorEnd = Math.max(priorEnd, clip.startFrame + clip.durationFrames);}
  const baseline = format5SyncBaselineSchema.parse({version: 1, board, track});
  return {nodes: convertedNodes, edges: convertedEdges, removedEdgeIds, timeline,
    subjectBindings: [...input.subjectBindings].sort((a, b) => compareId(a.id, b.id)).map(binding => ({...structuredClone(binding), bindingMode: binding.subjectVersionId === null ? 'detached' : 'locked'})),
    syncState: {timelineId: timeline.id, sequenceNodeId: allocation.sequenceRootId, revision: 1, baseline},
    summary: {reorderedClips: oldOrder.filter((id, at) => newOrder[at] !== id).length, lockedClips, placeholderClips: placeholders,
      mediaCards: groups.filter(group => group.media).length, removedDecorativeEdges: removedEdgeIds.length, removedTransitions,
      compactedGapFrames: gaps, detachedAnchors: detached.size, durationDeltaFrames: timeline.durationFrames - original.durationFrames,
      ambiguousSourceClips: ambiguous.sort(compareId)}};
}

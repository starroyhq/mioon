/** UI-E3: format-5 editing panels → the one shared `sequence.preview/commit`
 * entry. Pure mapping only; the App owns sessions, notices and refresh. */
import {isClipTransition, canonicalClipTransition} from '../../../../packages/contracts/src/timeline-clip-transition.ts';
import type {ClipTransition} from '../../../../packages/contracts/src/timeline-clip-transition.ts';
import {isClipTransform} from '../../../../packages/contracts/src/timeline-clip-transform.ts';
import {sameClipDraftValue} from '../clip-draft-state.ts';
import type {SubtitleIntent} from '../subtitle-state.ts';
import type {SequenceDialogueConflict} from './lost-response.ts';

type Row = Record<string, unknown>;

/** Clip fields FR-A's `propertiesIntent` accepts (persisted clip row name ->
 * patch name). Rect/layout and opacity envelopes are not in that contract. */
const PROPERTY_FIELDS = Object.freeze([
  ['name', 'name'], ['gain', 'gain'], ['fadeInFrames', 'fadeInFrames'], ['fadeOutFrames', 'fadeOutFrames'],
  ['colour', 'colour'], ['audioRole', 'audioRole'], ['volumeEnvelope', 'volumeEnvelope'],
  ['transform', 'transform'], ['transitionIn', 'transition'], ['muted', 'muted'],
] as const);
const GEOMETRY_FIELDS = Object.freeze(['trackId', 'startFrame', 'durationFrames', 'sourceInFrame'] as const);

export interface Format5ClipPatchSplit {
  /** Persisted clip field -> FR-A patch value, for changed property fields only. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: Readonly<Record<string, unknown>>;
  readonly unsupported: readonly string[];
}
function same(left: unknown, right: unknown): boolean {
  return sameClipDraftValue(left ?? null, right ?? null);
}
/** Split one inspector save patch into FR-A property edits, TS structural edits
 * and fields the format-5 contract does not accept. Only changed fields count:
 * the draft always carries the whole row. */
export function splitFormat5ClipPatch(clip: Row, patch: Record<string, unknown>): Format5ClipPatchSplit {
  const properties: Record<string, unknown> = {}, geometry: Record<string, unknown> = {}, unsupported: string[] = [];
  for (const [field, target] of PROPERTY_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    if (!same(clip[field], patch[field])) properties[target] = patch[field];
  }
  for (const field of GEOMETRY_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    if (!same(clip[field], patch[field])) geometry[field] = patch[field];
  }
  for (const field of Object.keys(patch)) {
    if (PROPERTY_FIELDS.some(([source]) => source === field) || (GEOMETRY_FIELDS as readonly string[]).includes(field)) continue;
    if (!same(clip[field], patch[field])) unsupported.push(field);
  }
  return {properties, geometry, unsupported};
}

export interface Format5PropertiesIntent {
  readonly side: 'timeline';
  readonly operation: {readonly kind: 'clip-properties';
    readonly edits: readonly {readonly clipId: string; readonly patch: Readonly<Record<string, unknown>>}[]};
}
export function format5PropertiesIntent(clipId: string, patch: Readonly<Record<string, unknown>>): Format5PropertiesIntent {
  return {side: 'timeline', operation: {kind: 'clip-properties', edits: [{clipId, patch}]}};
}
/** Most recent frame first: a trimmed width may match several cuts; the clip is
 * placed before the first main-track clip that starts after the requested frame. */
export function format5MoveBeforeClipId(clips: readonly Row[], clipId: string, mainTrackId: string | null, startFrame: number): string | null {
  if (!mainTrackId) return null;
  const others = clips.filter(clip => clip.id !== clipId && clip.trackId === mainTrackId)
    .sort((left, right) => Number(left.startFrame) - Number(right.startFrame) || String(left.id).localeCompare(String(right.id)));
  const currentStartFrame = Number(clips.find(clip => clip.id === clipId)?.startFrame ?? 0);
  // A target equal to a sibling's start means "before that sibling" when the
  // clip currently sits later; the packed main track has no free frames.
  const before = others.find(clip => Number(clip.startFrame) > startFrame
    || Number(clip.startFrame) === startFrame && currentStartFrame > startFrame)?.id;
  return typeof before === 'string' ? before : null;
}

export type Format5ClipEdit =
  | {readonly kind: 'properties'; readonly intent: Format5PropertiesIntent}
  | {readonly kind: 'trim'; readonly patch: Readonly<Record<string, unknown>>}
  | {readonly kind: 'move'; readonly beforeClipId: string | null}
  | {readonly kind: 'move-off-track'; readonly trackId: string; readonly startFrame: number}
  | {readonly kind: 'unsupported'; readonly reason: 'mixed' | 'field'; readonly fields: readonly string[]};

/** One inspector save = one action. Structural and property edits cannot share
 * one envelope family (contract rule), so a mixed draft asks for two saves. */
export function format5ClipInspectorEdit(clip: Row, patch: Record<string, unknown>, clips: readonly Row[],
  mainTrackId: string | null): Format5ClipEdit {
  const split = splitFormat5ClipPatch(clip, patch);
  if (split.unsupported.length) return {kind: 'unsupported', reason: 'field', fields: split.unsupported};
  const hasProperties = Object.keys(split.properties).length > 0;
  const geometry = split.geometry;
  const trim = Object.hasOwn(geometry, 'durationFrames') || Object.hasOwn(geometry, 'sourceInFrame');
  const moving = Object.hasOwn(geometry, 'trackId') || Object.hasOwn(geometry, 'startFrame');
  if (!hasProperties && !trim && !moving) return {kind: 'unsupported', reason: 'field', fields: []};
  if (hasProperties && (trim || moving)) return {kind: 'unsupported', reason: 'mixed', fields: [...Object.keys(split.properties), ...Object.keys(geometry)]};
  if (hasProperties) return {kind: 'properties', intent: format5PropertiesIntent(String(clip.id), split.properties)};
  if (trim && moving) return {kind: 'unsupported', reason: 'mixed', fields: [...Object.keys(geometry)]};
  if (trim) return {kind: 'trim', patch: geometry};
  const trackId = typeof geometry.trackId === 'string' ? geometry.trackId : String(clip.trackId);
  const startFrame = typeof geometry.startFrame === 'number' ? geometry.startFrame : Number(clip.startFrame);
  if (trackId !== mainTrackId) {
    return clip.trackId === mainTrackId
      ? {kind: 'move-off-track', trackId, startFrame}
      : {kind: 'unsupported', reason: 'field', fields: ['trackId']};
  }
  // Bringing an other-track segment back onto the packed main track has no TS
  // command yet; only main-track reorders are mapped here.
  if (clip.trackId !== mainTrackId) return {kind: 'unsupported', reason: 'field', fields: ['trackId']};
  return {kind: 'move', beforeClipId: format5MoveBeforeClipId(clips, String(clip.id), mainTrackId, startFrame)};
}

/** `transform` / `transitionIn` edits opened from the inspector controls. */
export function format5ClipPropertyEdit(clipId: string, key: 'transform' | 'transition',
  value: unknown, durationFrames: number): Format5PropertiesIntent | {readonly unsupported: true} {
  if (value !== null && key === 'transition' && !isClipTransition(value)) return {unsupported: true};
  if (value !== null && key === 'transform' && !isClipTransform(value, durationFrames)) return {unsupported: true};
  const normalized = key === 'transition' ? canonicalClipTransition(value as ClipTransition | null) : value;
  return format5PropertiesIntent(clipId, {[key]: normalized});
}

export interface Format5SubtitleEdit {
  readonly intent: {
    readonly side: 'timeline';
    readonly operation: {readonly kind: 'subtitles';
      readonly edits: readonly unknown[]};
  } | null;
  readonly unsupported?: string;
}
/** Subtitle inspector intent -> shared `subtitlesIntent` (FR-B). New cue ids are
 * allocated here because the shared action carries the row identity. */
export function format5SubtitleEdit(intent: SubtitleIntent, newCueId: string): Format5SubtitleEdit {
  const input = intent.input;
  if (intent.operation === 'timeline.subtitle.add') {
    if (typeof input.text !== 'string' || typeof input.startFrame !== 'number' || typeof input.durationFrames !== 'number')
      return {intent: null, unsupported: 'payload'};
    return {intent: {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'add', cue: {
      id: newCueId, text: input.text, startFrame: input.startFrame, durationFrames: input.durationFrames}}]}}};
  }
  if (intent.operation === 'timeline.subtitle.update') {
    if (!input.cueId || !input.patch) return {intent: null, unsupported: 'payload'};
    const patch: Record<string, unknown> = {};
    if (typeof input.patch.text === 'string') patch.text = input.patch.text;
    if (typeof input.patch.startFrame === 'number') patch.startFrame = input.patch.startFrame;
    if (typeof input.patch.durationFrames === 'number') patch.durationFrames = input.patch.durationFrames;
    if (Object.keys(patch).length === 0) return {intent: null, unsupported: 'payload'};
    return {intent: {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'update', cueId: input.cueId, patch}]}}};
  }
  if (intent.operation === 'timeline.subtitle.remove') {
    if (!input.cueId) return {intent: null, unsupported: 'payload'};
    return {intent: {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'remove', cueId: input.cueId}]}}};
  }
  return {intent: null, unsupported: 'operation'};
}

/** Codes the panels can meet; the shared map keeps one reason per code. */
export function format5PanelErrorKey(code: string | undefined): string {
  switch (code) {
    case 'SEQUENCE_EDIT_ANCHOR_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT';
    case 'SEQUENCE_EDIT_DIALOGUE_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT';
    case 'SEQUENCE_EDIT_REVISION_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_REVISION_CONFLICT';
    case 'SEQUENCE_EDIT_PATCH_INVALID': return 'editUi.error.SEQUENCE_EDIT_PATCH_INVALID';
    case 'SEQUENCE_EDIT_HISTORY_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_HISTORY_CONFLICT';
    case 'SEQUENCE_EDIT_NOOP': return 'editUi.error.SEQUENCE_EDIT_NOOP';
    case 'SEQUENCE_EDIT_CONTRACT_INVALID': return 'editUi.error.SEQUENCE_EDIT_CONTRACT_INVALID';
    case 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID': return 'editUi.error.CLIP_PROPERTIES_INVALID';
    case 'SEQUENCE_EDIT_SUBTITLE_INVALID': return 'editUi.error.SUBTITLE_INVALID';
    case 'SEQUENCE_EDIT_SOUND_INVALID': return 'editUi.error.SEQUENCE_EDIT_SOUND_INVALID';
    default: return 'editUi.error.GENERIC';
  }
}
/** Best-effort affected ids from a rejected shared action (anchor conflicts). */
export function format5ConflictIds(error: unknown): readonly string[] {
  if (error === null || typeof error !== 'object') return [];
  const record = error as {ids?: unknown; details?: {ids?: unknown}};
  const raw = Array.isArray(record.ids) ? record.ids : record.details && typeof record.details === 'object' && Array.isArray(record.details.ids) ? record.details.ids : [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export interface Format5AnchorConflictPresentation {
  readonly message: string;
  readonly highlightIds: readonly string[];
}

/** Resolves conflicting clip/subtitle IDs from SEQUENCE_EDIT_ANCHOR_CONFLICT into
 * a specific toast line naming the overlapping segment(s) and the timeline highlight set. */
export function format5AnchorConflictPresentation(
  ids: readonly string[] | undefined,
  timeline: {readonly clips?: readonly Row[]; readonly subtitles?: {readonly cues?: readonly Row[]} | null} | null | undefined,
  assets: readonly Row[] | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): Format5AnchorConflictPresentation {
  const uniqueIds = [...new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const clips = timeline?.clips ?? [];
  const cues = timeline?.subtitles?.cues ?? [];
  const assetList = assets ?? [];
  const matched: {readonly id: string; readonly name: string}[] = [];
  for (const id of uniqueIds) {
    const clip = clips.find(item => item.id === id);
    if (clip) {
      const asset = assetList.find(item => item.id === clip.assetId);
      const name = String(clip.name || asset?.name || t('timeline.view.mediaClip'));
      matched.push({id, name});
      continue;
    }
    const cue = cues.find(item => item.id === id);
    if (cue) {
      const text = typeof cue.text === 'string' ? cue.text.replaceAll('\n', ' ').trim() : '';
      const name = text ? (text.length > 24 ? `${text.slice(0, 24)}…` : text) : t('round3.timeline.subtitles');
      matched.push({id, name});
    }
  }
  if (matched.length === 0) {
    return {message: t('editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT'), highlightIds: []};
  }
  const highlightIds = matched.map(item => item.id);
  if (matched.length === 1) {
    return {
      message: t('editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT_ONE', {name: matched[0]!.name}),
      highlightIds,
    };
  }
  return {
    message: t('editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT_MANY', {name: matched[0]!.name, count: matched.length}),
    highlightIds,
  };
}

export interface Format5DialogueConflictPresentation {
  readonly message: string;
  readonly highlightIds: readonly string[];
  readonly locateCue: {readonly cueId: string; readonly startFrame: number} | null;
}

/** Resolves SEQUENCE_EDIT_DIALOGUE_CONFLICT details into one plain-language
 * reason plus optional blocking-subtitle highlight and locate target. */
export function format5DialogueConflictPresentation(
  conflict: SequenceDialogueConflict | undefined,
  timeline: {readonly subtitles?: {readonly cues?: readonly Row[]} | null} | null | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  options: {readonly copying?: boolean} = {},
): Format5DialogueConflictPresentation {
  const copying = options.copying === true;
  if (!conflict) {
    return {
      message: t(copying ? 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_COPY' : 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT'),
      highlightIds: [],
      locateCue: null,
    };
  }
  if (conflict.blockerCount === 0) {
    return {
      message: t(
        copying ? 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_COPY_SPACE' : 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_SPACE',
        {required: conflict.requiredFrames, available: conflict.availableFrames},
      ),
      highlightIds: [],
      locateCue: null,
    };
  }
  const highlightIds = [...new Set(conflict.blockers.map(item => item.cueId))];
  const first = conflict.blockers[0] ?? null;
  let text = first?.textExcerpt.trim() ?? '';
  if (!text && first) {
    const live = timeline?.subtitles?.cues?.find(item => item.id === first.cueId);
    const raw = typeof live?.text === 'string' ? live.text.replace(/\s+/gu, ' ').trim() : '';
    const chars = [...raw];
    text = chars.slice(0, 12).join('') + (chars.length > 12 ? '…' : '');
  }
  const locateCue = first ? {cueId: first.cueId, startFrame: first.startFrame} : null;
  if (!text) {
    return {
      message: t(copying ? 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_COPY_BLOCKED' : 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_BLOCKED'),
      highlightIds,
      locateCue,
    };
  }
  if (conflict.blockerCount > 1) {
    return {
      message: t(
        copying ? 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_COPY_MANY' : 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_MANY',
        {text, count: conflict.blockerCount},
      ),
      highlightIds,
      locateCue,
    };
  }
  return {
    message: t(
      copying ? 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_COPY_ONE' : 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT_ONE',
      {text},
    ),
    highlightIds,
    locateCue,
  };
}

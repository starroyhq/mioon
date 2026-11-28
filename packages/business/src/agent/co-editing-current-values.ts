import path from 'node:path';
import type {AgentTaskJson, AgentTaskTarget} from '../../../contracts/src/agent-tasks-v2.ts';
import {agentTaskEditingTargetRevisionKind} from '../../../contracts/src/agent-tasks-v2.ts';
import {ASSET_ANNOTATION_LIMITS} from '../../../contracts/src/asset-annotations.ts';
import {CLIP_TRANSFORM_LIMITS} from '../../../contracts/src/timeline-clip-transform.ts';
import {OPACITY_ENVELOPE_LIMITS} from '../../../contracts/src/timeline-opacity-envelope.ts';
import {VOLUME_ENVELOPE_LIMITS} from '../../../contracts/src/timeline-volume-envelope.ts';
import {isCanvasArchived, isCanvasEdgeHidden} from '../canvas-active.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {agentTaskDisplayTargetReader} from './task-display-v2.ts';

type Fields = Record<string, AgentTaskJson>;
type FieldReader = (value: unknown) => AgentTaskJson | undefined;
type Shape = Readonly<Record<string, FieldReader>>;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (limit: number): FieldReader => value =>
  typeof value === 'string' && value.length <= limit ? value : undefined;
const enumText: FieldReader = value => typeof value === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(value) ? value : undefined;
const identifier: FieldReader = value => typeof value === 'string' && uuid.test(value) ? value : undefined;
const number: FieldReader = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const boolean: FieldReader = value => typeof value === 'boolean' ? value : undefined;
const nullable = (read: FieldReader): FieldReader => value => value === null ? null : read(value);
const fileName: FieldReader = value => {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  return path.win32.basename(path.posix.basename(value));
};
const rationalTerm: FieldReader = value => typeof value === 'string' && /^-?\d{1,39}$/u.test(value) ? value : undefined;

function project(value: unknown, shape: Shape): Fields | undefined {
  if (!record(value)) return undefined;
  const result: Fields = {};
  for (const [key, read] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) continue;
    const field = read(value[key]);
    if (field !== undefined) result[key] = field;
  }
  return result;
}
const object = (shape: Shape): FieldReader => value => project(value, shape);
const list = (read: FieldReader, max: number): FieldReader => value => {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const result: AgentTaskJson[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === undefined) return undefined;
    result.push(item);
  }
  return result;
};

const position = {x: number, y: number};
const anchor = nullable(object({clipId: identifier, offsetFrames: number}));
const layout = object({profileId: enumText, basisPresetId: enumText});
const transform = object({profileId: enumText, rotation: number,
  crop: object({left: number, right: number, top: number, bottom: number}),
  keyframes: list(object({frame: number, ...position, scale: number}), CLIP_TRANSFORM_LIMITS.keyframes)});
const transition = object({profileId: enumText, kind: enumText, durationFrames: number});
const colour = object({profileId: enumText,
  source: nullable(object({profileId: enumText, range: enumText, interpretation: enumText,
    streamIndex: number})),
  look: nullable(object({resourceId: identifier, resourceProfile: enumText, purpose: enumText,
    enabled: boolean, strength: number}))});
const volumeEnvelope = object({profileId: enumText,
  points: list(object({frame: number, multiplier: number}), VOLUME_ENVELOPE_LIMITS.points)});
const opacityEnvelope = object({profileId: enumText,
  points: list(object({frame: number, opacity: number}), OPACITY_ENVELOPE_LIMITS.points)});

// This projection also reads format-6 clip rows when the format-6 storage
// reader is available. It omits sync fingerprints and other host evidence.
const rate = object({numerator: number, denominator: number});
const boundary = object({kind: enumText, numerator: rationalTerm, denominator: rationalTerm, ticks: rationalTerm});
const timebase = object({fpsNumerator: number, fpsDenominator: number});
const viewBoundary = object({anchor: enumText, offsetOutputFrames: number});
const timing = object({profile: enumText, interpolation: enumText, pitchShift: boolean,
  basis: object({profile: enumText, sourceFps: timebase, outputFps: timebase,
    sourceRange: object({start: boundary, end: boundary}),
    speed: object({kind: enumText, rate, presetId: enumText, interpolation: enumText,
      points: list(object({sourceFrame: number, rate}), 256)})}),
  view: object({loTime: viewBoundary, hiTime: viewBoundary, direction: enumText}),
  outputWindow: object({fromFrame: number, toFrame: number}),
  sourceFrame: number, sourceVersionId: nullable(identifier)});

const audio: Shape = {gain: number, muted: boolean, fadeInFrames: number, fadeOutFrames: number,
  audioRole: nullable(enumText), volumeEnvelope: nullable(volumeEnvelope)};
const visual: Shape = {rect: object({...position, width: number, height: number}),
  layout: nullable(layout), transform: nullable(transform), transitionIn: nullable(transition),
  colour: nullable(colour), opacity: number, opacityEnvelope: nullable(opacityEnvelope), blendMode: enumText};
const time: Shape = {trackId: identifier, startFrame: number, durationFrames: number, sourceInFrame: number,
  sourceSpanFrames: number, anchor, timing: nullable(timing)};

const timelineFields: Readonly<Record<string, Shape>> = {
  timeline: {fps: number, width: number, height: number},
  timeline_clip: {...audio, ...visual, ...time, name: fileName, assetId: nullable(identifier),
    versionId: nullable(identifier), sourceState: enumText, soundOnly: boolean},
  timeline_clip_audio: audio,
  timeline_clip_visual: visual,
  timeline_clip_timing: time,
  timeline_subtitle: {text: text(512), startFrame: number, durationFrames: number, anchor,
    dialogueRef: object({shotId: identifier, lineId: identifier})},
  timeline_track: {name: text(150), kind: enumText, orderIndex: number, hidden: boolean, muted: boolean},
};
const recordFields: Readonly<Record<string, Shape>> = {
  project: {name: text(150), description: text(2000), notes: text(16384)},
  shot: {title: text(500), prompt: text(20000), duration: number, aspectRatio: text(10),
    position: object(position), orderIndex: number, selectedVersionId: nullable(identifier),
    referenceAssetIds: list(identifier, 8), lastFrameAssetId: nullable(identifier),
    dialogue: list(object({id: identifier, text: text(512), speakerSubjectId: nullable(identifier)}), 100)},
  node: {name: text(150), label: text(150), text: text(5000), type: enumText,
    position: object(position), assetId: nullable(identifier)},
  edge: {source: identifier, target: identifier, kind: enumText, role: enumText, orderIndex: number},
  asset: {name: fileName},
};

function json(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

const MAX_CURRENT_VALUE_BYTES = 24576;

/** Construct inside the transaction applying a claim. Use one saved timeline
 * read for its groups. The only returned data are bounded public editor fields. */
export function createCoEditingCurrentValueReader(store: ProjectStore):
  (target: Pick<AgentTaskTarget, 'kind' | 'id'>) => Fields | null {
  const readTarget = agentTaskDisplayTargetReader(store, store.projectId);
  const cache = new Map<string, Fields | null>();
  const {db, projectId} = store;
  function read({kind, id}: Pick<AgentTaskTarget, 'kind' | 'id'>): Fields | undefined {
    if (!uuid.test(id)) return undefined;
    if (Object.hasOwn(timelineFields, kind)) {
      return project(readTarget({kind: agentTaskEditingTargetRevisionKind(kind), id}), timelineFields[kind]!);
    }
    if (Object.hasOwn(recordFields, kind)) {
      const row = readTarget({kind, id});
      if (!row || (kind === 'node' || kind === 'shot') && isCanvasArchived(db, kind === 'node' ? 'nodes' : 'shots', id)
        || kind === 'edge' && isCanvasEdgeHidden(db, row)) return undefined;
      return project(row, recordFields[kind]!);
    }
    switch (kind) {
      case 'asset_range':
        return project(db.prepare('SELECT inFrame,outFrame FROM project.asset_ranges WHERE projectId=? AND assetId=?')
          .get(projectId, id), {inFrame: number, outFrame: number});
      case 'asset_annotation': {
        const row = db.prepare('SELECT tags,note FROM project.asset_annotations WHERE projectId=? AND assetId=?').get(projectId, id);
        return row ? project({...row, tags: json(row.tags)}, {
          tags: list(text(2 * ASSET_ANNOTATION_LIMITS.tagCodePoints), ASSET_ANNOTATION_LIMITS.tags),
          note: text(2 * ASSET_ANNOTATION_LIMITS.noteCodePoints),
        }) : undefined;
      }
      case 'asset_disposition':
        return project(db.prepare('SELECT disposition FROM project.asset_dispositions WHERE projectId=? AND assetId=?')
          .get(projectId, id), {disposition: enumText});
      case 'subject':
        return project(db.prepare('SELECT name,kind,headVersionId FROM project.subjects WHERE projectId=? AND id=?')
          .get(projectId, id), {name: text(500), kind: enumText, headVersionId: nullable(identifier)});
      case 'subject_binding': {
        const row = db.prepare('SELECT shotId,subjectId,role,bindingMode,subjectVersionId FROM project.subject_bindings WHERE projectId=? AND id=?')
          .get(projectId, id);
        if (!row || row.bindingMode === 'detached' || typeof row.shotId !== 'string' || isCanvasArchived(db, 'shots', row.shotId)) return undefined;
        return project(row, {shotId: identifier, subjectId: identifier, role: enumText, bindingMode: enumText,
          subjectVersionId: nullable(identifier)});
      }
      default:
        return undefined;
    }
  }
  return target => {
    const key = `${target.kind}:${target.id}`;
    const saved = cache.get(key);
    if (saved !== undefined) return saved;
    const fields = read(target);
    const bounded = fields && Object.keys(fields).length > 0 &&
      Buffer.byteLength(JSON.stringify(fields)) <= MAX_CURRENT_VALUE_BYTES ? fields : null;
    cache.set(key, bounded);
    return bounded;
  };
}

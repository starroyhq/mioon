/** Candidate-only routing for the existing bounded preflight lifecycle. This
 * performs the actual owned source preparation; a report grants no render
 * capability and never registers a worker attempt or prepared Map. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';
import {timelineAnyColourPlanSchema} from '../../contracts/src/timeline-colour.ts';
import {createTimelineColourLutReader,verifyTimelineColourLuts} from './timeline-colour-lut.ts';

type Value = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
interface PreparationOptions {
  readonly signal?: AbortSignal;
  readonly budget: unknown;
  readonly beforeEffect: (() => void) | undefined;
  readonly probe: unknown;
  readonly onChecked: () => void;
}
export const OPACITY_CANDIDATE_PREFLIGHT_MESSAGES = Object.freeze({
  TIMELINE_COLOUR_LOOK_UNAVAILABLE: 'The creative look is not an exact owned LUT resource in this project.',
  SOURCE_BOUNDS: 'A clip source in-point or duration exceeds the saved source frame range.',
  INVALID_FADE: 'Audio fade frames must be valid and fit inside the clip duration.',
  FADE_AUDIO_UNSUPPORTED: 'Nonzero fades require an audio or video source with confirmed audio.',
  AUDIO_ROLE_CLIP_UNSUPPORTED: 'Audio roles require an audio or video source rather than a still image.',
  TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED: 'Volume automation requires a source with confirmed supported audio.',
  VOLUME_ENVELOPE_SOURCE_UNSUPPORTED: 'Volume automation requires a verified supported audio stream.',
  INVALID_CLIP_TYPE: 'A source is not supported on its saved timeline track.',
});
const require = createRequire(import.meta.url);
const sources: unknown = require('./timeline-sources.ts');
const managed: unknown = require('./managed-media.ts');
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, part: unknown) => object(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)).digest('hex');
function invalid(): never {throw new AppError('INVALID_TIMELINE_SNAPSHOT', 'The candidate timeline snapshot is invalid.', 409);}
function method(module: unknown, name: string): Method {
  if (!object(module) || typeof module[name] !== 'function') return invalid();
  return module[name] as Method;
}

export function createOpacityCandidatePreflightRuntime(store: unknown) {
  const assembly = getOpacityCandidateAssembly(store);
  if (!assembly) return null;
  if (!object(store) || typeof store.root !== 'string' || !(store.db instanceof DatabaseSync)) return invalid();
  const root = store.root, db = store.db, domain = createOpacityCandidateDomain(store);
  const snapshots = new WeakMap<object, {readonly inputDigest: string; readonly projection: Value | null; readonly check: () => void}>();
  const checkpoint = (): void => {assembly.checkpoint();};
  const effect = (input: Value, additional?: () => void): (() => void) => {
    checkpoint();assembly.refuseOperation('timeline.export.preflight', input);
    const fence = assembly.effectFence();
    return (): void => {checkpoint();assembly.refuseOperation('timeline.export.preflight', input);fence?.();additional?.();fence?.();};
  };
  function validationSnapshot(initial: unknown, input?: Value): Value {
    checkpoint();
    if (!object(initial)) return invalid();
    const proof = snapshots.get(initial);
    if (!proof || !proof.projection || input !== undefined && proof.inputDigest !== digest(input)) return invalid();
    proof.check();return proof.projection;
  }
  function assertPrepared(initial: unknown, input: Value, prepared: unknown, beforeEffect?: () => void): void {
    const check = effect(input, beforeEffect);check();
    const projection = validationSnapshot(initial, input);
    if (!(prepared instanceof Map)) return invalid();
    // Reuse the exact graph, LUT and frozen source checks used by candidate
    // worker authority, then pin every source inode even without colourPlan.
    method(sources, 'validatePreparedTimelineSources')(db, input.projectId, projection, prepared, {root});
    for (const [id, value] of prepared) {
      check();
      const current = method(sources, 'readOwnedTimelineAsset')(db, input.projectId, id);
      if (!object(value) || !object(value.opacitySourceIdentity) || !object(current)) return invalid();
      const actual = method(managed, 'validateManagedSource')(root, current);
      if (!object(actual) || method(managed, 'sameManagedFile')(value.opacitySourceIdentity, actual.info) !== true)
        throw new AppError('MANAGED_SOURCE_CHANGED', 'A verified source changed during the bounded check.', 409);
    }
    if (projection.colourPlan !== undefined) {
      if (typeof input.projectId !== 'string') return invalid();
      verifyTimelineColourLuts(timelineAnyColourPlanSchema.parse(projection.colourPlan), createTimelineColourLutReader(db, input.projectId), true);
    }
    check();
  }
  return Object.freeze({
    parse(input: unknown): Value {checkpoint();return domain.parse('timeline.export.preflight', input);},
    begin(input: unknown): (() => void) | undefined {
      checkpoint();assembly.refuseOperation('timeline.export.preflight', input);return assembly.effectFence();
    },
    readSnapshot(input: unknown): unknown {
      const parsed = domain.parse('timeline.export.preflight', input), check = effect(parsed);check();
      const initial = domain.readPreflightSnapshot(parsed);check();
      const projection = object(initial.legacyValidationSnapshot) ? initial.legacyValidationSnapshot : null;
      snapshots.set(initial, {inputDigest: digest(parsed), projection, check});return initial;
    },
    validationSnapshot,
    async prepare(initial: unknown, input: Value, options: PreparationOptions): Promise<unknown> {
      const check = effect(input, options.beforeEffect);check();
      if (typeof input.projectId !== 'string') return invalid();
      if (typeof options.probe !== 'function') return invalid();
      const probe = options.probe as Method;
      const projection = validationSnapshot(initial, input);
      return method(sources, 'prepareTimelineInputs')(projection, {root, projectId: input.projectId,
        signal: options.signal, budget: options.budget, beforeEffect: check,
        readAsset: (id: unknown) => {check();return method(sources, 'readOwnedTimelineAsset')(db, input.projectId, id);},
        validateLinks: (timeline: unknown) => {check();method(sources, 'validateFrozenTimelineSourceGraph')(db, input.projectId, timeline);},
        readLut: createTimelineColourLutReader(db, input.projectId),
        probe: async (file: unknown, probeOptions: unknown): Promise<unknown> => {
          if (!object(probeOptions)) return invalid();
          check();const result = await probe(file, {...probeOptions, beforeEffect: check});check();return result;
        }, onChecked: options.onChecked, retainOpacitySourceIdentity: true});
    },
    assertPrepared,
  });
}

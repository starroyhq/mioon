import {z} from 'zod';
import {TIMELINE_OUTPUT_RATIOS} from './timeline-output-geometry.ts';
import {parseVideoBinding} from './video-providers.ts';
import {effectiveVideoParameters} from './wan-video.ts';

export const generationFixedAspectRatioSchema = z.enum(TIMELINE_OUTPUT_RATIOS);
export const generationAspectRatioSchema = z.enum([...TIMELINE_OUTPUT_RATIOS, 'adaptive']);

export const generationAspectSourceSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('project'), expectedTimelineRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), aspectRatio: generationFixedAspectRatioSchema}).strict(),
  z.object({kind: z.literal('shot')}).strict(),
  z.object({kind: z.literal('explicit'), aspectRatio: generationAspectRatioSchema}).strict(),
]).describe('Aspect source for this generation only. For a new generation, default to project: read timeline.format.get and pass its reviewed revision and ratio. Shot keeps the saved shot ratio. Explicit uses a user-selected ratio without editing the shot; adaptive requires model support. Omission preserves legacy generation behavior.');

export type GenerationAspectSource = z.infer<typeof generationAspectSourceSchema>;
export type GenerationAspectRatio = z.infer<typeof generationAspectRatioSchema>;
type FixedAspectRatio = z.infer<typeof generationFixedAspectRatioSchema>;
type GenerationAspectRejection =
  | {code: 'PROJECT_ASPECT_CHANGED'; projectAspectRatio: FixedAspectRatio; timelineRevision: number}
  | {code: 'PROJECT_ASPECT_UNSUPPORTED'; projectAspectRatio: FixedAspectRatio; supportedAspectRatios: GenerationAspectRatio[]}
  | {code: 'GENERATION_ASPECT_UNSUPPORTED'; aspectRatio: GenerationAspectRatio; supportedAspectRatios: GenerationAspectRatio[]};

const ownValue = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const safeSource = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
const allowedRatios = z.array(generationAspectRatioSchema).max(7);

/** Read an exact, request-bound rejection without exposing arbitrary error details. */
export function readGenerationAspectRejection(error: unknown, input: unknown, projectId: string): GenerationAspectRejection | null {
  const code = ownValue(error, 'code'), status = ownValue(error, 'status'), details = ownValue(error, 'details');
  const requestId = ownValue(input, 'requestId'), shotId = ownValue(input, 'shotId'), aspectSource = ownValue(input, 'aspectSource');
  if (!projectId || ownValue(details, 'projectId') !== projectId
    || typeof requestId !== 'string' || !requestId || typeof shotId !== 'string' || !shotId
    || ownValue(details, 'requestId') !== requestId || ownValue(details, 'shotId') !== shotId
    || ownValue(details, 'mutationOutcome') !== 'not_applied' || !safeSource(aspectSource)) return null;
  const source = generationAspectSourceSchema.safeParse(aspectSource);
  if (!source.success) return null;
  const value = source.data;
  if (code === 'PROJECT_ASPECT_CHANGED' && status === 409 && value.kind === 'project') {
    const revision = ownValue(details, 'timelineRevision');
    const ratio = generationFixedAspectRatioSchema.safeParse(ownValue(details, 'projectAspectRatio'));
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || !ratio.success
      || revision === value.expectedTimelineRevision && ratio.data === value.aspectRatio) return null;
    return {code, projectAspectRatio: ratio.data, timelineRevision: revision};
  }
  if (status !== 400) return null;
  const ratios = ownValue(details, 'supportedAspectRatios');
  if (!Array.isArray(ratios) || ratios.length > 7) return null;
  const supported = allowedRatios.safeParse(Array.from({length: ratios.length}, (_, index) => ownValue(ratios, String(index))));
  if (!supported.success || new Set(supported.data).size !== supported.data.length) return null;
  if (code === 'PROJECT_ASPECT_UNSUPPORTED' && value.kind === 'project') {
    if (ownValue(details, 'projectAspectRatio') !== value.aspectRatio || supported.data.includes(value.aspectRatio)) return null;
    return {code, projectAspectRatio: value.aspectRatio, supportedAspectRatios: supported.data};
  }
  if (code !== 'GENERATION_ASPECT_UNSUPPORTED' || value.kind === 'project') return null;
  const ratioSchema = value.kind === 'shot' ? generationFixedAspectRatioSchema : generationAspectRatioSchema;
  const ratio = ratioSchema.safeParse(ownValue(details, 'aspectRatio'));
  if (!ratio.success || supported.data.includes(ratio.data) || value.kind === 'explicit' && value.aspectRatio !== ratio.data) return null;
  return {code, aspectRatio: ratio.data, supportedAspectRatios: supported.data};
}

export function isGenerationAspectNotApplied(error: unknown, input: unknown, projectId: string): boolean {
  return readGenerationAspectRejection(error, input, projectId) !== null;
}

/** Bind a job to the original aspect-aware submission before releasing its
 * recovery record. The current shot and current project frame can both differ. */
export function readGenerationAspectResponseRatio(input: unknown, result: unknown, projectId: string): GenerationAspectRatio | null {
  const aspectSource = ownValue(input, 'aspectSource');
  if (!projectId || !safeSource(aspectSource)) return null;
  const source = generationAspectSourceSchema.safeParse(aspectSource);
  if (!source.success || !safeSource(result)) return null;
  const job = result as Record<string, unknown>;
  const requestId = ownValue(input, 'requestId'), shotId = ownValue(input, 'shotId'), providerId = ownValue(input, 'providerId');
  const model = ownValue(input, 'model'), revision = ownValue(input, 'expectedRevision');
  if (!z.string().uuid().safeParse(job.id).success || job.projectId !== projectId || job.retryOfJobId !== null
    || typeof requestId !== 'string' || !requestId || job.requestId !== requestId || job.shotId !== shotId
    || typeof shotId !== 'string' || typeof providerId !== 'string' || job.providerId !== providerId
    || typeof job.model !== 'string' || !job.model || model && job.model !== model
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || !safeSource(job.snapshot)) return null;
  const snapshot = job.snapshot as Record<string, unknown>;
  const ratio = generationFixedAspectRatioSchema.safeParse(snapshot.aspectRatio);
  if (!ratio.success || snapshot.shotId !== shotId || snapshot.shotRevision !== revision
    || snapshot.providerId !== providerId || snapshot.model !== job.model) return null;
  const connectionId = ownValue(input, 'connectionId');
  let effective: unknown = ratio.data;
  if (connectionId !== undefined) {
    try {
      const binding = parseVideoBinding(snapshot.executionBinding);
      if (binding.connectionId !== connectionId || binding.configurationRevision !== ownValue(input, 'configurationRevision')
        || binding.model.id !== ownValue(input, 'modelEntryId') || binding.providerId !== providerId
        || binding.model.modelId !== job.model) return null;
      effective = effectiveVideoParameters(binding, snapshot).aspectRatio;
    } catch { return null; }
  } else if (Object.hasOwn(snapshot, 'executionBinding')) return null;
  const expected = source.data.kind === 'shot' ? ratio.data : source.data.aspectRatio;
  return effective === expected && (expected === 'adaptive' || ratio.data === expected) ? expected : null;
}

export function isGenerationAspectResponse(input: unknown, result: unknown, projectId: string): boolean {
  return readGenerationAspectResponseRatio(input, result, projectId) !== null;
}

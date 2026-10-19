import {z} from 'zod';

// Source ranges use the output timeline's clock, not native/VFR frame indexes.
export const SOURCE_RANGE_FPS = 30;
export function sourceFrameCount(duration: unknown): number | null {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
  // Ignore only binary rounding at an exact timeline-frame boundary. A partial
  // final frame cannot provide a complete 30fps output frame.
  const frames = Math.floor(duration * SOURCE_RANGE_FPS + 1e-6);
  return Number.isSafeInteger(frames) && frames >= 1 ? frames : null;
}

const id = z.string().uuid();
const frame = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sourceRangeSchemas = Object.freeze({
  'asset.range.get': z.object({projectId:id,assetId:id}).strict(),
  'asset.range.set': z.object({
    projectId:id,assetId:id,
    expectedRevision:frame.describe('Source-range revision, starting at 0 when no range has been saved. Independent of project, asset and timeline revisions.'),
    requestId:z.string().min(8).max(200).describe('Required stable replay key (8–200 characters). Exact retries return the immutable original response, including after later range edits or restart. Changed operation, project or input conflicts; no keyless mutation is supported.'),
    inFrame:frame.describe('Inclusive source in point in the 30fps timeline timebase; not a native/VFR frame index.'),
    outFrame:frame.describe('Exclusive source out point in the 30fps timeline timebase; greater than inFrame and no greater than sourceFrameCount.'),
  }).strict().refine(value=>value.outFrame>value.inFrame,{path:['outFrame'],message:'Source range must contain at least one complete frame.'}),
});

export type SourceRangeGetInput = z.infer<typeof sourceRangeSchemas['asset.range.get']>;
export type SourceRangeSetInput = z.infer<typeof sourceRangeSchemas['asset.range.set']>;
export interface SourceRange {inFrame: number; outFrame: number}
export interface SourceRangeResponse {
  id: string;
  assetId: string;
  projectId: string;
  revision: number;
  range: SourceRange | null;
  sourceFrameCount: number;
  fps: typeof SOURCE_RANGE_FPS;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
// Strict acknowledgement envelope. Returning a historical revision is allowed;
// neither this guard nor request replay asserts that a result is the latest one.
export function isSourceRangeResponse(value: unknown): value is SourceRangeResponse {
  if (!exactKeys(value,['id','assetId','projectId','revision','range','sourceFrameCount','fps']) ||
      typeof value.assetId !== 'string' || !value.assetId || value.id !== value.assetId ||
      typeof value.projectId !== 'string' || !value.projectId ||
      !integer(value.revision) || value.revision < 0 ||
      !integer(value.sourceFrameCount) || value.sourceFrameCount < 1 || value.fps !== SOURCE_RANGE_FPS) return false;
  if (value.revision === 0) return value.range === null;
  return exactKeys(value.range,['inFrame','outFrame']) && integer(value.range.inFrame) &&
    value.range.inFrame >= 0 && integer(value.range.outFrame) &&
    value.range.outFrame > value.range.inFrame && value.range.outFrame <= value.sourceFrameCount;
}

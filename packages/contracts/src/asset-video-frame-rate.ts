import {z} from 'zod';

// FFprobe reports the source rate as an AVRational, whose terms are signed 32-bit integers.
const frameRatePart = z.number().int().positive().max(0x7fffffff);
export const assetVideoFrameRateSchema = z.object({
  numerator: frameRatePart,
  denominator: frameRatePart,
  nearestInteger: z.number().int().nonnegative().max(0x7fffffff),
}).strict().refine(({numerator, denominator, nearestInteger}) => nearestInteger === Math.round(numerator / denominator),
  'The nearest integer must match the source frame rate.');
export type AssetVideoFrameRate = z.infer<typeof assetVideoFrameRateSchema>;

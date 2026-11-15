import {z} from 'zod';
import {canvasArchiveNodeTypeSchema} from './canvas-editing.ts';
import {CANVAS_GRID} from './canvas-position.ts';
import {previsNodeRecordSchema} from './previs.ts';
import {projectIdSchema} from './project-file.ts';
import {shotGenerationParametersSchema} from './shot-generation-parameters.ts';

const coordinate = z.number().finite().min(-CANVAS_GRID.coordinateLimit).max(CANVAS_GRID.coordinateLimit);
export const canvasCopyPositionSchema = z.object({x: coordinate, y: coordinate}).strict();

// Projection schemas intentionally strip every field outside the copy allowlist.
export const canvasCopyShotFields = z.object({
  title: z.string().min(1).max(150),
  prompt: z.string().max(5000),
  aspectRatio: z.enum(['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']),
  duration: z.number().int().min(1).max(20),
  parameters: shotGenerationParametersSchema.strip(),
  referenceAssetIds: z.array(projectIdSchema).max(8),
  lastFrameAssetId: projectIdSchema.nullable().optional(),
  position: canvasCopyPositionSchema,
});
export const canvasCopyNodeFields = z.object({
  type: canvasArchiveNodeTypeSchema.exclude(['previs']), label: z.string().max(150), text: z.string().max(5000),
  assetId: projectIdSchema.nullable().optional(), position: canvasCopyPositionSchema,
});
export const canvasCopyPrevisFields = previsNodeRecordSchema.innerType()
  .pick({type: true, label: true, text: true, scene: true}).strip().extend({position: canvasCopyPositionSchema});

export type CanvasCopyShotFields = z.infer<typeof canvasCopyShotFields>;
export type CanvasCopyNodeFields = z.infer<typeof canvasCopyNodeFields> | z.infer<typeof canvasCopyPrevisFields>;

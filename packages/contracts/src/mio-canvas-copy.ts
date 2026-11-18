import {z} from 'zod';
import {CANVAS_GRID} from './canvas-position.ts';
import {MIO_CANVAS_SELECTION_LIMIT} from './mio-canvas.ts';
import {projectIdSchema} from './project-file.ts';

const target = z.object({kind: z.enum(['shot', 'node', 'edge']), id: projectIdSchema}).strict();
const targets = z.array(target).min(1).max(MIO_CANVAS_SELECTION_LIMIT)
  .refine(values => new Set(values.map(({kind, id}) => `${kind}:${id}`)).size === values.length);
const coordinate = z.number().finite().min(-CANVAS_GRID.coordinateLimit).max(CANVAS_GRID.coordinateLimit);
const extent = z.number().finite().positive().max(2 * CANVAS_GRID.coordinateLimit);
const viewport = z.object({x: coordinate, y: coordinate, width: extent, height: extent}).strict()
  .refine(value => value.x + value.width <= CANVAS_GRID.coordinateLimit && value.y + value.height <= CANVAS_GRID.coordinateLimit);

/** Clipboard bytes, document ownership and replay identity stay with the host. */
export const mioCanvasCopySchemas = Object.freeze({
  'canvas.copy.snapshot': z.object({targets}).strict(),
  'canvas.paste': z.object({snapshotId: projectIdSchema, viewport}).strict(),
  'canvas.duplicate': z.object({targets, viewport}).strict(),
});
export type MioCanvasCopyOperation = keyof typeof mioCanvasCopySchemas;
export type MioCanvasCopyInput = {
  [Operation in MioCanvasCopyOperation]: {operation: Operation; input: z.infer<(typeof mioCanvasCopySchemas)[Operation]>}
}[MioCanvasCopyOperation];
export const mioCanvasCopyOperations = Object.freeze(Object.keys(mioCanvasCopySchemas) as MioCanvasCopyOperation[]);
export const isMioCanvasCopyOperation = (operation: string): operation is MioCanvasCopyOperation =>
  Object.hasOwn(mioCanvasCopySchemas, operation);

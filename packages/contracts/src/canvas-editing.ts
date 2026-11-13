import {z} from 'zod';
import {CANVAS_GRID} from './canvas-position.ts';
import {projectIdSchema} from './project-file.ts';

export const CANVAS_EDIT_LIMITS = Object.freeze({
  targets: 4096, effects: 16384, archivedPage: 100, historyEntries: 100,
  historyBytes: 8 * 1024 * 1024, receiptRows: 65536, receiptBytes: 32 * 1024 * 1024,
});

const revision = z.number().int().safe().nonnegative();
const id = projectIdSchema;
const requestId = z.string().min(8).max(200).refine(value =>
  !value.includes('\u0000') && [...value].length >= 8 && (value as string & {isWellFormed(): boolean}).isWellFormed());
const kind = z.enum(['shot', 'node', 'edge']);
const target = z.object({kind, id}).strict();
const selected = z.array(target.extend({revision})).min(1).max(CANVAS_EDIT_LIMITS.targets);
const coordinate = z.number().finite().min(-CANVAS_GRID.coordinateLimit).max(CANVAS_GRID.coordinateLimit);
const position = z.object({x: coordinate, y: coordinate}).strict();
const moves = z.array(target.extend({kind: z.enum(['shot', 'node']), revision, position})).min(1).max(CANVAS_EDIT_LIMITS.targets);
const project = {projectId: id};
const commit = {...project, requestId, historyRevision: revision};
const confirmation = z.string().min(1).max(512);
const archiveAction = {targets: selected, confirmation: confirmation.optional()};
const archiveCursor = z.object({id, kind}).strict();

export const canvasEditingSchemas = Object.freeze({
  'canvas.archive.preview': z.discriminatedUnion('operation', [
    z.object({...project, operation: z.literal('archive'), targets: selected}).strict(),
    z.object({...project, operation: z.literal('restore'), targets: selected, batchId: id.optional()}).strict(),
  ]),
  'canvas.archive.list': z.object({...project, after: archiveCursor.optional(), limit: z.number().int().positive().max(CANVAS_EDIT_LIMITS.archivedPage).optional()}).strict(),
  'canvas.apply': z.discriminatedUnion('operation', [
    z.object({...commit, operation: z.literal('archive'), ...archiveAction}).strict(),
    z.object({...commit, operation: z.literal('restore'), ...archiveAction, batchId: id.optional()}).strict(),
    z.object({...commit, operation: z.literal('move'), moves}).strict(),
    z.object({...commit, operation: z.literal('layout'), moves, contentSequence: revision, contentToken: z.string().regex(/^[0-9a-f]{32}$/u)}).strict(),
  ]),
  'canvas.history.get': z.object(project).strict(),
  'canvas.history.undo': z.object(commit).strict(),
  'canvas.history.redo': z.object(commit).strict(),
});

export type CanvasEditingOperation = keyof typeof canvasEditingSchemas;
export type CanvasEditInput = z.infer<typeof canvasEditingSchemas['canvas.apply']>;
export type CanvasHistoryInput = z.infer<typeof canvasEditingSchemas['canvas.history.undo']>;
export type CanvasArchivePreviewInput = z.infer<typeof canvasEditingSchemas['canvas.archive.preview']>;
export type CanvasArchiveListInput = z.infer<typeof canvasEditingSchemas['canvas.archive.list']>;
export type CanvasTarget = z.infer<typeof target>;
export type CanvasTargetExpectation = z.infer<typeof selected>[number];
export interface CanvasEditBase {
  readonly contentSequence: number;
  readonly contentToken: string;
  readonly targets: readonly CanvasTargetExpectation[];
}

export const canvasEditingWrites = Object.freeze(['canvas.apply', 'canvas.history.undo', 'canvas.history.redo'] as const);
export const isCanvasEditingOperation = (value: string): value is CanvasEditingOperation => Object.hasOwn(canvasEditingSchemas, value);

const historyAction = z.object({id, operation: z.enum(['archive', 'restore', 'move', 'layout', 'paste']), count: z.number().int().nonnegative()}).strict();
const historyResponse = z.object({revision, undo: historyAction.nullable(), redo: historyAction.nullable(),
  conflict: z.boolean()}).strict();
const blocked = z.object({kind: z.string(), id: z.string(), reason: z.string()}).strict();
const archiveInfo = z.object({at: z.string().datetime(), batchId: id, reason: z.enum(['user-delete', 'undo-create', 'reference-source'])}).strict();
const result = z.object({projectId: id, actionId: id.nullable(), affected: z.number().int().nonnegative(),
  history: historyResponse, contentSequence: revision, contentToken: z.string().regex(/^[0-9a-f]{32}$/u)}).strict();
export const canvasEditingResponses = Object.freeze({
  'canvas.archive.preview': z.object({projectId: id, targets: selected, affected: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(), clips: z.number().int().nonnegative(),
    blocked: z.array(blocked), confirmation: confirmation.nullable(), historyRevision: revision}).strict(),
  'canvas.archive.list': z.object({projectId: id, next: archiveCursor.nullable(),
    items: z.array(target.extend({archive: archiveInfo, revision, label: z.string()})).max(CANVAS_EDIT_LIMITS.archivedPage)}).strict(),
  'canvas.apply': result,
  'canvas.history.get': historyResponse,
  'canvas.history.undo': result,
  'canvas.history.redo': result,
});
export type CanvasEditResult = z.infer<typeof result>;
export type CanvasHistoryView = z.infer<typeof historyResponse>;
export type CanvasEditingResponse<T extends CanvasEditingOperation> = z.infer<(typeof canvasEditingResponses)[T]>;

import {z} from 'zod';
import {AppError} from './app-error.ts';
import {isNormalizedAbsolutePath} from './media-reference.ts';

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u);
const signedDecimal = z.string().regex(/^(?:0|-?[1-9][0-9]{0,39})$/u);
export const projectTrashFileGenerationSchema = z.object({
  dev: decimal, ino: decimal, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mtimeNs: signedDecimal, ctimeNs: signedDecimal, birthtimeNs: signedDecimal,
}).strict();
export const projectTrashReserveInputSchema = z.object({requestId: z.string().uuid(), projectId: z.string().uuid()}).strict();
export const projectTrashRequestSchema = projectTrashReserveInputSchema.extend({
  projectFile: z.string().min(1).max(4096).refine(isNormalizedAbsolutePath).refine(file => file.endsWith('.mioon')),
  fileIdentity: projectTrashFileGenerationSchema,
}).strict();
export type ProjectTrashFileGeneration = z.infer<typeof projectTrashFileGenerationSchema>;
export type ProjectTrashRequest = z.infer<typeof projectTrashRequestSchema>;
const id = z.string().uuid(), deadline = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Private owned-utility envelopes; these are not renderer or HTTP schemas. */
export const projectTrashCommandSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('project-trash:reserve'), version: z.literal(1), messageId: id, deadline, input: projectTrashReserveInputSchema}).strict(),
  z.object({type: z.literal('project-trash:trash'), version: z.literal(1), messageId: id, deadline, reservationId: id, input: projectTrashRequestSchema}).strict(),
  z.object({type: z.literal('project-trash:release'), version: z.literal(1), messageId: id, deadline, reservationId: id, input: projectTrashReserveInputSchema}).strict(),
]);
export const projectTrashReplySchema = z.discriminatedUnion('ok', [
  z.object({type: z.literal('project-trash:reply'), version: z.literal(1), messageId: id, ok: z.literal(true), reservationId: id.nullable()}).strict(),
  z.object({type: z.literal('project-trash:reply'), version: z.literal(1), messageId: id, ok: z.literal(false),
    refused: z.enum(['PROJECT_HOST_BUSY', 'PROJECT_TRASH_SOURCE_CHANGED', 'PROJECT_TRASH_UNAVAILABLE']).nullable()}).strict(),
]);
export type ProjectTrashCommand = z.infer<typeof projectTrashCommandSchema>;
export type ProjectTrashReply = z.infer<typeof projectTrashReplySchema>;
export interface ProjectTrashReservation {
  trash(request: ProjectTrashRequest): Promise<void>;
  release(): void;
}
/** Main-owned window reservation; never a renderer capability. */
export interface ProjectTrashPort {
  reserve(input: z.infer<typeof projectTrashReserveInputSchema>): Promise<ProjectTrashReservation>;
}
export type ProjectTrashRefusedCode = 'PROJECT_HOST_BUSY' | 'PROJECT_TRASH_SOURCE_CHANGED' | 'PROJECT_TRASH_UNAVAILABLE';
const refusedMessages: Record<ProjectTrashRefusedCode, string> = {
  PROJECT_HOST_BUSY: '项目仍在窗口中打开或有项目操作正在进行，请先关闭项目。',
  PROJECT_TRASH_SOURCE_CHANGED: '项目文件已改变，未移到废纸篓。',
  PROJECT_TRASH_UNAVAILABLE: '当前环境暂不支持将项目文件移到废纸篓。',
};
/** Only main's pre-dispatch refusal establishes that no OS call occurred. */
export class ProjectTrashRefusedError extends AppError {
  declare code: ProjectTrashRefusedCode;
  constructor(code: ProjectTrashRefusedCode) {super(code, refusedMessages[code], 409);}
}

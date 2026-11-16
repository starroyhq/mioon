import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

export const DESKTOP_UPDATE_CHANNEL = 'mioon:desktop-update:v1';
export const DESKTOP_UPDATE_EVENT = 'mioon:desktop-update-state:v1';
export const DESKTOP_UPDATE_RELEASES = 'https://github.com/starroyhq/mioon/releases';
export const desktopReleaseVersionSchema = z.string().max(32).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);

export const desktopUpdateOfferSchema = z.object({
  version: desktopReleaseVersionSchema,
  currentVersion: z.string().min(1).max(64),
  notes: z.array(z.string().min(1).max(480)).max(8).readonly(),
  releaseDate: z.string().max(64).optional(),
  sizeBytes: z.number().int().positive().optional(),
}).strict();
export type DesktopUpdateOffer = z.infer<typeof desktopUpdateOfferSchema>;

export const desktopUpdateStateSchema = z.union([
  z.object({kind: z.literal('disabled')}).strict(),
  z.object({kind: z.literal('idle')}).strict(),
  z.object({kind: z.literal('checking')}).strict(),
  z.object({kind: z.literal('available'), offer: desktopUpdateOfferSchema}).strict(),
  z.object({kind: z.literal('downloading'), offer: desktopUpdateOfferSchema, percent: z.number().min(0).max(100),
    secondsRemaining: z.number().int().nonnegative().nullable(),
    transferredBytes: z.number().int().nonnegative().optional(), totalBytes: z.number().int().positive().optional()}).strict(),
  z.object({kind: z.literal('ready'), offer: desktopUpdateOfferSchema, installOnQuit: z.boolean()}).strict(),
  z.object({kind: z.literal('failed'), stage: z.literal('check')}).strict(),
  z.object({kind: z.literal('failed'), stage: z.literal('download'), offer: desktopUpdateOfferSchema}).strict(),
]);
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export const desktopUpdateActivitySchema = z.object({exports: z.boolean(), generations: z.boolean()}).strict();
export type DesktopUpdateActivity = z.infer<typeof desktopUpdateActivitySchema>;
export const desktopUpdateNoticeSchema = z.object({
  id: z.number().int().positive(), kind: z.enum(['launch', 'manual', 'ready']),
}).strict();
export type DesktopUpdateNotice = z.infer<typeof desktopUpdateNoticeSchema>;
export const desktopUpdateViewSchema = z.object({
  revision: z.number().int().nonnegative(), currentVersion: z.string().min(1).max(64), state: desktopUpdateStateSchema,
  notice: desktopUpdateNoticeSchema.nullable(), activity: desktopUpdateActivitySchema,
}).strict();
export type DesktopUpdateView = z.infer<typeof desktopUpdateViewSchema>;

export const desktopUpdateRequestSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('read')}).strict(),
  z.object({kind: z.literal('check')}).strict(),
  z.object({kind: z.literal('download'), expectedVersion: desktopReleaseVersionSchema}).strict(),
  z.object({kind: z.literal('cancel')}).strict(),
  z.object({kind: z.literal('install'), expectedVersion: desktopReleaseVersionSchema, mode: z.enum(['now', 'on-quit']),
    acknowledgeExports: z.boolean().optional()}).strict(),
]);
export type DesktopUpdateRequest = z.infer<typeof desktopUpdateRequestSchema>;
export const desktopUpdateReopenSchema = z.object({
  version: z.literal(1), installedVersion: desktopReleaseVersionSchema, requestedAt: z.number().int().nonnegative(),
  projectIds: z.array(projectIdSchema).max(128),
}).strict();
export type DesktopUpdateReopen = z.infer<typeof desktopUpdateReopenSchema>;
export const desktopUpdateErrorSchema = z.object({
  code: z.enum(['UPDATE_UNAVAILABLE', 'UPDATE_INVALID', 'UPDATE_VERSION_CHANGED', 'UPDATE_NOT_SAVED', 'UPDATE_EXPORT_ACTIVE']),
  status: z.union([z.literal(400), z.literal(409), z.literal(503)]),
}).strict();
export type DesktopUpdateError = z.infer<typeof desktopUpdateErrorSchema>;
export const desktopUpdateReplySchema = z.discriminatedUnion('ok', [
  z.object({ok: z.literal(true), data: desktopUpdateViewSchema}).strict(),
  z.object({ok: z.literal(false), error: desktopUpdateErrorSchema}).strict(),
]);
export type DesktopUpdateReply = z.infer<typeof desktopUpdateReplySchema>;
export type DesktopUpdateInstallMode = 'now' | 'on-quit';

export interface DesktopUpdateBridge {
  read(): Promise<DesktopUpdateView>;
  subscribe(listener: (view: DesktopUpdateView) => void): () => void;
  check(): Promise<DesktopUpdateView>;
  download(expectedVersion: string): Promise<DesktopUpdateView>;
  cancel(): Promise<DesktopUpdateView>;
  install(expectedVersion: string, mode: DesktopUpdateInstallMode, acknowledgeExports?: boolean): Promise<DesktopUpdateView>;
}

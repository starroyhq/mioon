import { z } from 'zod';

const tool = z.object({path:z.string().max(4096),version:z.string().max(1024).nullable(),available:z.boolean()}).strict();
export const mediaToolDiagnosticsSchema=z.object({ffmpeg:tool,ffprobe:tool,capabilities:z.object({libx264:z.boolean(),aac:z.boolean(),drawtext:z.boolean(),subtitles:z.boolean()}).strict()}).strict();
export type MediaToolDiagnostics=z.infer<typeof mediaToolDiagnosticsSchema>;
export const workspaceInfoSchema=z.object({version:z.string().min(1).max(100),channel:z.enum(['web','development','production']),dataDirectory:z.string().min(1).max(4096),pendingProjectCleanup:z.number().int().nonnegative().safe(),
  usage:z.object({bytes:z.number().int().nonnegative().safe(),files:z.number().int().nonnegative().safe(),complete:z.boolean()}).strict(),
  tools:z.object({ffmpeg:z.string().max(4096),ffprobe:z.string().max(4096)}).strict()}).strict();
export type WorkspaceInfo=z.infer<typeof workspaceInfoSchema>;
export const WORKSPACE_TOOLS_CHANNEL='mioon:workspace-tools';
export const toolPathsSchema=z.object({ffmpeg:z.string().min(1).max(4096),ffprobe:z.string().min(1).max(4096)}).strict();
export type ToolPaths=z.infer<typeof toolPathsSchema>;
// Mioon's own FFmpeg build, offered as a pinned download on supported platforms.
export const MEDIA_TOOLS_INSTALL_PHASES=['idle','downloading','verifying','installing','checking','completed','failed','cancelled'] as const;
export type MediaToolsInstallPhase=typeof MEDIA_TOOLS_INSTALL_PHASES[number];
const failureCode=z.string().regex(/^[A-Z0-9_]{1,64}$/u);
export const mediaToolsOfferSchema=z.object({version:z.string().min(1).max(64),ffmpegVersion:z.string().min(1).max(64),arch:z.enum(['arm64','x64']),
  downloadBytes:z.number().int().positive().safe(),license:z.string().min(1).max(64),sourceUrl:z.string().url().max(512).startsWith('https://')}).strict();
export type MediaToolsOffer=z.infer<typeof mediaToolsOfferSchema>;
export const mediaToolsProgressSchema=z.object({phase:z.enum(MEDIA_TOOLS_INSTALL_PHASES),receivedBytes:z.number().int().nonnegative().safe(),
  totalBytes:z.number().int().nonnegative().safe(),code:failureCode.nullable()}).strict();
export type MediaToolsProgress=z.infer<typeof mediaToolsProgressSchema>;
export const mediaToolsStatusSchema=z.object({offer:mediaToolsOfferSchema.nullable(),installed:toolPathsSchema.nullable(),progress:mediaToolsProgressSchema}).strict();
export type MediaToolsStatus=z.infer<typeof mediaToolsStatusSchema>;
export const mediaToolsInstallResultSchema=z.discriminatedUnion('ok',[
  z.object({ok:z.literal(true),paths:toolPathsSchema,diagnostics:mediaToolDiagnosticsSchema}).strict(),
  z.object({ok:z.literal(false),code:failureCode}).strict(),
]);
export type MediaToolsInstallResult=z.infer<typeof mediaToolsInstallResultSchema>;
export const workspaceToolsRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('read')}).strict(),
  z.object({action:z.literal('select'),tool:z.enum(['ffmpeg','ffprobe'])}).strict(),
  z.object({action:z.enum(['check','save']),paths:toolPathsSchema}).strict(),
  z.object({action:z.literal('revealWorkspace')}).strict(),
  z.object({action:z.literal('mediaToolsStatus')}).strict(),
  z.object({action:z.literal('installMediaTools')}).strict(),
  z.object({action:z.literal('cancelMediaToolsInstall')}).strict(),
]);
export interface WorkspaceToolsBridge {
  read():Promise<ToolPaths>;
  select(tool:'ffmpeg'|'ffprobe'):Promise<string|null>;
  check(paths:ToolPaths):Promise<MediaToolDiagnostics>;
  save(paths:ToolPaths):Promise<MediaToolDiagnostics>;
  revealWorkspace():Promise<boolean>;
  /** Download, verify and install Mioon's FFmpeg build, then save its paths. */
  mediaToolsStatus():Promise<MediaToolsStatus>;
  installMediaTools():Promise<MediaToolsInstallResult>;
  cancelMediaToolsInstall():Promise<boolean>;
}

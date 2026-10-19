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
export const workspaceToolsRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('read')}).strict(),
  z.object({action:z.literal('select'),tool:z.enum(['ffmpeg','ffprobe'])}).strict(),
  z.object({action:z.enum(['check','save']),paths:toolPathsSchema}).strict(),
  z.object({action:z.literal('revealWorkspace')}).strict(),
]);
export interface WorkspaceToolsBridge {
  read():Promise<ToolPaths>;
  select(tool:'ffmpeg'|'ffprobe'):Promise<string|null>;
  check(paths:ToolPaths):Promise<MediaToolDiagnostics>;
  save(paths:ToolPaths):Promise<MediaToolDiagnostics>;
  revealWorkspace():Promise<boolean>;
}

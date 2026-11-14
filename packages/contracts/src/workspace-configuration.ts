import {z} from 'zod';

// Preserve the legacy wire shape while the application ignores the retired flag.
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const workspaceSettingsSchema=z.object({
  formatVersion:z.literal(1),revision,liveGeneration:z.boolean(),
}).strict();
export const workspaceSettingsUpdateSchema=z.object({
  expectedRevision:revision,liveGeneration:z.boolean(),
}).strict();
export const workspaceConfigurationSchemas={
  'workspace.settings.get':z.object({}).strict(),
  'workspace.settings.set':workspaceSettingsUpdateSchema,
} as const;
export type WorkspaceSettings=z.infer<typeof workspaceSettingsSchema>;
export type WorkspaceSettingsUpdate=z.infer<typeof workspaceSettingsUpdateSchema>;

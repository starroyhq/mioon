import {z} from 'zod';

// Version numbers describe fixed pairs, not a contiguous migration chain.
// Historical backup DTOs retain their exact fields. Explicit ordinary26/28/30
// are additional source versions; restored25/27/29/31 are never backup sources.
export const workspaceBackupSourceSchemaVersion = z.union([
  z.number().int().min(1).max(24),
  z.literal(26),
  z.literal(28),
  z.literal(30),
]);
export const workspaceRestorationPairSchema = z.union([
  z.object({profile:z.literal('restored-local-v1'),sourceSchema:z.literal(24),databaseSchemaVersion:z.literal(25)}).strict(),
  z.object({profile:z.literal('restored-local-v2'),sourceSchema:z.literal(26),databaseSchemaVersion:z.literal(27)}).strict(),
  z.object({profile:z.literal('restored-local-v3'),sourceSchema:z.literal(28),databaseSchemaVersion:z.literal(29)}).strict(),
  z.object({profile:z.literal('restored-local-v4'),sourceSchema:z.literal(30),databaseSchemaVersion:z.literal(31)}).strict(),
]);
export type WorkspaceRestorationPair = z.infer<typeof workspaceRestorationPairSchema>;

export function isWorkspaceRestorationPair(value: unknown): value is WorkspaceRestorationPair {
  return workspaceRestorationPairSchema.safeParse(value).success;
}

export const workspaceRestoreProfile = z.enum(['restored-local-v1','restored-local-v2','restored-local-v3','restored-local-v4']);
export const workspaceRestoreSourceVersion = z.union([z.literal(24),z.literal(26),z.literal(28),z.literal(30)]);
export const workspaceRestoreDatabaseVersion = z.union([z.literal(25),z.literal(27),z.literal(29),z.literal(31)]);

export function validateWorkspaceRestorationPair(
  value: {profile:unknown;sourceSchema:unknown;databaseSchemaVersion:unknown},
  context: z.RefinementCtx,
): void {
  if(!isWorkspaceRestorationPair({profile:value.profile,sourceSchema:value.sourceSchema,databaseSchemaVersion:value.databaseSchemaVersion}))context.addIssue({code:z.ZodIssueCode.custom,message:'Restore profile, source and database versions must be an exact supported pair.'});
}

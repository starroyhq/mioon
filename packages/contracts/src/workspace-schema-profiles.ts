import {z} from 'zod';

// Version numbers describe fixed pairs, not a contiguous migration chain.
// Historical backup DTOs retain their exact fields. Explicit ordinary26/28/30/32/34
// are additional source versions; restored25/27/29/31/33/35 are never backup sources.
export const workspaceBackupSourceSchemaVersion = z.union([
  z.number().int().min(1).max(24),
  z.literal(26),
  z.literal(28),
  z.literal(30),
  z.literal(32),
  z.literal(34),
  z.literal(36),
  z.literal(38),
  z.literal(40),
]);
export const workspaceRestorationPairSchema = z.union([
  z.object({profile:z.literal('restored-local-v9'),sourceSchema:z.literal(40),databaseSchemaVersion:z.literal(41)}).strict(),
  z.object({profile:z.literal('restored-local-v8'),sourceSchema:z.literal(38),databaseSchemaVersion:z.literal(39)}).strict(),
  z.object({profile:z.literal('restored-local-v7'),sourceSchema:z.literal(36),databaseSchemaVersion:z.literal(37)}).strict(),
  z.object({profile:z.literal('restored-local-v1'),sourceSchema:z.literal(24),databaseSchemaVersion:z.literal(25)}).strict(),
  z.object({profile:z.literal('restored-local-v2'),sourceSchema:z.literal(26),databaseSchemaVersion:z.literal(27)}).strict(),
  z.object({profile:z.literal('restored-local-v3'),sourceSchema:z.literal(28),databaseSchemaVersion:z.literal(29)}).strict(),
  z.object({profile:z.literal('restored-local-v4'),sourceSchema:z.literal(30),databaseSchemaVersion:z.literal(31)}).strict(),
  z.object({profile:z.literal('restored-local-v5'),sourceSchema:z.literal(32),databaseSchemaVersion:z.literal(33)}).strict(),
  z.object({profile:z.literal('restored-local-v6'),sourceSchema:z.literal(34),databaseSchemaVersion:z.literal(35)}).strict(),
]);
export type WorkspaceRestorationPair = z.infer<typeof workspaceRestorationPairSchema>;

export function isWorkspaceRestorationPair(value: unknown): value is WorkspaceRestorationPair {
  return workspaceRestorationPairSchema.safeParse(value).success;
}

export const workspaceRestoreProfile = z.enum(['restored-local-v1','restored-local-v2','restored-local-v3','restored-local-v4','restored-local-v5','restored-local-v6','restored-local-v7','restored-local-v8','restored-local-v9']);
export const workspaceRestoreSourceVersion = z.union([z.literal(24),z.literal(26),z.literal(28),z.literal(30),z.literal(32),z.literal(34),z.literal(36),z.literal(38),z.literal(40)]);
export const workspaceRestoreDatabaseVersion = z.union([z.literal(25),z.literal(27),z.literal(29),z.literal(31),z.literal(33),z.literal(35),z.literal(37),z.literal(39),z.literal(41)]);

export function validateWorkspaceRestorationPair(
  value: {profile:unknown;sourceSchema:unknown;databaseSchemaVersion:unknown},
  context: z.RefinementCtx,
): void {
  if(!isWorkspaceRestorationPair({profile:value.profile,sourceSchema:value.sourceSchema,databaseSchemaVersion:value.databaseSchemaVersion}))context.addIssue({code:z.ZodIssueCode.custom,message:'Restore profile, source and database versions must be an exact supported pair.'});
}

import {z} from 'zod';
import {WORKSPACE_SCHEMA_LINEAGE,WORKSPACE_ORDINARY_SCHEMAS,WORKSPACE_RESTORED_SCHEMAS,WORKSPACE_RESTORE_PROFILES,workspaceSchemasSince} from './workspace-schema-lineage.ts';
import type {WorkspaceSchemaLineageEntry,WorkspaceRestoreProfileId} from './workspace-schema-lineage.ts';

// Version numbers describe fixed pairs, not a contiguous migration chain; the
// pairs come from the explicit lineage in workspace-schema-lineage.ts.
// Historical backup DTOs retain their exact fields. Explicit ordinary26/28/30/32/34
// are additional source versions; restored25/27/29/31/33/35 are never backup sources.
const literals = <const T extends number>(values: readonly T[]) =>
  values.map(value => z.literal(value)) as unknown as [z.ZodLiteral<T>, z.ZodLiteral<T>, ...z.ZodLiteral<T>[]];
const pair = ({profile, ordinary, restored}: WorkspaceSchemaLineageEntry) =>
  z.object({profile:z.literal(profile),sourceSchema:z.literal(ordinary),databaseSchemaVersion:z.literal(restored)}).strict();

export const workspaceBackupSourceSchemaVersion = z.union([
  z.number().int().min(1).max(24),
  ...literals(workspaceSchemasSince(26)),
]);
export const workspaceRestorationPairSchema = z.union(
  WORKSPACE_SCHEMA_LINEAGE.map(pair) as unknown as [ReturnType<typeof pair>, ReturnType<typeof pair>, ...ReturnType<typeof pair>[]],
);
export type WorkspaceRestorationPair = z.infer<typeof workspaceRestorationPairSchema>;

export function isWorkspaceRestorationPair(value: unknown): value is WorkspaceRestorationPair {
  return workspaceRestorationPairSchema.safeParse(value).success;
}

export const workspaceRestoreProfile = z.enum([...WORKSPACE_RESTORE_PROFILES] as [WorkspaceRestoreProfileId, ...WorkspaceRestoreProfileId[]]);
export const workspaceRestoreSourceVersion = z.union(literals(WORKSPACE_ORDINARY_SCHEMAS));
export const workspaceRestoreDatabaseVersion = z.union(literals(WORKSPACE_RESTORED_SCHEMAS));

export function validateWorkspaceRestorationPair(
  value: {profile:unknown;sourceSchema:unknown;databaseSchemaVersion:unknown},
  context: z.RefinementCtx,
): void {
  if(!isWorkspaceRestorationPair({profile:value.profile,sourceSchema:value.sourceSchema,databaseSchemaVersion:value.databaseSchemaVersion}))context.addIssue({code:z.ZodIssueCode.custom,message:'Restore profile, source and database versions must be an exact supported pair.'});
}

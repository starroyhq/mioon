// Offline filesystem API results only. Never add these paths/actions to RPC.
import {z} from 'zod';
import {workspaceRestoreProfile,workspaceRestoreSourceVersion,workspaceRestoreDatabaseVersion,validateWorkspaceRestorationPair} from './workspace-schema-profiles.ts';
import {workspaceBackupInventorySchema,WORKSPACE_BACKUP_LIMITS} from './workspace-backup.mjs';
const hash=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const binding={restorationId:z.string().uuid(),workspaceOrigin:z.string().uuid(),sourceBackupId:z.string().uuid(),manifestHash:hash,sourceDbHash:hash};
export const workspaceRestoreOfflineResultSchema=z.object({
 ...binding,profile:workspaceRestoreProfile,sourceSchema:workspaceRestoreSourceVersion,databaseSchemaVersion:workspaceRestoreDatabaseVersion,
 publication:z.literal('confirmed'),createdAt:z.string().datetime(),
 fileCount:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.fileCount),payloadBytes:integer.max(WORKSPACE_BACKUP_LIMITS.totalBytes),
 databaseBytes:integer.min(1).max(WORKSPACE_BACKUP_LIMITS.databaseBytes),additionalDiskBytesEstimate:integer,
 inventory:workspaceBackupInventorySchema,heldCounts:z.record(integer),
 warnings:z.array(z.enum(['DESTINATION_LOCK_RELEASE_UNCONFIRMED'])).max(1).optional(),
}).strict().superRefine(validateWorkspaceRestorationPair);
export const workspaceRestorePublicationStatusSchema=z.object({
 ...binding,profile:workspaceRestoreProfile,sourceSchema:workspaceRestoreSourceVersion,databaseSchemaVersion:workspaceRestoreDatabaseVersion,
 publication:z.literal('observed_guarded'),createdAt:z.string().datetime(),
 durability:z.literal('not_reconfirmed'),heldCounts:z.record(integer),
}).strict().superRefine(validateWorkspaceRestorationPair);

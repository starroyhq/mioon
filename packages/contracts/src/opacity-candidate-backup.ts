/** Fixed offline candidate DTOs. The existing format1 entry/inventory limits,
 * strict objects and publication binding are reused; legacy versions stay closed. */
import {createRequire} from 'node:module';
import {z} from 'zod';

const require = createRequire(import.meta.url);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function unavailable(): never {throw new Error('The fixed offline archive contract is unavailable.');}
function base(moduleName: string, name: string) {
  const module: unknown = require(moduleName);
  if (!object(module)) return unavailable();
  const schema: unknown = module[name];
  const inner: unknown = schema instanceof z.ZodEffects ? schema.innerType() : schema;
  if (!(inner instanceof z.ZodObject)) return unavailable();
  return inner;
}
export const OPACITY_BACKUP_DRAFT_POLICY = 'excluded' as const;
const draftPolicy = z.literal(OPACITY_BACKUP_DRAFT_POLICY);
export const opacityWorkspaceBackupManifestSchema = base('./workspace-backup.mjs', 'workspaceBackupManifestSchema')
  .extend({databaseSchemaVersion: z.literal(42), draftPolicy})
  .superRefine((value, context) => {
    // The base entry schemas already enforce roles, fixed paths and file caps.
    // Retain the original cross-entry sorted/unique/aggregate constraints.
    const entries: unknown = value.entries;
    if (!Array.isArray(entries)) return context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid entries.'});
    let bytes = 0, databases = 0, previous = ''; const paths = new Set<string>();
    for (const entry of entries) {
      if (!object(entry) || typeof entry.path !== 'string' || typeof entry.bytes !== 'number')
        return context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid entry.'});
      bytes += entry.bytes;
      if (paths.has(entry.path) || entry.path <= previous) context.addIssue({code: z.ZodIssueCode.custom, message: 'Entries must have unique, lexically sorted paths.'});
      paths.add(entry.path); previous = entry.path; if (entry.role === 'database') databases++;
    }
    if (databases !== 1 || bytes > 64 * 1024 * 1024 * 1024)
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Exactly one database and a bounded total payload are required.'});
  });
export const opacityWorkspaceBackupResultSchema = base('./workspace-backup.mjs', 'workspaceBackupResultSchema')
  .extend({databaseSchemaVersion: z.literal(42), draftPolicy});
const restoration = {profile: z.literal('restored-local-v10'), sourceSchema: z.literal(42), databaseSchemaVersion: z.literal(43), draftPolicy};
export const opacityWorkspaceRestoreResultSchema = base('./workspace-restore-offline.mjs', 'workspaceRestoreOfflineResultSchema').extend(restoration);
export const opacityWorkspaceRestoreStatusSchema = base('./workspace-restore-offline.mjs', 'workspaceRestorePublicationStatusSchema').extend(restoration);

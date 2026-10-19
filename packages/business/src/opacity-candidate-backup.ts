/** Explicit local/offline API only. Never creates a backend or grants a43
 * application capability. Defaults and package/RPC barrels remain unchanged. */
import {createRequire} from 'node:module';
import {OPACITY_CANDIDATE_BACKUP_PROFILE as profile} from './opacity-candidate-backup-profile.ts';

const require = createRequire(import.meta.url);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface SourceOptions {readonly source: string; readonly destination: string; readonly signal?: AbortSignal}
interface VerifyOptions {readonly directory: string; readonly signal?: AbortSignal}
interface RestoreOptions extends VerifyOptions {readonly destination: string}
export type OpacityRestoreStatusOptions = Readonly<{destination: string; signal?: AbortSignal} & (
  {directory: string; restorationId?: never; sourceBackupId?: never; manifestHash?: never; sourceDbHash?: never} |
  {directory?: never; restorationId: string; sourceBackupId: string; manifestHash: string; sourceDbHash: string}
)>;
async function invoke(moduleName: './workspace-backup.ts' | './workspace-restore.ts', member: string, options: unknown, schema: {safeParse(value: unknown): {success: boolean; data?: unknown}}): Promise<unknown> {
  const module: unknown = moduleName === './workspace-backup.ts' ? require('./workspace-backup.ts') : require('./workspace-restore.ts');
  if (!object(module) || typeof module[member] !== 'function') throw new Error('The fixed offline archive runtime is unavailable.');
  const result: unknown = await Reflect.apply(module[member], module, [options, profile]);
  if (!schema.safeParse(result).success) throw Object.assign(new Error('Invalid fixed candidate offline result.'), {code: 'WORKSPACE_BACKUP_IO'});
  return result;
}
export function createOpacityCandidateWorkspaceBackup(options: SourceOptions): Promise<unknown> {return invoke('./workspace-backup.ts', 'createWorkspaceBackup', options, profile.resultSchema);}
export function verifyOpacityCandidateWorkspaceBackup(options: VerifyOptions): Promise<unknown> {return invoke('./workspace-backup.ts', 'verifyWorkspaceBackup', options, profile.resultSchema);}
export function restoreOpacityCandidateWorkspaceBackup(options: RestoreOptions): Promise<unknown> {return invoke('./workspace-restore.ts', 'restoreWorkspaceBackup', options, profile.restoreResultSchema);}
export function inspectOpacityCandidateRestorePublication(options: OpacityRestoreStatusOptions): Promise<unknown> {return invoke('./workspace-restore.ts', 'inspectWorkspaceRestorePublication', options, profile.restoreStatusSchema);}

/** One module-owned offline profile. Only object identity selects these fixed
 * validators in the shared file pipeline; copied/wire metadata grants nothing. */
import type {DatabaseSync} from 'node:sqlite';
import {classifyWorkspaceSchema46} from './workspace-schema-v46.ts';
import {installWorkspaceRestoreSchemaV47, validateWorkspaceRestoreSchemaV47} from './workspace-restore-schema-v47.ts';
import {rippleOpacityWorkspaceBackupManifestSchema, rippleOpacityWorkspaceBackupResultSchema, rippleOpacityWorkspaceRestoreResultSchema, rippleOpacityWorkspaceRestoreStatusSchema} from '../../contracts/src/opacity-ripple-candidate-backup.ts';

function requireSource(db: DatabaseSync): void {classifyWorkspaceSchema46(db);}
export const OPACITY_RIPPLE_CANDIDATE_BACKUP_PROFILE = Object.freeze({
  sourceVersion: 46 as const,
  manifestSchema: rippleOpacityWorkspaceBackupManifestSchema,
  resultSchema: rippleOpacityWorkspaceBackupResultSchema,
  restoreResultSchema: rippleOpacityWorkspaceRestoreResultSchema,
  restoreStatusSchema: rippleOpacityWorkspaceRestoreStatusSchema,
  manifestMetadata: Object.freeze({draftPolicy: 'excluded' as const}),
  resultMetadata: Object.freeze({draftPolicy: 'excluded' as const}),
  requireSource,
  readSchemaVersion(db: DatabaseSync): 46 {requireSource(db); return 46;},
  installRestore: installWorkspaceRestoreSchemaV47,
  validateRestore: validateWorkspaceRestoreSchemaV47,
});

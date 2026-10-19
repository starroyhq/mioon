/** One module-owned offline profile. Only object identity selects these fixed
 * validators in the shared file pipeline; copied/wire metadata grants nothing. */
import type {DatabaseSync} from 'node:sqlite';
import {classifyWorkspaceSchema42} from './workspace-schema-v42.ts';
import {installWorkspaceRestoreSchemaV43, validateWorkspaceRestoreSchemaV43} from './workspace-restore-schema-v43.ts';
import {opacityWorkspaceBackupManifestSchema, opacityWorkspaceBackupResultSchema, opacityWorkspaceRestoreResultSchema, opacityWorkspaceRestoreStatusSchema} from '../../contracts/src/opacity-candidate-backup.ts';

function requireSource(db: DatabaseSync): void {classifyWorkspaceSchema42(db);}
export const OPACITY_CANDIDATE_BACKUP_PROFILE = Object.freeze({
  sourceVersion: 42 as const,
  manifestSchema: opacityWorkspaceBackupManifestSchema,
  resultSchema: opacityWorkspaceBackupResultSchema,
  restoreResultSchema: opacityWorkspaceRestoreResultSchema,
  restoreStatusSchema: opacityWorkspaceRestoreStatusSchema,
  manifestMetadata: Object.freeze({draftPolicy: 'excluded' as const}),
  resultMetadata: Object.freeze({draftPolicy: 'excluded' as const}),
  requireSource,
  readSchemaVersion(db: DatabaseSync): 42 {requireSource(db); return 42;},
  installRestore: installWorkspaceRestoreSchemaV43,
  validateRestore: validateWorkspaceRestoreSchemaV43,
});

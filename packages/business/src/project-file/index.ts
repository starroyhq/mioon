/** Project file kernel: the only code that opens a project file, its local
 * records (history.db) and its cache (cache.db). Runtime code here never
 * imports db.ts or services.ts. */
export {openStore} from './test-store.ts';
export {commitProjectAssetHash, createProjectStore, isProjectStore, openProjectStore, openStagedProjectStore, registerProjectTransactionFence, registerProjectTransactionObserver} from './store.ts';
export type {CommitProjectAssetHashOptions, ProjectStore} from './store.ts';
export {createProjectFile, isProjectDatabase, isProjectFileHeld, openProjectConnection, openStagedProjectConnection, inspectProjectFileReadOnly, inspectProjectFormatHeader, inspectProjectFormatReadOnly, PROJECT_JOURNAL_SIZE_LIMIT, recoverProjectFile} from './connection.ts';
export type {
  CreateProjectFileOptions, OpenProjectConnectionOptions, ProjectConnection, ProjectCopyCheck, ProjectFileRecovery, ProjectLocation, ProjectIdentity, ProjectFormatIdentity, StagedProjectConnectionOptions,
  Format4Options, Format4UpgradePreview, Format4UpgradeBoundary,
} from './connection.ts';
export {isSuperJournalInUse, superJournalsIn} from './journals.ts';
export {isSqliteBusy, MAX_REPORTED_DIFFERENCES, projectFileError} from './errors.ts';
export type {ProjectFileErrorDetails, ProjectFileErrorReason, ProjectFileKernelErrorCode} from './errors.ts';
export {PROJECT_FILE_EXISTS} from '../../../contracts/src/project-file.ts';
export {crossFileTriggerStatements, FOREIGN_KEY_MESSAGE, installCrossFileTriggers} from './cross-file/install.ts';
export {foreignKeyCheck, schemaObjects} from './cross-file/inspect.ts';
export type {ForeignKeyViolation, SchemaObject} from '../../../contracts/src/project-file.ts';
export {
  CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION,
} from './schema/databases.ts';
export type {DatabaseKind} from './schema/databases.ts';
export {createProjectBackup, inspectCopiedProjectFile, inspectProjectBackup, openProjectBackup, PROJECT_BACKUP_APPLICATION_ID} from './backup.ts';
export type {ProjectBackupIdentity, ProjectBackupReader} from './backup.ts';
export {copyProjectBackup, copyProjectToNewFile} from './copy.ts';
export type {CopyProjectOptions, ProjectCopyResult} from './copy.ts';

export {readProjectContentStamp, sameContentStamp} from './content-stamp.ts';
export type {ContentStamp, ProjectHistoryAdmission} from './content-stamp.ts';

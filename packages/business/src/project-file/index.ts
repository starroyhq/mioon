/** Project file kernel: the only code that opens a project file, its local
 * records (history.db) and its cache (cache.db). Runtime code here never
 * imports db.ts or services.ts. */
export {openStore} from './test-store.ts';
export {createProjectStore, openProjectStore, registerProjectTransactionFence, registerProjectTransactionObserver} from './store.ts';
export type {ProjectStore} from './store.ts';
export {createProjectFile, openProjectConnection, PROJECT_JOURNAL_SIZE_LIMIT} from './connection.ts';
export type {CreateProjectFileOptions, OpenProjectConnectionOptions, ProjectConnection, ProjectCopyCheck, ProjectLocation} from './connection.ts';
export {isSqliteBusy, MAX_REPORTED_DIFFERENCES, PROJECT_FILE_EXISTS, projectFileError} from './errors.ts';
export type {ProjectFileErrorCode, ProjectFileErrorDetails, ProjectFileErrorReason} from './errors.ts';
export {crossFileTriggerStatements, FOREIGN_KEY_MESSAGE, installCrossFileTriggers} from './cross-file/install.ts';
export {foreignKeyCheck, schemaObjects} from './cross-file/inspect.ts';
export type {ForeignKeyViolation, SchemaObject} from './cross-file/inspect.ts';
export {
  CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION,
} from './schema/databases.ts';
export type {DatabaseKind} from './schema/databases.ts';

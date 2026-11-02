/** The app library (task card B1): one SQLite file in the app data directory
 * for this computer's registry and records, never attached to a project
 * connection. The project host opens it once per backend (S0's AppLibraryPort)
 * and hands the ports on; nothing here opens a project file. */
import type {DatabaseSync} from 'node:sqlite';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import {openAppDatabase} from './connection.ts';
import {projectFileIdentity} from './identity.ts';
import {createLocalRecords} from './local-records.ts';
import type {LocalRecordsStore} from './local-records.ts';
import {createProjectRegistry} from './registry.ts';
import type {AppProjectRegistry} from './registry.ts';
import {
  createAgentPolicyStore, createAppDocumentStore, createAppOperationReceiptStore, createBackgroundTaskIndexStore,
  createOutsidePathConfirmationStore, createProjectInboxStore, createProjectRulesTrustStore,
} from './stores.ts';
import type {
  AgentPolicyStore, AppDocumentStore, AppOperationReceiptStore, BackgroundTaskIndexStore, OutsidePathConfirmationStore, ProjectInboxStore,
  ProjectRulesTrustStore,
} from './stores.ts';

export {APP_LIBRARY_APPLICATION_ID, APP_LIBRARY_FILE, APP_LIBRARY_SCHEMA_VERSION, APP_DOCUMENT_LIMITS, APP_DOCUMENT_NAMES} from './schema.ts';
export type {AppDocumentName} from './schema.ts';
export {appLibraryError, projectFileCopyError} from './errors.ts';
export type {AppLibraryErrorCode, AppLibraryErrorDetails, AppLibraryInvalidReason} from './errors.ts';
export {
  DEFAULT_FIND_MOVED_DEPTH, DEFAULT_FIND_MOVED_LIMIT, findMovedProjectFile, findMovedSearchRoots, identityOfStats, isProjectFileName,
  isSkippedEntry, NODE_FIND_MOVED_FILE_SYSTEM, projectFileIdentity, sameProjectFileIdentity,
} from './identity.ts';
export type {DirectoryEntry, FindMovedFileSystem, FindMovedOptions, FindMovedPath, IdentityStats} from './identity.ts';
export {MAX_RECENT_PROJECTS} from './registry.ts';
export type {AppProjectRegistry, ProjectFileCandidate} from './registry.ts';
export type {
  AgentPolicyStore, AppDocumentStore, AppOperationReceipt, AppOperationReceiptStore, BackgroundTaskIndexStore, OutsidePathConfirmationStore,
  ProjectInboxStore, ProjectRulesTrustStore,
} from './stores.ts';
export {hasSuperJournalInUse} from './local-records.ts';
export type {LocalRecordsItem, LocalRecordsStore} from './local-records.ts';

export interface AppLibraryOptions {
  /** The app data directory: a private directory, created when missing. */
  readonly dataDir: string;
  /** Also searched for moved project files, after the old folder and its
   * parent; S0 passes the default projects directory. */
  readonly findMovedRoots?: readonly string[];
  readonly findMovedLimit?: number;
  /** Whether this process has the project open; the local records of an open
   * project are never listed or deleted. Called on every check, so the host
   * may supply it before its manager exists. */
  readonly isProjectOpen?: (projectId: string) => boolean;
}

/** Satisfies the project host's AppLibraryPort (registry, agentPolicy,
 * projectFileIdentity, databaseFile, close) and S3's task index and inbox
 * ports, and adds the rest of the app library. */
export interface AppLibrary {
  readonly dataDir: string;
  /** `<dataDir>/app-library.db`. Mio authorizations, UI preferences, the last
   * project and the desktop's window appearance and LUT recovery are scoped by
   * its file identity instead of workbench.sqlite's. The file is changed only
   * in place by SQLite, so its identity stays. */
  readonly databaseFile: string;
  readonly registry: AppProjectRegistry;
  /** lstat only: never opens the file. */
  readonly projectFileIdentity: (projectFile: string) => ProjectFileIdentity | null;
  readonly agentPolicy: AgentPolicyStore;
  readonly documents: AppDocumentStore;
  readonly rulesTrust: ProjectRulesTrustStore;
  readonly outsidePaths: OutsidePathConfirmationStore;
  readonly taskIndex: BackgroundTaskIndexStore;
  readonly inbox: ProjectInboxStore;
  readonly receipts: AppOperationReceiptStore;
  readonly localRecords: LocalRecordsStore;
  /** The connection, for modules that already write SQL against these tables
   * (workspace-preferences.ts on workspace_preferences). It checks no project
   * exists: callers look the project up in the registry. */
  readonly db: DatabaseSync;
  /** A transaction on that connection; the stores' own writes join it. */
  tx<T>(callback: () => T): T;
  /** Idempotent; afterwards every store throws APP_LIBRARY_CLOSED. */
  close(): void;
}

/** Opens (or creates) the app library of `dataDir`. A second open of the same
 * library, in this process or another, is APP_LIBRARY_LOCKED until close(). */
export function openAppLibrary({dataDir, findMovedRoots = [], findMovedLimit, isProjectOpen = () => false}: AppLibraryOptions): AppLibrary {
  const database = openAppDatabase(dataDir);
  try {
    const registry = createProjectRegistry(database, {
      identity: projectFileIdentity,
      findMoved: {roots: [...findMovedRoots], ...(findMovedLimit === undefined ? {} : {limit: findMovedLimit})},
    });
    return Object.freeze({
      dataDir: database.dataDir,
      databaseFile: database.file,
      registry: Object.freeze(registry),
      projectFileIdentity,
      agentPolicy: Object.freeze(createAgentPolicyStore(database)),
      documents: Object.freeze(createAppDocumentStore(database)),
      rulesTrust: Object.freeze(createProjectRulesTrustStore(database)),
      outsidePaths: Object.freeze(createOutsidePathConfirmationStore(database)),
      taskIndex: Object.freeze(createBackgroundTaskIndexStore(database)),
      inbox: Object.freeze(createProjectInboxStore(database)),
      receipts: Object.freeze(createAppOperationReceiptStore(database)),
      localRecords: Object.freeze(createLocalRecords({dataDir: database.dataDir, registry, identity: projectFileIdentity, isProjectOpen})),
      db: database.db,
      tx: database.tx,
      close: database.close,
    });
  } catch (error) {
    database.close();
    throw error;
  }
}
